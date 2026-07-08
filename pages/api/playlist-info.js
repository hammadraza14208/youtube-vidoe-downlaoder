import { buildBackendUrl, readBackendError } from '../../lib/ytdropBackend';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { url } = req.query;
  if (!url) {
    return res.status(400).json({ error: 'Missing url parameter' });
  }

  try {
    const backendUrl = buildBackendUrl('/playlist-info', { url });
    const backendRes = await fetch(backendUrl, { signal: AbortSignal.timeout(50000) });

    if (!backendRes.ok) {
      const message = await readBackendError(backendRes);
      return res.status(backendRes.status).json({ error: message });
    }

    const data = await backendRes.json();
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(data);
  } catch (err) {
    console.error('[api/playlist-info] error:', err);
    return res.status(503).json({
      error: 'Playlist info server is unavailable. Start server.py, then try again.',
    });
  }
}
