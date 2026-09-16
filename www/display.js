import * as THREE from 'three';
import { S } from './state.js';
import { setupLights, updateGroundAppearance, applyFileSunSettings } from './lighting.js';
import { isPageVisuallyDark } from './helpers.js';

// ── Skybox sphere for rendered mode (bypasses tone mapping) ─────────────────
// In rendered mode with ACES tone mapping, scene.background color gets compressed.
// We add a huge BackSide sphere with toneMapped:false that bypasses the tone
// mapping pipeline, so the user-set bg color shows exactly. For other modes,
// scene.background is used directly (no ACES → no compression issue).

// Stub — bg skybox idea reverted. Background still uses scene.background.
// In rendered mode with ACES, white bg compresses to ~86% (light gray).
// Acceptable trade-off for PBR quality.
export function updateBgSkybox() {
  // No-op for now. May reintroduce a proper skybox approach later.
  const sky = S.scene?.getObjectByName('bg-skybox') || S.camera?.getObjectByName('bg-skybox');
  if (sky) {
    sky.geometry?.dispose();
    sky.material?.dispose();
    sky.parent?.remove(sky);
  }
}

export function applySceneBackground() {
  if (S.scene) {
    const bgType = document.getElementById('bg-type-select')?.value || 'solid';
    if (bgType === 'hdr') {
      S.scene.backgroundIntensity = S.scene.environmentIntensity !== null ? S.scene.environmentIntensity : 1.0;
    } else {
      S.scene.backgroundIntensity = 1.0;
    }
  }

  if (S.currentMode === 'technical') { 
    S.scene.background = new THREE.Color(0xffffff); 
    return; 
  }

  const bgType = document.getElementById('bg-type-select')?.value || 'solid';

  // HDR environment as background — uses the same PMREMGenerator texture
  // that drives IBL, so reflections and background match perfectly.
  if (bgType === 'hdr') {
    if (S.environmentMap) {
      S.scene.background = S.environmentMap;
      S.scene.backgroundBlurriness = 0;
    }
    updateBgSkybox();
    return;
  }

  const c1 = document.getElementById('bg-panel-c1')?.value || '#ffffff';
  const c2 = document.getElementById('bg-panel-c2')?.value || '#e0e0e0';

  if (S.bgTexture) { S.bgTexture.dispose(); S.bgTexture = null; }

  if (bgType === 'solid') {
    S.scene.background = new THREE.Color(c1);

  } else if (bgType === 'gradient2') {
    const canvas = document.createElement('canvas');
    canvas.width = 4; canvas.height = 256;
    const ctx  = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, c1);
    grad.addColorStop(1, c2);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 4, 256);
    S.bgTexture = new THREE.CanvasTexture(canvas);
    S.bgTexture.mapping = THREE.UVMapping;
    S.scene.background = S.bgTexture;

  } else if (bgType === 'radial') {
    const spread = parseFloat(document.getElementById('bg-radial-spread')?.value ?? 0.5);
    const size   = 256;
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx    = canvas.getContext('2d');
    const cx = size / 2, cy = size / 2;
    const outerR = size * 0.72;
    const innerR = outerR * (1.0 - spread);
    const grad   = ctx.createRadialGradient(cx, cy, innerR, cx, cy, outerR);
    grad.addColorStop(0, c1);
    grad.addColorStop(1, c2);
    ctx.fillStyle = c2;
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    S.bgTexture = new THREE.CanvasTexture(canvas);
    S.bgTexture.minFilter = THREE.LinearFilter;
    S.bgTexture.magFilter = THREE.LinearFilter;
    S.scene.background = S.bgTexture;

  } else if (bgType === 'gradient4') {
    const c3 = document.getElementById('bg-panel-c3')?.value || '#2d3748';
    const c4 = document.getElementById('bg-panel-c4')?.value || '#1a202c';
    const hexToRgb = (hex) => {
      const num = parseInt(hex.slice(1), 16);
      return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
    };
    const rgb1 = hexToRgb(c1), rgb2 = hexToRgb(c2);
    const rgb3 = hexToRgb(c3), rgb4 = hexToRgb(c4);
    const size = 128;
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx     = canvas.getContext('2d');
    const imgData = ctx.createImageData(size, size);
    const data    = imgData.data;
    for (let y = 0; y < size; y++) {
      const v = y / (size - 1), invV = 1.0 - v;
      for (let x = 0; x < size; x++) {
        const u = x / (size - 1), invU = 1.0 - u;
        const w1 = invU * invV, w2 = u * invV, w3 = invU * v, w4 = u * v;
        const idx = (y * size + x) * 4;
        data[idx]   = Math.round(rgb1.r * w1 + rgb2.r * w2 + rgb3.r * w3 + rgb4.r * w4);
        data[idx+1] = Math.round(rgb1.g * w1 + rgb2.g * w2 + rgb3.g * w3 + rgb4.g * w4);
        data[idx+2] = Math.round(rgb1.b * w1 + rgb2.b * w2 + rgb3.b * w3 + rgb4.b * w4);
        data[idx+3] = 255;
      }
    }
    ctx.putImageData(imgData, 0, 0);
    S.bgTexture = new THREE.CanvasTexture(canvas);
    S.bgTexture.minFilter = THREE.LinearFilter;
    S.bgTexture.magFilter = THREE.LinearFilter;
    S.scene.background = S.bgTexture;
  }

  // Update skybox to reflect new bg color (rendered mode only)
  updateBgSkybox();

}

export function applyFileBackground() {
  const bgSel    = document.getElementById('bg-type-select');
  const c1Input  = document.getElementById('bg-panel-c1');
  const c2Input  = document.getElementById('bg-panel-c2');
  const c3Input  = document.getElementById('bg-panel-c3');
  const c4Input  = document.getElementById('bg-panel-c4');
  if (!bgSel) return;

  // bg type — driven by S.fileDefaultBgStyle (loaders.js sets it from
  // rs.backgroundStyle enum, with 4-corner upgrade if RDK XML carries one).
  let newType = 'solid';
  const styleStr = String(S.fileDefaultBgStyle || '').toLowerCase();
  if (styleStr === 'gradient4')      newType = 'gradient4';
  else if (styleStr === 'gradient2') newType = 'gradient2';
  else if (styleStr === 'solid')     newType = 'solid';
  else if (styleStr.includes('gradient')) newType = 'gradient2';
  bgSel.value = newType;

  // Colors — already stored as sRGB hex strings in state (no THREE.Color round-trip).
  const isDark = isPageVisuallyDark();
  const defaults = isDark
    ? { c1: '#24252a', c2: '#1b1c20', c3: '#2d3748', c4: '#1a202c' }
    : { c1: '#ffffff', c2: '#e0e0e0', c3: '#d6dae0', c4: '#bfc4cc' };

  // For gradient4, prefer 4 explicit corners. Map TL→c1, TR→c2, BL→c3, BR→c4
  // (matches the bilinear-weight layout in applySceneBackground's gradient4 branch).
  const hex1 = (newType === 'gradient4' ? S.fileBackgroundColorTL : S.fileBackgroundColorTop)    || defaults.c1;
  const hex2 = (newType === 'gradient4' ? S.fileBackgroundColorTR : S.fileBackgroundColorBottom) || defaults.c2;
  const hex3 = (newType === 'gradient4' ? S.fileBackgroundColorBL : null) || defaults.c3;
  const hex4 = (newType === 'gradient4' ? S.fileBackgroundColorBR : null) || defaults.c4;

  updateColorPickerInput(c1Input, hex1);
  updateColorPickerInput(c2Input, hex2);
  updateColorPickerInput(c3Input, hex3);
  updateColorPickerInput(c4Input, hex4);

  const isSolid  = newType === 'solid';
  const isRadial = newType === 'radial';
  const isGrad4  = newType === 'gradient4';
  document.getElementById('picker-c1')?.classList.remove('hidden');
  document.getElementById('picker-c2')?.classList.toggle('hidden', isSolid);
  document.getElementById('picker-c3')?.classList.toggle('hidden', !isGrad4);
  document.getElementById('picker-c4')?.classList.toggle('hidden', !isGrad4);
  document.getElementById('bg-radial-section')?.classList.toggle('hidden', !isRadial);

  // Apply file sun settings (on/off, azimuth, elevation, intensity) as well
  try {
    applyFileSunSettings();
  } catch (err) {
    console.warn('[display] applyFileSunSettings err:', err);
  }
}

