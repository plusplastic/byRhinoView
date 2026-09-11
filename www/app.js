import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Rhino3dmLoader } from 'three/addons/loaders/3DMLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { initI18n, setLang, applyI18n, t, currentLang } from './i18n.js';

import { S } from './state.js';
import { updateSliderFill, updateAllSliderFills, updateSelectIcon, showLoading, hideLoading, bindSliderDblClickInput, beginSave } from './helpers.js';
import { setupLights, updateSunLight, updateShadowCasting, addGroundPlane, removeGroundPlane, computeVisibleBoundingBox } from './lighting.js';
import { switchToOrtho, switchToPersp, switchToTwoPoint, apply2PointConstraints, installTwoPointDragHandler, setViewPreset, setWalkthroughMode, triggerCameraTransition, fitCameraToBox, fitCameraToObject, fitCameraToSelected, saveCustomView, renderNamedViewsUI, updateAdaptiveClipping } from './camera.js';
import { applySceneBackground, applyFileBackground, applyDisplayMode, applyLayerColorsToModel, recreateAllEdges, setEdgeAngleUniform } from './display.js';
import { renderLayerUI, updateLayerVisibility } from './layers.js';
import { createAnnotationSprites } from './annotations.js';
import { saveSession, loadSession, exportPackage } from './session.js';
import { handleFile, clearCurrentModel } from './loaders.js';
import * as GoogleDrive from './cloud/google-drive.js';
import * as OneDrive from './cloud/onedrive.js';
import * as Dropbox from './cloud/dropbox.js';
import { History } from './history.js';
import {
  deactivateAllTools, clearMeasurements, renderMeasurementListUI,
  spawnAngleWidget, handleWidgetPointerDown, handleWidgetPointerMove,
  handleWidgetPointerUp, updateTempDistanceLine, updateDistanceGhost,
  updateTempAngleWidget, updateAngleGhost,
  syncMeasurementTabsUI,
  onCanvasClick, updateClippingPlane, setupClippingHelper, updateClippingHelperPose,
  cancelCurrentInProgressMeasurement, updateMeasurementScales,
  rebuildClippingGrid, applyClipWidgetVisibility
} from './tools.js';
import { initPenInput } from './pen-input.js';
import { onPointerDown, clearSelection, updatePropertiesPanel, addSelectionOutline, setupGumballHelper, clearGumballHelper, ensureOriginalTransform } from './selection.js';
import { buildClippingCap, destroyClippingCap, setClippingCapEnabled, setClippingCapColor, updateClippingCapPose } from './clip-cap.js';

// Notes UI is loaded lazily so the rest of the app boots even if the user
// never opens a note. The animate loop reads the populated reference.
let _notesUiUpdateBubble = null;
let _notesUiPickMarker   = null;
import('./notes-ui.js').then(m => {
  _notesUiUpdateBubble = m.updateBubblePosition;
  _notesUiPickMarker   = m.pickNoteMarker;
});

// ── Color Grading Shader ───────────────────────────────────────────────────
const ColorGradingShader = {
  uniforms: {
    tDiffuse:     { value: null },
    uExposure:    { value: 0.0 },
    uContrast:    { value: 0.0 },
    uSaturation:  { value: 0.0 },
    uTemperature: { value: 0.0 }
  },
  vertexShader: `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uExposure;
    uniform float uContrast;
    uniform float uSaturation;
    uniform float uTemperature;
    varying vec2 vUv;
    void main() {
      vec4 tex = texture2D(tDiffuse, vUv);
      vec3 c = tex.rgb;
      c *= pow(2.0, uExposure);
      c = (c - 0.5) * (1.0 + uContrast) + 0.5;
      float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(lum), c, 1.0 + uSaturation);
      c.r += uTemperature * 0.15;
      c.g += uTemperature * 0.03;
      c.b -= uTemperature * 0.15;
      // Only clamp NEGATIVE values; preserve HDR (>1.0) so subsequent
      // tone mapping in OutputPass works correctly. Clamping to [0,1] here
      // would clip HDR values like scene.backgroundIntensity above 1.
      gl_FragColor = vec4(max(c, vec3(0.0)), tex.a);
    }
  `
};

// ── BVH acceleration ───────────────────────────────────────────────────────
import('three-mesh-bvh').then(mod => {
  THREE.Mesh.prototype.raycast = mod.acceleratedRaycast;
  THREE.BufferGeometry.prototype.computeBoundsTree = mod.computeBoundsTree;
  THREE.BufferGeometry.prototype.disposeBoundsTree = mod.disposeBoundsTree;
  S.bvhReady = true;
}).catch(() => console.warn('three-mesh-bvh not loaded'));

window.addEventListener('error', e => {
  console.error('Uncaught:', e.message, e.filename, e.lineno);
});

window.addEventListener('unhandledrejection', e => {
  console.error('Unhandled Rejection:', e.reason);
});

// ── rhino3dm init ──────────────────────────────────────────────────────────
if (window.rhino3dm) {
  // Self-hosted WASM (same-origin) — no CDN cross-origin fetch, so no CORS
  // preflight. locateFile resolves rhino3dm.wasm next to the local .min.js.
  window.rhino3dm({ locateFile: (p) => 'libs/' + p }).then(rhino => { S.rhinoInstance = rhino; });
}

const rhinoLoader = new Rhino3dmLoader();
rhinoLoader.setLibraryPath('libs/');

const gltfLoader = new GLTFLoader();

// Module-scope state used by animate() — must be initialized before bootstrap
// so the very first frame doesn't hit the TDZ.
let barContrastFrameCount = 0;

// ── Bootstrap ─────────────────────────────────────────────────────────────
document.getElementById('loading')?.classList.remove('hidden');
initThemeSync();
init();
animate();

// ── Auto-load embedded model (self-contained Export Package HTML) ────────────
// When this page was produced by "Export Package", the model travels inline as
// either a plain base64 gzip'd .rhv in window.__RHV_PACKAGE__, OR an encrypted
// {salt,iv,data} blob in window.__RHV_PACKAGE_ENCRYPTED__ (AES-GCM+PBKDF2).
// Either way we decode/decrypt to bytes, wrap as a File, and feed it through
// the normal session loader — no fetch, no server needed.
const _hasPlainPackage     = typeof window.__RHV_PACKAGE__ === 'string' && window.__RHV_PACKAGE__.length;
const _hasEncryptedPackage = window.__RHV_PACKAGE_ENCRYPTED__ && typeof window.__RHV_PACKAGE_ENCRYPTED__.data === 'string';

if (_hasPlainPackage || _hasEncryptedPackage) {
  // This is a delivered review artifact, not an authoring session — hide the
  // save/export actions that don't make sense here (and Export Package can't
  // work standalone, since it fetches the viewer shell that only exists on the
  // dev server).
  ['btn-save-panel', 'btn-save-as-panel', 'btn-save-glb', 'btn-export-package']
    .forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });

  // Optional: hide the File menu entirely (export option).
  if (window.__RHV_HIDE_FILE__) {
    const fileBtn = document.getElementById('btn-file');
    if (fileBtn) fileBtn.style.display = 'none';
  }

  (async () => {
    try {
      const name = window.__RHV_PACKAGE_NAME__ || 'model.rhv';
      let bytes;
      if (_hasEncryptedPackage) {
        bytes = await _decryptEmbeddedPayload(window.__RHV_PACKAGE_ENCRYPTED__);
        if (!bytes) return; // user cancelled / wrong password — loading stays
      } else {
        bytes = _base64ToBytes(window.__RHV_PACKAGE__);
      }
      const file = new File([bytes], name, { type: 'application/octet-stream' });
      await loadSession(file);
    } catch (e) {
      console.error('[App] Failed to load embedded package:', e);
      document.getElementById('loading')?.classList.add('hidden');
    }
  })();
}

// Base64 → bytes.
//
// Measured on a 69 MB payload (the size of a real embedded model): atob() plus this
// per-character loop takes ~140 ms, while handing a data: URL to fetch() — which
// looks like it should be faster, being native — takes ~980 ms. V8's atob and the
// charCodeAt loop are both well optimised, and the data: URL path pays for URL
// parsing and extra copies. Do not "optimise" this into fetch().
function _base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Prompt for the package password, derive the key, decrypt the payload, and
// return raw bytes. Re-prompts on wrong password; returns null only if the
// user cancels. Used only on packaged HTML — never reached on the dev server.
async function _decryptEmbeddedPayload(enc) {
  const salt = _base64ToBytes(enc.salt);
  const iv   = _base64ToBytes(enc.iv);
  const data = _base64ToBytes(enc.data);

  // Hide the spinning loader during the prompt so the user can read the dialog.
  document.getElementById('loading')?.classList.add('hidden');

  let attempt = 0;
  while (true) {
    const msg = attempt === 0
      ? t('exportpkg.prompt_label')
      : t('exportpkg.wrong_password') + '\n' + t('exportpkg.prompt_label');
    const password = window.prompt(msg);
    if (password == null) return null; // user cancelled

    try {
      const baseKey = await crypto.subtle.importKey(
        'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']
      );
      const key = await crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations: 200000, hash: 'SHA-256' },
        baseKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['decrypt']
      );
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
      // Re-show the loader now that we're about to actually load the model.
      document.getElementById('loading')?.classList.remove('hidden');
      return new Uint8Array(plain);
    } catch {
      attempt++;
      // AES-GCM throws on bad key — loop back and re-prompt.
    }
  }
}

// ── init ───────────────────────────────────────────────────────────────────

/**
 * Enable or disable center toolbar + layer button based on model presence.
 * @param {boolean} loaded - true when a model is loaded, false otherwise.
 */
export function setToolbarModelState(loaded) {
  const center = document.getElementById('top-bar-center');
  const layerBtn = document.getElementById('btn-layer-panel');
  const bottomBar = document.getElementById('bottom-view-tools-bar');
  if (loaded) {
    center?.classList.remove('no-model');
    layerBtn?.classList.remove('no-model');
    bottomBar?.classList.remove('no-model');
  } else {
    center?.classList.add('no-model');
    layerBtn?.classList.add('no-model');
    bottomBar?.classList.add('no-model');
  }
}

function init() {
  const container = document.getElementById('canvas-container');

  // Disable model-dependent toolbar buttons until a model is loaded
  setToolbarModelState(false);

  S.scene = new THREE.Scene();
  S.scene.backgroundRotation.order = 'YXZ';
  S.scene.environmentRotation.order = 'YXZ';
  S.scene.backgroundRotation.x = Math.PI / 2;
  S.scene.environmentRotation.x = Math.PI / 2;
  S.scene.backgroundRotation.y = 0;
  S.scene.environmentRotation.y = 0;
  S.scene.backgroundRotation.z = 0;
  S.scene.environmentRotation.z = 0;
  S.scene.background = null;
  S.measurementGroup = new THREE.Group();
  S.raycaster = new THREE.Raycaster();
  S.mouse = new THREE.Vector2();
  S.clippingPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

  // Separate overlay scene for arc handles — rendered after main scene with NO clipping planes
  S.arcOverlayScene = new THREE.Scene();
  S.arcOverlayScene.background = null;

  S.perspCamera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 10000);
  S.perspCamera.up.set(0, 0, 1);
  S.perspCamera.position.set(100, -100, 100);
  S.perspCamera.layers.enable(1);  // layer 1 = annotations (excluded from AO)
  S.scene.add(S.perspCamera);

  S.orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100000);
  S.orthoCamera.up.set(0, 0, 1);
  S.orthoCamera.layers.enable(1);
  S.scene.add(S.orthoCamera);

  S.camera = S.perspCamera;

  S.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, stencil: true });
  S.renderer.setPixelRatio(window.devicePixelRatio);
  S.renderer.setSize(window.innerWidth, window.innerHeight);
  S.renderer.outputColorSpace = THREE.SRGBColorSpace;
  S.renderer.toneMapping = THREE.NoToneMapping;
  S.renderer.shadowMap.enabled = true;
  S.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(S.renderer.domElement);

  // EffectComposer with MSAA render target (samples:4).
  // Hardware MSAA on the RT fixes thin-line aliasing that SMAA alone cannot solve
  // (SMAA blends 1px lines with neighbors, reducing their apparent weight).
  // GTAOPass reads depth — depth resolve from MSAA RT works in WebGL2;
  // if GTAO is enabled and depth sampling breaks, fall back by switching to a
  // plain RT at that time. GTAO is disabled by default so this is safe.
  S.msaaTarget = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight, {
    samples: 4
  });
  S.composer = new EffectComposer(S.renderer, S.msaaTarget);
  S.composer.setPixelRatio(window.devicePixelRatio);
  S.composer.setSize(window.innerWidth, window.innerHeight);
  S.composer.addPass(new RenderPass(S.scene, S.camera));

  // GTAO — Ground Truth Ambient Occlusion, configured per three.js example
  // (https://threejs.org/examples/?q=ambient#webgl_postprocessing_gtao)
  S.gtaoPass = new GTAOPass(S.scene, S.camera, window.innerWidth, window.innerHeight);
  // OUTPUT.Default = scene blended with AO. OUTPUT.Denoise outputs AO only (debug).
  S.gtaoPass.output = GTAOPass.OUTPUT.Default;
  S.gtaoPass.enabled = false;
  S.gtaoPass.blendIntensity = 1.0;
  S.composer.addPass(S.gtaoPass);
  // Expose for runtime debugging in console
  window._gtao = S.gtaoPass;
  window._GTAO_OUTPUT = GTAOPass.OUTPUT;

  // Initialize GTAO parameters (default — overridden per mode in display.js).
  // screenSpaceRadius: false matches the three.js example setup.  The
  // world-space radius is set to a placeholder (1.0); display.js sets it to
  // 5% of the loaded model's bounding-box size so it scales automatically
  // from a 20 mm jewelry ring to a 50 m building.
  S.gtaoPass.updateGtaoMaterial({
    radius: 1.0, distanceExponent: 1.0, thickness: 20.0, scale: 1.0,
    samples: 16, distanceFallOff: 1.0, screenSpaceRadius: false
  });
  S.gtaoPass.updatePdMaterial({
    lumaPhi: 10., depthPhi: 2., normalPhi: 3.,
    radius: 4., radiusExponent: 1., rings: 2., samples: 16
  });

  // SSAOPass — fallback / comparison. Added to the composer so we can enable it
  // per-mode. Starts disabled; ao-debug mode can toggle it to verify the
  // pipeline works while GTAOPass is being debugged.
  S.ssaoPass = new SSAOPass(S.scene, S.camera, window.innerWidth, window.innerHeight);
  S.ssaoPass.kernelRadius = 16;   // world-space radius (scaled in display.js)
  S.ssaoPass.minDistance  = 0.005;
  S.ssaoPass.maxDistance  = 0.1;
  S.ssaoPass.enabled = false;
  S.composer.addPass(S.ssaoPass);
  window._ssao = S.ssaoPass;

  // Wrap AO passes: exclude annotations from the depth/normal G-buffer render.
  // GTAOPass uses scene.overrideMaterial + renderer.render(scene, camera) internally,
  // so we need BOTH approaches: layer restriction (camera.layers.set(0)) AND
  // visibility toggle (annotationGroup.visible = false). The RenderPass runs before
  // these passes, so annotations are already in the visual output — hiding them here
  // only affects the AO G-buffer, not the final image.
  [S.gtaoPass, S.ssaoPass].forEach(pass => {
    const _orig = pass.render.bind(pass);
    pass.render = (renderer, writeBuffer, readBuffer, dt, mask) => {
      const savedMask = S.camera.layers.mask;
      const ann        = S.annotationGroup;
      const annVisible = ann ? ann.visible : false;
      S.camera.layers.set(0);
      if (ann) ann.visible = false;
      _orig(renderer, writeBuffer, readBuffer, dt, mask);
      S.camera.layers.mask = savedMask;
      if (ann) ann.visible = annVisible;
    };
  });

  // Outline pass for technical-mode silhouette (2px) — disabled by default.
  S.outlinePass = new OutlinePass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    S.scene, S.camera
  );
  S.outlinePass.edgeStrength      = 20.0;
  S.outlinePass.edgeGlow          = 0.0;
  S.outlinePass.edgeThickness     = 4.0;  // visibly thicker than 1px geometry edges
  S.outlinePass.pulsePeriod       = 0;
  S.outlinePass.visibleEdgeColor.set('#000000');
  S.outlinePass.hiddenEdgeColor.set('#000000');
  S.outlinePass.enabled = false;
  S.composer.addPass(S.outlinePass);

  // Dedicated selection outline pass (glowing vibrant electric blue silhouette)
  S.selectionOutlinePass = new OutlinePass(
    new THREE.Vector2(window.innerWidth, window.innerHeight),
    S.scene, S.camera
  );
  S.selectionOutlinePass.edgeStrength      = 6.0;
  S.selectionOutlinePass.edgeGlow          = 0.2;
  S.selectionOutlinePass.edgeThickness     = 1.0;  // Delicate razor-thin precision outline
  S.selectionOutlinePass.pulsePeriod       = 0;
  S.selectionOutlinePass.visibleEdgeColor.set('#0066ff'); // Deep electric blue: excellent contrast on white, glows brilliantly on dark
  S.selectionOutlinePass.hiddenEdgeColor.set('#002288');
  
  // Disable AdditiveBlending to ensure outlines are beautifully visible on white backgrounds
  S.selectionOutlinePass.overlayMaterial.blending = THREE.CustomBlending;
  
  S.selectionOutlinePass.enabled = true; // Renders automatically when selectedObjects is populated
  S.composer.addPass(S.selectionOutlinePass);

  S.cgPass = new ShaderPass(ColorGradingShader);
  S.composer.addPass(S.cgPass);

  // SMAA — software AA pass; secondary to the MSAA render target.
  // Helps smooth post-process artifacts (OutlinePass edges, etc) that MSAA misses.
  S.smaaPass = new SMAAPass(window.innerWidth, window.innerHeight);
  S.composer.addPass(S.smaaPass);

  S.composer.addPass(new OutputPass());

  S.controls = new OrbitControls(S.camera, S.renderer.domElement);
  S.controls.enableDamping = true;
  S.controls.dampingFactor = 0.5;
  S.controls.autoRotateSpeed = 1.0;

  // 2-Point Perspective drag interception (no-op until twoPointActive=true)
  installTwoPointDragHandler();

  // Stylus-only filter. Must come after the canvas is in #canvas-container and
  // after OrbitControls is bound to it — it intercepts in the container's
  // capture phase, upstream of every listener on the canvas itself.
  initPenInput();

  S.renderer.localClippingEnabled = true;
  S.scene.add(S.measurementGroup);

  S.raycaster.params.Line.threshold = 2.5;
  S.raycaster.layers.enableAll(); // Enable hit-testing on all layers including layer 1 (annotations)

  S.clippingTransformControls = new TransformControls(S.camera, S.renderer.domElement);
  S.clippingTransformControls.setSpace('local');
  S.clippingTransformControls.setMode('translate');
  S.clippingTransformControls.size = 0.6; // Scale down translate gizmo to 60%
  S.clippingTransformControls.showX = true;
  S.clippingTransformControls.showY = true;
  S.clippingTransformControls.showZ = true;
  
  // Render gizmo helper in the arc overlay scene so it is never clipped
  S.arcOverlayScene.add(S.clippingTransformControls.getHelper());

  // ── Gumball Transform Controls Setup ──
  S.gumballTransformControls = new TransformControls(S.camera, S.renderer.domElement);
  S.gumballTransformControls.setSpace('local');
  S.gumballTransformControls.setMode('translate');
  S.gumballTransformControls.size = 0.6; // Scale down translate gizmo to 60%
  S.gumballTransformControls.showX = true;
  S.gumballTransformControls.showY = true;
  S.gumballTransformControls.showZ = true;
  S.arcOverlayScene.add(S.gumballTransformControls.getHelper());

  // Hide negative direction handles for gumball
  try {
    const gizmoTranslate = S.gumballTransformControls._gizmo.gizmo['translate'];
    gizmoTranslate.traverse(child => {
      const isPlane = child.name && (
        child.name === 'XY' || child.name === 'YZ' || child.name === 'XZ' ||
        child.name.includes('XY') || child.name.includes('YZ') || child.name.includes('XZ')
      );
      if (isPlane) {
        child.userData.isPlaneHandle = true;
      }

      if (!child.geometry) return;
      child.geometry.computeBoundingBox();
      const center = child.geometry.boundingBox.getCenter(new THREE.Vector3());
      const isGeometryNeg = (center.x < -0.02 || center.y < -0.02 || center.z < -0.02);
      const isPositionNeg = (child.position.x < -0.02 || child.position.y < -0.02 || child.position.z < -0.02);
      
      const shouldHide = isPlane || isGeometryNeg || isPositionNeg;
      if (shouldHide) {
        child.layers.set(31); // hidden layer
        const mat = child.material;
        if (mat) {
          const clonedMat = mat.clone();
          clonedMat.transparent = true;
          clonedMat.opacity = 0;
          clonedMat.needsUpdate = true;
          child.material = clonedMat;
          child.userData.clonedNegMat = clonedMat;
        }
        if (isGeometryNeg || isPositionNeg) {
          child.userData.isNegArrow = true;
        }
      }
    });
  } catch(e) { console.warn('Gumball negative arrow hide failed:', e); }

  let lastGumballPos = new THREE.Vector3();
  let transformBeforeState = null;
  S.gumballTransformControls.addEventListener('dragging-changed', (event) => {
    S.controls.enabled = !event.value;
    console.log('[Gumball] dragging-changed event.value:', event.value, 'S.gumballHelper exists:', !!S.gumballHelper);
    if (event.value && S.gumballHelper) {
      lastGumballPos.copy(S.gumballHelper.position);
      transformBeforeState = S.selectedObjects.map(obj => ({
        position: obj.position.clone(),
        quaternion: obj.quaternion.clone(),
        scale: obj.scale.clone()
      }));
      console.log('[Gumball] Captured transformBeforeState:', transformBeforeState);
    } else if (!event.value && transformBeforeState) {
      const transformAfterState = S.selectedObjects.map(obj => ({
        position: obj.position.clone(),
        quaternion: obj.quaternion.clone(),
        scale: obj.scale.clone()
      }));
      
      let changed = false;
      for (let i = 0; i < S.selectedObjects.length; i++) {
        if (!S.selectedObjects[i].position.equals(transformBeforeState[i].position) ||
            !S.selectedObjects[i].quaternion.equals(transformBeforeState[i].quaternion) ||
            !S.selectedObjects[i].scale.equals(transformBeforeState[i].scale)) {
          changed = true;
          break;
        }
      }
      
      console.log('[Gumball] Drag finished. changed:', changed, 'transformBeforeState:', transformBeforeState, 'transformAfterState:', transformAfterState);
      if (changed) {
        History.push({
          type: 'transform',
          targets: [...S.selectedObjects],
          before: transformBeforeState,
          after: transformAfterState
        });
      }
      transformBeforeState = null;
    }
  });

  S.gumballTransformControls.addEventListener('change', () => {
    if (S.gumballHelper && S.gumballTransformControls.dragging) {
      const delta = new THREE.Vector3().subVectors(S.gumballHelper.position, lastGumballPos);
      
      S.selectedObjects.forEach(obj => {
        ensureOriginalTransform(obj);
        obj.position.add(delta);
        obj.updateMatrixWorld(true);
      });
      
      lastGumballPos.copy(S.gumballHelper.position);

      if (S.selectionOutlinePass) {
        S.selectionOutlinePass.selectedObjects = [...S.selectedObjects];
      }
      
      S.gumballArcHandles.forEach(h => {
        h.mesh.position.copy(S.gumballHelper.position);
        h.hitMesh.position.copy(S.gumballHelper.position);
      });
    }
  });

  // Hide negative-direction arrowheads permanently via material opacity.
  // TransformControls resets handle.visible = true every frame (source line 1233),
  // so we CANNOT use visible=false. Instead we make the material fully transparent.
  // setupGizmo() bakes positions into geometry (resets object.position to 0,0,0),
  // so we detect direction via geometry bounding box centroid.
  try {
    const gizmoTranslate = S.clippingTransformControls._gizmo.gizmo['translate'];
    gizmoTranslate.traverse(child => {
      const isPlane = child.name && (
        child.name === 'XY' || child.name === 'YZ' || child.name === 'XZ' ||
        child.name.includes('XY') || child.name.includes('YZ') || child.name.includes('XZ')
      );
      if (isPlane) {
        child.userData.isPlaneHandle = true;
      }

      if (!child.geometry) return;
      child.geometry.computeBoundingBox();
      const center = child.geometry.boundingBox.getCenter(new THREE.Vector3());
      const isGeometryNeg = (center.x < -0.02 || center.y < -0.02 || center.z < -0.02);
      const isPositionNeg = (child.position.x < -0.02 || child.position.y < -0.02 || child.position.z < -0.02);
      
      const shouldHide = isPlane || isGeometryNeg || isPositionNeg;
      if (shouldHide) {
        child.layers.set(31); // Move to hidden layer so camera never renders it!
        const mat = child.material;
        if (mat) {
          const clonedMat = mat.clone();
          clonedMat.transparent = true;
          clonedMat.opacity = 0;
          clonedMat.needsUpdate = true;
          child.material = clonedMat;
          child.userData.clonedNegMat = clonedMat;
        }
        if (isGeometryNeg || isPositionNeg) {
          child.userData.isNegArrow = true;
        }
      }
    });
  } catch(e) { console.warn('Negative arrow or plane hide failed:', e); }

  let clippingDragBefore = null;

  S.clippingTransformControls.addEventListener('dragging-changed', (event) => {
    S.controls.enabled = !event.value;

    if (History.suppress) return;

    if (event.value) {
      clippingDragBefore = {
        position: S.clippingPosition ? S.clippingPosition.clone() : null,
        quaternion: S.clippingQuaternion ? S.clippingQuaternion.clone() : null,
        clipAxis: S.clipAxis,
        clipFlipped: S.clipFlipped
      };
    } else {
      if (clippingDragBefore) {
        const afterState = {
          position: S.clippingPosition ? S.clippingPosition.clone() : null,
          quaternion: S.clippingQuaternion ? S.clippingQuaternion.clone() : null,
          clipAxis: S.clipAxis,
          clipFlipped: S.clipFlipped
        };

        const posChanged = (!clippingDragBefore.position && afterState.position) ||
                           (clippingDragBefore.position && !afterState.position) ||
                           (clippingDragBefore.position && afterState.position && clippingDragBefore.position.distanceTo(afterState.position) > 0.0001);
        const quatChanged = (!clippingDragBefore.quaternion && afterState.quaternion) ||
                            (clippingDragBefore.quaternion && !afterState.quaternion) ||
                            (clippingDragBefore.quaternion && afterState.quaternion && clippingDragBefore.quaternion.angleTo(afterState.quaternion) > 0.0001);

        if (posChanged || quatChanged) {
          History.push({
            type: 'clipping',
            before: clippingDragBefore,
            after: afterState
          });
        }
        clippingDragBefore = null;
      }
    }
  });

  S.clippingTransformControls.addEventListener('change', () => {
    if (S.clippingHelper && S.currentModel) {
      const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(S.clippingHelper.quaternion).normalize();
      if (S.clipFlipped) normal.negate();
      S.clippingPlane.normal.copy(normal);
      S.clippingPlane.constant = -normal.dot(S.clippingHelper.position);

      if (!S.clippingPosition) S.clippingPosition = new THREE.Vector3();
      S.clippingPosition.copy(S.clippingHelper.position);

      if (!S.clippingQuaternion) S.clippingQuaternion = new THREE.Quaternion();
      S.clippingQuaternion.copy(S.clippingHelper.quaternion);

      if (S.clippingArcHandles) {
        S.clippingArcHandles.forEach(h => {
          h.mesh.position.copy(S.clippingHelper.position);
          h.mesh.quaternion.copy(S.clippingHelper.quaternion);
          h.hitMesh.position.copy(S.clippingHelper.position);
          h.hitMesh.quaternion.copy(S.clippingHelper.quaternion);
        });
      }
    }
  });

  setupLights();

  const pmrem = new THREE.PMREMGenerator(S.renderer);
  pmrem.compileEquirectangularShader();

  S.envMaps.studio = makeStudioEnv(pmrem);

  S.envMaps.neutral = makeGradientEnv(pmrem, '#a0a0a0', '#d8d8d8', '#505050', '#101010');
  S.envMaps.sky     = makeGradientEnv(pmrem, '#061124', '#335485', '#d6c2ad', '#0e0b0a');
  S.envMaps.sunset  = makeSunsetEnv(pmrem);
  S.envMaps.night   = makeGradientEnv(pmrem, '#020202', '#080808', '#141414', '#020202');

  S.environmentMap = S.envMaps.studio;
  S.scene.environment = S.environmentMap;
  pmrem.dispose();

  const bgSel = document.getElementById('bg-type-select');
  if (bgSel) {
    bgSel.value = 'solid';
    document.getElementById('picker-c1')?.classList.remove('hidden');
    document.getElementById('picker-c2')?.classList.add('hidden');
    document.getElementById('bg-radial-section')?.classList.add('hidden');
    document.querySelector('.env-preset-btn[data-preset="studio"]')?.classList.add('active');
  }

  initI18n();
  applyI18n();

  bindUI();
  applyModeSettings(S.currentMode);
  updateAllSliderFills();
  window.addEventListener('resize', onWindowResize);
  onWindowResize(); // Force initial sizing of renderer, composer, and passes to physical pixel resolution

  // Apply env intensity initial value
  const slEnvInit = document.getElementById('sl-env-intensity');
  if (slEnvInit) {
    const val = parseFloat(slEnvInit.value) || 1.0;
    S.scene.environmentIntensity = val;
    const bgType = document.getElementById('bg-type-select')?.value || 'solid';
    S.scene.backgroundIntensity = (bgType === 'hdr') ? val : 1.0;
  }

  // Apply HDR rotation initial value
  const slHdrInit = document.getElementById('sl-hdr-rotation');
  if (slHdrInit) {
    const v = parseInt(slHdrInit.value) || 0;
    S.hdrRotation = v;
    const rad = (v * Math.PI) / 180;
    if (S.scene) {
      S.scene.backgroundRotation.y = rad;
      S.scene.environmentRotation.y = rad;
      S.scene.backgroundRotation.z = 0;
      S.scene.environmentRotation.z = 0;
    }
  }

  // Check for auto-loading a model via query parameter (e.g., ?model=path/to/file.3dm)
  const urlParams = new URLSearchParams(window.location.search);
  const modelUrl = urlParams.get('model') || urlParams.get('url');
  if (modelUrl) {
    loadModelFromUrl(modelUrl);
  } else {
    hideLoading();
  }
}

