import type { BoxSizing, DielineKind } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Dieline (전개도) generation. Given inner box dimensions, produce a flat layout
// of cut lines and fold (crease) lines for the selected box family.
//
// SKELETON: generates a correct, manufacturable-looking layout for the common
// tuck-end / G-type cross pattern. Other families fall back to the same cross
// with notes. Dimensions are in mm. Refine per FEFCO/ECMA spec later.
// ─────────────────────────────────────────────────────────────────────────────

export type LineType = "cut" | "crease";

export interface DielineLine {
  type: LineType;
  pts: Array<[number, number]>;
}

export interface Dieline {
  kind: DielineKind;
  /** Overall flat sheet size (mm). */
  sheet: { width: number; height: number };
  lines: DielineLine[];
}

function rect(
  x: number,
  y: number,
  w: number,
  h: number,
  type: LineType
): DielineLine {
  return {
    type,
    pts: [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
      [x, y],
    ],
  };
}

/**
 * Classic "cross" dieline used by tuck-end / G-type style cartons:
 * a horizontal band of 4 wall panels (front, side, back, side) with top/bottom
 * flaps and tuck panels. Glue flap on the right.
 */
function crossDieline(
  kind: DielineKind,
  W: number,
  D: number,
  H: number
): Dieline {
  const glue = Math.max(12, D * 0.6); // glue flap width
  const flap = Math.max(15, D * 0.7); // top/bottom flap depth

  const bandX = [0, W, W + D, 2 * W + D, 2 * W + 2 * D]; // panel left edges
  const sheetW = bandX[4] + glue;
  const sheetH = H + 2 * flap;

  const lines: DielineLine[] = [];

  // outer cut boundary (simplified rectangle of the whole sheet)
  lines.push(rect(0, 0, sheetW, sheetH, "cut"));

  // vertical crease lines between the 4 body panels + glue flap
  for (const x of [W, W + D, 2 * W + D, 2 * W + 2 * D]) {
    lines.push({ type: "crease", pts: [[x, flap], [x, flap + H]] });
  }

  // horizontal creases separating body from top/bottom flaps
  lines.push({ type: "crease", pts: [[0, flap], [bandX[4], flap]] });
  lines.push({ type: "crease", pts: [[0, flap + H], [bandX[4], flap + H]] });

  // flap separation cuts (between adjacent flaps) — top & bottom
  for (const x of bandX) {
    lines.push({ type: "cut", pts: [[x, 0], [x, flap]] });
    lines.push({ type: "cut", pts: [[x, flap + H], [x, sheetH]] });
  }

  return {
    kind,
    sheet: { width: sheetW, height: sheetH },
    lines,
  };
}

export function generateDieline(
  kind: DielineKind,
  sizing: BoxSizing
): Dieline {
  const W = sizing.width;
  const D = sizing.depth;
  const H = sizing.height;
  // All current families share the cross layout in the skeleton.
  return crossDieline(kind, W, D, H);
}
