import type { BoxSizing, DielineKind } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Dieline (전개도) generation. Given inner box dimensions (W = width, D = depth,
// H = height, mm) produce a flat layout of CUT lines (the knife outline) and
// CREASE lines (fold lines) for each box family. Layouts follow the standard
// FEFCO/ECMA carton anatomy (not spec-exact, but structurally correct: the right
// panels, walls, glue flaps and tuck/dust flaps, with proper cut/crease split).
//
// Each generator returns raw lines in its own local coordinates (y increases
// downward); finalize() normalises them to a positive sheet with a small margin.
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

type Pt = [number, number];
interface Raw {
  type: LineType;
  pts: Pt[];
}

const SHEET_MARGIN = 8; // mm border around the artwork

const clamp = (v: number, lo: number, hi = 1e9) =>
  Math.max(lo, Math.min(hi, v));
const cut = (...pts: Pt[]): Raw => ({ type: "cut", pts });
const crease = (a: Pt, b: Pt): Raw => ({ type: "crease", pts: [a, b] });

/** Shift raw lines to a positive sheet with a margin; compute sheet size. */
function finalize(kind: DielineKind, raw: Raw[]): Dieline {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const l of raw)
    for (const [x, y] of l.pts) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  if (!isFinite(minX)) return { kind, sheet: { width: 0, height: 0 }, lines: [] };
  const lines = raw.map((l) => ({
    type: l.type,
    pts: l.pts.map(([x, y]) => [x - minX + SHEET_MARGIN, y - minY + SHEET_MARGIN] as Pt),
  }));
  return {
    kind,
    sheet: { width: maxX - minX + 2 * SHEET_MARGIN, height: maxY - minY + 2 * SHEET_MARGIN },
    lines,
  };
}

/**
 * A top/bottom closure flap over the body segment [x0,x1] at fold line `baseY`,
 * extending by `depth` in direction `dir` (-1 = up, +1 = down). The fold line is
 * a crease; the three outer edges are a chamfered cut. An optional `tongue` adds
 * a second crease near the tip (the tuck-in fold of a tuck flap).
 */
function flap(
  out: Raw[],
  x0: number,
  x1: number,
  baseY: number,
  dir: -1 | 1,
  depth: number,
  chamfer: number,
  tongue = 0
) {
  const ch = clamp(chamfer, 0, Math.min(depth * 0.45, (x1 - x0) * 0.45));
  const oy = baseY + dir * depth; // outer edge
  const sy = baseY + dir * (depth - ch); // shoulder
  out.push(crease([x0, baseY], [x1, baseY]));
  out.push(
    cut([x0, baseY], [x0, sy], [x0 + ch, oy], [x1 - ch, oy], [x1, sy], [x1, baseY])
  );
  if (tongue > 0) {
    const ty = baseY + dir * (depth - tongue);
    out.push(crease([x0, ty], [x1, ty]));
  }
}

/** A trapezoidal glue flap on a vertical edge at x=`ex`, spanning y in [y0,y1]. */
function glueFlap(out: Raw[], ex: number, y0: number, y1: number, width: number) {
  const ch = clamp(width * 0.6, 0, (y1 - y0) * 0.4);
  out.push(crease([ex, y0], [ex, y1]));
  out.push(cut([ex, y0], [ex + width, y0 + ch], [ex + width, y1 - ch], [ex, y1]));
}

// ── 1) Reverse Tuck End carton (tuck-end-rte) ────────────────────────────────
// 4 wall panels [W,D,W,D] + glue flap. Tuck panels on opposite ends (back-top,
// front-bottom); dust flaps on both side panels; open edges on the other ends.
function reverseTuckEnd(W: number, D: number, H: number): Raw[] {
  const out: Raw[] = [];
  const xs = [0, W, W + D, 2 * W + D, 2 * W + 2 * D];
  const glue = clamp(0.5 * D, 14);
  const tuck = clamp(0.92 * D, 16);
  const dust = clamp(0.62 * D, 12);
  const ch = clamp(Math.min(D, H) * 0.18, 5);

  // Body: outer left edge cut, inter-panel + glue creases.
  out.push(cut([xs[0], 0], [xs[0], H]));
  for (const x of [xs[1], xs[2], xs[3], xs[4]]) out.push(crease([x, 0], [x, H]));
  glueFlap(out, xs[4], 0, H, glue);

  // Top closure: Front open · Side dust · Back tuck · Side dust.
  out.push(cut([xs[0], 0], [xs[1], 0]));
  flap(out, xs[1], xs[2], 0, -1, dust, ch);
  flap(out, xs[2], xs[3], 0, -1, tuck, ch, tuck * 0.28);
  flap(out, xs[3], xs[4], 0, -1, dust, ch);

  // Bottom closure (reversed): Front tuck · Side dust · Back open · Side dust.
  flap(out, xs[0], xs[1], H, 1, tuck, ch, tuck * 0.28);
  flap(out, xs[1], xs[2], H, 1, dust, ch);
  out.push(cut([xs[2], H], [xs[3], H]));
  flap(out, xs[3], xs[4], H, 1, dust, ch);
  return out;
}

