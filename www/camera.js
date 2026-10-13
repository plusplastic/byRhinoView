import * as THREE from 'three';
import { S } from './state.js';

// The viewport's aspect ratio, never NaN.
//
// window.innerWidth / window.innerHeight is 0/0 while the page lays out in a
// hidden or zero-sized frame, and that NaN does not stay local: it reaches the
// lens→fov conversion, from there the near/far planes, and from there the
// projection matrix — at which point the scene is fully loaded and draws
// nothing at all. updateAdaptiveClipping() cannot undo it either, since every
// comparison against NaN is false (see the guard there). A square frame for a
// viewport that has no shape yet costs nothing: the next resize recomputes it.
export function viewAspect() {
  const w = window.innerWidth, h = window.innerHeight;
  return (w > 0 && h > 0) ? w / h : 1;
}

export function switchToOrtho() {
  if (S.twoPointActive) disableTwoPoint();
  const dist   = S.perspCamera.position.distanceTo(S.controls.target);
  const h      = dist * Math.tan(S.perspCamera.fov * Math.PI / 360);
  const aspect = viewAspect();
  S.orthoCamera.left   = -h * aspect;
  S.orthoCamera.right  =  h * aspect;
  S.orthoCamera.top    =  h;
  S.orthoCamera.bottom = -h;
  S.orthoCamera.near   = -100000;
  S.orthoCamera.far    =  100000;
  S.orthoCamera.position.copy(S.perspCamera.position);
  S.orthoCamera.quaternion.copy(S.perspCamera.quaternion);
  S.orthoCamera.up.copy(S.perspCamera.up);
  S.orthoCamera.updateProjectionMatrix();
  S.camera = S.orthoCamera;
  S.controls.object = S.camera;
  if (S.composer?.passes) {
    S.composer.passes.forEach(pass => {
      if (pass.camera !== undefined) pass.camera = S.camera;
    });
  }
  const ps = document.getElementById('select-projection');
  if (ps) ps.value = 'parallel';
  S.controls.update();
}

export function switchToPersp() {
  if (S.twoPointActive) disableTwoPoint();
  S.camera = S.perspCamera;
  S.controls.object = S.camera;
  if (S.composer?.passes) {
    S.composer.passes.forEach(pass => {
      if (pass.camera !== undefined) pass.camera = S.camera;
    });
  }
  const ps = document.getElementById('select-projection');
  if (ps) ps.value = 'perspective';
  S.controls.update();
}

// ── 2-Point Perspective ───────────────────────────────────────────────────
//
// Rhino-style 2-point: the user orbits freely (any polar angle, any azimuth).
// Each frame, AFTER OrbitControls.update(), we look at the camera/target
// relationship and convert whatever pitch it would produce into an equivalent
// vertical lens shift, then re-aim the camera horizontally. The user perceives
// "looking up/down" but world-vertical lines stay parallel.
//
//   pitch = atan2(target.z - camera.z, horizontal_distance)
//   lens_shift (NDC y) = tan(pitch) / tan(fov/2)
//
// This means pan / dolly / orbit all work as the user expects in any
// direction — no input is intercepted.

let _savedTarget = null; // THREE.Vector3 clone of S.controls.target on entry

export function switchToTwoPoint() {
  // 2-point only makes sense with a perspective camera.
  if (S.camera === S.orthoCamera) {
    S.perspCamera.position.copy(S.orthoCamera.position);
    S.perspCamera.quaternion.copy(S.orthoCamera.quaternion);
    S.perspCamera.up.copy(S.orthoCamera.up);
    S.camera = S.perspCamera;
    S.controls.object = S.camera;
    if (S.composer?.passes) {
      S.composer.passes.forEach(pass => {
        if (pass.camera !== undefined) pass.camera = S.camera;
      });
    }
  }

  // Save the original orbit target so we can restore it on exit (so the
  // round-trip is non-destructive — the camera goes back to its 3-point pose).
  _savedTarget = S.controls.target.clone();

  S.perspCamera.up.set(0, 0, 1);
  S.twoPointActive = true;
  S.twoPointShift  = 0; // recomputed each frame from camera/target geometry
  const ps = document.getElementById('select-projection');
  if (ps) ps.value = 'two-point';
  S.controls.update();
}

