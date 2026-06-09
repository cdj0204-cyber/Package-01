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

/** A trapezoidal glue/lock tab on a VERTICAL edge at x=`ex`, y∈[y0,y1], extending
 *  `width` in direction `dir` (-1 = left, +1 = right). */
function vGlue(
  out: Raw[],
  ex: number,
  y0: number,
  y1: number,
  width: number,
  dir: -1 | 1
) {
  const ch = clamp(width * 0.6, 0, (y1 - y0) * 0.4);
  out.push(crease([ex, y0], [ex, y1]));
  out.push(
    cut(
      [ex, y0],
      [ex + dir * width, y0 + ch],
      [ex + dir * width, y1 - ch],
      [ex, y1]
    )
  );
}

/** Minor-arc polyline from point a to point b about centre c (the short way). */
function arcBetween(c: Pt, a: Pt, b: Pt, segs = 7): Pt[] {
  const a0 = Math.atan2(a[1] - c[1], a[0] - c[0]);
  let d = Math.atan2(b[1] - c[1], b[0] - c[0]) - a0;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  const r = Math.hypot(a[0] - c[0], a[1] - c[1]);
  const pts: Pt[] = [];
  for (let i = 1; i <= segs; i++) {
    const t = a0 + (d * i) / segs;
    pts.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]);
  }
  return pts;
}

/**
 * A joining/glue WING hinged on the VERTICAL edge x=`ex`, y∈[y0,y1], extending
 * `len` in direction `dir` (−1 left / +1 right) with rounded far corners (radius
 * `r`) and an optional `taper` (outer edge shortened by `taper` at each end). The
 * hinge edge is a crease; the outer outline is a rounded cut. These are the lid
 * and front-tuck side wings that wrap around and glue/lock the cover shut — the
 * "결합 날개" missing from the previous layout.
 */
function sideWing(
  out: Raw[],
  ex: number,
  y0: number,
  y1: number,
  len: number,
  dir: -1 | 1,
  r: number,
  taper = 0
) {
  out.push(crease([ex, y0], [ex, y1]));
  const xo = ex + dir * len;
  const ty0 = y0 + taper;
  const ty1 = y1 - taper;
  const rr = clamp(r, 0, Math.min(len * 0.6, (ty1 - ty0) * 0.48));
  const cTop: Pt = [xo - dir * rr, ty0 + rr];
  const cBot: Pt = [xo - dir * rr, ty1 - rr];
  out.push({
    type: "cut",
    pts: [
      [ex, y0],
      [xo - dir * rr, ty0],
      ...arcBetween(cTop, [xo - dir * rr, ty0], [xo, ty0 + rr]),
      [xo, ty1 - rr],
      ...arcBetween(cBot, [xo, ty1 - rr], [xo - dir * rr, ty1]),
      [xo - dir * rr, ty1],
      [ex, y1],
    ],
  });
}

