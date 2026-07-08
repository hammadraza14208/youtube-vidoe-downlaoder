const DEFAULT_BACKEND_URL = 'http://localhost:5001';

export function buildBackendUrl(path, query = {}) {
  const baseUrl = process.env.YTDROP_BACKEND_URL || DEFAULT_BACKEND_URL;
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const url = new URL(path.replace(/^\//, ''), normalizedBase);

  Object.entries(query).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    url.searchParams.set(key, Array.isArray(value) ? value[0] : value);
  });

  return url;
}

export async function readBackendError(response) {
  const contentType = response.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    try {
      const data = await response.json();
      return data.error || JSON.stringify(data);
    } catch {
      return `Backend returned ${response.status}`;
    }
  }

  try {
    const text = await response.text();
    return text || `Backend returned ${response.status}`;
  } catch {
    return `Backend returned ${response.status}`;
  }
}