function disableTwoPoint() {
  S.twoPointActive = false;
  S.twoPointShift  = 0;
  if (_savedTarget) {
    S.controls.target.copy(_savedTarget);
    S.perspCamera.lookAt(_savedTarget);
  }
  _savedTarget = null;
  // Reset projection matrix to a clean state.
  if (S.perspCamera) S.perspCamera.updateProjectionMatrix();
}

// No-op kept for backward compatibility — the drag handler is no longer needed
// since OrbitControls drives vertical motion directly.
export function installTwoPointDragHandler() {}

// Called every frame from animate(), after S.controls.update().
// Converts the current pitch (target above/below camera) into a lens shift,
// then re-aims the camera horizontally so verticals stay parallel.
export function apply2PointConstraints() {
  if (!S.twoPointActive || S.camera !== S.perspCamera) return;

  S.perspCamera.up.set(0, 0, 1);

  // Vector from camera to target — its horizontal magnitude and vertical
  // component define the "pitch" the user has dialed in via OrbitControls.
  const dx = S.controls.target.x - S.perspCamera.position.x;
  const dy = S.controls.target.y - S.perspCamera.position.y;
  const dz = S.controls.target.z - S.perspCamera.position.z;
  const horiz = Math.hypot(dx, dy);
  if (horiz < 1e-4) return; // looking straight up/down — 2-point ill-defined

  const pitch = Math.atan2(dz, horiz);

  // Re-aim camera horizontally in the same azimuth (level target at camera Z).
  const levelTarget = new THREE.Vector3(
    S.perspCamera.position.x + dx,
    S.perspCamera.position.y + dy,
    S.perspCamera.position.z
  );
  S.perspCamera.lookAt(levelTarget);
  S.perspCamera.updateMatrixWorld();

  // Lens shift = focal * tan(pitch) = tan(pitch) / tan(fov/2).
  // m.elements[9] subtracts directly from NDC y, so this offsets the framing
  // by exactly the amount the original pitch would have moved the horizon.
  const t = Math.tan(S.perspCamera.fov * Math.PI / 360);
  S.twoPointShift = Math.tan(pitch) / Math.max(t, 1e-6);

  S.perspCamera.updateProjectionMatrix();
  S.perspCamera.projectionMatrix.elements[9] = S.twoPointShift;
  // updateProjectionMatrix() also writes projectionMatrixInverse, which is now
  // stale relative to our shifted matrix. SSAO, screen-space passes, and
  // depth-to-view reconstruction read this inverse — keep it in sync.
  S.perspCamera.projectionMatrixInverse.copy(S.perspCamera.projectionMatrix).invert();
}

