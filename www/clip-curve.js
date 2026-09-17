import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { S } from './state.js';

// ── Clipping Section Curve ────────────────────────────────────────────────────
//
// The outline where the clipping plane cuts the model: every triangle straddling
// the plane contributes one segment, and the segments together read as the
// section's boundary curve. Unlike the stencil cap fill (clip-cap.js) this is
// real geometry, so it works for OPEN meshes too — a cut through a surface or a
// shell has a section curve even though it encloses no volume to fill.
//
// Lives in arcOverlayScene alongside the cap, with renderOrder above it:
//  -1  depth mesh    (kept solid, depthWrite only — so the curve can be occluded)
//   1  cap plane     (clip-cap.js)
//   2  section curve (drawn over the cap, occluded by the depth mesh)
//
// The depth pre-pass is what keeps the curve from X-raying through the model when
// the camera orbits to the kept side. polygonOffset pushes that depth slightly
// away from the camera so the solid's faces right at the cut — coincident with
// the curve — do not z-fight it away.
//
// The source geometry is merged ONCE (world space, position only) and, when BVH
// is available, given a bounds tree. Recomputing the segments then only visits
// triangles near the plane, which is what makes dragging the gizmo smooth.

let _srcGeo    = null;  // merged world-space, position-only source for the intersection
let _depthMesh = null;  // depth-only pre-pass so the curve is occluded from the kept side
let _posAttr   = null;  // the line's position attribute (grown, not reallocated, per move)
let _capacity  = 0;     // floats allocated in _posAttr

// Plane pose the current segments were computed for — recomputing is skipped
// while it is unchanged, since animate() calls the update every frame.
let _lastNx = NaN, _lastNy = NaN, _lastNz = NaN, _lastConst = NaN;

const SKIP_NAMES = ['rhino-edges', 'rhino-outline', 'selection-outline', 'ground-plane'];

// Same unpacking rationale as clip-cap.js: a .rhv position attribute is a
// normalized int16 view into an interleaved buffer, so only getX/getY/getZ
// return usable float coordinates.
function _readPositions(attr) {
  const n = attr.count;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    out[i * 3]     = attr.getX(i);
    out[i * 3 + 1] = attr.getY(i);
    out[i * 3 + 2] = attr.getZ(i);
  }
  return out;
}

// A hidden object has no section, so honour visibility up the whole chain.
function _visible(obj) {
  let o = obj;
  while (o) {
    if (!o.visible) return false;
    if (o === S.currentModel) return true;
    o = o.parent;
  }
  return true;
}

// ── Plane × triangle → one segment ────────────────────────────────────────────
// A triangle only yields a segment when exactly two of its edges straddle the
// plane; anything else (coplanar, or touching at a single vertex) is discarded
// rather than guessed at, which keeps zero-length stubs out of the curve.
function _pushCross(v0, d0, v1, d1, out) {
  const t = d0 / (d0 - d1);
  out.push(
    v0.x + (v1.x - v0.x) * t,
    v0.y + (v1.y - v0.y) * t,
    v0.z + (v1.z - v0.z) * t,
  );
}

function _triSegment(a, b, c, nx, ny, nz, cst, out) {
  const da = nx * a.x + ny * a.y + nz * a.z + cst;
  const db = nx * b.x + ny * b.y + nz * b.z + cst;
  const dc = nx * c.x + ny * c.y + nz * c.z + cst;
  if ((da > 0 && db > 0 && dc > 0) || (da < 0 && db < 0 && dc < 0)) return;  // fully on one side
  const start = out.length;
  if (da * db < 0) _pushCross(a, da, b, db, out);
  if (db * dc < 0) _pushCross(b, db, c, dc, out);
  if (dc * da < 0) _pushCross(c, dc, a, da, out);
  if (out.length - start !== 6) out.length = start;   // not exactly two points → drop it
}

const _ta = new THREE.Vector3(), _tb = new THREE.Vector3(), _tc = new THREE.Vector3();

function _computeSegments() {
  const plane = S.clippingPlane;
  const nx = plane.normal.x, ny = plane.normal.y, nz = plane.normal.z;
  const cst = plane.constant;
  const out = [];

  const bvh = _srcGeo.boundsTree;
  if (bvh) {
    bvh.shapecast({
      intersectsBounds: box => plane.intersectsBox(box),
      intersectsTriangle: tri => { _triSegment(tri.a, tri.b, tri.c, nx, ny, nz, cst, out); return false; },
    });
    return out;
  }

  // No BVH (heavy model, or three-mesh-bvh unavailable) — walk every triangle.
  const pos = _srcGeo.attributes.position.array;
  const idx = _srcGeo.index ? _srcGeo.index.array : null;
  const triCount = idx ? idx.length / 3 : pos.length / 9;
  for (let t = 0; t < triCount; t++) {
    const i0 = (idx ? idx[t * 3]     : t * 3)     * 3;
    const i1 = (idx ? idx[t * 3 + 1] : t * 3 + 1) * 3;
    const i2 = (idx ? idx[t * 3 + 2] : t * 3 + 2) * 3;
    _ta.set(pos[i0], pos[i0 + 1], pos[i0 + 2]);
    _tb.set(pos[i1], pos[i1 + 1], pos[i1 + 2]);
    _tc.set(pos[i2], pos[i2 + 1], pos[i2 + 2]);
    _triSegment(_ta, _tb, _tc, nx, ny, nz, cst, out);
  }
  return out;
}

