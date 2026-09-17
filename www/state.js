const isLightMode = window.matchMedia?.('(prefers-color-scheme: light)').matches ?? false;

// Single shared mutable state object — imported as `S` in every module.
// All module-level let variables from the original app.js live here.
// THREE objects (Group, Raycaster, etc.) are initialized in app.js init()
// to guarantee they share the same THREE module instance.
export const S = {
  // ── Core Three.js ────────────────────────────────────────────────────────
  scene:        null,
  camera:       null,
  renderer:     null,
  controls:     null,
  perspCamera:  null,
  orthoCamera:  null,

  // ── Post-processing ──────────────────────────────────────────────────────
  composer: null,
  ssaoPass: null,
  cgPass:   null,

  // ── Scene objects ────────────────────────────────────────────────────────
  currentModel:    null,
  clipSphere:      null,   // {center, radius} for adaptive perspective near/far
  currentMode:     'shaded',
  edgeThresholdAngle: 30,
  measurementGroup: null,

  // ── Environment ──────────────────────────────────────────────────────────
  environmentMap:    null,
  envMaps:           {},
  currentEnvPreset:  'studio',
  envAsBackground:   false,
  hdrRotation:       59,

  // ── Layers ───────────────────────────────────────────────────────────────
  parsedLayers:    [],
  // 3dm material table as parsed from the file, keyed by table index. Null for any
  // format that has no Rhino material table to read.
  parsedMaterials: null,
  layerNodeByIndex: {},

  // ── Interaction ──────────────────────────────────────────────────────────
  raycaster: null,
  mouse:     null,

  // ── Rhino native data ────────────────────────────────────────────────────
  rhinoInstance:       null,
  rhinoBackgroundColor: null,
  missingRenderMeshCount: 0,         // # of 3dm Brep/Extrusion objects with no stored render mesh
  fileDefaultBgStyle:  null,
  fileBackgroundColorTop: null,      // sRGB hex string '#rrggbb' (or null)
  fileBackgroundColorBottom: null,   // sRGB hex string '#rrggbb' (or null)
  fileBackgroundColorTL: null,       // 4-color gradient corners (hex), null if not present
  fileBackgroundColorTR: null,
  fileBackgroundColorBL: null,
  fileBackgroundColorBR: null,
  fileSunEnabled:      null,
  fileSunAzimuth:      null,
  fileSunElevation:    null,
  fileSunIntensity:    null,
  fileGroundEnabled:   null,
  fileAmbientIntensity: null,
  fileSkylightEnabled:  null,
  fileSkylightIntensity: null,
  customBackgroundColor: null,
  parsedAnnotations:   [],
  annotationGroup:     null,
  parsed3dmFileInfo:   null,
  parsedNamedViews:    [],

  // ── Selection ────────────────────────────────────────────────────────────
  selectedObjects: [],
  selectMode:      'single',

  // ── UI state ─────────────────────────────────────────────────────────────
  settingsOpen: false,

  // ── Turntable ────────────────────────────────────────────────────────────
  turntableActive: false,
  turntableSpeed:  1.0,
  turntableDir:    1,

  // ── Walkthrough mode ─────────────────────────────────────────────────────
  // WASD-to-move + drag-to-look first-person navigation. While active,
  // OrbitControls is disabled and animate() integrates motion per-frame.
  walkthroughActive: false,
  walkthroughKeys:   null,   // Set<string> of pressed key codes ('KeyW' etc.)
  walkthroughDrag:   null,   // { lastX, lastY } while pointer is down
  walkthroughYaw:    0,      // radians, rotation around world up (+Z)
  walkthroughPitch:  0,      // radians, clamped to ±~85°; roll stays 0
  walkthroughSpeed:  1.0,    // model units per second; derived from bbox
  walkthroughLastT:  0,      // performance.now() of previous frame (for dt)

  // ── Lighting / shadows / ground ──────────────────────────────────────────
  sunLight:         null,
  modelShadowDims:  null,
  groundMesh:       null,
  shadowsEnabled:   true,
  groundEnabled:    false,
  aoIntensity:      0.40,

  // ── Per-mode visibility settings ──
  modeSettings: {
    wireframe: {
      edges: true,
      curves: true,
      ground: false,
      shadows: false,
      annotations: true
    },
    shaded: {
      edges: true,
      curves: true,
      ground: false,
      shadows: true,
      annotations: true
    },
    arctic: {
      edges: false,
      curves: false,
      ground: true,
      shadows: true,
      annotations: true,
      aoIntensity: 0.70
    },
    rendered: {
      edges: false,
      curves: false,
      ground: true,
      shadows: true,
      annotations: true,
      aoIntensity: 0.40
    },
    technical: {
      edges: true,
      curves: true,
      ground: false,
      shadows: false,
      annotations: true
    }
  },

  // ── Hidden objects ───────────────────────────────────────────────────────
  hiddenObjects: new Set(),
  // When true, "Show All" has overridden Rhino's per-object hidden state so
  // file-author-hidden objects are revealed too (matches Rhino's Show command).
  // Reset to false on every model load. See updateLayerVisibility().
  revealHidden: false,

  // ── File / session ───────────────────────────────────────────────────────
  currentFileName: '',
  currentFileNameWithExt: '',
  // FileSystemFileHandle of the currently-open file (only when opened via the
  // File System Access API — showOpenFilePicker or drag-drop getAsFileSystemHandle
  // on desktop Chromium). null for <input>/sample/cloud opens. Used by Save to
  // overwrite an opened .rhv in place, or to open the save dialog in its folder.
  currentFileHandle: null,
  modelUnit: 'Unknown',

  // ── Background ───────────────────────────────────────────────────────────
  bgGradient:  false,
  bgColorTop:  isLightMode ? '#f2f2f5' : '#2a2b2f',
  bgColorBot:  isLightMode ? '#dcdce2' : '#18181c',
  bgTexture:   null,

  // ── Camera transition ────────────────────────────────────────────────────
  cameraTransition:  null,
  pendingOrthoSwitch: false,

  // ── 2-point perspective ──────────────────────────────────────────────────
  // When active: camera up is locked to world +Z, camera is forced to look
  // horizontally (controls.target.z = camera.position.z), and the vertical
  // "tilt" is faked by shifting the perspective frustum's principal point
  // via projectionMatrix.elements[9]. This keeps world-vertical lines
  // parallel in screen space — the same trick Rhino's 2-Point uses.
  twoPointActive: false,
  twoPointShift:  0,   // signed; +1 ≈ tilt the framing up by ~one full frame height

  // ── Measurement tool ─────────────────────────────────────────────────────
  distanceToolState:     null,
  angleToolState:        null,
  distanceGhostSphere:   null,
  completedMeasurements: [],
  angleWidget:    null,
  draggedHandle:  null,
  annotationScale:       1.0,   // scale for imported Rhino annotations (dims/text/dots)
  measurementScale:      1.0,   // scale for the Distance/Angle measurement tool only

  // Stylus-only input (palm rejection) while a measurement tool is active.
  // `penOnlyMeasure` is the user's preference; `penDetected` records whether a
  // stylus has ever been used on this device. Both persist in localStorage and
  // are restored by initPenInput(). See pen-input.js.
  penOnlyMeasure: true,
  penDetected:    false,

  // ── Note tool ────────────────────────────────────────────────────────────
  noteToolState: null,  // truthy when the Note tool is active
  notes:         [],    // [{ id, position:[x,y,z], text, color, createdAt, marker:<Sprite> }]
  noteActiveId:  null,  // currently shown bubble's note id (or null)
  noteDefaultColor: '#fbbf24',

  // ── Clipping ─────────────────────────────────────────────────────────────
  clippingPlane:             null,
  clippingHelper:            null,
  clippingTransformControls: null,
  clippingArcHandles:        [],   // Array of {mesh, hitMesh, axis: 'x'|'y'|'z'} for custom rotation arcs
  clippingArcDrag: null,           // Active drag state: {axis, startAngle, startQuat}
  arcOverlayScene: null,           // Separate scene for arc handles — rendered without clipping planes
  clippingEnabled:           false,
  clippingToggleOn:          false,
  clippingPosition:          null, // THREE.Vector3 storing the last position of S.clippingHelper
  clippingQuaternion:        null, // THREE.Quaternion storing the last quaternion of S.clippingHelper
  // True once the clipping plane has been first positioned for this model.
  // Used to skip the default-position computation on toggle off→on so the
  // user's manually-dragged transform is preserved.
  clippingHasBeenInitialized: false,
  clippingBaseQuaternion:    null,
  clipAxis:                  'z',
  clipFlipped:               false,
  clippingCapEnabled:        false,
  clippingCapColor:          '#000000',
  clippingCurveEnabled:      false,   // Draw the outline where the plane cuts the model
  clippingCurveColor:        '#ffffff',
  clipGridVisible:           true,  // Show/hide the clipping-plane grid widget (+ rotation arcs)
  clipGizmoVisible:          true,  // Show/hide the move (translate) widget
  clipGridScale:             1.0,   // Grid size multiplier driven by the panel slider
  clippingGridBaseSize:      50,    // Model-derived base grid half-size, set in setupClippingHelper
  capStencilScene:           null,
  capMesh:                   null,
  sectionCurve:              null,   // THREE.LineSegments of the plane × model intersection

  // ── Gumball ──────────────────────────────────────────────────────────────
  gumballActive:             false,
  gumballTransformControls:  null,
  gumballHelper:             null,
  gumballArcHandles:         [],   // Array of {mesh, hitMesh, axis: 'x'|'y'|'z'} for custom rotation arcs
  gumballArcDrag:            null, // Active drag state: {axis, startAngle, startQuat, startPositions, startQuats}

  // ── BVH ──────────────────────────────────────────────────────────────────
  bvhReady: false,

  // ── Heavy-model load deferral ────────────────────────────────────────────
  // Set by postProcessModel when a model exceeds HEAVY_MESH_COUNT /
  // HEAVY_TRIANGLE_COUNT. Edge extraction is O(triangles) and allocates a
  // second geometry per mesh — measured at 82% of load time on an 18k-mesh
  // model (15.8s → 2.9s with it off), so it is skipped rather than made the
  // user wait. Session restore honours the flag instead of switching edges
  // back on from the saved settings.
  edgesDeferred: false,
  deferredStats: null, // { meshes, triangles } for the toast / re-enable prompt

  // True when the loaded file already carries edge geometry (written by the Rhino
  // export plugin from Brep topology). Only used for reporting coverage at load —
  // protecting those edges from the angle slider is decided per mesh in
  // recreateAllEdges(), since one file can mix exact Brep edges with SubD edges
  // that are still derived from the threshold.
  edgesPrecomputed: false,

  // Last model's edge accounting from measureModelWeight(): { meshes, triangles,
  // precomputedEdges, meshesNeedingEdges, trianglesNeedingEdges }. Kept for every
  // load, not just heavy ones, because the edge-angle slider is enabled only when
  // some geometry actually derives its edges from the dihedral threshold.
  edgeWeight: null,

  // ── Theme ────────────────────────────────────────────────────────────────
  THEME_KEY:    'byrhinoview_theme',
  currentTheme: (() => {
    try {
      return localStorage.getItem('byrhinoview_theme') || 'system';
    } catch (e) {
      return 'system';
    }
  })(),
};
