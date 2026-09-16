import * as THREE from 'three';
import { S } from './state.js';
import { applyDisplayMode, applyCustomToMaterial } from './display.js';
import { switchToPersp, getCustomViews } from './camera.js';
import { updateSliderFill, isPageVisuallyDark, showToast } from './helpers.js';
import { History } from './history.js';
import { t } from './i18n.js';

// ── .rhv format versioning ───────────────────────────────────────────────────
// Full contract in docs/rhv-format.md. Two producers write this format — this
// file and rhino-plugin/src/RhvWriter.cs — so the constants below are a shared
// interface, not local detail. Change the doc first.
//
// CONTAINER_VERSION describes the RV3D byte layout only. A file claiming a
// higher one cannot be parsed at all (we would not know where the fields are),
// so it is a hard fail. Everything additive goes in the JSON instead, which is
// why this should stay at 1.
//
// SCHEMA_VERSION describes the metadata JSON. MIN_VIEWER_SCHEMA is what we
// stamp into files we write: the oldest schema a reader needs to render our
// output *correctly*. Keep it below SCHEMA_VERSION for additive changes so
// older viewers keep opening new files and just ignore what they don't know.
const CONTAINER_VERSION   = 1;
const SCHEMA_VERSION      = 5;
const MIN_VIEWER_SCHEMA   = 3;
// Files written before schema 4 carry no minViewerSchema field.
const LEGACY_MIN_SCHEMA   = 3;
// Provenance only — never drives behaviour. Mirrors package.json and the version
// tag in index.html. That tag is also what the Rhino plugin's ShellUpdater parses to
// decide whether a published viewer-shell.html is newer, so bump all three together.
const APP_VERSION         = '1.0.2';

// Tagged so the loadSession catch can show the specific "update byRhinoView"
// message instead of the generic corrupt-file alert.
function versionError(message) {
  const e = new Error(message);
  e.rhvVersionError = true;
  return e;
}

// ── IndexedDB for last-used file handle ──────────────────────────────────────

export async function openPrefsDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('rhinoview-prefs', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('handles');
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

export async function saveLastFileHandle(handle) {
  try {
    const db  = await openPrefsDB();
    const tx  = db.transaction('handles', 'readwrite');
    tx.objectStore('handles').put(handle, 'lastFile');
  } catch {}
}

export async function loadLastFileHandle() {
  try {
    const db = await openPrefsDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction('handles').objectStore('handles').get('lastFile');
      req.onsuccess = e => resolve(e.target.result || null);
      req.onerror   = e => reject(e.target.error);
    });
  } catch { return null; }
}

// ── Object identity key (for session serialisation) ──────────────────────────

export function getObjectKey(obj) {
  const a = obj.userData.attributes || {};
  return (a.name || 'obj') + '_L' + (a.layerIndex ?? 0);
}

// (No GLB-level mesh compression. We tried meshopt FILTER/QUANTIZE and Draco;
// FILTER gave ~0 reduction, QUANTIZE + gltf-transform collapsed geometry on
// round-trip, and Draco's browser encoder couldn't be loaded via CDN with the
// current setup. So we keep only the gzip wrap below — browser-native, fast,
// and the only step actually saving bytes on the GLB binary right now.
// Real geometry compression will require a proper bundled Draco WASM build.)

// ── Texture re-encoding for GLB export ──────────────────────────────────────
// GLTFExporter encodes images based on tex.image.src MIME prefix. rhino3dm's
// 3DM loader hands us textures whose src says "data:image/png;base64,..." but
// whose actual bytes are JPEG (/9j/...). Result: a small JPEG gets DECODED
// then RE-ENCODED as a much larger PNG. For the Sample-Small-House model the
// 7 baseColor textures balloon from ~1.4 MB (JPEG) to ~12 MB (PNG).
//
// Policy:
//   • Normal maps          → PNG (lossless; JPEG would warp surface detail)
//   • Has alpha             → WebP 80% lossy (small + alpha preserved)
//   • Everything else       → JPEG 80% (best size/compatibility for opaque)
//
// We mutate tex.image temporarily for export and restore originals after.

// Slots whose pixel data encodes per-pixel surface direction. JPEG would
// distort the vector; PNG keeps them lossless.
//   • normalMap, clearcoatNormalMap — explicit RGB normal vectors
// bumpMap is INTENTIONALLY NOT in this set: it's a single-channel height/
// intensity field that JPEG handles fine at high quality and the savings
// are large (often 70-80% of total texture bytes).
const NORMAL_MAP_SLOTS = new Set(['normalMap', 'clearcoatNormalMap']);
// High-quality JPEG for height/bump (intensity field — tolerant of mild
// compression but visible at low quality).
const BUMP_MAP_SLOTS   = new Set(['bumpMap']);

function loadImageFromDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load re-encoded texture'));
    img.src = dataUrl;
  });
}

function imageHasAlpha(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  // Sample alpha channel — early exit at first translucent pixel. For very
  // large textures we stride to keep the scan ~1ms.
  const total  = data.length / 4;
  const stride = total > 65536 ? Math.ceil(total / 65536) : 1;
  for (let i = 3; i < data.length; i += 4 * stride) {
    if (data[i] < 255) return true;
  }
  return false;
}

/**
 * Walk the model's materials and tag each texture with the preferred mime type.
 * GLTFExporter reads texture.userData.mimeType when encoding the binary image.
 *
 *   • Normal/bump maps → image/png  (lossless; JPEG would distort surface)
 *   • Has alpha channel → image/webp (lossy with alpha)
 *   • Everything else  → image/jpeg (smallest for opaque colour data)
 *
 * Returns a Map<Texture, originalMimeType> that must be passed to
 * restoreTextureMimeTypes() after export.
 *
 * NOTE: an older revision of this helper swapped tex.image with a re-encoded
 * HTMLImageElement; that did NOTHING because the GLTFExporter draws the
 * decoded bitmap to its own canvas and re-encodes via the userData.mimeType
 * hint. Only this tag matters.
 */
function tagTextureMimeTypes(model) {
  const seen   = new Map();      // tex.uuid → { tex, slot }
  model.traverse(child => {
    if (!child.isMesh || !child.material) return;
    const mats = Array.isArray(child.material) ? child.material : [child.material];
    for (const mat of mats) {
      if (!mat) continue;
      for (const slot of ['map', 'normalMap', 'roughnessMap', 'metalnessMap',
                          'aoMap', 'emissiveMap', 'bumpMap', 'alphaMap',
                          'clearcoatNormalMap']) {
        const tex = mat[slot];
        if (!tex?.image || seen.has(tex.uuid)) continue;
        const img = tex.image;
        if (!(img.width || img.naturalWidth) || !(img.height || img.naturalHeight)) continue;
        seen.set(tex.uuid, { tex, slot });
      }
    }
  });

  const originals = new Map();  // tex → prior userData.mimeType (or undefined)
  for (const { tex, slot } of seen.values()) {
    try {
      let mimeType;
      if (NORMAL_MAP_SLOTS.has(slot)) {
        // Direction-encoding maps must stay lossless.
        mimeType = 'image/png';
      } else if (BUMP_MAP_SLOTS.has(slot)) {
        // Height/bump — JPEG fine. Quality is fixed by GLTFExporter (0.8) so
        // we just pick JPEG; it'd be quality 0.9+ if we could pass it through.
        mimeType = 'image/jpeg';
      } else {
        const img = tex.image;
        const w = img.width || img.naturalWidth;
        const h = img.height || img.naturalHeight;
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0);
        mimeType = imageHasAlpha(canvas) ? 'image/webp' : 'image/jpeg';
      }
      originals.set(tex, tex.userData.mimeType);
      tex.userData.mimeType = mimeType;
    } catch (e) {
      console.warn('[texture-tag] failed for one texture:', e);
    }
  }
  return originals;
}

