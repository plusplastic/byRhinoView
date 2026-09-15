import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { S } from './state.js';

// ── Clipping Section Cap (Stencil Buffer Method) ───────────────────────────────
//
// All meshes live in arcOverlayScene so the stencil writes and reads happen in
// the SAME renderer.render() call — required for the stencil buffer to persist
// between the writer (stencil mesh) and the reader (cap plane).
//
// renderOrder within arcOverlayScene:
//  -1    depth mesh    (kept solid, depthWrite only — so the cap can be occluded)
//   0    stencil meshes (back +1 / front −1, colorWrite=false — depth complexity)
//   1    cap plane     (NotEqualStencilFunc + depthTest — fills the cross-section)
//   999+ gizmos        (arc handles, helper — unchanged)
//
// The animate loop calls renderer.clearStencil() AND clearDepth() right before
// rendering the overlay so both masks are rebuilt fresh each frame.
//
// The depth pre-pass is what makes the section behave correctly from BOTH sides:
// when the camera is on the kept side, the solid sits in front of the section
// plane and must occlude it (otherwise the green bleeds through the model).
//
// NOTE the cap plane must be CENTERED ON THE MODEL and sized to cover it — the
// model can sit far from the world origin, so a plane anchored at the origin
// would miss it entirely.

let _depthMesh        = null; // kept-solid depth-only pre-pass
let _stencilMesh      = null; // stencil writer — back faces (increment)
let _stencilMeshFront = null; // stencil writer — front faces (decrement)
let _mergedGeo   = null; // merged position-only geometry (world space)
let _modelCenter = null; // THREE.Vector3 — model bbox center (for plane placement)

// Unpacks a position attribute into a plain, unit-correct xyz Float32Array.
//
// Everything below wants float model-space coordinates it can transform and merge,
// and the attribute a .rhv hands over is not that: with KHR_mesh_quantization it
// is a normalized int16 view into an interleaved buffer. getX/getY/getZ is the one
// accessor that undoes both the stride and the normalization, so it is what both
// the closed-solid test and the merged cap geometry read through.
//
// Also the reason the result is copied rather than cloned: BufferAttribute.clone()
// preserves `normalized`, and applyMatrix4 on a normalized int16 attribute writes
// world coordinates back through the 1/32767 scale, which clamps them to nothing.
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

// A section cap only makes sense for CLOSED (watertight) solids. The stencil
// count runs along the WHOLE view ray (depthTest off), so an OPEN mesh anywhere
// in the column stays unbalanced and paints the cap color onto it even when the
// clip plane never touches it — that's the "untouched object gets filled" bug.
// A closed solid that isn't cut balances to zero, so it never paints.
//
// The catch: Rhino meshes are routinely "unwelded" (split vertices at smoothing
// creases), so a perfectly solid piece looks open at a fixed tolerance. We weld
// with a tolerance RELATIVE to the mesh size before counting boundary edges, so
// unwelded-but-closed solids are correctly recognised while genuinely open
// meshes (furniture shells, ground planes, flat panels) are excluded.
// Returns true only if every welded edge is shared by ≥2 triangles (no holes).
//
// Takes a plain xyz Float32Array rather than the geometry's own attribute: a .rhv
// written with KHR_mesh_quantization stores positions as normalized int16 packed
// into an INTERLEAVED buffer with a stride of 4, so reading `attribute.array` at
// i*3 walks straight across vertex boundaries and returns raw quantized integers.
// Every mesh then looked open, and the section cap silently built nothing.
function _isClosedSolid(xyz, indexArr) {
  if (!xyz) return false;
  const idx = indexArr;
  const triCount = idx ? idx.length / 3 : xyz.length / 9;
  if (triCount < 4) return false;                 // too few tris to bound a volume
  if (triCount > 300000) return true;             // too big to weld-check; assume solid
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < xyz.length; i += 3) {
    const x = xyz[i], y = xyz[i + 1], z = xyz[i + 2];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  const diag = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
  const inv = 1 / Math.max(diag * 1e-4, 1e-6);    // weld tolerance ∝ mesh size
  const arr = xyz;
  const vmap = new Map(); let nextId = 0;
  const idFor = vi => {
    const k = Math.round(arr[vi*3]*inv) + ',' + Math.round(arr[vi*3+1]*inv) + ',' + Math.round(arr[vi*3+2]*inv);
    let id = vmap.get(k);
    if (id === undefined) { id = nextId++; vmap.set(k, id); }
    return id;
  };
  const edges = new Map();
  const ek = (a, b) => a < b ? a + '_' + b : b + '_' + a;
  for (let t = 0; t < triCount; t++) {
    let a, b, c;
    if (idx) { a = idx[t*3]; b = idx[t*3+1]; c = idx[t*3+2]; } else { a = t*3; b = t*3+1; c = t*3+2; }
    const ia = idFor(a), ib = idFor(b), ic = idFor(c);
    const e1 = ek(ia, ib), e2 = ek(ib, ic), e3 = ek(ic, ia);
    edges.set(e1, (edges.get(e1) || 0) + 1);
    edges.set(e2, (edges.get(e2) || 0) + 1);
    edges.set(e3, (edges.get(e3) || 0) + 1);
  }
  for (const count of edges.values()) if (count < 2) return false;  // boundary edge → open
  return true;
}