export function setViewPreset(preset) {
  const box    = S.currentModel ? new THREE.Box3().setFromObject(S.currentModel) : null;
  const center = box ? box.getCenter(new THREE.Vector3()) : new THREE.Vector3(0, 0, 0);
  const size   = box ? box.getSize(new THREE.Vector3()) : new THREE.Vector3(100, 100, 100);
  const maxDim = Math.max(size.x, size.y, size.z) || 100;
  const dist   = maxDim * 2.2;

  let targetPos = new THREE.Vector3();
  let targetUp  = new THREE.Vector3(0, 0, 1);

  if (preset === 'perspective') {
    targetPos.set(center.x + dist * 0.7, center.y - dist * 0.7, center.z + dist * 0.7);
    targetUp.set(0, 0, 1);
  } else if (preset === 'top') {
    targetPos.set(center.x, center.y, center.z + dist);
    targetUp.set(0, 1, 0);
  } else if (preset === 'front') {
    targetPos.set(center.x, center.y - dist, center.z);
    targetUp.set(0, 0, 1);
  } else if (preset === 'right') {
    targetPos.set(center.x + dist, center.y, center.z);
    targetUp.set(0, 0, 1);
  }

  triggerCameraTransition(targetPos, center, targetUp);

  // ── Sync the view preset dropdown button UI dynamically ──
  const dropdown = document.getElementById('view-dropdown');
  if (dropdown) {
    const activeItem = dropdown.querySelector(`.dropdown-item[data-view="${preset}"]`);
    if (activeItem) {
      // Keep dropdown active classes in sync
      dropdown.querySelectorAll('.dropdown-item').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.view === preset);
      });
      // Update top trigger button label & title
      const triggerBtn = document.getElementById('btn-view-dropdown');
      if (triggerBtn) {
        const label = activeItem.querySelector('span').textContent.split(' ')[0];
        const triggerLabel = triggerBtn.querySelector('span');
        if (triggerLabel) triggerLabel.textContent = label;
        triggerBtn.title = `View Preset (${label})`;

        // Clone and swap the active view's SVG icon onto the trigger button
        const svg = activeItem.querySelector('svg').cloneNode(true);
        const oldSvg = triggerBtn.querySelector('svg');
        if (oldSvg) {
          triggerBtn.replaceChild(svg, oldSvg);
        }
      }
    }
  }
}

// ── Walkthrough mode ──────────────────────────────────────────────────────
//
// First-person navigation: WASD/Arrow keys to move, mouse drag to look.
// World-up is +Z (Rhino convention), so yaw rotates around Z and movement
// happens on the XY plane. Pitch is clamped to keep roll = 0 ("upright head").
//
// The actual per-frame integration (key→velocity, drag→yaw/pitch) lives in
// app.js animate(). This module just owns the enter/exit transition.

export function setWalkthroughMode(enable) {
  if (enable === S.walkthroughActive) return;

  if (enable) {
    // 1. Force perspective — parallel projection makes no sense for walking.
    //    Also exit 2-point: walkthrough needs free pitch.
    if (S.twoPointActive) {
      disableTwoPoint();
      const ps = document.getElementById('select-projection');
      if (ps) ps.value = 'perspective';
    }
    if (S.camera === S.orthoCamera) switchToPersp();

    // 2. Derive initial yaw/pitch from current camera orientation so the
    //    transition is seamless (no view jump).
    const forward = new THREE.Vector3();
    S.camera.getWorldDirection(forward);
    S.walkthroughYaw   = Math.atan2(forward.y, forward.x);
    const horiz        = Math.hypot(forward.x, forward.y);
    S.walkthroughPitch = Math.atan2(forward.z, horiz);

    // 3. Lock camera-up to world-up so roll can't accumulate.
    S.camera.up.set(0, 0, 1);

    // 4. Derive a reasonable walk speed from the model size. ~1/8 of the
    //    diagonal per second feels close to human walking pace in a typical
    //    room-scale model, and scales gracefully across units (mm/m/in).
    if (S.currentModel) {
      const box  = new THREE.Box3().setFromObject(S.currentModel);
      const size = box.getSize(new THREE.Vector3());
      const diag = size.length() || 100;
      S.walkthroughSpeed = diag / 8;
    } else {
      S.walkthroughSpeed = 10;
    }

    // 5. Clean per-session input state and hand off control.
    S.walkthroughKeys     = new Set();
    S.walkthroughDrag     = null;
    S.walkthroughLastT    = performance.now();
    S.controls.enabled    = false;
    S.walkthroughActive   = true;
    window.dispatchEvent(new CustomEvent('walkthrough-changed', { detail: { active: true } }));
  } else {
    // Resume orbit at a target slightly in front of the camera so the user
    // can immediately orbit around where they were looking.
    const forward = new THREE.Vector3();
    S.camera.getWorldDirection(forward);
    const t = S.walkthroughSpeed > 0 ? S.walkthroughSpeed * 2 : 5;
    S.controls.target.copy(S.camera.position).addScaledVector(forward, t);
    S.camera.up.set(0, 0, 1);
    S.controls.enabled  = true;
    S.controls.update();
    S.walkthroughActive = false;
    S.walkthroughKeys   = null;
    S.walkthroughDrag   = null;
    window.dispatchEvent(new CustomEvent('walkthrough-changed', { detail: { active: false } }));
  }
}

