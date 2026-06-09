import * as THREE from "three";
import type {
  ImportedMesh,
  ImportedModel,
  ModelSilhouette,
  ModelTransform,
  SilhouetteField,
  Silhouette,
  ViewName,
} from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Step 2 — real silhouette extraction via a signed-distance field (SDF).
//
//   1. Transform the model into world space (its current placement).
//   2. Project every triangle onto the chosen view's 2D (u,v) plane.
//   3. Rasterise the projected triangles into an occupancy grid.
//   4. Compute an exact Euclidean signed distance field (Felzenszwalb EDT):
//      negative inside the silhouette, positive outside.
//   5. The outline at offset d is simply the iso-contour of the SDF at level d
//      (marching squares). So + / − offsets are exact and handle concave shapes
//      and interior holes for free — no polygon-offset maths needed.
//
// The offset outline then becomes a plane that is extruded along the view's
// depth axis into a solid (with holes), see buildExtrudeMesh().
// ─────────────────────────────────────────────────────────────────────────────

/** Which world axes form a view's 2D plane (u, v) and its depth axis (Y is up). */
export function viewAxes(view: ViewName): {
  u: 0 | 1 | 2;
  v: 0 | 1 | 2;
  depth: 0 | 1 | 2;
} {
  switch (view) {
    case "top":
      return { u: 0, v: 2, depth: 1 }; // look down Y: plane X-Z, extrude along Y
    case "front":
      return { u: 0, v: 1, depth: 2 }; // look along Z: plane X-Y, extrude along Z
    case "side":
      return { u: 2, v: 1, depth: 0 }; // look along X: plane Z-Y, extrude along X
  }
}

function bboxCenter(b: ImportedModel["bbox"]): [number, number, number] {
  return [
    (b.min[0] + b.max[0]) / 2,
    (b.min[1] + b.max[1]) / 2,
    (b.min[2] + b.max[2]) / 2,
  ];
}

/** Map a 2D (u,v) point + depth value back to a world XYZ triple for a view. */
export function uvToWorld(
  u: number,
  v: number,
  depthVal: number,
  view: ViewName
): [number, number, number] {
  const ax = viewAxes(view);
  const p: [number, number, number] = [0, 0, 0];
  p[ax.u] = u;
  p[ax.v] = v;
  p[ax.depth] = depthVal;
  return p;
}

