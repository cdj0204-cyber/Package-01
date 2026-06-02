import * as THREE from "three";
import type { PlacedModel } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Bottom-face alignment helpers.
//
// In the viewport Y is up (grid on XZ, block height along Y), so a model's
// "bottom face" is its lowest world-space Y. We must account for each model's
// transform exactly as Viewport3D applies it:
//
//   worldPos = center + transform.position + R * (vertex - center)
//
// where `center` is the model's bbox centre (the gizmo pivot) and R is the
// Euler('XYZ') rotation. Translating position.y by d shifts every vertex's
// world Y by d, so aligning bottoms is a pure Y translation — robust under
// any rotation.
// ─────────────────────────────────────────────────────────────────────────────

function bboxCenter(b: PlacedModel["model"]["bbox"]): [number, number, number] {
  return [
    (b.min[0] + b.max[0]) / 2,
    (b.min[1] + b.max[1]) / 2,
    (b.min[2] + b.max[2]) / 2,
  ];
}

/** World axis: 0 = X, 1 = Y (height), 2 = Z. */
export type AlignAxis = 0 | 1 | 2;
/** Which side of the bounding box to align: min / center / max edge. */
export type AlignPick = "min" | "center" | "max";

/** World-space min/max of a placed model's (rotated) bbox along a world axis. */
export function worldAxisRange(
  pm: PlacedModel,
  axis: AlignAxis
): { min: number; max: number } {
  const b = pm.model.bbox;
  const c = bboxCenter(b);
  const R = new THREE.Matrix4().makeRotationFromEuler(
    new THREE.Euler(
      pm.transform.rotation[0],
      pm.transform.rotation[1],
      pm.transform.rotation[2],
      "XYZ"
    )
  );
  const v = new THREE.Vector3();
  let min = Infinity;
  let max = -Infinity;
  for (const x of [b.min[0], b.max[0]])
    for (const y of [b.min[1], b.max[1]])
      for (const z of [b.min[2], b.max[2]]) {
        v.set(x - c[0], y - c[1], z - c[2]).applyMatrix4(R);
        const w = [v.x, v.y, v.z][axis] + c[axis] + pm.transform.position[axis];
        if (w < min) min = w;
        if (w > max) max = w;
      }
  return { min, max };
}

/** World-space coordinate of a model's chosen edge/center along a world axis. */
export function worldAlignValue(
  pm: PlacedModel,
  axis: AlignAxis,
  pick: AlignPick
): number {
  const { min, max } = worldAxisRange(pm, axis);
  if (pick === "min") return min;
  if (pick === "max") return max;
  return (min + max) / 2;
}

/** Lowest world-space Y of a placed model's (rotated) bounding box. */
export function worldBottomY(pm: PlacedModel): number {
  return worldAxisRange(pm, 1).min;
}
