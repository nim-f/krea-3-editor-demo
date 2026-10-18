import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { maskBounds } from '../imageUtils.js';

const MASK_COLOR = '#8b5cff';
const MAX_MASK_HISTORY = 15;
const MAX_REGION_BUTTONS = 24;

/**
 * Canvas stage: shows the current image, lets the user paint a selection mask
 * (rectangle / brush / eraser) and pan / zoom the view.
 */
const Stage = forwardRef(function Stage(
  { image, overrideUrl, tool, brushSize, busy, onMaskChange, onDropFile },
  ref
) {
  const wrapRef = useRef(null);
  const maskRef = useRef(null);
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [dragRect, setDragRect] = useState(null);
  const [cursor, setCursor] = useState(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const drag = useRef(null);
  // Connected painted areas (image coords) — each gets a delete button.
  const [regions, setRegions] = useState([]);
  // Selection history: ImageData snapshots of the mask canvas taken before each change.
  const undoStack = useRef([]);
  const redoStack = useRef([]);

  const fit = useCallback(() => {
    if (!image || !size.w) return;
    const s = Math.min(size.w / image.w, size.h / image.h) * 0.92;
    setView({ scale: s, x: (size.w - image.w * s) / 2, y: (size.h - image.h * s) / 2 });
  }, [image, size]);

  const snapshot = () => {
    const c = maskRef.current;
    return c.getContext('2d').getImageData(0, 0, c.width, c.height);
  };
  const pushUndo = () => {
    undoStack.current.push(snapshot());
    if (undoStack.current.length > MAX_MASK_HISTORY) undoStack.current.shift();
    redoStack.current = [];
  };
  // Swap the mask with the top of `from`, keeping the replaced state on `to`. False if `from` is empty.
  const stepMask = (from, to) => {
    const prev = from.current.pop();
    if (!prev) return false;
    to.current.push(snapshot());
    maskRef.current.getContext('2d').putImageData(prev, 0, 0);
    refreshHasMask();
    return true;
  };

  useImperativeHandle(ref, () => ({
    getMask: () => maskRef.current,
    undoMask: () => stepMask(undoStack, redoStack),
    redoMask: () => stepMask(redoStack, undoStack),
    clearMask() {
      const c = maskRef.current;
      if (c) pushUndo();
      if (c) c.getContext('2d').clearRect(0, 0, c.width, c.height);
      onMaskChange(false);
      setRegions([]);
    },
    fit,
  }));

  // Track container size.
  useEffect(() => {
    const el = wrapRef.current;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Fit when a new image arrives (or the first size is known). Mask resets with the image.
  useEffect(() => {
    fit();
    const c = maskRef.current;
    if (c) c.getContext('2d').clearRect(0, 0, c.width, c.height);
    undoStack.current = [];
    redoStack.current = [];
    onMaskChange(false);
    setRegions([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [image?.url, size.w > 0]);

  // Wheel zoom around cursor (needs a non-passive listener).
  useEffect(() => {
    const el = wrapRef.current;
    const onWheel = (e) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      setView((v) => {
        const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
        const scale = Math.min(16, Math.max(0.05, v.scale * factor));
        const k = scale / v.scale;
        return { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Space = temporary hand tool.
  useEffect(() => {
    const typing = (e) => /INPUT|TEXTAREA|SELECT/.test(e.target.tagName);
    const down = (e) => {
      if (e.code === 'Space' && !typing(e)) {
        e.preventDefault();
        setSpaceDown(true);
      }
    };
    const up = (e) => e.code === 'Space' && setSpaceDown(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  const toImage = (e) => {
    const rect = wrapRef.current.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left - view.x) / view.scale,
      y: (e.clientY - rect.top - view.y) / view.scale,
    };
  };

  const strokeTo = (from, to, erase) => {
    const ctx = maskRef.current.getContext('2d');
    ctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
    ctx.strokeStyle = MASK_COLOR;
    ctx.fillStyle = MASK_COLOR;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = brushSize / view.scale;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  };

  // Delete the connected painted area under `p` (flood fill over non-transparent mask pixels).
  const removeRegionAt = (p) => {
    const c = maskRef.current;
    const x0 = Math.floor(p.x);
    const y0 = Math.floor(p.y);
    if (x0 < 0 || y0 < 0 || x0 >= c.width || y0 >= c.height) return;
    const ctx = c.getContext('2d');
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const { data, width, height } = img;
    if (!data[(y0 * width + x0) * 4 + 3]) return;
    pushUndo();
    const stack = [y0 * width + x0];
    while (stack.length) {
      const i = stack.pop();
      if (!data[i * 4 + 3]) continue;
      data[i * 4 + 3] = 0;
      const x = i % width;
      if (x > 0) stack.push(i - 1);
      if (x < width - 1) stack.push(i + 1);
      if (i >= width) stack.push(i - width);
      if (i < width * (height - 1)) stack.push(i + width);
    }
    ctx.putImageData(img, 0, 0);
    refreshHasMask();
  };

  // Label connected painted areas and record each one's bounding box plus a painted seed pixel.
  const findRegions = () => {
    const c = maskRef.current;
    const { data, width, height } = c.getContext('2d').getImageData(0, 0, c.width, c.height);
    const seen = new Uint8Array(width * height);
    const found = [];
    for (let start = 0; start < seen.length; start++) {
      if (seen[start] || !data[start * 4 + 3]) continue;
      let x0 = width, y0 = height, x1 = 0, y1 = 0;
      const stack = [start];
      seen[start] = 1;
      while (stack.length) {
        const i = stack.pop();
        const x = i % width;
        const y = (i - x) / width;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        const visit = (j) => {
          if (!seen[j] && data[j * 4 + 3]) {
            seen[j] = 1;
            stack.push(j);
          }
        };
        if (x > 0) visit(i - 1);
        if (x < width - 1) visit(i + 1);
        if (y > 0) visit(i - width);
        if (y < height - 1) visit(i + width);
      }
      if (x1 - x0 >= 4 && y1 - y0 >= 4) {
        found.push({ x0, y0, x1, y1, seed: { x: start % width, y: Math.floor(start / width) } });
      }
    }
    return found.slice(0, MAX_REGION_BUTTONS);
  };

  const refreshHasMask = () => {
    onMaskChange(Boolean(maskBounds(maskRef.current)));
    setRegions(findRegions());
  };

  const onPointerDown = (e) => {
    if (!image || busy) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const pan = tool === 'hand' || spaceDown || e.button === 1;
    if (pan) {
      drag.current = { type: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
      return;
    }
    const p = toImage(e);
    if (tool === 'remove') {
      removeRegionAt(p);
    } else if (tool === 'rect') {
      drag.current = { type: 'rect', start: p };
      setDragRect({ x: p.x, y: p.y, w: 0, h: 0 });
    } else if (tool === 'brush' || tool === 'erase') {
      drag.current = { type: tool, last: p };
      pushUndo();
      strokeTo(p, p, tool === 'erase');
    }
  };

  const onPointerMove = (e) => {
    const rect = wrapRef.current.getBoundingClientRect();
    setCursor({ x: e.clientX - rect.left, y: e.clientY - rect.top });
    const d = drag.current;
    if (!d) return;
    if (d.type === 'pan') {
      setView((v) => ({ ...v, x: d.vx + e.clientX - d.sx, y: d.vy + e.clientY - d.sy }));
    } else if (d.type === 'rect') {
      const p = toImage(e);
      setDragRect({
        x: Math.min(d.start.x, p.x),
        y: Math.min(d.start.y, p.y),
        w: Math.abs(p.x - d.start.x),
        h: Math.abs(p.y - d.start.y),
      });
    } else {
      const p = toImage(e);
      strokeTo(d.last, p, d.type === 'erase');
      d.last = p;
    }
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.type === 'rect' && dragRect && dragRect.w > 2 && dragRect.h > 2) {
      pushUndo();
      const ctx = maskRef.current.getContext('2d');
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = MASK_COLOR;
      ctx.fillRect(dragRect.x, dragRect.y, dragRect.w, dragRect.h);
    }
    setDragRect(null);
    if (d.type !== 'pan') refreshHasMask();
  };

  const handTool = tool === 'hand' || spaceDown;
  const paintTool = tool === 'brush' || tool === 'erase';
  const cursorStyle = !image ? 'default' : handTool ? 'grab' : paintTool ? 'none' : tool === 'remove' ? 'pointer' : 'crosshair';

  return (
    <div
      ref={wrapRef}
      className="stage"
      style={{ cursor: cursorStyle }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => setCursor(null)}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const f = e.dataTransfer.files?.[0];
        if (f) onDropFile(f);
      }}
    >
      {image && (
        <div
          className="stage-layer"
          style={{
            width: image.w,
            height: image.h,
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
          }}
        >
          <img src={overrideUrl || image.url} width={image.w} height={image.h} draggable={false} alt="" />
          <canvas
            ref={maskRef}
            width={image.w}
            height={image.h}
            className="mask"
            style={{ opacity: overrideUrl ? 0 : 0.5 }}
          />
          {dragRect && (
            <div
              className="rect-preview"
              style={{
                left: dragRect.x,
                top: dragRect.y,
                width: dragRect.w,
                height: dragRect.h,
                borderWidth: 1.5 / view.scale,
              }}
            />
          )}
          {busy && <div className="shimmer" />}
        </div>
      )}
      {image &&
        !busy &&
        !overrideUrl &&
        regions.map((r) => (
          <button
            key={`${r.seed.x},${r.seed.y}`}
            className="region-delete"
            title="Delete this selection"
            style={{ left: view.x + r.x1 * view.scale, top: view.y + r.y0 * view.scale }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => removeRegionAt(r.seed)}
          >
            ×
          </button>
        ))}
      {image && paintTool && !spaceDown && cursor && (
        <div
          className="brush-ring"
          style={{ left: cursor.x, top: cursor.y, width: brushSize, height: brushSize }}
        />
      )}
      {!image && (
        <div className="empty">
          <div className="empty-title">Drop an image to edit</div>
          <div className="empty-sub">or describe an image below to generate one with the selected model</div>
        </div>
      )}
    </div>
  );
});

export default Stage;