export function buildClippingCap() {
  destroyClippingCap();
  if (!S.currentModel || !S.clippingPlane || !S.arcOverlayScene) return;

  // ── 1. Collect lean (position-only) geometries in world space ──────────────
  const geos = [];
  S.currentModel.traverse(mesh => {
    if (!mesh.isMesh) return;
    if (mesh.userData.type === 'note-marker') return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (mats.length > 0 && mats.every(m => m?.transparent && (m?.opacity ?? 1) < 0.5)) return;
    const srcGeo = mesh.geometry;
    const srcPos = srcGeo?.attributes?.position;
    if (!srcPos) return;
    const xyz = _readPositions(srcPos);
    const idx = srcGeo.index ? srcGeo.index.array : null;
    if (!_isClosedSolid(xyz, idx)) return;  // section fill is for closed solids only

    mesh.updateWorldMatrix(true, false);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(xyz, 3));
    if (srcGeo.index) g.setIndex(srcGeo.index.clone());
    g.applyMatrix4(mesh.matrixWorld);
    geos.push(g);
  });

  if (geos.length === 0) return;

  const merged = mergeGeometries(geos, false);
  geos.forEach(g => g.dispose());
  if (!merged) return;
  _mergedGeo = merged;

  // Model size → cap plane placement & size
  const box = new THREE.Box3().setFromObject(S.currentModel);
  _modelCenter = box.getCenter(new THREE.Vector3());
  const diameter = box.getSize(new THREE.Vector3()).length(); // bounding-sphere diameter
  const planeSize = diameter * 1.5;

  // ── 2. Stencil meshes (back/front Increment/Decrement — depth-complexity) ──
  // We count back-faces (+1) minus front-faces (−1) along each ray (depthTest
  // off → count ALL faces). For a closed solid the clip removes the near cap of
  // faces, leaving an unbalanced count inside the section. This signed count
  // handles OVERLAPPING / ABUTTING solids correctly (e.g. interlocking puzzle
  // pieces): the depth-complexity stays non-zero where the cut is inside any
  // solid. The INVERT/parity method fails here — coincident faces at shared
  // seams cancel, making the section flicker as the plane sweeps through them.
  // NotEqual 0 catches both +N and −N (wrapped to 255), so it reads correctly
  // from either side of the cut.
  const twinOpts = {
    colorWrite: false, depthWrite: false, depthTest: false,
    stencilWrite: true,
    stencilFunc: THREE.AlwaysStencilFunc,
    clippingPlanes: [S.clippingPlane],  // material-level clip; renderer clip is [] in overlay
  };
  _stencilMesh = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({
    ...twinOpts, side: THREE.BackSide,
    stencilFail: THREE.IncrementWrapStencilOp,
    stencilZFail: THREE.IncrementWrapStencilOp,
    stencilZPass: THREE.IncrementWrapStencilOp,
  }));
  _stencilMesh.renderOrder = 0;
  _stencilMesh.frustumCulled = false;

  _stencilMeshFront = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({
    ...twinOpts, side: THREE.FrontSide,
    stencilFail: THREE.DecrementWrapStencilOp,
    stencilZFail: THREE.DecrementWrapStencilOp,
    stencilZPass: THREE.DecrementWrapStencilOp,
  }));
  _stencilMeshFront.renderOrder = 0;
  _stencilMeshFront.frustumCulled = false;

  S.arcOverlayScene.add(_stencilMesh, _stencilMeshFront);

  // ── 3. Depth pre-pass — writes the kept solid's depth (no color, no stencil)
  // so the cap plane can be occluded by geometry in front of it.
  // polygonOffset pushes this depth slightly AWAY from the camera: the solid
  // faces right at the cut are coincident with the cap plane, so without the
  // bias they z-fight and the solid speckles through the fill. With the bias the
  // cap reliably wins at the cut, while geometry clearly in front (kept-side
  // view) still occludes it.
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

  // ── 4. Cap plane ───────────────────────────────────────────────────────────
  S.capMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(planeSize, planeSize),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(S.clippingCapColor || '#000000'),
      side: THREE.DoubleSide,
      depthWrite: false, depthTest: true,   // occluded by the kept solid (depth pre-pass)
      depthFunc: THREE.LessEqualDepth,
      stencilWrite: true,
      stencilFunc: THREE.NotEqualStencilFunc,
      stencilRef: 0,
      stencilFail: THREE.ReplaceStencilOp,
      stencilZFail: THREE.ReplaceStencilOp,
      stencilZPass: THREE.ReplaceStencilOp,  // reset stencil to 0 as the cap draws
    })
  );
  S.capMesh.renderOrder = 1;
  S.capMesh.frustumCulled = false;
  S.arcOverlayScene.add(S.capMesh);

  updateClippingCapPose();
}

