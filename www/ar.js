// ── AR view ───────────────────────────────────────────────────────────────────
// "View in AR" hands the current model to whatever AR runtime the platform has:
//
//   Android app (Capacitor)  → native ArViewer plugin (ARCore + SceneView), fed a GLB
//   iPhone / iPad Safari     → AR Quick Look, fed a USDZ built here in the browser
//   everything else          → no AR; the button stays hidden
//
// Desktop browsers and Android Chrome fall into the last case, so for them
// nothing about the viewer changes. (An Export Package opened in iPhone Safari
// does get Quick Look.)
//
// Both runtimes expect what glTF/USD expect: Y-up, metres, the model resting on
// the floor at the origin. The viewer works Z-up in the file's own units, so the
// model is copied under a wrapper that rotates, scales and re-centres it; the live
// scene is never touched, so nothing flickers while the export runs.
import * as THREE from 'three';
import { S } from './state.js';
import { t } from './i18n.js';
import { showLoading, hideLoading, showToast } from './helpers.js';
import { computeVisibleBoundingBox } from './lighting.js';

const HELPER_NAMES = new Set(['rhino-edges', 'rhino-outline', 'selection-outline', 'ground-plane']);

// S.modelUnit holds whichever label the loader produced: the short names the
// .3dm path maps to, or the longer ones STEP/IGES/STL set directly.
const METRES_PER_UNIT = {
  'Microns': 1e-6,
  'mm': 0.001, 'Millimeters': 0.001, 'Millimeters / Unitless': 0.001,
  'cm': 0.01, 'dm': 0.1, 'm': 1, 'km': 1000,
  'in': 0.0254, 'ft': 0.3048, 'yd': 0.9144, 'mi': 1609.344,
  'Centimeters': 0.01, 'Decimeters': 0.1, 'Meters': 1, 'Kilometers': 1000,
  'Inches': 0.0254, 'Feet': 0.3048, 'Yards': 0.9144, 'Miles': 1609.344,
};

let _mode = null;            // 'native' | 'quicklook' | null
let _usdzCache = null;       // { key, url } — Quick Look reopens the same model instantly

export async function initAR() {
  const btn = document.getElementById('btn-ar');
  if (!btn) return;

  _mode = await detectMode();
  if (!_mode) return;        // stays hidden

  btn.classList.remove('hidden');
  btn.addEventListener('click', () => { openAR(); });
}

async function detectMode() {
  const cap = window.Capacitor;
  if (cap?.isPluginAvailable?.('ArViewer')) {
    try {
      const { supported } = await cap.Plugins.ArViewer.isSupported();
      return supported ? 'native' : null;
    } catch {
      return null;
    }
  }
  if (cap) return null;      // some other native shell — no AR runtime there

  // Safari on iOS/iPadOS advertises AR Quick Look through rel="ar".
  const a = document.createElement('a');
  if (a.relList?.supports?.('ar')) return 'quicklook';
  return null;
}

async function openAR() {
  if (!S.currentModel) return;
  showLoading(t('ar.preparing'));
  // Let the overlay paint before the export blocks the main thread. rAF never
  // fires in a hidden page, so a timeout stands in for it there.
  await new Promise(r => { requestAnimationFrame(() => setTimeout(r, 0)); setTimeout(r, 100); });
  try {
    if (_mode === 'native') await openNative();
    else if (_mode === 'quicklook') await openQuickLook();
  } catch (err) {
    console.error('[AR] failed:', err);
    showToast(t('ar.failed'));
  } finally {
    hideLoading();
  }
}

// ── Model preparation ─────────────────────────────────────────────────────────

function metresPerUnit() {
  const f = METRES_PER_UNIT[S.modelUnit];
  if (f) return f;
  // glTF is metres by definition; anything else unknown is most often a Rhino
  // millimetre file whose unit label did not survive.
  return /\.(glb|gltf)$/i.test(S.currentFileNameWithExt || '') ? 1 : 0.001;
}

// The material the object has in Rendered mode, whatever mode is showing now —
// AR is a rendering, not a technical drawing or an x-ray.
function arMaterial(mesh) {
  const m = S.currentMode === 'rendered'
    ? mesh.material
    : (mesh.userData.renderedMaterial || mesh.userData.originalMaterial || mesh.material);
  if (Array.isArray(m)) return m.map(toStandard);
  return toStandard(m);
}

// Both exporters only carry PBR materials faithfully (USDZ drops anything else
// outright), so a basic/lambert/phong material is rebuilt as a standard one.
function toStandard(m) {
  if (!m || m.isMeshStandardMaterial) return m;
  return new THREE.MeshStandardMaterial({
    color: m.color ? m.color.clone() : 0xffffff,
    map: m.map || null,
    transparent: m.transparent,
    opacity: m.opacity ?? 1,
    side: m.side,
  });
}