function updateColorPickerInput(inputEl, hex) {
  if (!inputEl) return;
  inputEl.value = hex;
  const wrapper = inputEl.parentNode;
  if (wrapper && wrapper.classList.contains('clr-field')) {
    wrapper.style.color = hex;
    const btn = wrapper.querySelector('button');
    if (btn) btn.style.backgroundColor = hex;
  }
  inputEl.dispatchEvent(new Event('input', { bubbles: true }));
}

// ── Display Modes ────────────────────────────────────────────────────────────

export function clearTechnicalOutlines() {
  if (!S.currentModel) return;
  S.currentModel.traverse(child => {
    if (!child.isMesh) return;
    const outline = child.getObjectByName('rhino-outline');
    if (outline) { outline.material.dispose(); child.remove(outline); }
  });
}

export function addTechnicalOutline(mesh) {
  // BackSide silhouette via uniform scale. Use a small factor so thin objects
  // (walls, plates) don't get overwhelmed by black bleed.
  // 1.03 scale → 3% bleed (e.g. 150mm on a 5m wall) is too much.
  // 1.005 scale → 0.5% bleed is barely visible but still gives a silhouette.
  const mat = new THREE.MeshBasicMaterial({
    color: 0x000000, side: THREE.BackSide,
    depthWrite: false
  });
  const outline = new THREE.Mesh(mesh.geometry, mat);
  outline.name = 'rhino-outline';
  outline.renderOrder = 1;
  outline.scale.setScalar(1.005);
  mesh.add(outline);
}