function restoreTextureMimeTypes(originals) {
  for (const [tex, oldMime] of originals) {
    if (oldMime === undefined) delete tex.userData.mimeType;
    else                       tex.userData.mimeType = oldMime;
  }
}

// Fields on Object3D.userData that get serialised into glTF node `extras` and
// have proven to balloon the JSON chunk (Rhino raw doc dump on the root node,
// cloned Three.js Material instances on every mesh). Stripped temporarily for
// export — the live viewer keeps full userData.
//
// ROOT_USERDATA_STRIP is applied to children too (some loaders copy the dump onto
// them), so anything listed here is lost from every mesh on save. 'objectType' is
// deliberately NOT in it: it is a short string that records whether a mesh came
// from a Rhino Brep or a Rhino Mesh, which is what lets the viewer decide not to
// run dihedral edge extraction over mesh objects. Stripping it made that
// indistinguishable after a .rhv round-trip. The root's own 'File3dm' value is
// removed separately below.
const ROOT_USERDATA_STRIP   = ['materials', 'layers', 'groups', 'settings', 'warnings'];
const ROOT_ONLY_STRIP       = ['objectType'];
const MESH_USERDATA_STRIP   = ['originalMaterial', 'renderedMaterial',
                                'shadedMaterial', 'materialColor'];

function stripExportUserData(model) {
  const restore = []; // { obj, key, value }
  function stripFrom(obj, keys) {
    if (!obj?.userData) return;
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(obj.userData, k)) {
        restore.push({ obj, key: k, value: obj.userData[k] });
        delete obj.userData[k];
      }
    }
  }
  stripFrom(model, ROOT_USERDATA_STRIP);
  stripFrom(model, ROOT_ONLY_STRIP);
  model.traverse(child => {
    if (child === model) return;
    stripFrom(child, MESH_USERDATA_STRIP);
    // Some loaders also stash a copy on the root scene node — strip again
    stripFrom(child, ROOT_USERDATA_STRIP);
  });
  return restore;
}

function restoreExportUserData(restore) {
  for (const { obj, key, value } of restore) {
    obj.userData[key] = value;
  }
}

// ── Save session ─────────────────────────────────────────────────────────────

