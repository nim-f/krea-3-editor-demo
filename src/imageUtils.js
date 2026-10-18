export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load image.'));
    img.src = src;
  });
}

function readFile(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(file);
  });
}

/** Read a file, downscale so the long side is <= maxSide, return { url, w, h }. */
export async function prepareFile(file, maxSide = 2048) {
  const img = await loadImage(await readFile(file));
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  const keepAlpha = /png|webp|gif/.test(file.type);
  return { url: c.toDataURL(keepAlpha ? 'image/png' : 'image/jpeg', 0.94), w, h };
}

export async function dataUrlSize(url) {
  const img = await loadImage(url);
  return { w: img.naturalWidth, h: img.naturalHeight };
}

/** Returns the bounding box (in 0..1 fractions) of non-transparent pixels, or null if empty. */
export function maskBounds(mask) {
  const { width: w, height: h } = mask;
  const data = mask.getContext('2d').getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  return { x0: x0 / w, y0: y0 / h, x1: (x1 + 1) / w, y1: (y1 + 1) / h };
}

/** The source image with the mask painted over it in magenta, as a data URL (guide for the model). */
export async function makeGuideImage(srcUrl, mask) {
  const img = await loadImage(srcUrl);
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const tint = document.createElement('canvas');
  tint.width = c.width;
  tint.height = c.height;
  const tctx = tint.getContext('2d');
  tctx.drawImage(mask, 0, 0, c.width, c.height);
  tctx.globalCompositeOperation = 'source-in';
  tctx.fillStyle = '#ff00ff';
  tctx.fillRect(0, 0, c.width, c.height);
  ctx.globalAlpha = 0.65;
  ctx.drawImage(tint, 0, 0);
  return c.toDataURL('image/jpeg', 0.92);
}

/** Paste `resultUrl` over `srcUrl` only where the mask is painted (feathered). */
export async function compositeThroughMask(srcUrl, resultUrl, mask) {
  const [src, res] = await Promise.all([loadImage(srcUrl), loadImage(resultUrl)]);
  const w = src.naturalWidth;
  const h = src.naturalHeight;

  const layer = document.createElement('canvas');
  layer.width = w;
  layer.height = h;
  const lctx = layer.getContext('2d');
  lctx.drawImage(res, 0, 0, w, h);

  const soft = document.createElement('canvas');
  soft.width = w;
  soft.height = h;
  const sctx = soft.getContext('2d');
  sctx.filter = `blur(${Math.max(1, Math.round(Math.max(w, h) * 0.003))}px)`;
  sctx.drawImage(mask, 0, 0, w, h);

  lctx.globalCompositeOperation = 'destination-in';
  lctx.drawImage(soft, 0, 0);

  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const octx = out.getContext('2d');
  octx.drawImage(src, 0, 0);
  octx.drawImage(layer, 0, 0);
  return out.toDataURL('image/png');
}

export function downloadDataUrl(url, name) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
}