export function applyDisplayMode() {
  if (!S.currentModel) return;

  clearTechnicalOutlines();
  setupLights();

  // OutlinePass: enable in technical mode, register all meshes for silhouette.
  if (S.outlinePass) {
    if (S.currentMode === 'technical') {
      S.outlinePass.enabled = true;
      const meshes = [];
      S.currentModel.traverse(c => {
        if (c.isMesh && c.name !== 'rhino-edges' && c.name !== 'rhino-outline'
            && c.name !== 'selection-outline' && c.name !== 'ground-plane') {
          meshes.push(c);
        }
      });
      S.outlinePass.selectedObjects = meshes;
    } else {
      S.outlinePass.enabled = false;
      S.outlinePass.selectedObjects = [];
    }
  }

  if (S.renderer) {
    // Rendered mode gets a tone curve; the CAD-flat modes do not.
    //
    // Without one, a real environment blows out the saturated materials: measured
    // on a Rhino export lit by an outdoor HDR, half the cyan sphere's pixels and a
    // third of the red one's had a channel pinned at 255. Clipping a channel does
    // not just brighten — it *saturates*, because the channels that were already
    // lower stay put, so the surface loses its shading and reads as flat poster
    // colour next to the same model in Rhino.
    //
    // It costs nothing where the old comment feared it would. A solid
    // `scene.background` never reaches the tone curve at all: three.js sets it as
    // the WebGL clear colour, which bypasses the shader — verified, #ffffff still
    // reads 255,255,255 under Neutral and ACES alike. Only a gradient background
    // is affected, being a CanvasTexture (white → 240 under Neutral).
    //
    // Neutral over ACES because it is the one that keeps the colours: on the same
    // scene ACES flattened chroma from 57 to 38 while Neutral held it at 61.
    //
    // Not switched on the *background* type, deliberately. Tying the tone curve to
    // the background would mean picking a different backdrop changed how every
    // material looks; tying it to the display mode is a choice the user makes about
    // how the model is drawn.
    S.renderer.toneMapping = S.currentMode === 'rendered'
      ? THREE.NeutralToneMapping
      : THREE.NoToneMapping;
    S.renderer.toneMappingExposure = 1.0;
  }
  if (S.scene) {
    // Dynamically match the background intensity to the environment light intensity (HDR brightness) only if background mode is HDR
    const bgType = document.getElementById('bg-type-select')?.value || 'solid';
    if (bgType === 'hdr') {
      S.scene.backgroundIntensity = S.scene.environmentIntensity !== null ? S.scene.environmentIntensity : 1.0;
    } else {
      S.scene.backgroundIntensity = 1.0;
    }
  }

  // Manage a skybox sphere that bypasses tone mapping so user-set background
  // color appears exactly as intended even in rendered (ACES) mode.
  updateBgSkybox();

  // Environment map (skylight) — Arch + Rendered use it for AO + reflections.
  // Shaded/Wireframe/Technical: no env (flat/specific look).
  if (['arctic', 'rendered'].includes(S.currentMode) && S.environmentMap) {
    S.scene.environment = S.environmentMap;
  } else {
    S.scene.environment = null;
  }

  // Shadow control by mode:
  // - shaded/arctic/rendered: shadows if sun enabled
  // - wireframe/technical: NO shadows (clean look)
  const modeWantsShadows = ['shaded', 'arctic', 'rendered'].includes(S.currentMode);
  if (S.sunLight) {
    S.sunLight.castShadow = modeWantsShadows && S.shadowsEnabled;
    if (modeWantsShadows && S.shadowsEnabled) {
      // Dispose stale shadow map so THREE.js generates a fresh one next frame.
      // Without this, switching shaded→arctic keeps a stale/invalid shadow map
      // and shadows don't reappear until the sun is re-toggled.
      if (S.sunLight.shadow.map) { S.sunLight.shadow.map.dispose(); S.sunLight.shadow.map = null; }
      S.sunLight.shadow.camera.updateProjectionMatrix();
    }
  }
  S.currentModel.traverse(c => {
    if (c.isMesh) {
      c.castShadow    = modeWantsShadows && S.shadowsEnabled;
      c.receiveShadow = modeWantsShadows && S.shadowsEnabled;
    }
  });

  if (S.ssaoPass) S.ssaoPass.enabled = false;
  if (S.gtaoPass) S.gtaoPass.enabled = false;

  // GTAO — world-space radius computed from the model bbox makes AO scale-
  // invariant: 5% of the largest dimension gives the same visual density for
  // a 20 mm jewelry ring and a 50 m building (same ratio the three.js example
  // uses: radius ~0.25 on ~5-unit objects).
  // screenSpaceRadius: false matches the three.js example and avoids the
  // shader path that was producing AO = 1.0 everywhere when true was set.

  const pdParams = {
    lumaPhi: 10.0, depthPhi: 2.0, normalPhi: 3.0,
    radius: 4.0, radiusExponent: 1.0, rings: 2.0, samples: 16
  };

  // 5 % of the model's longest axis — same proportional radius as the three.js
  // GTAO example scene (0.25 unit radius on ~5 unit objects).
  let aoRadiusWS = 1.0;
  if (S.currentModel) {
    const _b = new THREE.Box3();
    S.currentModel.traverse(c => {
      if (c.isMesh && !['rhino-edges','rhino-outline','selection-outline','ground-plane'].includes(c.name))
        _b.expandByObject(c);
    });
    if (!_b.isEmpty()) {
      const _sz = _b.getSize(new THREE.Vector3());
      const _d  = Math.max(_sz.x, _sz.y, _sz.z);
      if (_d > 0) aoRadiusWS = _d * 0.05;
    }
  }

  // thickness must scale with the model. In the GTAO shader:
  //   if (abs(viewDelta.z) < thickness) → accept occluder
  // three.js example uses thickness=1.0 because 1 unit ≈ 1 m there, so 1.0 = 1 m tolerance.
  // Our models are in mm → thickness=1.0 = 1 mm → rejects every real occluder
  // (ring prong 15 mm above band, wall corner 200-2000 mm depth delta, etc.) → AO = 1.0.
  // Fix: scale to model size. 20× radius = ~100% of model bbox, safely covers all adjacent
  // surfaces while staying far below the background (which sits at far = dist × 50).
  const gtaoParams = {
    radius:            aoRadiusWS,          // 5 % of model size (world-space)
    distanceExponent:  1.0,
    thickness:         aoRadiusWS * 20.0,  // scale with model — was 1.0 (only 1 mm!)
    scale:             1.0,
    samples:           16,
    distanceFallOff:   1.0,
    screenSpaceRadius: false               // world-space mode — matches three.js example
  };

  switch (S.currentMode) {
    case 'arctic':
      if (S.gtaoPass) {
        S.gtaoPass.output         = 0; // OUTPUT.Default — blend AO with scene
        S.gtaoPass.enabled        = true;
        // blend formula: mix(white, AO, intensity) then MultiplyBlend onto scene.
        // intensity > 1 clamps AO < (1 - 1/intensity) to pure black — avoid this.
        // three.js example slider max is 1.0.
        // Read from the AO slider so the user-facing control actually controls
        // GTAO. Falls back to the mode default if the slider is missing.
        S.gtaoPass.blendIntensity = parseFloat(
          document.getElementById('sl-ao-intensity')?.value
          ?? S.modeSettings?.arctic?.aoIntensity ?? 0.7
        );
        S.gtaoPass.updateGtaoMaterial(gtaoParams);
        S.gtaoPass.updatePdMaterial(pdParams);
      }
      break;

    case 'rendered':
      if (S.gtaoPass) {
        S.gtaoPass.output         = 0;
        S.gtaoPass.enabled        = true;
        S.gtaoPass.blendIntensity = parseFloat(
          document.getElementById('sl-ao-intensity')?.value
          ?? S.modeSettings?.rendered?.aoIntensity ?? 0.4
        );
        S.gtaoPass.updateGtaoMaterial(gtaoParams);
        S.gtaoPass.updatePdMaterial(pdParams);
      }
      break;


  }

  applySceneBackground();
  if (S.currentMode === 'technical')
    S.scene.background = new THREE.Color(0xffffff);

  updateGroundAppearance();

  const edgeOverlay = document.getElementById('chk-edges-panel')?.checked ?? true;

  S.currentModel.traverse(child => {
    if (!((child.isMesh || child.isLine) && child.userData.originalMaterial)) return;
    if (child.name === 'rhino-outline') return;
    if (child.name === 'selection-outline') return;
    child.renderOrder = 0;

    // Helper: raw color from layer/object (PRESERVES black/white, with automatic theme inversion).
    // In dark mode, pure black/very dark curves map to white. In light mode, pure white/very light curves map to black.
    const childAttrs = child.userData.attributes || {};
    const childLayer = S.parsedLayers.find(l => l.index === childAttrs.layerIndex);
    const rawColor = () => {
      if (child.userData.objectColorCustom) {
        return new THREE.Color(child.userData.objectColorCustom);
      }
      
      const getColorSourceValue = (cs) => {
        if (cs === undefined || cs === null) return 0; // Default to ByLayer
        if (typeof cs === 'number') return cs;
        if (typeof cs === 'object' && typeof cs.value === 'number') return cs.value;
        return 0;
      };
      const csVal = getColorSourceValue(childAttrs.colorSource);
      const isByObject = csVal === 1;
      const isByMaterial = csVal === 2;

      const oc = childAttrs.objectColor;
      const out = new THREE.Color(0, 0, 0);
      // Rhino layer/object colors are sRGB. Pass SRGBColorSpace so r169's
      // ColorManagement converts to linear before storing — otherwise values
      // are stored raw and curves/edges render with a hue shift (e.g. cyan
      // #00cdff → too-blue because G channel reads ~0.61 instead of ~0.39).
      if (isByMaterial && child.material?.color) {
        out.copy(child.material.color);
      } else if (isByObject && oc) {
        out.setRGB(oc.r / 255, oc.g / 255, oc.b / 255, THREE.SRGBColorSpace);
      } else if (childLayer?.color) {
        const lc = childLayer.color;
        out.setRGB((lc.r ?? lc.R ?? 0) / 255, (lc.g ?? lc.G ?? 0) / 255, (lc.b ?? lc.B ?? 0) / 255, THREE.SRGBColorSpace);
      } else if (oc && ((oc.r ?? 0) > 0 || (oc.g ?? 0) > 0 || (oc.b ?? 0) > 0)) {
        // Fallback: objectColor stores the layer color redundantly in Rhino for ByLayer objects.
        // Use it when the layer lookup fails (e.g., index mismatch between cleanDoc and original doc).
        out.setRGB(oc.r / 255, oc.g / 255, oc.b / 255, THREE.SRGBColorSpace);
      }

      // Curves keep their Rhino-original color — no black↔white flip based
      // on UI theme. Scene background mirrors the 3dm file, so the file's
      // intended color is what the user should see.
      return out;
    };

    if (child.isLine) {
      const modeSettings = S.modeSettings[S.currentMode] || {};
      const modeAllowsCurves = modeSettings.curves !== false;
      // Also respect layer visibility — don't show curves on hidden layers
      const curveLayerVis = childLayer ? childLayer.visible : true;
      const curveObjVis = !S.hiddenObjects?.has(child);
      // Rhino per-object hidden state (3DMLoader applies layer visibility only).
      // S.revealHidden ("Show All") overrides it to reveal file-author-hidden.
      const curveRhinoVis = S.revealHidden || child.userData?.attributes?.visible !== false;
      child.visible = modeAllowsCurves && curveLayerVis && curveObjVis && curveRhinoVis;

      // Ensure the line has its own unique cloned material from originalMaterial,
      // so modifying its color does not affect other lines sharing the material.
      if (child.userData.originalMaterial) {
        if (child.material !== child.userData.originalMaterial) {
          child.material = child.userData.originalMaterial;
        }
      }

      // THREE.js 3DM loader may create LineBasicMaterial with vertexColors:true,
      // which overrides material.color entirely. Disable vertex colors so our
      // rawColor() value is actually applied.
      if (child.material && child.material.vertexColors) {
        child.material.vertexColors = false;
        child.material.needsUpdate = true;
      }
      child.material.color.copy(rawColor());
      return;
    }

    const orig  = child.userData.originalMaterial;
    const edges = child.getObjectByName('rhino-edges');
    if (edges) edges.renderOrder = 0;
    // Surfaces carrying exact edges get a larger depth offset below, so they must
    // not share a material with surfaces that have none.
    const exactEdgeKey = edges?.userData?.role === 'rhino-edges' ? ':e' : '';

    switch (S.currentMode) {

      case 'wireframe': {
        // Wireframe mode always shows edges over depth-only (invisible) faces,
        // regardless of the edge-overlay panel toggle — that toggle only governs
        // optional edge overlay in the OTHER shaded modes. Previously, with the
        // panel off, wireframe fell back to a solid shaded render (and the edge
        // geometry was never built at load), so the model looked shaded.
        child.material = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true });
        let wfEdges = edges;
        if (!wfEdges && child.isMesh && child.geometry) {
          // Built on demand when edges weren't generated at load time.
          addEdges(child);
          wfEdges = child.getObjectByName('rhino-edges');
        }
        if (wfEdges) {
          wfEdges.visible = true;
          // Use raw color which has automatic theme inversion for black/white lines
          wfEdges.material.color.copy(rawColor());
        }
        break;
      }

      case 'shaded': {
        const base = child.userData.shadedMaterial || orig;
        const custom = child.userData.objectColorCustom;
        const build = () => {
          const m = base.clone();
          m.polygonOffset = true; m.polygonOffsetFactor = 1; m.polygonOffsetUnits = 1;
          m.roughness = 0.85; m.metalness = 0.05;
          // Two-sided faces — match Rhino's shaded viewport so open surfaces and
          // the inside of non-solid polysurfaces stay visible from behind.
          m.side = THREE.DoubleSide;
          if (custom !== undefined) m.color?.set(custom);
          m.needsUpdate = true;
          return m;
        };
        // A per-object colour is by definition not shareable.
        child.material = custom !== undefined
          ? build()
          : shareMaterial(materialKey('shaded', child, base), build);
        if (edges) {
          edges.visible = edgeOverlay;
          edges.material.color.setHex(0x000000);
          edges.renderOrder = 1;
          edges.material.depthWrite = false;
        }
        break;
      }

      case 'arctic': {
        // Architecture: near-white surfaces + env-map IBL + sun shadows. Identical
        // for every object, so the whole model needs exactly one of these.
        child.material = shareMaterial('arctic' + exactEdgeKey, () => {
          const m = new THREE.MeshStandardMaterial({
            color: 0xf0f0f0, roughness: 0.95, metalness: 0.0,
            side: THREE.DoubleSide
          });
          m.polygonOffset = true; m.polygonOffsetFactor = 1; m.polygonOffsetUnits = 1;
          // Rely on scene.environment instead of explicit envMap so HDR changes apply.
          // 0.4 keeps IBL contribution modest — supplemental lights add the rest.
          m.envMapIntensity = 0.4;
          return m;
        });
        if (edges) {
          edges.visible = edgeOverlay;
          edges.material.color.setHex(0x000000);
          edges.renderOrder = 1;
          edges.material.depthWrite = false;
        }
        break;
      }

      case 'rendered': {
        const base = child.userData.renderedMaterial || orig;
        // Resolve the effective custom material first — it decides shareability.
        // Priority: object-level customMaterial > layer customMaterial (when ByLayer) > none
        let effectiveCustom = child.userData.customMaterial;
        // Switching an object to ByLayer has to *detach* it from the material it
        // carried, not just stop overriding one — in Rhino the object then uses the
        // layer's material and nothing of its own survives. Its base material here is
        // still the per-object one the file assigned, and leaving that in place shows
        // up two ways: with an empty layer nothing changes at all, and with a layer
        // material the layer's colour merely tints the object's own maps, so a wood
        // texture and its bump carry on through a plain red layer material.
        //
        // Detaching starts from Rhino's default material — the same white matte
        // sphere the Layers panel already draws for "no material assigned" — and lets
        // the layer's own settings land on that instead.
        //
        // Objects the file itself marked ByLayer are untouched: their base material
        // *is* the layer's, resolved by the exporter, textures and all, so there is
        // nothing to detach and doing so would throw away maps the layer really has.
        let detachedFromOwnMaterial = false;
        if (!effectiveCustom && child.userData.isMaterialByLayer) {
          const childLayerIdx = (child.userData.attributes || {}).layerIndex ?? 0;
          const childLayer = S.parsedLayers.find(l => l.index === childLayerIdx);
          if (childLayer?.customMaterial) effectiveCustom = childLayer.customMaterial;
          detachedFromOwnMaterial = !child.userData.originalIsMaterialByLayer;
        }

        const buildRendered = () => {
        let m = detachedFromOwnMaterial ? defaultLayerMaterial() : base.clone();
        // A standard material silently drops transmission, ior and clearcoat, so a
        // layer asking for any of them has to be upgraded first — otherwise the
        // slider moves and nothing happens. Only on request: a physical material
        // costs more to compile and most of a model does not need one.
        if (!m.isMeshPhysicalMaterial && wantsPhysicalLobes(effectiveCustom)) m = toPhysical(m);
        if (m.isMeshPhysicalMaterial) normalizeRhinoPhysical(m);
        // An anisotropic BRDF is evaluated in a tangent frame. Without a tangent
        // attribute the frame is undefined and the surface renders as hard-edged
        // black wedges rather than degrading to isotropic, so the safe reading of
        // "anisotropy on geometry that cannot support it" is none. Guarded here
        // rather than at export because a .glb from anywhere can carry it.
        if (m.anisotropy > 0 && !child.geometry?.attributes?.tangent) m.anisotropy = 0;
        // Not when detached: materialColor is the object's own material colour, and
        // re-applying it would put back the very thing ByLayer just took away.
        if (child.userData.materialColor && !detachedFromOwnMaterial)
          m.color.copy(child.userData.materialColor);
        // A near-zero roughness is treated as a missing value rather than a request
        // for a mirror — except on metal and glass, where a mirror finish is the
        // whole point and the floor would turn chrome into pewter and a window into
        // frosted glass.
        if (m.roughness !== undefined && m.roughness < 0.05
            && !(m.metalness > 0.9) && !(m.transmission > 0)) m.roughness = 0.4;
        if (m.metalness === undefined) m.metalness = 0.0;
        m.polygonOffset = true; m.polygonOffsetFactor = 1; m.polygonOffsetUnits = 1;
        // Don't set m.envMap directly — that overrides scene.environment and prevents
        // HDR changes from taking effect. envMapIntensity controls strength.
        m.envMap = null;
        m.envMapIntensity = 1.0;
        applyCustomToMaterial(m, effectiveCustom);
        reconcileTransmission(m);
        // Transparency blends once in Rhino. Two-sided geometry blends it twice —
        // three.js draws back faces and then front faces — and on a closed solid
        // that is pure error, because the inside is never seen. Measured on a
        // 28%-transparent sphere: the background arrived at 0.28² = 7.8% and the
        // sphere read as opaque; single-sided brought it back to 28%.
        //
        // Only closed shells are switched. An open transparent surface genuinely
        // needs its back face, or a glass wall vanishes when viewed from inside.
        if ((m.transparent || m.transmission > 0) && child.userData.solid)
          m.side = THREE.FrontSide;
        m.needsUpdate = true;
        return m;
        };

        // Only an OBJECT-level custom material forces its own instance. A layer's
        // custom material is shared by everything on that layer, and layerIndex is
        // already part of the key — but its *contents* go in too, so editing a
        // layer's material does not hand back the cached material built from the
        // previous settings.
        child.material = child.userData.customMaterial
          ? buildRendered()
          : shareMaterial(
              materialKey('rendered', child, base) + '|' +
              (child.userData.materialColor?.getHexString() ?? '-') + '|' +
              (effectiveCustom ? JSON.stringify(effectiveCustom) : '-') +
              // A detached object ignores `base` entirely, so it must not be handed
              // a material cached under the base it no longer uses.
              (detachedFromOwnMaterial ? '|bylayer-default' : ''),
              buildRendered);
        if (edges) {
          edges.visible = edgeOverlay;
          edges.material.color.setHex(0x000000);
          // renderOrder=1 + depthWrite:false ensures lines always draw on top
          // of face geometry, preventing fragmentation from z-fighting.
          edges.renderOrder = 1;
          edges.material.depthWrite = false;
        }
        break;
      }

      case 'technical': {
        child.renderOrder = 0;
        const orig = child.userData.originalMaterial;
        const isTransparent = orig?.transparent && (orig?.opacity ?? 1) < 0.95;
        // Two possible materials for the whole model, not two per object.
        child.material = shareMaterial((isTransparent ? 'technical:t' : 'technical') + exactEdgeKey, () =>
          isTransparent
            ? new THREE.MeshBasicMaterial({
                color: 0xffffff, side: THREE.DoubleSide,
                transparent: true, opacity: 0.08,
                polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
                depthWrite: false
              })
            : new THREE.MeshBasicMaterial({
                color: 0xffffff, side: THREE.DoubleSide,
                polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1
              }));
        if (edges) {
          edges.visible = edgeOverlay;
          edges.material.color.setHex(0x000000);
          edges.renderOrder = 2;
          edges.material.depthWrite = false;
        }
        break;
      }

    }

    // After the mode has chosen a material: surfaces that carry exact edges need
    // a depth offset or the outline breaks up into dashes. Applied here because
    // this is the one place every mode's material assignment converges.
    if (edges?.userData?.role === 'rhino-edges') applyExactEdgeSurfaceOffset(child);
  });

  // ── Sync the display mode dropdown button UI dynamically ──
  const dropdown = document.getElementById('mode-dropdown');
  if (dropdown) {
    const activeItem = dropdown.querySelector(`.dropdown-item[data-mode="${S.currentMode}"]`);
    if (activeItem) {
      // Keep dropdown active classes in sync
      dropdown.querySelectorAll('.dropdown-item').forEach(b => b.classList.toggle('active', b === activeItem));
      // Update top trigger button label & title
      const triggerBtn = document.getElementById('btn-mode-dropdown');
      if (triggerBtn) {
        const label = activeItem.querySelector('span').textContent.split(' ')[0];
        const triggerLabel = triggerBtn.querySelector('span');
        if (triggerLabel) triggerLabel.textContent = label;
        triggerBtn.title = `Display Mode (${label})`;
        
        // Clone and swap the active mode's SVG icon onto the trigger button
        const svg = activeItem.querySelector('svg').cloneNode(true);
        const oldSvg = triggerBtn.querySelector('svg');
        if (oldSvg) {
          triggerBtn.replaceChild(svg, oldSvg);
        }
      }
    }
  }
}