// ── Build the SDF for a placed model ─────────────────────────────────────────
export function buildSilhouetteField(
  model: ImportedModel,
  transform: ModelTransform,
  view: ViewName
): SilhouetteField {
  const ax = viewAxes(view);
  const center = bboxCenter(model.bbox);
  const R = new THREE.Matrix4().makeRotationFromEuler(
    new THREE.Euler(
      transform.rotation[0],
      transform.rotation[1],
      transform.rotation[2],
      "XYZ"
    )
  );
  const [px, py, pz] = transform.position;

  // Transform every vertex to world space, keep its (u, v, depth) components.
  const meshUV: Array<{ u: Float32Array; v: Float32Array; idx: Uint32Array }> =
    [];
  let minU = Infinity,
    minV = Infinity,
    maxU = -Infinity,
    maxV = -Infinity,
    minD = Infinity,
    maxD = -Infinity;
  const vec = new THREE.Vector3();

  for (const mesh of model.meshes) {
    const n = mesh.positions.length / 3;
    const u = new Float32Array(n);
    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      vec.set(
        mesh.positions[i * 3] - center[0],
        mesh.positions[i * 3 + 1] - center[1],
        mesh.positions[i * 3 + 2] - center[2]
      );
      vec.applyMatrix4(R);
      const wx = center[0] + px + vec.x;
      const wy = center[1] + py + vec.y;
      const wz = center[2] + pz + vec.z;
      const w = [wx, wy, wz] as const;
      const uu = w[ax.u];
      const vv = w[ax.v];
      const dd = w[ax.depth];
      u[i] = uu;
      v[i] = vv;
      if (uu < minU) minU = uu;
      if (uu > maxU) maxU = uu;
      if (vv < minV) minV = vv;
      if (vv > maxV) maxV = vv;
      if (dd < minD) minD = dd;
      if (dd > maxD) maxD = dd;
    }
    meshUV.push({ u, v, idx: mesh.indices });
  }

  const du = Math.max(1e-3, maxU - minU);
  const dv = Math.max(1e-3, maxV - minV);
  const maxExtent = Math.max(du, dv);
  const pad = Math.max(15, maxExtent * 0.35);
  // ~320 cells across the larger dimension → finer iso-contours (smoother walls
  // & cleaner booleans). The SDF/contour are computed only on extraction, so the
  // higher resolution is a one-time cost, not a per-frame one.
  let cell = maxExtent / 320;
  cell = Math.max(0.08, cell);
  const originU = minU - pad;
  const originV = minV - pad;
  let nu = Math.ceil((du + 2 * pad) / cell) + 1;
  let nv = Math.ceil((dv + 2 * pad) / cell) + 1;
  const CAP = 560;
  if (nu > CAP) {
    cell *= nu / CAP;
    nu = CAP;
    nv = Math.ceil((dv + 2 * pad) / cell) + 1;
  }
  if (nv > CAP) {
    cell *= nv / CAP;
    nv = CAP;
    nu = Math.ceil((du + 2 * pad) / cell) + 1;
  }

  // Rasterise projected triangles into an occupancy grid (cell-centre test).
  const occ = new Uint8Array(nu * nv);
  for (const md of meshUV) {
    const { u, v, idx } = md;
    for (let t = 0; t < idx.length; t += 3) {
      rasterTriangle(
        occ,
        nu,
        nv,
        originU,
        originV,
        cell,
        u[idx[t]],
        v[idx[t]],
        u[idx[t + 1]],
        v[idx[t + 1]],
        u[idx[t + 2]],
        v[idx[t + 2]]
      );
    }
  }

  const sdf = signedDistanceField(occ, nu, nv, cell);

  return {
    view,
    nu,
    nv,
    origin: [originU, originV],
    cell,
    sdf,
    uvMin: [minU, minV],
    uvMax: [maxU, maxV],
    depthAxis: ax.depth,
    depthBase: minD,
    depthSize: Math.max(0.1, maxD - minD),
    pad,
  };
}

/** Scan-convert a triangle, flagging every grid cell whose centre is inside. */
function rasterTriangle(
  occ: Uint8Array,
  nu: number,
  nv: number,
  ou: number,
  ov: number,
  cell: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number
) {
  const minX = Math.min(ax, bx, cx);
  const maxX = Math.max(ax, bx, cx);
  const minY = Math.min(ay, by, cy);
  const maxY = Math.max(ay, by, cy);
  let i0 = Math.floor((minX - ou) / cell);
  let i1 = Math.ceil((maxX - ou) / cell);
  let j0 = Math.floor((minY - ov) / cell);
  let j1 = Math.ceil((maxY - ov) / cell);
  if (i0 < 0) i0 = 0;
  if (j0 < 0) j0 = 0;
  if (i1 > nu - 1) i1 = nu - 1;
  if (j1 > nv - 1) j1 = nv - 1;

  const d = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
  if (Math.abs(d) < 1e-12) return;
  const inv = 1 / d;

  for (let j = j0; j <= j1; j++) {
    const py = ov + j * cell;
    for (let i = i0; i <= i1; i++) {
      const px = ou + i * cell;
      // Barycentric inside test.
      const w0 = ((bx - px) * (cy - py) - (cx - px) * (by - py)) * inv;
      const w1 = ((cx - px) * (ay - py) - (ax - px) * (cy - py)) * inv;
      const w2 = 1 - w0 - w1;
      if (w0 >= -1e-6 && w1 >= -1e-6 && w2 >= -1e-6) occ[j * nu + i] = 1;
    }
  }
}

// ── Exact Euclidean signed distance field (Felzenszwalb & Huttenlocher) ───────
const INF = 1e20;