// ── Custom photography studio softbox environment generator ────────────────
function makeStudioEnv(pmrem) {
  const w = 1024, h = 512;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');

  // 1. Fill base dark room background (ceiling and background walls)
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, w, h);

  // Ceiling glow / light gray ceiling (Y = 0 to 24% / 120px)
  const ceilGrad = ctx.createLinearGradient(0, 0, 0, 120);
  ceilGrad.addColorStop(0, '#e5e5e5');
  ceilGrad.addColorStop(0.7, '#a8a8a8');
  ceilGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = ceilGrad;
  ctx.fillRect(0, 0, w, 120);

  // 2. Draw the cyc wall floor (light gray paper sweep)
  // It is a light gray floor at the bottom (Y = 320 to 512)
  const floorGrad = ctx.createLinearGradient(0, 300, 0, h);
  floorGrad.addColorStop(0, '#000000'); // background wall shadow
  floorGrad.addColorStop(0.12, '#606060'); // top of paper sweep curve
  floorGrad.addColorStop(0.45, '#989898'); // main floor
  floorGrad.addColorStop(1, '#b5b5b5'); // foreground floor
  ctx.fillStyle = floorGrad;
  ctx.fillRect(0, 300, w, h - 300);

  // 3. Draw Left and Right hanging backdrop sheets (light gray)
  // Left sheet (X = 0 to 140)
  const leftSheetGrad = ctx.createLinearGradient(0, 0, 140, 0);
  leftSheetGrad.addColorStop(0, '#b0b0b0');
  leftSheetGrad.addColorStop(0.75, '#909090');
  leftSheetGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = leftSheetGrad;
  ctx.fillRect(0, 120, 140, h - 120);

  // Right sheet (X = 884 to 1024)
  const rightSheetGrad = ctx.createLinearGradient(1024, 0, 884, 0);
  rightSheetGrad.addColorStop(0, '#b0b0b0');
  rightSheetGrad.addColorStop(0.75, '#909090');
  rightSheetGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = rightSheetGrad;
  ctx.fillRect(884, 120, 140, h - 120);

  // 4. Helper to draw softbox panels with shadowBlur (gives beautiful dual-axis blur)
  function drawSoftboxPanel(cx, cy, sw, sh, opacity, round = 10) {
    ctx.save();
    // Soft outer glow
    ctx.shadowBlur = 45;
    ctx.shadowColor = `rgba(255,255,255,${opacity * 0.95})`;
    ctx.fillStyle = `rgba(255,255,255,${opacity * 0.9})`;
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(cx - sw/2, cy - sh/2, sw, sh, round);
    } else {
      ctx.rect(cx - sw/2, cy - sh/2, sw, sh);
    }
    ctx.fill();

    // Bright inner core
    ctx.shadowBlur = 15;
    ctx.fillStyle = `rgba(255,255,255,${opacity})`;
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(cx - sw/4, cy - sh/4, sw/2, sh/2, round/2);
    } else {
      ctx.rect(cx - sw/4, cy - sh/4, sw/2, sh/2);
    }
    ctx.fill();
    ctx.restore();
  }

  // 5. Draw the key softboxes from the photo (shifted upwards as requested):
  // Center-left bright softbox
  drawSoftboxPanel(w * 0.35, h * 0.35, 110, 110, 1.0, 8);

  // Center-right weaker softbox
  drawSoftboxPanel(w * 0.65, h * 0.37, 90, 90, 0.6, 6);

  // Top weak softbox (or bright overhead ceiling light)
  drawSoftboxPanel(w * 0.5, h * 0.22, 220, 50, 0.55, 10);

  // Spotlight bulb on the right
  ctx.save();
  ctx.shadowBlur = 35;
  ctx.shadowColor = 'rgba(255,255,255,1)';
  ctx.fillStyle = 'white';
  ctx.beginPath();
  ctx.arc(w * 0.85, h * 0.30, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const tex = new THREE.CanvasTexture(canvas);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  const envMap = pmrem.fromEquirectangular(tex).texture;
  tex.dispose();
  return envMap;
}

