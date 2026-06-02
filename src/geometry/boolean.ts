import type { BoxForm, ImportedMesh, InsertFoam } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Step 4/5 — boolean subtraction: block form minus the drafted cavity plug,
// keeping `floorOffset` of solid material at the bottom so the box is not
// punched through.
//
// SKELETON IMPLEMENTATION:
//   Returns the block mesh as the insert foam and carries the plug along as a
//   preview cutter. True CSG is not performed yet, so the result is a visual
//   placeholder (block + cavity shown separately by the viewport).
//
// TODO (real implementation):
//   - Perform exact mesh/B-rep boolean difference (OCCT BRepAlgoAPI_Cut, or a JS
//     CSG lib like three-bvh-csg for the tessellated path).
//   - Clamp cavity depth to (height - floorOffset).
//   - Weld/repair the result for clean STL/STEP export.
// ─────────────────────────────────────────────────────────────────────────────

/** Builds a closed box mesh centered on the cavity's XY, sitting on z=0..height. */
export function buildBlockMesh(
  form: BoxForm,
  center: [number, number]
): ImportedMesh {
  const { width, depth, height } = form;
  const hx = width / 2,
    hy = depth / 2;
  const [cx, cy] = center;
  const x0 = cx - hx,
    x1 = cx + hx,
    y0 = cy - hy,
    y1 = cy + hy,
    z0 = 0,
    z1 = height;

  const v: number[] = [
    x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, // bottom
    x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, // top
  ];
  const f: number[] = [
    0, 1, 2, 0, 2, 3, // bottom
    4, 6, 5, 4, 7, 6, // top
    0, 4, 5, 0, 5, 1, // y0
    1, 5, 6, 1, 6, 2, // x1
    2, 6, 7, 2, 7, 3, // y1
    3, 7, 4, 3, 4, 0, // x0
  ];

  return {
    name: "block-form",
    positions: new Float32Array(v),
    indices: new Uint32Array(f),
    color: [0.75, 0.78, 0.82],
  };
}

export function subtractCavity(
  block: ImportedMesh,
  _plug: ImportedMesh,
  _form: BoxForm
): InsertFoam {
  // Placeholder: real CSG goes here. For now the block stands in for the result.
  return { mesh: block, ready: true };
}