function edt1d(f: Float64Array, n: number, out: Float64Array) {
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s =
      (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dq = q - v[k];
    out[q] = dq * dq + f[v[k]];
  }
}

/** Squared Euclidean distance (in cells) to the nearest cell where mask!=0. */
function edt2d(mask: Uint8Array, nu: number, nv: number): Float64Array {
  const g = new Float64Array(nu * nv);
  // Seed: 0 at feature cells, +INF elsewhere.
  for (let i = 0; i < g.length; i++) g[i] = mask[i] ? 0 : INF;
  // Columns.
  const col = new Float64Array(nv);
  const colOut = new Float64Array(nv);
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) col[j] = g[j * nu + i];
    edt1d(col, nv, colOut);
    for (let j = 0; j < nv; j++) g[j * nu + i] = colOut[j];
  }
  // Rows.
  const row = new Float64Array(nu);
  const rowOut = new Float64Array(nu);
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) row[i] = g[j * nu + i];
    edt1d(row, nu, rowOut);
    for (let i = 0; i < nu; i++) g[j * nu + i] = rowOut[i];
  }
  return g;
}

function signedDistanceField(
  occ: Uint8Array,
  nu: number,
  nv: number,
  cell: number
): Float32Array {
  const inside = occ; // mask of inside cells
  const outside = new Uint8Array(nu * nv);
  for (let i = 0; i < outside.length; i++) outside[i] = occ[i] ? 0 : 1;

  const distToInside = edt2d(inside, nu, nv); // valid for outside cells
  const distToOutside = edt2d(outside, nu, nv); // valid for inside cells

  const sdf = new Float32Array(nu * nv);
  for (let i = 0; i < sdf.length; i++) {
    sdf[i] = occ[i]
      ? -Math.sqrt(distToOutside[i]) * cell
      : Math.sqrt(distToInside[i]) * cell;
  }
  return sdf;
}

// ── Marching squares: iso-contour of the SDF at level `iso` (mm) ──────────────
// Returns closed loops of world-space (u, v) points.
export function contourAt(
  field: SilhouetteField,
  iso: number
): Array<Array<[number, number]>> {
  const { nu, nv, sdf, origin, cell } = field;
  const segs: Array<[string, number, number, string, number, number]> = [];

  const at = (i: number, j: number) => sdf[j * nu + i];
  // Interp helper returns [worldU, worldV].
  const lerp = (
    ia: number,
    ja: number,
    va: number,
    ib: number,
    jb: number,
    vb: number
  ): [number, number] => {
    let t = (iso - va) / (vb - va);
    if (!Number.isFinite(t)) t = 0.5;
    t = Math.max(0, Math.min(1, t));
    const gi = ia + (ib - ia) * t;
    const gj = ja + (jb - ja) * t;
    return [origin[0] + gi * cell, origin[1] + gj * cell];
  };

  for (let j = 0; j < nv - 1; j++) {
    for (let i = 0; i < nu - 1; i++) {
      const bl = at(i, j),
        br = at(i + 1, j),
        tr = at(i + 1, j + 1),
        tl = at(i, j + 1);
      // Edge crossings (inside = value < iso).
      const cross: Record<string, [string, number, number] | null> = {
        B: null,
        R: null,
        T: null,
        L: null,
      };
      if (bl < iso !== br < iso) {
        const [x, y] = lerp(i, j, bl, i + 1, j, br);
        cross.B = [`h:${i}:${j}`, x, y];
      }
      if (br < iso !== tr < iso) {
        const [x, y] = lerp(i + 1, j, br, i + 1, j + 1, tr);
        cross.R = [`v:${i + 1}:${j}`, x, y];
      }
      if (tl < iso !== tr < iso) {
        const [x, y] = lerp(i, j + 1, tl, i + 1, j + 1, tr);
        cross.T = [`h:${i}:${j + 1}`, x, y];
      }
      if (bl < iso !== tl < iso) {
        const [x, y] = lerp(i, j, bl, i, j + 1, tl);
        cross.L = [`v:${i}:${j}`, x, y];
      }
      const present = (["B", "R", "T", "L"] as const).filter(
        (k) => cross[k]
      );
      const emit = (a: string, b: string) => {
        const ea = cross[a]!;
        const eb = cross[b]!;
        segs.push([ea[0], ea[1], ea[2], eb[0], eb[1], eb[2]]);
      };
      if (present.length === 2) {
        emit(present[0], present[1]);
      } else if (present.length === 4) {
        // Saddle: resolve with the cell-centre average.
        const c = (bl + br + tr + tl) / 4;
        const cIn = c < iso;
        if (bl < iso) {
          // bl & tr inside
          if (cIn) {
            emit("B", "R");
            emit("T", "L");
          } else {
            emit("B", "L");
            emit("R", "T");
          }
        } else {
          // br & tl inside
          if (cIn) {
            emit("B", "L");
            emit("R", "T");
          } else {
            emit("B", "R");
            emit("T", "L");
          }
        }
      }
    }
  }

  return stitchLoops(segs);
}