// ── Custom Sunset Environment Generator ─────────────────────────────────────
function makeSunsetEnv(pmrem) {
  const w = 1024, h = 512;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');

  // 1. Sky & Water Base Gradient
  const bgGrad = ctx.createLinearGradient(0, 0, 0, h);
  bgGrad.addColorStop(0,    '#183e66'); // rich sky blue
  bgGrad.addColorStop(0.35, '#3c668c'); // mid sky blue
  bgGrad.addColorStop(0.47, '#d6b294'); // warm orange sky glow near horizon
  bgGrad.addColorStop(0.50, '#c97130'); // sun horizon line
  bgGrad.addColorStop(0.53, '#d6b294'); // horizon reflection
  bgGrad.addColorStop(0.65, '#2f5473'); // reflection midtone
  bgGrad.addColorStop(1.0,  '#102b47'); // deep reflection
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, w, h);

  // 2. Draw Sun Glow
  const sunGlow = ctx.createRadialGradient(w * 0.6, h * 0.5, 4, w * 0.6, h * 0.5, 140);
  sunGlow.addColorStop(0,   'rgba(255, 255, 255, 0.85)');
  sunGlow.addColorStop(0.1, 'rgba(255, 235, 180, 0.70)');
  sunGlow.addColorStop(0.3, 'rgba(255, 150, 70, 0.30)');
  sunGlow.addColorStop(0.6, 'rgba(255, 110, 50, 0.10)');
  sunGlow.addColorStop(1,   'rgba(255, 110, 50, 0.0)');
  ctx.fillStyle = sunGlow;
  ctx.beginPath();
  ctx.arc(w * 0.6, h * 0.5, 140, 0, Math.PI * 2);
  ctx.fill();

  // 3. Draw Sun Disk
  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.shadowBlur = 8;
  ctx.shadowColor = '#ffecd4';
  ctx.beginPath();
  ctx.arc(w * 0.6, h * 0.5, 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // 4. Clouds Drawing Helpers
  function drawCloudPuff(x, y, radius, opacity) {
    const grad = ctx.createRadialGradient(x, y, 0, x, y, radius);
    grad.addColorStop(0, `rgba(240, 245, 255, ${opacity * 0.7})`);
    grad.addColorStop(0.5, `rgba(195, 208, 224, ${opacity * 0.28})`);
    grad.addColorStop(1, 'rgba(195, 208, 224, 0.0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawSunsetCloud(x, y, radius, opacity) {
    const grad = ctx.createRadialGradient(x, y, 0, x, y, radius);
    grad.addColorStop(0, `rgba(255, 215, 180, ${opacity})`);
    grad.addColorStop(0.6, `rgba(224, 160, 128, ${opacity * 0.4})`);
    grad.addColorStop(1, 'rgba(224, 160, 128, 0.0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  // Draw Sky Clouds (Left side cloud bank from photo)
  drawCloudPuff(w * 0.15, h * 0.35, 60, 0.35);
  drawCloudPuff(w * 0.20, h * 0.33, 80, 0.40);
  drawCloudPuff(w * 0.25, h * 0.36, 70, 0.35);
  drawCloudPuff(w * 0.28, h * 0.38, 50, 0.25);
  drawCloudPuff(w * 0.10, h * 0.38, 40, 0.20);
  drawCloudPuff(w * 0.33, h * 0.35, 45, 0.25);

  // Sunset tinted clouds closer to the sun
  drawSunsetCloud(w * 0.42, h * 0.41, 55, 0.30);
  drawSunsetCloud(w * 0.48, h * 0.42, 45, 0.25);
  drawSunsetCloud(w * 0.72, h * 0.42, 65, 0.25);
  drawSunsetCloud(w * 0.78, h * 0.44, 55, 0.20);

  // 5. Water Reflections of Clouds (Squashed & stretched reflection)
  ctx.save();
  ctx.scale(1.2, 0.7);
  drawCloudPuff(w * 0.15 / 1.2, (h - h * 0.35) / 0.7, 60, 0.18);
  drawCloudPuff(w * 0.20 / 1.2, (h - h * 0.33) / 0.7, 80, 0.22);
  drawCloudPuff(w * 0.25 / 1.2, (h - h * 0.36) / 0.7, 70, 0.18);
  drawSunsetCloud(w * 0.42 / 1.2, (h - h * 0.41) / 0.7, 55, 0.15);
  drawSunsetCloud(w * 0.72 / 1.2, (h - h * 0.42) / 0.7, 65, 0.12);
  ctx.restore();

  const tex = new THREE.CanvasTexture(canvas);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  const envMap = pmrem.fromEquirectangular(tex).texture;
  tex.dispose();
  return envMap;
}

// ── Environment gradient helper ────────────────────────────────────────────
function makeGradientEnv(pmrem, top, mid, horizon, bottom) {
  const w = 512, h = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0,    top);
  grad.addColorStop(0.38, mid);
  grad.addColorStop(0.55, horizon ?? mid);
  grad.addColorStop(1,    bottom ?? top);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  const tex = new THREE.CanvasTexture(canvas);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  const envMap = pmrem.fromEquirectangular(tex).texture;
  tex.dispose();
  return envMap;
}

// ── UI bindings ────────────────────────────────────────────────────────────
let pointerDownTime = 0;
let pointerDownPos = new THREE.Vector2();

function bindUI() {
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const fileAccept = isMobile ? '*/*' : '.3dm,.glb,.gltf,.stp,.step,.iges,.igs,.stl,.3mf,.rhv';
  const sessionAccept = isMobile ? '*/*' : '.rhv';

  let fileInput = document.getElementById('file-upload');
  if (!fileInput) {
    fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.id = 'file-upload';
    fileInput.style.display = 'none';
    fileInput.accept = fileAccept;
    document.body.appendChild(fileInput);
  } else {
    fileInput.accept = fileAccept;
  }
  fileInput.addEventListener('change', async e => {
    const f = e.target.files[0];
    if (f) {
      if (f.name.toLowerCase().endsWith('.rhv')) {
        await loadSession(f);
      } else {
        handleFile(f, rhinoLoader, gltfLoader);
      }
    }
  });

  let sessionInput = document.getElementById('session-upload');
  if (!sessionInput) {
    sessionInput = document.createElement('input');
    sessionInput.type = 'file';
    sessionInput.id = 'session-upload';
    sessionInput.style.display = 'none';
    sessionInput.accept = sessionAccept;
    document.body.appendChild(sessionInput);
  } else {
    sessionInput.accept = sessionAccept;
  }
  sessionInput.addEventListener('change', async e => {
    const f = e.target.files[0]; if (f) { await loadSession(f); }
    e.target.value = '';
  });

  // ── 1. Panel toggles ──
  const leftPanel = document.getElementById('left-panel');
  const layerRightPanel = document.getElementById('layer-right-panel');
  const settingsRightPanel = document.getElementById('settings-right-panel');

  function closeAllPanels() {
    leftPanel.classList.add('hidden');
    layerRightPanel?.classList.remove('panel-open');
    settingsRightPanel?.classList.remove('panel-open');
  }

  document.getElementById('btn-file').addEventListener('click', () => {
    const isOpen = !leftPanel.classList.contains('hidden');
    closeAllPanels();
    if (!isOpen) leftPanel.classList.remove('hidden');
  });
  document.getElementById('btn-close-menu').addEventListener('click', () => {
    leftPanel.classList.add('hidden');
  });

  document.getElementById('btn-layer-panel')?.addEventListener('click', () => {
    const isOpen = layerRightPanel?.classList.contains('panel-open');
    closeAllPanels();
    if (!isOpen) layerRightPanel?.classList.add('panel-open');
  });
  document.getElementById('btn-close-layer-panel')?.addEventListener('click', () => {
    layerRightPanel?.classList.remove('panel-open');
  });

  document.getElementById('btn-settings-panel')?.addEventListener('click', () => {
    const isOpen = settingsRightPanel?.classList.contains('panel-open');
    closeAllPanels();
    if (!isOpen) settingsRightPanel?.classList.add('panel-open');
  });
  document.getElementById('btn-close-settings-panel')?.addEventListener('click', () => {
    settingsRightPanel?.classList.remove('panel-open');
  });

  // ── 2. File tab actions ──
  document.getElementById('btn-open-panel').addEventListener('click', async () => {
    // Desktop Chromium: open via the File System Access API so we keep a
    // writable handle (lets Save overwrite the file in place). Elsewhere use
    // the classic file input.
    if (typeof window.showOpenFilePicker === 'function') {
      let handle;
      try {
        [handle] = await window.showOpenFilePicker({
          multiple: false,
          types: [{ description: '3D / CAD Models', accept: { 'application/octet-stream':
            ['.3dm', '.glb', '.gltf', '.stp', '.step', '.iges', '.igs', '.stl', '.3mf', '.rhv'] } }],
        });
      } catch (err) {
        if (err?.name !== 'AbortError') console.error('[Open] picker failed:', err);
        return;
      }
      const file = await handle.getFile();
      if (file.name.toLowerCase().endsWith('.rhv')) await loadSession(file, handle);
      else handleFile(file, rhinoLoader, gltfLoader, handle);
    } else {
      fileInput.click();
    }
  });
  const cloudLoaders = { rhinoLoader, gltfLoader };
  document.getElementById('btn-open-gdrive')?.addEventListener('click', () => {
    GoogleDrive.pickAndLoad(cloudLoaders);
  });
  document.getElementById('btn-open-onedrive')?.addEventListener('click', () => {
    OneDrive.pickAndLoad(cloudLoaders);
  });
  document.getElementById('btn-open-dropbox')?.addEventListener('click', () => {
    Dropbox.pickAndLoad(cloudLoaders);
  });
  document.getElementById('btn-save-panel').addEventListener('click', () => { saveSession(); });
  // Export Package opens an options dialog (hide File menu, password protect).
  // The dialog's confirm button is what eventually calls exportPackage(), so the
  // FSA save picker still fires inside a real user gesture.
  document.getElementById('btn-export-package')?.addEventListener('click', () => {
    if (!S.currentModel) { alert('No model loaded to export.'); return; }
    const dlg = document.getElementById('export-package-dialog');
    // Reset fields each time the dialog opens.
    const hideCb = document.getElementById('exportpkg-hide-file');
    const pwdCb  = document.getElementById('exportpkg-use-password');
    const pwdRow = document.getElementById('exportpkg-password-row');
    const pwdIn  = document.getElementById('exportpkg-password');
    if (hideCb) hideCb.checked = false;
    if (pwdCb)  pwdCb.checked  = false;
    if (pwdIn)  pwdIn.value    = '';
    pwdRow?.classList.add('hidden');
    dlg?.classList.remove('hidden');
    leftPanel.classList.add('hidden');
  });

  document.getElementById('exportpkg-use-password')?.addEventListener('change', (e) => {
    const row = document.getElementById('exportpkg-password-row');
    if (!row) return;
    if (e.target.checked) {
      row.classList.remove('hidden');
      document.getElementById('exportpkg-password')?.focus();
    } else {
      row.classList.add('hidden');
    }
  });

  document.getElementById('btn-close-export-pkg-dialog')?.addEventListener('click', () => {
    document.getElementById('export-package-dialog')?.classList.add('hidden');
  });
  document.getElementById('btn-cancel-export-pkg')?.addEventListener('click', () => {
    document.getElementById('export-package-dialog')?.classList.add('hidden');
  });
  document.getElementById('btn-confirm-export-pkg')?.addEventListener('click', () => {
    const hideFileMenu = !!document.getElementById('exportpkg-hide-file')?.checked;
    const usePassword  = !!document.getElementById('exportpkg-use-password')?.checked;
    const password     = usePassword ? (document.getElementById('exportpkg-password')?.value || '') : '';
    if (usePassword && !password) {
      // Require a non-empty password when the user opted in.
      document.getElementById('exportpkg-password')?.focus();
      return;
    }
    document.getElementById('export-package-dialog')?.classList.add('hidden');
    exportPackage(null, { hideFileMenu, password });
  });
  document.getElementById('btn-save-as-panel')?.addEventListener('click', () => {
    if (!S.currentModel) {
      alert('No model loaded to save.');
      return;
    }
    // Desktop Chromium: the native save dialog handles name + location in one
    // step, so skip the in-app filename prompt. Elsewhere fall back to the
    // in-app name dialog (a plain download has no OS picker).
    if (typeof window.showSaveFilePicker === 'function') {
      saveSession(null, true);
    } else {
      openSaveAsDialog();
    }
  });
  document.getElementById('btn-close-panel').addEventListener('click', () => { clearCurrentModel(); });
  document.getElementById('btn-capture-panel').addEventListener('click', () => {
    document.getElementById('capture-w').value = window.innerWidth;
    document.getElementById('capture-h').value = window.innerHeight;
    document.getElementById('capture-size-select').value = '1';
    document.getElementById('capture-dialog').classList.remove('hidden');
    leftPanel.classList.add('hidden');
  });
  document.getElementById('btn-close-capture-dialog')?.addEventListener('click', () => {
    document.getElementById('capture-dialog').classList.add('hidden');
  });
  document.getElementById('capture-size-select')?.addEventListener('change', e => {
    const scale = parseInt(e.target.value);
    document.getElementById('capture-w').value = Math.round(window.innerWidth * scale);
    document.getElementById('capture-h').value = Math.round(window.innerHeight * scale);
  });
  document.getElementById('btn-capture-confirm')?.addEventListener('click', async () => {
    const transparent = document.getElementById('capture-transparent').checked;
    const w = parseInt(document.getElementById('capture-w').value) || window.innerWidth;
    const h = parseInt(document.getElementById('capture-h').value) || window.innerHeight;

    const origPixelRatio = S.renderer.getPixelRatio();
    const origBackground = S.scene.background;

    S.renderer.setSize(w, h);
    S.renderer.setPixelRatio(1);
    if (transparent) {
      S.scene.background = null;
      S.renderer.setClearColor(0x000000, 0);
    }
    S.renderer.render(S.scene, S.camera);
    const dataURL = S.renderer.domElement.toDataURL('image/png');
    S.renderer.setSize(window.innerWidth, window.innerHeight);
    S.renderer.setPixelRatio(origPixelRatio);
    S.composer.setSize(window.innerWidth, window.innerHeight);
    S.scene.background = origBackground;
    if (transparent) S.renderer.setClearColor(0x000000, 0);

    const fileName = (S.currentFileName || 'capture') + '.png';
    if (window.Capacitor && window.Capacitor.isPluginAvailable('FileOpener')) {
      window.Capacitor.Plugins.FileOpener.saveFile({
        base64Data: dataURL,
        fileName: fileName,
        mimeType: 'image/png'
      }).then(() => {
        alert('Capture saved to Downloads folder!');
      }).catch(err => {
        console.error('[Capacitor Capture] Save failed:', err);
        alert('Failed to save capture: ' + err);
      });
    } else {
      // Desktop Chromium: prompt for save location; otherwise download.
      const sink = await beginSave({
        suggestedName: fileName,
        types: [{ description: 'PNG Image', accept: { 'image/png': ['.png'] } }],
      });
      if (sink) {
        const blob = await (await fetch(dataURL)).blob();
        await sink(blob);
      }
    }
    document.getElementById('capture-dialog').classList.add('hidden');
  });

  const saveGlbBtn = document.getElementById('btn-save-glb');
  if (saveGlbBtn) saveGlbBtn.addEventListener('click', () => exportGLB());

  // ── 3. Background color pickers ──
  if (window.Coloris) {
    Coloris.wrap('.bg-coloris-input');
  }

  const bgTypeSelect  = document.getElementById('bg-type-select');
  const bgPanelC1 = document.getElementById('bg-panel-c1');
  const bgPanelC2 = document.getElementById('bg-panel-c2');
  const bgPanelC3 = document.getElementById('bg-panel-c3');
  const bgPanelC4 = document.getElementById('bg-panel-c4');
  const bgSwatchC1 = document.getElementById('bg-panel-swatch-c1');
  const bgSwatchC2 = document.getElementById('bg-panel-swatch-c2');
  const bgSwatchC3 = document.getElementById('bg-panel-swatch-c3');
  const bgSwatchC4 = document.getElementById('bg-panel-swatch-c4');

  bgTypeSelect?.addEventListener('change', () => {
    const val = bgTypeSelect.value;
    const isSolid  = val === 'solid';
    const isRadial = val === 'radial';
    const isGrad4  = val === 'gradient4';
    const isHdr    = val === 'hdr';
    document.getElementById('picker-c1')?.classList.toggle('hidden', isHdr);
    document.getElementById('picker-c2')?.classList.toggle('hidden', isSolid || isHdr);
    document.getElementById('picker-c3')?.classList.toggle('hidden', !isGrad4 || isHdr);
    document.getElementById('picker-c4')?.classList.toggle('hidden', !isGrad4 || isHdr);
    const radialSection = document.getElementById('bg-radial-section');
    if (radialSection) radialSection.classList.toggle('hidden', !isRadial || isHdr);
    applySceneBackground();
  });

  const radialSpread = document.getElementById('bg-radial-spread');
  if (radialSpread) {
    radialSpread.addEventListener('input', () => {
      const v = parseFloat(radialSpread.value);
      document.getElementById('bg-radial-spread-val').textContent = Math.round(v * 100) + '%';
      updateSliderFill(radialSpread);
      applySceneBackground();
    });
    bindSliderDblClickInput(radialSpread, 'bg-radial-spread-val', '%');
  }

  // ── Environment preset select ──
  const envPresetSel = document.getElementById('env-preset-select');
  if (envPresetSel) {
    envPresetSel.addEventListener('change', () => {
      S.currentEnvPreset = envPresetSel.value;
      const preset = S.envMaps[S.currentEnvPreset];
      if (preset) {
        S.environmentMap = preset;
        if (['arctic','rendered'].includes(S.currentMode)) {
          S.scene.environment = S.environmentMap;
        }
        // Also update background if HDR bg mode is active
        const bgSel = document.getElementById('bg-type-select');
        if (bgSel?.value === 'hdr') applySceneBackground();
      }
    });
  }

  // ── Environment light intensity ──
  const slEnvInt    = document.getElementById('sl-env-intensity');
  const slEnvIntVal = document.getElementById('sl-env-intensity-val');
  if (slEnvInt) {
    slEnvInt.addEventListener('input', e => {
      const v = parseFloat(e.target.value);
      if (slEnvIntVal) slEnvIntVal.textContent = v.toFixed(2);
      updateSliderFill(e.target);
      if (S.scene) {
        S.scene.environmentIntensity = v;
        const bgType = document.getElementById('bg-type-select')?.value || 'solid';
        S.scene.backgroundIntensity = (bgType === 'hdr') ? v : 1.0;
      }
    });
    updateSliderFill(slEnvInt);
    bindSliderDblClickInput(slEnvInt, slEnvIntVal);
  }

  // ── HDR Background / Environment Rotation ──
  const slHdrRot    = document.getElementById('sl-hdr-rotation');
  const slHdrRotVal = document.getElementById('sl-hdr-rotation-val');
  if (slHdrRot) {
    slHdrRot.addEventListener('input', e => {
      const v = parseInt(e.target.value);
      if (slHdrRotVal) slHdrRotVal.textContent = v + '°';
      updateSliderFill(e.target);
      S.hdrRotation = v;
      const rad = (v * Math.PI) / 180;
      if (S.scene) {
        S.scene.backgroundRotation.y = rad;
        S.scene.environmentRotation.y = rad;
        S.scene.backgroundRotation.z = 0;
        S.scene.environmentRotation.z = 0;
      }
    });
    updateSliderFill(slHdrRot);
    bindSliderDblClickInput(slHdrRot, slHdrRotVal, '°');
  }

  // Legacy button-based env presets (no-op if no such elements in HTML)
  document.querySelectorAll('.env-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      S.currentEnvPreset = btn.dataset.preset;
      document.querySelectorAll('.env-preset-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (envPresetSel) envPresetSel.value = S.currentEnvPreset;
      const preset = S.envMaps[S.currentEnvPreset];
      if (preset) {
        S.environmentMap = preset;
        S.scene.environment = S.environmentMap;
        if (document.getElementById('bg-type-select')?.value === 'hdr') applySceneBackground();
      }
    });
  });

  // ── HDR file upload ──
  const hdrInput = document.getElementById('hdr-file-input');
  if (hdrInput) {
    hdrInput.addEventListener('change', e => {
      const file = e.target.files?.[0];
      if (!file) return;

      // Read custom HDR file as Base64 for embedding in saved session packages
      const reader = new FileReader();
      reader.onload = function(evt) {
        const dataUrl = evt.target.result;
        const base64Index = dataUrl.indexOf(';base64,');
        if (base64Index !== -1) {
          S.customHdrData = dataUrl.substring(base64Index + 8);
          S.customHdrName = file.name;
        }
      };
      reader.readAsDataURL(file);

      const url = URL.createObjectURL(file);
      const isExr = /\.exr$/i.test(file.name);
      const loaderPromise = isExr
        ? import('three/addons/loaders/EXRLoader.js').then(m => new m.EXRLoader())
        : Promise.resolve(new RGBELoader());
      const pmrem = new THREE.PMREMGenerator(S.renderer);
      pmrem.compileEquirectangularShader();
      loaderPromise.then(loader => loader.load(url, texture => {
        URL.revokeObjectURL(url);
        const envTexture = pmrem.fromEquirectangular(texture).texture;
        texture.dispose();
        pmrem.dispose();
        if (S.envMaps['hdr-custom']) S.envMaps['hdr-custom'].dispose();
        S.envMaps['hdr-custom'] = envTexture;
        S.environmentMap = envTexture;
        S.currentEnvPreset = 'hdr-custom';
        if (['arctic','rendered'].includes(S.currentMode)) S.scene.environment = S.environmentMap;
        // Enable the custom-HDR option and select it
        const hdrOpt = document.getElementById('opt-hdr-custom');
        if (hdrOpt) { hdrOpt.disabled = false; hdrOpt.textContent = 'Custom HDR'; }
        const envSel = document.getElementById('env-preset-select');
        if (envSel) envSel.value = 'hdr-custom';
        // Also update background if HDR bg mode
        if (document.getElementById('bg-type-select')?.value === 'hdr') applySceneBackground();
        document.querySelectorAll('.env-preset-btn').forEach(b => b.classList.remove('active'));
        document.querySelector('.env-preset-btn[data-preset="hdr-custom"]')?.classList.add('active');
      }, undefined, err => console.error('[HDR] load error', err)))
      .catch(err => console.error('[HDR] loader import error', err));
    });
  }

  const bindBgInput = (input, swatch) => {
    if (!input || !swatch) return;
    input.addEventListener('input', () => {
      swatch.style.background = input.value;
      applySceneBackground();
    });
  };
  bindBgInput(bgPanelC1, bgSwatchC1);
  bindBgInput(bgPanelC2, bgSwatchC2);
  bindBgInput(bgPanelC3, bgSwatchC3);
  bindBgInput(bgPanelC4, bgSwatchC4);

  // ── 4. Visibility checkboxes ──
  const updateModeSetting = (key, val) => {
    if (S.modeSettings && S.modeSettings[S.currentMode]) {
      S.modeSettings[S.currentMode][key] = val;
    }
  };

  document.getElementById('chk-edges-panel').addEventListener('change', e => {
    updateModeSetting('edges', e.target.checked);
    updateModeSetting('curves', e.target.checked); // curves follow edges check state
    applyDisplayMode();
  });
  document.getElementById('chk-shadows-panel').addEventListener('change', e => {
    S.shadowsEnabled = e.target.checked;
    updateModeSetting('shadows', e.target.checked);
    updateShadowCasting();
  });
  document.getElementById('chk-ground-panel').addEventListener('change', e => {
    S.groundEnabled = e.target.checked;
    updateModeSetting('ground', e.target.checked);
    if (S.groundEnabled && S.currentModel) {
      addGroundPlane(computeVisibleBoundingBox(S.currentModel));
    } else {
      removeGroundPlane();
    }
  });
  document.getElementById('chk-annotations-panel').addEventListener('change', e => {
    updateModeSetting('annotations', e.target.checked);
    // Route through updateLayerVisibility so the toggle honors layer visibility,
    // Rhino per-object hidden state, and the user hide-set — not just the
    // annotation checkbox. (updateLayerVisibility reads the checkbox itself.)
    updateLayerVisibility();
  });

  // Measurements visibility — toggles all completed-measurement objects, plus
  // any in-flight tool ghost. Pin markers are handled separately by the
  // Notes toggle so the two overlays can be turned on/off independently.
  document.getElementById('chk-measurements-panel')?.addEventListener('change', e => {
    const show = e.target.checked;
    S.measurementsVisible = show;
    if (S.measurementGroup) {
      S.measurementGroup.children.forEach(child => {
        const isNoteMarker = child.userData?.type === 'note-marker';
        if (!isNoteMarker) child.visible = show;
      });
    }
  });

  document.getElementById('chk-notes-panel')?.addEventListener('change', e => {
    const show = e.target.checked;
    S.notesVisible = show;
    for (const n of S.notes) {
      if (n.marker) n.marker.visible = show;
    }
    // Auto-close bubble when hiding
    if (!show && S.noteActiveId != null) {
      import('./notes-ui.js').then(m => m.hideBubble());
    }
  });

  const safeBindCheck = (id, targetId) => {
    const original = document.getElementById(id);
    const panelChk = document.getElementById(targetId);
    if (original && panelChk) {
      original.addEventListener('change', () => {
        panelChk.checked = original.checked;
        panelChk.dispatchEvent(new Event('change'));
      });
      panelChk.addEventListener('change', () => {
        original.checked = panelChk.checked;
      });
    }
  };
  safeBindCheck('chk-edge',        'chk-edges-panel');
  safeBindCheck('chk-shadows',     'chk-shadows-panel');
  safeBindCheck('chk-ground',      'chk-ground-panel');
  safeBindCheck('chk-annotations', 'chk-annotations-panel');

  // ── Edge Angle Slider ──
  const slEdgeAngle = document.getElementById('sl-edge-angle');
  const slEdgeAngleVal = document.getElementById('sl-edge-angle-val');
  if (slEdgeAngle) {
    updateSliderFill(slEdgeAngle);
    slEdgeAngle.addEventListener('input', e => {
      const val = parseInt(e.target.value);
      if (slEdgeAngleVal) slEdgeAngleVal.textContent = val + '°';
      updateSliderFill(e.target);
      // Exact edges re-filter in the shader, so they can follow the drag. Dihedral
      // edges still wait for 'change' — regenerating them per input event would
      // stall the drag on any model large enough to care.
      setEdgeAngleUniform(val);
    });
    slEdgeAngle.addEventListener('change', e => {
      const val = parseInt(e.target.value);
      recreateAllEdges(val);
    });
    bindSliderDblClickInput(slEdgeAngle, slEdgeAngleVal, '°');
  }

  // ── Annotation (imported Rhino dims/text/dots) size slider ──
  const slAnnotationScale = document.getElementById('sl-annotation-scale');
  const slAnnotationScaleVal = document.getElementById('sl-annotation-scale-val');
  if (slAnnotationScale) {
    updateSliderFill(slAnnotationScale);
    slAnnotationScale.addEventListener('input', e => {
      const v = parseFloat(e.target.value);
      if (slAnnotationScaleVal) slAnnotationScaleVal.textContent = v.toFixed(1) + 'x';
      updateSliderFill(e.target);
      // Affects ONLY imported Rhino annotations — the measurement tool uses S.measurementScale.
      S.annotationScale = v;
      createAnnotationSprites();
    });
    bindSliderDblClickInput(slAnnotationScale, slAnnotationScaleVal);
  }

  // ── 5. Lighting & damping sliders ──
  const slAmbient = document.getElementById('sl-ambient-panel');
  const slAmbientVal = document.getElementById('sl-ambient-val');
  if (slAmbient) {
    slAmbient.addEventListener('input', e => {
      const val = parseFloat(e.target.value);
      if (slAmbientVal) slAmbientVal.textContent = val.toFixed(2);
      updateSliderFill(e.target);
      S.scene.traverse(child => {
        if (child.isAmbientLight) child.intensity = val;
      });
    });
    bindSliderDblClickInput(slAmbient, slAmbientVal);
  }

  // AO intensity slider — wires the existing GTAOPass to the user-facing
  // value. Without this listener the slider was decorative: display.js's
  // per-mode hardcoded blendIntensity overrode any value the user set.
  const slAoInt = document.getElementById('sl-ao-intensity');
  const slAoIntVal = document.getElementById('sl-ao-intensity-val');
  if (slAoInt) {
    slAoInt.addEventListener('input', e => {
      const val = parseFloat(e.target.value);
      if (slAoIntVal) slAoIntVal.textContent = val.toFixed(2);
      updateSliderFill(e.target);
      if (S.gtaoPass) S.gtaoPass.blendIntensity = val;
    });
    updateSliderFill(slAoInt);
    bindSliderDblClickInput(slAoInt, slAoIntVal);
  }

  const chkSun       = document.getElementById('chk-sun-panel');
  const sunControls  = document.getElementById('sun-controls');
  const slAzimuth    = document.getElementById('sl-sun-azimuth');
  const slElevation  = document.getElementById('sl-sun-elevation');
  const slSunInt     = document.getElementById('sl-sun-intensity');

  chkSun?.addEventListener('change', () => {
    sunControls?.classList.toggle('hidden', !chkSun.checked);
    updateSunLight();
  });
  slAzimuth?.addEventListener('input', e => {
    document.getElementById('sl-sun-azimuth-val').textContent = Math.round(e.target.value) + '°';
    updateSliderFill(e.target);
    updateSunLight();
  });
  slElevation?.addEventListener('input', e => {
    document.getElementById('sl-sun-elevation-val').textContent = Math.round(e.target.value) + '°';
    updateSliderFill(e.target);
    updateSunLight();
  });
  slSunInt?.addEventListener('input', e => {
    document.getElementById('sl-sun-intensity-val').textContent = parseFloat(e.target.value).toFixed(2);
    updateSliderFill(e.target);
    updateSunLight();
  });
  if (slAzimuth) {
    updateSliderFill(slAzimuth);
    bindSliderDblClickInput(slAzimuth, 'sl-sun-azimuth-val', '°');
  }
  if (slElevation) {
    updateSliderFill(slElevation);
    bindSliderDblClickInput(slElevation, 'sl-sun-elevation-val', '°');
  }
  if (slSunInt) {
    updateSliderFill(slSunInt);
    bindSliderDblClickInput(slSunInt, 'sl-sun-intensity-val');
  }

  const slDamping = document.getElementById('sl-damping-panel');
  const slDampingVal = document.getElementById('sl-damping-val');
  if (slDamping) {
    slDamping.addEventListener('input', e => {
      const friction = parseFloat(e.target.value);
      if (slDampingVal) slDampingVal.textContent = friction.toFixed(2);
      updateSliderFill(e.target);
      S.controls.dampingFactor = 1.0 - friction;
      if (S.controls.dampingFactor < 0.005) S.controls.dampingFactor = 0.005;
    });
    bindSliderDblClickInput(slDamping, slDampingVal);
  }

  // ── 6. Dropdowns ──
  const dropdowns = [
    { btnId: 'btn-mode-dropdown',      menuId: 'mode-dropdown'      },
    { btnId: 'btn-view-dropdown',      menuId: 'view-dropdown'      },
    { btnId: 'btn-turntable-dropdown', menuId: 'turntable-dropdown' },
    { btnId: 'btn-select-dropdown',    menuId: 'select-dropdown'    },
    { btnId: 'btn-tools-dropdown',     menuId: 'tools-dropdown'     }
  ];
  dropdowns.forEach(dd => {
    const btn  = document.getElementById(dd.btnId);
    const menu = document.getElementById(dd.menuId);
    if (btn && menu) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const wasHidden = menu.classList.contains('hidden');
        dropdowns.forEach(other => {
          document.getElementById(other.menuId)?.classList.add('hidden');
        });
        if (wasHidden) menu.classList.remove('hidden');
      });
    }
  });
  document.addEventListener('click', () => {
    dropdowns.forEach(dd => document.getElementById(dd.menuId)?.classList.add('hidden'));
  });

  // ── Gumball Toggle ──
  const gumballBtn = document.getElementById('btn-gumball');
  gumballBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    // Hide all other dropdowns
    dropdowns.forEach(dd => document.getElementById(dd.menuId)?.classList.add('hidden'));

    S.gumballActive = !S.gumballActive;
    gumballBtn.classList.toggle('active', S.gumballActive);

    if (S.gumballActive) {
      document.getElementById('object-properties').classList.add('hidden');
      if (S.selectedObjects.length > 0) {
        setupGumballHelper();
      }
    } else {
      clearGumballHelper();
      if (S.selectedObjects.length > 0) {
        updatePropertiesPanel();
      }
    }
  });

  document.getElementById('mode-dropdown').querySelectorAll('.dropdown-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      changeDisplayMode(mode);
    });
  });

  // Stash for restoring the trigger button's pre-walkthrough icon/label.
  let savedTriggerSvgHtml = null;
  let savedTriggerLabel   = null;
  let savedTriggerTitle   = null;

  function updateViewTriggerForWalkthrough(on, walkItem) {
    const trigger = document.getElementById('btn-view-dropdown');
    if (!trigger) return;
    const triggerSvg   = trigger.querySelector('svg');
    const triggerLabel = trigger.querySelector('span');
    if (on) {
      // Save current state once on enter so we can restore on exit.
      if (!trigger.classList.contains('walkthrough-on')) {
        savedTriggerSvgHtml = triggerSvg ? triggerSvg.outerHTML : null;
        savedTriggerLabel   = triggerLabel ? triggerLabel.textContent : null;
        savedTriggerTitle   = trigger.title;
      }
      const walkSvg = walkItem.querySelector('svg').cloneNode(true);
      if (triggerSvg) trigger.replaceChild(walkSvg, triggerSvg);
      if (triggerLabel) triggerLabel.textContent = walkItem.querySelector('span').textContent;
      trigger.title = 'Walkthrough (active) — Esc to exit';
      trigger.classList.add('walkthrough-on');
    } else {
      if (savedTriggerSvgHtml && triggerSvg) {
        const tmp = document.createElement('div');
        tmp.innerHTML = savedTriggerSvgHtml;
        const newSvg = tmp.firstElementChild;
        if (newSvg) trigger.replaceChild(newSvg, triggerSvg);
      }
      if (savedTriggerLabel != null && triggerLabel) triggerLabel.textContent = savedTriggerLabel;
      if (savedTriggerTitle != null) trigger.title = savedTriggerTitle;
      trigger.classList.remove('walkthrough-on');
    }
  }

  document.getElementById('view-dropdown').querySelectorAll('.dropdown-item').forEach(btn => {
    if (btn.dataset.view) {
      btn.addEventListener('click', () => {
        const view = btn.dataset.view;
        const dropdown = document.getElementById('view-dropdown');

        if (view === 'walkthrough') {
          // Toggle walkthrough on/off; clicking the same item again exits.
          // The 'walkthrough-changed' event listener handles the trigger
          // button visual + dropdown active-class sync (one code path for
          // all entry routes: click, Esc, programmatic).
          setWalkthroughMode(!S.walkthroughActive);
          return;
        }

        // Clicking any other preset while walking → exit walkthrough first.
        if (S.walkthroughActive) setWalkthroughMode(false);

        setViewPreset(view);
        const label = btn.querySelector('span').textContent.split(' ')[0];
        const triggerBtn = document.getElementById('btn-view-dropdown');
        triggerBtn.querySelector('span').textContent = label;
        triggerBtn.title = `View Preset (${label})`;

        // Dynamically replace trigger button icon with selected view's icon
        const svg = btn.querySelector('svg').cloneNode(true);
        const oldSvg = triggerBtn.querySelector('svg');
        if (oldSvg) {
          triggerBtn.replaceChild(svg, oldSvg);
        }
      });
    }
  });

  // Hide the Walkthrough item on touch-primary devices (no keyboard / no
  // mouse drag distinction). v1 ships desktop-only; mobile support is a
  // separate UX problem (virtual joystick + swipe).
  if (matchMedia('(hover: none)').matches) {
    document.querySelectorAll('#view-dropdown .walkthrough-item').forEach(el => {
      el.style.display = 'none';
    });
  }

  // Whenever walkthrough exits via *non-dropdown* paths (Esc key, programmatic),
  // the trigger button still needs its icon/label restored. We listen on a
  // custom event dispatched from setWalkthroughMode().
  window.addEventListener('walkthrough-changed', (e) => {
    const trigger = document.getElementById('btn-view-dropdown');
    if (!trigger) return;
    const walkItem = document.querySelector('#view-dropdown .dropdown-item[data-view="walkthrough"]');
    if (!walkItem) return;
    if (e.detail.active) {
      updateViewTriggerForWalkthrough(true, walkItem);
    } else if (trigger.classList.contains('walkthrough-on')) {
      updateViewTriggerForWalkthrough(false, walkItem);
    }
    document.querySelectorAll('#view-dropdown .dropdown-item').forEach(b => {
      if (b.dataset.view === 'walkthrough') b.classList.toggle('active', e.detail.active);
    });
  });

  // Named view dialog
  const saveViewBtn  = document.getElementById('btn-save-named-view');
  const namedViewDlg = document.getElementById('named-view-dialog');
  const nameInput    = document.getElementById('input-named-view-name');

  const openNamedViewDialog = () => {
    if (!namedViewDlg) return;
    nameInput.value = '';
    namedViewDlg.classList.remove('hidden');
    document.getElementById('view-dropdown')?.classList.add('hidden');
    requestAnimationFrame(() => nameInput.focus());
  };
  const closeNamedViewDialog = () => namedViewDlg?.classList.add('hidden');
  const confirmNamedView = () => {
    const name = nameInput?.value.trim();
    if (name) saveCustomView(name);
    closeNamedViewDialog();
  };

  saveViewBtn?.addEventListener('click', (e) => { e.stopPropagation(); openNamedViewDialog(); });
  document.getElementById('btn-close-named-view-dialog')?.addEventListener('click', closeNamedViewDialog);
  document.getElementById('btn-cancel-named-view')?.addEventListener('click', closeNamedViewDialog);
  document.getElementById('btn-confirm-named-view')?.addEventListener('click', confirmNamedView);
  nameInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); confirmNamedView(); }
    if (e.key === 'Escape') { e.preventDefault(); closeNamedViewDialog(); }
  });
  namedViewDlg?.addEventListener('click', (e) => { if (e.target === namedViewDlg) closeNamedViewDialog(); });

  // Save As Dialog
  const saveAsDlg   = document.getElementById('save-as-dialog');
  const saveAsInput = document.getElementById('input-save-as-name');

  function openSaveAsDialog() {
    if (!saveAsDlg) return;
    saveAsInput.value = S.currentFileName || 'scene';
    saveAsDlg.classList.remove('hidden');
    requestAnimationFrame(() => {
      saveAsInput.focus();
      saveAsInput.select();
    });
  }
  function closeSaveAsDialog() {
    saveAsDlg?.classList.add('hidden');
  }
  function confirmSaveAs() {
    const name = saveAsInput?.value.trim();
    if (name) {
      saveSession(name, true);
      closeSaveAsDialog();
    } else {
      alert('Please enter a valid file name.');
    }
  }

  document.getElementById('btn-close-save-as-dialog')?.addEventListener('click', closeSaveAsDialog);
  document.getElementById('btn-cancel-save-as')?.addEventListener('click', closeSaveAsDialog);
  document.getElementById('btn-confirm-save-as')?.addEventListener('click', confirmSaveAs);
  saveAsInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); confirmSaveAs(); }
    if (e.key === 'Escape') { e.preventDefault(); closeSaveAsDialog(); }
  });
  saveAsDlg?.addEventListener('click', (e) => { if (e.target === saveAsDlg) closeSaveAsDialog(); });

  document.getElementById('btn-zoom-extents').addEventListener('click', () => {
    if (!S.currentModel) return;
    const box = new THREE.Box3();
    S.currentModel.traverse(child => {
      if (child.isMesh && child.visible &&
          child.name !== 'rhino-edges' && child.name !== 'rhino-outline' &&
          child.name !== 'selection-outline' && child.name !== 'ground-plane') {
        box.expandByObject(child);
      }
    });
    if (!box.isEmpty()) fitCameraToBox(box, true, true);
    else fitCameraToObject(S.currentModel, true, true);
  });
  document.getElementById('btn-zoom-selected').addEventListener('click', fitCameraToSelected);

  // ── Turntable ──
  let ttContinuous = false;
  const ttToggleBtn  = document.getElementById('btn-tt-toggle');
  const springSlider = document.getElementById('tt-spring-slider');
  const springVal    = document.getElementById('tt-spring-val');
  const ttDropdown   = document.getElementById('turntable-dropdown');
  const ttTriggerBtn = document.getElementById('btn-turntable-dropdown');

  // Prevent clicks INSIDE the turntable dropdown from closing it.
  // The global document click handler closes all dropdowns; stopping
  // propagation here ensures clicks on the toggle/slider don't close it.
  ttDropdown?.addEventListener('click', e => e.stopPropagation());

  const setTurntable = (on) => {
    ttContinuous = on;
    if (ttToggleBtn) {
      ttToggleBtn.classList.toggle('active', on);
      ttToggleBtn.textContent = on ? t('turntable.on') : t('turntable.off');
    }
    // Tint the toolbar Turn button when auto-rotate is active
    if (ttTriggerBtn) ttTriggerBtn.classList.toggle('active', on);
    if (!on) {
      // Turning off: reset slider and stop rotation
      springSlider.value = 0;
      springVal.textContent = '0.0';
      updateSliderFill(springSlider);
      S.controls.autoRotate = false;
      S.controls.autoRotateSpeed = 0;
    }
    // Turning on: keep current slider value — speed 0 means no rotation yet
  };
  ttToggleBtn?.addEventListener('click', () => {
    setTurntable(!ttContinuous);
    // Don't close dropdown on toggle — user needs speed slider
  });

  springSlider?.addEventListener('input', () => {
    const speed = parseFloat(springSlider.value);
    springVal.textContent = (speed >= 0 ? '+' : '') + speed.toFixed(1);
    updateSliderFill(springSlider);
    // Speed 0 always means no rotation, regardless of continuous state
    if (speed === 0) {
      S.controls.autoRotate = false;
      S.controls.autoRotateSpeed = 0;
    } else {
      S.controls.autoRotate = true;
      S.controls.autoRotateSpeed = speed * 4.0; // negative = counter-clockwise
    }
  });
  const resetSpringSlider = () => {
    // Continuous ON: keep the set speed (no spring-back)
    if (ttContinuous) return;
    // Continuous OFF: spring back to 0 and stop
    if (springSlider) { springSlider.value = 0; updateSliderFill(springSlider); }
    if (springVal) springVal.textContent = '0.0';
    S.controls.autoRotate = false;
    S.controls.autoRotateSpeed = 0;
  };
  springSlider?.addEventListener('pointerup',     resetSpringSlider);
  springSlider?.addEventListener('pointercancel', resetSpringSlider);
  springSlider?.addEventListener('change',        resetSpringSlider);

  // ── Select mode ──
  document.getElementById('select-dropdown').querySelectorAll('.dropdown-item').forEach(btn => {
    btn.addEventListener('click', () => {
      S.selectMode = btn.dataset.select;
      document.getElementById('select-dropdown').querySelectorAll('.dropdown-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const label = btn.querySelector('span').textContent.split(' ')[0];
      const triggerBtn = document.getElementById('btn-select-dropdown');
      triggerBtn.querySelector('span').textContent = `Select: ${label}`;
      triggerBtn.title = `Selection Mode (${label})`;
      updateSelectIcon(S.selectMode);
      if (S.selectMode === 'none') { clearSelection(); updatePropertiesPanel(); }
    });
  });

  // ── Show/hide ──
  document.getElementById('btn-show-all').addEventListener('click', () => {
    // Reveal both viewer-side hides AND Rhino's per-object hidden objects,
    // matching Rhino's Show command. revealHidden is reset on the next load.
    S.hiddenObjects.forEach(obj => { obj.visible = true; });
    S.hiddenObjects.clear();
    S.revealHidden = true;
    updateLayerVisibility();
  });
  document.getElementById('btn-hide-selected').addEventListener('click', () => {
    S.selectedObjects.forEach(child => { child.visible = false; S.hiddenObjects.add(child); });
    clearSelection();
    updatePropertiesPanel();
  });
  document.getElementById('btn-isolate-selected').addEventListener('click', () => {
    if (!S.selectedObjects.length || !S.currentModel) return;
    
    const isNodeOrAncestorSelected = (node) => {
      let curr = node;
      while (curr) {
        if (S.selectedObjects.includes(curr)) return true;
        curr = curr.parent;
      }
      return false;
    };

    S.currentModel.traverse(child => {
      if (child.name === 'rhino-edges' || child.name === 'rhino-outline' || child.name === 'selection-outline' || child.name === 'ground-plane') return;

      const isCandidate = child.isMesh || child.isLine || child.isLineSegments || (child.parent === S.annotationGroup);
      if (isCandidate) {
        if (!isNodeOrAncestorSelected(child)) {
          child.visible = false;
          S.hiddenObjects.add(child);
        }
      }
    });
    updatePropertiesPanel();
  });


  // ── 7. Tools ──
  document.getElementById('btn-tool-distance').addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('tools-dropdown').classList.add('hidden');
    if (S.distanceToolState) {
      S.distanceToolState = null;
      if (S.distanceGhostSphere) {
        if (S.distanceGhostSphere.geometry) S.distanceGhostSphere.geometry.dispose();
        if (S.distanceGhostSphere.material) S.distanceGhostSphere.material.dispose();
        S.measurementGroup.remove(S.distanceGhostSphere);
        S.distanceGhostSphere = null;
      }
      document.getElementById('canvas-container').style.cursor = '';
      document.getElementById('btn-tool-distance').classList.remove('active');
      renderMeasurementListUI();
      updateToolsDropdownActiveState();
      return;
    }
    deactivateAllTools();
    S.distanceToolState = { points: [], spheres: [] };
    document.getElementById('btn-tool-distance').classList.add('active');
    document.getElementById('canvas-container').style.cursor = 'crosshair';
    renderMeasurementListUI();
    updateToolsDropdownActiveState();
  });

  document.getElementById('btn-tool-angle').addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('tools-dropdown').classList.add('hidden');
    if (S.angleToolState) {
      deactivateAllTools();
      renderMeasurementListUI();
      return;
    }
    deactivateAllTools();
    S.angleToolState = { points: [], spheres: [] };
    document.getElementById('btn-tool-angle').classList.add('active');
    document.getElementById('canvas-container').style.cursor = 'crosshair';
    renderMeasurementListUI();
    updateToolsDropdownActiveState();
  });

  document.getElementById('btn-tool-note')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    document.getElementById('tools-dropdown').classList.add('hidden');
    const { activateNoteTool, deactivateNoteTool } = await import('./notes.js');
    if (S.noteToolState) {
      deactivateNoteTool();
      updateToolsDropdownActiveState();
      return;
    }
    deactivateAllTools();
    activateNoteTool();
    updateToolsDropdownActiveState();
  });

  document.getElementById('btn-tool-clipping').addEventListener('click', (e) => {
    e.stopPropagation();
    deactivateAllTools();
    document.getElementById('clipping-panel').classList.remove('hidden');
    document.getElementById('btn-tool-clipping').classList.add('active');
    document.getElementById('tools-dropdown').classList.add('hidden');
    // Always force turn On when opening the tool panel
    setClippingToggle(true);
  });

  document.getElementById('btn-tool-find').addEventListener('click', (e) => {
    e.stopPropagation();
    deactivateAllTools();
    document.getElementById('find-panel').classList.remove('hidden');
    document.getElementById('btn-tool-find').classList.add('active');
    document.getElementById('tools-dropdown').classList.add('hidden');
    updateToolsDropdownActiveState();
  });

  // Color Adjustment moved to Settings panel — no floating popup anymore

  const setupSafeClose = (btnId, callback) => {
    const btn = document.getElementById(btnId);
    if (btn) {
      let triggered = false;
      const handler = (e) => {
        e.preventDefault(); e.stopPropagation();
        if (!triggered) {
          triggered = true;
          callback();
          setTimeout(() => { triggered = false; }, 300);
        }
      };
      btn.addEventListener('click',      handler);
      btn.addEventListener('pointerdown', handler);
      btn.addEventListener('touchstart',  handler, { passive: false });
    }
  };
  setupSafeClose('btn-close-clipping', () => {
    document.getElementById('clipping-panel').classList.add('hidden');
    document.getElementById('btn-tool-clipping').classList.toggle('active', !!S.clippingToggleOn);
    // Only deactivate helper if clipping is Off (keep visible if On)
    if (!S.clippingToggleOn) {
      deactivateClippingHelper();
    }
    updateToolsDropdownActiveState();
  });
  setupSafeClose('btn-close-find', () => {
    document.getElementById('find-panel').classList.add('hidden');
    document.getElementById('btn-tool-find').classList.remove('active');
    updateToolsDropdownActiveState();
  });
  setupSafeClose('btn-close-measurements', () => {
    deactivateAllTools();
    document.getElementById('measurement-list-panel').classList.add('hidden');
  });
  // Color panel removed — color adj is now inline in Settings
  document.getElementById('btn-measure-clear-all')?.addEventListener('click', () => clearMeasurements());

  // ── Measurement text & line scale slider ──
  const slMeasureScale = document.getElementById('sl-measure-scale');
  const slMeasureScaleVal = document.getElementById('sl-measure-scale-val');
  if (slMeasureScale) {
    slMeasureScale.addEventListener('input', e => {
      const v = parseFloat(e.target.value);
      if (slMeasureScaleVal) slMeasureScaleVal.textContent = v.toFixed(1) + 'x';
      updateSliderFill(e.target);
      // Text Size affects ONLY the Distance/Angle measurement tool — not the
      // imported Rhino annotations (dimensions/text/dots), which keep their own scale.
      S.measurementScale = v;
      updateMeasurementScales();
      import('./notes.js').then(m => m.refreshAllNoteScales?.());
    });
    updateSliderFill(slMeasureScale);
    bindSliderDblClickInput(slMeasureScale, slMeasureScaleVal);
  }

  // ── Measurement panel tab selectors ──
  document.getElementById('btn-measure-tab-dist')?.addEventListener('click', () => {
    if (S.distanceToolState) return;
    deactivateAllTools();
    S.distanceToolState = { points: [], spheres: [] };
    document.getElementById('canvas-container').style.cursor = 'crosshair';
    renderMeasurementListUI();
    updateToolsDropdownActiveState();
  });
  document.getElementById('btn-measure-tab-angle')?.addEventListener('click', () => {
    if (S.angleToolState) return;
    deactivateAllTools();
    S.angleToolState = { points: [], spheres: [] };
    document.getElementById('canvas-container').style.cursor = 'crosshair';
    renderMeasurementListUI();
    updateToolsDropdownActiveState();
  });
  setupSafeClose('btn-close-props', () => {
    document.getElementById('object-properties').classList.add('hidden');
    clearSelection();
  });

  // ── Draggable measurement panel ──
  ;(function() {
    const panel  = document.getElementById('measurement-list-panel');
    const handle = panel?.querySelector('.measure-drag-handle');
    if (!panel || !handle) return;
    let dragging = false, ox = 0, oy = 0;
    handle.addEventListener('pointerdown', e => {
      if (e.target.closest('button')) return;
      dragging = true;
      const rect = panel.getBoundingClientRect();
      ox = e.clientX - rect.left; oy = e.clientY - rect.top;
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    handle.addEventListener('pointermove', e => {
      if (!dragging) return;
      const x = Math.max(0, Math.min(window.innerWidth  - panel.offsetWidth,  e.clientX - ox));
      const y = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, e.clientY - oy));
      panel.style.left = x + 'px'; panel.style.top = y + 'px';
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
    });
    handle.addEventListener('pointerup',     () => { dragging = false; });
    handle.addEventListener('pointercancel', () => { dragging = false; });
  })();

  // ── Draggable properties panel ──
  ;(function() {
    const panel  = document.getElementById('object-properties');
    const handle = document.getElementById('prop-drag-handle');
    if (!panel || !handle) return;
    let dragging = false, ox = 0, oy = 0;
    const onDown = e => {
      if (e.target.closest('button')) return;
      dragging = true;
      const rect = panel.getBoundingClientRect();
      ox = e.clientX - rect.left; oy = e.clientY - rect.top;
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    };
    const onMove = e => {
      if (!dragging) return;
      const x = Math.max(0, Math.min(window.innerWidth  - panel.offsetWidth,  e.clientX - ox));
      const y = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, e.clientY - oy));
      panel.style.left = x + 'px'; panel.style.top = y + 'px'; panel.style.right = 'auto';
    };
    const onUp = () => { dragging = false; };
    handle.addEventListener('pointerdown',   onDown);
    handle.addEventListener('pointermove',   onMove);
    handle.addEventListener('pointerup',     onUp);
    handle.addEventListener('pointercancel', onUp);
  })();

  // ── Draggable find panel ──
  ;(function() {
    const panel  = document.getElementById('find-panel');
    const handle = panel?.querySelector('.cg-header');
    if (!panel || !handle) return;
    let dragging = false, ox = 0, oy = 0;
    handle.addEventListener('pointerdown', e => {
      if (e.target.closest('button,input,select')) return;
      dragging = true;
      const rect = panel.getBoundingClientRect();
      ox = e.clientX - rect.left; oy = e.clientY - rect.top;
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    handle.addEventListener('pointermove', e => {
      if (!dragging) return;
      const x = Math.max(0, Math.min(window.innerWidth  - panel.offsetWidth,  e.clientX - ox));
      const y = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, e.clientY - oy));
      panel.style.left = x + 'px'; panel.style.top = y + 'px';
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
    });
    handle.addEventListener('pointerup',     () => { dragging = false; });
    handle.addEventListener('pointercancel', () => { dragging = false; });
  })();

  // ── Layer toggle-all ──
  document.getElementById('btn-toggle-all-layers-panel')?.addEventListener('click', () => {
    const anyOff = S.parsedLayers.some(l => !l.visible);
    S.parsedLayers.forEach(l => l.visible = anyOff);
    renderLayerUI();
    updateLayerVisibility();
    createAnnotationSprites();
  });

  // ── 8. Clipping plane ──
  function deactivateClippingHelper() {
    if (S.clippingTransformControls) {
      S.clippingTransformControls.detach();
      S.clippingTransformControls.getHelper().visible = false;
    }
    // Clean up arc handles from overlay scene
    S.clippingArcHandles.forEach(h => {
      S.arcOverlayScene?.remove(h.mesh);
      S.arcOverlayScene?.remove(h.hitMesh);
      if (h.mesh.geometry) h.mesh.geometry.dispose();
      if (h.mesh.material) h.mesh.material.dispose();
      if (h.hitMesh.geometry) h.hitMesh.geometry.dispose();
      if (h.hitMesh.material) h.hitMesh.material.dispose();
    });
    if (S.clippingHelper) {
      S.arcOverlayScene?.remove(S.clippingHelper);
      S.clippingHelper = null;
    }
    S.clippingArcHandles = [];
    S.clippingArcDrag = null;
  }
  window.deactivateClippingHelper = deactivateClippingHelper;

  function updateToolsDropdownActiveState() {
    const isDistanceActive = S.distanceToolState !== null && S.distanceToolState !== undefined;
    const isAngleActive = S.angleToolState !== null && S.angleToolState !== undefined;
    const isFindActive = !document.getElementById('find-panel')?.classList.contains('hidden');
    const isClippingActive = !!S.clippingToggleOn;
    const isNoteActive = S.noteToolState !== null && S.noteToolState !== undefined;

    const anyActive = isDistanceActive || isAngleActive || isFindActive || isClippingActive || isNoteActive;
    document.getElementById('btn-tools-dropdown')?.classList.toggle('active', anyActive);
    document.getElementById('btn-tool-clipping')?.classList.toggle('active', isClippingActive);
    document.getElementById('btn-tool-note')?.classList.toggle('active', isNoteActive);
  }
  window.updateToolsDropdownActiveState = updateToolsDropdownActiveState;

  function setClippingToggle(on) {
    S.clippingToggleOn = on;
    const toggleBtn = document.getElementById('btn-clip-toggle');
    if (toggleBtn) {
      toggleBtn.classList.toggle('active', on);
      toggleBtn.textContent = on ? t('clip.on') : t('clip.off');
    }

    S.renderer.clippingPlanes = on ? [S.clippingPlane] : [];
    S.clippingEnabled = on;

    if (on) {
      if (!S.clippingHasBeenInitialized) {
        updateClippingPlane();
        S.clippingHasBeenInitialized = true;
      }
      const panelVisible = !document.getElementById('clipping-panel').classList.contains('hidden');
      if (panelVisible) {
        setupClippingHelper();
      }
      if (S.clippingCapEnabled) buildClippingCap();
    } else {
      deactivateClippingHelper();
      destroyClippingCap();
    }
    updateToolsDropdownActiveState();
  }
  window.setClippingToggle = setClippingToggle;

  function setClippingActive(active) {
    S.clippingEnabled = active;
    S.renderer.clippingPlanes = active ? [S.clippingPlane] : [];
    if (active) {
      if (!S.clippingHasBeenInitialized) {
        updateClippingPlane();
        S.clippingHasBeenInitialized = true;
      }
      setupClippingHelper();
      if (S.clippingCapEnabled) buildClippingCap();
    } else {
      deactivateClippingHelper();
      destroyClippingCap();
    }
  }
  window.setClippingActive = setClippingActive;

  // ── Draggable clipping panel ──
  ;(function() {
    const panel  = document.getElementById('clipping-panel');
    const handle = panel?.querySelector('.cg-header');
    if (!panel || !handle) return;
    let ox=0, oy=0, dragging=false;
    handle.addEventListener('pointerdown', e => {
      if (e.target.closest('button,input,select')) return;
      dragging=true; handle.setPointerCapture(e.pointerId);
      const r = panel.getBoundingClientRect();
      ox = e.clientX - r.left; oy = e.clientY - r.top;
      handle.style.cursor = 'grabbing';
    });
    handle.addEventListener('pointermove', e => {
      if (!dragging) return;
      const x = Math.max(0, Math.min(window.innerWidth  - panel.offsetWidth,  e.clientX - ox));
      const y = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, e.clientY - oy));
      panel.style.left = x + 'px'; panel.style.top = y + 'px';
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
    });
    handle.addEventListener('pointerup', () => { dragging=false; handle.style.cursor='grab'; });
  })();

  const applyClipAxisUI = () => {
    document.querySelectorAll('.clip-axis-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.axis === S.clipAxis);
    });

    if (!S.clippingHelper) {
      // No gizmo yet — fall back to world-axis defaults
      const normals = {
        z:  [0,  180], zf: [0,    0],
        y:  [-90,  0], yf: [ 90,  0],
        x:  [0,  -90], xf: [0,   90]
      };
      const key = S.clipAxis + (S.clipFlipped ? 'f' : '');
      const [rx, ry] = normals[key];
      const cp = document.getElementById('clipping-panel');
      if (cp) { cp.dataset.rotX = rx; cp.dataset.rotY = ry; }
      updateClippingPlane();
      return;
    }

    // ── Gizmo exists: derive normal from the base quaternion ──
    const qBase = S.clippingBaseQuaternion || S.clippingHelper.quaternion.clone();
    if (!S.clippingBaseQuaternion) {
      S.clippingBaseQuaternion = qBase.clone();
    }
    const Lx = new THREE.Vector3(1, 0, 0).applyQuaternion(qBase).normalize();
    const Ly = new THREE.Vector3(0, 1, 0).applyQuaternion(qBase).normalize();
    const Lz = new THREE.Vector3(0, 0, 1).applyQuaternion(qBase).normalize();

    let targetX, targetY, targetZ;
    if (S.clipAxis === 'x') {
      targetZ = Lx;
      targetX = Lz.clone().negate();
      targetY = Ly;
    } else if (S.clipAxis === 'y') {
      targetZ = Ly;
      targetX = Lx;
      targetY = Lz.clone().negate();
    } else {
      targetZ = Lz;
      targetX = Lx;
      targetY = Ly;
    }

    const mat = new THREE.Matrix4();
    mat.makeBasis(targetX, targetY, targetZ);
    S.clippingHelper.quaternion.setFromRotationMatrix(mat);

    // Derive normal from targetZ, negating if clipFlipped is active
    const worldNormal = targetZ.clone();
    if (S.clipFlipped) worldNormal.negate();

    // Update clipping plane normal and constant
    S.clippingPlane.normal.copy(worldNormal);
    S.clippingPlane.constant = -worldNormal.dot(S.clippingHelper.position);

    // Sync arc handles to the new gizmo orientation
    S.clippingHelper.updateMatrixWorld(true);
    if (S.clippingArcHandles) {
      S.clippingArcHandles.forEach(h => {
        h.mesh.position.copy(S.clippingHelper.position);
        h.mesh.quaternion.copy(S.clippingHelper.quaternion);
        h.hitMesh.position.copy(S.clippingHelper.position);
        h.hitMesh.quaternion.copy(S.clippingHelper.quaternion);
      });
    }

    // Refresh TransformControls
    if (S.clippingTransformControls) {
      S.clippingTransformControls.detach();
      S.clippingTransformControls.attach(S.clippingHelper);
      applyClipWidgetVisibility();
    }

    // Save actual pose in state
    if (!S.clippingPosition) S.clippingPosition = new THREE.Vector3();
    S.clippingPosition.copy(S.clippingHelper.position);
    if (!S.clippingQuaternion) S.clippingQuaternion = new THREE.Quaternion();
    S.clippingQuaternion.copy(S.clippingHelper.quaternion);
  };

  document.getElementById('btn-clip-toggle')?.addEventListener('click', () => {
    setClippingToggle(!S.clippingToggleOn);
  });

  document.querySelectorAll('.clip-axis-btn[data-axis]').forEach(btn => {
    btn.addEventListener('click', () => { S.clipAxis = btn.dataset.axis; applyClipAxisUI(); });
  });

  document.getElementById('btn-clip-flip')?.addEventListener('click', () => {
    S.clipFlipped = !S.clipFlipped;
    if (S.clippingHelper && S.clippingEnabled) {
      // ── Flip only reverses the cut side — do NOT move or rotate the gizmo ──
      // Negate the normal: same plane geometry, opposite clipping direction
      S.clippingPlane.normal.negate();
      // Recalculate constant to keep the plane at the exact same position
      S.clippingPlane.constant = -S.clippingPlane.normal.dot(S.clippingHelper.position);

      // Save pose!
      if (!S.clippingPosition) S.clippingPosition = new THREE.Vector3();
      S.clippingPosition.copy(S.clippingHelper.position);
      if (!S.clippingQuaternion) S.clippingQuaternion = new THREE.Quaternion();
      S.clippingQuaternion.copy(S.clippingHelper.quaternion);
    } else {
      applyClipAxisUI();
    }
  });

  document.getElementById('btn-clip-reset')?.addEventListener('click', () => {
    // 1. Reset toggle state to true
    setClippingToggle(true);

    // 2. Reset all state variables
    S.clipAxis = 'z';
    S.clipFlipped = false;
    S.clippingBaseQuaternion = null;
    S.clippingHasBeenInitialized = false;
    S.clippingPosition = null;
    S.clippingQuaternion = null;

    // 3. Reset dataset rotations to Z-axis world default
    const cp = document.getElementById('clipping-panel');
    if (cp) {
      cp.dataset.rotX = "0";
      cp.dataset.rotY = "180";
    }

    // 4. Reset height slider to 0 (centered)
    const heightSlider = document.getElementById('clip-height');
    if (heightSlider) {
      heightSlider.value = 0;
      updateSliderFill(heightSlider);
    }

    // 4b. Reset widget visibility + grid size to defaults
    S.clipGridVisible = true;
    S.clipGizmoVisible = true;
    S.clipGridScale = 1.0;
    document.getElementById('btn-clip-grid-toggle')?.classList.add('active');
    document.getElementById('btn-clip-gizmo-toggle')?.classList.add('active');
    const gridSizeSlider = document.getElementById('clip-grid-size');
    if (gridSizeSlider) gridSizeSlider.value = 1.0;
    const gridSizeVal = document.getElementById('clip-grid-size-val');
    if (gridSizeVal) gridSizeVal.textContent = '1.0x';

    // 5. Re-activate clipping fresh from scratch!
    setClippingActive(true);

    // 6. Update UI active states
    document.querySelectorAll('.clip-axis-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.axis === 'z');
    });
  });

  // ── Cap fill toggle ──
  document.getElementById('btn-clip-cap-toggle')?.addEventListener('click', () => {
    const on = !S.clippingCapEnabled;
    setClippingCapEnabled(on);
    const btn = document.getElementById('btn-clip-cap-toggle');
    if (btn) { btn.classList.toggle('active', on); btn.textContent = on ? t('clip.on') : t('clip.off'); }
  });

  // ── Cap fill color ──
  document.getElementById('clip-cap-color')?.addEventListener('input', e => {
    const hex = e.target.value;
    if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
      setClippingCapColor(hex);
      e.target.style.background = hex;
    }
  });
  // Coloris picks up 'coloris:pick' on the element
  document.getElementById('clip-cap-color')?.addEventListener('coloris:pick', e => {
    setClippingCapColor(e.detail.color);
    e.target.style.background = e.detail.color;
  });

  // ── Grid widget toggle (grid lines + rotation arcs) ──
  document.getElementById('btn-clip-grid-toggle')?.addEventListener('click', e => {
    S.clipGridVisible = !S.clipGridVisible;
    e.currentTarget.classList.toggle('active', S.clipGridVisible);
    applyClipWidgetVisibility();
  });

  // ── Move widget toggle (translate gizmo) ──
  document.getElementById('btn-clip-gizmo-toggle')?.addEventListener('click', e => {
    S.clipGizmoVisible = !S.clipGizmoVisible;
    e.currentTarget.classList.toggle('active', S.clipGizmoVisible);
    applyClipWidgetVisibility();
  });

  // ── Grid size slider ──
  const clipGridSizeSlider = document.getElementById('clip-grid-size');
  if (clipGridSizeSlider) {
    clipGridSizeSlider.addEventListener('input', e => {
      S.clipGridScale = parseFloat(e.target.value);
      const valEl = document.getElementById('clip-grid-size-val');
      if (valEl) valEl.textContent = S.clipGridScale.toFixed(1) + 'x';
      rebuildClippingGrid();
    });
  }

  // ── 9. Object search (live) ──
  const findInput = document.getElementById('find-search-input');
  const findBtn   = document.getElementById('btn-find-search');
  if (findInput) {
    findInput.addEventListener('input', () => {
      const query = findInput.value.trim();
      clearSelection();
      if (!S.currentModel || !query) { updatePropertiesPanel(); return; }
      S.currentModel.traverse(child => {
        if (!(child.isMesh || child.isLine || child.isLineSegments)) return;
        if (child.name === 'rhino-edges' || child.name === 'rhino-outline' ||
            child.name === 'selection-outline' || child.name === 'ground-plane') return;
        const name = child.userData?.attributes?.name || child.name || '';
        if (name.toLowerCase().includes(query.toLowerCase())) {
          S.selectedObjects.push(child);
          addSelectionOutline(child);
        }
      });
      updatePropertiesPanel();
    });
    findInput.addEventListener('keydown', e => {
      if (e.key === 'Escape') { findInput.value = ''; clearSelection(); updatePropertiesPanel(); }
    });
  }
  if (findBtn) findBtn.addEventListener('click', () => findInput?.dispatchEvent(new Event('input')));

  document.getElementById('btn-cg-reset').addEventListener('click', () => {
    ['exposure','contrast','saturation','temperature'].forEach(k => {
      const slider = document.getElementById('cg-' + k);
      if (slider) {
        slider.value = 0;
        document.getElementById('cg-' + k + '-val').textContent = '0.0';
        S.cgPass.uniforms['u' + k.charAt(0).toUpperCase() + k.slice(1)].value = 0;
        updateSliderFill(slider);
      }
    });
  });
  const cgSliders = [
    { id: 'cg-exposure',    uniform: 'uExposure'    },
    { id: 'cg-contrast',    uniform: 'uContrast'    },
    { id: 'cg-saturation',  uniform: 'uSaturation'  },
    { id: 'cg-temperature', uniform: 'uTemperature' }
  ];
  cgSliders.forEach(({ id, uniform }) => {
    const slider = document.getElementById(id);
    if (slider) {
      slider.addEventListener('input', e => {
        const v = parseFloat(e.target.value);
        document.getElementById(id + '-val').textContent = (v >= 0 ? '+' : '') + v.toFixed(2);
        S.cgPass.uniforms[uniform].value = v;
        updateSliderFill(e.target);
      });
      bindSliderDblClickInput(slider, id + '-val');
    }
  });

  // ── 11. Canvas pointer events ──
  // Helper: raycast against arc hit meshes
  function hitTestArcHandles(clientX, clientY) {
    if (!S.clippingHelper || !S.clippingEnabled || S.clippingArcHandles.length === 0) return null;
    if (S.clipGizmoVisible === false) return null;  // arcs hidden with Gumball → not interactive
    const mouse = new THREE.Vector2(
      (clientX / window.innerWidth) * 2 - 1,
      -(clientY / window.innerHeight) * 2 + 1
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, S.camera);
    // Collect all arc meshes (visible + hit areas)
    const arcMeshes = [];
    S.clippingArcHandles.forEach(h => { arcMeshes.push(h.mesh, h.hitMesh); });
    const hits = raycaster.intersectObjects(arcMeshes, false);
    if (hits.length > 0) {
      const obj = hits[0].object;
      const axis = obj.userData.clipArcAxis;
      return axis || null;
    }
    return null;
  }

  // Helper: get signed angle of pointer projected onto arc plane
  function getArcPointerAngle(clientX, clientY, axis) {
    if (!S.clippingHelper) return 0;
    // Project screen ray onto the plane of the arc (local plane, world-space)
    const mouse = new THREE.Vector2(
      (clientX / window.innerWidth) * 2 - 1,
      -(clientY / window.innerHeight) * 2 + 1
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, S.camera);

    // Build a plane perpendicular to the axis in world space
    const worldAxisMap = { x: new THREE.Vector3(1,0,0), y: new THREE.Vector3(0,1,0), z: new THREE.Vector3(0,0,1) };
    const localAxis = worldAxisMap[axis].clone();
    localAxis.applyQuaternion(S.clippingHelper.quaternion);
    const center = S.clippingHelper.position.clone();
    const planePt = new THREE.Plane().setFromNormalAndCoplanarPoint(localAxis, center);
    const intersection = new THREE.Vector3();
    raycaster.ray.intersectPlane(planePt, intersection);
    if (!intersection) return 0;
    const offset = intersection.clone().sub(center);
    // Choose two reference vectors perpendicular to the axis for angle computation
    let ref = localAxis.clone().cross(new THREE.Vector3(0, 1, 0));
    if (ref.length() < 0.01) ref = localAxis.clone().cross(new THREE.Vector3(1, 0, 0));
    ref.normalize();
    const perp1 = ref;
    const perp2 = localAxis.clone().cross(perp1).normalize();
    return Math.atan2(offset.dot(perp2), offset.dot(perp1));
  }

  // Helper: raycast against gumball arc hit meshes
  function hitTestGumballArcHandles(clientX, clientY) {
    if (!S.gumballHelper || !S.gumballActive || S.gumballArcHandles.length === 0) return null;
    const mouse = new THREE.Vector2(
      (clientX / window.innerWidth) * 2 - 1,
      -(clientY / window.innerHeight) * 2 + 1
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, S.camera);
    // Collect all arc meshes (visible + hit areas)
    const arcMeshes = [];
    S.gumballArcHandles.forEach(h => { arcMeshes.push(h.mesh, h.hitMesh); });
    const hits = raycaster.intersectObjects(arcMeshes, false);
    if (hits.length > 0) {
      const obj = hits[0].object;
      const axis = obj.userData.gumballArcAxis;
      return axis || null;
    }
    return null;
  }

  // Helper: get signed angle of pointer projected onto gumball arc plane
  function getGumballArcPointerAngle(clientX, clientY, axis) {
    if (!S.gumballHelper) return 0;
    // Project screen ray onto the plane of the arc (local plane, world-space)
    const mouse = new THREE.Vector2(
      (clientX / window.innerWidth) * 2 - 1,
      -(clientY / window.innerHeight) * 2 + 1
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(mouse, S.camera);

    // Build a plane perpendicular to the axis in world space
    const worldAxisMap = { x: new THREE.Vector3(1,0,0), y: new THREE.Vector3(0,1,0), z: new THREE.Vector3(0,0,1) };
    const localAxis = worldAxisMap[axis].clone();
    localAxis.applyQuaternion(S.gumballHelper.quaternion);
    const center = S.gumballHelper.position.clone();
    const planePt = new THREE.Plane().setFromNormalAndCoplanarPoint(localAxis, center);
    const intersection = new THREE.Vector3();
    raycaster.ray.intersectPlane(planePt, intersection);
    if (!intersection) return 0;
    const offset = intersection.clone().sub(center);
    // Choose two reference vectors perpendicular to the axis for angle computation
    let ref = localAxis.clone().cross(new THREE.Vector3(0, 1, 0));
    if (ref.length() < 0.01) ref = localAxis.clone().cross(new THREE.Vector3(1, 0, 0));
    ref.normalize();
    const perp1 = ref;
    const perp2 = localAxis.clone().cross(perp1).normalize();
    return Math.atan2(offset.dot(perp2), offset.dot(perp1));
  }

  S.renderer.domElement.addEventListener('pointerdown', (e) => {
    pointerDownTime = performance.now();
    pointerDownPos.set(e.clientX, e.clientY);

    // Walkthrough takes priority — left = look, right = pan (strafe + vertical).
    if (S.walkthroughActive && (e.button === 0 || e.button === 2)) {
      e.preventDefault();
      S.walkthroughDrag = {
        lastX: e.clientX,
        lastY: e.clientY,
        mode:  e.button === 2 ? 'pan' : 'look',
      };
      S.renderer.domElement.setPointerCapture?.(e.pointerId);
      S.renderer.domElement.style.cursor = e.button === 2 ? 'move' : 'grabbing';
      return;
    }

    // Move (Gumball) mode + pointerdown on a note pin → begin pin drag.
    // We intentionally skip this when other tools (distance/angle/note)
    // are active so they keep priority.
    if (S.gumballActive && !S.distanceToolState && !S.angleToolState && !S.noteToolState && _notesUiPickMarker) {
      const noteHit = _notesUiPickMarker(e.clientX, e.clientY);
      if (noteHit) {
        e.preventDefault();
        import('./notes-ui.js').then(m => m.beginNoteDrag(noteHit.id));
        return;
      }
    }

    // Check Gumball arc handles first
    const gumballArcAxis = hitTestGumballArcHandles(e.clientX, e.clientY);
    if (gumballArcAxis) {
      e.preventDefault();
      S.controls.enabled = false;
      if (S.gumballTransformControls) S.gumballTransformControls.enabled = false;
      const startAngle = getGumballArcPointerAngle(e.clientX, e.clientY, gumballArcAxis);
      
      const startObjectPositions = [];
      const startObjectQuats = [];
      S.selectedObjects.forEach(obj => {
        ensureOriginalTransform(obj);
        startObjectPositions.push(obj.position.clone());
        startObjectQuats.push(obj.quaternion.clone());
      });

      S.gumballArcDrag = {
        axis: gumballArcAxis,
        startAngle,
        startQuat: S.gumballHelper.quaternion.clone(),
        startObjectPositions,
        startObjectQuats
      };
      return;
    }

    // Check clipping arc handles next
    const arcAxis = hitTestArcHandles(e.clientX, e.clientY);
    if (arcAxis) {
      e.preventDefault();
      S.controls.enabled = false;
      if (S.clippingTransformControls) S.clippingTransformControls.enabled = false;
      const startAngle = getArcPointerAngle(e.clientX, e.clientY, arcAxis);
      S.clippingArcDrag = {
        axis: arcAxis,
        startAngle,
        startQuat: S.clippingHelper.quaternion.clone(),
        beforeState: {
          position: S.clippingPosition ? S.clippingPosition.clone() : null,
          quaternion: S.clippingQuaternion ? S.clippingQuaternion.clone() : null,
          clipAxis: S.clipAxis,
          clipFlipped: S.clipFlipped
        }
      };
      return;
    }

    handleWidgetPointerDown(e);
  });

  S.renderer.domElement.addEventListener('pointermove', (e) => {
    // Walkthrough drag — left-button rotates view, right-button pans the
    // camera in the camera-right / world-up plane.
    if (S.walkthroughActive && S.walkthroughDrag) {
      const dx = e.clientX - S.walkthroughDrag.lastX;
      const dy = e.clientY - S.walkthroughDrag.lastY;
      S.walkthroughDrag.lastX = e.clientX;
      S.walkthroughDrag.lastY = e.clientY;
      if (S.walkthroughDrag.mode === 'pan') {
        // Pan scale: at 1 px ≈ 1/600 of the walk-speed scale → feels close
        // to "drag the world a few cm per pixel" across all model sizes.
        const panK = S.walkthroughSpeed / 600;
        const cy = Math.cos(S.walkthroughYaw);
        const sy = Math.sin(S.walkthroughYaw);
        // Camera-right in the XY plane (yaw-only basis).
        _walkRight.set(sy, -cy, 0);
        _walkVel.set(0, 0, 0)
          .addScaledVector(_walkRight,   -dx * panK)
          .addScaledVector(_walkWorldUp,  dy * panK);
        S.camera.position.add(_walkVel);
      } else {
        const sens = 0.005;  // rad/px; tuned for typical screens
        S.walkthroughYaw   -= dx * sens;
        const PITCH_MAX = Math.PI / 2 - 0.05;  // ~85° — keeps "up" well-defined
        S.walkthroughPitch = Math.max(-PITCH_MAX, Math.min(PITCH_MAX,
          S.walkthroughPitch - dy * sens));
      }
      return;
    }

    // Note pin drag has priority — bypass orbit + other hover effects
    if (_notesUiPickMarker) {
      // We can't synchronously check isNoteDragging() because it's loaded
      // lazily. Instead, the dynamic import below resolves to a cached
      // module so the check is effectively synchronous after the first
      // load (which happened at app boot).
      import('./notes-ui.js').then(m => {
        if (m.isNoteDragging()) m.updateNoteDrag(e.clientX, e.clientY);
      });
    }

    // Update cursor when hovering over arc handles
    if (!S.clippingArcDrag && !S.gumballArcDrag) {
      const axis = hitTestArcHandles(e.clientX, e.clientY);
      const gAxis = hitTestGumballArcHandles(e.clientX, e.clientY);
      S.renderer.domElement.style.cursor = (axis || gAxis) ? 'grab' : '';
    }

    if (S.gumballArcDrag) {
      e.preventDefault();
      const { axis, startAngle, startQuat, startObjectPositions, startObjectQuats } = S.gumballArcDrag;
      const currentAngle = getGumballArcPointerAngle(e.clientX, e.clientY, axis);
      const delta = currentAngle - startAngle;

      // Build rotation quaternion around local-space axis of S.gumballHelper
      const worldAxisMap = { x: new THREE.Vector3(1,0,0), y: new THREE.Vector3(0,1,0), z: new THREE.Vector3(0,0,1) };
      const localAxis = worldAxisMap[axis].clone().applyQuaternion(startQuat).normalize();
      const rotQ = new THREE.Quaternion().setFromAxisAngle(localAxis, delta);

      // Rotate S.gumballHelper
      S.gumballHelper.quaternion.copy(rotQ).multiply(startQuat);
      S.gumballHelper.updateMatrixWorld(true);

      // Rotate all selected objects around S.gumballHelper.position (pivot)
      const pivot = S.gumballHelper.position.clone();
      S.selectedObjects.forEach((obj, idx) => {
        const startPos = startObjectPositions[idx].clone();
        const startQuatObj = startObjectQuats[idx].clone();

        const offset = startPos.sub(pivot);
        offset.applyQuaternion(rotQ);
        obj.position.copy(pivot).add(offset);

        obj.quaternion.copy(rotQ).multiply(startQuatObj);
        obj.updateMatrixWorld(true);
      });

      // Sync arc handles' orientations to match S.gumballHelper
      S.gumballArcHandles.forEach(h => {
        h.mesh.quaternion.copy(S.gumballHelper.quaternion);
        h.hitMesh.quaternion.copy(S.gumballHelper.quaternion);
      });

      if (S.selectionOutlinePass) {
        S.selectionOutlinePass.selectedObjects = [...S.selectedObjects];
      }
      return;
    }

    if (S.clippingArcDrag) {
      e.preventDefault();
      const { axis, startAngle, startQuat } = S.clippingArcDrag;
      const currentAngle = getArcPointerAngle(e.clientX, e.clientY, axis);
      const delta = currentAngle - startAngle;

      // Build rotation quaternion around world-space axis (local to helper)
      const worldAxisMap = { x: new THREE.Vector3(1,0,0), y: new THREE.Vector3(0,1,0), z: new THREE.Vector3(0,0,1) };
      const localAxis = worldAxisMap[axis].clone().applyQuaternion(startQuat).normalize();
      const rotQ = new THREE.Quaternion().setFromAxisAngle(localAxis, delta);

      // Apply rotation to helper
      S.clippingHelper.quaternion.copy(rotQ).multiply(startQuat);
      S.clippingHelper.updateMatrixWorld(true);

      // Update base quaternion since user manually rotated the gizmo
      S.clippingBaseQuaternion = S.clippingHelper.quaternion.clone();

      // Reset active axis to 'z' (custom coordinate system)
      S.clipAxis = 'z';
      document.querySelectorAll('.clip-axis-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.axis === 'z');
      });

      // Update clipping plane (negating if clipFlipped is active)
      const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(S.clippingHelper.quaternion).normalize();
      if (S.clipFlipped) normal.negate();
      S.clippingPlane.normal.copy(normal);
      S.clippingPlane.constant = -normal.dot(S.clippingHelper.position);

      // Sync scene-level arc handles to follow helper rotation
      S.clippingArcHandles.forEach(h => {
        h.mesh.quaternion.copy(S.clippingHelper.quaternion);
        h.hitMesh.quaternion.copy(S.clippingHelper.quaternion);
      });
      return;
    }

    handleWidgetPointerMove(e);
    if (S.distanceToolState) {
      updateTempDistanceLine(e);
      updateDistanceGhost(e);
    } else if (S.angleToolState) {
      updateTempAngleWidget(e);
      updateAngleGhost(e);
    }
  });

  S.renderer.domElement.addEventListener('pointerup', (e) => {
    // End walkthrough look-drag
    if (S.walkthroughActive && S.walkthroughDrag) {
      S.walkthroughDrag = null;
      S.renderer.domElement.releasePointerCapture?.(e.pointerId);
      S.renderer.domElement.style.cursor = '';
      return;
    }

    // End any in-flight note pin drag
    if (_notesUiPickMarker) {
      import('./notes-ui.js').then(m => {
        if (m.isNoteDragging()) m.endNoteDrag();
      });
    }

    if (S.gumballArcDrag) {
      console.log('[Gumball] Arc drag pointerup. Creating before/after states.');
      const beforeState = S.selectedObjects.map((obj, i) => ({
        position: S.gumballArcDrag.startObjectPositions[i].clone(),
        quaternion: S.gumballArcDrag.startObjectQuats[i].clone(),
        scale: obj.scale.clone()
      }));
      const afterState = S.selectedObjects.map(obj => ({
        position: obj.position.clone(),
        quaternion: obj.quaternion.clone(),
        scale: obj.scale.clone()
      }));

      console.log('[Gumball] Arc drag pushing transform. beforeState:', beforeState, 'afterState:', afterState);
      History.push({
        type: 'transform',
        targets: [...S.selectedObjects],
        before: beforeState,
        after: afterState
      });

      S.gumballArcDrag = null;
      S.controls.enabled = true;
      S.renderer.domElement.style.cursor = '';
      if (S.gumballTransformControls) S.gumballTransformControls.enabled = true;

      // Immediately refresh TransformControls to snap handles to the new rotation!
      if (S.gumballTransformControls && S.gumballHelper) {
        S.gumballTransformControls.detach();
        S.gumballTransformControls.attach(S.gumballHelper);
        S.gumballTransformControls.getHelper().visible = true;
      }
      return;
    }

    if (S.clippingArcDrag) {
      const beforeState = S.clippingArcDrag.beforeState;
      S.clippingArcDrag = null;
      S.controls.enabled = true;
      S.renderer.domElement.style.cursor = '';
      if (S.clippingTransformControls) S.clippingTransformControls.enabled = true;

      // Immediately refresh TransformControls to snap handles to the new rotation!
      if (S.clippingTransformControls && S.clippingHelper) {
        S.clippingTransformControls.detach();
        S.clippingTransformControls.attach(S.clippingHelper);
        applyClipWidgetVisibility();
      }

      if (!History.suppress && beforeState) {
        const afterState = {
          position: S.clippingPosition ? S.clippingPosition.clone() : null,
          quaternion: S.clippingQuaternion ? S.clippingQuaternion.clone() : null,
          clipAxis: S.clipAxis,
          clipFlipped: S.clipFlipped
        };

        const quatChanged = (!beforeState.quaternion && afterState.quaternion) ||
                            (beforeState.quaternion && !afterState.quaternion) ||
                            (beforeState.quaternion && afterState.quaternion && beforeState.quaternion.angleTo(afterState.quaternion) > 0.0001);
        if (quatChanged) {
          History.push({
            type: 'clipping',
            before: beforeState,
            after: afterState
          });
        }
      }
      return;
    }

    handleWidgetPointerUp();
    const timeDiff = performance.now() - pointerDownTime;
    const dist = pointerDownPos.distanceTo(new THREE.Vector2(e.clientX, e.clientY));
    const isClick = timeDiff < 500 && dist < 12;
    if (isClick) {
      const anyPanelOpen =
        !leftPanel.classList.contains('hidden') ||
        layerRightPanel?.classList.contains('panel-open') ||
        settingsRightPanel?.classList.contains('panel-open');
      if (anyPanelOpen) { closeAllPanels(); return; }
      document.querySelectorAll('.dropdown-menu:not(.hidden)').forEach(m => m.classList.add('hidden'));
      if (S.distanceToolState || S.angleToolState || S.noteToolState) {
        onCanvasClick(e);
      } else {
        // Pin marker click? Behavior depends on Move (Gumball) mode.
        if (_notesUiPickMarker) {
          const noteHit = _notesUiPickMarker(e.clientX, e.clientY);
          if (noteHit) {
            if (S.gumballActive) {
              // In Move mode: don't show bubble — let pointerdown have
              // already started a drag in the pointerdown listener above.
              // (We arrive here on the short-click path; pointermove won't
              //  have moved enough to trigger drag, so re-enable controls
              //  and skip selection.)
              return;
            }
            import('./notes-ui.js').then(m => m.showBubbleForNote(noteHit.id));
            return;
          }
        }
        // Empty-space click while a bubble is visible → dismiss it.
        if (S.noteActiveId != null) {
          import('./notes-ui.js').then(m => m.hideBubble());
          return;
        }
        onPointerDown(e);
      }
    }
  });

  // ── Camera projection toggle ──
  const projSelect = document.getElementById('select-projection');
  if (projSelect) {
    projSelect.value = S.twoPointActive ? 'two-point'
                     : (S.camera === S.orthoCamera) ? 'parallel'
                     : 'perspective';
    projSelect.addEventListener('change', () => {
      if (projSelect.value === 'parallel')       switchToOrtho();
      else if (projSelect.value === 'two-point') switchToTwoPoint();
      else                                       switchToPersp();
    });
  }

  // ── Camera Lens Length ──
  const fovSlider = document.getElementById('sl-camera-fov');
  const fovValEl  = document.getElementById('sl-camera-fov-val');

  if (fovSlider) {
    fovSlider.addEventListener('input', () => {
      updateLensCamera();
      updateSliderFill(fovSlider);
    });
    bindSliderDblClickInput(fovSlider, fovValEl, 'mm');
  }

  // ── Language ──
  const langSel = document.getElementById('lang-select');
  if (langSel) {
    langSel.value = currentLang;
    langSel.addEventListener('change', () => setLang(langSel.value));
  }

  // ── Theme ──
  const themeSel = document.getElementById('theme-select');
  if (themeSel) {
    themeSel.value = S.currentTheme;
    themeSel.addEventListener('change', () => applyTheme(themeSel.value));
  }

  // ── Drag & drop ──
  window.addEventListener('dragenter', e => e.preventDefault());
  window.addEventListener('dragover',  e => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
  window.addEventListener('drop', async e => {
    e.preventDefault();
    // Capture a writable handle synchronously — DataTransfer is neutered after
    // any await. Only desktop Chromium exposes getAsFileSystemHandle.
    const item0 = e.dataTransfer.items?.[0];
    const handlePromise = item0?.getAsFileSystemHandle ? item0.getAsFileSystemHandle() : null;
    const resolveDropHandle = async () => {
      try { const h = await handlePromise; return (h && h.kind === 'file') ? h : null; }
      catch { return null; }
    };
    const files = e.dataTransfer.files;
    if (files?.length > 0) {
      const f = files[0];
      const name = f.name.toLowerCase();
      if (name.endsWith('.rhv')) {
        loadSession(f, await resolveDropHandle());
      } else if (name.endsWith('.hdr')) {
        const { showLoading, hideLoading } = await import('./helpers.js');
        showLoading('Loading custom HDR background…');
        try {
          const { RGBELoader } = await import('three/addons/loaders/RGBELoader.js');
          
          // Read custom HDR file as Base64 for embedding in saved session packages
          const reader = new FileReader();
          reader.onload = function(evt) {
            const dataUrl = evt.target.result;
            const base64Index = dataUrl.indexOf(';base64,');
            if (base64Index !== -1) {
              S.customHdrData = dataUrl.substring(base64Index + 8);
              S.customHdrName = f.name;
            }
          };
          reader.readAsDataURL(f);

          const url = URL.createObjectURL(f);
          const rgbeLoader = new RGBELoader();
          const pmrem = new THREE.PMREMGenerator(S.renderer);
          pmrem.compileEquirectangularShader();
          
          rgbeLoader.load(url, texture => {
            URL.revokeObjectURL(url);
            const envTexture = pmrem.fromEquirectangular(texture).texture;
            texture.dispose();
            pmrem.dispose();
            
            if (S.envMaps['hdr-custom']) S.envMaps['hdr-custom'].dispose();
            S.envMaps['hdr-custom'] = envTexture;
            S.environmentMap = envTexture;
            S.currentEnvPreset = 'hdr-custom';
            
            // Switch to Rendered mode to show HDR lighting & background if in shaded/wireframe
            if (!['rendered', 'arctic'].includes(S.currentMode)) {
              changeDisplayMode('rendered');
            }
            
            // Enable the custom-HDR option in UI
            const hdrOpt = document.getElementById('opt-hdr-custom');
            if (hdrOpt) { 
              hdrOpt.disabled = false; 
              hdrOpt.textContent = f.name; 
            }
            const envSel = document.getElementById('env-preset-select');
            if (envSel) envSel.value = 'hdr-custom';
            
            // Set background type to 'hdr' to display it as background
            const bgSel = document.getElementById('bg-type-select');
            if (bgSel) {
              bgSel.value = 'hdr';
              bgSel.dispatchEvent(new Event('change'));
            }
            
            applySceneBackground();
            applyDisplayMode();
            
            // Sync bottom toolbar or env preset active buttons if any
            document.querySelectorAll('.env-preset-btn').forEach(b => b.classList.remove('active'));
            document.querySelector('.env-preset-btn[data-preset="hdr-custom"]')?.classList.add('active');
            
            hideLoading();
          }, undefined, err => {
            console.error('[HDR Drag-and-Drop] load error', err);
            alert(t('msg.load_hdr_failed'));
            hideLoading();
          });
        } catch (hdrErr) {
          console.error('[HDR Drag-and-Drop] error', hdrErr);
          hideLoading();
        }
      } else {
        handleFile(f, rhinoLoader, gltfLoader, await resolveDropHandle());
      }
    }
  });

  // ── Escape key & Right-click to cancel active measurements ──
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      // Esc also exits walkthrough — most natural "get me out" key.
      // UI sync (dropdown + trigger button) handled by the
      // 'walkthrough-changed' event listener.
      if (S.walkthroughActive) setWalkthroughMode(false);
      cancelCurrentInProgressMeasurement();
      // Also close any open note bubble
      if (S.noteActiveId != null) {
        import('./notes-ui.js').then(m => m.hideBubble());
      }
    }

    // Walkthrough movement keys — track pressed state. Ignore when a text
    // input is focused so typing in dialogs (e.g. note text) isn't hijacked.
    if (S.walkthroughActive && S.walkthroughKeys) {
      const target = e.target;
      const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (!typing && WALK_KEYS.has(e.code)) {
        S.walkthroughKeys.add(e.code);
        e.preventDefault();
      }
    }
  });

  window.addEventListener('keyup', (e) => {
    if (S.walkthroughActive && S.walkthroughKeys && WALK_KEYS.has(e.code)) {
      S.walkthroughKeys.delete(e.code);
    }
  });

  // Stop motion if the window loses focus mid-walk (e.g. user alt-tabs)
  // — otherwise the camera would keep drifting forever.
  window.addEventListener('blur', () => {
    if (S.walkthroughKeys) S.walkthroughKeys.clear();
    S.walkthroughDrag = null;
  });

  window.addEventListener('contextmenu', (e) => {
    // Suppress the browser menu while walking — right-button is reserved for pan.
    if (S.walkthroughActive) {
      e.preventDefault();
      return;
    }
    // Only intercept right-click if a measurement is actively in progress
    if ((S.distanceToolState && S.distanceToolState.points.length > 0) ||
        (S.angleToolState && S.angleToolState.points.length > 0)) {
      e.preventDefault();
      cancelCurrentInProgressMeasurement();
    }
  });

  // Wheel = walk forward/back along the ground-projected forward. Wheel down
  // (deltaY > 0) walks BACK, matching the convention that scrolling "away"
  // pulls things farther in most viewers.
  S.renderer.domElement.addEventListener('wheel', (e) => {
    if (!S.walkthroughActive) return;
    e.preventDefault();
    const cy = Math.cos(S.walkthroughYaw);
    const sy = Math.sin(S.walkthroughYaw);
    _walkForward.set(cy, sy, 0);  // yaw-only forward, ignores pitch
    // Step is ~1 walk-second of motion per typical wheel notch (deltaY ≈ 100).
    const step = -(e.deltaY / 100) * S.walkthroughSpeed * 0.5;
    S.camera.position.addScaledVector(_walkForward, step);
  }, { passive: false });

  // ── Bottom Bar Group Popups ──
  document.querySelectorAll('.bottom-tool-group').forEach(grp => {
    const trigger = grp.querySelector('.group-trigger');
    const popup = grp.querySelector('.group-popup');
    trigger?.addEventListener('click', (e) => {
      e.stopPropagation();
      // Close all other popups
      document.querySelectorAll('.group-popup').forEach(p => {
        if (p !== popup) p.classList.add('hidden');
      });
      popup?.classList.toggle('hidden');
      if (popup && !popup.classList.contains('hidden')) {
        popup.classList.add('show');
      }
    });
  });
  
  // Close popups on item click
  document.querySelectorAll('.group-popup button').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.parentElement?.classList.add('hidden');
    });
  });

  // Click away to close popups
  document.addEventListener('click', () => {
    document.querySelectorAll('.group-popup').forEach(p => p.classList.add('hidden'));
  });
  
  // Bind Undo/Redo Buttons
  document.getElementById('btn-undo')?.addEventListener('click', () => {
    History.undo();
  });
  document.getElementById('btn-redo')?.addEventListener('click', () => {
    History.redo();
  });
  
  // ── Keyboard Shortcuts (Ctrl+Z / Ctrl+Y) ──
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      History.undo();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      History.redo();
    }
  });
}