export function triggerCameraTransition(pos, target, up) {
  const endPos    = pos    instanceof THREE.Vector3 ? pos.clone()    : new THREE.Vector3().fromArray(pos);
  const endTarget = target instanceof THREE.Vector3 ? target.clone() : new THREE.Vector3().fromArray(target);
  const endUp     = up     instanceof THREE.Vector3 ? up.clone()     : new THREE.Vector3().fromArray(up);

  S.pendingOrthoSwitch = (S.camera === S.orthoCamera);

  if (S.camera === S.orthoCamera) {
    S.perspCamera.position.copy(S.orthoCamera.position);
    S.perspCamera.quaternion.copy(S.orthoCamera.quaternion);
    S.perspCamera.up.copy(S.orthoCamera.up);
    S.camera = S.perspCamera;
    S.controls.object = S.camera;
    if (S.composer?.passes[0]) S.composer.passes[0].camera = S.camera;
    if (S.composer?.passes[1]) S.composer.passes[1].camera = S.camera;
  }

  S.cameraTransition = {
    startTime:   performance.now(),
    duration:    1200,
    startPos:    S.camera.position.clone(),
    endPos:      endPos,
    startTarget: S.controls.target.clone(),
    endTarget:   endTarget,
    startUp:     S.camera.up.clone(),
    endUp:       endUp
  };
}

export function fitCameraToBox(box, preserveView = false, animate = false) {
  const center = box.getCenter(new THREE.Vector3());
  const size   = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  const fov    = S.camera.isPerspectiveCamera ? S.camera.fov : 45;

  // Both inputs are sanitized before they can reach a clipping plane. A degenerate
  // box (one point, or a model of a single flat object) makes maxDim 0, and a fov
  // that arrived NaN from a zero-sized viewport makes the whole expression NaN —
  // either way near/far end up unusable and the viewport goes blank with the model
  // loaded, which reads as a failed load rather than a bad camera.
  const extent  = Number.isFinite(maxDim) && maxDim > 0 ? maxDim : 1;
  const safeFov = Number.isFinite(fov) && fov > 0 && fov < 180 ? fov : 45;
  const dist    = Math.abs(extent / 2 / Math.tan(safeFov * Math.PI / 360)) * 1.5;

  const minNear = Math.max(0.001, dist * 0.0005);
  const maxFar  = dist * 50;
  S.perspCamera.near = minNear;
  S.perspCamera.far  = maxFar;
  S.perspCamera.updateProjectionMatrix();
  if (S.orthoCamera) {
    S.orthoCamera.near = -maxFar;
    S.orthoCamera.far  =  maxFar;
    S.orthoCamera.updateProjectionMatrix();
  }

  // Cache the model's world-space bounding sphere so the render loop can
  // adaptively tighten the perspective near/far. The fixed far/near = 100000
  // ratio above wrecks depth-buffer precision; with a long lens + zoom-out the
  // model sits deep in that range, and GTAO — which reconstructs view positions
  // from depth — produces speckle noise. See updateAdaptiveClipping().
  //   - radius     bounds the MODEL → drives `near` (precision where AO matters).
  //   - farRadius  also covers the ground plane (span = max(x,y)*5, so its
  //                half-diagonal) → drives `far` so the ground stays visible.
  // Keeping `near` tight to the model (not the much larger ground sphere) is
  // what actually restores precision: depth resolution at the model scales with
  // (far-near)/near, so a large `near` just in front of the model is the win.
  const groundHalfDiag = Math.max(size.x, size.y) * 2.5 * Math.SQRT2;
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  S.clipSphere = {
    center:    sphere.center.clone(),
    radius:    Math.max(sphere.radius, 1e-4),
    farRadius: Math.max(sphere.radius, groundHalfDiag, 1e-4)
  };

  let targetPos;
  if (preserveView) {
    const dir = new THREE.Vector3();
    S.camera.getWorldDirection(dir);
    targetPos = center.clone().addScaledVector(dir, -dist);
  } else {
    targetPos = new THREE.Vector3(
      center.x + dist * 0.7,
      center.y - dist * 0.7,
      center.z + dist * 0.7
    );
  }

  if (animate) {
    triggerCameraTransition(targetPos.toArray(), center.toArray(), S.camera.up.toArray());
  } else {
    S.camera.position.copy(targetPos);
    if (!preserveView) S.camera.lookAt(center);
    S.controls.target.copy(center);
    S.controls.update();
  }
}