// Gathers all viewer state, exports the model to GLB, and wraps it in the
// gzip'd RV3D container. Resolves with { finalBuffer, finalName }. All temporary
// scene mutations (hidden outlines, swapped materials, stripped userData) are
// restored before resolving and on every error path. Shared by saveSession()
// (writes a .rhv) and exportPackage() (embeds into a self-contained .html).
async function buildSessionBuffer(customFileName = null) {
  const toHide = [];
  // Objects forced visible for the export because onlyVisible would otherwise
  // drop data that cannot be reconstructed — see the rhino-edges case below.
  const toReveal = [];
  // Declared in outer scope so the outer catch (synchronous errors before
  // GLTFExporter.parse fires) can also restore mutations.
  let outerTextureMimeOriginals = new Map();
  let outerUserDataRestore = [];
  let annGroup = null;
  let annParent = null;
  const activeMaterials = new Map();
  try {
    const settings = {
      displayMode:        S.currentMode,
      shadowsEnabled:     S.shadowsEnabled,
      groundEnabled:      S.groundEnabled,
      edgeOverlay:        document.getElementById('chk-edges-panel')?.checked ?? true,
      edgeThresholdAngle: parseFloat(document.getElementById('sl-edge-angle')?.value ?? 30),
      annotationsEnabled: document.getElementById('chk-annotations-panel')?.checked ?? true,
      sunLightEnabled:    document.getElementById('chk-sun-panel')?.checked ?? false,
      sunAzimuth:         parseFloat(document.getElementById('sl-sun-azimuth')?.value ?? 135),
      sunElevation:       parseFloat(document.getElementById('sl-sun-elevation')?.value ?? 45),
      sunIntensity:       parseFloat(document.getElementById('sl-sun-intensity')?.value ?? 1.8),
      ambientIntensity:   parseFloat(document.getElementById('sl-ambient-panel')?.value ?? 0.4),
      aoIntensity:        parseFloat(document.getElementById('sl-ao-intensity')?.value ?? 0.40),
      cameraLens:         parseFloat(document.getElementById('sl-camera-fov')?.value ?? 50),
      cameraFov:          (() => {
        const lens = parseFloat(document.getElementById('sl-camera-fov')?.value ?? 50);
        const aspect = window.innerWidth / window.innerHeight;
        const vFovRad = 2 * Math.atan(18 / (aspect * lens));
        return (vFovRad * 180) / Math.PI;
      })(),
      dampingFactor:      parseFloat(document.getElementById('sl-damping-panel')?.value ?? 0.5),
      envIntensity:       parseFloat(document.getElementById('sl-env-intensity')?.value ?? 1.00),
      measurementScale:   parseFloat(document.getElementById('sl-measure-scale')?.value ?? 1.0),
      annotationScale:    parseFloat(document.getElementById('sl-annotation-scale')?.value ?? 1.0),
      hdrRotation:        parseInt(document.getElementById('sl-hdr-rotation')?.value ?? 59),
      envPreset:          document.getElementById('env-preset-select')?.value || 'studio',
      bgType:             document.getElementById('bg-type-select')?.value || 'solid',
      bgC1:               document.getElementById('bg-panel-c1')?.value || '#2a2b2f',
      bgC2:               document.getElementById('bg-panel-c2')?.value || '#18181c',
      bgC3:               document.getElementById('bg-panel-c3')?.value || '#2d3748',
      bgC4:               document.getElementById('bg-panel-c4')?.value || '#1a202c',
      bgRadialSpread:     parseFloat(document.getElementById('bg-radial-spread')?.value ?? 0.5),
      modelUnit:          S.modelUnit,
      
      // Clipping Plane Settings
      clippingEnabled:    S.clippingEnabled,
      clippingHeight:     parseFloat(document.getElementById('clip-height')?.value ?? 0),
      clippingRotX:       parseFloat(document.getElementById('clipping-panel')?.dataset.rotX ?? 0),
      clippingRotY:       parseFloat(document.getElementById('clipping-panel')?.dataset.rotY ?? 180),
      clippingMode:       document.querySelector('.clip-axis-btn[data-clip-mode].active')?.dataset.clipMode ?? 'translate',
      clippingAxis:       document.querySelector('.clip-axis-btn[data-axis].active')?.dataset.axis ?? 'z',
      clippingPosition:   S.clippingPosition ? S.clippingPosition.toArray() : null,
      clippingQuaternion: S.clippingQuaternion ? S.clippingQuaternion.toArray() : null,

      colorGrading: {
        exposure:    parseFloat(document.getElementById('cg-exposure')?.value    ?? 0),
        contrast:    parseFloat(document.getElementById('cg-contrast')?.value    ?? 0),
        saturation:  parseFloat(document.getElementById('cg-saturation')?.value  ?? 0),
        temperature: parseFloat(document.getElementById('cg-temperature')?.value ?? 0)
      }
    };

    const cameraState = {
      position:   S.camera.position.toArray(),
      target:     S.controls.target.toArray(),
      up:         S.camera.up.toArray(),
      projection: S.camera.isOrthographicCamera ? 'parallel' : 'perspective'
    };

    const measurements = S.completedMeasurements.map(m => {
      const saved = {
        id:   m.id,
        type: m.type || 'distance',
        p1:   [m.p1.x, m.p1.y, m.p1.z],
        p2:   [m.p2.x, m.p2.y, m.p2.z]
      };
      if (m.type === 'angle') {
        saved.center = [m.center.x, m.center.y, m.center.z];
        saved.angle = m.angle;
      } else {
        saved.dist = m.dist;
      }
      return saved;
    });

    const notes = (S.notes || []).map(n => ({
      id: n.id,
      position: n.position,           // already [x,y,z]
      text: n.text,
      color: n.color,
      createdAt: n.createdAt,
    }));

    const data = {
      version:             SCHEMA_VERSION,
      // Our output stays renderable by any viewer that understands schema 3
      // (unified geometry + annotations); schema 4 only added provenance.
      minViewerSchema:     MIN_VIEWER_SCHEMA,
      producer:            { name: 'byRhinoView.Viewer', version: APP_VERSION, host: navigator.userAgent },
      displayMode:         S.currentMode,
      settings,
      cameraState,
      customMaterials:     {},
      hiddenKeys:          [],
      namedViews:          getCustomViews(),
      rhinoNamedViews:     S.parsedNamedViews || [],
      parsedLayers:        S.parsedLayers || [],
      parsedAnnotations:   S.parsedAnnotations || [],
      completedMeasurements: measurements,
      notes,
      customHdrData:       S.customHdrData || null,
      customHdrName:       S.customHdrName || null
    };

    // Temporarily hide UI outlines and apply Rendered/Custom PBR materials during GLB export.
    // GLTFExporter runs with onlyVisible, so hiding is how these are excluded.
    S.currentModel.traverse(child => {
      if (['rhino-outline', 'selection-outline', 'ground-plane'].includes(child.name)) {
        if (child.visible) { toHide.push(child); child.visible = false; }
        return;
      }
      // Edges are kept only when they cannot be rebuilt from the exported GLB.
      // Exact ones — read from Brep/SubD topology, marked with role — have no
      // source in the file: the NURBS topology never makes it into a GLB, so
      // dropping them would silently downgrade every re-save to a dihedral
      // approximation. Dihedral edges are dropped, because reloading rebuilds
      // them identically from the same threshold and storing them would just
      // inflate the file. See docs/rhv-format.md §5.3d.
      if (child.name === 'rhino-edges') {
        if (child.userData?.role !== 'rhino-edges') {
          if (child.visible) { toHide.push(child); child.visible = false; }
        } else if (!child.visible) {
          // Exporting must not depend on whether the user has edges switched on:
          // onlyVisible would drop them from the file for good. Force them visible
          // for the export and let toReveal put them back.
          toReveal.push(child); child.visible = true;
        }
        return;
      }
      if (child.isMesh && child.userData.originalMaterial) {
        const key = getObjectKey(child);
        if (child.userData.customMaterial) data.customMaterials[key] = { ...child.userData.customMaterial };
        if (!child.visible) data.hiddenKeys.push(key);

        // Keep track of active material to restore later
        activeMaterials.set(child, child.material);

        // Temporarily apply Rendered-mode material (with custom overrides) so they get exported in GLB
        const base = child.userData.renderedMaterial || child.userData.originalMaterial;
        const m = base.clone();
        if (child.userData.materialColor) m.color.copy(child.userData.materialColor);
        if (m.metalness === undefined) m.metalness = 0.0;
        m.polygonOffset = true; m.polygonOffsetFactor = 1; m.polygonOffsetUnits = 1;
        m.envMap = null;
        m.envMapIntensity = 1.0;

        applyCustomToMaterial(m, child.userData.customMaterial);
        child.material = m;
      }
    });

    // Exclude annotations group from GLB export so they aren't baked as static outline-prone meshes
    annGroup = S.annotationGroup;
    annParent = annGroup?.parent;
    if (annGroup && annParent) {
      annParent.remove(annGroup);
    }

    // Tag textures with target MIME type (PNG/JPEG/WebP). GLTFExporter
    // honors texture.userData.mimeType when encoding the binary image.
    try {
      outerTextureMimeOriginals = tagTextureMimeTypes(S.currentModel);
    } catch (e) {
      console.warn('[Session Export] texture mime tagging failed, continuing:', e);
    }
    // Strip bulky userData (Rhino raw doc dump, cached Material clones) that
    // would otherwise balloon the glTF JSON chunk. Restored after export so
    // the live viewer keeps full state.
    try {
      outerUserDataRestore = stripExportUserData(S.currentModel);
    } catch (e) {
      console.warn('[Session Export] userData strip failed, continuing:', e);
    }

    const restoreSessionState = () => {
      // Restore mutations in reverse order of application.
      restoreExportUserData(outerUserDataRestore);
      restoreTextureMimeTypes(outerTextureMimeOriginals);
      // Restore annotations parent
      if (annGroup && annParent && !annGroup.parent) {
        annParent.add(annGroup);
      }
      // Restore meshes materials
      activeMaterials.forEach((mat, mesh) => {
        mesh.material = mat;
      });
      // Restore outlines visibility
      toHide.forEach(c => { c.visible = true; });
      toReveal.forEach(c => { c.visible = false; });
    };

    const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
    const exporter = new GLTFExporter();
    return await new Promise((resolve, reject) => {
      exporter.parse(
        S.currentModel,
        async (glbBuffer) => {
          try {
            restoreSessionState();

            // Serialize metadata to UTF-8
            const jsonStr = JSON.stringify(data);
            const jsonBytes = new TextEncoder().encode(jsonStr);

            // Binary Package Layout:
            // 1. Magic Bytes (4 bytes): "RV3D"
            // 2. Version (4 bytes): 1 (uint32)
            // 3. JSON Length (4 bytes): json length (uint32)
            // 4. JSON UTF-8 Payload (jsonBytes.byteLength bytes)
            // 5. GLB Binary Payload (glbBuffer.byteLength bytes)
            const totalLength = 4 + 4 + 4 + jsonBytes.byteLength + glbBuffer.byteLength;
            const combinedBuffer = new ArrayBuffer(totalLength);
            const view = new DataView(combinedBuffer);
            const uint8 = new Uint8Array(combinedBuffer);

            // Magic "RV3D" (0x52, 0x56, 0x33, 0x44)
            view.setUint8(0, 0x52);
            view.setUint8(1, 0x56);
            view.setUint8(2, 0x33);
            view.setUint8(3, 0x44);

            // containerVersion — the RV3D byte layout, not the JSON schema.
            view.setUint32(4, CONTAINER_VERSION, true);

            // JSON Length
            view.setUint32(8, jsonBytes.byteLength, true);

            // Copy JSON payload
            uint8.set(jsonBytes, 12);

            // Copy GLB binary payload (no extra compression — see comment block
            // above compressGlbWithDraco/Meshopt discussion in this file).
            uint8.set(new Uint8Array(glbBuffer), 12 + jsonBytes.byteLength);

            // Gzip the whole RV3D container. Loaders auto-detect compression via
            // the gzip magic (0x1f 0x8b).
            let finalBuffer = combinedBuffer;
            if (typeof CompressionStream === 'function') {
              try {
                const cs = new CompressionStream('gzip');
                const writer = cs.writable.getWriter();
                writer.write(new Uint8Array(combinedBuffer));
                writer.close();
                finalBuffer = await new Response(cs.readable).arrayBuffer();
              } catch (gzipErr) {
                console.warn('[Session Export] gzip failed, saving uncompressed:', gzipErr);
                finalBuffer = combinedBuffer;
              }
            }

            console.log('[Session Export] sizes (bytes):', {
              raw_glb: glbBuffer.byteLength,
              after_gzip: finalBuffer.byteLength,
            });

            let finalName = customFileName || S.currentFileName || 'scene';
            if (finalName.toLowerCase().endsWith('.rhv')) finalName = finalName.slice(0, -4);

            resolve({ finalBuffer, finalName });
          } catch (callbackErr) {
            console.error('[Session Export] Callback error:', callbackErr);
            reject(callbackErr);
          }
        },
        (err) => {
          restoreSessionState();
          console.error('[Session Export] GLB export failed:', err);
          reject(err);
        },
        { binary: true }
      );
    });
  } catch (err) {
    restoreExportUserData(outerUserDataRestore);
    restoreTextureMimeTypes(outerTextureMimeOriginals);
    if (annGroup && annParent && !annGroup.parent) {
      annParent.add(annGroup);
    }
    activeMaterials.forEach((mat, mesh) => {
      mesh.material = mat;
    });
    toHide.forEach(c => { c.visible = true; });
    toReveal.forEach(c => { c.visible = false; });
    console.error('[Session Export] error:', err);
    throw err;
  }
}

