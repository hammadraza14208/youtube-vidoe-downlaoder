import { useEffect, useRef, useState } from 'react';
import Head from 'next/head';

const DOWNLOAD_CLEANUP_DELAY = 30000;
const PLAYLIST_QUALITIES = [
  { value: '240', label: '240p' },
  { value: '360', label: '360p' },
  { value: '480', label: '480p' },
  { value: '720', label: '720p' },
  { value: '1080', label: '1080p' },
  { value: 'audio', label: 'Audio only' },
];

function formatBytes(bytes) {
  if (!bytes || bytes < 0) return '0 B';
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${Math.round(bytes)} B`;
}

function formatSpeed(bytesPerSecond) {
  if (!bytesPerSecond || bytesPerSecond < 0) return '0 KB/s';
  return `${formatBytes(bytesPerSecond)}/s`;
}

function getFilenameFromDisposition(disposition) {
  if (!disposition) return '';
  const utfMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i);
  if (utfMatch) {
    try {
      return decodeURIComponent(utfMatch[1].replace(/["']/g, ''));
    } catch {
      return utfMatch[1].replace(/["']/g, '');
    }
  }
  const plainMatch = disposition.match(/filename="?([^"]+)"?/i);
  return plainMatch ? plainMatch[1] : '';
}

function saveBlob(blob, filename) {
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

function detectUrlType(value) {
  if (!value) return 'unknown';
  try {
    const parsed = new URL(value);
    const hasList = parsed.searchParams.has('list');
    const isYoutuBe = parsed.hostname === 'youtu.be' && parsed.pathname.length > 1;
    const hasVideo = parsed.searchParams.has('v') || parsed.pathname.includes('/shorts/') || isYoutuBe;
    if (hasList && hasVideo) return 'both';
    if (hasList) return 'playlist';
    if (hasVideo || parsed.hostname === 'youtu.be') return 'video';
    return 'unknown';
  } catch {
    if (value.includes('list=') && (value.includes('v=') || value.includes('youtu.be'))) return 'both';
    if (value.includes('list=')) return 'playlist';
    return 'video';
  }
}

function stripPlaylistParam(urlStr) {
  try {
    const parsed = new URL(urlStr);
    parsed.searchParams.delete('list');
    parsed.searchParams.delete('index');
    return parsed.toString();
  } catch {
    return urlStr;
  }
}

function createJobId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function playlistQualityLabel(value) {
  return PLAYLIST_QUALITIES.find(option => option.value === value)?.label || `${value}p`;
}

export default function Home() {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState(null);
  const [playlistInfo, setPlaylistInfo] = useState(null);
  const [playlistQuality, setPlaylistQuality] = useState('720');
  const [playlistDownloading, setPlaylistDownloading] = useState(false);
  const [playlistProgress, setPlaylistProgress] = useState(null);
  const [tab, setTab] = useState('video');
  const [downloading, setDownloading] = useState({});
  const [downloads, setDownloads] = useState([]);
  const [modeChoice, setModeChoice] = useState(null); // null | 'video' | 'playlist'
  const inputRef = useRef(null);
  const playlistPollRef = useRef(null);

  useEffect(() => () => {
    if (playlistPollRef.current) {
      clearInterval(playlistPollRef.current);
    }
  }, []);

  async function fetchInfo(forceMode) {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) return;

    const urlType = detectUrlType(trimmedUrl);

    // If URL has both video + playlist and user hasn't chosen yet, show chooser
    if (urlType === 'both' && !forceMode) {
      setModeChoice('pending');
      setInfo(null);
      setPlaylistInfo(null);
      setError('');
      return;
    }

    const mode = forceMode || (urlType === 'playlist' ? 'playlist' : 'video');

    setLoading(true);
    setError('');
    setInfo(null);
    setPlaylistInfo(null);
    setPlaylistProgress(null);
    setModeChoice(null);
    stopPlaylistPolling();
    try {
      if (mode === 'playlist') {
        const res = await fetch(`/api/playlist-info?url=${encodeURIComponent(trimmedUrl)}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to fetch playlist info');
        setPlaylistInfo(data);
        return;
      }

      // For single video, strip playlist params so backend uses --no-playlist
      const videoUrl = urlType === 'both' ? stripPlaylistParam(trimmedUrl) : trimmedUrl;
      const res = await fetch(`/api/info?url=${encodeURIComponent(videoUrl)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to fetch info');
      setInfo(data);
      setTab('video');
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  function handleKey(e) {
    if (e.key === 'Enter') fetchInfo();
  }

  async function startDownload(fmt, type) {
    const key = fmt.itag;
    const id = Date.now() + Math.random();
    const title = info.title || 'video';
    const ext = fmt.needsMerge ? 'mp4' : (fmt.ext || (type === 'audio' ? 'm4a' : 'mp4'));
    const safeTitle = title.replace(/[^a-z0-9]/gi, '_').toLowerCase().slice(0, 60) || 'download';
    setDownloading(d => ({ ...d, [key]: true }));
    setDownloads(prev => [...prev, {
      id,
      title,
      quality: fmt.label,
      type,
      ext,
      status: 'downloading',
      loadedBytes: 0,
      totalBytes: fmt.size_bytes || 0,
      speed: 0,
      percent: 0,
    }]);

    const params = new URLSearchParams({
      url: url.trim(),
      itag: fmt.itag,
      title,
      type,
      merge: fmt.needsMerge ? '1' : '0',
      ext,
    });

    const updateDownload = patch => {
      setDownloads(prev => prev.map(d => (
        d.id === id ? { ...d, ...patch } : d
      )));
    };

    try {
      const res = await fetch(`/api/download?${params.toString()}`);
      if (!res.ok) {
        let message = 'Download failed';
        try {
          const text = await res.text();
          try {
            const data = JSON.parse(text);
            message = data.error || text || message;
          } catch {
            message = text || message;
          }
        } catch {
          message = 'Download failed';
        }
        throw new Error(message);
      }

      const headerTotal = Number(res.headers.get('content-length')) || 0;
      const totalBytes = headerTotal || fmt.size_bytes || 0;
      const filename = getFilenameFromDisposition(res.headers.get('content-disposition')) || `${safeTitle}.${ext}`;

      updateDownload({ totalBytes });

      if (!res.body) {
        const blob = await res.blob();
        saveBlob(blob, filename);
        updateDownload({
          loadedBytes: blob.size,
          totalBytes: totalBytes || blob.size,
          percent: 100,
          speed: 0,
          status: 'done',
        });
        setTimeout(() => setDownloads(prev => prev.filter(d => d.id !== id)), DOWNLOAD_CLEANUP_DELAY);
        return;
      }

      const reader = res.body.getReader();
      const chunks = [];
      let loadedBytes = 0;
      const startedAt = performance.now();
      let lastUiUpdate = startedAt;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        chunks.push(value);
        loadedBytes += value.length;

        const now = performance.now();
        if (now - lastUiUpdate >= 200) {
          const elapsedSeconds = Math.max((now - startedAt) / 1000, 0.001);
          const percent = totalBytes ? Math.min(99, Math.round((loadedBytes / totalBytes) * 100)) : 0;
          updateDownload({
            loadedBytes,
            speed: loadedBytes / elapsedSeconds,
            percent,
          });
          lastUiUpdate = now;
        }
      }

      const elapsedSeconds = Math.max((performance.now() - startedAt) / 1000, 0.001);
      const blob = new Blob(chunks, {
        type: res.headers.get('content-type') || 'application/octet-stream',
      });
      saveBlob(blob, filename);
      updateDownload({
        loadedBytes,
        totalBytes: totalBytes || loadedBytes,
        speed: loadedBytes / elapsedSeconds,
        percent: 100,
        status: 'done',
      });

      setTimeout(() => setDownloads(prev => prev.filter(d => d.id !== id)), DOWNLOAD_CLEANUP_DELAY);
    } catch (e) {
      updateDownload({
        status: 'error',
        error: e.message,
      });
    } finally {
      setDownloading(d => { const n = { ...d }; delete n[key]; return n; });
    }
  }

  function stopPlaylistPolling() {
    if (playlistPollRef.current) {
      clearInterval(playlistPollRef.current);
      playlistPollRef.current = null;
    }
  }

  async function pollPlaylistProgress(jobId) {
    try {
      const res = await fetch(`/api/playlist-progress?id=${encodeURIComponent(jobId)}`);
      if (!res.ok) return;
      const data = await res.json();
      setPlaylistProgress(prev => ({ ...(prev || {}), ...data, id: jobId }));
      if (data.status === 'done' || data.status === 'error') {
        stopPlaylistPolling();
      }
    } catch {
      // Keep polling; the download request may still be running.
    }
  }

  function startPlaylistPolling(jobId) {
    stopPlaylistPolling();
    pollPlaylistProgress(jobId);
    playlistPollRef.current = setInterval(() => pollPlaylistProgress(jobId), 2000);
  }

  async function startPlaylistDownload() {
    if (!playlistInfo || playlistDownloading) return;

    const jobId = createJobId();
    const selectedType = playlistQuality === 'audio' ? 'audio' : 'video';
    const qualityLabel = playlistQualityLabel(playlistQuality);

    setPlaylistDownloading(true);
    setError('');
    setPlaylistProgress({
      id: jobId,
      current: 0,
      total: playlistInfo.videoCount || 0,
      status: 'preparing',
      message: 'Preparing playlist download...',
    });
    startPlaylistPolling(jobId);

    const params = new URLSearchParams({
      url: url.trim(),
      quality: playlistQuality,
      type: selectedType,
      id: jobId,
    });

    try {
      const res = await fetch(`/api/playlist-download?${params.toString()}`);
      if (!res.ok) {
        let message = 'Playlist download failed';
        try {
          const text = await res.text();
          try {
            const data = JSON.parse(text);
            message = data.error || text || message;
          } catch {
            message = text || message;
          }
        } catch {
          message = 'Playlist download failed';
        }
        throw new Error(message);
      }

      const filename = getFilenameFromDisposition(res.headers.get('content-disposition')) || `${playlistInfo.playlistTitle || 'playlist'}.zip`;
      const blob = await res.blob();
      saveBlob(blob, filename);
      setPlaylistProgress(prev => ({
        ...(prev || {}),
        id: jobId,
        current: playlistInfo.videoCount || prev?.current || 0,
        total: playlistInfo.videoCount || prev?.total || 0,
        status: 'done',
        message: `ZIP ready: ${qualityLabel}`,
      }));
    } catch (e) {
      setPlaylistProgress(prev => ({
        ...(prev || {}),
        id: jobId,
        status: 'error',
        message: e.message || 'Playlist download failed',
      }));
      setError(e.message || 'Playlist download failed');
    } finally {
      stopPlaylistPolling();
      setPlaylistDownloading(false);
    }
  }

  function clearFinishedDownloads() {
    setDownloads(prev => prev.filter(d => d.status === 'downloading'));
  }

  function truncateTitle(title) {
    return title.length > 30 ? `${title.slice(0, 30)}...` : title;
  }

  function playlistProgressText() {
    if (!playlistProgress) {
      return 'This may take several minutes for larger playlists.';
    }
    if (playlistProgress.status === 'error') {
      return playlistProgress.message || 'Playlist download failed.';
    }
    if (playlistProgress.status === 'done') {
      return playlistProgress.message || 'ZIP ready.';
    }
    if (playlistProgress.message) {
      return playlistProgress.message;
    }
    if (playlistProgress.current && playlistProgress.total) {
      return `Downloading video ${playlistProgress.current} of ${playlistProgress.total}...`;
    }
    return 'Preparing playlist download...';
  }

  const formats = info ? (tab === 'video' ? info.videoFormats : info.audioFormats) : [];
  const playlistPercent = playlistProgress?.total
    ? Math.min(100, Math.round(((playlistProgress.current || 0) / playlistProgress.total) * 100))
    : 0;

  return (
    <>
      <Head>
        <title>ytdrop — YouTube Video Downloader</title>
        <meta name="description" content="Paste any YouTube URL and download video or audio in your preferred quality. Fast, free, and reliable." />
        <meta name="viewport" content="width=device-width, initial-scale=1" />

      </Head>

      <div className="page">
        {/* Radial glow */}
        <div className="glow" />

        {/* Header */}
        <header className="header">
          <div className="logo">
            <div className="logo-icon">
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <path d="M9 3v9M5 8l4 4 4-4" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>
            <span className="logo-text">ytdrop</span>
          </div>
          <p className="tagline">Single video or entire playlist — paste a link and download.</p>
        </header>

        {/* URL Input */}
        <section className="input-section">
          <div className="input-wrap">
            <span className="input-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/>
                <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/>
              </svg>
            </span>
            <input
              ref={inputRef}
              type="text"
              className="url-input"
              placeholder="Paste YouTube URL here..."
              value={url}
              onChange={e => setUrl(e.target.value)}
              onKeyDown={handleKey}
              id="youtube-url-input"
            />
            {url && (
              <button className="clear-btn" onClick={() => { setUrl(''); setInfo(null); setPlaylistInfo(null); setPlaylistProgress(null); setModeChoice(null); stopPlaylistPolling(); setError(''); inputRef.current?.focus(); }} title="Clear">
                ✕
              </button>
            )}
            <button className="fetch-btn" onClick={fetchInfo} disabled={loading || !url.trim()} id="fetch-btn">
              {loading ? <span className="spinner" /> : 'Fetch'}
            </button>
          </div>
          {error && <div className="error-msg">⚠ {error}</div>}
        </section>

        {/* Mode Chooser — shown when URL has both video + playlist */}
        {modeChoice === 'pending' && (
          <section className="mode-chooser">
            <p className="mode-heading">This URL contains both a video and a playlist</p>
            <p className="mode-sub">What would you like to download?</p>
            <div className="mode-cards">
              <button className="mode-card" onClick={() => fetchInfo('video')} id="mode-video">
                <span className="mode-card-icon">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
                  </svg>
                </span>
                <span className="mode-card-title">Single Video</span>
                <span className="mode-card-desc">Download just this one video</span>
              </button>
              <button className="mode-card playlist" onClick={() => fetchInfo('playlist')} id="mode-playlist">
                <span className="mode-card-icon">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
                    <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
                  </svg>
                </span>
                <span className="mode-card-title">Entire Playlist</span>
                <span className="mode-card-desc">Download all videos as ZIP</span>
              </button>
            </div>
          </section>
        )}

        {/* How it works — shown when no video loaded */}
        {!info && !playlistInfo && !loading && modeChoice !== 'pending' && (
          <section className="how-it-works">
            <div className="steps">
              {[
                { n: '01', icon: '🔗', title: 'Paste URL', desc: 'Copy any YouTube video or playlist link' },
                { n: '02', icon: '⚡', title: 'Fetch Info', desc: 'We detect whether it\'s a single video or a playlist' },
                { n: '03', icon: '⬇', title: 'Download', desc: 'Pick quality — single file or entire playlist as ZIP' },
              ].map(s => (
                <div className="step-card" key={s.n}>
                  <div className="step-num">{s.n}</div>
                  <div className="step-icon">{s.icon}</div>
                  <h3 className="step-title">{s.title}</h3>
                  <p className="step-desc">{s.desc}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Video Result */}
        {info && (
          <section className="result-section">
            <div className="video-card">
              <div className="thumb-wrap">
                <img src={info.thumbnail} alt={info.title} className="thumb" />
                <span className="duration-badge">{info.duration}</span>
              </div>
              <div className="video-meta">
                <h2 className="video-title">{info.title}</h2>
                <div className="video-stats">
                  <span className="stat">👤 {info.author}</span>
                  <span className="stat">👁 {info.views}</span>
                </div>
              </div>
            </div>

            {/* Tab switcher */}
            <div className="tabs">
              <button className={`tab-btn ${tab === 'video' ? 'active' : ''}`} onClick={() => setTab('video')} id="tab-video">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{marginRight:6}}>
                  <polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
                </svg>
                Video
              </button>
              <button className={`tab-btn ${tab === 'audio' ? 'active' : ''}`} onClick={() => setTab('audio')} id="tab-audio">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{marginRight:6}}>
                  <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
                </svg>
                Audio
              </button>
            </div>

            {/* Format list */}
            <div className="format-list">
              {formats.length === 0 && (
                <div className="no-formats">No {tab} formats available.</div>
              )}
              {formats.map(fmt => (
                <div className="format-row" key={fmt.itag}>
                  <div className="fmt-left">
                    <span className={`quality-badge ${tab === 'audio' ? 'audio' : ''}`}>
                      {fmt.label}
                      {fmt.hd && <span className="hd-tag">HD</span>}
                    </span>
                    <span className="fmt-ext">.{fmt.ext}</span>
                    {fmt.needsMerge && <span className="merge-tag">+audio</span>}
                  </div>
                  <div className="fmt-right">
                    <span className="fmt-size">{fmt.size}</span>
                    <button
                      className={`dl-btn ${downloading[fmt.itag] ? 'dl-active' : ''}`}
                      onClick={() => startDownload(fmt, tab)}
                      disabled={!!downloading[fmt.itag]}
                      id={`dl-${fmt.itag}`}
                    >
                      {downloading[fmt.itag] ? (
                        <><span className="spinner sm" /> Downloading…</>
                      ) : (
                        <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{marginRight:5}}>
                          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                        </svg>Download</>
                      )}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {playlistInfo && (
          <section className="playlist-section">
            <div className="playlist-card">
              <div className="playlist-heading">
                <div>
                  <div className="playlist-kicker">📋 Playlist detected — {playlistInfo.videoCount} videos</div>
                  <h2 className="playlist-title">{playlistInfo.playlistTitle || 'YouTube Playlist'}</h2>
                </div>
                <span className="playlist-count">{playlistInfo.videoCount}</span>
              </div>

              <p className="playlist-warning">
                This may take several minutes. Downloads are limited to the first {playlistInfo.limit || 50} videos
                {playlistInfo.truncated ? ' for safety.' : '.'}
              </p>

              <div className="playlist-controls">
                <label className="playlist-quality-label" htmlFor="playlist-quality">Quality</label>
                <select
                  id="playlist-quality"
                  className="playlist-quality"
                  value={playlistQuality}
                  onChange={e => setPlaylistQuality(e.target.value)}
                  disabled={playlistDownloading}
                >
                  {PLAYLIST_QUALITIES.map(option => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
                <button
                  className={`playlist-download-btn ${playlistDownloading ? 'dl-active' : ''}`}
                  onClick={startPlaylistDownload}
                  disabled={playlistDownloading}
                >
                  {playlistDownloading ? (
                    <><span className="spinner sm" /> Downloading ZIP…</>
                  ) : (
                    <>Download All as ZIP</>
                  )}
                </button>
              </div>

              <div className="playlist-progress-block">
                <div className={`playlist-progress-text ${playlistProgress?.status === 'error' ? 'error' : ''}`}>
                  {playlistProgressText()}
                </div>
                {(playlistDownloading || playlistProgress) && (
                  <span className={`progress-track playlist-progress ${playlistProgress?.total ? '' : 'indeterminate'}`}>
                    <span
                      className="progress-fill"
                      style={{ width: playlistProgress?.total ? `${playlistPercent}%` : '45%' }}
                    />
                  </span>
                )}
              </div>

              <ol className="playlist-video-list">
                {playlistInfo.videos.map((video, index) => (
                  <li className="playlist-video-row" key={`${video.id}-${index}`}>
                    <span className="playlist-video-index">{String(index + 1).padStart(2, '0')}</span>
                    <span className="playlist-video-title" title={video.title}>{video.title}</span>
                    <span className="playlist-video-duration">{video.duration || '—'}</span>
                  </li>
                ))}
              </ol>
            </div>
          </section>
        )}

        <footer className="footer">
          <p>For personal use only. Respect copyright laws and YouTube&apos;s Terms of Service.</p>
        </footer>
      </div>

      {downloads.length > 0 && (
        <aside className="downloads-panel" aria-live="polite">
          <div className="downloads-header">
            <div className="downloads-title">
              <span className="downloads-title-icon">⬇</span>
              Downloads
            </div>
            <button className="downloads-clear" onClick={clearFinishedDownloads} title="Clear finished downloads">
              ×
            </button>
          </div>
          <div className="downloads-list">
            {downloads.map(download => (
              <div className="download-row" key={download.id}>
                <div className="download-main">
                  <span className="download-type-icon">{download.type === 'audio' ? '🎵' : '🎬'}</span>
                  <span className="download-name" title={download.title}>{truncateTitle(download.title)}</span>
                  <span className={`download-quality ${download.type === 'audio' ? 'audio' : ''}`}>{download.quality}</span>
                  <span className="download-ext">{download.ext.toUpperCase()}</span>
                </div>
                <div className="download-progress-row">
                  {download.status === 'downloading' ? (
                    <>
                      <span className={`progress-track ${download.totalBytes ? '' : 'indeterminate'}`}>
                        <span
                          className="progress-fill"
                          style={{ width: download.totalBytes ? `${Math.min(download.percent || 0, 100)}%` : '45%' }}
                        />
                      </span>
                      <span className="download-status">
                        {download.totalBytes ? `${download.percent || 0}%` : formatBytes(download.loadedBytes)}
                      </span>
                      <span className="download-speed">{formatSpeed(download.speed)}</span>
                    </>
                  ) : (
                    <span className={`download-status ${download.status}`}>
                      {download.status === 'done'
                        ? `✓ Done ${formatBytes(download.loadedBytes)}`
                        : `✗ ${download.error || 'Failed'}`}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </aside>
      )}

      <style jsx global>{`
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #0a0a0f; color: #e8e8f0; font-family: 'Inter', -apple-system, sans-serif; min-height: 100vh; }

        .page { position: relative; max-width: 760px; margin: 0 auto; padding: 0 20px 60px; overflow: hidden; }

        .glow {
          position: fixed; top: -200px; left: 50%; transform: translateX(-50%);
          width: 700px; height: 500px; pointer-events: none; z-index: 0;
          background: radial-gradient(ellipse at center, rgba(108,99,255,0.18) 0%, transparent 70%);
        }

        .header { position: relative; z-index: 1; text-align: center; padding: 52px 0 36px; }
        .logo { display: inline-flex; align-items: center; gap: 10px; margin-bottom: 12px; }
        .logo-icon {
          width: 38px; height: 38px; border-radius: 10px;
          background: linear-gradient(135deg, #6c63ff, #a78bfa);
          display: flex; align-items: center; justify-content: center;
          box-shadow: 0 4px 20px rgba(108,99,255,0.4);
        }
        .logo-text { font-size: 28px; font-weight: 800; letter-spacing: -1px; color: #fff; }
        .tagline { color: #7878a0; font-size: 15px; font-weight: 400; }

        .input-section { position: relative; z-index: 1; margin-bottom: 48px; }
        .input-wrap {
          display: flex; align-items: center; gap: 8px;
          background: #111118; border: 1.5px solid #22223a; border-radius: 14px;
          padding: 10px 12px; transition: border-color 0.2s;
        }
        .input-wrap:focus-within { border-color: #6c63ff; box-shadow: 0 0 0 3px rgba(108,99,255,0.12); }
        .input-icon { color: #4a4a6a; flex-shrink: 0; display: flex; }
        .url-input {
          flex: 1; background: none; border: none; outline: none; color: #e8e8f0;
          font-size: 15px; font-family: inherit; min-width: 0;
        }
        .url-input::placeholder { color: #3e3e5e; }
        .clear-btn {
          background: none; border: none; color: #4a4a6a; cursor: pointer; font-size: 13px;
          padding: 4px 6px; border-radius: 6px; transition: color 0.15s;
        }
        .clear-btn:hover { color: #e8e8f0; }
        .fetch-btn {
          flex-shrink: 0; background: #6c63ff; color: #fff; border: none; border-radius: 9px;
          padding: 9px 22px; font-size: 14px; font-weight: 600; cursor: pointer;
          transition: background 0.2s, transform 0.1s, box-shadow 0.2s;
          display: flex; align-items: center; gap: 8px;
        }
        .fetch-btn:hover:not(:disabled) { background: #7c73ff; box-shadow: 0 4px 20px rgba(108,99,255,0.4); }
        .fetch-btn:active:not(:disabled) { transform: scale(0.97); }
        .fetch-btn:disabled { opacity: 0.6; cursor: not-allowed; }

        .error-msg { color: #ff6b6b; font-size: 13px; margin-top: 10px; padding-left: 4px; }

        /* Spinner */
        .spinner {
          display: inline-block; width: 16px; height: 16px; border-radius: 50%;
          border: 2px solid rgba(255,255,255,0.3); border-top-color: #fff;
          animation: spin 0.7s linear infinite;
        }
        .spinner.sm { width: 12px; height: 12px; }
        @keyframes spin { to { transform: rotate(360deg); } }

        /* Mode Chooser */
        .mode-chooser {
          position: relative; z-index: 1; margin-bottom: 40px; text-align: center;
          animation: fadeSlideUp 0.3s ease-out;
        }
        @keyframes fadeSlideUp {
          from { opacity: 0; transform: translateY(12px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .mode-heading {
          font-size: 16px; font-weight: 800; color: #e8e8f0; margin-bottom: 6px;
        }
        .mode-sub {
          font-size: 13px; color: #7878a0; margin-bottom: 20px;
        }
        .mode-cards {
          display: grid; grid-template-columns: 1fr 1fr; gap: 16px; max-width: 460px; margin: 0 auto;
        }
        .mode-card {
          display: flex; flex-direction: column; align-items: center; gap: 10px;
          background: #111118; border: 1.5px solid #22223a; border-radius: 16px;
          padding: 28px 16px; cursor: pointer; transition: all 0.25s ease;
          font-family: inherit; color: #e8e8f0;
        }
        .mode-card:hover {
          border-color: #6c63ff; transform: translateY(-4px);
          box-shadow: 0 8px 30px rgba(108,99,255,0.2);
        }
        .mode-card.playlist:hover {
          border-color: #34d399;
          box-shadow: 0 8px 30px rgba(52,211,153,0.2);
        }
        .mode-card-icon { color: #6c63ff; }
        .mode-card.playlist .mode-card-icon { color: #34d399; }
        .mode-card-title { font-size: 16px; font-weight: 800; }
        .mode-card-desc { font-size: 12px; color: #7878a0; }

        /* How it works */
        .how-it-works { position: relative; z-index: 1; margin-bottom: 40px; }
        .steps { display: grid; grid-template-columns: repeat(3,1fr); gap: 16px; }
        .step-card {
          background: #111118; border: 1px solid #1e1e30; border-radius: 16px;
          padding: 28px 20px; text-align: center; transition: border-color 0.2s, transform 0.2s;
        }
        .step-card:hover { border-color: #6c63ff40; transform: translateY(-3px); }
        .step-num { font-size: 11px; font-weight: 700; color: #6c63ff; letter-spacing: 1px; margin-bottom: 12px; }
        .step-icon { font-size: 28px; margin-bottom: 12px; }
        .step-title { font-size: 15px; font-weight: 700; margin-bottom: 8px; color: #e8e8f0; }
        .step-desc { font-size: 13px; color: #5a5a7a; line-height: 1.5; }

        /* Result */
        .result-section { position: relative; z-index: 1; }
        .video-card {
          display: flex; gap: 20px; background: #111118; border: 1px solid #1e1e30;
          border-radius: 16px; padding: 20px; margin-bottom: 24px; overflow: hidden;
        }
        .thumb-wrap { position: relative; flex-shrink: 0; }
        .thumb { width: 180px; height: 102px; border-radius: 10px; object-fit: cover; display: block; }
        .duration-badge {
          position: absolute; bottom: 6px; right: 6px; background: rgba(0,0,0,0.8);
          color: #fff; font-size: 11px; font-weight: 600; padding: 2px 7px; border-radius: 5px;
        }
        .video-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center; }
        .video-title { font-size: 16px; font-weight: 700; color: #e8e8f0; line-height: 1.4; margin-bottom: 10px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
        .video-stats { display: flex; gap: 16px; flex-wrap: wrap; }
        .stat { font-size: 13px; color: #6060a0; }

        /* Tabs */
        .tabs { display: flex; gap: 8px; margin-bottom: 16px; }
        .tab-btn {
          display: flex; align-items: center; padding: 9px 20px; border-radius: 10px;
          border: 1.5px solid #22223a; background: #111118; color: #7878a0;
          font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.2s;
        }
        .tab-btn.active { background: #6c63ff; border-color: #6c63ff; color: #fff; box-shadow: 0 4px 16px rgba(108,99,255,0.3); }
        .tab-btn:not(.active):hover { border-color: #6c63ff60; color: #b0b0d0; }

        /* Format rows */
        .format-list { display: flex; flex-direction: column; gap: 10px; margin-bottom: 32px; }
        .no-formats { text-align: center; color: #5a5a7a; padding: 40px 0; font-size: 14px; }
        .format-row {
          display: flex; align-items: center; justify-content: space-between; gap: 12px;
          background: #111118; border: 1px solid #1e1e30; border-radius: 12px;
          padding: 14px 18px; transition: border-color 0.2s;
        }
        .format-row:hover { border-color: #6c63ff40; }
        .fmt-left { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
        .quality-badge {
          background: rgba(108,99,255,0.15); color: #a89bff; font-size: 13px; font-weight: 700;
          padding: 4px 10px; border-radius: 7px; display: flex; align-items: center; gap: 6px;
          border: 1px solid rgba(108,99,255,0.25);
        }
        .quality-badge.audio { background: rgba(52,211,153,0.12); color: #6ee7b7; border-color: rgba(52,211,153,0.25); }
        .hd-tag {
          background: #6c63ff; color: #fff; font-size: 9px; font-weight: 800;
          padding: 1px 5px; border-radius: 4px; letter-spacing: 0.5px;
        }
        .fmt-ext { font-size: 12px; color: #4a4a6a; font-weight: 500; text-transform: uppercase; }
        .merge-tag {
          font-size: 11px; color: #60a0d0; background: rgba(96,160,208,0.1);
          padding: 2px 7px; border-radius: 5px; border: 1px solid rgba(96,160,208,0.2);
        }
        .fmt-right { display: flex; align-items: center; gap: 14px; flex-shrink: 0; }
        .fmt-size { font-size: 13px; color: #5a5a7a; min-width: 52px; text-align: right; }
        .dl-btn {
          display: flex; align-items: center; background: #1a1a28; border: 1.5px solid #2a2a40;
          color: #b0b0d0; font-size: 13px; font-weight: 600; padding: 8px 16px; border-radius: 9px;
          cursor: pointer; transition: all 0.2s; white-space: nowrap;
        }
        .dl-btn:hover:not(:disabled) {
          background: #6c63ff; border-color: #6c63ff; color: #fff;
          box-shadow: 0 4px 18px rgba(108,99,255,0.4);
        }
        .dl-btn:disabled { opacity: 0.6; cursor: not-allowed; }
        .dl-btn.dl-active { background: #2a2a40; }

        .playlist-section { position: relative; z-index: 1; margin-bottom: 32px; }
        .playlist-card {
          background: #111118; border: 1px solid #1e1e30; border-radius: 14px;
          padding: 20px; overflow: hidden;
        }
        .playlist-heading {
          display: flex; align-items: flex-start; justify-content: space-between; gap: 16px;
          margin-bottom: 12px;
        }
        .playlist-kicker { color: #80efc2; font-size: 13px; font-weight: 800; margin-bottom: 7px; }
        .playlist-title {
          color: #fff; font-size: 18px; font-weight: 800; line-height: 1.35;
          overflow-wrap: anywhere;
        }
        .playlist-count {
          flex-shrink: 0; min-width: 46px; height: 34px; border-radius: 8px;
          display: inline-flex; align-items: center; justify-content: center;
          background: rgba(52,211,153,0.12); border: 1px solid rgba(52,211,153,0.28);
          color: #80efc2; font-size: 14px; font-weight: 900;
        }
        .playlist-warning {
          color: #c8a96a; background: rgba(245,158,11,0.08); border: 1px solid rgba(245,158,11,0.18);
          border-radius: 8px; padding: 10px 12px; font-size: 13px; line-height: 1.45; margin-bottom: 16px;
        }
        .playlist-controls {
          display: grid; grid-template-columns: auto minmax(140px, 180px) auto;
          align-items: center; gap: 10px; margin-bottom: 14px;
        }
        .playlist-quality-label { color: #7878a0; font-size: 13px; font-weight: 800; }
        .playlist-quality {
          width: 100%; height: 40px; border-radius: 8px; border: 1.5px solid #2a2a40;
          background: #171722; color: #e8e8f0; padding: 0 10px; font-size: 14px;
          outline: none;
        }
        .playlist-quality:focus { border-color: #6ee7b7; box-shadow: 0 0 0 3px rgba(52,211,153,0.12); }
        .playlist-download-btn {
          display: inline-flex; align-items: center; justify-content: center; gap: 8px;
          min-height: 40px; border: 1.5px solid #2a2a40; border-radius: 8px;
          background: #1a1a28; color: #e8e8f0; padding: 0 16px; font-size: 13px;
          font-weight: 800; cursor: pointer; white-space: nowrap; transition: all 0.2s;
        }
        .playlist-download-btn:hover:not(:disabled) {
          background: #10b981; border-color: #10b981; color: #07110d;
          box-shadow: 0 4px 18px rgba(16,185,129,0.28);
        }
        .playlist-download-btn:disabled { opacity: 0.65; cursor: not-allowed; }
        .playlist-download-btn.dl-active { background: #1d2d2a; border-color: #2f5f50; color: #b6f4dc; }
        .playlist-progress-block { display: grid; gap: 9px; margin-bottom: 16px; }
        .playlist-progress-text { color: #a8a8c6; font-size: 13px; font-weight: 700; min-height: 18px; }
        .playlist-progress-text.error { color: #ff6b6b; }
        .playlist-progress { height: 7px; }
        .playlist-video-list {
          list-style: none; display: grid; gap: 8px; max-height: 310px; overflow-y: auto;
          padding-right: 4px;
        }
        .playlist-video-row {
          display: grid; grid-template-columns: 36px minmax(0, 1fr) auto;
          align-items: center; gap: 10px; min-height: 42px; border: 1px solid #202034;
          border-radius: 8px; background: #15151f; padding: 9px 10px;
        }
        .playlist-video-index { color: #5a5a7a; font-size: 11px; font-weight: 900; }
        .playlist-video-title {
          min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
          color: #dedef0; font-size: 13px; font-weight: 700;
        }
        .playlist-video-duration { color: #707095; font-size: 12px; font-weight: 800; white-space: nowrap; }

        .downloads-panel {
          position: fixed; right: 24px; bottom: 24px; z-index: 20;
          width: 340px; max-height: 400px; overflow: hidden;
          background: #111118; border: 1px solid #2a2a38; border-radius: 16px;
          box-shadow: 0 18px 45px rgba(0,0,0,0.36);
          animation: downloadsIn 0.24s ease-out;
        }
        .downloads-header {
          display: flex; align-items: center; justify-content: space-between; gap: 12px;
          padding: 13px 14px; border-bottom: 1px solid #2a2a38;
        }
        .downloads-title {
          display: flex; align-items: center; gap: 8px; color: #f2f2fb;
          font-size: 14px; font-weight: 800;
        }
        .downloads-title-icon { color: #a89bff; font-size: 15px; line-height: 1; }
        .downloads-clear {
          width: 26px; height: 26px; border-radius: 8px; border: 1px solid #2a2a38;
          background: #1a1a24; color: #7878a0; cursor: pointer; font-size: 18px;
          line-height: 1; display: flex; align-items: center; justify-content: center;
          transition: color 0.15s, border-color 0.15s, background 0.15s;
        }
        .downloads-clear:hover {
          color: #fff; border-color: #6c63ff80; background: #202030;
        }
        .downloads-list {
          display: flex; flex-direction: column; max-height: 338px; overflow-y: auto;
        }
        .download-row {
          padding: 13px 14px; color: #d8d8e8; font-size: 12px;
          border-bottom: 1px solid rgba(42,42,56,0.75);
        }
        .download-row:last-child { border-bottom: none; }
        .download-main {
          display: grid; grid-template-columns: 20px minmax(0, 1fr) auto auto;
          align-items: center; gap: 7px; margin-bottom: 9px;
        }
        .download-type-icon { font-size: 15px; line-height: 1; }
        .download-name {
          min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
          color: #dedef0; font-weight: 600;
        }
        .download-quality {
          color: #a89bff; background: rgba(108,99,255,0.15);
          border: 1px solid rgba(108,99,255,0.25); border-radius: 7px;
          padding: 3px 7px; font-size: 11px; font-weight: 800; white-space: nowrap;
        }
        .download-quality.audio {
          color: #6ee7b7; background: rgba(52,211,153,0.12);
          border-color: rgba(52,211,153,0.25);
        }
        .download-ext {
          color: #a8a8c6; background: #1a1a24; border: 1px solid #2a2a38;
          border-radius: 6px; padding: 3px 6px; font-size: 10px; font-weight: 800;
          white-space: nowrap;
        }
        .download-progress-row {
          display: grid; grid-template-columns: minmax(0, 1fr) auto auto;
          align-items: center; gap: 10px; padding-left: 27px;
        }
        .progress-track {
          position: relative; display: block; height: 5px; border-radius: 999px;
          overflow: hidden; background: #24243a; border: 1px solid #30304a;
        }
        .progress-fill {
          position: absolute; inset: 0 auto 0 0; width: 0;
          border-radius: inherit; background: linear-gradient(90deg, #6c63ff, #6ee7b7);
          transition: width 0.2s ease;
        }
        .progress-track.indeterminate .progress-fill {
          background-size: 200% auto;
          animation: indeterminateProgress 1.15s ease-in-out infinite;
        }
        .download-status {
          color: #7878a0; font-size: 11px; font-weight: 600; white-space: nowrap;
        }
        .download-speed {
          color: #a8a8c6; font-size: 11px; font-weight: 700; min-width: 66px; text-align: right;
          white-space: nowrap;
        }
        .download-status.done { color: #6ee7b7; }
        .download-status.error { color: #ff6b6b; }
        .download-progress-row > .download-status.done,
        .download-progress-row > .download-status.error {
          grid-column: 1 / -1; min-width: 0; white-space: normal; line-height: 1.35;
        }
        @keyframes indeterminateProgress {
          0% { transform: translateX(-100%); }
          50% { transform: translateX(65%); }
          100% { transform: translateX(230%); }
        }
        @keyframes downloadsIn {
          from { opacity: 0; transform: translateY(18px); }
          to { opacity: 1; transform: translateY(0); }
        }

        .footer { text-align: center; padding: 20px 0; color: #3a3a5a; font-size: 12px; position: relative; z-index: 1; }

        /* Responsive */
        @media (max-width: 600px) {
          .mode-cards { grid-template-columns: 1fr; max-width: 280px; }
          .steps { grid-template-columns: 1fr; }
          .video-card { flex-direction: column; }
          .thumb { width: 100%; height: auto; aspect-ratio: 16/9; }
          .format-row { flex-wrap: wrap; gap: 10px; }
          .fmt-right { width: 100%; justify-content: space-between; }
          .playlist-heading { align-items: stretch; }
          .playlist-controls { grid-template-columns: 1fr; }
          .playlist-download-btn { width: 100%; }
          .playlist-video-row { grid-template-columns: 32px minmax(0, 1fr); }
          .playlist-video-duration { grid-column: 2; }
          .fetch-btn { padding: 9px 16px; }
          .logo-text { font-size: 22px; }
          .downloads-panel { right: 0; bottom: 0; width: 100%; max-height: 400px; border-radius: 16px 16px 0 0; }
          .download-main { grid-template-columns: 20px minmax(0, 1fr) auto; }
          .download-ext { grid-column: 3; }
          .download-progress-row { padding-left: 27px; }
        }
      `}</style>
    </>
  );
}