/** Stitch marching-squares segments (keyed by shared edge ids) into loops. */
function stitchLoops(
  segs: Array<[string, number, number, string, number, number]>
): Array<Array<[number, number]>> {
  // Adjacency: edge-id node -> list of {seg index, other id}.
  const adj = new Map<string, Array<{ s: number; other: string }>>();
  const pos = new Map<string, [number, number]>();
  segs.forEach((sg, s) => {
    const [ia, xa, ya, ib, xb, yb] = sg;
    pos.set(ia, [xa, ya]);
    pos.set(ib, [xb, yb]);
    (adj.get(ia) ?? adj.set(ia, []).get(ia)!).push({ s, other: ib });
    (adj.get(ib) ?? adj.set(ib, []).get(ib)!).push({ s, other: ia });
  });

  const usedSeg = new Uint8Array(segs.length);
  const loops: Array<Array<[number, number]>> = [];

  const nextFrom = (id: string): { s: number; other: string } | null => {
    const list = adj.get(id);
    if (!list) return null;
    for (const e of list) if (!usedSeg[e.s]) return e;
    return null;
  };

  for (let start = 0; start < segs.length; start++) {
    if (usedSeg[start]) continue;
    const [ia] = segs[start];
    const loop: Array<[number, number]> = [];
    let curId = ia;
    let guard = 0;
    const maxGuard = segs.length * 2 + 10;
    while (guard++ < maxGuard) {
      const e = nextFrom(curId);
      if (!e) break;
      usedSeg[e.s] = 1;
      const p = pos.get(curId)!;
      loop.push([p[0], p[1]]);
      curId = e.other;
      if (curId === ia) break; // closed
    }
    if (loop.length >= 3) loops.push(simplify(loop, 1e9));
  }
  return loops;
}