// ── Material Utilities ───────────────────────────────────────────────────────

export function fixMaterialTransparency(mat) {
  if (!mat) return;
  if (mat.opacity !== undefined && mat.opacity < 0.99) {
    mat.transparent = true;
    mat.depthWrite  = false;
  }
}

// Rhino object types with no triangles to run a dihedral pass over at all.
//
// Point clouds are the whole list. A Rhino Mesh used to be here too, on the
// grounds that a threshold pass over an imported tree or a scanned terrain yields
// noise rather than an outline — true, but it is an argument for a control, not
// for an exclusion, and the control already exists. Excluding the type outright
// left the user no way to say "outline my meshes, but only above 60°", and it
// treated the same triangles differently depending on the container they arrived
// in: an STL of a terrain was outlined while the same terrain inside a .3dm was
// not. Mesh objects are now eligible and the Edge Angle slider governs them.
//
// In a .3dm that means the slider governs the mesh objects and nothing else, which
// is what makes it a usable control rather than a global one: Brep and SubD
// objects there carry exact edges marked with userData.role, and both the slider
// and the rebuild path skip those on sight.
//
// The cost that motivated the old exclusion is handled where it belongs. Nothing
// is extracted at load unless the model is light enough (see HEAVY_TRIANGLE_COUNT
// in loaders.js), and turning the overlay on afterwards extracts on demand behind
// a progress indicator.
const NO_TOPOLOGY_EDGE_TYPES = new Set(['PointSet', 'PointCloud']);