export function fitCameraToObject(obj, preserve, animate = false) {
  fitCameraToBox(new THREE.Box3().setFromObject(obj), preserve, animate);
}

// Adaptively fit the perspective camera's near/far to the scene bounding sphere
// each frame. Keeps far/near small (~2-3x) so the 24-bit depth buffer retains
// precision at any lens length / zoom level. Without this, a long lens (tiny
// FOV → camera far back) plus zoom-out pushes the model into the low-precision
// far half of the depth range, and GTAO reconstructs jittery view positions
// from the quantized depth → uniform speckle AO noise over every surface.
// Ortho is left untouched (linear depth has no such precision problem).
export function updateAdaptiveClipping() {
  const cam = S.perspCamera;
  if (!cam || S.camera !== cam || !S.clipSphere) return;

  const d  = cam.position.distanceTo(S.clipSphere.center);
  const r  = S.clipSphere.radius;      // model only → tight near plane
  const fr = S.clipSphere.farRadius;   // model + ground → far plane

  // near just in front of the model (clamped positive when the camera is inside
  // the model sphere); far behind the model + ground. The nearest model point
  // is d-r and the farthest ground point is within d+fr, so visible geometry is
  // never clipped. A small margin on near guards against grazing-angle clipping.
  const near = Math.max(d - r * 1.05, r * 1e-3, 1e-4);
  const far  = d + fr;

  // Never write a NaN, and never leave one in place. A NaN near plane is not a
  // bad frame, it is a permanent one: it makes the projection matrix NaN so the
  // scene vanishes, and the "has it moved enough to be worth updating" test below
  // is false against NaN whichever side it sits on, so the plane that went bad
  // would never be replaced by the good value computed on the next frame. Forcing
  // the write when what the camera currently holds is not finite is what lets a
  // single bad frame — a zero-sized viewport during layout, a model whose bounds
  // came out NaN — recover by itself.
  if (!Number.isFinite(near) || !Number.isFinite(far)) return;

  if (!Number.isFinite(cam.near) || !Number.isFinite(cam.far)
      || Math.abs(cam.near - near) > near * 1e-3 || Math.abs(cam.far - far) > far * 1e-3) {
    cam.near = near;
    cam.far  = far;
    cam.updateProjectionMatrix();
  }
}

export function fitCameraToSelected() {
  if (!S.selectedObjects.length) return;
  const box = new THREE.Box3();
  S.selectedObjects.forEach(o => box.expandByObject(o));
  fitCameraToBox(box, true, true);
}

// ── Custom / Named Views ──────────────────────────────────────────────────────

function _customViewKey() {
  const base = S.currentFileName ? S.currentFileName.replace(/\.[^.]+$/, '') : '__default__';
  return `rhino_custom_views_${base}`;
}

function _deletedRhinoViewKey() {
  const base = S.currentFileName ? S.currentFileName.replace(/\.[^.]+$/, '') : '__default__';
  return `rhino_deleted_views_${base}`;
}

export function getCustomViews() {
  try { return JSON.parse(localStorage.getItem(_customViewKey()) || '[]'); } catch { return []; }
}

function getDeletedRhinoViewNames() {
  try { return JSON.parse(localStorage.getItem(_deletedRhinoViewKey()) || '[]'); } catch { return []; }
}