// ── Walkthrough mode constants ─────────────────────────────────────────────
//
// Keys we capture during walkthrough. Arrow keys map to WASD; Q/E or
// Space/Shift handle vertical movement so the user can dolly up/down without
// pitching the head. Speed modifier is Shift — but Shift conflicts with the
// up-binding choice, so we deliberately don't map Shift here.
const WALK_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'KeyQ', 'KeyE',
  'Space',
]);

// Reusable scratch vectors — allocating per-frame would churn GC.
const _walkForward = new THREE.Vector3();
const _walkRight   = new THREE.Vector3();
const _walkVel     = new THREE.Vector3();
const _walkWorldUp = new THREE.Vector3(0, 0, 1);

function applyWalkthroughFrame(now) {
  const dt = Math.min(0.1, Math.max(0, (now - S.walkthroughLastT) / 1000));
  S.walkthroughLastT = now;
  if (dt <= 0) return;

  // 1. Update orientation from yaw/pitch. Build the look direction in the
  //    Z-up frame: yaw rotates around +Z, pitch tilts the look vector up/down.
  const cp = Math.cos(S.walkthroughPitch);
  const sp = Math.sin(S.walkthroughPitch);
  const cy = Math.cos(S.walkthroughYaw);
  const sy = Math.sin(S.walkthroughYaw);
  _walkForward.set(cp * cy, cp * sy, sp);

  S.camera.up.copy(_walkWorldUp);
  const lookAt = _walkVel.copy(S.camera.position).add(_walkForward);
  S.camera.lookAt(lookAt);

  // 2. Apply movement. W/S walks along the XY-projected forward (so looking
  //    up doesn't make you fly forward). Q/E (and Space) move along world Z.
  const keys = S.walkthroughKeys;
  if (!keys || keys.size === 0) return;

  // Forward direction projected onto the ground plane.
  _walkForward.z = 0;
  if (_walkForward.lengthSq() < 1e-6) _walkForward.set(cy, sy, 0);
  _walkForward.normalize();
  _walkRight.crossVectors(_walkForward, _walkWorldUp).negate().normalize();

  let fwd = 0, side = 0, up = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp'))    fwd  += 1;
  if (keys.has('KeyS') || keys.has('ArrowDown'))  fwd  -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) side += 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft'))  side -= 1;
  if (keys.has('KeyE') || keys.has('Space'))      up   += 1;
  if (keys.has('KeyQ'))                            up   -= 1;
  if (fwd === 0 && side === 0 && up === 0) return;

  const step = S.walkthroughSpeed * dt;
  _walkVel.set(0, 0, 0)
    .addScaledVector(_walkForward, fwd  * step)
    .addScaledVector(_walkRight,   side * step)
    .addScaledVector(_walkWorldUp, up   * step);
  S.camera.position.add(_walkVel);
}