// ── Save session (.rhv) ───────────────────────────────────────────────────────
// Plain Save (pickLocation=false):
//   • opened a .rhv (with a writable handle) → overwrite that file in place
//   • opened another format (.3dm, …)        → native save dialog, opened in
//     the source file's folder with the same base name + .rhv
// Save As (pickLocation=true): always the native save dialog (in the source
// folder when known). Desktop Chromium only; elsewhere falls back to download.
export async function saveSession(customFileName = null, pickLocation = false) {
  if (!S.currentModel) {
    alert('No model loaded to save.');
    return;
  }
  const { showLoading, hideLoading, ensureWritePermission, writeBlobToHandle } = await import('./helpers.js');

  const isCapacitor = window.Capacitor && window.Capacitor.isPluginAvailable('FileOpener');
  const hasFSA = typeof window.showSaveFilePicker === 'function';
  let baseName = customFileName || S.currentFileName || 'scene';
  if (baseName.toLowerCase().endsWith('.rhv')) baseName = baseName.slice(0, -4);

  // Decide the write target FIRST, while the click gesture is still active
  // (showSaveFilePicker and requestPermission both require it).
  let writeHandle = null;   // FileSystemFileHandle to create/overwrite
  let useDownload = false;
  if (!isCapacitor) {
    const openedRhv = (!pickLocation && S.currentFileHandle && /\.rhv$/i.test(S.currentFileHandle.name || ''))
      ? S.currentFileHandle : null;
    if (openedRhv && await ensureWritePermission(openedRhv)) {
      writeHandle = openedRhv;                       // overwrite the opened .rhv
    } else if (hasFSA) {
      try {
        const opts = {
          suggestedName: baseName + '.rhv',
          types: [{ description: 'byRhinoView Session', accept: { 'application/octet-stream': ['.rhv'] } }],
        };
        if (S.currentFileHandle) opts.startIn = S.currentFileHandle; // same folder
        writeHandle = await window.showSaveFilePicker(opts);
      } catch (err) {
        if (err?.name === 'AbortError') return;       // user cancelled
        console.warn('[Save] showSaveFilePicker failed, downloading instead:', err);
        useDownload = true;
      }
    } else {
      useDownload = true;
    }
  }

  showLoading('Saving session file…');
  try {
    const { finalBuffer, finalName } = await buildSessionBuffer(customFileName);
    const blob = new Blob([finalBuffer], { type: 'application/octet-stream' });
    const fullFileName = finalName + '.rhv';
    const { setFileName } = await import('./helpers.js');

    if (isCapacitor) {
      const reader = new FileReader();
      reader.readAsDataURL(blob);
      reader.onloadend = async () => {
        try {
          await window.Capacitor.Plugins.FileOpener.saveFile({
            base64Data: reader.result,
            fileName: fullFileName,
            mimeType: 'application/octet-stream'
          });
          alert('Session saved to Downloads folder!');
        } catch (err) {
          console.error('[Capacitor Save] Failed to save session:', err);
          alert('Failed to save session: ' + err);
        }
      };
    } else if (writeHandle) {
      await writeBlobToHandle(writeHandle, blob);
      S.currentFileHandle = writeHandle;            // remember for the next Save
      setFileName(writeHandle.name || fullFileName); // reflect the saved name
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = fullFileName;
      a.click();
      URL.revokeObjectURL(a.href);
      if (customFileName) setFileName(finalName + '.rhv');
    }

    hideLoading();
  } catch (err) {
    console.error('[Session Export] error:', err);
    alert('Failed to save session file: ' + (err?.message || err));
    hideLoading();
  }
}

// ── Export self-contained HTML package ────────────────────────────────────────
// Embeds the gzip'd RV3D session buffer (base64) into the prebuilt offline
// viewer shell (viewer-shell.html, produced by build/build-shell.mjs). The
// result is one double-clickable .html with the model inside — no server, no
// internet, no install. Bootstrap in app.js auto-loads window.__RHV_PACKAGE__.
export async function exportPackage(customFileName = null, opts = {}) {
  if (!S.currentModel) {
    alert('No model loaded to export.');
    return;
  }
  const hideFileMenu = !!opts.hideFileMenu;
  const password     = (typeof opts.password === 'string' && opts.password.length) ? opts.password : null;

  const { showLoading, hideLoading, beginSave } = await import('./helpers.js');

  const isCapacitor = window.Capacitor && window.Capacitor.isPluginAvailable('FileOpener');
  let baseName = customFileName || S.currentFileName || 'scene';
  if (baseName.toLowerCase().endsWith('.rhv')) baseName = baseName.slice(0, -4);

  // Acquire the save location first, while the click gesture is still active.
  let sink = null;
  if (!isCapacitor) {
    sink = await beginSave({
      suggestedName: baseName + '.html',
      types: [{ description: 'HTML', accept: { 'text/html': ['.html'] } }],
    });
    if (!sink) return; // user cancelled
  }

  showLoading('Exporting HTML package…');
  try {
    // Fetch the offline shell first so we fail fast if it's missing.
    const shellResp = await fetch('./viewer-shell.html', { cache: 'no-store' });
    if (!shellResp.ok) {
      throw new Error('viewer-shell.html not found. Run `node build/build-shell.mjs` to generate it.');
    }
    let shell = await shellResp.text();

    const { finalBuffer, finalName } = await buildSessionBuffer(customFileName);

    // Build the inject string. With a password, encrypt the raw binary payload
    // with AES-GCM (key derived via PBKDF2). Without one, ship the plain base64.
    //
    // The base64 goes into an inert <script type="text/plain"> rather than a
    // JavaScript string literal, and a small script assigns it to the globals the
    // bootstrap in app.js reads. Measured on a 69 MB payload: as a literal the JS
    // parser spends ~1s tokenising it; as inert character data a textContent read
    // costs ~25ms. Nothing changes for the reader, so packages written either way
    // still open. Keep this in step with HtmlPackageWriter in the Rhino plugin —
    // docs/rhv-format.md §6 is the shared contract.
    //
    // Closing the shell's own <script id="rhv-package"> is safe: the HTML parser
    // ends a script element at the first "</script", and base64 contains no '<'.
    const PAYLOAD_ID = 'rhv-payload';
    let inject = '';
    if (password) {
      const enc = await _encryptBinary(new Uint8Array(finalBuffer), password);
      // Salt and IV are a handful of bytes and stay inline; only the ciphertext is
      // worth keeping out of the parser's way.
      inject =
        `</script><script id="${PAYLOAD_ID}" type="text/plain">${enc.data}</script>` +
        `<script>var _p=document.getElementById(${JSON.stringify(PAYLOAD_ID)}).textContent;` +
        `window.__RHV_PACKAGE_ENCRYPTED__={v:${JSON.stringify(enc.v ?? 1)},` +
        `salt:${JSON.stringify(enc.salt)},iv:${JSON.stringify(enc.iv)},data:_p};` +
        `window.__RHV_PACKAGE_NAME__=${JSON.stringify(finalName + '.rhv')};`;
    } else {
      const b64 = arrayBufferToBase64(finalBuffer);
      inject =
        `</script><script id="${PAYLOAD_ID}" type="text/plain">${b64}</script>` +
        `<script>var _p=document.getElementById(${JSON.stringify(PAYLOAD_ID)}).textContent;` +
        `window.__RHV_PACKAGE__=_p;` +
        `window.__RHV_PACKAGE_NAME__=${JSON.stringify(finalName + '.rhv')};`;
    }
    if (hideFileMenu) {
      inject += `window.__RHV_HIDE_FILE__=true;`;
    }

    // Function replacements: a string replacement would interpret "$&"/"$'"/…
    // patterns, and the base64 payload / file name could contain them.
    if (shell.includes('/*__RHV_PACKAGE__*/')) {
      shell = shell.replace('/*__RHV_PACKAGE__*/', () => inject);
    } else {
      // Fallback for shells without the placeholder: inject before the bundle.
      shell = shell.replace('<script type="module" id="app-bundle">', () => `<script>${inject}</script>\n<script type="module" id="app-bundle">`);
    }

    const blob = new Blob([shell], { type: 'text/html' });
    const fullFileName = finalName + '.html';

    if (isCapacitor) {
      const reader = new FileReader();
      reader.readAsDataURL(blob);
      reader.onloadend = async () => {
        try {
          await window.Capacitor.Plugins.FileOpener.saveFile({
            base64Data: reader.result,
            fileName: fullFileName,
            mimeType: 'text/html'
          });
          alert('HTML package saved to Downloads folder!');
        } catch (err) {
          console.error('[Capacitor Save] Failed to save package:', err);
          alert('Failed to save package: ' + err);
        }
      };
    } else {
      await sink(blob);
    }
    hideLoading();
  } catch (err) {
    console.error('[Export Package] error:', err);
    alert('Failed to export HTML package: ' + (err?.message || err));
    hideLoading();
  }
}

