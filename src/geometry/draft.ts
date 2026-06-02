import type { DraftConfig, ImportedMesh, Silhouette } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Step 3/4 — build a drafted (구배) cavity solid by lofting a silhouette loop
// from its full size at the opening down to a scaled-in profile at depth, where
// the inset is determined by the draft angle.
//
// SKELETON IMPLEMENTATION:
//   Extrudes the silhouette's outer loop along -Z (pull direction = top view) and
//   insets each successive ring by tan(angle) * depth. Produces a closed triangle
//   mesh approximating the drafted plug. Good enough to subtract in step 4 and to
//   visualize. Only the top-view pull is handled in the skeleton.
//
// TODO (real implementation):
//   - Respect the chosen draft view (pull along front/side too).
//   - Honour holes in the silhouette.
//   - Use the OCCT kernel for an exact drafted B-rep instead of a tessellation.
// ─────────────────────────────────────────────────────────────────────────────

export function buildDraftedPlug(
  sil: Silhouette,
  draft: DraftConfig,
  /** Top Z (opening plane) in mm. */
  topZ: number
): ImportedMesh {
  const loop = sil.loops[0];
  const cx =
    loop.reduce((s, p) => s + p[0], 0) / loop.length;
  const cy =
    loop.reduce((s, p) => s + p[1], 0) / loop.length;

  const inset = Math.tan((draft.angleDeg * Math.PI) / 180) * draft.depth;
  const bottomZ = topZ - draft.depth;

  // Scale factor that pulls the bottom ring inward by `inset` (approx, radial).
  const avgR =
    loop.reduce(
      (s, p) => s + Math.hypot(p[0] - cx, p[1] - cy),
      0
    ) / loop.length || 1;
  const k = Math.max(0.01, (avgR - inset) / avgR);

  const n = loop.length;
  const positions: number[] = [];
  const indices: number[] = [];

  // top ring (full) then bottom ring (inset)
  for (const [x, y] of loop) positions.push(x, y, topZ);
  for (const [x, y] of loop) {
    const bx = cx + (x - cx) * k;
    const by = cy + (y - cy) * k;
    positions.push(bx, by, bottomZ);
  }

  // side walls
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const t0 = i,
      t1 = j,
      b0 = n + i,
      b1 = n + j;
    indices.push(t0, b0, t1, t1, b0, b1);
  }

  // bottom cap (fan)
  const baseCenter = positions.length / 3;
  let bcx = 0,
    bcy = 0;
  for (let i = 0; i < n; i++) {
    bcx += positions[(n + i) * 3];
    bcy += positions[(n + i) * 3 + 1];
  }
  positions.push(bcx / n, bcy / n, bottomZ);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    indices.push(baseCenter, n + j, n + i);
  }

  return {
    name: "drafted-plug",
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    color: [0.9, 0.5, 0.2],
  };
}
