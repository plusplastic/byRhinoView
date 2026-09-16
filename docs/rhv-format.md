# `.rhv` — byRhinoView session package

Authoritative contract for the `.rhv` container. **Two independent producers write
this format** and they must not drift:

| Producer | Language | Entry point |
|---|---|---|
| Viewer "Save session" | JS | `buildSessionBuffer()` — `www/session.js` |
| Rhino export plugin | C# | `RhvWriter.Write()` — `rhino-plugin/src/RhvWriter.cs` |

The single reader is `loadSession()` in `www/session.js`.

Change this document **first**, then both producers, then the reader.

---

## 1. Byte layout

A `.rhv` file is a gzip stream wrapping an `RV3D` container. The gzip wrapper is
optional on read (detected by magic `1f 8b`) and always written.

```
RV3D container
┌────────────┬──────────┬────────────────────────────────────────────┐
│ offset     │ size     │ field                                      │
├────────────┼──────────┼────────────────────────────────────────────┤
│ 0          │ 4        │ magic — ASCII "RV3D" (52 56 33 44)         │
│ 4          │ 4        │ containerVersion — uint32 LE               │
│ 8          │ 4        │ jsonLength — uint32 LE, bytes              │
│ 12         │ jsonLen  │ metadata — UTF-8 JSON, no BOM              │
│ 12+jsonLen │ rest     │ payload — a complete GLB (glTF 2.0 binary) │
└────────────┴──────────┴────────────────────────────────────────────┘
```

There is no length field for the GLB — it runs to end of container.

### `containerVersion`

Describes the **byte layout above only**, not the JSON contents. Current value: `1`.

Bump *only* for a layout change (e.g. adding a chunk table). A reader that sees a
`containerVersion` above the highest it knows **must hard-fail** — it cannot locate
the fields. Everything additive belongs in the JSON instead, so in practice this
should stay at `1` for a long time.

---

## 2. Metadata JSON

### Versioning fields

```json
{
  "version": 4,
  "minViewerSchema": 3,
  "producer": {
    "name": "byRhinoView.RhinoExport",
    "version": "0.1.0",
    "host": "Rhino 8.14 (win)"
  }
}
```

| Field | Meaning |
|---|---|
| `version` | Schema version of this document. Monotonic. Informational for the reader. |
| `minViewerSchema` | The oldest schema a reader must fully understand to render this file **correctly**. |
| `producer` | Free-form provenance. Never drives behaviour — it exists so a bug report identifies which writer produced the file. |

`version` alone cannot answer "can I open this?", which is why `minViewerSchema`
exists. Reader rule:

```
magic != "RV3D"                        → not a package (try legacy JSON-only path)
containerVersion > MAX_CONTAINER       → hard fail  "newer container"
minViewerSchema > CURRENT_SCHEMA       → hard fail  "newer schema"
version > CURRENT_SCHEMA               → load, warn "some settings ignored"
otherwise                              → load
```

Consequence: **additive changes must not raise `minViewerSchema`.** Adding a new
settings key, a new annotation type, or a new producer field keeps
`minViewerSchema` where it is, so older viewers keep opening new files and simply
ignore what they don't know. Raise it only when an old reader would render the file
*wrong* rather than merely incomplete — e.g. if the meaning of an existing field
changes, or geometry starts relying on a glTF extension.

Missing `minViewerSchema` (files written before schema 4) is read as `3`.

### Content fields

All optional unless noted. Anything absent falls back to the viewer's default.

| Field | Type | Notes |
|---|---|---|
| `displayMode` | string | `wireframe` \| `shaded` \| `arctic` \| `rendered` \| `technical` |
| `settings` | object | See `buildSessionBuffer()` for the full key list. The plugin writes only the subset it can derive from the document. |
| `settings.modelUnit` | string | Restored early — drives the File Info panel. |
| `cameraState` | object | `{ position[3], target[3], up[3], projection }`, `projection` = `perspective` \| `parallel` |
| `parsedLayers` | array | **Required for layer UI.** See §3. |
| `parsedAnnotations` | array | See §4. |
| `rhinoNamedViews` | array | `{ name, position[3], up[3], target[3] }` |
| `namedViews` | array | Viewer-authored views. Plugin writes `[]`. |
| `customMaterials` | object | Viewer-side per-object overrides. Plugin writes `{}`. |
| `hiddenKeys` | array | Viewer-side hidden objects. Plugin writes `[]`. |
| `completedMeasurements` | array | Plugin writes `[]`. |
| `notes` | array | Plugin writes `[]`. |
| `customHdrData` / `customHdrName` | string \| null | Base64 environment map. See §2.1. |

