import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Stage from './components/Stage.jsx';
import CameraPanel from './components/CameraPanel.jsx';
import Gallery from './components/Gallery.jsx';
import { generateImage, getModels, getStatus, historyImageUrl, saveHistory } from './api.js';
import {
  compositeThroughMask,
  dataUrlSize,
  downloadDataUrl,
  makeGuideImage,
  maskBounds,
  prepareFile,
} from './imageUtils.js';

const PROVIDERS = [
  { id: 'krea', label: 'Krea' },
  { id: 'openrouter', label: 'OpenRouter' },
];
const loadProvider = () => {
  try {
    const p = localStorage.getItem('provider');
    return PROVIDERS.some((x) => x.id === p) ? p : 'krea';
  } catch {
    return 'krea';
  }
};

const DEFAULT_ASPECTS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'];
const DEFAULT_MAX_IMAGES = 8;

const TOOLS = [
  { id: 'rect', label: 'Rectangle select', icon: '▭' },
  { id: 'brush', label: 'Brush select', icon: '✎' },
  { id: 'erase', label: 'Erase selection', icon: '⌫' },
  { id: 'remove', label: 'Delete one selection (click it)', icon: '⊗' },
  { id: 'hand', label: 'Pan (hold Space)', icon: '✥' },
];

let uid = 0;
const nextId = () => ++uid;