// Base64-encode an ArrayBuffer in chunks (avoids call-stack overflow on large
// buffers passed to String.fromCharCode).
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// AES-GCM encrypt a binary payload with a key derived from `password` via
// PBKDF2-SHA256 (200k iterations). Returns { salt, iv, data } all base64.
// Decrypt in app.js bootstrap via the same parameters.
async function _encryptBinary(uint8, password) {
  const enc  = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv   = crypto.getRandomValues(new Uint8Array(12));
  const baseKey = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']
  );
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 200000, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, uint8);
  return {
    v:    1,
    salt: arrayBufferToBase64(salt),
    iv:   arrayBufferToBase64(iv),
    data: arrayBufferToBase64(new Uint8Array(cipher)),
  };
}

// ── Load session ─────────────────────────────────────────────────────────────

export async function loadSession(file, fileHandle = null) {
  // Record (or clear) the writable handle for this open — only FSA opens pass
  // one. Lets a plain Save overwrite the opened .rhv in place.
  S.currentFileHandle = fileHandle || null;

  const { showLoading, hideLoading } = await import('./helpers.js');
  showLoading('Loading session file…');

  // Suppress history recording for the duration of restore — dispatched
  // input/change events during settings playback would otherwise fill the
  // undo stack with the entire session reload, drowning the user's history.
  History.suppress = true;
  try {
    let arrayBuffer = await file.arrayBuffer();

    // Auto-detect gzip wrapper (magic 0x1f 0x8b). .rhv files are gzip-wrapped
    // around the RV3D container for a 3–5× size reduction.
    if (arrayBuffer.byteLength >= 2) {
      const head = new Uint8Array(arrayBuffer, 0, 2);
      if (head[0] === 0x1f && head[1] === 0x8b && typeof DecompressionStream === 'function') {
        try {
          const ds = new DecompressionStream('gzip');
          const writer = ds.writable.getWriter();
          writer.write(new Uint8Array(arrayBuffer));
          writer.close();
          arrayBuffer = await new Response(ds.readable).arrayBuffer();
        } catch (gunzipErr) {
          console.warn('[Session Load] gunzip failed, treating as raw:', gunzipErr);
        }
      }
    }

    const view = new DataView(arrayBuffer);

    // Check magic bytes
    let isBinaryPackage = false;
    if (arrayBuffer.byteLength >= 12) {
      const magic0 = view.getUint8(0);
      const magic1 = view.getUint8(1);
      const magic2 = view.getUint8(2);
      const magic3 = view.getUint8(3);
      if (magic0 === 0x52 && magic1 === 0x56 && magic2 === 0x33 && magic3 === 0x44) {
        isBinaryPackage = true;
      }
    }

    let data;
    let glbBuffer = null;

    if (isBinaryPackage) {
      const containerVersion = view.getUint32(4, true);
      const jsonLength = view.getUint32(8, true);

      // A newer container layout is unreadable — we would not know where the
      // fields sit. Fail loudly rather than parsing garbage. See
      // docs/rhv-format.md §1.
      if (containerVersion > CONTAINER_VERSION) {
        throw versionError(t('msg.rhv_newer_container')
          .replace('{found}', containerVersion)
          .replace('{supported}', CONTAINER_VERSION));
      }

      const jsonBytes = new Uint8Array(arrayBuffer, 12, jsonLength);
      const jsonStr = new TextDecoder().decode(jsonBytes);
      data = JSON.parse(jsonStr);

      // Schema gating (docs/rhv-format.md §2). minViewerSchema is what the
      // producer says we must understand to render the file *correctly*; a
      // higher data.version alone only means there are fields we will ignore.
      const minSchema = typeof data.minViewerSchema === 'number'
        ? data.minViewerSchema : LEGACY_MIN_SCHEMA;
      if (minSchema > SCHEMA_VERSION) {
        throw versionError(t('msg.rhv_newer_schema')
          .replace('{found}', minSchema)
          .replace('{supported}', SCHEMA_VERSION));
      }
      if (typeof data.version === 'number' && data.version > SCHEMA_VERSION) {
        console.warn(`[Session Load] file schema v${data.version} is newer than this viewer (v${SCHEMA_VERSION}); unknown settings ignored.`);
        showToast(t('msg.rhv_newer_minor'));
      }
      if (data.producer?.name) {
        console.info(`[Session Load] producer: ${data.producer.name} ${data.producer.version || ''} (${data.producer.host || 'unknown host'})`);
      }

      // Restore parsedLayers early so that postProcessModel (called inside loadGeometryFromGLB)
      // can resolve the correct layer colors for shadedMaterial and other color checks.
      if (data.parsedLayers) {
        S.parsedLayers = data.parsedLayers;
      }
      // Restore modelUnit early too — showModelInfo() runs inside
      // loadGeometryFromGLB and reads S.modelUnit to populate the File Info
      // panel. Without this it would show "Unknown" on every reload.
      if (data.settings?.modelUnit) {
        S.modelUnit = data.settings.modelUnit;
      }

      const glbStart = 12 + jsonLength;
      glbBuffer = arrayBuffer.slice(glbStart);

      // 1. Load the packed geometry first
      const { loadGeometryFromGLB } = await import('./loaders.js');
      await loadGeometryFromGLB(glbBuffer, file.name, glbBuffer.byteLength);
    } else {
      // Legacy JSON-only session file
      resetSettingsToDefault();
      const text = new TextDecoder().decode(new Uint8Array(arrayBuffer));
      data = JSON.parse(text);
    }

    // 1.5. Restore custom HDR if embedded
    if (data.customHdrData) {
      S.customHdrData = data.customHdrData;
      S.customHdrName = data.customHdrName || 'Custom HDR';
      
      try {
        const isExr = /\.exr$/i.test(S.customHdrName || '');
        const Loader = isExr
          ? (await import('three/addons/loaders/EXRLoader.js')).EXRLoader
          : (await import('three/addons/loaders/RGBELoader.js')).RGBELoader;
        const res = await fetch("data:application/octet-stream;base64," + data.customHdrData);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);

        await new Promise((resolve, reject) => {
          const loader = new Loader();
          const pmrem = new THREE.PMREMGenerator(S.renderer);
          pmrem.compileEquirectangularShader();

          loader.load(url, texture => {
            URL.revokeObjectURL(url);
            const envTexture = pmrem.fromEquirectangular(texture).texture;
            texture.dispose();
            pmrem.dispose();
            
            if (S.envMaps['hdr-custom']) S.envMaps['hdr-custom'].dispose();
            S.envMaps['hdr-custom'] = envTexture;
            
            // Enable the custom-HDR option and select it
            const hdrOpt = document.getElementById('opt-hdr-custom');
            if (hdrOpt) { 
              hdrOpt.disabled = false; 
              hdrOpt.textContent = S.customHdrName; 
            }
            resolve();
          }, undefined, reject);
        });
      } catch (hdrErr) {
        console.error('[Session Import] Failed to restore custom HDR:', hdrErr);
      }
    }

    // 2. Restore settings
    if (data.settings) {
      const s = data.settings;

      S.currentMode    = s.displayMode    || 'shaded';
      S.shadowsEnabled = s.shadowsEnabled ?? true;
      S.groundEnabled  = s.groundEnabled  ?? false;
      S.modelUnit      = s.modelUnit       || 'Unknown';

      const setCheck = (id, val) => {
        const el = document.getElementById(id);
        if (el) { el.checked = val; el.dispatchEvent(new Event('change')); }
      };

      // Geometry has already been post-processed at this point. If it was heavy
      // enough that edges were deferred, restoring edgeOverlay:true here would
      // dispatch 'change' and rebuild every edge — paying the exact cost the
      // deferral avoided. Leave it off and let the user opt in.
      if (!S.edgesDeferred) setCheck('chk-edges-panel', s.edgeOverlay ?? true);
      setCheck('chk-annotations-panel', s.annotationsEnabled ?? true);
      setCheck('chk-ground-panel',      S.groundEnabled);
      setCheck('chk-shadows-panel',     S.shadowsEnabled);
      setCheck('chk-sun-panel',         s.sunLightEnabled   ?? false);

      const setSlider = (id, valElId, val, formatType = 'float') => {
        const el = document.getElementById(id);
        if (el && val !== undefined) {
          el.value = val;
          updateSliderFill(el);
          const valEl = document.getElementById(valElId);
          if (valEl) {
            if (formatType === 'percent') valEl.textContent = Math.round(val * 100) + '%';
            else if (formatType === 'degree') valEl.textContent = Math.round(val) + '°';
            else if (formatType === 'mm') valEl.textContent = Math.round(val) + 'mm';
            else if (formatType === 'xScale') valEl.textContent = parseFloat(val).toFixed(1) + 'x';
            else valEl.textContent = parseFloat(val).toFixed(2);
          }
          el.dispatchEvent(new Event('input'));
        }
      };

      // Restore env preset
      if (s.envPreset) {
        const envSel = document.getElementById('env-preset-select');
        if (envSel) {
          const hasPreset = S.envMaps && S.envMaps[s.envPreset];
          if (hasPreset) {
            envSel.value = s.envPreset;
          } else {
            console.warn(`[Session Import] Environment preset '${s.envPreset}' is not loaded. Falling back to default 'studio'.`);
            envSel.value = 'studio';
          }
          envSel.dispatchEvent(new Event('change'));
        }
      }
      setSlider('sl-env-intensity', 'sl-env-intensity-val', s.envIntensity ?? 1.0, 'float');
      setSlider('sl-measure-scale', 'sl-measure-scale-val', s.measurementScale ?? s.annotationScale ?? 1.0, 'xScale');
      setSlider('sl-annotation-scale', 'sl-annotation-scale-val', s.annotationScale ?? 1.0, 'xScale');
      setSlider('sl-hdr-rotation', 'sl-hdr-rotation-val', s.hdrRotation ?? 0, 'degree');
      setSlider('sl-ambient-panel', 'sl-ambient-val',     s.ambientIntensity, 'float');
      setSlider('sl-ao-intensity',  'sl-ao-intensity-val', s.aoIntensity ?? (S.modeSettings[S.currentMode]?.aoIntensity ?? 0.40), 'float');
      setSlider('sl-sun-intensity', 'sl-sun-intensity-val', s.sunIntensity ?? 1.8, 'float');
      setSlider('sl-sun-azimuth',   'sl-sun-azimuth-val', s.sunAzimuth,       'degree');
      setSlider('sl-sun-elevation', 'sl-sun-elevation-val', s.sunElevation,   'degree');
      if (s.cameraLens !== undefined) {
        setSlider('sl-camera-fov',    'sl-camera-fov-val',  s.cameraLens,       'mm');
      } else if (s.cameraFov !== undefined) {
        const aspect = window.innerWidth / window.innerHeight;
        const vFovRad = (s.cameraFov * Math.PI) / 360;
        const lens = 18 / (aspect * Math.tan(vFovRad));
        setSlider('sl-camera-fov',    'sl-camera-fov-val',  Math.round(lens),   'mm');
      }
      setSlider('sl-damping-panel', 'sl-damping-val',     s.dampingFactor,    'float');

      if (s.edgeThresholdAngle !== undefined) {
        S.edgeThresholdAngle = s.edgeThresholdAngle;
      }
      setSlider('sl-edge-angle', 'sl-edge-angle-val', S.edgeThresholdAngle ?? 30, 'degree');
      // Exact edges filter in the shader off a uniform, which the slider's own
      // events would normally set. Restoring a session moves neither, so the
      // saved threshold has to be pushed through by hand or the file opens
      // showing every edge regardless of what was saved.
      (await import('./display.js')).setEdgeAngleUniform(S.edgeThresholdAngle ?? 30);

      const bgSel = document.getElementById('bg-type-select');
      if (bgSel && s.bgType) bgSel.value = s.bgType;

      const setBgColor = (id, swatchId, val) => {
        const el = document.getElementById(id);
        if (el && val !== undefined) {
          el.value = val;
          const swatch = document.getElementById(swatchId);
          if (swatch) swatch.style.background = val;
          const wrapper = el.parentNode;
          if (wrapper && wrapper.classList.contains('clr-field')) {
            wrapper.style.color = val;
            const btn = wrapper.querySelector('button');
            if (btn) btn.style.backgroundColor = val;
          }
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      };

      setBgColor('bg-panel-c1', 'bg-panel-swatch-c1', s.bgC1);
      setBgColor('bg-panel-c2', 'bg-panel-swatch-c2', s.bgC2);
      setBgColor('bg-panel-c3', 'bg-panel-swatch-c3', s.bgC3);
      setBgColor('bg-panel-c4', 'bg-panel-swatch-c4', s.bgC4);
      setSlider('bg-radial-spread', 'bg-radial-spread-val', s.bgRadialSpread, 'percent');

      if (bgSel) bgSel.dispatchEvent(new Event('change'));

      // Restore Clipping Plane
      if (s.clippingEnabled !== undefined) {
        S.clippingToggleOn = s.clippingEnabled;
        setSlider('clip-height', 'clip-height-val', s.clippingHeight ?? 0, 'float');
        
        const cp = document.getElementById('clipping-panel');
        if (cp) {
          cp.dataset.rotX = s.clippingRotX ?? 0;
          cp.dataset.rotY = s.clippingRotY ?? 180;
        }

        // Mode (translate / rotate)
        if (s.clippingMode) {
          document.querySelectorAll('.clip-axis-btn[data-clip-mode]').forEach(b => {
            b.classList.toggle('active', b.dataset.clipMode === s.clippingMode);
          });
          if (S.clippingTransformControls) S.clippingTransformControls.setMode(s.clippingMode);
        }

        // Axis (x / y / z)
        if (s.clippingAxis) {
          document.querySelectorAll('.clip-axis-btn[data-axis]').forEach(b => {
            b.classList.toggle('active', b.dataset.axis === s.clippingAxis);
          });
        }

        // Restore manual position and rotation
        if (s.clippingPosition) {
          S.clippingPosition = new THREE.Vector3().fromArray(s.clippingPosition);
        } else {
          S.clippingPosition = null;
        }
        if (s.clippingQuaternion) {
          S.clippingQuaternion = new THREE.Quaternion().fromArray(s.clippingQuaternion);
        } else {
          S.clippingQuaternion = null;
        }
        
        const { updateClippingPlane, setupClippingHelper } = await import('./tools.js');
        const { t } = await import('./i18n.js');
        
        updateClippingPlane();
        S.clippingHasBeenInitialized = true;

        const toggleBtn = document.getElementById('btn-clip-toggle');
        if (toggleBtn) {
          toggleBtn.classList.toggle('active', s.clippingEnabled);
          toggleBtn.textContent = s.clippingEnabled ? t('clip.on') : t('clip.off');
        }

        S.clippingEnabled = s.clippingEnabled;
        if (s.clippingEnabled) {
          S.renderer.clippingPlanes = [S.clippingPlane];
          setupClippingHelper();
          document.getElementById('clipping-panel')?.classList.remove('hidden');
          document.getElementById('btn-tool-clipping')?.classList.add('active');
        } else {
          S.renderer.clippingPlanes = [];
          if (window.deactivateClippingHelper) {
            window.deactivateClippingHelper();
          }
          document.getElementById('clipping-panel')?.classList.add('hidden');
          document.getElementById('btn-tool-clipping')?.classList.remove('active');
        }
      }

      if (s.colorGrading) {
        const cg = s.colorGrading;
        const setCgSlider = (id, val) => {
          const el = document.getElementById(id);
          if (el && val !== undefined) {
            el.value = val;
            updateSliderFill(el);
            const valEl = document.getElementById(id + '-val');
            if (valEl) valEl.textContent = (val >= 0 ? '+' : '') + parseFloat(val).toFixed(2);
            el.dispatchEvent(new Event('input'));
          }
        };
        setCgSlider('cg-exposure',    cg.exposure);
        setCgSlider('cg-contrast',    cg.contrast);
        setCgSlider('cg-saturation',  cg.saturation);
        setCgSlider('cg-temperature', cg.temperature);
      }
    } else {
      if (data.displayMode) S.currentMode = data.displayMode;
    }

    // 3. Restore CAD layers
    if (data.parsedLayers) {
      S.parsedLayers = data.parsedLayers;
      const { renderLayerUI, updateLayerVisibility } = await import('./layers.js');
      renderLayerUI();
      updateLayerVisibility();
    }

    // 4. Restore Rhino named views
    if (data.rhinoNamedViews) {
      S.parsedNamedViews = data.rhinoNamedViews;
    }

    // 5. Restore custom named views
    if (data.namedViews) {
      const base = file.name.replace(/\.[^.]+$/, '');
      try {
        localStorage.setItem(`rhino_custom_views_${base}`, JSON.stringify(data.namedViews));
      } catch (e) {
        console.warn('Failed to save session views to localStorage:', e);
      }
      const { renderNamedViewsUI } = await import('./camera.js');
      renderNamedViewsUI();
    }

    // 6. Restore hidden items and custom materials
    if (S.currentModel) {
      S.currentModel.traverse(child => {
        if (!child.isMesh || !child.userData.originalMaterial) return;
        if (['rhino-outline', 'rhino-edges', 'selection-outline'].includes(child.name)) return;
        const key = getObjectKey(child);
        if (data.hiddenKeys?.includes(key)) {
          child.visible = false;
          S.hiddenObjects.add(child);
        } else {
          child.visible = true;
        }
        if (data.customMaterials?.[key]) {
          child.userData.customMaterial = { ...data.customMaterials[key] };
          if (child.userData.customMaterial.mapTexture !== null && child.userData.customMaterial.mapTexture !== undefined) {
            const orig = child.userData.renderedMaterial || child.userData.originalMaterial;
            if (orig && orig.map) {
              child.userData.customMaterial.mapTexture = orig.map;
            } else {
              child.userData.customMaterial.mapTexture = null;
            }
          }
        } else {
          delete child.userData.customMaterial;
        }
      });
    }

    // 7. Restore completed measurements
    if (data.completedMeasurements) {
      const { reconstructMeasurements } = await import('./tools.js');
      reconstructMeasurements(data.completedMeasurements);
    }

    // 7.5. Restore notes (pin markers placed by the user)
    if (data.notes && data.notes.length) {
      const notes = await import('./notes.js');
      const ui    = await import('./notes-ui.js');
      // Clear any stale notes first (defensive — session usually starts blank)
      notes.clearAllNotes();
      for (const n of data.notes) {
        const pos = new THREE.Vector3(n.position[0], n.position[1], n.position[2]);
        const created = notes.createNote(pos, n.text, n.color);
        // Preserve original id + createdAt instead of the new ones createNote
        // generated so list ordering and bubble-active references survive.
        created.id        = n.id;
        created.createdAt = n.createdAt || created.createdAt;
      }
      ui.renderNoteListUI();
    } else {
      // Still call the UI render so the empty-state row shows up cleanly.
      try {
        const ui = await import('./notes-ui.js');
        ui.renderNoteListUI();
      } catch (_) {}
    }

    // 8. Restore camera state
    if (data.cameraState) {
      const cs = data.cameraState;
      const pos = new THREE.Vector3(...cs.position);
      const tgt = new THREE.Vector3(...cs.target);
      const up  = new THREE.Vector3(...cs.up);

      S.perspCamera.position.copy(pos);
      S.controls.target.copy(tgt);
      S.perspCamera.up.copy(up);
      S.perspCamera.updateProjectionMatrix();

      if (S.orthoCamera) {
        S.orthoCamera.position.copy(pos);
        S.orthoCamera.up.copy(up);
        S.orthoCamera.updateProjectionMatrix();
      }

      if (cs.projection === 'parallel') {
        const { switchToOrtho } = await import('./camera.js');
        switchToOrtho();
      } else {
        const { switchToPersp } = await import('./camera.js');
        switchToPersp();
      }

      S.controls.update();
    }

    // 8.5. Restore annotations
    if (data.parsedAnnotations) {
      S.parsedAnnotations = data.parsedAnnotations;
      const { createAnnotationSprites } = await import('./annotations.js');
      await createAnnotationSprites();
    }

    // Sync display mode dropdown UI
    const dropdown = document.getElementById('mode-dropdown');
    if (dropdown) {
      const activeItem = dropdown.querySelector(`.dropdown-item[data-mode="${S.currentMode}"]`);
      if (activeItem) {
        dropdown.querySelectorAll('.dropdown-item').forEach(b => b.classList.toggle('active', b === activeItem));
        const triggerBtn = document.getElementById('btn-mode-dropdown');
        if (triggerBtn) {
          const label = activeItem.querySelector('span').textContent.split(' ')[0];
          const triggerLabel = triggerBtn.querySelector('span');
          if (triggerLabel) triggerLabel.textContent = label;
          triggerBtn.title = `Display Mode (${label})`;
          const svg = activeItem.querySelector('svg').cloneNode(true);
          const oldSvg = triggerBtn.querySelector('svg');
          if (oldSvg) triggerBtn.replaceChild(svg, oldSvg);
        }
      }
    }

    // Sync AO Intensity slider row visibility
    const slAoInt = document.getElementById('sl-ao-intensity');
    const aoSliderRow = slAoInt?.closest('.slider-row');
    const settings = S.modeSettings[S.currentMode];
    if (settings && settings.aoIntensity !== undefined) {
      if (aoSliderRow) aoSliderRow.classList.remove('hidden');
    } else {
      if (aoSliderRow) aoSliderRow.classList.add('hidden');
    }

    applyDisplayMode();
    hideLoading();
  } catch (e) {
    console.error('Session load failed', e);
    // Version-gate rejections (docs/rhv-format.md §2) already carry a message
    // that tells the user what to do about it; a generic "failed to load" would
    // throw that away and read as a corrupt file.
    alert(e?.rhvVersionError ? e.message : t('msg.load_session_failed'));
    hideLoading();
  } finally {
    History.suppress = false;
    // Drop anything that snuck in via History.clear in clearCurrentModel;
    // the restored session represents a fresh starting point for undo/redo.
    History.clear();
  }
}