### 2.1 Environment map

`customHdrData` is the base64 of a **complete image file**, and `customHdrName` is
the name the viewer shows. The reader picks its loader from that name's extension —
`.exr` gets `EXRLoader`, anything else `RGBELoader` — so the name is not cosmetic
and must agree with the bytes.

Three keys have to move together or the map loads and is never used:

| Key | Value | Why |
|---|---|---|
| `customHdrData` / `customHdrName` | the file | decoded into `S.envMaps['hdr-custom']` |
| `settings.envPreset` | `"hdr-custom"` | the reader *enables* the custom option from the data but only **selects** it from the preset |
| `settings.bgType` | `"hdr"` | only when the background really is the environment |

`settings.bgType` must be one of the viewer's own option values — `solid`,
`gradient2`, `radial`, `gradient4`, `hdr`. The reader assigns it straight to the
`<select>`, and a value that is not an option silently clears the element and falls
back to solid. Write the background colours (`bgC1`…`bgC4`) regardless, so switching
the viewer away from HDR lands on the document's colours rather than the defaults.

`settings.hdrRotation` is degrees in `[0, 360)`, applied as
`scene.environmentRotation.y` (Euler `YXZ`, X pinned at +90° for this Z-up scene).

**It is offset from Rhino's dial by 180°:** `hdrRotation = rhinoRotation + 180`,
measured on Rhino 8 (0° → 180°, 25° → 205°). Both are a yaw about the world
vertical and they wind the same way; the constant is the usual disagreement about
which world axis an equirectangular map's seam falls on. A writer that omits
`hdrRotation` does **not** get "no rotation" — it gets whatever the slider happened
to hold, so an unrotated environment must still write `180`.

Rhino reports the angle in **radians** even where the panel shows degrees, and a
content can carry an unused zero-valued `rotation` beside the real one — so a writer
has to take the first *non-zero* candidate and convert by magnitude (≤ 2π is
radians; a rotation under 6.3° is not distinguishable from none either way).

**Equirectangular only.** The viewer builds its IBL with `PMREMGenerator`, which
reads the image as latitude–longitude. Mirror-ball, light-probe, box and cube-cross
layouts are a different pixel arrangement and render as a smear rather than failing
visibly, so a writer must decline them and fall back to the background colour.

The Rhino plugin always writes Radiance `.hdr`, never `.exr`: RGBELoader is on every
code path, and EXR's float32 scanlines cost several times the bytes for detail that
disappears into the PMREM blur. Note that `RGBELoader` decodes with
`byte * 2^(E-128) / 255` where the Radiance spec says `/256`, so every `.hdr` — ours
and any stock HDRI alike — reads 0.4% bright in the viewer. Encode to the spec so
exported environments match the built-in presets rather than each other's error.

---

## 3. `parsedLayers`

```json
{
  "index": 0,
  "name": "Walls::Exterior",
  "color": { "r": 200, "g": 200, "b": 200, "a": 255 },
  "visible": true,
  "parentLayerIndex": -1,
  "customMaterial": null,
  "originalCustomMaterial": null
}
```

- `name` is the **full path** with `::` separators, matching Rhino's `Layer.FullPath`.
- `color` components are 0–255 **sRGB**.
- `parentLayerIndex` is `-1` for root layers.
- `index` must match the `attributes.layerIndex` written into GLB node extras (§5).
  This is the join key for the whole layer UI — get it wrong and layer visibility
  silently controls the wrong objects.
- `customMaterial` is the layer's render material, or `null`. When present it must
  carry at least `color` as `#rrggbb`. `originalCustomMaterial` is an untouched copy
  used by the Reset button, so the two must be equal at write time.

## 4. `parsedAnnotations`

Two shapes, discriminated by `type`.

```json
{ "type": "TextDot", "text": "…", "position": [x,y,z],
  "layerIndex": 0, "objectColor": {"r":0,"g":0,"b":0,"a":255}, "visible": true }
```