/**
 * Whether dihedral edge extraction can run on this object at all.
 *
 * An absent objectType means the geometry did not come from a .3dm (STL, 3MF, GLB,
 * STEP/IGES via OCCT), and those are eligible for the same reason a Rhino Mesh is:
 * a triangle soup is exactly what the threshold pass is for.
 */
export function isEdgeEligible(mesh) {
  const type = mesh?.userData?.objectType ?? mesh?.userData?.attributes?.objectType;
  return !(type && NO_TOPOLOGY_EDGE_TYPES.has(type));
}

/**
 * Pushes a surface a fraction of a depth unit away from the viewer so the exact
 * edges lying on it are not swallowed by it.
 *
 * Only surfaces carrying exact edges need this. A dihedral edge reuses the mesh's
 * own vertices, so its depth is bit-identical to the triangle edge underneath and
 * the default LessEqualDepth test passes. An edge read from Brep or SubD topology
 * follows the *true* surface, while the render mesh is a chordal approximation
 * cutting inside it — so on curved geometry stretches of the curve fall behind
 * neighbouring facets and get culled, and the outline reads as a dashed line.
 *
 * Offsetting the surface rather than biasing the line, because the gap is a
 * world-space quantity while depth-buffer resolution is not: a constant clip-space
 * bias that clears the gap when zoomed out is too small when zoomed in. Polygon
 * offset is measured in depth-buffer units and includes a slope term, so it tracks
 * both automatically — which is what GL provides it for. It also cannot apply to
 * lines, only fills, so the surface is the only side that can carry it.
 *
 * Not depthTest:false on the edges, which would let edges on the far side of a
 * solid show through. Safe for the AO passes and the clipping-cap stencil: both
 * render with their own materials rather than these.
 */
