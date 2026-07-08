import { Readable } from 'node:stream';
import { buildBackendUrl, readBackendError } from '../../lib/ytdropBackend';

export const config = {
  api: {
    responseLimit: false,
  },
};

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { url, itag } = req.query;
  if (!url || !itag) {
    return res.status(400).json({ error: 'Missing url or itag' });
  }

  try {
    const backendUrl = buildBackendUrl('/download', req.query);
    const backendRes = await fetch(backendUrl);

    if (!backendRes.ok) {
      const message = await readBackendError(backendRes);
      return res.status(backendRes.status).json({ error: message });
    }

    res.statusCode = backendRes.status;
    res.setHeader('Cache-Control', 'no-store');

    const passthroughHeaders = [
      'content-type',
      'content-length',
      'content-disposition',
    ];

    passthroughHeaders.forEach((header) => {
      const value = backendRes.headers.get(header);
      if (value) res.setHeader(header, value);
    });

    if (!backendRes.body) {
      return res.end();
    }

    return Readable.fromWeb(backendRes.body).pipe(res);
  } catch (err) {
    console.error('[api/download] error:', err);
    return res.status(503).json({
      error: 'Download server is unavailable. Start server.py, then try again.',
    });
  }
}