```json
{ "type": "Text", "geomType": "TextEntity", "isDimension": false,
  "text": "…", "position": [x,y,z],
  "xAxis": [1,0,0], "yAxis": [0,1,0], "zAxis": [0,0,1],
  "textHeight": 1.0, "dimPoints": null,
  "layerIndex": 0, "objectColor": {…}, "visible": true, "isBold": false }
```

`textHeight` must already be resolved through the dimension-style parent chain — the
viewer does not resolve it.

---

## 5. GLB payload

A complete, self-contained glTF 2.0 binary. The viewer hands it to `GLTFLoader` via
`loadGeometryFromGLB()`.

Four rules the writer must honour. Each of these is a silent-corruption bug if
missed, not a load failure:

**5.1 — Z-up, no axis conversion.** glTF nominally specifies Y-up, but this viewer
works entirely in Rhino's Z-up space (camera up is forced to `[0,0,1]`, the ground
plane and named views assume it). Write Rhino coordinates verbatim. Do **not** apply
the usual Z-up→Y-up rotation.

**5.1b — Mesh modifiers are part of the mesh.** Edge softening, shut lining,
thickening, curve piping and displacement are not geometry edits. Rhino keeps them
as settings on the object and applies them while building the render mesh, so
`RhinoObject.GetMeshes(MeshType.Render)` returns the *unmodified* mesh and an
export taken from it drops every one of them — a displaced surface arrives flat, a
curve with piping arrives as a bare curve.

`RhinoObject.RenderMeshes(...)` returns what the display actually draws, as one
`Instance` per piece. Each carries its own transform, which must be baked into the
mesh: the pieces are merged under a single node and a transform left on the side
would be lost. Pass a null viewport and null display attributes to get the
view-independent result — the right one for a file that will be orbited — and do
**not** pass the `Recursive` flag, which would duplicate the contents of blocks
that are already flattened.

**5.2 — Linear material colours.** `loadGeometryFromGLB()` calls
`postProcessModel(..., colorsAreSRGBStoredAsLinear = false)`, i.e. GLB colours are
taken as already-linear. `pbrMetallicRoughness.baseColorFactor` must therefore be
**linear**, so convert Rhino's sRGB colours on the way out. Skipping this makes the
model visibly brighter than the same file opened as `.3dm`.

**5.2b — `extras.solid` on closed meshes.** A mesh whose shell is closed carries
`"extras": { "solid": true }`. glTF has nowhere else to put this: `doubleSided`
lives on the *material*, which is shared, so it cannot answer per-object — and a
reader cannot recover it cheaply either, because this writer splits vertices at
normal seams and an index-only manifold test reports every crease as a hole.

It exists for transparency. Rhino blends a transparent surface **once**; two-sided
geometry blends it **twice**, because three.js draws back faces and then front
faces. Measured on a 28%-transparent sphere, the background arrived at
0.28² = 7.8% and the sphere read as opaque. The viewer therefore drops back faces
on a transparent material when — and only when — the mesh says it is solid; an
open transparent surface keeps them, or a glass wall vanishes when viewed from
inside.

**5.3 — Per-node `extras.attributes`.** Every renderable node carries:

```json
{ "attributes": {
    "id": "5f2c…",  "name": "…",  "layerIndex": 3,  "visible": true,
    "objectColor": { "r": 255, "g": 0, "b": 0, "a": 255 },
    "colorSource": 0, "materialSource": 0,
    "isInstanceDefinitionObject": false,
    "userStrings": { }
} }
```

`GLTFExporter` writes `object.userData` to node `extras` and `GLTFLoader` reads it
back, so this round-trips as `child.userData.attributes` — which is what
`postProcessModel()` reads.

`layerIndex` is mandatory. `colorSource`/`materialSource` use Rhino's enum values
where `0` means "from layer"; the viewer branches on that to decide whether an
object follows its layer colour.

`objectType` records what the object was in Rhino, spelled the way three.js's
`3DMLoader` spells it (`"Brep"`, `"Extrusion"`, `"Surface"`, `"Mesh"`, `"SubD"`,
`"Curve"`, `"Point"`, `"PointSet"`, `"InstanceReference"`) so that a `.rhv` and a
directly-opened `.3dm` agree. The viewer uses it to decide whether dihedral edge
extraction can run at all: only `PointSet` and `PointCloud` are excluded, having no
triangles to find an angle between.