/** Douglas–Peucker simplification of a closed loop (epsilon in mm). */
function simplify(
  loop: Array<[number, number]>,
  _epsAuto: number
): Array<[number, number]> {
  // Auto epsilon from loop scale.
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const [x, y] of loop) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  // Light simplification only — keep enough contour fidelity for smooth walls.
  const eps = Math.max(0.02, Math.max(maxX - minX, maxY - minY) * 0.0008);

  const keep = new Uint8Array(loop.length);
  keep[0] = 1;
  keep[loop.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, loop.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let dmax = 0;
    let idx = -1;
    const [ax, ay] = loop[a];
    const [bx, by] = loop[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    for (let k = a + 1; k < b; k++) {
      const [px, py] = loop[k];
      const dist = Math.abs((px - ax) * dy - (py - ay) * dx) / len;
      if (dist > dmax) {
        dmax = dist;
        idx = k;
      }
    }
    if (dmax > eps && idx > -1) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  const out: Array<[number, number]> = [];
  for (let i = 0; i < loop.length; i++) if (keep[i]) out.push(loop[i]);
  return out;
}

function signedArea(loop: Array<[number, number]>): number {
  let a = 0;
  for (let i = 0; i < loop.length; i++) {
    const [x0, y0] = loop[i];
    const [x1, y1] = loop[(i + 1) % loop.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

/** Even-odd point-in-polygon test (ray cast). */
function pointInPoly(p: [number, number], poly: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0],
      yi = poly[i][1];
    const xj = poly[j][0],
      yj = poly[j][1];
    if (
      yi > p[1] !== yj > p[1] &&
      p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi
    )
      inside = !inside;
  }
  return inside;
}

/**
 * Keep only TOP-LEVEL outer boundary loops, dropping holes (any loop nested
 * inside a larger one). An imported part's internal openings — e.g. a drone
 * frame's lattice windows or motor-mount bores — show up as hole loops in the
 * iso-contour; for an insert-foam pocket we want the FILLED outer profile, so
 * those interior loops are discarded. Disconnected outer parts are all kept.
 */
export function outerLoopsOnly(
  loops: Array<Array<[number, number]>>
): Array<Array<[number, number]>> {
  if (loops.length <= 1) return loops;
  const areas = loops.map((l) => Math.abs(signedArea(l)));
  const keep: Array<Array<[number, number]>> = [];
  for (let i = 0; i < loops.length; i++) {
    const probe = loops[i][0];
    let nested = false;
    for (let j = 0; j < loops.length; j++) {
      if (i === j || areas[j] <= areas[i]) continue; // only a bigger loop can enclose i
      if (pointInPoly(probe, loops[j])) {
        nested = true;
        break;
      }
    }
    if (!nested) keep.push(loops[i]);
  }
  return keep.length ? keep : loops;
}

// ── Build an extruded (optionally drafted) solid from the offset outline ──────
//
// The base face is the silhouette at `offset`. With a draft angle the top face
// is the silhouette at a *different* iso-level (offset − tan(angle)·depth), so
// the wall is the linear loft between the two real silhouette contours — the
// draft therefore follows the true outline at every height, not a radial scale.
// Internal holes are ignored (outer profile only) so the insert-foam solid is a
// filled block, not one pierced by the product's openings.
export function buildExtrudeMesh(
  sil: ModelSilhouette,
  color: [number, number, number] = [0.3, 0.55, 1]
): ImportedMesh | null {
  const field = sil.field;
  const view = sil.view;
  const base = field.depthBase;
  const top = base + sil.extrudeDepth;

  // Top iso-level from the draft angle, clamped so the top never fully vanishes
  // (or exceeds the grid margin for a flaring draft).
  const inset = Math.tan((sil.draftDeg * Math.PI) / 180) * sil.extrudeDepth;
  let topIso = sil.offset - inset;
  let mn = Infinity;
  for (let i = 0; i < field.sdf.length; i++)
    if (field.sdf[i] < mn) mn = field.sdf[i];
  const minIso = mn + field.cell; // most-inset usable level
  if (topIso < minIso) topIso = minIso;
  if (topIso > field.pad) topIso = field.pad;

  const baseLoops = outerLoopsOnly(contourAt(field, sil.offset));
  if (!baseLoops.length) return null;
  const topLoops = outerLoopsOnly(contourAt(field, topIso));

  const positions: number[] = [];
  const indices: number[] = [];
  const addVert = (uv: [number, number], depth: number): number => {
    const w = uvToWorld(uv[0], uv[1], depth, view);
    positions.push(w[0], w[1], w[2]);
    return positions.length / 3 - 1;
  };

  // Resample resolution for ring loops — shared by caps and walls. Higher = more
  // wall facets → smoother curved surfaces and cleaner boolean cuts in Step 3.
  const M = 220;

  // Caps: triangulate each ring (outer + its holes). The rings are resampled to
  // the SAME M points the walls use, so the cap boundary and the wall rings have
  // identical vertices — once welded the solid is a watertight manifold, which
  // is what lets the boolean (CSG) produce clean cuts instead of torn slivers.
  const cap = (loops: Array<Array<[number, number]>>, depth: number, up: boolean) => {
    if (!loops.length) return;
    const ranked = loops
      .map((l) => ({ l, a: signedArea(l) }))
      .sort((p, q) => Math.abs(q.a) - Math.abs(p.a));
    // resampleAlign returns CCW; keep outer CCW, flip holes to CW for triangulation.
    const outer = resampleAlign(ranked[0].l, M);
    const holes = ranked.slice(1).map((h) => {
      const r = resampleAlign(h.l, M);
      return signedArea(r) > 0 ? r.slice().reverse() : r;
    });
    const flat = [outer, ...holes].flat();
    const start = positions.length / 3;
    for (const p of flat) addVert(p, depth);
    const tris = THREE.ShapeUtils.triangulateShape(
      outer.map((p) => new THREE.Vector2(p[0], p[1])),
      holes.map((h) => h.map((p) => new THREE.Vector2(p[0], p[1])))
    );
    for (const t of tris) {
      if (up) indices.push(start + t[0], start + t[1], start + t[2]);
      else indices.push(start + t[0], start + t[2], start + t[1]);
    }
  };
  cap(baseLoops, base, false);
  cap(topLoops, top, true);

  // Walls: loft matched base→top loops (resampled + angle-aligned to avoid twist).
  const baseMatch = matchLoops(baseLoops);
  const topMatch = matchLoops(topLoops);
  const usedTop = new Set<number>();

  const buildWall = (
    bLoop: Array<[number, number]>,
    tLoop: Array<[number, number]>
  ) => {
    const rb = resampleAlign(bLoop, M);
    const rt = resampleAlign(tLoop, M);
    const bStart = positions.length / 3;
    for (const p of rb) addVert(p, base);
    const tStart = positions.length / 3;
    for (const p of rt) addVert(p, top);
    for (let i = 0; i < M; i++) {
      const a = bStart + i;
      const b = bStart + ((i + 1) % M);
      const c = tStart + i;
      const d = tStart + ((i + 1) % M);
      indices.push(a, b, c, b, d, c);
    }
  };

  // Outer↔outer always loft.
  if (baseMatch.outer && topMatch.outer) buildWall(baseMatch.outer, topMatch.outer);

  // Holes: pair by nearest centroid; unmatched holes close to an apex.
  for (const bh of baseMatch.holes) {
    let best = -1;
    let bestD = Infinity;
    topMatch.holes.forEach((th, k) => {
      if (usedTop.has(k)) return;
      const d = dist2(centroid(bh), centroid(th));
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    });
    if (best >= 0) {
      usedTop.add(best);
      buildWall(bh, topMatch.holes[best]);
    } else {
      apexClose(bh, base, top, view, positions, indices, M); // hole closed by draft
    }
  }
  topMatch.holes.forEach((th, k) => {
    if (!usedTop.has(k)) apexClose(th, top, base, view, positions, indices, M);
  });

  return {
    name: "silhouette-extrude",
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    color,
  };
}

/** The drafted top iso-level for a silhouette (matches buildExtrudeMesh). */
function draftTopIso(sil: ModelSilhouette): number {
  const field = sil.field;
  const inset = Math.tan((sil.draftDeg * Math.PI) / 180) * sil.extrudeDepth;
  let topIso = sil.offset - inset;
  let mn = Infinity;
  for (let i = 0; i < field.sdf.length; i++)
    if (field.sdf[i] < mn) mn = field.sdf[i];
  const minIso = mn + field.cell;
  if (topIso < minIso) topIso = minIso;
  if (topIso > field.pad) topIso = field.pad;
  return topIso;
}

/**
 * Base + top OUTER rings (arc-length resampled to M points and angle-aligned so
 * they correspond, exactly like buildExtrudeMesh's walls) as world-space XYZ.
 * Used to build a smooth B-spline-lofted solid in the OpenCascade NURBS export.
 * Returns null if the silhouette has no outer contour.
 */
export function extrudeOuterRings(
  sil: ModelSilhouette,
  M = 80
): {
  base: Array<[number, number, number]>;
  top: Array<[number, number, number]>;
} | null {
  const field = sil.field;
  const view = sil.view;
  const baseDepth = field.depthBase;
  const topDepth = baseDepth + sil.extrudeDepth;
  const baseLoops = contourAt(field, sil.offset);
  if (!baseLoops.length) return null;
  const topLoops = contourAt(field, draftTopIso(sil));
  const bM = matchLoops(baseLoops);
  const tM = matchLoops(topLoops);
  if (!bM.outer || !tM.outer) return null;
  const rb = resampleAlign(bM.outer, M);
  const rt = resampleAlign(tM.outer, M);
  return {
    base: rb.map((p) => uvToWorld(p[0], p[1], baseDepth, view)),
    top: rt.map((p) => uvToWorld(p[0], p[1], topDepth, view)),
  };
}

/**
 * The base (bottom) and top cap-rim loops of the extruded solid, as world-space
 * XYZ point loops. These are exactly the horizontal boundary outlines of the
 * solid — used to draw a clean top/bottom outline without the wall edges.
 */
export function extrudeCapLoops(sil: ModelSilhouette): {
  base: Array<Array<[number, number, number]>>;
  top: Array<Array<[number, number, number]>>;
} {
  const field = sil.field;
  const view = sil.view;
  const baseDepth = field.depthBase;
  const topDepth = baseDepth + sil.extrudeDepth;
  const toWorld = (
    loops: Array<Array<[number, number]>>,
    depth: number
  ): Array<Array<[number, number, number]>> =>
    loops.map((l) => l.map((p) => uvToWorld(p[0], p[1], depth, view)));
  return {
    base: toWorld(outerLoopsOnly(contourAt(field, sil.offset)), baseDepth),
    top: toWorld(outerLoopsOnly(contourAt(field, draftTopIso(sil))), topDepth),
  };
}

function matchLoops(loops: Array<Array<[number, number]>>): {
  outer: Array<[number, number]> | null;
  holes: Array<Array<[number, number]>>;
} {
  if (!loops.length) return { outer: null, holes: [] };
  const ranked = loops
    .map((l) => ({ l, a: Math.abs(signedArea(l)) }))
    .sort((p, q) => q.a - p.a);
  return { outer: ranked[0].l, holes: ranked.slice(1).map((r) => r.l) };
}

function centroid(loop: Array<[number, number]>): [number, number] {
  let x = 0,
    y = 0;
  for (const p of loop) {
    x += p[0];
    y += p[1];
  }
  return [x / loop.length, y / loop.length];
}

function dist2(a: [number, number], b: [number, number]): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
}

/**
 * In-place binomial smoothing of a CLOSED, uniformly-spaced loop: each point is
 * pulled a little toward the average of its neighbours (new = ¼·prev + ½·cur +
 * ¼·next). The marching-squares contour is stair-stepped and the offset can
 * leave sub-mm crinkle on tight roundings; a couple of passes over the
 * arc-length-resampled ring irons that out so the lofted wall reads as a smooth
 * curve instead of a faceted/jagged one. The inward pull is a fraction of the
 * point spacing — visually negligible on the cavity.
 */
function smoothClosed(
  pts: Array<[number, number]>,
  passes: number
): Array<[number, number]> {
  const n = pts.length;
  if (n < 5) return pts;
  let cur = pts;
  for (let pass = 0; pass < passes; pass++) {
    const next: Array<[number, number]> = new Array(n);
    for (let i = 0; i < n; i++) {
      const a = cur[(i - 1 + n) % n];
      const b = cur[i];
      const c = cur[(i + 1) % n];
      next[i] = [
        0.25 * a[0] + 0.5 * b[0] + 0.25 * c[0],
        0.25 * a[1] + 0.5 * b[1] + 0.25 * c[1],
      ];
    }
    cur = next;
  }
  return cur;
}

/** Arc-length resample a closed loop to M points, CCW, aligned by start angle. */
function resampleAlign(
  loop: Array<[number, number]>,
  M: number
): Array<[number, number]> {
  let src = signedArea(loop) < 0 ? loop.slice().reverse() : loop.slice();
  const n = src.length;
  const seg: number[] = [];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const a = src[i];
    const b = src[(i + 1) % n];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    seg.push(d);
    total += d;
  }
  const out: Array<[number, number]> = [];
  if (total < 1e-9) {
    for (let k = 0; k < M; k++) out.push([src[0][0], src[0][1]]);
    return out;
  }
  const step = total / M;
  let i = 0;
  let acc = 0;
  for (let k = 0; k < M; k++) {
    const dpos = k * step;
    while (i < n - 1 && acc + seg[i] < dpos) {
      acc += seg[i];
      i++;
    }
    const t = seg[i] > 1e-9 ? (dpos - acc) / seg[i] : 0;
    const a = src[i];
    const b = src[(i + 1) % n];
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  // Smooth out marching-squares stair-steps now that points are evenly spaced,
  // so the lofted wall is a clean curve (kills the crinkle on tight roundings).
  const smoothed = smoothClosed(out, 2);
  // Rotate so the point nearest angle 0 (from centroid) is first → no twist.
  const c = centroid(smoothed);
  let best = 0;
  let bestA = Infinity;
  for (let k = 0; k < smoothed.length; k++) {
    const a = Math.abs(Math.atan2(smoothed[k][1] - c[1], smoothed[k][0] - c[0]));
    if (a < bestA) {
      bestA = a;
      best = k;
    }
  }
  return smoothed.slice(best).concat(smoothed.slice(0, best));
}

/** Close an unmatched hole loop to an apex point on the opposite face. */
function apexClose(
  loop: Array<[number, number]>,
  ringDepth: number,
  apexDepth: number,
  view: ViewName,
  positions: number[],
  indices: number[],
  M: number
) {
  const ring = resampleAlign(loop, M);
  const ringStart = positions.length / 3;
  for (const p of ring) {
    const w = uvToWorld(p[0], p[1], ringDepth, view);
    positions.push(w[0], w[1], w[2]);
  }
  const c = centroid(loop);
  const wa = uvToWorld(c[0], c[1], apexDepth, view);
  positions.push(wa[0], wa[1], wa[2]);
  const apex = positions.length / 3 - 1;
  for (let i = 0; i < M; i++) {
    indices.push(ringStart + i, ringStart + ((i + 1) % M), apex);
  }
}

/** World-space axis-aligned bounding box of a silhouette's extruded solid. */
export function extrudeAABB(
  sil: ModelSilhouette
): { min: [number, number, number]; max: [number, number, number] } | null {
  const mesh = buildExtrudeMesh(sil);
  if (!mesh) return null;
  const p = mesh.positions;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = p[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}

/** Box placement (XZ centre + base Y) framing one or more extruded solids. */
export function solidsPlacement(
  sils: ModelSilhouette[]
): { cx: number; cz: number; baseY: number } | null {
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxZ = -Infinity;
  let any = false;
  for (const s of sils) {
    const b = extrudeAABB(s);
    if (!b) continue;
    any = true;
    minX = Math.min(minX, b.min[0]);
    maxX = Math.max(maxX, b.max[0]);
    minZ = Math.min(minZ, b.min[2]);
    maxZ = Math.max(maxZ, b.max[2]);
    minY = Math.min(minY, b.min[1]);
  }
  if (!any) return null;
  return { cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2, baseY: minY };
}

/** Legacy Silhouette (for steps 3/4 continuity) from the offset-0 outline. */
export function toLegacySilhouette(field: SilhouetteField): Silhouette {
  const loops = contourAt(field, 0);
  const ranked = loops
    .map((l) => ({ l, a: Math.abs(signedArea(l)) }))
    .sort((p, q) => q.a - p.a);
  const outer = ranked.length ? ranked[0].l : [];
  return {
    view: field.view,
    loops: outer.length ? [outer] : [],
    bbox: { min: [...field.uvMin], max: [...field.uvMax] },
  };
}