// ── Core render loop ───────────────────────────────────────────────────────
function animate() {
  requestAnimationFrame(animate);

  // Exclude all measurement elements (lines, sprites, handles) from AO (SSAO/GTAO) and shadows by moving them to Layer 1
  if (S.measurementGroup) {
    S.measurementGroup.traverse(child => {
      if (child.layers.mask !== 2) {
        child.layers.set(1);
      }
    });
  }

  // Note bubble follows its anchor marker each frame.
  if (S.notes && S.notes.length && S.noteActiveId != null && _notesUiUpdateBubble) {
    _notesUiUpdateBubble();
  }

  if (S.clippingTransformControls) {
    // Enforce hiding negative direction arrowheads permanently!
    try {
      const gizmoTranslate = S.clippingTransformControls._gizmo?.gizmo?.['translate'];
      if (gizmoTranslate) {
        gizmoTranslate.traverse(child => {
          if (child.userData.isNegArrow || child.userData.isPlaneHandle) {
            // Keep on layer 31 (hidden layer) so the camera never renders it!
            child.layers.set(31);
            
            // If the material has been swapped by TransformControls during drag/hover,
            // clone and keep it fully transparent.
            if (child.material && child.material !== child.userData.clonedNegMat) {
              const clonedMat = child.material.clone();
              clonedMat.transparent = true;
              clonedMat.opacity = 0;
              clonedMat.needsUpdate = true;
              child.material = clonedMat;
              child.userData.clonedNegMat = clonedMat;
            } else if (child.material && child.material.opacity !== 0) {
              child.material.opacity = 0;
            }
          }
        });
      }
    } catch (e) {}

    // Sync arc handle scale with the TransformControls screen-space scale.
    // TransformControls sets scale on each individual handle child every frame
    // via: handle.scale.set(1,1,1).multiplyScalar(factor * size / 4)
    // We read that scale from the first child of the translate gizmo group.
    if (S.clippingEnabled && S.clippingArcHandles && S.clippingArcHandles.length > 0) {
      try {
        const gizmoTranslate = S.clippingTransformControls._gizmo?.gizmo?.['translate'];
        let handleScale = 1;
        if (gizmoTranslate && gizmoTranslate.children.length > 0) {
          handleScale = gizmoTranslate.children[0].scale.x;
        }
        // arcRadius base = 10.0 units, gizmo arrows are 0.5 units at scale 1.0
        // We want arc radius ≈ arrow length in world space
        // arrow world length = handleScale * 0.5, arc world radius = handleScale * 0.5
        // arcMesh.scale needed = (handleScale * 0.5) / 10.0 = handleScale * 0.05
        const targetScale = Math.max(0.001, handleScale) * 0.05;
        S.clippingArcHandles.forEach(h => {
          if (h.mesh && h.hitMesh) {
            h.mesh.scale.set(targetScale, targetScale, targetScale);
            h.hitMesh.scale.set(targetScale, targetScale, targetScale);
          }
        });
      } catch (err) {
        console.warn('Arc scale sync error:', err);
      }
    }

    // Sync Gumball arc handle scale with the TransformControls screen-space scale
    if (S.gumballActive && S.gumballArcHandles && S.gumballArcHandles.length > 0) {
      try {
        const gizmoTranslate = S.gumballTransformControls._gizmo?.gizmo?.['translate'];
        let handleScale = 1;
        if (gizmoTranslate && gizmoTranslate.children.length > 0) {
          handleScale = gizmoTranslate.children[0].scale.x;
        }
        const targetScale = Math.max(0.001, handleScale) * 0.05;
        S.gumballArcHandles.forEach(h => {
          if (h.mesh && h.hitMesh) {
            h.mesh.scale.set(targetScale, targetScale, targetScale);
            h.hitMesh.scale.set(targetScale, targetScale, targetScale);
          }
        });
      } catch (err) {
        console.warn('Gumball arc scale sync error:', err);
      }
    }
  }
  if (S.cameraTransition) {
    const now     = performance.now();
    const elapsed = now - S.cameraTransition.startTime;
    let t = Math.min(1.0, elapsed / S.cameraTransition.duration);
    const easeT = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    S.camera.position.lerpVectors(S.cameraTransition.startPos,    S.cameraTransition.endPos,    easeT);
    S.controls.target.lerpVectors(S.cameraTransition.startTarget, S.cameraTransition.endTarget, easeT);
    S.camera.up.lerpVectors(S.cameraTransition.startUp, S.cameraTransition.endUp, easeT);
    S.camera.up.normalize();
    if (t >= 1.0) {
      S.cameraTransition = null;
      if (S.pendingOrthoSwitch) { S.pendingOrthoSwitch = false; switchToOrtho(); }
    }
  }
  if (S.walkthroughActive) {
    applyWalkthroughFrame(performance.now());
    // Skip S.controls.update() — OrbitControls.update() always re-orients
    // the camera to look at its target, which would clobber our yaw/pitch
    // from the mouse drag. `.enabled = false` only blocks input, not update.
  } else {
    S.controls.update();
    apply2PointConstraints();
  }
  // Keep perspective near/far tight to the scene so depth precision (and GTAO)
  // holds up at long lens lengths / zoom-out. No-op for ortho.
  updateAdaptiveClipping();
  S.composer.render();

  // Render arc overlay scene on top — no clipping planes active.
  // If cap fill is on, clearStencil() before this render so stencil twins (renderOrder 0)
  // write their values before the cap plane (renderOrder 1) reads them, all in one pass.
  if ((S.clippingEnabled || S.gumballActive) && S.arcOverlayScene && S.arcOverlayScene.children.length > 0) {
    const savedPlanes = S.renderer.clippingPlanes;
    S.renderer.clippingPlanes = [];           // disable clipping for overlay
    S.renderer.autoClear = false;             // don't clear what composer already drew
    if (S.clippingEnabled && S.clippingCapEnabled && S.capMesh) {
      updateClippingCapPose();                // keep cap glued to the clip plane (any move path)
      S.renderer.clearStencil();              // fresh stencil for cap fill this frame
      S.renderer.clearDepth();                // fresh depth for the cap's depth pre-pass
    }
    S.renderer.render(S.arcOverlayScene, S.camera);
    S.renderer.autoClear = true;              // restore
    S.renderer.clippingPlanes = savedPlanes;  // restore clipping for next frame
  }

  // Dynamic color contrast adaptation for the bottom tools bar — runs for ALL
  // background types (solid, gradient2, gradient4, radial, hdr). We sample the
  // pixel directly behind the bar so the icons stay legible regardless of UI theme.
  if (S.renderer) {
    barContrastFrameCount++;
    if (barContrastFrameCount % 6 === 0) {
      updateBottomBarLocalContrast();
    }
  }
}