`Mesh` used to be excluded too, on the grounds that a threshold pass over an
imported tree or a scanned terrain yields noise rather than an outline. That is an
argument for a control, not for an exclusion — and it left a mesh building outlined
when it arrived as an STL and bare when it arrived in a `.3dm`. Mesh objects are
eligible as of viewer 1.0.2, with the Edge Angle slider governing them.

Omitting `objectType` is safe: the viewer treats unknown geometry as eligible, which
is the right default for the mesh-only formats it also opens (STL, 3MF, GLB,
STEP/IGES) where dihedral extraction is the only edge source.

**5.3b — Textures.** Images must be embedded as `bufferView`s (never external
URIs — the package has to stay self-contained) and must be `image/png` or
`image/jpeg`, the only two formats glTF allows. Rhino documents freely reference
TIFF/TGA/BMP, so a writer has to convert. A material carrying a
`baseColorTexture` is only useful if the primitives using it also write
`TEXCOORD_0`; Rhino's V axis runs opposite to glTF's, so UVs need `v → 1 - v`.

Which Rhino slot goes where:

| Rhino `TextureType` | glTF | Condition |
|---|---|---|
| `PBR_BaseColor` → `Bitmap` → `Diffuse` | `baseColorTexture` | first one present wins |
| `Bump` | `normalTexture` | **only if `RenderTexture.IsNormalMap()`** |
| `PBR_Roughness` | `metallicRoughnessTexture` | only when the material is not metallic |
| `PBR_AmbientOcclusion` | `occlusionTexture` | |
| `PBR_Emission` | `emissiveTexture` | |

**A bump slot is not a normal map.** Rhino puts both kinds in `TextureType.Bump`
and the enum does not distinguish them — only the RDK does, through
`RenderMaterial.GetTextureFromUsage(StandardChildSlots.Bump)` and
`RenderTexture.IsNormalMap()`. Skip the height maps rather than guessing: glTF has
no height channel, and `normalTexture` reads its greyscale as an XYZ direction, so
a mid-grey height of 0.5 becomes the normal `(0, 0, 0)` and the surface lights as
though it faced nowhere. Rhino states the slot's amount as a percentage, so divide
values above 1.5 by 100.

**Where the amount applies depends on which kind it is**, and this is not
cosmetic — putting it in the wrong place made a bump vanish entirely:

- **A normal map** is a finished normal, so the amount is how much of it to apply:
  `normalTexture.scale`.
- **A height map** takes the amount *inside* the derivation, scaling the height
  before normals are computed — which is what Rhino does, so its edges stay crisp
  as the amount falls. Applying it afterwards scales a normal that is already near
  saturation (a step edge derives to 0.89) and cuts far deeper than Rhino does. A
  checker bump at Rhino's 30% rendered perfectly smooth that way.

**A procedural bump is not read like an image one.** `RenderTexture.IsImageBased()`
decides: an image's pixels exist independently of any mapping, so read it with
`DisableLocalMapping` and let the mesh's UVs carry the object's mapping — baking
the texture's own repeat in would apply it twice. A procedural has no pixels until
it is mapped, so it must be read *with* its local mapping and baked at full size,
since it has no native resolution to report and no source file to fall back on.

Reading it wrong does not degrade gracefully. A Rhino "2D Checker Texture" read
with local mapping disabled came back as four constant quadrants over UV `[0,1]` —
the checker at its native period of 1 — and baked to a normal map that was flat
apart from a cross where the quadrants met.

**Roughness and metallic share one image in glTF** — roughness in G, metallic in B
— and Rhino keeps them in separate slots, so carrying both means decoding,
interleaving and re-encoding. One case avoids that entirely: a greyscale roughness
map already has the right value in G, and its B channel is multiplied by
`metallicFactor`, so on a non-metallic material it can be passed through
byte-for-byte and is exactly correct. A metallic map cannot — G would read it as
roughness. Set `roughnessFactor` to 1 when the map goes out; Rhino's map replaces
the slider rather than scaling it, and glTF multiplies the two.

Emissive is a colour **and** a map, multiplied. A map under Rhino's default black
emission would light nothing, so `emissiveFactor` becomes white when a map is
present and no colour was set.

**5.3b-2 — Material extensions (optional).** Core glTF carries base colour,
metallic and roughness. Everything else Rhino's PBR channels describe travels as a
`KHR_materials_*` extension, which `three.js` GLTFLoader reads into a
`MeshPhysicalMaterial`:

| Rhino channel | Extension | Notes |
|---|---|---|
| transparency | `KHR_materials_transmission` *or* alpha — see below | refracting materials only |
| `OpacityIOR` | `KHR_materials_ior` | only alongside transmission, only if ≠ 1.5 |
| `Clearcoat`, `ClearcoatRoughness` | `KHR_materials_clearcoat` | |
| `Sheen`, `SheenTint` | `KHR_materials_sheen` | glTF has no sheen *strength*; the colour carries it |
| `Material.Reflectivity` | core `metallicFactor` | **legacy materials only** — see below |
| `Material.ReflectionGlossiness` | core `roughnessFactor` | blended with gloss finish by `Reflectivity` |
| `Anisotropic`, `AnisotropicRotation` | `KHR_materials_anisotropy` | **needs `TANGENT`** — see below |
| `Emission` | core `emissiveFactor` | `KHR_materials_emissive_strength` above 1 |

These go in `extensionsUsed` and **never** `extensionsRequired`. A reader that
doesn't know them still gets a well-formed material and draws it opaque —
incomplete, not wrong — whereas requiring them would lock an older viewer out of
the whole file over a surface finish.

**Transparency travels exactly one way.** A material writes *either* a base colour
alpha below 1 with `alphaMode: "BLEND"`, *or* a `transmissionFactor` with alpha
pinned to 1 — never both. Writing both makes a reader blend the surface away *and*
refract through it, so a window renders as a faint smear instead of glass.

**Which of the two depends on the material's refraction index**, because Rhino has
both kinds and they do not look alike:

- IOR > 1 — Glass at 1.523, a physically-based material at 1.53 — is glass.
  `transmissionFactor`: a reader tints what comes through by the base colour and
  modulates it by fresnel and roughness.
- IOR = 1 is a flat blend. Rhino shows the background through it *untinted*, which
  reads pale and desaturated against a bright environment. `alphaMode: "BLEND"`.

Sending the second kind as transmission produced a saturated ball where Rhino drew
a washed-out one.

Ask the right field for it. `ToPhysicallyBased()` hands back a converted material
whose `OpacityIOR` is a stock 1.5 *even for a legacy material authored with none*,
so the physically-based view cannot be used to make this decision — check
`Material.IsPhysicallyBased` first, and fall back to legacy
`Material.IndexOfRefraction`. Reading the view is what gave a test document's
"Custom" material (`IsPhysicallyBased` false, IOR 1.0, a plain 28% blend) an
exported IOR of 1.5 and a refraction lobe it never had.

Reading the *amount* needs both routes checked, largest wins. A physically-based
material uses `PhysicallyBased.Opacity`, while the older types (Custom, Glass,
Plastic…) leave that at 1 and keep the value in the legacy `Material.Transparency`
— `ToPhysicallyBased()` does not migrate it. Asking only the PBR view exports a
28%-transparent Custom material as fully opaque.

**Out of range means discard, not clamp.** Rhino's stock "Physically Based"
material was measured reporting a clearcoat of 1.2673 — unreachable from a 0..1
slider — beside an anisotropy of 0.3251, while every other material in the same
document reported a clean 0 for both. These are channels the simulated view leaves
unfilled, not values an author set, and Rhino does not draw them. Clamping turned
"no meaningful value" into a full-strength mirror coat and made the sphere read
glossier in the viewer than in Rhino. The same rule applies to sheen.

**A legacy material's `Reflectivity` is metalness, not specular.** Check
`Material.IsPhysicallyBased` before reading any legacy field — the same rule as the
IOR above — because the two cases mean different things:

- **Legacy** (Custom and the older types): `Reflectivity` is authored, and
  `Material.FresnelReflections` decides which of two unrelated things it means.
- **Physically based**: it is a derived readout, not an authored value. Measured
  across a test document it was exactly `1 - Roughness` on every non-metal not
  pinned to 1.0 (Paint 0.86/0.14, Physically Based 0.69/0.31). Leave it alone —
  write neither metalness nor specular from it.

| Legacy material | Rhino draws | Write |
|---|---|---|
| Fresnel **off** | `(1-R)·diffuse + R·mirror`, flat with viewing angle | core `metallicFactor` |
| Fresnel **on** | dielectric reflection, `R` scaling its strength | `KHR_materials_specular` |