// ── Shared display materials ─────────────────────────────────────────────────
//
// applyDisplayMode used to build a material per mesh per mode switch. On a model
// with 156,578 objects that produced 156,578 material instances where the file
// held 24 — one orange material copied 46,423 times — and three.js refreshes
// uniforms whenever the material instance changes between draws, so the copies
// cost real frame time as well as memory.
//
// Sharing is safe only where the objects would stay identical for the life of the
// model, so the key carries everything that can diverge later:
//
//  - layerIndex, because layer colour is editable at runtime and must move one
//    layer's objects without touching another's, even when the two currently
//    render the same colour;
//  - every visual property the mode sets from the object.
//
// An object with a per-object colour override never shares at all.
//
// Anything that mutates a material for one object — selection highlight, a colour
// picked in the properties panel — must call ensureOwnMaterial() first.
const sharedMaterials = new Map();

export function clearSharedMaterials() {
  for (const m of sharedMaterials.values()) m.dispose();
  sharedMaterials.clear();
}

// layerIndex first: it is the property that makes two identical-looking objects
// still need separate materials, because the layer panel can recolour one of them.
function materialKey(mode, mesh, base) {
  const layer = mesh.userData?.attributes?.layerIndex ?? -1;
  const m = base;
  return [
    mode, layer,
    m?.type, m?.color?.getHexString(), m?.opacity, m?.transparent, m?.depthWrite,
    m?.side, m?.roughness, m?.metalness, m?.emissive?.getHexString(),
    m?.map?.uuid ?? '-', m?.envMapIntensity,
    // Every image slot, not just the colour one. Two materials that differ only in
    // their normal or roughness map are different materials, and sharing on the
    // colour map alone would hand the first one's bumps to the second.
    m?.normalMap?.uuid ?? '-', m?.normalScale?.x,
    m?.roughnessMap?.uuid ?? '-', m?.metalnessMap?.uuid ?? '-',
    m?.aoMap?.uuid ?? '-', m?.aoMapIntensity,
    m?.emissiveMap?.uuid ?? '-',
    // The Physical-only lobes. They belong here for the same reason colour does:
    // rendered mode no longer flattens them away, so two materials that differ
    // only in transmission are genuinely different materials. Leaving them out
    // silently hands the first one back for both, which turns every piece of
    // glass on a layer into whatever the first material on it happened to be.
    m?.transmission, m?.ior, m?.thickness,
    m?.clearcoat, m?.clearcoatRoughness,
    m?.sheen, m?.sheenColor?.getHexString(),
    m?.specularIntensity, m?.anisotropy,
    // Exact edges make their surface carry a larger depth offset, which must not
    // leak onto objects that have no edges to protect.
    mesh.getObjectByName('rhino-edges')?.userData?.role === 'rhino-edges' ? 'e' : '-',
    // A closed shell drops its back faces when transparent, so it cannot share a
    // material with an open surface that keeps them.
    mesh.userData?.solid ? 's' : '-'
  ].join('|');
}

function shareMaterial(key, build) {
  let m = sharedMaterials.get(key);
  if (!m) {
    m = build();
    m.userData.__shared = true;
    sharedMaterials.set(key, m);
  }
  return m;
}

/**
 * Gives a mesh a material of its own so it can be mutated without dragging every
 * other object that happens to look the same along with it.
 *
 * Returns the material to mutate. Cheap and idempotent when the mesh already owns
 * one, so call it freely at the top of any per-object edit.
 */
export function ensureOwnMaterial(mesh) {
  const mat = mesh?.material;
  if (!mat || Array.isArray(mat)) return mat;
  if (!mat.userData.__shared) return mat;
  const own = mat.clone();
  own.userData.__shared = false;
  mesh.material = own;
  return own;
}

// Shared by every filtered edge material, so moving the slider is one assignment
// rather than a walk over the scene. three.js keeps the object reference we hand
// it in onBeforeCompile, so mutating .value reaches all of them.
const edgeAngleUniform = { value: 30 };

export function setEdgeAngleUniform(deg) {
  edgeAngleUniform.value = deg;
}

/**
 * Makes the edge-angle slider filter an exact edge object instead of ignoring it.
 *
 * Exact edges are the complete set of surface boundaries, which includes the
 * tangent-continuous ones — a fillet's two sides, a lofted patch join. Those are
 * real edges and Rhino draws them, but they are also the lines people mean when
 * they say a model looks busy, and the old dihedral extraction never showed them
 * because a tangent join has no angle to detect.
 *
 * So the producer measures the angle between the two surfaces meeting along each
 * edge and ships it per vertex, and the threshold becomes a filter over exact
 * geometry rather than a parameter that generates approximate geometry. Same
 * slider, same meaning, but nothing is rebuilt when it moves and the curves stay
 * exact at every setting — no faceting on curved surfaces, no smooth-but-real
 * edge dropped. Naked edges are tagged 180° so they survive any threshold, which
 * is what EdgesGeometry does with boundary edges too.
 *
 * Edges without the attribute — sampled from a .3dm in the browser, where
 * rhino3dm exposes no face adjacency to measure with — are left unfiltered.
 */
export function applyEdgeAngleFilter(line) {
  const geom = line?.geometry;
  const mat  = line?.material;
  if (!geom?.attributes?._angle || !mat || mat.userData.__edgeAngleFilter) return;
  mat.userData.__edgeAngleFilter = true;

  mat.onBeforeCompile = shader => {
    shader.uniforms.uEdgeAngleThreshold = edgeAngleUniform;
    shader.vertexShader =
      'attribute float _angle;\nvarying float vEdgeAngle;\n' +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n\tvEdgeAngle = _angle;'
      );
    shader.fragmentShader =
      'uniform float uEdgeAngleThreshold;\nvarying float vEdgeAngle;\n' +
      shader.fragmentShader.replace(
        '#include <clipping_planes_fragment>',
        '#include <clipping_planes_fragment>\n\tif ( vEdgeAngle < uEdgeAngleThreshold ) discard;'
      );
  };
  // Or the patched program gets served to an unpatched material with the same
  // parameters, and every line in the scene starts discarding.
  mat.customProgramCacheKey = () => 'edgeAngleFilter';
  mat.needsUpdate = true;
}

// Used for both the constant and the slope term. Chosen by testing, not derived:
// 1 (the conventional starting point) held at moderate distance but broke up again
// at close range on a concave junction, where the render mesh sits in FRONT of the
// true edge. 4 held from a whole-model view down to an extreme close-up, with no
// edges bleeding through thin geometry. Raise only with a case that needs it —
// too much offset and edges on the far side of a thin wall start showing through.
//
// The right structural fix is the near plane: this viewer runs near/far at roughly
// 6450:1, which leaves very little depth resolution to work with. Tightening that
// would let a much smaller offset do the same job.
const EXACT_EDGE_POLYGON_OFFSET = 4;

export function applyExactEdgeSurfaceOffset(mesh) {
  const mats = Array.isArray(mesh?.material) ? mesh.material
             : mesh?.material ? [mesh.material] : [];
  for (const mat of mats) {
    if (!mat) continue;
    // Raise, never just skip. Several display modes already set a 1/1 offset of
    // their own, so an "is it set?" guard here silently did nothing in exactly
    // the modes people look at — shaded, rendered and arctic.
    if (mat.polygonOffset
        && mat.polygonOffsetFactor >= EXACT_EDGE_POLYGON_OFFSET
        && mat.polygonOffsetUnits  >= EXACT_EDGE_POLYGON_OFFSET) continue;
    mat.polygonOffset       = true;
    mat.polygonOffsetFactor = Math.max(mat.polygonOffsetFactor || 0, EXACT_EDGE_POLYGON_OFFSET);
    mat.polygonOffsetUnits  = Math.max(mat.polygonOffsetUnits  || 0, EXACT_EDGE_POLYGON_OFFSET);
    mat.needsUpdate         = true;
  }
}