export function destroyClippingCap() {
  if (_stencilMesh) {
    S.arcOverlayScene?.remove(_stencilMesh);
    _stencilMesh.material?.dispose();
    _stencilMesh = null;
  }
  if (_stencilMeshFront) {
    S.arcOverlayScene?.remove(_stencilMeshFront);
    _stencilMeshFront.material?.dispose();
    _stencilMeshFront = null;
  }
  if (_depthMesh) {
    S.arcOverlayScene?.remove(_depthMesh);
    _depthMesh.material?.dispose();
    _depthMesh = null;
  }
  if (_mergedGeo) { _mergedGeo.dispose(); _mergedGeo = null; }
  if (S.capMesh) {
    S.arcOverlayScene?.remove(S.capMesh);
    S.capMesh.geometry?.dispose();
    S.capMesh.material?.dispose();
    S.capMesh = null;
  }
  _modelCenter = null;
}

export function updateClippingCapPose() {
  if (!S.capMesh || !S.clippingPlane || !_modelCenter) return;
  const n = S.clippingPlane.normal;
  // Anchor the plane at the MODEL CENTER projected onto the clipping plane,
  // not at the world-origin foot point (the model may be far from the origin).
  const dist = n.dot(_modelCenter) + S.clippingPlane.constant; // signed distance
  S.capMesh.position.copy(_modelCenter).addScaledVector(n, -dist);
  S.capMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
}

export function setClippingCapEnabled(enabled) {
  S.clippingCapEnabled = enabled;
  if (enabled && S.clippingEnabled) {
    buildClippingCap();
  } else {
    destroyClippingCap();
  }
}

export function setClippingCapColor(hexColor) {
  S.clippingCapColor = hexColor;
  if (S.capMesh?.material) {
    S.capMesh.material.color.set(hexColor);
    S.capMesh.material.needsUpdate = true;
  }
}
