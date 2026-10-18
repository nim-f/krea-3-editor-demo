import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';

export const LIMITS = {
  rotate: { min: -90, max: 90, step: 1 },
  vertical: { min: -30, max: 60, step: 1 },
  zoom: { min: 0.5, max: 1.5, step: 0.05 },
};

const R0 = 2.2; // ring radius
const rad = THREE.MathUtils.degToRad;
const deg = THREE.MathUtils.radToDeg;
const clamp = (v, { min, max }) => Math.min(max, Math.max(min, v));

/** Turn the three camera values into an edit instruction for the model. */
export function cameraPrompt({ rotate, vertical, zoom }) {
  const parts = [];
  if (Math.abs(rotate) >= 2) {
    parts.push(
      `orbit the camera ${Math.abs(Math.round(rotate))} degrees around the subject to the ${rotate > 0 ? 'right' : 'left'}` +
        ` (so the subject is seen from a ${Math.abs(rotate) > 60 ? 'near side-on' : 'turned'} angle)`
    );
  }
  if (Math.abs(vertical) >= 2) {
    parts.push(
      vertical > 0
        ? `raise the camera ${Math.round(vertical)} degrees so it looks down on the subject (high-angle view)`
        : `lower the camera ${Math.abs(Math.round(vertical))} degrees so it looks up at the subject (low-angle view)`
    );
  }
  if (zoom >= 1.05) parts.push(`move the camera closer / zoom in to ${zoom.toFixed(2)}x with tighter framing`);
  else if (zoom <= 0.95) parts.push(`move the camera back / zoom out to ${zoom.toFixed(2)}x with a wider framing`);
  if (!parts.length) return '';
  return (
    `Change the camera angle of this exact photo: ${parts.join('; ')}. ` +
    `Keep the same subject, identity, clothing, lighting, colours and scene; only the camera viewpoint changes. ` +
    `Naturally fill in plausible content for any newly visible areas, with correct perspective.`
  );
}

function camPos(az, el, r) {
  const a = rad(az);
  const e = rad(el);
  return new THREE.Vector3(r * Math.sin(a) * Math.cos(e), r * Math.sin(e), r * Math.cos(a) * Math.cos(e));
}

function Widget({ imageUrl, aspect, value, onChange }) {
  const hostRef = useRef(null);
  const api = useRef({});
  const latest = useRef({ value, onChange });
  latest.current = { value, onChange };

  // Build the scene once.
  useEffect(() => {
    const host = hostRef.current;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const view = new THREE.PerspectiveCamera(38, 1, 0.1, 50);
    view.position.set(3.6, 3.3, 5.6);
    view.lookAt(0, -0.1, 0);

    // Floor grid.
    const grid = new THREE.GridHelper(8, 16, 0x222226, 0x17171a);
    grid.position.y = -1;
    scene.add(grid);

    // Image plane.
    const planeMat = new THREE.MeshBasicMaterial({ color: 0x444444, side: THREE.DoubleSide });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), planeMat);
    scene.add(plane);

    // Azimuth ring (blue).
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(R0, 0.035, 12, 128),
      new THREE.MeshBasicMaterial({ color: 0x3b6cf0 })
    );
    ring.rotation.x = Math.PI / 2;
    scene.add(ring);

    // Elevation arc (purple) — lives in a vertical plane that follows the azimuth.
    const arcGroup = new THREE.Group();
    const arcSpan = rad(LIMITS.vertical.max - LIMITS.vertical.min + 30);
    const arc = new THREE.Mesh(
      new THREE.TorusGeometry(R0, 0.035, 12, 64, arcSpan),
      new THREE.MeshBasicMaterial({ color: 0x8b4dff })
    );
    arc.rotation.z = rad(LIMITS.vertical.min - 15);
    arcGroup.add(arc);
    scene.add(arcGroup);

    const handleGeo = new THREE.SphereGeometry(0.15, 24, 16);
    const blue = new THREE.Mesh(handleGeo, new THREE.MeshBasicMaterial({ color: 0x4a7bff }));
    const purple = new THREE.Mesh(handleGeo, new THREE.MeshBasicMaterial({ color: 0x9a5cff }));
    scene.add(blue);
    arcGroup.add(purple);

    // Camera marker.
    const cam = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(0.34, 0.24, 0.3),
      new THREE.MeshBasicMaterial({ color: 0x2c3a52 })
    );
    const lens = new THREE.Mesh(
      new THREE.CylinderGeometry(0.1, 0.1, 0.12, 20),
      new THREE.MeshBasicMaterial({ color: 0xf0a030 })
    );
    lens.rotation.x = Math.PI / 2;
    lens.position.z = 0.2;
    cam.add(body, lens);
    scene.add(cam);

    const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    const line = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0xf0a030, transparent: true, opacity: 0.6 }));
    scene.add(line);

    const render = () => renderer.render(scene, view);

    const sync = () => {
      const { rotate, vertical, zoom } = latest.current.value;
      const r = R0 / zoom;
      const p = camPos(rotate, vertical, r);
      cam.position.copy(p);
      cam.lookAt(0, 0, 0);
      lineGeo.setFromPoints([p, new THREE.Vector3()]);
      blue.position.copy(camPos(rotate, 0, R0));
      arcGroup.rotation.y = rad(rotate) - Math.PI / 2;
      purple.position.set(R0 * Math.cos(rad(vertical)), R0 * Math.sin(rad(vertical)), 0);
      render();
    };

    const resize = () => {
      const w = host.clientWidth;
      renderer.setSize(w, w, false);
      renderer.domElement.style.width = '100%';
      renderer.domElement.style.height = '100%';
      render();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();

    // Dragging the two handles.
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let dragging = null;
    const setRay = (e) => {
      const r = renderer.domElement.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, view);
    };
    const onDown = (e) => {
      setRay(e);
      const hit = ray.intersectObjects([blue, purple])[0];
      if (!hit) return;
      dragging = hit.object === blue ? 'rotate' : 'vertical';
      renderer.domElement.setPointerCapture(e.pointerId);
    };
    const onMove = (e) => {
      setRay(e);
      if (!dragging) {
        renderer.domElement.style.cursor = ray.intersectObjects([blue, purple]).length ? 'grab' : 'default';
        return;
      }
      const cur = latest.current.value;
      const pt = new THREE.Vector3();
      if (dragging === 'rotate') {
        if (!ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), pt)) return;
        latest.current.onChange({ ...cur, rotate: Math.round(clamp(deg(Math.atan2(pt.x, pt.z)), LIMITS.rotate)) });
      } else {
        const a = rad(cur.rotate);
        const normal = new THREE.Vector3(Math.cos(a), 0, -Math.sin(a));
        if (!ray.ray.intersectPlane(new THREE.Plane(normal, 0), pt)) return;
        const dir = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
        latest.current.onChange({
          ...cur,
          vertical: Math.round(clamp(deg(Math.atan2(pt.y, pt.dot(dir))), LIMITS.vertical)),
        });
      }
    };
    const onUp = () => (dragging = null);
    const el = renderer.domElement;
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);

    api.current = { sync, plane, planeMat, render };
    sync();

    return () => {
      ro.disconnect();
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      scene.traverse((o) => {
        o.geometry?.dispose();
        o.material?.dispose?.();
      });
      renderer.dispose();
      host.removeChild(el);
    };
  }, []);

  // Re-pose on value changes.
  useEffect(() => api.current.sync?.(), [value.rotate, value.vertical, value.zoom]);

  // Texture + plane proportions follow the current image.
  useEffect(() => {
    const { plane, planeMat, render } = api.current;
    if (!plane) return;
    const h = 1.5;
    const w = h * (aspect || 1);
    const fit = Math.min(1, 2.4 / w);
    plane.scale.set(w * fit, h * fit, 1);
    if (!imageUrl) {
      planeMat.map = null;
      planeMat.color.set(0x444444);
      planeMat.needsUpdate = true;
      render();
      return;
    }
    let dead = false;
    new THREE.TextureLoader().load(imageUrl, (tex) => {
      if (dead) return;
      tex.colorSpace = THREE.SRGBColorSpace;
      planeMat.map?.dispose();
      planeMat.map = tex;
      planeMat.color.set(0xffffff);
      planeMat.needsUpdate = true;
      render();
    });
    return () => {
      dead = true;
    };
  }, [imageUrl, aspect]);

  return <div className="cam-widget" ref={hostRef} />;
}