// Hysteresis band + EMA smoothing prevent flicker on noisy backgrounds
// (e.g. grass HDR) where a single-pixel sample crosses the threshold every
// frame as the camera rotates. Constants live on S so they persist across calls.
const BAR_LUM_ENTER_DARK  = 0.42;  // switch to dark icons when luminance drops below
const BAR_LUM_ENTER_LIGHT = 0.48;  // switch to light icons when luminance rises above
const BAR_LUM_EMA_ALPHA   = 0.25;  // higher = more responsive, lower = more stable

function updateBottomBarLocalContrast() {
  const bottomBar = document.getElementById('bottom-view-tools-bar');
  if (!bottomBar || !S.renderer) return;
  try {
    const gl = S.renderer.getContext();
    if (!gl) return;
    const canvasW = S.renderer.domElement.width;
    const canvasH = S.renderer.domElement.height;
    const dpr = window.devicePixelRatio || 1;

    // Sample the actual rectangle behind the bar so the average reflects what
    // shows through the blur — not an arbitrary point that may miss the bar.
    const rect = bottomBar.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    // CSS px → device px. WebGL Y is bottom-up, CSS Y is top-down.
    const sx = Math.round(rect.left * dpr);
    const sw = Math.round(rect.width * dpr);
    const sh = Math.round(rect.height * dpr);
    const sy = Math.round(canvasH - (rect.bottom * dpr));
    if (sw <= 0 || sh <= 0 || sx < 0 || sy < 0 ||
        sx + sw > canvasW || sy + sh > canvasH) return;

    const buf = new Uint8Array(sw * sh * 4);
    gl.readPixels(sx, sy, sw, sh, gl.RGBA, gl.UNSIGNED_BYTE, buf);

    // Body bg for alpha composite — read once per call.
    let bgR = 255, bgG = 255, bgB = 255;
    const bodyBg = window.getComputedStyle(document.body).backgroundColor;
    const m = bodyBg.match(/\d+/g);
    if (m && m.length >= 3) {
      bgR = parseInt(m[0]); bgG = parseInt(m[1]); bgB = parseInt(m[2]);
    }

    // Stride keeps work bounded for large bars on high-DPI displays.
    // For a ~300×40 CSS bar at 2x DPR that's 600×80=48k px; stride 4 → ~3k samples.
    const stride = Math.max(1, Math.round(Math.sqrt((sw * sh) / 2000)));
    let sumR = 0, sumG = 0, sumB = 0, count = 0;
    for (let yy = 0; yy < sh; yy += stride) {
      for (let xx = 0; xx < sw; xx += stride) {
        const i = (yy * sw + xx) * 4;
        const a = buf[i + 3];
        if (a === 255) {
          sumR += buf[i]; sumG += buf[i + 1]; sumB += buf[i + 2];
        } else {
          const af = a / 255;
          sumR += buf[i]     * af + bgR * (1 - af);
          sumG += buf[i + 1] * af + bgG * (1 - af);
          sumB += buf[i + 2] * af + bgB * (1 - af);
        }
        count++;
      }
    }
    if (count === 0) return;
    const r = sumR / count, g = sumG / count, b = sumB / count;

    // ITU-R BT.709 relative luminance, then temporal EMA for extra stability.
    const lumRaw = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    S.barLumEma = S.barLumEma == null
      ? lumRaw
      : S.barLumEma * (1 - BAR_LUM_EMA_ALPHA) + lumRaw * BAR_LUM_EMA_ALPHA;
    const lum = S.barLumEma;

    // Hysteresis: only flip when luminance crosses the outer edge of the
    // deadband. Between thresholds the previous decision persists.
    const isDark = bottomBar.classList.contains('local-dark');
    let wantDark;
    if (isDark)                    wantDark = lum < BAR_LUM_ENTER_LIGHT;
    else if (bottomBar.classList.contains('local-light')) wantDark = lum < BAR_LUM_ENTER_DARK;
    else                           wantDark = lum < 0.45;  // first-call default

    const wantClass   = wantDark ? 'local-dark'  : 'local-light';
    const removeClass = wantDark ? 'local-light' : 'local-dark';
    if (!bottomBar.classList.contains(wantClass)) {
      bottomBar.classList.add(wantClass);
      bottomBar.classList.remove(removeClass);
    }
  } catch (e) {
    console.warn('Luminance sampling error:', e);
  }
}

