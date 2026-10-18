import { useEffect, useState } from 'react';
import { deleteHistory, historyImageUrl, listHistory } from '../api.js';

export default function Gallery({ open, onClose, onOpenImage, refreshKey }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    listHistory()
      .then((d) => setItems(Array.isArray(d) ? d : []))
      .finally(() => setLoading(false));
  }, [open, refreshKey]);

  if (!open) return null;

  const remove = async (id) => {
    if (!window.confirm('Delete this image from history? This removes the file too.')) return;
    await deleteHistory(id);
    setItems((x) => x.filter((i) => i.id !== id));
  };

  return (
    <div className="gallery-backdrop" onClick={onClose}>
      <div className="gallery" onClick={(e) => e.stopPropagation()}>
        <div className="gallery-head">
          <strong>History</strong>
          <span className="muted">{items.length} saved · files in the project's data/images folder</span>
          <button onClick={onClose}>Close</button>
        </div>
        {loading && !items.length && <div className="muted pad">Loading…</div>}
        {!loading && !items.length && <div className="muted pad">Nothing yet — generated images will appear here.</div>}
        <div className="gallery-grid">
          {items.map((it) => (
            <div className="card" key={it.id}>
              <button className="card-img" onClick={() => onOpenImage(it)} title="Open in editor">
                <img src={historyImageUrl(it.id)} loading="lazy" alt="" />
              </button>
              <div className="card-meta">
                <div className="card-prompt" title={it.prompt}>{it.label || it.prompt || 'Untitled'}</div>
                <div className="muted small">
                  {new Date(it.createdAt).toLocaleString()} · {it.model}
                  {typeof it.cost === 'number' ? ` · $${it.cost.toFixed(3)}` : ''}
                </div>
                <div className="card-actions">
                  <button onClick={() => onOpenImage(it)}>Open</button>
                  <a href={historyImageUrl(it.id)} download={`krea-${it.id}.${it.ext}`}>Download</a>
                  <button className="del" onClick={() => remove(it.id)}>Delete</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
