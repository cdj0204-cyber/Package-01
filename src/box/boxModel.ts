import type { DielineKind, LidSide } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Folded 3D representation of each box family, assembled with its lid/flaps
// slightly OPEN so the type reads at a glance (matching real product photos):
//   • sleeve         — open tube
//   • tuck-end-rte   — tall tuck carton, top tuck lid ajar + dust flaps
//   • mailer/g-type  — die-cut roll-end mailer: tray + back-hinged lid open +
//                      side dust flaps folded in + front tuck
//   • two-piece-tray — tray with a separate telescoping lid lifted ajar
//
// Coordinates: box centred on X/Z, base at y=0, up +Y. W = width (X), D = depth
// (Z), H = height (Y). Panels are quads. `kind` of each panel ("out"/"in"/"edge"
// is decided later by the renderer from winding). The viewport gives every panel
// real board thickness + a corrugated material.
// ─────────────────────────────────────────────────────────────────────────────

export type V3 = [number, number, number];

export interface BoxModel {
  faces: V3[][];
  color: [number, number, number];
}

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const nrm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const DEG = Math.PI / 180;

/** Rotate point Q about the axis through O with unit direction `a` by `ang` rad. */
function rotateAboutAxis(Q: V3, O: V3, a: V3, ang: number): V3 {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const v = sub(Q, O);
  const av = a[0] * v[0] + a[1] * v[1] + a[2] * v[2];
  const cr = cross(a, v);
  return [
    O[0] + v[0] * c + cr[0] * s + a[0] * av * (1 - c),
    O[1] + v[1] * c + cr[1] * s + a[1] * av * (1 - c),
    O[2] + v[2] * c + cr[2] * s + a[2] * av * (1 - c),
  ];
}

/**
 * Round the listed corners of a (convex) polygon: each chosen vertex V is
 * replaced by a quadratic-bezier fillet of `segs` segments between the points
 * `r` mm back along each adjoining edge. Radius is clamped to half the shorter
 * edge so neighbouring fillets never overlap.
 */
function roundCorners(poly: V3[], roundIdx: number[], r: number, segs = 5): V3[] {
  const n = poly.length;
  const set = new Set(roundIdx);
  const out: V3[] = [];
  for (let i = 0; i < n; i++) {
    if (!set.has(i)) {
      out.push(poly[i]);
      continue;
    }
    const prev = poly[(i - 1 + n) % n];
    const V = poly[i];
    const next = poly[(i + 1) % n];
    const rr = Math.min(r, dist(prev, V) * 0.5, dist(V, next) * 0.5);
    const p1 = sub(V, mul(nrm(sub(V, prev)), rr)); // back along incoming edge
    const p2 = add(V, mul(nrm(sub(next, V)), rr)); //  forward along outgoing edge
    for (let s = 0; s <= segs; s++) {
      const tt = s / segs;
      const u = 1 - tt;
      const a = u * u;
      const b = 2 * u * tt;
      const c = tt * tt;
      out.push([
        a * p1[0] + b * V[0] + c * p2[0],
        a * p1[1] + b * V[1] + c * p2[1],
        a * p1[2] + b * V[2] + c * p2[2],
      ]);
    }
  }
  return out;
}

/**
 * A flap hinged along edge A→B. `out` is the unfolded (flat) extension direction,
 * `up` the fold direction; `angleDeg` is measured from `out`. Returns the flap
 * quad [A, B, tipB, tipA].
 */
function flap(A: V3, B: V3, out: V3, up: V3, L: number, angleDeg: number): V3[] {
  const o = nrm(out);
  const u = nrm(up);
  const c = Math.cos(angleDeg * DEG);
  const s = Math.sin(angleDeg * DEG);
  const dir: V3 = [o[0] * c + u[0] * s, o[1] * c + u[1] * s, o[2] * c + u[2] * s];
  return [A, B, add(B, mul(dir, L)), add(A, mul(dir, L))];
}

const KRAFT: [number, number, number] = [0.80, 0.62, 0.40];