// ── Reset settings to defaults ───────────────────────────────────────────────
// Imported by both loadSession (above) and handleFile (in loaders.js).

export function resetSettingsToDefault() {
  S.currentMode    = 'shaded';
  S.shadowsEnabled = true;
  S.groundEnabled  = false;
  S.selectedObjects = [];
  S.hiddenObjects.clear();

  // Reset per-mode visibility settings
  S.modeSettings = {
    wireframe: { edges: true, curves: true, ground: false, shadows: false, annotations: true },
    shaded: { edges: true, curves: true, ground: false, shadows: true, annotations: true },
    arctic: { edges: false, curves: false, ground: true, shadows: true, annotations: true, aoIntensity: 0.70 },
    rendered: { edges: false, curves: false, ground: true, shadows: true, annotations: true, aoIntensity: 0.40 },
    technical: { edges: true, curves: true, ground: false, shadows: false, annotations: true }
  };

  // Clear custom HDR state
  S.customHdrData = null;
  S.customHdrName = null;
  const hdrOpt = document.getElementById('opt-hdr-custom');
  if (hdrOpt) {
    hdrOpt.disabled = true;
    hdrOpt.textContent = 'No Custom HDR';
  }

  // Clear measurements (deferred import to avoid loading tools.js at module parse time)
  import('./tools.js').then(m => m.clearMeasurements()).catch(() => {});

  // Clear selection outlines
  import('./selection.js').then(m => m.clearSelection()).catch(() => {});

  document.querySelectorAll('#mode-dropdown .dropdown-item').forEach(b => {
    b.classList.toggle('active', b.dataset.mode === 'shaded');
  });

  const setCheck = (id, val) => {
    const el = document.getElementById(id);
    if (el) { el.checked = val; el.dispatchEvent(new Event('change')); }
  };

  setCheck('chk-edges-panel',     true);
  setCheck('chk-annotations-panel', true);
  setCheck('chk-ground-panel',    false);
  setCheck('chk-shadows-panel',   true);
  setCheck('chk-sun-panel',       false);

  S.clippingToggleOn = false;
  S.clippingHasBeenInitialized = false;
  S.clippingEnabled = false;
  S.clippingPosition = null;
  S.clippingQuaternion = null;
  if (S.renderer) S.renderer.clippingPlanes = [];
  if (window.deactivateClippingHelper) window.deactivateClippingHelper();
  document.getElementById('clipping-panel')?.classList.add('hidden');
  document.getElementById('btn-tool-clipping')?.classList.remove('active');
  const toggleBtn = document.getElementById('btn-clip-toggle');
  if (toggleBtn) {
    toggleBtn.classList.remove('active');
    toggleBtn.textContent = 'Off';
  }

  const resetSlider = (id, valElId, val, formatType = 'float') => {
    const el = document.getElementById(id);
    if (el) {
      el.value = val;
      updateSliderFill(el);
      const valEl = document.getElementById(valElId);
      if (valEl) {
        if (formatType === 'percent') valEl.textContent = Math.round(val * 100) + '%';
        else if (formatType === 'degree') valEl.textContent = Math.round(val) + '°';
        else if (formatType === 'mm') valEl.textContent = Math.round(val) + 'mm';
        else if (formatType === 'xScale') valEl.textContent = parseFloat(val).toFixed(1) + 'x';
        else valEl.textContent = parseFloat(val).toFixed(2);
      }
      el.dispatchEvent(new Event('input'));
    }
  };

  resetSlider('sl-env-intensity', 'sl-env-intensity-val', 1.00,  'float');
  resetSlider('sl-measure-scale', 'sl-measure-scale-val', 1.0,  'xScale');
  resetSlider('sl-annotation-scale', 'sl-annotation-scale-val', 1.0, 'xScale');
  resetSlider('sl-hdr-rotation', 'sl-hdr-rotation-val', 59,    'degree');
  resetSlider('sl-ambient-panel', 'sl-ambient-val',       0.55,  'float');
  resetSlider('sl-sun-intensity', 'sl-sun-intensity-val', 1.8,  'float');
  resetSlider('sl-sun-azimuth',   'sl-sun-azimuth-val',   135,  'degree');
  resetSlider('sl-sun-elevation', 'sl-sun-elevation-val', 45,   'degree');
  resetSlider('sl-camera-fov',    'sl-camera-fov-val',    50,   'mm');
  resetSlider('sl-damping-panel', 'sl-damping-val',       0.5,  'float');
  resetSlider('bg-radial-spread', 'bg-radial-spread-val', 0.5,  'percent');
  resetSlider('sl-edge-angle',    'sl-edge-angle-val',    30,   'degree');
  S.edgeThresholdAngle = 30;
  import('./display.js').then(m => m.setEdgeAngleUniform(30));

  const ttToggleBtn = document.getElementById('btn-tt-toggle');
  if (ttToggleBtn?.classList.contains('active')) ttToggleBtn.click();
  const springSlider = document.getElementById('tt-spring-slider');
  if (springSlider) {
    springSlider.value = 0;
    updateSliderFill(springSlider);
    const springVal = document.getElementById('tt-spring-val');
    if (springVal) springVal.textContent = '0.0';
  }

  document.getElementById('btn-cg-reset')?.click();

  const isDark = isPageVisuallyDark();

  const defaultBg  = isDark ? '#24252a' : '#ffffff';
  const defaultBg2 = isDark ? '#1c1d22' : '#f3f4f6';
  const defaultBg3 = isDark ? '#1e293b' : '#e5e7eb';
  const defaultBg4 = isDark ? '#0f172a' : '#d1d5db';

  const resetBgColor = (id, swatchId, val) => {
    const el = document.getElementById(id);
    if (el) {
      el.value = val;
      const swatch = document.getElementById(swatchId);
      if (swatch) swatch.style.background = val;
      const wrapper = el.parentNode;
      if (wrapper && wrapper.classList.contains('clr-field')) {
        wrapper.style.color = val;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  };
  resetBgColor('bg-panel-c1', 'bg-panel-swatch-c1', defaultBg);
  resetBgColor('bg-panel-c2', 'bg-panel-swatch-c2', defaultBg2);
  resetBgColor('bg-panel-c3', 'bg-panel-swatch-c3', defaultBg3);
  resetBgColor('bg-panel-c4', 'bg-panel-swatch-c4', defaultBg4);

  const bgSel = document.getElementById('bg-type-select');
  if (bgSel) { bgSel.value = 'solid'; bgSel.dispatchEvent(new Event('change')); }

  switchToPersp();
}