// ── Window resize ──────────────────────────────────────────────────────────
export function updateLensCamera() {
  const fovSlider = document.getElementById('sl-camera-fov');
  const fovValEl  = document.getElementById('sl-camera-fov-val');
  if (!fovSlider) return;
  const lens = parseFloat(fovSlider.value);
  if (fovValEl) fovValEl.textContent = Math.round(lens) + 'mm';
  
  const aspect = window.innerWidth / window.innerHeight;
  const vFovRad = 2 * Math.atan(18 / (aspect * lens));
  const fov = (vFovRad * 180) / Math.PI;
  
  if (S.perspCamera) {
    S.perspCamera.fov = fov;
    S.perspCamera.updateProjectionMatrix();
  }
}

// ── Window resize ──────────────────────────────────────────────────────────
function onWindowResize() {
  const aspect = window.innerWidth / window.innerHeight;
  S.perspCamera.aspect = aspect;
  S.perspCamera.updateProjectionMatrix();
  if (S.camera.isOrthographicCamera) {
    const half = S.camera.top;
    S.camera.left  = -half * aspect;
    S.camera.right =  half * aspect;
    S.camera.updateProjectionMatrix();
  }
  S.renderer.setSize(window.innerWidth, window.innerHeight);
  S.composer.setSize(window.innerWidth, window.innerHeight);
  // Recalculate camera FOV from constant Lens Length on window resize
  try {
    updateLensCamera();
  } catch (err) {}
}