The two do not look remotely alike. With Fresnel off the test document's Custom
sphere carried a broad sky reflection across the top; ticking the box left the
identical material rendering as flat cyan with only a soft edge.

Metalness is structurally right for the flat case: it scales the diffuse by `1-m`
and puts an environment reflection in its place, exactly Rhino's blend.
`ToPhysicallyBased()` drops the value entirely — a 53%-reflective blue Custom
material converts to `Metallic` 0 and renders flat.

`specularFactor` is right for the Fresnel case and **wrong** for the flat one: it
*scales down* a dielectric F0 that starts at 4%, so a 53%-reflective material
becomes a 2% surface. An earlier revision wrote it for every non-metal, which was
right only when Fresnel happened to be on.

glTF has no untinted strong mirror to offer, so the flat case costs something: the
specular extension only scales F0, and three.js caps IOR at 2.333, so even a
maximal dielectric reflects 16%. Metalness reaches the strength but picks up the
base colour, which Rhino's reflection does not when its reflection colour is white.

This is the one material setting that cannot be carried faithfully, so the exporter
counts these materials and says so in its report rather than leaving the difference
to be discovered. Turning Fresnel on in Rhino moves the material to the other row
of the table, where it does match.

**Two gloss controls, one roughness.** A legacy material's "Gloss finish" sizes the
highlight on the diffuse surface while "Reflection polish"
(`Material.ReflectionGlossiness`) sharpens the mirror. Weight them by `Reflectivity`
— the amount that decides which lobe the eye sees — so a material with no
reflectivity keeps its gloss finish and a mirror follows its polish. The test
document's Custom material is gloss finish 47% but polish 72%, and Rhino's sky
reflection in it is visibly sharper than a roughness of 0.47 can draw.

Read `ReflectionGlossiness` as a **roughness despite its name, and do not invert
it**. Every physically-based material in the test document reported it equal to its
own roughness to the digit — 0, 0.1, 0.14, 0.15, 0.31, 0.69 — which a glossiness
could not be. Inverting it turned the Custom material's 0.24 into 0.76 and blurred
the reflection away instead of sharpening it.

**`KHR_materials_anisotropy` requires a `TANGENT` attribute** on every primitive
using the material. An anisotropic BRDF is evaluated in a tangent frame, and
without one three.js does not fall back to isotropic — the surface renders as
hard-edged black wedges (measured: 14% of a sphere's pixels fully black, cleared
entirely by setting the factor to zero). A writer that emits only POSITION and
NORMAL must therefore not write this extension, and the reader zeroes the factor
on untangented geometry whatever the file says.

**5.3c — Quantization (optional).** Attributes may use normalized integer types
via `KHR_mesh_quantization`, which must appear in **both** `extensionsUsed` and
`extensionsRequired` — the data is unreadable without it. `three.js` GLTFLoader
supports it.

The writer's scheme: `POSITION` as normalized `SHORT` mapped from each mesh's own
bounding box, `NORMAL` as normalized `BYTE` padded to a 4-byte stride, indices and
`TEXCOORD_0` left alone (Rhino UVs routinely exceed `[0,1]` for tiling, which
normalized types cannot express). Accuracy is ~1/32767 of a mesh's extent.

The catch: the transform that undoes position quantization has to be composed
into **every node referencing that mesh**, or the geometry lands at the wrong
place and scale. Instanced meshes therefore get
`instanceXform * leafXform * dequant`. A quantized mesh referenced by a node with
no `matrix` is a bug.

