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
    const pyUrl = buildBackendUrl('/info', { url });
    const pyRes = await fetch(pyUrl, { signal: AbortSignal.timeout(28000) });

    if (!pyRes.ok) {
      const message = await readBackendError(pyRes);
      return res.status(pyRes.status).json({ error: message });
    }

    const data = await pyRes.json();
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json(data);
  } catch (err) {
    console.error('[api/info] error:', err);
    return res.status(503).json({
      error: 'Info server is unavailable. Start server.py, then try again.',
    });
  }
}