// ── 2) G-type carton: roll-end body + hinged lid + front tuck flap (g-type) ───
// The flat unfold of the folded 3D model in box/boxModel.ts, so the Step-8 3D
// preview and the Step-9 dieline agree. Three regions (as marked on the
// reference): ③ body = base + 4 walls (+ back dust flap, side glue tabs),
// ② lid = a W×D cover hinged off the FRONT wall with rounded shoulders, and
// ① front tuck flap = a rounded tongue hinged off the lid that tucks down the
// front. Local coords: y DOWNWARD. Base sits at x∈[0,W], y∈[0,D]; walls fold off
// its four edges; the lid+tuck hang below the front wall.
function gType(W: number, D: number, H: number, tol: number): Raw[] {
  const out: Raw[] = [];
  const topFlap = clamp(0.5 * H, 12); // back-wall top dust/glue flap depth
  const sideGlue = clamp(0.42 * H, 10); // side-wall outer glue-tab width
  const lidLen = D + tol; // lid covers the W×D top (+ a little tolerance)
  const tuckLen = clamp(0.9 * H, 16); // front tuck flap depth (≈ box height)
  const lidWing = clamp(0.7 * H, 14); // lid side-wing reach (joining/glue wing)
  const tuckWing = clamp(0.5 * D, 12); // front-tuck side-wing reach
  const lidWingR = clamp(0.4 * Math.min(lidWing, lidLen), 8);
  const tuckWingR = clamp(0.4 * Math.min(tuckWing, tuckLen), 6);
  const ch = clamp(Math.min(W, D, H) * 0.14, 4);
  const lockW = clamp(0.22 * D, 8); // side-tab lock notch width
  const lockD = clamp(0.45 * sideGlue, 5); // lock notch depth

  // Key y bands (y increases downward).
  const yBack = -H; // back wall top edge (crease to its dust flap)
  const yBaseT = 0; // base top edge (crease back ↔ base)
  const yBaseB = D; // base bottom edge (crease base ↔ front)
  const yFront = D + H; // front wall bottom edge (crease front ↔ lid)
  const yLid = yFront + lidLen; // lid end edge (crease lid ↔ tuck)
  const yTuck = yLid + tuckLen; // tuck tip

  // ── ③ Body ──────────────────────────────────────────────────────────────
  // Base: four fold creases (to the four walls).
  out.push(crease([0, yBaseT], [W, yBaseT])); // base ↔ back
  out.push(crease([0, yBaseB], [W, yBaseB])); // base ↔ front
  out.push(crease([0, yBaseT], [0, yBaseB])); // base ↔ left wall
  out.push(crease([W, yBaseT], [W, yBaseB])); // base ↔ right wall

  // Back wall (folds up) + its top dust flap; side edges are free cuts.
  out.push(cut([0, yBack], [0, yBaseT]));
  out.push(cut([W, yBack], [W, yBaseT]));
  flap(out, 0, W, yBack, -1, topFlap, ch, topFlap * 0.3);

  // Front wall (folds down); side edges free; bottom edge becomes the lid hinge.
  out.push(cut([0, yBaseB], [0, yFront]));
  out.push(cut([W, yBaseB], [W, yFront]));

  // Left & right side walls (fold up out of the page) with outer glue+lock tabs.
  // Left wall: x∈[-H,0]. Right wall: x∈[W,W+H].
  out.push(cut([-H, yBaseT], [0, yBaseT])); // left wall top edge
  out.push(cut([-H, yBaseB], [0, yBaseB])); // left wall bottom edge
  out.push(cut([W, yBaseT], [W + H, yBaseT])); // right wall top edge
  out.push(cut([W, yBaseB], [W + H, yBaseB])); // right wall bottom edge
  vGlue(out, -H, yBaseT, yBaseB, sideGlue, -1);
  vGlue(out, W + H, yBaseT, yBaseB, sideGlue, 1);
  // Lock notches on the side glue tabs (cut slots that bite into the front/back
  // walls when assembled — the comb edge on the reference).
  for (const yc of [yBaseT + D * 0.32, yBaseB - D * 0.32]) {
    out.push(
      cut(
        [-H, yc - lockW / 2],
        [-H + lockD, yc - lockW / 2],
        [-H + lockD, yc + lockW / 2],
        [-H, yc + lockW / 2]
      )
    );
    out.push(
      cut(
        [W + H, yc - lockW / 2],
        [W + H - lockD, yc - lockW / 2],
        [W + H - lockD, yc + lockW / 2],
        [W + H, yc + lockW / 2]
      )
    );
  }

  // ── ② Lid — hinged off the front wall (yFront). A plain W×lidLen cover whose
  //    FOUR edges are all folds, with a rounded JOINING WING on each side. The
  //    wings wrap down and glue/lock to the box side walls — the curved shoulders
  //    of region ②.
  out.push(crease([0, yFront], [W, yFront])); // front wall ↔ lid (hinge)
  out.push(crease([0, yFront], [0, yLid])); // lid ↔ left wing
  out.push(crease([W, yFront], [W, yLid])); // lid ↔ right wing
  out.push(crease([0, yLid], [W, yLid])); // lid ↔ tuck (hinge)
  sideWing(out, 0, yFront, yLid, lidWing, -1, lidWingR, lidWing * 0.16);
  sideWing(out, W, yFront, yLid, lidWing, 1, lidWingR, lidWing * 0.16);

  // ── ① Front tuck flap — hinged off the lid (yLid). The tongue panel (W×tuckLen)
  //    plus a smaller rounded wing on each side; its bottom edge has rounded
  //    corners so the whole thing reads as the pill-shaped front tuck of region ①.
  out.push(crease([0, yLid], [0, yTuck])); // tuck ↔ left wing
  out.push(crease([W, yLid], [W, yTuck])); // tuck ↔ right wing
  const tr = clamp(0.4 * tuckLen, 6, W * 0.4); // tongue bottom corner radius
  out.push({
    type: "cut",
    pts: [
      [0, yTuck - tr],
      ...arcBetween([tr, yTuck - tr], [0, yTuck - tr], [tr, yTuck]),
      [W - tr, yTuck],
      ...arcBetween([W - tr, yTuck - tr], [W - tr, yTuck], [W, yTuck - tr]),
    ],
  });
  sideWing(out, 0, yLid, yTuck, tuckWing, -1, tuckWingR, tuckWing * 0.22);
  sideWing(out, W, yLid, yTuck, tuckWing, 1, tuckWingR, tuckWing * 0.22);

  // Conventional G-type sheet orientation: body ③ at the TOP with the lid ② and
  // front tuck ① hanging below. The panels above are authored y-downward (tuck at
  // the largest y); mirror vertically so the viewport/SVG show body-up.
  for (const r of out) r.pts = r.pts.map(([x, y]) => [x, -y] as Pt);

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
      return finalize(kind, gType(W, D, H, tol));
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