export function addEdges(mesh, thresholdAngle) {
  if (!mesh || !mesh.isMesh || mesh.isLine || !mesh.geometry) return;
  // Guard here as well as at the call sites: addEdges is reached from load,
  // display-mode changes and the angle slider, and a Mesh object must never
  // acquire dihedral edges through any of them.
  if (!isEdgeEligible(mesh)) return;

  // Skip if mesh is part of annotations
  let isAnn = false;
  let p = mesh.parent;
  while (p) {
    if (p.name === 'annotations-group') { isAnn = true; break; }
    p = p.parent;
  }
  if (isAnn) return;

  const angle = typeof thresholdAngle === 'number' ? thresholdAngle : (S.edgeThresholdAngle ?? 30);
  const eg   = new THREE.EdgesGeometry(mesh.geometry, angle);
  const line = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: 0x000000 }));
  line.name = 'rhino-edges';
  mesh.add(line);
}

// An edge object never belongs to an annotation or to a measurement: building
// EdgesGeometry on every measurement sphere is wasted work, and it also trips a
// three.js side effect where opaque depthTest:false meshes stop rendering after
// the applyDisplayMode() that follows — see issue history.
function _isEdgeExcludedByParent(child) {
  let p = child.parent;
  while (p) {
    if (p.name === 'annotations-group' || p === S.measurementGroup) return true;
    p = p.parent;
  }
  return false;
}

/**
 * Every mesh that would get dihedral edges but has none yet.
 *
 * The edge-overlay toggle needs this because the edges it is asked to show may
 * never have been built. A heavy model skips extraction at load and the toast
 * points the user straight at that toggle; a .3dm whose objects the Brep sampler
 * could not cover (mesh-derived geometry, or Breps past the sampling budget)
 * arrives in the same state. Flipping `.visible` alone then lights up only the
 * objects whose edges came from the file — which reads as "edges work for
 * exported models and not for opened ones".
 *
 * Separate from recreateAllEdges, which discards and re-extracts every dihedral
 * edge because the threshold moved. Here the threshold has not moved, so anything
 * already built is already correct and must be left alone — including the exact
 * edges the file supplied.
 */
export function findMeshesNeedingEdges() {
  const out = [];
  if (!S.scene) return out;
  S.scene.traverse(child => {
    if (!child.isMesh || child.isLine) return;
    if (['rhino-edges', 'rhino-outline', 'selection-outline', 'ground-plane'].includes(child.name)) return;
    if (!child.geometry) return;
    if (!isEdgeEligible(child)) return;
    if (child.children?.some(c => c.name === 'rhino-edges')) return;
    if (_isEdgeExcludedByParent(child)) return;
    out.push(child);
  });
  return out;
}

// Triangles the meshes above would have to walk — what decides whether the caller
// owes the user a progress indicator before it blocks the thread.
export function countTriangles(meshes) {
  let tris = 0;
  for (const m of meshes) {
    const g = m.geometry;
    if (!g) continue;
    if (g.index) tris += g.index.count / 3;
    else if (g.attributes?.position) tris += g.attributes.position.count / 3;
  }
  return Math.round(tris);
}

export function buildEdgesFor(meshes) {
  const angle = S.edgeThresholdAngle ?? 30;
  for (const m of meshes) addEdges(m, angle);
}

export function recreateAllEdges(thresholdAngle) {
  if (thresholdAngle !== undefined) {
    S.edgeThresholdAngle = thresholdAngle;
  }
  const angle = S.edgeThresholdAngle ?? 30;
  // Exact edges carrying an angle re-filter from this alone — no rebuild, and it
  // has to happen even when the traverse below finds nothing to regenerate.
  setEdgeAngleUniform(angle);
  if (!S.scene) return;

  S.scene.traverse(child => {
    if (child.isMesh && !['rhino-edges', 'rhino-outline', 'selection-outline', 'ground-plane'].includes(child.name)) {
      // No dihedral edges exist on ineligible geometry, so there is nothing to
      // rebuild — and returning here also makes sure the removal below can never
      // strip edges off an object that will not get them back.
      if (!isEdgeEligible(child)) return;

      if (_isEdgeExcludedByParent(child)) return;

      const oldEdges = child.getObjectByName('rhino-edges');
      // Edges the file supplied came from Brep topology: exact, with no dihedral
      // threshold to re-apply. Rebuilding them would substitute a coarser
      // approximation derived from the tessellation and pay the extraction cost
      // they exist to avoid. Checked per mesh rather than per model because a
      // single .rhv can mix both — Breps carry their edges, SubD derives them.
      if (oldEdges?.userData?.role === 'rhino-edges') return;
      if (oldEdges) {
        child.remove(oldEdges);
        oldEdges.geometry?.dispose();
        if (oldEdges.material) {
          if (Array.isArray(oldEdges.material)) {
            oldEdges.material.forEach(m => m.dispose());
          } else {
            oldEdges.material.dispose();
          }
        }
      }
      addEdges(child, angle);
    }
  });

  applyDisplayMode();
}

export function applyLayerColorsToModel(model) {
  if (!S.parsedLayers.length) return;
  model.traverse(child => {
    if (child.name === 'rhino-edges' || child.name === 'rhino-outline' || child.name === 'selection-outline') return;
    if ((!child.isMesh && !child.isLine) || !child.userData.originalMaterial) return;
    const attrs = child.userData.attributes || {};
    if (child.userData.isColorByLayer) {
      const layer = S.parsedLayers.find(l => l.index === attrs.layerIndex);
      if (layer?.color) {
        const lc = layer.color;
        // Build via hex string so r169 ColorManagement applies sRGB→linear
        // conversion. The 3-arg `new Color(r,g,b)` form routes through setRGB
        // which stores raw values (linear), causing a visible hue shift.
        const hex = '#' + [
          lc.r ?? lc.R ?? 0,
          lc.g ?? lc.G ?? 0,
          lc.b ?? lc.B ?? 0
        ].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
        const col = new THREE.Color().set(hex);
        
        if (!child.isLine) {
          // Mesh black → white safety mapping (mode-independent): a pitch-black
          // shaded mesh receives no lighting and reads as invisible blobs, so we
          // promote it to white. This is unrelated to UI theme.
          if (col.r < 0.08 && col.g < 0.08 && col.b < 0.08) {
            col.setHex(0xffffff);
          }
        }
        // Curves keep their Rhino-original color — no black↔white flip based
        // on UI theme.
        
        if (child.isLine) {
          if (child.userData.originalMaterial && child.material !== child.userData.originalMaterial) {
            child.material = child.userData.originalMaterial;
          }
          // Update line color directly
          child.material.color.copy(col);
          if (child.userData.originalMaterial) child.userData.originalMaterial.color.copy(col);
        } else {
          child.userData.originalMaterial.color.copy(col);
          if (child.userData.shadedMaterial) child.userData.shadedMaterial.color.copy(col);
        }
      }
    }
  });
}