export function saveCustomView(name) {
  if (!name || !S.controls) return;
  const views = getCustomViews().filter(v => v.name !== name); // overwrite existing
  views.push({
    name,
    position: S.camera.position.toArray(),
    target:   S.controls.target.toArray(),
    up:       S.camera.up.toArray(),
    isCustom: true
  });
  try {
    localStorage.setItem(_customViewKey(), JSON.stringify(views));
  } catch (e) {
    console.warn('Failed to save custom views to localStorage:', e);
  }
  renderNamedViewsUI();
}

export function deleteCustomView(name) {
  const views = getCustomViews().filter(v => v.name !== name);
  try {
    localStorage.setItem(_customViewKey(), JSON.stringify(views));
  } catch (e) {
    console.warn('Failed to delete custom view from localStorage:', e);
  }
  renderNamedViewsUI();
}

function deleteRhinoView(name) {
  const deleted = getDeletedRhinoViewNames();
  if (!deleted.includes(name)) deleted.push(name);
  try {
    localStorage.setItem(_deletedRhinoViewKey(), JSON.stringify(deleted));
  } catch (e) {
    console.warn('Failed to save deleted Rhino views to localStorage:', e);
  }
  renderNamedViewsUI();
}

export function renderNamedViewsUI() {
  const container = document.getElementById('named-views-list');
  if (!container) return;
  container.innerHTML = '';

  const deletedNames = getDeletedRhinoViewNames();
  const rhinoViews   = (S.parsedNamedViews || [])
    .filter(v => !deletedNames.includes(v.name));
  const customViews  = getCustomViews();

  // Merge: custom views override rhino views of the same name
  const customNames = new Set(customViews.map(v => v.name));
  const filteredRhino = rhinoViews.filter(v => !customNames.has(v.name));
  const allViews = [...filteredRhino, ...customViews];

  if (!allViews.length) {
    container.innerHTML = '<span class="dropdown-empty-msg" data-i18n="view.no_named">No named views</span>';
    return;
  }

  const delSVG = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="13" height="13"><polyline points="2 4 14 4"/><path d="M6 4V3h4v1M5 4l.5 9h5l.5-9"/></svg>`;
  const saveSVG = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" width="13" height="13"><path d="M13 2H3a1 1 0 00-1 1v10a1 1 0 001 1h10a1 1 0 001-1V5l-3-3z"/><path d="M9 2v3H6V2"/><rect x="3" y="9" width="10" height="5" rx="0.5"/></svg>`;

  allViews.forEach(nv => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:2px;';

    const btn = document.createElement('button');
    btn.className  = 'dropdown-item';
    btn.style.flex = '1';
    btn.innerHTML  = `<span>${nv.name}</span>`;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const pos = Array.isArray(nv.position) ? new THREE.Vector3(...nv.position) : nv.position;
      const tgt = Array.isArray(nv.target)   ? new THREE.Vector3(...nv.target)   : nv.target;
      const up  = Array.isArray(nv.up)       ? new THREE.Vector3(...nv.up)       : nv.up;
      triggerCameraTransition(pos, tgt, up);
      document.getElementById('view-dropdown').classList.add('hidden');
    });
    row.appendChild(btn);

    // Overwrite button (save current camera to this view name)
    const saveBtn = document.createElement('button');
    saveBtn.className  = 'icon-btn sm';
    saveBtn.title      = 'Overwrite with current view';
    saveBtn.style.cssText = 'padding:3px 5px;flex-shrink:0;color:var(--text-2);';
    saveBtn.innerHTML  = saveSVG;
    saveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      saveCustomView(nv.name); // overwrites same name in localStorage
    });
    row.appendChild(saveBtn);

    // Delete button (works for both rhino and custom views)
    const del = document.createElement('button');
    del.className  = 'icon-btn sm';
    del.title      = 'Delete view';
    del.style.cssText = 'padding:3px 5px;flex-shrink:0;color:var(--text-2);';
    del.innerHTML  = delSVG;
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (nv.isCustom) deleteCustomView(nv.name);
      else deleteRhinoView(nv.name);
    });
    row.appendChild(del);

    container.appendChild(row);
  });
}