export default function App() {
  const stageRef = useRef(null);
  const fileRef = useRef(null);
  const refFileRef = useRef(null);
  const abortRef = useRef(null);

  const [server, setServer] = useState(null);
  const [provider, setProvider] = useState(loadProvider);
  const [history, setHistory] = useState([]);
  const [idx, setIdx] = useState(-1);
  const [refs, setRefs] = useState([]);
  const [prompt, setPrompt] = useState('');
  const [tool, setTool] = useState('rect');
  const [brushSize, setBrushSize] = useState(36);
  const [hasMask, setHasMask] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [jobStatus, setJobStatus] = useState('');
  const [error, setError] = useState('');
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryKey, setGalleryKey] = useState(0);
  const [models, setModels] = useState([]);
  const [model, setModel] = useState('');
  const [s, setS] = useState({
    resolution: '1K',
    aspect: 'auto',
    negative: '',
    seed: '',
    useSelection: true,
    lockOutside: true,
  });
  const set = (patch) => setS((v) => ({ ...v, ...patch }));

  const current = history[idx] || null;
  const original = history[0] || null;
  const usingSelection = Boolean(current && hasMask && s.useSelection);

  // What the selected model supports (from the provider's model list).
  const params = models.find((m) => m.id === model)?.params || {};
  const resolutions = params.resolution?.values || null;
  const aspects = params.aspect_ratio?.values || (model ? [] : DEFAULT_ASPECTS);
  const canSeed = Boolean(params.seed);
  const maxImages = params.input_references?.max ?? DEFAULT_MAX_IMAGES;
  const needsImage = (params.input_references?.min ?? 0) > 0;
  const maxRefs = Math.max(0, maxImages - (current ? 1 : 0) - (usingSelection ? 1 : 0));

  const info = server?.providers?.[provider];
  const configured = server ? Boolean(info?.configured) : true;

  useEffect(() => {
    getStatus()
      .then(setServer)
      .catch(() => setServer({ offline: true }));
  }, []);

  // (Re)load the model list whenever the provider changes.
  useEffect(() => {
    if (!info) return;
    let stale = false;
    setModels([]);
    setModel(info.defaultModel);
    if (info.configured) {
      getModels(provider)
        .then((m) => !stale && setModels(m))
        .catch((e) => !stale && setError(e.message));
    }
    return () => {
      stale = true;
    };
  }, [provider, info?.configured, info?.defaultModel]);

  const switchProvider = (id) => {
    if (id === provider || busy) return;
    setError('');
    setProvider(id);
    try {
      localStorage.setItem('provider', id);
    } catch {}
  };

  const pushVersion = useCallback((entry) => {
    setHistory((h) => [...h.slice(0, idx + 1), entry]);
    setIdx(idx + 1);
  }, [idx]);

  const openFile = async (file) => {
    if (!file?.type.startsWith('image/')) return setError('Please choose an image file.');
    setError('');
    const img = await prepareFile(file);
    setHistory([{ id: nextId(), ...img, label: file.name, prompt: '' }]);
    setIdx(0);
  };

  // Load a saved generation from the gallery as a fresh editing session.
  const openFromGallery = async (item) => {
    try {
      const blob = await (await fetch(historyImageUrl(item.id))).blob();
      const url = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = reject;
        fr.readAsDataURL(blob);
      });
      const size = await dataUrlSize(url);
      setHistory([{ id: nextId(), url, ...size, label: item.label || item.prompt, prompt: item.prompt }]);
      setIdx(0);
      setGalleryOpen(false);
    } catch {
      setError('Could not open that image.');
    }
  };

  const addRefs = async (files) => {
    const room = Math.max(0, maxRefs - refs.length);
    const picked = [...files].filter((f) => f.type.startsWith('image/')).slice(0, room);
    const prepared = await Promise.all(
      picked.map(async (f) => ({ id: nextId(), name: f.name, url: (await prepareFile(f, 1536)).url }))
    );
    setRefs((r) => [...r, ...prepared]);
  };

  // `override` ({ text, label }) runs a plain whole-image edit with that exact prompt
  // (no selection, references or extra instructions) — used by the camera-angle tool.
  const generate = async (override) => {
    const plain = override && typeof override.text === 'string' ? override : null;
    if (busy || (!plain && !prompt.trim())) return;
    setError('');
    setBusy(true);
    setJobStatus('submitting');
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const mask = stageRef.current?.getMask();
      const bounds = !plain && usingSelection ? maskBounds(mask) : null;
      const images = [];
      const usedRefs = plain ? [] : refs.slice(0, maxRefs);
      let text = plain ? plain.text : prompt.trim();

      if (plain) {
        if (!current) throw new Error('Open an image first.');
        images.push(current.url);
      } else if (current) {
        images.push(current.url);
        const lines = ['Image 1 is the photo to edit. Keep its framing, subject and composition exactly as they are.'];
        let next = 2;
        if (bounds) {
          images.push(await makeGuideImage(current.url, mask));
          const pct = (n) => Math.round(n * 100);
          lines.push(
            `Image 2 is the same photo with the target area painted magenta ` +
              `(roughly x ${pct(bounds.x0)}%-${pct(bounds.x1)}%, y ${pct(bounds.y0)}%-${pct(bounds.y1)}% of the frame). ` +
              `Make the change inside that magenta area of image 1 and leave everything outside it untouched. ` +
              `The magenta paint itself must not appear in the result.`
          );
          if (usedRefs.length) {
            lines.push(
              `SIZE: any object taken from the references must be scaled to fit entirely inside the magenta area ` +
                `(about ${pct(bounds.x1 - bounds.x0)}% of the frame width and ${pct(bounds.y1 - bounds.y0)}% of the frame height), ` +
                `keeping its proportions. Do not let it extend past the area. Match the scene's perspective, lighting and scale.`
            );
          }
          next = 3;
        }
        if (usedRefs.length) {
          const range = usedRefs.length > 1 ? `Images ${next}-${next + usedRefs.length - 1} are` : `Image ${next} is`;
          lines.push(`${range} reference material: take the object/style from ${usedRefs.length > 1 ? 'them' : 'it'} as the instruction describes.`);
        }
        text = `${lines.join('\n')}\n\nInstruction: ${text}`;
      }
      images.push(...usedRefs.map((r) => r.url));

      if (!plain && s.negative.trim()) text += `\n\nAvoid: ${s.negative.trim()}`;
      if (needsImage && !images.length) {
        throw new Error(`${model} edits existing images. Open an image first, or pick a text-to-image model.`);
      }

      const payload = { model, prompt: text };
      if (images.length) {
        payload.input_references = images.map((url) => ({ type: 'image_url', image_url: { url } }));
      }
      if (resolutions) payload.resolution = resolutions.includes(s.resolution) ? s.resolution : resolutions[0];
      if (s.aspect !== 'auto' && aspects.includes(s.aspect)) payload.aspect_ratio = s.aspect;
      else if (s.aspect === 'auto' && aspects.includes('auto')) payload.aspect_ratio = 'auto';
      else if (s.aspect === 'auto' && current && aspects.length) {
        // No "auto" for this model: pick the supported ratio closest to the source image so
        // the result lines up with the original (important when pasting back through a selection).
        const target = current.w / current.h;
        const ratio = (a) => a.split(':').reduce((x, y) => x / y);
        payload.aspect_ratio = [...aspects].sort(
          (a, b) => Math.abs(Math.log(ratio(a) / target)) - Math.abs(Math.log(ratio(b) / target))
        )[0];
      }
      if (canSeed && s.seed !== '' && Number.isInteger(Number(s.seed))) payload.seed = Number(s.seed);

      setJobStatus('generating');
      const { image: out0, usage } = await generateImage(payload, { provider, signal: ctrl.signal });
      let out = out0;
      if (bounds && s.lockOutside) out = await compositeThroughMask(current.url, out, mask);
      const size = await dataUrlSize(out);
      const label = plain ? plain.label : prompt.trim().slice(0, 40);
      pushVersion({ id: nextId(), url: out, ...size, label, prompt: plain ? plain.text : prompt.trim() });
      saveHistory({
        image: out,
        prompt: prompt.trim() || plain?.text || '',
        label,
        model,
        cost: typeof usage?.cost === 'number' ? usage.cost : null,
        ...size,
      })
        .then(() => setGalleryKey((k) => k + 1))
        .catch(() => {});
    } catch (err) {
      if (err.name !== 'AbortError') setError(err.message || String(err));
    } finally {
      setBusy(false);
      setJobStatus('');
      abortRef.current = null;
    }
  };

  // Ctrl/Cmd+Z / Shift+Z through selection edits, then versions.
  useEffect(() => {
    const onKey = (e) => {
      if (/INPUT|TEXTAREA/.test(e.target.tagName)) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        // Selection edits undo/redo first; once exhausted, step through image versions.
        const stage = stageRef.current;
        if (e.shiftKey ? stage?.redoMask() : stage?.undoMask()) return;
        setIdx((i) => (e.shiftKey ? Math.min(history.length - 1, i + 1) : Math.max(0, i - 1)));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [history.length]);

  const overrideUrl = comparing && original && idx > 0 ? original.url : null;
  const selectionHint = useMemo(() => {
    if (!current) return 'Describe an image to generate it, or drop an image to edit.';
    if (usingSelection) return 'Editing the selected area only.';
    return 'Edit the whole image — or paint a selection first to target one area.';
  }, [current, usingSelection]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">K</span> Krea Editor
          <div className="seg provider" title="Image API provider">
            {PROVIDERS.map((p) => (
              <button key={p.id} className={provider === p.id ? 'on' : ''} disabled={busy} onClick={() => switchProvider(p.id)}>
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <div className="top-actions">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => e.target.files[0] && openFile(e.target.files[0])}
          />
          <button onClick={() => setGalleryOpen(true)}>History</button>
          <button onClick={() => fileRef.current.click()}>Open image</button>
          <button
            disabled={!current || idx === 0}
            onMouseDown={() => setComparing(true)}
            onMouseUp={() => setComparing(false)}
            onMouseLeave={() => setComparing(false)}
            title="Hold to see the original"
          >
            Hold to compare
          </button>
          <button disabled={!current} onClick={() => stageRef.current?.fit()}>Fit</button>
          <button
            className="primary"
            disabled={!current}
            onClick={() => downloadDataUrl(current.url, `krea-edit-${current.id}.png`)}
          >
            Download
          </button>
        </div>
      </header>

      {server && !configured && (
        <div className="banner">
          {server.offline
            ? 'Cannot reach the local API server. Run `npm run dev`.'
            : `No ${PROVIDERS.find((p) => p.id === provider).label} key found. Put ${info.keyName}=... in the .env file.`}
        </div>
      )}

      <Gallery
        open={galleryOpen}
        onClose={() => setGalleryOpen(false)}
        onOpenImage={openFromGallery}
        refreshKey={galleryKey}
      />

      <main className="workspace">
        <aside className="toolbar">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              className={tool === t.id ? 'tool active' : 'tool'}
              title={t.label}
              onClick={() => setTool(t.id)}
            >
              {t.icon}
            </button>
          ))}
          <div className="tool-sep" />
          <label className="brush-size" title="Brush size">
            <input
              type="range"
              min="8"
              max="120"
              value={brushSize}
              onChange={(e) => setBrushSize(Number(e.target.value))}
            />
          </label>
          <button
            className="tool"
            title="Clear selection"
            disabled={!hasMask}
            onClick={() => stageRef.current?.clearMask()}
          >
            ✕
          </button>
        </aside>

        <section className="center">
          <Stage
            ref={stageRef}
            image={current}
            overrideUrl={overrideUrl}
            tool={tool}
            brushSize={brushSize}
            busy={busy}
            onMaskChange={setHasMask}
            onDropFile={openFile}
          />

          <div className="promptbar">
            <div className="hint">{selectionHint}</div>
            <div className="prompt-row">
              <textarea
                value={prompt}
                placeholder={current ? 'What should change? e.g. "make the jacket red leather"' : 'Describe the image you want…'}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) generate();
                }}
                rows={2}
              />
              {busy ? (
                <button className="danger" onClick={() => abortRef.current?.abort()}>
                  Cancel{jobStatus ? ` · ${jobStatus}` : ''}
                </button>
              ) : (
                <button className="primary big" disabled={!prompt.trim()} onClick={() => generate()}>
                  {current ? 'Edit' : 'Generate'}
                  <small>⌘↵</small>
                </button>
              )}
            </div>
            {error && <div className="error">{error}</div>}
          </div>

          <div className="filmstrip">
            {history.map((h, i) => (
              <button
                key={h.id}
                className={i === idx ? 'thumb active' : 'thumb'}
                title={h.label}
                onClick={() => setIdx(i)}
              >
                <img src={h.url} alt="" />
                <span>{i === 0 ? 'Original' : `v${i}`}</span>
              </button>
            ))}
          </div>
        </section>

        <aside className="panel">
          <h3>Model</h3>
          <select className="text" value={model} onChange={(e) => setModel(e.target.value)}>
            {!models.some((m) => m.id === model) && model && <option value={model}>{model}</option>}
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name || m.id}
                {m.editing ? ' · edit' : ''}
              </option>
            ))}
          </select>

          {resolutions && (
            <>
              <h3>Resolution</h3>
              <div className="seg">
                {resolutions.map((r) => (
                  <button
                    key={r}
                    className={(resolutions.includes(s.resolution) ? s.resolution : resolutions[0]) === r ? 'on' : ''}
                    onClick={() => set({ resolution: r })}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </>
          )}

          {aspects.length > 0 && (
            <>
              <h3>Aspect ratio</h3>
              <div className="chips">
                {['auto', ...aspects.filter((a) => a !== 'auto')].map((a) => (
                  <button key={a} className={s.aspect === a ? 'on' : ''} onClick={() => set({ aspect: a })}>
                    {a === 'auto' ? 'Auto' : a}
                  </button>
                ))}
              </div>
            </>
          )}

          {current && (
            <>
              <h3>Edit mode</h3>
              <label className="check">
                <input
                  type="checkbox"
                  checked={s.useSelection}
                  onChange={(e) => set({ useSelection: e.target.checked })}
                />
                Use my selection
                <small>Sends a highlighted guide image with the request.</small>
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={s.lockOutside}
                  onChange={(e) => set({ lockOutside: e.target.checked })}
                />
                Lock outside selection
                <small>Pastes the result back through your selection so nothing else changes.</small>
              </label>
            </>
          )}

          <h3>
            References <em>{refs.length}/{Math.max(0, maxRefs)}</em>
          </h3>
          <div className="refs">
            {refs.map((r) => (
              <div className="ref" key={r.id} title={r.name}>
                <img src={r.url} alt="" />
                <button onClick={() => setRefs((x) => x.filter((y) => y.id !== r.id))}>×</button>
              </div>
            ))}
            {refs.length < maxRefs && (
              <button className="ref add" onClick={() => refFileRef.current.click()}>
                +
              </button>
            )}
            <input
              ref={refFileRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={(e) => {
                addRefs(e.target.files);
                e.target.value = '';
              }}
            />
          </div>

          <h3>Negative prompt</h3>
          <textarea
            className="small"
            rows={2}
            maxLength={1024}
            value={s.negative}
            placeholder="Things to avoid…"
            onChange={(e) => set({ negative: e.target.value })}
          />

          {canSeed && (
            <>
              <h3>Seed</h3>
              <input
                className="text"
                inputMode="numeric"
                value={s.seed}
                placeholder="random"
                onChange={(e) => set({ seed: e.target.value.replace(/[^0-9]/g, '') })}
              />
            </>
          )}

          <CameraPanel image={current} busy={busy} onGenerate={generate} />
        </aside>
      </main>
    </div>
  );
}