export function buildBoxModel(
  kind: DielineKind,
  W: number,
  D: number,
  H: number,
  lidSide: LidSide = "width"
): BoxModel {
  const hx = W / 2;
  const hz = D / 2;
  const b00: V3 = [-hx, 0, -hz];
  const b10: V3 = [hx, 0, -hz];
  const b11: V3 = [hx, 0, hz];
  const b01: V3 = [-hx, 0, hz];
  const t00: V3 = [-hx, H, -hz];
  const t10: V3 = [hx, H, -hz];
  const t11: V3 = [hx, H, hz];
  const t01: V3 = [-hx, H, hz];

  const front: V3[] = [b01, b11, t11, t01]; // +z
  const back: V3[] = [b10, b00, t00, t10]; // −z
  const left: V3[] = [b00, b01, t01, t00]; // −x
  const right: V3[] = [b11, b10, t10, t11]; // +x
  const bottom: V3[] = [b00, b10, b11, b01];
  const top: V3[] = [t01, t11, t10, t00];
  const walls = [front, back, left, right];

  switch (kind) {
    case "sleeve":
      // Open tube — four walls, open top & bottom.
      return { faces: [...walls], color: KRAFT };

    case "two-piece-tray": {
      // Base tray (walls up full H) + a separate shallow lid lifted ajar above.
      const lidH = Math.max(10, H * 0.5);
      const lift = Math.max(10, H * 0.18); // raised so the lid reads as separate
      const ex = 2.5; // lid is slightly larger (telescoping)
      const ly = H + lift; // lid rim sits here
      const Lhx = hx + ex;
      const Lhz = hz + ex;
      const c00: V3 = [-Lhx, ly + lidH, -Lhz];
      const c10: V3 = [Lhx, ly + lidH, -Lhz];
      const c11: V3 = [Lhx, ly + lidH, Lhz];
      const c01: V3 = [-Lhx, ly + lidH, Lhz];
      const d00: V3 = [-Lhx, ly, -Lhz];
      const d10: V3 = [Lhx, ly, -Lhz];
      const d11: V3 = [Lhx, ly, Lhz];
      const d01: V3 = [-Lhx, ly, Lhz];
      const lidTop: V3[] = [c01, c11, c10, c00];
      const lidFront: V3[] = [d01, d11, c11, c01];
      const lidBack: V3[] = [d10, d00, c00, c10];
      const lidLeft: V3[] = [d00, d01, c01, c00];
      const lidRight: V3[] = [d11, d10, c10, c11];
      return {
        faces: [bottom, ...walls, lidTop, lidFront, lidBack, lidLeft, lidRight],
        color: KRAFT,
      };
    }

    case "mailer":
    case "g-type": {
      // Die-cut roll-end mailer: base + 4 walls + a hinged lid open, with a front
      // tuck flap on the lid. Built on a generic hinge FRAME so the whole lid
      // assembly can attach to either the width-spanning edge (가로, default) or
      // the depth-spanning edge (세로):
      //   • hd  = hinge direction (along the hinge edge)
      //   • od  = outward flat direction the lid folds over (horizontal)
      //   • H0,H1 = the two hinge corners;  coverLen = dimension the lid covers
      const lidAngle = kind === "g-type" ? 110 : 120; // both open, slightly diff
      const onDepth = lidSide === "depth";
      const up: V3 = [0, 1, 0];
      const H0: V3 = t00;
      const H1: V3 = onDepth ? t01 : t10;
      const hd: V3 = onDepth ? [0, 0, 1] : [1, 0, 0];
      const od: V3 = onDepth ? [1, 0, 0] : [0, 0, 1];
      const coverLen = onDepth ? W : D;

      const lid = flap(H0, H1, od, up, coverLen, lidAngle); // [H0,H1,tipB,tipA]
      const tipB = lid[2]; // lid far tip on the H1 side
      const tipA = lid[3]; // lid far tip on the H0 side
      const alongLid: V3 = nrm(sub(tipA, H0)); // hinge → tip, along the lid

      // Rule 1: front tuck flap length == box height (H). Unit direction (58°
      // forward off the lid, toward the opening `od`) so length is exactly H.
      const tuckLen = H;
      const tuckUnit: V3 = nrm(
        add(mul(alongLid, Math.cos(58 * DEG)), mul(od, Math.sin(58 * DEG)))
      );
      const tuck: V3[] = [
        tipA,
        tipB,
        add(tipB, mul(tuckUnit, tuckLen)),
        add(tipA, mul(tuckUnit, tuckLen)),
      ];

      // Lid side wings: flat ears (extending ∓hd from the side edges) folded 100°
      // toward the lid's up-front normal. outL/outR run along ∓hd.
      const wingW = H; // rule 3: lid side-wing length = box height
      let lidNormal: V3 = nrm(cross(hd, alongLid));
      if (lidNormal[0] * od[0] + lidNormal[1] * od[1] + lidNormal[2] * od[2] < 0)
        lidNormal = mul(lidNormal, -1); // ensure up-front (toward od)
      const outL: V3 = mul(hd, -1);
      const outR: V3 = hd;
      const wingR = wingW * 0.4; // corner radius
      const lidWingLeft = roundCorners(
        flap(H0, tipA, outL, lidNormal, wingW, 100),
        [2, 3],
        wingR
      );
      const lidWingRight = roundCorners(
        flap(H1, tipB, outR, lidNormal, wingW, 100),
        [2, 3],
        wingR
      );

      // Front-tuck side wings: COPLANAR with the tuck flap, extending ∓hd from the
      // flap side edges, narrowing toward the tip (symmetric parallelogram).
      const tuckTipB = tuck[2];
      const tuckTipA = tuck[3];
      const tuckDir: V3 = nrm(sub(tuckTipA, tipA)); // along the flap, hinge→tip
      const tWingW = Math.min(D, 100); // rule 2: tuck side-wing length = box depth, capped at 100 mm
      const tTaper = tuckLen * 0.2; // slight narrowing toward the free edge
      const tHalf = tTaper / 2; // split the taper both ends → symmetric (no skew)
      const tWingR = tWingW * 0.4; // free-corner radius (same idea as lid wings)
      // Round the two FREE corners (idx 2 & 3) BEFORE folding so the hinge
      // vertices (idx 0 & 1) stay on the fold axis.
      const tuckWingLeftFlat = roundCorners(
        [
          tipA,
          tuckTipA,
          add(add(tuckTipA, mul(outL, tWingW)), mul(tuckDir, -tHalf)),
          add(add(tipA, mul(outL, tWingW)), mul(tuckDir, tHalf)),
        ],
        [2, 3],
        tWingR
      );
      const tuckWingRightFlat = roundCorners(
        [
          tipB,
          tuckTipB,
          add(add(tuckTipB, mul(outR, tWingW)), mul(tuckDir, -tHalf)),
          add(add(tipB, mul(outR, tWingW)), mul(tuckDir, tHalf)),
        ],
        [2, 3],
        tWingR
      );
      // Fold each tuck side wing DOWN ~60° about its hinge. The down-going sign
      // depends on orientation, so pick whichever lowers the free corner's Y.
      const tuckFold = 60 * DEG;
      const downSign = (wing: V3[], origin: V3): number => {
        const probe = wing[2];
        const yp = rotateAboutAxis(probe, origin, tuckDir, tuckFold)[1];
        const ym = rotateAboutAxis(probe, origin, tuckDir, -tuckFold)[1];
        return yp <= ym ? tuckFold : -tuckFold;
      };
      const lSign = downSign(tuckWingLeftFlat, tipA);
      const rSign = downSign(tuckWingRightFlat, tipB);
      const tuckWingLeft = tuckWingLeftFlat.map((p) =>
        rotateAboutAxis(p, tipA, tuckDir, lSign)
      );
      const tuckWingRight = tuckWingRightFlat.map((p) =>
        rotateAboutAxis(p, tipB, tuckDir, rSign)
      );

      return {
        faces: [
          bottom,
          ...walls,
          lid,
          tuck,
          lidWingLeft,
          lidWingRight,
          tuckWingLeft,
          tuckWingRight,
        ],
        color: KRAFT,
      };
    }

    case "tuck-end-rte":
    default: {
      // Tall tuck-end carton: closed body, bottom closed, top tuck lid ajar with
      // the two side dust flaps folded in over the opening.
      const lid = flap(t00, t10, [0, 0, 1], [0, 1, 0], D * 0.96, 122); // tuck lid ajar
      const dust = Math.min(D * 0.45, W * 0.4);
      const dustL = flap(t00, t01, [0, 1, 0], [1, 0, 0], dust, 80);
      const dustR = flap(t11, t10, [0, 1, 0], [-1, 0, 0], dust, 80);
      return { faces: [...walls, bottom, dustL, dustR, lid], color: KRAFT };
    }
  }
}