**5.3d — Precomputed edges (optional).** A writer may ship edge geometry so the
viewer does not run `EdgesGeometry` per mesh at load — measured at 82% of load
time on an 18k-mesh model. Each edge object is a **child of the mesh node** (the
viewer looks it up with `mesh.getObjectByName('rhino-edges')`, which only searches
that mesh's descendants) and uses primitive **mode 1 (LINES)**, since GLTFLoader
maps mode 1 to `LineSegments` and mode 3 to `Line`.

The edge node **must** carry `extras.role = "rhino-edges"`:

```json
{ "name": "rhino-edges", "mesh": 42, "extras": { "role": "rhino-edges" } }
```

The name alone is not sufficient. GLTFLoader passes every node name through
`createUniqueName()`, so a file with N edge objects loads as one `rhino-edges`
plus `rhino-edges_1`, `rhino-edges_2`, … Since the viewer matches that name
exactly in a dozen places, relying on the name leaves **one** object with working
edges and turns the rest into loose selectable curves. `extras` is copied to
`userData` verbatim and never rewritten, so the viewer renames from the role on
load.

Two further constraints:

- **Quantization interaction.** Edge geometry is unquantized, but glTF composes
  transforms down the hierarchy — so under a quantized parent the child must carry
  the *inverse* of the parent's dequantization matrix, or the edges are scaled and
  offset by it.
- **Prefer real topology.** Brep edges are exact; `EdgesGeometry` is a
  dihedral-angle heuristic over the tessellated mesh. Edges supplied by the file
  have no threshold to re-apply, so the viewer leaves them untouched when the
  edge-angle slider moves, and disables the slider outright once *nothing* in the
  scene derives its edges from the threshold. Both are decided per mesh: one file
  may legitimately mix exact Brep edges with SubD edges the viewer still derives.
- **Do not write edges for `Mesh` objects.** They have no topology to read, so the
  only thing a writer could ship is a dihedral pass — the one case where edge data
  can exceed the geometry it describes, and a threshold baked in at export rather
  than left to the reader. The viewer derives them itself instead, on demand and at
  whatever Edge Angle the user has set (see `objectType` in §5.3).
- **`SubD` edges come from the control net,** read via `SubD.Edges` and evaluated
  on the limit surface with `SubDEdge.ToNurbsCurve()` — not from
  `ControlNetLine`, which would cut straight across a smoothly interpolated edge.
  One entry per cage edge, so the data is small regardless of subdivision level.
  This is plugin-only: `rhino3dm`'s WASM build exposes no SubD edge access, so a
  directly-opened `.3dm` can only fall back to dihedral extraction, which finds a
  SubD's creases and boundaries but not its interior structure.

**Per-edge angle (optional, schema 5).** The edge primitive may carry a custom
`_ANGLE` scalar attribute: the angle in degrees between the two surfaces meeting
along that edge, `0` meaning tangent. Both vertices of a segment carry their
edge's value, so an edge is kept or dropped whole. Edges with no second face —
naked or non-manifold — are written as `180` so they survive any threshold, which
is what `EdgesGeometry` does with boundary edges.

This is what lets the viewer's edge-angle slider **filter** exact edges rather
than being irrelevant to them. Exact edges are the complete set of surface
boundaries, tangent-continuous joins included; those are real edges Rhino draws,
but they are also why a filleted model can look busier than the old dihedral
extraction made it. With the attribute the same slider value means the same thing
whichever source an object's edges came from, nothing is rebuilt when it moves,
and the curves stay exact at every setting.

Measure it the way `EdgesGeometry` measures its threshold — between face normals —
or the slider will not agree with itself across a mixed scene. The writer reads
the angle through the edge's **trims**, whose curves already live in face UV
space, rather than through `BrepFace.ClosestPoint`; on a 114,000-edge model that
is the difference between a visible pause and none. For SubD the tag is the
answer without measuring: the limit surface is tangent-continuous across a smooth
edge, so smooth is `0` and crease is `180`.

Omitting the attribute is valid and stays readable: the viewer shows every edge
and reports the slider as not applying to them. That is the `.3dm`-opened-directly
case, where `rhino3dm`'s `BrepEdge` exposes no face adjacency to measure with.

`role` is also what the viewer keys on when **re-saving** a `.rhv`. Edges marked
exact are written back out, because the GLB carries no topology they could be
rebuilt from; unmarked (dihedral) edges are dropped, since reloading reproduces
them identically from the same threshold. Measured on a 1.29 MB session, keeping
exact edges cost +121 KB (+9.4%).

**5.4 — Nothing else in `userData`.** The viewer strips `originalMaterial`,
`renderedMaterial`, `shadedMaterial`, `materialColor` (per mesh) and `materials`,
`layers`, `groups`, `settings`, `warnings`, `objectType` (root) before its own
export, because they balloon the JSON chunk. The plugin must not write them either.

### Blocks

Rhino instance references are expanded into a node subtree per instance. Members
carry `attributes.isInstanceDefinitionObject = true`, and the group node carries the
*instance's own* `layerIndex` so that hiding the layer the instance sits on hides the
whole instance.

Where a definition is placed many times, reuse the same glTF `mesh` index across
instance nodes. glTF node reuse is what keeps a 463k-object file tractable — see
`sample_3dm/RhinoSample-Architecture-LCT-Mesh-RenderMode.3dm`.

---

## 6. HTML package

Both producers can also emit a single self-contained `.html`: the prebuilt
`viewer-shell.html` (from `npm run build:shell`) with the gzip'd RV3D container
injected at the `/*__RHV_PACKAGE__*/` placeholder.

> **`viewer-shell.html` is a build artifact of `www/`, and nothing rebuilds it
> automatically.** Every package embeds a whole copy of the viewer, so a stale shell
> means packages ship stale viewer code — with no error and no obvious symptom
> beyond "the package behaves like an older build". Run `npm run build:shell` after
> changing anything under `www/`, and bump the version tag in `index.html` when the
> change matters, since that tag is what identifies the shell.

| Global | Contents |
|---|---|
| `window.__RHV_PACKAGE__` | base64 of the container |
| `window.__RHV_PACKAGE_ENCRYPTED__` | `{v,salt,iv,data}` instead, when a password is set |
| `window.__RHV_PACKAGE_NAME__` | display name, e.g. `"model.rhv"` |
| `window.__RHV_HIDE_FILE__` | `true` to hide the File menu |

If the placeholder is absent, inject a `<script>` before
`<script type="module" id="app-bundle">`.

### Where the base64 goes

Those globals are the reader's contract and do not change. **How** the base64 gets
into them does matter for performance: a JavaScript string literal has to be
tokenised by the JS parser, which costs about **1 second per 70 MB**. The same bytes
as inert character data cost about **25 ms**.

So writers put the payload in an inert element and assign from it:

```html
<script id="rhv-payload" type="text/plain">H4sIAAAA…</script>
<script>
  var _p = document.getElementById("rhv-payload").textContent;
  window.__RHV_PACKAGE__ = _p;                       // or {…, data:_p} when encrypted
  window.__RHV_PACKAGE_NAME__ = "model.rhv";
</script>
```

Since the placeholder sits *inside* `<script id="rhv-package">`, the injected text
begins with `</script>` to close it. That is safe: the HTML parser ends a script
element at the first `</script`, and the base64 alphabet contains no `<`, so the
inert block cannot terminate early.

With a password, only the ciphertext moves out — `salt` and `iv` are a few bytes and
stay inline.

**Both forms must keep loading.** The reader is unchanged, so packages written as a
literal (anything produced before this was documented) still open. A writer emitting
a literal is not broken, just slower — `validate-rhv.mjs` warns rather than fails.

### Replace the FIRST occurrence only

`viewer-shell.html` contains `/*__RHV_PACKAGE__*/` **three times**: once at the real
injection site, and twice as string literals inside the minified bundle — that being
the viewer's own copy of this same logic.

JavaScript's `String.replace(stringPattern, …)` replaces only the first match, which
is what the viewer relies on. C#'s `String.Replace` replaces **all** of them, and
doing so injects the payload into the middle of the bundle's own JavaScript, breaking
its syntax. The package then loads with no error and never boots.

Encryption is AES-256-GCM with a PBKDF2-SHA256 key: **200,000 iterations**,
16-byte salt, 12-byte IV, 128-bit tag **appended to the ciphertext** (WebCrypto's
layout). All three blobs are base64. These constants are the entire compatibility
contract between the C# writer and the browser's WebCrypto reader — the plugin and
viewer are independent implementations, so changing any of them breaks existing
packages. `rhino-plugin/tools/crypto-compat/` verifies the two against each other.

## 7. Compatibility notes

- The viewer's own `.rhv` writer never populates `producer`; treat its absence as
  "written by the viewer".
- Files written before schema 4 have no `minViewerSchema`; read as `3`.
- Schema 5 added the `_ANGLE` edge attribute (§5.3d). Purely additive, so
  `minViewerSchema` stays at `3`: an older viewer ignores the attribute and draws
  every edge, which is exactly what it did before the attribute existed.
- The plugin began writing `customHdrData` (§2.1) without a schema bump — the field
  and the reader that consumes it both predate it, so the only change is that the
  value is no longer always `null`.
- Plugin-written files from before that also carried `bgType: "gradient"`, which is
  not one of the viewer's options and therefore loaded as solid. Nothing reads the
  old value, so there is no migration; re-export to get the gradient back.
- The reader must tolerate a `.rhv` whose GLB contains no meshes (empty document).