// ── Theme ──────────────────────────────────────────────────────────────────
function updateBgColors(isLight) {
  const p1 = document.getElementById('bg-panel-c1');
  const p2 = document.getElementById('bg-panel-c2');
  const p3 = document.getElementById('bg-panel-c3');
  const p4 = document.getElementById('bg-panel-c4');
  if (isLight) {
    if (p1 && (p1.value === '#2a2b2f' || p1.value === '#000000' || p1.value === '#1b1b1f' || p1.value === '#24252a')) p1.value = '#ffffff';
    if (p2 && (p2.value === '#18181c' || p2.value === '#1c1d22')) p2.value = '#f3f4f6';
    if (p3 && p3.value === '#1e293b') p3.value = '#e5e7eb';
    if (p4 && p4.value === '#0f172a') p4.value = '#d1d5db';
  } else {
    if (p1 && p1.value === '#ffffff') p1.value = '#24252a';
    if (p2 && p2.value === '#f3f4f6') p2.value = '#1c1d22';
    if (p3 && p3.value === '#e5e7eb') p3.value = '#1e293b';
    if (p4 && p4.value === '#d1d5db') p4.value = '#0f172a';
  }
  ['c1','c2','c3','c4'].forEach(id => {
    const sw = document.getElementById('bg-panel-swatch-' + id);
    const p  = document.getElementById('bg-panel-' + id);
    if (sw && p) {
      sw.style.background = p.value;
      const wrapper = p.parentNode;
      if (wrapper && wrapper.classList.contains('clr-field')) {
        wrapper.style.color = p.value;
        const btn = wrapper.querySelector('button');
        if (btn) btn.style.backgroundColor = p.value;
      }
    }
  });
  if (S.scene) applySceneBackground();
}

function applyTheme(theme) {
  S.currentTheme = theme;
  try {
    localStorage.setItem(S.THEME_KEY, theme);
  } catch (e) {
    console.warn('Failed to write theme to localStorage:', e);
  }
  const root = document.documentElement;
  const isLight = theme === 'light' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: light)').matches);
  if (isLight) {
    root.setAttribute('data-theme', 'light');
    document.body.classList.add('light-theme');
    document.body.classList.remove('dark-theme');
  } else {
    root.setAttribute('data-theme', 'dark');
    document.body.classList.add('dark-theme');
    document.body.classList.remove('light-theme');
  }
  const themeSel = document.getElementById('theme-select');
  if (themeSel) themeSel.value = theme;

  updateBgColors(isLight);

  if (S.currentModel) {
    applyLayerColorsToModel(S.currentModel);
    applyDisplayMode();
    createAnnotationSprites();
  }
}

window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (S.currentTheme === 'system') applyTheme('system');
});

function initThemeSync() {
  const mediaQuery = window.matchMedia('(prefers-color-scheme: light)');
  applyTheme(S.currentTheme);

  const isLightInitial = S.currentTheme === 'light' ||
    (S.currentTheme === 'system' && mediaQuery.matches);
  updateBgColors(isLightInitial);

  const updateTheme = (e) => {
    if (S.currentTheme === 'system') { applyTheme('system'); updateBgColors(e.matches); }
  };
  if (mediaQuery.addEventListener) mediaQuery.addEventListener('change', updateTheme);
  else if (mediaQuery.addListener)  mediaQuery.addListener(updateTheme);
}


async function exportGLB() {
  if (!S.currentModel) { alert('No model loaded.'); return; }

  const isCapacitor = window.Capacitor && window.Capacitor.isPluginAvailable('FileOpener');
  const glbFileName = (S.currentFileName?.replace(/\.[^.]+$/, '') || 'model') + '.glb';

  // Pick the save location first, while the click gesture is still active.
  let sink = null;
  if (!isCapacitor) {
    sink = await beginSave({
      suggestedName: glbFileName,
      types: [{ description: 'glTF Binary', accept: { 'model/gltf-binary': ['.glb'] } }],
    });
    if (!sink) return; // user cancelled
  }

  applyDisplayMode();

  const toHide = [];
  S.currentModel.traverse(child => {
    if (child.name === 'rhino-outline' || child.name === 'selection-outline' ||
        child.name === 'rhino-edges'   || child.name === 'ground-plane') {
      if (child.visible) { toHide.push(child); child.visible = false; }
    }
  });

  const exporter = new GLTFExporter();
  exporter.parse(
    S.currentModel,
    async (gltf) => {
      toHide.forEach(c => { c.visible = true; });
      const blob = new Blob([gltf], { type: 'application/octet-stream' });

      if (isCapacitor) {
        const reader = new FileReader();
        reader.readAsDataURL(blob);
        reader.onloadend = async () => {
          const base64Data = reader.result;
          try {
            await window.Capacitor.Plugins.FileOpener.saveFile({
              base64Data: base64Data,
              fileName: glbFileName,
              mimeType: 'application/octet-stream'
            });
            alert('GLB saved to Downloads folder!');
          } catch (err) {
            console.error('[Capacitor GLB] Export failed:', err);
            alert('Failed to save GLB: ' + err);
          }
        };
      } else {
        await sink(blob);
      }
    },
    (err) => {
      toHide.forEach(c => { c.visible = true; });
      console.error('[GLB Export] error:', err);
      alert('GLB export failed. See console for details.');
    },
    { binary: true }
  );
}

// ── Object search (results panel) ─────────────────────────────────────────
function searchObjects(query) {
  const container = document.getElementById('find-results-container');
  if (!container) return;
  container.innerHTML = '';

  if (!S.currentModel) {
    container.innerHTML = '<span class="dropdown-empty-msg">No model loaded</span>';
    return;
  }
  if (!query || query.trim() === '') {
    container.innerHTML = '<span class="dropdown-empty-msg">Enter object name...</span>';
    return;
  }

  const matches = [];
  S.currentModel.traverse(child => {
    if (child.isMesh && child.name !== 'rhino-edges' &&
        child.name !== 'rhino-outline' && child.name !== 'ground-plane') {
      const name = child.userData?.attributes?.name || child.name || '';
      if (name.toLowerCase().includes(query.toLowerCase())) matches.push(child);
    }
  });

  if (matches.length === 0) {
    container.innerHTML = '<span class="dropdown-empty-msg" style="padding:10px 0;">No matching objects found</span>';
    return;
  }

  matches.forEach(obj => {
    const name  = obj.userData?.attributes?.name || obj.name || 'Unnamed Mesh';
    const layer = S.parsedLayers.find(l => l.index === obj.userData?.attributes?.layerIndex);
    const btn   = document.createElement('button');
    btn.className = 'dropdown-item';
    btn.style.cssText = 'width:100%;padding:6px 8px;background:var(--surface-hi);border:1px solid var(--border);border-radius:var(--r-sm);margin-bottom:4px;color:var(--text)';
    btn.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:2px;font-size:0.75rem;text-align:left;">
        <span style="font-weight:600;">${name}</span>
        <span style="color:var(--text-2);font-size:0.65rem;">Layer: ${layer?.name ?? '—'}</span>
      </div>`;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      clearSelection();
      S.selectedObjects.push(obj);
      addSelectionOutline(obj);
      fitCameraToObject(obj, true);
      updatePropertiesPanel();
    });
    container.appendChild(btn);
  });
}

// ── Handle incoming file intents from native Android/iOS ──
async function handleIncomingSharedFile(url) {
  if (!url) return;
  try {
    showLoading(t('loading.parse') || 'Parsing file...');
    const convertedUrl = window.Capacitor.convertFileSrc(url);
    const res = await fetch(convertedUrl);
    if (!res.ok) throw new Error('Failed to fetch shared file data');
    const blob = await res.blob();
    
    // Extract clean filename from URL (remove query parameters if any)
    let filename = url.substring(url.lastIndexOf('/') + 1);
    if (filename.includes('?')) filename = filename.split('?')[0];
    
    const file = new File([blob], filename, { type: blob.type });
    
    if (filename.toLowerCase().endsWith('.rhv')) {
      await loadSession(file);
    } else {
      await handleFile(file, rhinoLoader, gltfLoader);
    }
  } catch (e) {
    console.error('Error loading shared file:', e);
    alert('Failed to open shared file: ' + e.message);
  } finally {
    hideLoading();
  }
}

// ── Handle loading a 3D file from a URL ──
async function loadModelFromUrl(url) {
  if (!url) return;
  try {
    showLoading(t('loading.parse') || 'Parsing file...');
    const res = await fetch(url);
    if (!res.ok) throw new Error('Failed to fetch file data: ' + res.statusText);
    const blob = await res.blob();
    
    // Extract clean filename from URL (remove query parameters if any)
    let filename = url.substring(url.lastIndexOf('/') + 1);
    if (filename.includes('?')) filename = filename.split('?')[0];
    if (!filename) filename = 'model.3dm';
    
    const file = new File([blob], filename, { type: blob.type });
    
    if (filename.toLowerCase().endsWith('.rhv')) {
      await loadSession(file);
    } else {
      await handleFile(file, rhinoLoader, gltfLoader);
    }
  } catch (e) {
    console.error('Error loading file from URL:', e);
    alert('Failed to load file from URL: ' + e.message);
  } finally {
    hideLoading();
  }
}

// ── Apply visibility settings for a specific display mode ──
export function applyModeSettings(mode) {
  const settings = S.modeSettings[mode];
  if (!settings) return;

  S.shadowsEnabled = settings.shadows;
  S.groundEnabled = settings.ground;

  const setCheckboxState = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.checked = val;
  };

  setCheckboxState('chk-edges-panel', settings.edges);
  setCheckboxState('chk-shadows-panel', settings.shadows);
  setCheckboxState('chk-ground-panel', settings.ground);
  setCheckboxState('chk-annotations-panel', settings.annotations);

  // Sync AO slider to this mode's default. Shaded/wireframe/technical have no
  // aoIntensity, so we leave the slider untouched (display.js disables GTAO
  // there anyway). The slider row's visibility is handled in session.js's
  // mode-change path.
  if (settings.aoIntensity !== undefined) {
    const aoSl = document.getElementById('sl-ao-intensity');
    const aoSlVal = document.getElementById('sl-ao-intensity-val');
    if (aoSl) {
      aoSl.value = settings.aoIntensity;
      if (aoSlVal) aoSlVal.textContent = settings.aoIntensity.toFixed(2);
      updateSliderFill(aoSl);
    }
  }

  // Sync secondary checkboxes
  const chkEdge = document.getElementById('chk-edge');
  if (chkEdge) chkEdge.checked = settings.edges;
  const chkShadows = document.getElementById('chk-shadows');
  if (chkShadows) chkShadows.checked = settings.shadows;
  const chkGround = document.getElementById('chk-ground');
  if (chkGround) chkGround.checked = settings.ground;
  const chkAnnotations = document.getElementById('chk-annotations');
  if (chkAnnotations) chkAnnotations.checked = settings.annotations;

  // Trigger side effects
  updateShadowCasting();
  
  if (S.groundEnabled && S.currentModel) {
    addGroundPlane(computeVisibleBoundingBox(S.currentModel));
  } else {
    removeGroundPlane();
  }

  // Gate annotation visibility through updateLayerVisibility so layer + Rhino
  // per-object hidden state are honored, not just this mode's annotation flag
  // (the chk-annotations-panel checkbox was synced to it above).
  if (S.annotationGroup) updateLayerVisibility();
}

// ── Switch display mode and apply its visibility settings ──
export function changeDisplayMode(mode) {
  if (S.currentMode === mode) return;
  
  if (!History.suppress) {
    History.push({
      type: 'displayMode',
      before: S.currentMode,
      after: mode
    });
  }

  S.currentMode = mode;
  
  // 1. Update dropdown active classes in UI
  const dropdown = document.getElementById('mode-dropdown');
  if (dropdown) {
    const activeItem = dropdown.querySelector(`.dropdown-item[data-mode="${mode}"]`);
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

  // 2. Apply the mode's visibility settings
  applyModeSettings(mode);

  // 3. Apply the rendering logic
  applyDisplayMode();
}

// ── Settings History Tracker ──────────────────────────────────────────────
(function initSettingsHistory() {
  const elements = [
    { id: 'sl-env-intensity', type: 'range' },
    { id: 'sl-measure-scale', type: 'range' },
    { id: 'sl-annotation-scale', type: 'range' },
    { id: 'sl-hdr-rotation', type: 'range' },
    { id: 'sl-ambient-panel', type: 'range' },
    { id: 'sl-ao-intensity', type: 'range' },
    { id: 'sl-sun-intensity', type: 'range' },
    { id: 'sl-sun-azimuth', type: 'range' },
    { id: 'sl-sun-elevation', type: 'range' },
    { id: 'sl-camera-fov', type: 'range' },
    { id: 'sl-damping-panel', type: 'range' },
    { id: 'sl-edge-angle', type: 'range' },
    { id: 'bg-radial-spread', type: 'range' },
    { id: 'cg-exposure', type: 'range' },
    { id: 'cg-contrast', type: 'range' },
    { id: 'cg-saturation', type: 'range' },
    { id: 'cg-temperature', type: 'range' },
    { id: 'env-preset-select', type: 'select' },
    { id: 'bg-type-select', type: 'select' },
    { id: 'bg-panel-c1', type: 'color' },
    { id: 'bg-panel-c2', type: 'color' },
    { id: 'bg-panel-c3', type: 'color' },
    { id: 'bg-panel-c4', type: 'color' },
    { id: 'chk-shadows-panel', type: 'checkbox' },
    { id: 'chk-ground-panel', type: 'checkbox' },
    { id: 'chk-sun-panel', type: 'checkbox' },
    { id: 'chk-edges-panel', type: 'checkbox' },
    { id: 'chk-annotations-panel', type: 'checkbox' }
  ];

  elements.forEach(item => {
    const el = document.getElementById(item.id);
    if (!el) return;

    let beforeValue = null;

    const captureStart = () => {
      if (History.suppress) return;
      beforeValue = (item.type === 'checkbox') ? el.checked : el.value;
    };

    if (item.type === 'range' || item.type === 'color') {
      el.addEventListener('pointerdown', captureStart);
      el.addEventListener('mousedown', captureStart);
      el.addEventListener('touchstart', captureStart);

      el.addEventListener('change', () => {
        if (History.suppress) return;
        const afterValue = (item.type === 'checkbox') ? el.checked : el.value;
        if (beforeValue !== null && beforeValue !== afterValue) {
          History.push({
            type: 'setting',
            elementId: item.id,
            before: beforeValue,
            after: afterValue
          });
        }
        beforeValue = null;
      });
    } else {
      el.addEventListener('focus', captureStart);
      el.addEventListener('pointerdown', captureStart);
      el.addEventListener('mousedown', captureStart);
      el.addEventListener('touchstart', captureStart);

      el.addEventListener('change', () => {
        if (History.suppress) return;
        const afterValue = (item.type === 'checkbox') ? el.checked : el.value;
        if (beforeValue !== null && beforeValue !== afterValue) {
          History.push({
            type: 'setting',
            elementId: item.id,
            before: beforeValue,
            after: afterValue
          });
        }
        beforeValue = null;
      });
    }
  });
})();

// ── Capacitor file-intent bridge ──────────────────────────────────────────
// Uses our custom FileOpenerPlugin for reliable file:// delivery.
// Falls back to the standard App.getLaunchUrl() if the plugin is absent.
(function initCapacitorFileOpener() {
  const cap = window.Capacitor;
  if (!cap) return; // not running in Capacitor (web-only mode)

  const FileOpener = cap?.Plugins?.FileOpener;
  const AppPlugin  = cap?.Plugins?.App;

  if (FileOpener) {
    // ── Cold start: app launched by tapping a file icon ──────────────────
    FileOpener.getPendingFile().then(data => {
      if (data && data.url) {
        console.log('[FileOpener] cold-start file:', data.url);
        handleIncomingSharedFile(data.url);
      }
    }).catch(e => console.error('[FileOpener] getPendingFile error:', e));

    // ── Hot start: file opened while app is already running ───────────────
    FileOpener.addListener('pendingFileOpen', data => {
      if (data && data.url) {
        console.log('[FileOpener] hot-start file:', data.url);
        handleIncomingSharedFile(data.url);
      }
    });

  } else if (AppPlugin) {
    // Fallback: standard Capacitor deep-link / launch URL
    AppPlugin.getLaunchUrl().then(data => {
      if (data && data.url) {
        console.log('[App] launch URL fallback:', data.url);
        handleIncomingSharedFile(data.url);
      }
    }).catch(e => console.error('[App] getLaunchUrl error:', e));

    AppPlugin.addListener('appUrlOpen', data => {
      if (data && data.url) {
        console.log('[App] appUrlOpen fallback:', data.url);
        handleIncomingSharedFile(data.url);
      }
    });
  }
})();