export function buildClippingCurve() {
  destroyClippingCurve();
  if (!S.currentModel || !S.clippingPlane || !S.arcOverlayScene) return;

  // ── 1. Merge every eligible mesh into one world-space, position-only geometry
  const geos = [];
  S.currentModel.traverse(mesh => {
    if (!mesh.isMesh) return;
    if (mesh.userData.type === 'note-marker') return;
    if (SKIP_NAMES.includes(mesh.name)) return;
    if (!_visible(mesh)) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (mats.length > 0 && mats.every(m => m?.transparent && (m?.opacity ?? 1) < 0.5)) return;
    const srcGeo = mesh.geometry;
    const srcPos = srcGeo?.attributes?.position;
    if (!srcPos) return;

    mesh.updateWorldMatrix(true, false);
    const xyz = _readPositions(srcPos);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(xyz, 3));
    // mergeGeometries refuses a mix of indexed and non-indexed inputs, so give
    // the non-indexed ones a trivial index rather than de-indexing the rest.
    if (srcGeo.index) {
      g.setIndex(srcGeo.index.clone());
    } else {
      const n = srcPos.count;
      const seq = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
      for (let i = 0; i < n; i++) seq[i] = i;
      g.setIndex(new THREE.BufferAttribute(seq, 1));
    }
    g.applyMatrix4(mesh.matrixWorld);
    geos.push(g);
  });

  if (geos.length === 0) return;
  const merged = mergeGeometries(geos, false);
  geos.forEach(g => g.dispose());
  if (!merged) return;
  _srcGeo = merged;

  if (S.bvhReady && merged.computeBoundsTree) {
    try { merged.computeBoundsTree(); } catch (e) { console.warn('section curve BVH failed:', e); }
  }

  // ── 2. Depth pre-pass — see the header note on occlusion from the kept side.
  _depthMesh = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthWrite: true, depthTest: true,
    side: THREE.DoubleSide,
    clippingPlanes: [S.clippingPlane],
    polygonOffset: true,
    polygonOffsetFactor: 2,
    polygonOffsetUnits: 2,
  }));
  _depthMesh.renderOrder = -1;
  _depthMesh.frustumCulled = false;
  S.arcOverlayScene.add(_depthMesh);

  // ── 3. The curve itself ────────────────────────────────────────────────────
  const geo = new THREE.BufferGeometry();
  S.sectionCurve = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
    color: new THREE.Color(S.clippingCurveColor || '#ffffff'),
    depthWrite: false, depthTest: true,
    depthFunc: THREE.LessEqualDepth,
    toneMapped: false,
  }));
  S.sectionCurve.renderOrder = 2;
  S.sectionCurve.frustumCulled = false;
  S.arcOverlayScene.add(S.sectionCurve);

  _lastConst = NaN;      // force the first computation
  updateClippingCurve();
}

// Recomputes the segments, but only when the clipping plane has actually moved —
// animate() calls this every frame.
export function updateClippingCurve() {
  if (!S.sectionCurve || !_srcGeo || !S.clippingPlane) return;
  const n = S.clippingPlane.normal, cst = S.clippingPlane.constant;
  if (n.x === _lastNx && n.y === _lastNy && n.z === _lastNz && cst === _lastConst) return;
  _lastNx = n.x; _lastNy = n.y; _lastNz = n.z; _lastConst = cst;

  const out = _computeSegments();
  const geo = S.sectionCurve.geometry;

  // Grow the buffer in place so a gizmo drag does not allocate a new one per frame.
  if (!_posAttr || out.length > _capacity) {
    _capacity = Math.max(out.length * 2, 6144);
    _posAttr = new THREE.BufferAttribute(new Float32Array(_capacity), 3);
    _posAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', _posAttr);
  }
  _posAttr.array.set(out);
  _posAttr.needsUpdate = true;
  geo.setDrawRange(0, out.length / 3);
}

export function destroyClippingCurve() {
  if (_depthMesh) {
    S.arcOverlayScene?.remove(_depthMesh);
    _depthMesh.material?.dispose();
    _depthMesh = null;
  }
  if (S.sectionCurve) {
    S.arcOverlayScene?.remove(S.sectionCurve);
    S.sectionCurve.geometry?.dispose();
    S.sectionCurve.material?.dispose();
    S.sectionCurve = null;
  }
  if (_srcGeo) {
    _srcGeo.disposeBoundsTree?.();
    _srcGeo.dispose();
    _srcGeo = null;
  }
  _posAttr = null;
  _capacity = 0;
  _lastNx = _lastNy = _lastNz = _lastConst = NaN;
}

export function setClippingCurveEnabled(enabled) {
  S.clippingCurveEnabled = enabled;
  if (enabled && S.clippingEnabled) {
    buildClippingCurve();
  } else {
    destroyClippingCurve();
  }
}

export function setClippingCurveColor(hexColor) {
  S.clippingCurveColor = hexColor;
  if (S.sectionCurve?.material) {
    S.sectionCurve.material.color.set(hexColor);
    S.sectionCurve.material.needsUpdate = true;
  }
}
