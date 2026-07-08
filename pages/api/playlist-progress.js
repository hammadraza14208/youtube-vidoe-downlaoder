import { buildBackendUrl, readBackendError } from '../../lib/ytdropBackend';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { id } = req.query;
  if (!id) {
    return res.status(400).json({ error: 'Missing id parameter' });
  }

  try {
    const backendUrl = buildBackendUrl('/playlist-progress', { id });
    const backendRes = await fetch(backendUrl, { signal: AbortSignal.timeout(10000) });

    if (!backendRes.ok) {
      const message = await readBackendError(backendRes);
      return res.status(backendRes.status).json({ error: message });
    }

    const data = await backendRes.json();
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(data);
  } catch (err) {
    console.error('[api/playlist-progress] error:', err);
    return res.status(503).json({
      error: 'Playlist progress server is unavailable. Start server.py, then try again.',
    });
  }
}