// ── Correcting what 3DMLoader hands us ───────────────────────────────────────
// Every .3dm material arrives as a MeshPhysicalMaterial with Rhino's PBR channels
// filled in — clearcoat, sheen, anisotropy, transmission and all. Keeping those is
// the whole point; three of the slots just are not in three.js units.
//
// `ior` is not an index of refraction at all. 3DMLoader's constructor passes both
// `ior: material.indexOfRefraction` and `reflectivity: material.reflectivity`, and
// since three derives one from the other, whichever is applied last wins — which
// is reflectivity. Verified against the loader: `{ior: 1.52, reflectivity: 1.0}`
// yields ior 2.333, and every reflectivity-1 material in a test document reports
// exactly that. So Rhino's real IOR never reaches us, and the value that does is a
// re-encoded reflectivity that would light glass like diamond (F0 .16 against the
// .04 of a dielectric). three's own default is the honest answer.
//
// `specularIntensity` comes from Rhino's PBR "Specular", a Disney principled
// parameter where 0.5 *means* a standard dielectric. three treats it as a plain
// multiplier on F0 where 1.0 means standard, so copying 0.5 across halves the
// reflectivity instead of leaving it alone.
//
// Transparency arrives twice over: as `transmission`, and as `opacity` — which
// fixMaterialTransparency then turns into `transparent: true, depthWrite: false`.
// Applied together a window is both blended away to 20% *and* refracting, so it
// reads as a faint smear. three.js wants exactly one of the two: transmission
// drives the see-through and the material stays in the opaque queue, which is also
// what lets the transmission pass sample the scene behind it.
//
// Resetting ior and specularIntensity reproduces exactly what the old
// downgrade-to-MeshStandardMaterial produced for a plain material — Standard *is*
// Physical with ior 1.5, specularIntensity 1 and no extra lobes — so opaque
// materials are unchanged, while the lobes the downgrade discarded now survive.
function normalizeRhinoPhysical(mat) {
  if (mat.userData?.__from3dm) {
    mat.ior = 1.5;
    mat.specularIntensity = 1.0;
  }

  // Rhino's ranges are not three's. A test document produced clearcoat 1.267,
  // which drives the clearcoat lobe past total reflection and blows out the
  // highlight. Clamping is cheap and there is no legitimate value outside [0,1].
  for (const k of ['clearcoat', 'clearcoatRoughness', 'sheen', 'transmission',
                   'metalness', 'roughness', 'anisotropy', 'iridescence']) {
    const v = mat[k];
    if (typeof v === 'number' && (v < 0 || v > 1)) mat[k] = Math.min(1, Math.max(0, v));
  }

}

// Makes transparency mean one thing.
//
// Rhino's transparency can reach a material by three routes at once: as
// `transmission` from the PBR channels, as `opacity` (which
// fixMaterialTransparency turns into `transparent: true, depthWrite: false`), and
// again as an `opacity` on the layer's customMaterial. Applied together a window
// is blended away to 12% *and* refracting, so it reads as a faint smear.
//
// Rhino's older material types take only the second route — their transparency
// lives in the legacy field, so 3DMLoader's PBR branch never runs. A "Custom"
// material and a "Glass" material at the same setting then render nothing alike
// although Rhino draws both as glass. Material-level transparency in Rhino means
// "see-through like glass", not "blend me", so transmission is the faithful
// reading of all of them.
//
// An alpha map is the exception: that is real per-texel masking, and Rhino's
// Transparency and PBR_Alpha textures both land there, so every texture-driven
// cut-out is excluded by that one test.
//
// Runs *after* the custom material is applied, which is the whole point — a
// layer's customMaterial carries the same Rhino transparency as a plain opacity
// and would otherwise reinstate the blending this just removed.
function reconcileTransmission(mat) {
  if (!mat.isMeshPhysicalMaterial) return;

  // Deriving transmission from opacity is a .3dm-only repair. A GLB says what it
  // means: our writer sends transparency as KHR_materials_transmission with the
  // base colour left opaque, so an alpha below 1 there is a deliberate blend
  // (alphaMode BLEND) and turning it into glass would be overriding the file.
  if (mat.userData?.__from3dm && mat.opacity < 1 && !mat.alphaMap) {
    mat.transmission = Math.max(mat.transmission ?? 0, 1 - mat.opacity);
  }

  // The untangling is for everyone. A layer's customMaterial carries the same
  // transparency again as a plain opacity whichever file it came from, so a GLB
  // window arrives refracting from its extension and is then blended away by the
  // layer swatch — the identical double-application, one route further along.
  if (mat.transmission > 0) {
    mat.opacity = 1.0;
    mat.transparent = false;
    mat.depthWrite = true;
  }
}

/**
 * What an object looks like on a layer that has no material.
 *
 * Rhino's default material, and the same thing the Layers panel already draws as
 * its "no material assigned" swatch — a plain white matte sphere. Deliberately a
 * fresh material rather than a neutered clone of the object's own: the point is
 * that nothing of the old material survives.
 */
function defaultLayerMaterial() {
  return new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.0 });
}

/** Whether an edited material asks for something only MeshPhysicalMaterial has. */
function wantsPhysicalLobes(custom) {
  if (!custom) return false;
  return (custom.transmission ?? 0) > 0 || (custom.clearcoat ?? 0) > 0;
}

/**
 * Re-creates a standard material as a physical one, keeping everything it had.
 *
 * `MeshPhysicalMaterial.copy` cannot be used: it reads clearcoat, sheen and the
 * rest off the source, which a standard material does not have. Borrowing the
 * standard prototype's copy instead moves exactly the fields that exist and
 * leaves the physical-only ones at their defaults, which is what "the same
 * material, now able to hold more" should mean.
 */
function toPhysical(standard) {
  const physical = new THREE.MeshPhysicalMaterial();
  THREE.MeshStandardMaterial.prototype.copy.call(physical, standard);
  physical.userData = { ...standard.userData };
  return physical;
}

export function applyCustomToMaterial(mat, custom) {
  if (!custom || !mat) return;
  if (custom.color     !== undefined) mat.color?.set(custom.color);
  if (custom.roughness !== undefined && mat.roughness !== undefined) mat.roughness = custom.roughness;
  if (custom.metalness !== undefined && mat.metalness !== undefined) mat.metalness = custom.metalness;
  if (custom.opacity   !== undefined) {
    mat.opacity     = custom.opacity;
    mat.transparent = custom.opacity < 0.999;
    mat.depthWrite  = custom.opacity >= 0.999;
  }
  // The Physical-only lobes. Guarded on the material rather than the value:
  // assigning `transmission` to a MeshStandardMaterial silently does nothing,
  // and a caller has no way to tell it was dropped.
  if (mat.isMeshPhysicalMaterial) {
    if (custom.transmission !== undefined) mat.transmission = custom.transmission;
    // IOR is only meaningful alongside transmission, and 1 is vacuum — a reader
    // derives F0 from it, so ((1-1)/(1+1))² = 0 and the surface loses its
    // specular reflection entirely. Left alone rather than written as 1.
    if (custom.ior !== undefined && custom.ior > 1.001) mat.ior = custom.ior;
    if (custom.clearcoat !== undefined) mat.clearcoat = custom.clearcoat;
  }
  if (custom.mapTexture !== undefined) {
    if (custom.mapTexture === null) {
      mat.map = null;
    } else if (custom.mapTexture.isTexture) {
      mat.map = custom.mapTexture;
    }
  }
  mat.needsUpdate = true;
}
