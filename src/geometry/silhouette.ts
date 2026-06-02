import type { ImportedModel, Silhouette, ViewName } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Step 2 — outline silhouette extraction from a chosen orthographic view.
//
// SKELETON IMPLEMENTATION:
//   Projects all mesh vertices onto the view plane and returns the convex /
//   bounding outline. Currently emits the axis-aligned bounding rectangle of the
//   projected points so the pipeline produces a usable closed loop.
//
// TODO (real implementation):
//   - Project triangles, compute the outer boundary via edge-loop extraction or
//     a 2D union of projected triangles (e.g. polygon clipping / alpha shape).
//   - Detect interior holes for through-features.
//   - Optionally use the true B-rep silhouette when the OCCT kernel is available.
// ─────────────────────────────────────────────────────────────────────────────

/** Maps a view to the two world axes that form its 2D plane. */
function planeAxes(view: ViewName): [0 | 1 | 2, 0 | 1 | 2] {
  switch (view) {
    case "top":
      return [0, 1]; // X, Y  (looking down -Z)
    case "front":
      return [0, 2]; // X, Z  (looking along -Y)
    case "side":
      return [1, 2]; // Y, Z  (looking along -X)
  }
}

export function extractSilhouette(
  model: ImportedModel,
  view: ViewName
): Silhouette {
  const [a, b] = planeAxes(view);
  let minU = Infinity,
    minV = Infinity,
    maxU = -Infinity,
    maxV = -Infinity;

  for (const mesh of model.meshes) {
    const p = mesh.positions;
    for (let i = 0; i < p.length; i += 3) {
      const u = p[i + a];
      const v = p[i + b];
      if (u < minU) minU = u;
      if (v < minV) minV = v;
      if (u > maxU) maxU = u;
      if (v > maxV) maxV = v;
    }
  }

  // Placeholder outline = projected bounding rectangle.
  const loop: Array<[number, number]> = [
    [minU, minV],
    [maxU, minV],
    [maxU, maxV],
    [minU, maxV],
  ];

  return {
    view,
    loops: [loop],
    bbox: { min: [minU, minV], max: [maxU, maxV] },
  };
}
