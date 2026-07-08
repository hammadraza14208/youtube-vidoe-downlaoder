#!/usr/bin/env python3
"""
ytdrop Python backend — yt-dlp HTTP server on port 5001
Uses only stdlib: http.server, subprocess, json, urllib, threading

Performance optimizations applied:
  1. --print instead of --dump-json for metadata
  2. -F for format listing (faster than full JSON dump)
  3. Parallel threading for info + formats
  4. In-memory cache with 5-minute TTL
  5. Socket timeout (10s) + automatic retry
  6. ThreadingHTTPServer for concurrent requests
  7. --extractor-retries 1 + --no-check-certificate
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import urllib.parse
import zipfile
from http.server import BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from http.server import HTTPServer

PORT = 5001
DEBUG = os.environ.get("YTDROP_DEBUG") == "1"
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Target resolutions for video formats
VIDEO_RESOLUTIONS = [1080, 720, 480, 360, 240]
FIELD_SEPARATOR = "\x1f"
PLAYLIST_LIMIT = 50
PLAYLIST_PROGRESS_PREFIX = "__YTDROP_PLAYLIST_ITEM__"

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
}

# ── Fix 4: In-memory cache ──────────────────────────────────────────────────
cache = {}  # { url: { "data": payload, "timestamp": float } }
CACHE_TTL = 300  # 5 minutes
progress_store = {}  # { job_id: { current, total, status, message, updatedAt } }
progress_lock = threading.Lock()


def debug_log(message):
    if DEBUG:
        print(f"[ytdrop] {message}", file=sys.stderr)

def get_cached(url):
    entry = cache.get(url)
    if entry and time.time() - entry["timestamp"] < CACHE_TTL:
        return entry["data"]
    return None

def set_cache(url, data):
    cache[url] = {"data": data, "timestamp": time.time()}


def get_playlist_cache_key(url):
    return f"playlist:{url}"


def is_playlist_url(url):
    try:
        parsed = urllib.parse.urlparse(url)
        query = urllib.parse.parse_qs(parsed.query)
        return bool(query.get("list"))
    except Exception:
        return "list=" in (url or "")


def sanitize_filename(name, fallback="download", max_len=90):
    safe_name = "".join(c for c in name if c.isalnum() or c in " -_()[]").strip()
    return (safe_name[:max_len] or fallback).strip()


def update_progress(job_id, **patch):
    if not job_id:
        return
    with progress_lock:
        state = progress_store.setdefault(
            job_id,
            {
                "current": 0,
                "total": 0,
                "status": "pending",
                "message": "Preparing playlist download...",
            },
        )
        state.update(patch)
        state["updatedAt"] = time.time()


def get_progress(job_id):
    with progress_lock:
        state = progress_store.get(job_id)
        if not state:
            return {
                "current": 0,
                "total": 0,
                "status": "pending",
                "message": "Waiting for playlist download to start...",
            }
        return dict(state)


def cleanup_old_progress(max_age=3600):
    cutoff = time.time() - max_age
    with progress_lock:
        for job_id, state in list(progress_store.items()):
            if state.get("updatedAt", 0) < cutoff:
                progress_store.pop(job_id, None)


# ── Fix 7: Common yt-dlp flags for speed ────────────────────────────────────
FAST_FLAGS = [
    "--no-playlist",
    "--no-warnings",
    "--socket-timeout", "10",
    "--extractor-retries", "1",
    "--no-check-certificate",
]

PLAYLIST_FLAGS = [
    "--no-warnings",
    "--socket-timeout", "10",
    "--extractor-retries", "1",
    "--no-check-certificate",
    "--ignore-errors",
    "--no-abort-on-error",
]


# ── Fix 5: Run with retry ───────────────────────────────────────────────────
def run_with_retry(cmd, retries=1, timeout=25):
    """Run a subprocess command with automatic retry on failure."""
    result = None
    for i in range(retries + 1):
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
            if result.returncode == 0:
                return result
        except subprocess.TimeoutExpired:
            print(f"[ytdrop] Command timed out (attempt {i+1}/{retries+1})", file=sys.stderr)
            result = None
        except Exception as e:
            print(f"[ytdrop] Command error (attempt {i+1}/{retries+1}): {e}", file=sys.stderr)
            result = None
    return result


def format_playlist_duration(value):
    if not value or value == "NA":
        return ""
    try:
        return format_duration(int(float(value)))
    except (TypeError, ValueError):
        return value


def parse_playlist_line(line):
    try:
        video_id, rest = line.split("|", 1)
        title, duration = rest.rsplit("|", 1)
    except ValueError:
        return None

    video_id = video_id.strip()
    if not video_id or video_id == "NA":
        return None

    title = title.strip()
    return {
        "id": video_id,
        "title": title if title and title != "NA" else "Untitled video",
        "duration": format_playlist_duration(duration.strip()),
    }


def fetch_playlist_title(url):
    cmd = [
        "yt-dlp",
        "--flat-playlist",
        "--playlist-end", "1",
        "--print", "playlist:%(title)s",
        *PLAYLIST_FLAGS,
        url,
    ]
    result = run_with_retry(cmd, retries=0, timeout=20)
    if result is None or result.returncode != 0:
        return "YouTube Playlist"

    for line in result.stdout.splitlines():
        title = line.strip()
        if title and title != "NA":
            return title
    return "YouTube Playlist"


def fetch_playlist_info(url):
    cached = get_cached(get_playlist_cache_key(url))
    if cached:
        return cached

    cmd = [
        "yt-dlp",
        "--flat-playlist",
        "--playlist-end", str(PLAYLIST_LIMIT),
        "--print", "%(id)s|%(title)s|%(duration)s",
        *PLAYLIST_FLAGS,
        url,
    ]
    result = run_with_retry(cmd, retries=1, timeout=45)
    if result is None or result.returncode != 0:
        stderr = result.stderr.strip() if result else "yt-dlp timed out"
        raise RuntimeError(stderr or "yt-dlp playlist listing failed")

    videos = []
    seen_ids = set()
    for line in result.stdout.splitlines():
        item = parse_playlist_line(line.strip())
        if not item or item["id"] in seen_ids:
            continue
        seen_ids.add(item["id"])
        videos.append(item)

    if not videos:
        raise RuntimeError("No public videos found in playlist")

    payload = {
        "playlistTitle": fetch_playlist_title(url),
        "videoCount": len(videos),
        "limit": PLAYLIST_LIMIT,
        "truncated": len(videos) >= PLAYLIST_LIMIT,
        "videos": videos,
    }
    set_cache(get_playlist_cache_key(url), payload)
    return payload


# ── Fix 1: Fetch metadata via --print (fast) ────────────────────────────────
def fetch_info_fast(url):
    """Fetch only the exact metadata fields needed using --print."""
    cmd = [
        "yt-dlp",
        "--print", FIELD_SEPARATOR.join([
            "%(title)s",
            "%(thumbnail)s",
            "%(duration)s",
            "%(uploader)s",
            "%(view_count)s",
        ]),
        *FAST_FLAGS,
        url,
    ]
    result = run_with_retry(cmd, retries=1, timeout=25)
    if result is None or result.returncode != 0:
        stderr = result.stderr.strip() if result else "yt-dlp timed out"
        raise RuntimeError(stderr or "yt-dlp --print failed")

    line = result.stdout.strip()
    parts = line.split(FIELD_SEPARATOR)
    if len(parts) < 5:
        raise RuntimeError(f"Unexpected --print output: {line}")

    title = parts[0] if parts[0] and parts[0] != "NA" else "Unknown"
    thumbnail = parts[1] if parts[1] and parts[1] != "NA" else ""
    try:
        duration = int(float(parts[2])) if parts[2] and parts[2] != "NA" else 0
    except (ValueError, TypeError):
        duration = 0
    uploader = parts[3] if parts[3] and parts[3] != "NA" else "Unknown"
    try:
        view_count = int(parts[4]) if parts[4] and parts[4] != "NA" else 0
    except (ValueError, TypeError):
        view_count = 0

    return {
        "title": title,
        "thumbnail": thumbnail,
        "duration": duration,
        "uploader": uploader,
        "view_count": view_count,
    }


# ── Fix 2: Fetch formats via -F (fast text output) ──────────────────────────
def fetch_formats_fast(url):
    """Parse yt-dlp -F text output into video and audio format lists."""
    cmd = [
        "yt-dlp",
        "-F",
        *FAST_FLAGS,
        url,
    ]
    result = run_with_retry(cmd, retries=1, timeout=25)
    if result is None or result.returncode != 0:
        stderr = result.stderr.strip() if result else "yt-dlp timed out"
        raise RuntimeError(stderr or "yt-dlp -F failed")

    lines = result.stdout.strip().split("\n")

    video_formats = []
    audio_formats = []

    for line in lines:
        # Skip header / separator lines
        if not line or line.startswith("ID") or line.startswith("[") or line.startswith("-"):
            continue

        # Typical -F line:
        # 137  mp4   1920x1080  ... video only ...  123.45MiB
        # 140  m4a   audio only ... 128k ...         3.45MiB
        parts = line.split()
        if len(parts) < 3:
            continue

        format_id = parts[0]
        ext = parts[1]

        # Skip storyboard / mhtml / data formats
        if ext in ("mhtml", "3gp") or "storyboard" in line.lower():
            continue

        # Detect audio-only
        is_audio = "audio only" in line.lower()

        # Detect video-only
        is_video_only = "video only" in line.lower()

        # Extract resolution (WxH pattern)
        resolution_match = re.search(r'(\d{3,5})x(\d{3,5})', line)
        height = 0
        if resolution_match:
            height = int(resolution_match.group(2))

        # Extract filesize from the line (e.g., "123.45MiB", "1.23GiB", "456KiB")
        filesize = None
        size_match = re.search(r'([\d.]+)\s*(GiB|MiB|KiB)', line)
        if size_match:
            val = float(size_match.group(1))
            unit = size_match.group(2)
            if unit == "GiB":
                filesize = int(val * 1024 * 1024 * 1024)
            elif unit == "MiB":
                filesize = int(val * 1024 * 1024)
            elif unit == "KiB":
                filesize = int(val * 1024)

        # Extract bitrate for audio (e.g., "128k", "256k")
        abr = 0
        abr_match = re.search(r'\b(\d+)k\b', line)
        if abr_match:
            abr = int(abr_match.group(1))

        if is_audio:
            audio_formats.append({
                "format_id": format_id,
                "ext": ext,
                "abr": abr,
                "filesize": filesize,
                "vcodec": "none",
                "acodec": "opus" if ext == "webm" else "aac",
            })
        elif height > 0:
            video_formats.append({
                "format_id": format_id,
                "ext": ext,
                "height": height,
                "filesize": filesize,
                "filesize_approx": filesize,
                "vcodec": "avc1",
                "acodec": "none" if is_video_only else "aac",
            })

    return video_formats, audio_formats


def format_size(bytes_val):
    """Convert bytes to human-readable string."""
    if bytes_val is None:
        return "~"
    mb = bytes_val / (1024 * 1024)
    if mb >= 1000:
        return f"{mb/1024:.1f} GB"
    return f"{mb:.1f} MB"


def format_duration(seconds):
    if not seconds:
        return "0:00"
    h = int(seconds) // 3600
    m = (int(seconds) % 3600) // 60
    s = int(seconds) % 60
    if h:
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


def format_views(views):
    if not views:
        return "N/A"
    if views >= 1_000_000_000:
        return f"{views/1_000_000_000:.1f}B views"
    if views >= 1_000_000:
        return f"{views/1_000_000:.1f}M views"
    if views >= 1_000:
        return f"{views/1_000:.1f}K views"
    return f"{views} views"


def build_video_formats(raw_formats: list) -> list:
    """
    Extract one best format per target resolution.
    For 1080p/720p use video-only + bestaudio merge.
    For 480p/360p/240p prefer combined (av) formats.
    """
    result = []

    for res in VIDEO_RESOLUTIONS:
        best = None

        # First look for combined (video+audio) format at this resolution
        for f in raw_formats:
            if f.get("vcodec", "none") == "none":
                continue
            fheight = f.get("height") or 0
            if fheight != res:
                continue
            ext = f.get("ext", "")
            if ext not in ("mp4", "webm", "mkv"):
                continue
            # For 480p and below prefer combined (has audio)
            if res <= 480 and f.get("acodec", "none") != "none":
                if best is None or (f.get("filesize") or 0) > (best.get("filesize") or 0):
                    best = f

        # For 1080p/720p (or if no combined found for lower res), take best video-only
        if best is None:
            for f in raw_formats:
                if f.get("vcodec", "none") == "none":
                    continue
                fheight = f.get("height") or 0
                if fheight != res:
                    continue
                ext = f.get("ext", "")
                if ext not in ("mp4", "webm", "mkv"):
                    continue
                if best is None or (f.get("filesize") or f.get("filesize_approx") or 0) > (
                    best.get("filesize") or best.get("filesize_approx") or 0
                ):
                    best = f

        if best is None:
            continue

        is_video_only = best.get("acodec", "none") == "none"
        itag = best.get("format_id", "")
        size = best.get("filesize") or best.get("filesize_approx")

        label_map = {1080: "1080p HD", 720: "720p HD", 480: "480p", 360: "360p", 240: "240p"}
        label = label_map.get(res, f"{res}p")

        result.append(
            {
                "itag": itag,
                "label": label,
                "resolution": res,
                "ext": best.get("ext", "mp4"),
                "size": format_size(size),
                "size_bytes": size,
                "needsMerge": is_video_only,
                "hd": res >= 720,
            }
        )

    return result


def build_audio_formats(raw_formats: list) -> list:
    """Extract audio-only formats (m4a, webm/opus, mp3)."""
    seen_bitrates = set()
    result = []

    # Sort by abr descending
    audio_fmts = [
        f for f in raw_formats
        if f.get("vcodec", "none") == "none" and f.get("acodec", "none") != "none"
    ]
    audio_fmts.sort(key=lambda f: f.get("abr") or 0, reverse=True)

    for f in audio_fmts:
        abr = f.get("abr") or 0
        ext = f.get("ext", "m4a")
        # Bucket bitrates into display labels
        if abr >= 256:
            label = "320 kbps"
            bucket = 320
        elif abr >= 192:
            label = "256 kbps"
            bucket = 256
        elif abr >= 128:
            label = "128 kbps"
            bucket = 128
        elif abr >= 64:
            label = "64 kbps"
            bucket = 64
        else:
            label = "48 kbps"
            bucket = 48

        key = (bucket, ext)
        if key in seen_bitrates:
            continue
        seen_bitrates.add(key)

        size = f.get("filesize") or f.get("filesize_approx")
        result.append(
            {
                "itag": f.get("format_id", ""),
                "label": label,
                "ext": ext,
                "size": format_size(size),
                "size_bytes": size,
            }
        )

        if len(result) >= 5:
            break

    return result


def normalize_playlist_quality(quality):
    match = re.search(r"\d+", quality or "")
    if not match:
        return 720
    value = int(match.group(0))
    return value if value in VIDEO_RESOLUTIONS else 720


def build_playlist_format(quality, dltype):
    if dltype == "audio" or quality == "audio":
        return "bestaudio[ext=m4a]/bestaudio"

    height = normalize_playlist_quality(quality)
    return (
        f"bestvideo[height<={height}][ext=mp4]+bestaudio[ext=m4a]/"
        f"bestvideo[height<={height}]+bestaudio/"
        f"best[height<={height}]/best"
    )


def collect_downloaded_files(tmp_dir):
    files = []
    ignored_suffixes = (".part", ".ytdl", ".temp", ".tmp")
    for root, _, filenames in os.walk(tmp_dir):
        for filename in filenames:
            if filename.endswith(ignored_suffixes):
                continue
            path = os.path.join(root, filename)
            if os.path.isfile(path):
                files.append(path)
    return sorted(files)


def zip_downloaded_files(tmp_dir, zip_path):
    files = collect_downloaded_files(tmp_dir)
    if not files:
        raise RuntimeError("No playlist files were downloaded")

    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        used_names = set()
        for path in files:
            arcname = os.path.relpath(path, tmp_dir)
            arcname = arcname.replace(os.sep, "/")
            if arcname in used_names:
                base, ext = os.path.splitext(arcname)
                suffix = 2
                while f"{base} ({suffix}){ext}" in used_names:
                    suffix += 1
                arcname = f"{base} ({suffix}){ext}"
            used_names.add(arcname)
            zf.write(path, arcname)

    return len(files)


def download_playlist(url, quality, dltype, job_id):
    playlist_info = None
    playlist_title = "YouTube Playlist"
    total = 0
    try:
        playlist_info = fetch_playlist_info(url)
        playlist_title = playlist_info.get("playlistTitle") or playlist_title
        total = playlist_info.get("videoCount") or 0
    except Exception as e:
        debug_log(f"Could not prefetch playlist info: {e}")

    tmp_dir = tempfile.mkdtemp(prefix="ytdrop_playlist_")
    zip_path = f"{tmp_dir}.zip"
    output_template = os.path.join(tmp_dir, "%(playlist_index)03d - %(title).180B.%(ext)s")
    dltype = "audio" if dltype == "audio" or quality == "audio" else "video"
    fmt = build_playlist_format(quality, dltype)

    update_progress(
        job_id,
        current=0,
        total=total,
        status="preparing",
        message="Preparing playlist download...",
    )

    cmd = [
        "yt-dlp",
        "-f", fmt,
        "--playlist-end", str(PLAYLIST_LIMIT),
        "--newline",
        "--progress",
        "--print", f"before_dl:{PLAYLIST_PROGRESS_PREFIX}%(playlist_index)s|%(title)s",
        *PLAYLIST_FLAGS,
        "-o", output_template,
    ]
    if dltype == "video":
        cmd.extend(["--merge-output-format", "mp4"])
    cmd.append(url)

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )

        if proc.stdout:
            for raw_line in proc.stdout:
                line = raw_line.strip()
                if not line:
                    continue

                if line.startswith(PLAYLIST_PROGRESS_PREFIX):
                    payload = line[len(PLAYLIST_PROGRESS_PREFIX):]
                    idx_text, _, _title = payload.partition("|")
                    try:
                        current = int(idx_text)
                    except ValueError:
                        current = 0
                    if current:
                        update_progress(
                            job_id,
                            current=current,
                            total=total,
                            status="downloading",
                            message=f"Downloading video {current} of {total or '?'}...",
                        )
                    continue

                item_match = re.search(r"\[download\]\s+Downloading item\s+(\d+)\s+of\s+(\d+)", line)
                if item_match:
                    current = int(item_match.group(1))
                    parsed_total = int(item_match.group(2))
                    total = max(total, parsed_total)
                    update_progress(
                        job_id,
                        current=current,
                        total=total,
                        status="downloading",
                        message=f"Downloading video {current} of {total}...",
                    )
                elif line.startswith("ERROR:") or "This video is unavailable" in line:
                    update_progress(
                        job_id,
                        total=total,
                        status="downloading",
                        message="Skipping an unavailable playlist item...",
                    )

        returncode = proc.wait()
        files = collect_downloaded_files(tmp_dir)
        if returncode != 0 and not files:
            raise RuntimeError("yt-dlp playlist download failed")
        if not files:
            raise RuntimeError("No public playlist videos were downloaded")

        update_progress(
            job_id,
            current=total or len(files),
            total=total or len(files),
            status="zipping",
            message=f"Creating ZIP with {len(files)} file{'s' if len(files) != 1 else ''}...",
        )
        file_count = zip_downloaded_files(tmp_dir, zip_path)
        update_progress(
            job_id,
            current=total or file_count,
            total=total or file_count,
            status="done",
            message=f"ZIP ready with {file_count} file{'s' if file_count != 1 else ''}.",
        )
        return zip_path, tmp_dir, playlist_title
    except Exception as e:
        update_progress(
            job_id,
            current=0,
            total=total,
            status="error",
            message=str(e) or "Playlist download failed",
        )
        shutil.rmtree(tmp_dir, ignore_errors=True)
        try:
            os.remove(zip_path)
        except OSError:
            pass
        raise


# ── Fix 6: ThreadingHTTPServer ───────────────────────────────────────────────
class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    """Handle each request in a new thread so slow requests don't block others."""
    daemon_threads = True


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # Quiet mode — only print errors
        pass

    def send_cors(self):
        for k, v in CORS_HEADERS.items():
            self.send_header(k, v)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_cors()
        self.end_headers()

    def do_HEAD(self):
        parsed = urllib.parse.urlparse(self.path)

        if parsed.path == "/" or parsed.path == "/index.html":
            index_path = os.path.join(BASE_DIR, "index.html")
            try:
                size = os.path.getsize(index_path)
            except OSError:
                self.send_response(404)
                self.send_header("Content-Type", "application/json")
                self.send_cors()
                self.end_headers()
                return

            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(size))
            self.end_headers()
            return

        self.send_response(404)
        self.send_header("Content-Type", "application/json")
        self.send_cors()
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)

        if parsed.path == "/" or parsed.path == "/index.html":
            self._handle_index()
        elif parsed.path == "/info":
            self._handle_info(params)
        elif parsed.path == "/download":
            self._handle_download(params)
        elif parsed.path == "/playlist-info":
            self._handle_playlist_info(params)
        elif parsed.path == "/playlist-download":
            self._handle_playlist_download(params)
        elif parsed.path == "/playlist-progress":
            self._handle_playlist_progress(params)
        else:
            self._json_error(404, "Not found")

    def _handle_index(self):
        try:
            with open(os.path.join(BASE_DIR, "index.html"), "rb") as f:
                content = f.read()
        except OSError:
            return self._json_error(404, "index.html not found")

        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def _json_error(self, code, msg):
        body = json.dumps({"error": msg}).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_cors()
        self.end_headers()
        self.wfile.write(body)

    def _handle_info(self, params):
        url = params.get("url", [None])[0]
        if not url:
            return self._json_error(400, "Missing url param")

        # ── Fix 4: Return from cache if available ────────────────────────
        cached = get_cached(url)
        if cached:
            body = json.dumps(cached).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_cors()
            self.end_headers()
            self.wfile.write(body)
            return

        # ── Fix 3: Run info + formats in parallel ───────────────────────
        info_result = {}
        formats_result = {"video": [], "audio": []}
        errors = []

        def _fetch_info():
            try:
                info_result.update(fetch_info_fast(url))
            except Exception as e:
                errors.append(f"info: {e}")

        def _fetch_formats():
            try:
                vf, af = fetch_formats_fast(url)
                formats_result["video"] = vf
                formats_result["audio"] = af
            except Exception as e:
                errors.append(f"formats: {e}")

        t1 = threading.Thread(target=_fetch_info)
        t2 = threading.Thread(target=_fetch_formats)
        t1.start()
        t2.start()
        t1.join(timeout=30)
        t2.join(timeout=30)

        if errors:
            return self._json_error(500, "; ".join(errors))

        if not info_result:
            return self._json_error(500, "Failed to fetch video info (timed out)")

        # Build the response payload — same shape as before
        payload = {
            "title": info_result.get("title", "Unknown"),
            "thumbnail": info_result.get("thumbnail", ""),
            "duration": format_duration(info_result.get("duration")),
            "author": info_result.get("uploader", "Unknown"),
            "views": format_views(info_result.get("view_count")),
            "videoFormats": build_video_formats(formats_result["video"]),
            "audioFormats": build_audio_formats(formats_result["audio"]),
        }

        # ── Fix 4: Store in cache ────────────────────────────────────────
        set_cache(url, payload)

        body = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_cors()
        self.end_headers()
        self.wfile.write(body)

    def _handle_playlist_info(self, params):
        url = params.get("url", [None])[0]
        if not url:
            return self._json_error(400, "Missing url param")
        if not is_playlist_url(url):
            return self._json_error(400, "URL does not contain a playlist list= parameter")

        try:
            payload = fetch_playlist_info(url)
        except Exception as e:
            return self._json_error(500, str(e) or "Failed to fetch playlist info")

        body = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_cors()
        self.end_headers()
        self.wfile.write(body)

    def _handle_playlist_progress(self, params):
        cleanup_old_progress()
        job_id = params.get("id", [None])[0]
        if not job_id:
            return self._json_error(400, "Missing progress id")

        body = json.dumps(get_progress(job_id)).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_cors()
        self.end_headers()
        self.wfile.write(body)

    def _handle_playlist_download(self, params):
        cleanup_old_progress()
        url = params.get("url", [None])[0]
        quality = params.get("quality", ["720"])[0]
        dltype = params.get("type", ["video"])[0]
        job_id = params.get("id", [uuid.uuid4().hex])[0]

        if not url:
            return self._json_error(400, "Missing url param")
        if not is_playlist_url(url):
            return self._json_error(400, "URL does not contain a playlist list= parameter")

        zip_path = None
        tmp_dir = None
        responded = False
        try:
            zip_path, tmp_dir, playlist_title = download_playlist(url, quality, dltype, job_id)
            filename = f"{sanitize_filename(playlist_title, 'playlist')}.zip"
            file_size = os.path.getsize(zip_path)

            self.send_response(200)
            self.send_header("Content-Type", "application/zip")
            self.send_header("Content-Length", str(file_size))
            self.send_header(
                "Content-Disposition",
                f'attachment; filename="{filename}"',
            )
            self.send_header("Connection", "keep-alive")
            self.send_cors()
            self.end_headers()
            responded = True

            with open(zip_path, "rb") as f:
                while True:
                    chunk = f.read(65536)
                    if not chunk:
                        break
                    try:
                        self.wfile.write(chunk)
                    except (BrokenPipeError, ConnectionResetError):
                        debug_log("Client disconnected during playlist ZIP stream")
                        break
        except Exception as e:
            print(f"[ytdrop] Playlist download error: {e}", file=sys.stderr)
            if not responded:
                return self._json_error(500, str(e) or "Playlist download failed")
        finally:
            if tmp_dir:
                shutil.rmtree(tmp_dir, ignore_errors=True)
            if zip_path:
                try:
                    os.remove(zip_path)
                except OSError:
                    pass

    def _handle_download(self, params):
        url = params.get("url", [None])[0]
        itag = params.get("itag", [None])[0]
        title = params.get("title", ["video"])[0]
        fmt_type = params.get("type", ["video"])[0]
        needs_merge = params.get("merge", ["0"])[0] == "1"
        ext = params.get("ext", ["mp4"])[0]

        if not url or not itag:
            return self._json_error(400, "Missing url or itag")

        safe_title = sanitize_filename(title, "download", 80)

        if needs_merge:
            # ── High-res path (1080p / 720p) ────────────────────────────────
            # ffmpeg cannot mux to stdout reliably; save to a temp file first.
            filename = f"{safe_title}.mp4"
            tmp_path = os.path.join(tempfile.gettempdir(), f"ytdrop_{uuid.uuid4().hex}.mp4")
            format_sel = f"{itag}+bestaudio[ext=m4a]/bestaudio"
            responded = False
            cmd = [
                "yt-dlp",
                "-f", format_sel,
                "--merge-output-format", "mp4",
                *FAST_FLAGS,
                "-o", tmp_path,
                url,
            ]
            try:
                # Wait for the full mux to complete before streaming
                result = subprocess.run(
                    cmd,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                if result.returncode != 0:
                    return self._json_error(500, "yt-dlp merge failed")

                file_size = os.path.getsize(tmp_path)

                self.send_response(200)
                self.send_header("Content-Type", "video/mp4")
                self.send_header("Content-Length", str(file_size))
                self.send_header(
                    "Content-Disposition",
                    f'attachment; filename="{filename}"',
                )
                self.send_header("Connection", "keep-alive")
                self.send_cors()
                self.end_headers()
                responded = True

                with open(tmp_path, "rb") as f:
                    while True:
                        chunk = f.read(65536)
                        if not chunk:
                            break
                        try:
                            self.wfile.write(chunk)
                        except (BrokenPipeError, ConnectionResetError):
                            debug_log("Client disconnected during merged stream")
                            break
            except Exception as e:
                print(f"[ytdrop] Merge download error: {e}", file=sys.stderr)
                if not responded:
                    return self._json_error(500, "Merge download failed")
            finally:
                # Always clean up temp file
                try:
                    os.remove(tmp_path)
                except OSError:
                    pass
        else:
            # ── Low-res / audio path (480p and below, audio-only) ───────────
            # These formats already carry audio; stream stdout directly.
            filename = f"{safe_title}.{ext}"
            cmd = [
                "yt-dlp",
                "-f", itag,
                *FAST_FLAGS,
                "-o", "-",
                url,
            ]

            proc = None
            try:
                proc = subprocess.Popen(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,
                )

                first_chunk = proc.stdout.read(65536)
                if not first_chunk:
                    proc.wait()
                    return self._json_error(500, "yt-dlp download failed")

                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header(
                    "Content-Disposition",
                    f'attachment; filename="{filename}"',
                )
                self.send_header("Connection", "keep-alive")
                self.send_cors()
                self.end_headers()

                self.wfile.write(first_chunk)
                while True:
                    chunk = proc.stdout.read(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                proc.wait()
            except (BrokenPipeError, ConnectionResetError):
                debug_log("Client disconnected (stream cancelled)")
                if proc and proc.poll() is None:
                    proc.terminate()
            except Exception as e:
                print(f"[ytdrop] Stream download error: {e}", file=sys.stderr)
                if proc and proc.poll() is None:
                    proc.terminate()


def main():
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"[ytdrop] Python server running on http://localhost:{PORT}")
    print("[ytdrop] Optimized: parallel fetch, caching, threading, fast flags")
    print("[ytdrop] Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[ytdrop] Shutting down.")
        server.server_close()


if __name__ == "__main__":
    main()