// A copy of the visible meshes and the groups above them, sharing geometry.
// Not Object3D.clone(): that deep-copies every userData (edge and material
// bookkeeping), which GLTFExporter then writes out as extras — tens of MB of
// JSON on a model whose geometry is one.
function copyForAR(src, geometries = new Map()) {
  const dst = src.isMesh ? new THREE.Mesh(floatGeometry(src.geometry, geometries), arMaterial(src)) : new THREE.Group();
  dst.name = src.name;
  dst.position.copy(src.position);
  dst.quaternion.copy(src.quaternion);
  dst.scale.copy(src.scale);
  for (const c of src.children) {
    if (HELPER_NAMES.has(c.name) || !c.visible || c.isLine || c.isPoints || c.isSprite) continue;
    dst.add(copyForAR(c, geometries));
  }
  return dst;
}

// A .rhv mesh is KHR_mesh_quantization: normalized int16 packed into an
// interleaved buffer, with the real size carried by the node's transform.
// Filament reads the bounds of such a mesh without that transform, so a 26 m
// house measured under 2 m and was placed at 1:1 with the camera inside it.
// Plain float attributes mean the same thing to every AR runtime.
function floatGeometry(geometry, cache) {
  const attrs = Object.values(geometry.attributes);
  if (!attrs.some(a => a.isInterleavedBufferAttribute || a.normalized)) return geometry;
  if (cache.has(geometry)) return cache.get(geometry);

  const out = new THREE.BufferGeometry();
  for (const [name, a] of Object.entries(geometry.attributes)) {
    const n = a.count, size = a.itemSize;
    const arr = new Float32Array(n * size);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < size; k++) arr[i * size + k] = a.getComponent(i, k);
    }
    out.setAttribute(name, new THREE.BufferAttribute(arr, size));
  }
  if (geometry.index) out.setIndex(geometry.index);
  for (const g of geometry.groups) out.addGroup(g.start, g.count, g.materialIndex);
  cache.set(geometry, out);
  return out;
}

function buildARRoot() {
  const box = computeVisibleBoundingBox(S.currentModel);
  if (box.isEmpty()) return null;

  const clone = copyForAR(S.currentModel);

  // Z-up → Y-up is a −90° turn about X: (x, y, z) ↦ (x, z, −y). The bottom
  // centre of the box lands on the origin so the model sits on the found floor.
  const s = metresPerUnit();
  const center = box.getCenter(new THREE.Vector3());
  const root = new THREE.Group();
  root.rotation.x = -Math.PI / 2;
  root.scale.setScalar(s);
  root.position.set(-s * center.x, -s * box.min.z, s * center.y);
  root.add(clone);
  root.updateMatrixWorld(true);
  const size = box.getSize(new THREE.Vector3()).multiplyScalar(s);
  root.userData.extentM = Math.max(size.x, size.y, size.z);
  return root;
}

// ── Android: native ARCore viewer ─────────────────────────────────────────────

async function openNative() {
  const root = buildARRoot();
  if (!root) return;

  const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
  const extentM = root.userData.extentM;
  root.userData = {};   // keep it out of the GLB's extras
  const glb = await new GLTFExporter().parseAsync(root, { binary: true });
  const base64Data = await toBase64(new Blob([glb], { type: 'model/gltf-binary' }));

  await window.Capacitor.Plugins.ArViewer.open({
    base64Data,
    extentM,
    title: S.currentFileName || '',
  });
}

function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1]);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// ── iOS: AR Quick Look ────────────────────────────────────────────────────────

// Anything that changes what the exported file would contain: the model itself,
// what is visible, where it is, and which materials the mode picks.
function usdzKey() {
  const box = computeVisibleBoundingBox(S.currentModel);
  let meshes = 0;
  S.currentModel.traverseVisible(c => { if (c.isMesh) meshes++; });
  return [S.currentModel.uuid, S.currentMode, meshes,
          ...box.min.toArray(), ...box.max.toArray()].join('|');
}

async function openQuickLook() {
  const key = usdzKey();
  if (_usdzCache?.key !== key) {
    const root = buildARRoot();
    if (!root) return;

    const { USDZExporter } = await import('three/addons/exporters/USDZExporter.js');
    const usdz = await new USDZExporter().parseAsync(root, { quickLookCompatible: true });

    if (_usdzCache) URL.revokeObjectURL(_usdzCache.url);
    const url = URL.createObjectURL(new Blob([usdz], { type: 'model/vnd.usdz+zip' }));
    _usdzCache = { key, url };
  }

  // Quick Look only opens from an anchor with rel="ar" whose sole child is an
  // <img>; the anchor itself never needs to be in the document.
  const a = document.createElement('a');
  a.rel = 'ar';
  a.href = `${_usdzCache.url}#allowsContentScaling=1`;
  a.appendChild(document.createElement('img'));
  a.click();
}