// ── 2) G-type carton: tuck top + glued auto-bottom (g-type) ───────────────────
// Tuck top like the RTE; bottom is a 4-flap auto/snap bottom (full bottom flaps
// with diagonal lock creases on the W panels).
function gType(W: number, D: number, H: number): Raw[] {
  const out: Raw[] = [];
  const xs = [0, W, W + D, 2 * W + D, 2 * W + 2 * D];
  const glue = clamp(0.5 * D, 14);
  const tuck = clamp(0.92 * D, 16);
  const dust = clamp(0.62 * D, 12);
  const bot = clamp(0.55 * D, 14); // auto-bottom flap depth
  const ch = clamp(Math.min(D, H) * 0.18, 5);

  out.push(cut([xs[0], 0], [xs[0], H]));
  for (const x of [xs[1], xs[2], xs[3], xs[4]]) out.push(crease([x, 0], [x, H]));
  glueFlap(out, xs[4], 0, H, glue);

  // Top: tuck on back panel, dust on sides, open over front.
  out.push(cut([xs[0], 0], [xs[1], 0]));
  flap(out, xs[1], xs[2], 0, -1, dust, ch);
  flap(out, xs[2], xs[3], 0, -1, tuck, ch, tuck * 0.28);
  flap(out, xs[3], xs[4], 0, -1, dust, ch);

  // Bottom: four overlapping auto-bottom flaps; diagonal lock creases on W flaps.
  for (let i = 0; i < 4; i++) {
    const a = xs[i],
      b = xs[i + 1];
    flap(out, a, b, H, 1, bot, ch);
    const isW = i % 2 === 0;
    if (isW) {
      // diagonal auto-lock creases from the inner corners.
      out.push(crease([a, H], [a + (b - a) / 2, H + bot]));
      out.push(crease([b, H], [a + (b - a) / 2, H + bot]));
    }
  }
  return out;
}

// ── 3) Open sleeve (sleeve) ───────────────────────────────────────────────────
// A 4-panel tube, open top & bottom, glue flap on one edge.
function sleeve(W: number, D: number, H: number): Raw[] {
  const out: Raw[] = [];
  const xs = [0, W, W + D, 2 * W + D, 2 * W + 2 * D];
  const glue = clamp(0.5 * D, 14);
  const ch = clamp(H * 0.18, 6);

  out.push(cut([xs[0], 0], [xs[4], 0])); // open top edge
  out.push(cut([xs[0], H], [xs[4], H])); // open bottom edge
  out.push(cut([xs[0], 0], [xs[0], H])); // left edge
  for (const x of [xs[1], xs[2], xs[3], xs[4]]) out.push(crease([x, 0], [x, H]));
  glueFlap(out, xs[4], 0, H, glue);
  return out;
}

// ── 4) Two-piece tray + lid (two-piece-tray) ─────────────────────────────────
// Tray: base W×D, four walls folding up (height H) with glued corner tabs.
// Lid: a shallower tray (Hl) enlarged by tolerance, laid out beside it.
function trayPiece(
  W: number,
  D: number,
  H: number,
  ox: number,
  oy: number
): Raw[] {
  const out: Raw[] = [];
  const tab = clamp(Math.min(W, D) * 0.4, 12, H); // corner glue tab width
  const ch = clamp(H * 0.2, 5);
  // base
  out.push(crease([ox, oy], [ox + W, oy]));
  out.push(crease([ox, oy + D], [ox + W, oy + D]));
  out.push(crease([ox, oy], [ox, oy + D]));
  out.push(crease([ox + W, oy], [ox + W, oy + D]));
  // top wall (up) + bottom wall (down) over the base width
  flap(out, ox, ox + W, oy, -1, H, ch);
  flap(out, ox, ox + W, oy + D, 1, H, ch);
  // left & right walls — drawn as vertical flaps, plus corner glue tabs.
  // left wall
  out.push(cut([ox, oy], [ox - H + ch, oy], [ox - H, oy + ch]));
  out.push(cut([ox - H, oy + ch], [ox - H, oy + D - ch]));
  out.push(cut([ox - H, oy + D - ch], [ox - H + ch, oy + D]));
  out.push(cut([ox - H + ch, oy + D], [ox, oy + D]));
  // right wall
  out.push(cut([ox + W, oy], [ox + W + H - ch, oy], [ox + W + H, oy + ch]));
  out.push(cut([ox + W + H, oy + ch], [ox + W + H, oy + D - ch]));
  out.push(cut([ox + W + H, oy + D - ch], [ox + W + H - ch, oy + D]));
  out.push(cut([ox + W + H - ch, oy + D], [ox + W, oy + D]));
  // corner glue tabs on the top & bottom walls' ends (fold around to side walls).
  for (const wy of [oy, oy + D]) {
    const dir = wy === oy ? -1 : 1;
    for (const wx of [ox, ox + W]) {
      const sgn = wx === ox ? -1 : 1;
      const yTip = wy + dir * H;
      out.push(crease([wx, wy], [wx, yTip]));
      out.push(
        cut(
          [wx, yTip],
          [wx + sgn * tab, yTip - dir * ch],
          [wx + sgn * tab, wy + dir * ch]
        )
      );
    }
  }
  return out;
}