function Slider({ label, color, unit, fmt, field, value, onChange }) {
  const lim = LIMITS[field];
  return (
    <div className="cam-slider">
      <div className="cam-slider-head">
        <span className="pill" style={{ background: color }} />
        <span>{label}</span>
        <code>{fmt(value[field])}{unit}</code>
      </div>
      <input
        type="range"
        min={lim.min}
        max={lim.max}
        step={lim.step}
        value={value[field]}
        onChange={(e) => onChange({ ...value, [field]: Number(e.target.value) })}
        onDoubleClick={() => onChange({ ...value, [field]: field === 'zoom' ? 1 : 0 })}
      />
    </div>
  );
}

export default function CameraPanel({ image, busy, onGenerate }) {
  const [open, setOpen] = useState(true);
  const [value, setValue] = useState({ rotate: 0, vertical: 0, zoom: 1 });
  const text = cameraPrompt(value);

  return (
    <div className="cam-panel">
      <button className="cam-head" onClick={() => setOpen((o) => !o)}>
        <span className="cam-icon">⟳</span>
        <span>Change Camera Angle</span>
        <span className="chev">{open ? '⌃' : '⌄'}</span>
      </button>
      {open && (
        <>
          <Widget imageUrl={image?.url} aspect={image ? image.w / image.h : 1} value={value} onChange={setValue} />
          <Slider label="Rotate" color="#4a7bff" unit="°" fmt={(v) => v} field="rotate" value={value} onChange={setValue} />
          <Slider label="Vertical" color="#9a5cff" unit="°" fmt={(v) => v} field="vertical" value={value} onChange={setValue} />
          <Slider label="Zoom" color="#ff8a1f" unit="" fmt={(v) => v.toFixed(1)} field="zoom" value={value} onChange={setValue} />
          <div className="cam-actions">
            <button className="ghost" onClick={() => setValue({ rotate: 0, vertical: 0, zoom: 1 })}>
              Reset
            </button>
            <button
              className="cam-generate"
              disabled={!image || busy || !text}
              onClick={() =>
                onGenerate({
                  text,
                  label: `Camera ${value.rotate}° / ${value.vertical}° / ${value.zoom.toFixed(1)}x`,
                })
              }
            >
              ✦ Generate
            </button>
          </div>
          {!image && <div className="cam-note">Open an image to use this.</div>}
        </>
      )}
    </div>
  );
}
