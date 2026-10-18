import dotenv from 'dotenv';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const OR_BASE = (process.env.OPENROUTER_API_BASE || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
const OR_MODEL = process.env.OPENROUTER_MODEL || 'krea/k3-edit';
const KREA_BASE = (process.env.KREA_API_BASE || 'https://api.krea.ai').replace(/\/$/, '');
const KREA_MODEL = (process.env.KREA_MODEL_PATH || '/generate/image/krea/krea-3').replace(/^\/generate\/image\//, '');
const KREA_POLL_MS = 2000;
const KREA_TIMEOUT_MS = 5 * 60 * 1000;
const KREA_PENDING = new Set(['scheduled', 'processing', 'queued', 'backlogged', 'sampling', 'intermediate-complete']);

const app = express();
app.use(express.json({ limit: '80mb' }));

const envPath = path.join(__dirname, '..', '.env');
// Re-read .env on every call so key changes apply without restarting.
const envValue = (...names) => {
  let file = {};
  try {
    file = dotenv.parse(fs.readFileSync(envPath));
  } catch {}
  for (const n of names) {
    const v = (file[n] || process.env[n] || '').trim();
    if (v) return v;
  }
  return '';
};
const KEY_NAMES = { openrouter: ['OPENROUTER_API_KEY'], krea: ['KREA_API_TOKEN', 'KREA_API_KEY'] };
const KEY_HINT = { openrouter: 'OPENROUTER_API_KEY', krea: 'KREA_API_TOKEN' };
const apiKey = (provider) => envValue(...KEY_NAMES[provider]);

const parseBody = async (res) => {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
};

async function orFetch(pathname, init = {}) {
  const res = await fetch(OR_BASE + pathname, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey('openrouter')}`,
      'Content-Type': 'application/json',
      'X-Title': 'Krea Editor',
      ...(init.headers || {}),
    },
  });
  return { status: res.status, body: await parseBody(res) };
}

async function kreaFetch(pathname, init = {}) {
  const res = await fetch(KREA_BASE + pathname, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey('krea')}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  return { status: res.status, body: await parseBody(res) };
}

// Krea reports validation problems as { error, details: [{ field, message }] }.
function kreaError(body, fallback) {
  const base = typeof body?.error === 'string' ? body.error : body?.message || fallback;
  const details = Array.isArray(body?.details)
    ? body.details.map((d) => (d.field ? `${d.field}: ${d.message}` : d.message)).join('; ')
    : '';
  return details ? `${base} (${details})` : base;
}

const KREA_MODELS = [
  {
    id: KREA_MODEL,
    name: KREA_MODEL === 'krea/krea-3' ? 'Krea 3' : KREA_MODEL,
    editing: true,
    params: {
      resolution: { values: ['1K', '2K'] },
      aspect_ratio: { values: ['1:1', '4:5', '3:4', '2:3', '9:16', '5:4', '4:3', '3:2', '16:9', '21:9'] },
      seed: true,
      input_references: { max: 8 },
    },
  },
];

function providerOf(req) {
  const p = req.body?.provider ?? req.query.provider ?? 'openrouter';
  return p in KEY_NAMES ? p : null;
}

function requireKey(req, res, next) {
  const provider = providerOf(req);
  if (!provider) return res.status(400).json({ error: 'Unknown provider.' });
  if (!apiKey(provider)) {
    return res.status(401).json({ error: `${KEY_HINT[provider]} is not set. Add it to .env.` });
  }
  req.provider = provider;
  next();
}

app.get('/api/status', (_req, res) => {
  res.json({
    providers: {
      openrouter: { configured: Boolean(apiKey('openrouter')), defaultModel: OR_MODEL, keyName: KEY_HINT.openrouter },
      krea: { configured: Boolean(apiKey('krea')), defaultModel: KREA_MODEL, keyName: KEY_HINT.krea },
    },
  });
});

// Image models that can output images (OpenRouter's list cached for 10 min).
let modelCache = { at: 0, data: null };
app.get('/api/models', requireKey, async (req, res) => {
  try {
    if (req.provider === 'krea') return res.json(KREA_MODELS);
    if (!modelCache.data || Date.now() - modelCache.at > 10 * 60 * 1000) {
      const { status, body } = await orFetch('/images/models');
      if (status !== 200) return res.status(status).json(body);
      modelCache = {
        at: Date.now(),
        data: (body.data || [])
          .filter((m) => m.architecture?.output_modalities?.includes('image'))
          .map((m) => ({
            id: m.id,
            name: m.name,
            editing: m.architecture?.input_modalities?.includes('image') ?? false,
            params: m.supported_parameters || {},
          })),
      };
    }
    res.json(modelCache.data);
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

// Both providers resolve to { image (data URL or URL), usage }.
async function generateOpenRouter(payload) {
  const { status, body } = await orFetch('/images', { method: 'POST', body: JSON.stringify(payload) });
  if (status !== 200) return { status, body };
  const item = body.data?.[0];
  if (!item?.b64_json && !item?.url) return { status: 502, body: { error: 'No image in response', raw: body } };
  return {
    status: 200,
    body: {
      image: item.b64_json ? `data:${item.media_type || 'image/png'};base64,${item.b64_json}` : item.url,
      usage: body.usage,
    },
  };
}

// Krea is async: create a job, poll it, then download the result (the client needs a data URL
// to composite and save it). `cancelled()` is true once the browser gave up on the request.
async function generateKrea(payload, cancelled) {
  const { model, prompt, input_references, resolution, aspect_ratio, seed } = payload;
  if (!/^[\w.-]+\/[\w.-]+$/.test(model || '')) return { status: 400, body: { error: `Invalid Krea model "${model}".` } };
  const input = { prompt };
  if (input_references?.length) input.image_urls = input_references.map((r) => r.image_url?.url).filter(Boolean);
  if (resolution) input.resolution = resolution;
  if (aspect_ratio) input.aspect_ratio = aspect_ratio;
  if (Number.isInteger(seed)) input.seed = seed;

  const created = await kreaFetch(`/generate/image/${model}`, { method: 'POST', body: JSON.stringify(input) });
  if (created.status >= 300 || !created.body.job_id) {
    return { status: created.status >= 300 ? created.status : 502, body: { error: kreaError(created.body, 'Could not start Krea job.') } };
  }
  const jobId = created.body.job_id;

  const deadline = Date.now() + KREA_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (cancelled()) {
      kreaFetch(`/jobs/${jobId}`, { method: 'DELETE' }).catch(() => {});
      return null;
    }
    await new Promise((r) => setTimeout(r, KREA_POLL_MS));
    const { status, body: job } = await kreaFetch(`/jobs/${jobId}`);
    if (status >= 300) return { status, body: { error: kreaError(job, 'Could not check Krea job.') } };
    if (job.status === 'completed') {
      const url = job.result?.urls?.[0];
      if (!url) return { status: 502, body: { error: 'Krea job finished without an image.' } };
      const img = await fetch(url);
      if (!img.ok) return { status: 502, body: { error: `Could not download result (${img.status}).` } };
      const type = (img.headers.get('content-type') || 'image/png').split(';')[0];
      const b64 = Buffer.from(await img.arrayBuffer()).toString('base64');
      return { status: 200, body: { image: `data:${type};base64,${b64}`, usage: typeof job.cost === 'number' ? { cost: job.cost } : undefined } };
    }
    if (!KREA_PENDING.has(job.status)) {
      const why = job.result?.error;
      return { status: 502, body: { error: `Krea job ${job.status}${why ? `: ${typeof why === 'string' ? why : JSON.stringify(why)}` : ''}` } };
    }
  }
  kreaFetch(`/jobs/${jobId}`, { method: 'DELETE' }).catch(() => {});
  return { status: 504, body: { error: 'Krea job timed out.' } };
}

// Generate or edit an image with the chosen provider.
app.post('/api/generate', requireKey, async (req, res) => {
  let gone = false;
  res.on('close', () => {
    if (!res.writableEnded) gone = true;
  });
  try {
    const { provider: _p, ...payload } = req.body;
    const out =
      req.provider === 'krea' ? await generateKrea(payload, () => gone) : await generateOpenRouter(payload);
    if (!out) return;
    res.status(out.status).json(out.body);
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

// ---- Saved generations (data/history.json + data/images/*.png) ----
const DATA_DIR = path.join(__dirname, '..', 'data');
const IMG_DIR = path.join(DATA_DIR, 'images');
const INDEX = path.join(DATA_DIR, 'history.json');
fs.mkdirSync(IMG_DIR, { recursive: true });

const readIndex = () => {
  try {
    return JSON.parse(fs.readFileSync(INDEX, 'utf8'));
  } catch {
    return [];
  }
};
const writeIndex = (items) => {
  fs.writeFileSync(INDEX + '.tmp', JSON.stringify(items, null, 2));
  fs.renameSync(INDEX + '.tmp', INDEX);
};
const validId = (id) => /^[a-z0-9]{6,32}$/.test(id);

app.get('/api/history', (_req, res) => res.json(readIndex()));

app.post('/api/history', (req, res) => {
  const { image, prompt = '', model = '', label = '', cost = null, w = 0, h = 0 } = req.body || {};
  const m = /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(image || '');
  if (!m) return res.status(400).json({ error: 'image must be a base64 data URL' });
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  fs.writeFileSync(path.join(IMG_DIR, `${id}.${ext}`), Buffer.from(m[2], 'base64'));
  const entry = { id, ext, prompt, model, label, cost, w, h, createdAt: new Date().toISOString() };
  writeIndex([entry, ...readIndex()]);
  res.json(entry);
});

app.get('/api/history/:id/image', (req, res) => {
  const entry = validId(req.params.id) && readIndex().find((e) => e.id === req.params.id);
  if (!entry) return res.status(404).end();
  res.sendFile(path.join(IMG_DIR, `${entry.id}.${entry.ext}`));
});

app.delete('/api/history/:id', (req, res) => {
  const items = readIndex();
  const entry = validId(req.params.id) && items.find((e) => e.id === req.params.id);
  if (!entry) return res.status(404).end();
  fs.rmSync(path.join(IMG_DIR, `${entry.id}.${entry.ext}`), { force: true });
  writeIndex(items.filter((e) => e.id !== entry.id));
  res.json({ ok: true });
});

// Serve the built frontend when available (npm start).
const dist = path.join(__dirname, '..', 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[krea-editor] api on http://localhost:${PORT} (openrouter key ${apiKey('openrouter') ? 'set' : 'MISSING'}, krea key ${apiKey('krea') ? 'set' : 'MISSING'})`);
});
