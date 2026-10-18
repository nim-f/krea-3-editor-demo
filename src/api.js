async function readJson(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

function errorMessage(body, fallback) {
  if (!body) return fallback;
  const msg = body.error?.message || body.error || body.message || body.detail || body.raw;
  return typeof msg === 'string' ? msg : JSON.stringify(msg || body);
}

export async function getStatus() {
  return readJson(await fetch('/api/status'));
}

export async function getModels(provider) {
  const res = await fetch(`/api/models?provider=${encodeURIComponent(provider)}`);
  const body = await readJson(res);
  if (!res.ok) throw new Error(errorMessage(body, 'Could not load models.'));
  return body;
}

/** Generate / edit an image. Returns { image (data URL or URL), usage }. */
export async function generateImage(payload, { provider, signal } = {}) {
  const res = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, provider }),
    signal,
  });
  const body = await readJson(res);
  if (!res.ok) throw new Error(errorMessage(body, `Request failed (${res.status})`));
  return body;
}

export async function listHistory() {
  return readJson(await fetch('/api/history'));
}

export async function saveHistory(entry) {
  const res = await fetch('/api/history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(entry),
  });
  return readJson(res);
}

export async function deleteHistory(id) {
  await fetch(`/api/history/${id}`, { method: 'DELETE' });
}

export const historyImageUrl = (id) => `/api/history/${id}/image`;
