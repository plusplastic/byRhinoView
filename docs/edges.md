# How Edges Work

byRhinoView draws a black outline along the edges of your model. This page explains
where those lines come from, why they sometimes differ between two files of the same
model, and what the **Edge Angle** slider actually does.

## The two kinds of edges

| | Exact edges | Computed edges |
|---|---|---|
| **Come from** | Rhino's own surface boundaries | The triangle mesh |
| **Used for** | Breps, extrusions, polysurfaces | SubD, meshes, anything from STL / 3MF / GLB / STEP |
| **Accuracy** | Follows the true curve at any zoom | Follows the tessellation |
| **Edge Angle slider** | Filters them (exported files only) | Decides which ones exist |

**Exact edges** are the real boundaries Rhino stores with a surface. They stay smooth
however far you zoom in, and they include edges that meet at a shallow angle — the two
sides of a fillet, a tangent join between lofted patches.

**Computed edges** are found by looking at the mesh: wherever two triangles meet at a
sharp enough angle, a line is drawn. This is the only option for geometry that has no
surface data, such as an STL file.

A single model can use both at once. Each object gets whichever applies to it.

## Where your edges come from

**A `.3dm` opened directly** — The viewer reads the exact edges out of the file while it
loads, straight from Rhino's surface topology. One limitation: the browser cannot measure
the angle at each edge, so the Edge Angle slider is greyed out (see below).

**Exported from Rhino with the byRhinoViewExport plug-in (`.rhv`)** — Only if **Save
edges from Brep topology** was ticked in the export dialog. That option is **off by
default**. With it on you get the best result there is: exact edges that the viewer does
not have to calculate, each carrying the angle the Edge Angle slider filters by. With it
off the `.rhv` carries no edges at all and the viewer computes them from the mesh, the
same as it would for an STL.

**Everything else (STL, 3MF, GLB, STEP/IGES)** — There are no surfaces in these formats,
so every edge is computed from the mesh using the Edge Angle threshold.

**Rhino Mesh and point-cloud objects get no edges at all.** A mesh has no surface
boundaries — only its triangulation — so outlining it produces noise rather than a
shape. This is deliberate, and it applies whatever format the mesh arrived in.

## The Edge Angle slider

The slider means the same thing in both cases — *how sharp does an edge have to be to
count?* — but it does a different job depending on what it is working with.

**Filtering exact edges (exported files).** Every edge is already there; the slider
hides the ones below the threshold. Raise it to remove tangent joins and clean up a busy
model, lower it to show every boundary. Nothing is recalculated, so the slider responds
as you drag it and the curves stay exact at any setting. Naked edges — boundaries with
nothing on the other side — are always shown.

**Generating computed edges.** The threshold decides which lines are created at all.
Moving the slider rebuilds them, so the change lands when you release it rather than as
you drag.

**Greyed out.** The slider is disabled when nothing in the model responds to it — most
commonly a `.3dm` of Breps opened in the viewer, where every edge is exact but has no
angle recorded. Hover it for the reason. To get the slider working on that model, export
it as a `.rhv` with **Save edges from Brep topology** ticked.

## Large models

Calculating edges from a mesh is the slowest part of opening a file, so if a model would
need a lot of it, byRhinoView opens with edges switched off and tells you so.

Turn **Edges** back on under Settings → Visibility whenever you want them. The
calculation runs then, with a progress indicator, and the result stays for the rest of
the session. Objects that already carried exact edges appear immediately.

This is also why a `.rhv` exported with **Save edges from Brep topology** opens with its
edges already showing however large the model is: nothing needs to be calculated.

## Quick answers

**My edges look different after exporting the same model.** Check whether **Save edges
from Brep topology** was ticked. With it on, the file carries the angle of every edge and
the Edge Angle slider can thin them out. With it off, the `.rhv` has no edges of its own
and they are rebuilt from the mesh, which looks coarser than the same model opened as a
`.3dm`.

**One object has no outline and the rest do.** It is probably a Rhino Mesh, or a SubD
whose surface is too smooth for the current Edge Angle. Check the object type in the
Properties panel.

**Turning Edges on did nothing.** Fixed in v1.0.1. Earlier versions could only show
edges that already existed, so on a model whose edges had to be calculated the switch
had no effect.