function twoPieceTray(W: number, D: number, H: number, tol: number): Raw[] {
  const out: Raw[] = [];
  // Tray.
  out.push(...trayPiece(W, D, H, 0, 0));
  // Lid: shallower, enlarged by tolerance, placed to the right.
  const lidH = clamp(H * 0.4, 14);
  const lidW = W + 2 * tol;
  const lidD = D + 2 * tol;
  const gap = clamp(H + 10, 20);
  const lidOx = W + H + gap + lidH; // clear of the tray's right wall + gap
  out.push(...trayPiece(lidW, lidD, lidH, lidOx, 0));
  return out;
}

// ── 5) Roll-end tuck-front mailer (mailer) ───────────────────────────────────
// Plus-shaped: base W×D, back wall + lid + lid-tuck above, front wall + lock
// below, side walls left & right with corner glue wings.
function mailer(W: number, D: number, H: number): Raw[] {
  const out: Raw[] = [];
  const ch = clamp(Math.min(W, D, H) * 0.16, 5);
  const tk = clamp(0.55 * H, 16); // lid tuck depth
  const lock = clamp(0.45 * D, 14); // front lock flap depth
  const wing = clamp(0.5 * H, 12); // side-wall corner wing width

  // base (all four edges crease where walls fold up)
  out.push(crease([0, 0], [W, 0]));
  out.push(crease([0, D], [W, D]));
  out.push(crease([0, 0], [0, D]));
  out.push(crease([W, 0], [W, D]));

  // back wall (up) + lid + lid tuck
  out.push(crease([0, -H], [W, -H])); // back wall ↔ lid fold
  out.push(crease([0, -H - D], [W, -H - D])); // lid ↔ tuck fold
  out.push(cut([0, 0], [0, -H - D])); // left edge up the stack
  out.push(cut([W, 0], [W, -H - D])); // right edge up the stack
  flap(out, 0, W, -H - D, -1, tk, ch, tk * 0.3); // lid tuck

  // front wall (down) + lock flap
  out.push(crease([0, D + H], [W, D + H])); // front wall ↔ lock fold
  out.push(cut([0, D], [0, D + H])); // left edge down
  out.push(cut([W, D], [W, D + H])); // right edge down
  flap(out, 0, W, D + H, 1, lock, ch, lock * 0.4);

  // side walls (left & right) + corner wings (glue to the back/front walls)
  for (const side of [-1, 1] as const) {
    const xWall = side === -1 ? 0 : W; // base edge the wall folds from
    const xTip = xWall + side * H;
    // wall outline (open ends, wings handle corners)
    out.push(crease([xWall, 0], [xWall, D])); // already added base edge crease; harmless dup avoided below
    out.push(cut([xWall, 0], [xTip, 0])); // top edge of side wall
    out.push(cut([xTip, 0], [xTip, D])); // outer edge
    out.push(cut([xTip, D], [xWall, D])); // bottom edge of side wall
    // corner wings at the wall's top & bottom ends (fold to meet back/front walls)
    for (const wy of [0, D]) {
      const dir = wy === 0 ? -1 : 1;
      out.push(crease([xWall, wy], [xTip, wy]));
      out.push(
        cut(
          [xWall, wy + dir * 0],
          [xWall, wy + dir * wing],
          [xTip, wy + dir * (wing - ch)],
          [xTip, wy]
        )
      );
    }
  }
  return out;
}

export function generateDieline(kind: DielineKind, sizing: BoxSizing): Dieline {
  const W = Math.max(5, sizing.width);
  const D = Math.max(5, sizing.depth);
  const H = Math.max(5, sizing.height);
  const tol = Math.max(0, sizing.tolerance);
  switch (kind) {
    case "tuck-end-rte":
      return finalize(kind, reverseTuckEnd(W, D, H));
    case "g-type":
      return finalize(kind, gType(W, D, H));
    case "sleeve":
      return finalize(kind, sleeve(W, D, H));
    case "two-piece-tray":
      return finalize(kind, twoPieceTray(W, D, H, tol));
    case "mailer":
      return finalize(kind, mailer(W, D, H));
    default:
      return finalize(kind, reverseTuckEnd(W, D, H));
  }
}
