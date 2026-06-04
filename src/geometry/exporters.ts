import type { ImportedMesh } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Step 12 — export the insert foam mesh to 3D formats.
//   STL (ascii) and OBJ are written straight from the triangle data.
//   FBX is written as ASCII FBX 7.4 (mesh + per-corner normals).
//   STEP is written as a faceted MANIFOLD_SOLID_BREP (AP214): one planar
//   ADVANCED_FACE per triangle over a shared vertex/edge topology, so CAD tools
//   open it as a real solid. No B-rep kernel needed — the cut surfaces are
//   already a clean triangle mesh.
// ─────────────────────────────────────────────────────────────────────────────

export type MeshFormat = "stl" | "obj" | "step" | "fbx";

export function exportMesh(mesh: ImportedMesh, format: MeshFormat): Blob {
  switch (format) {
    case "stl":
      return new Blob([meshToAsciiStl(mesh)], { type: "model/stl" });
    case "obj":
      return new Blob([meshToObj(mesh)], { type: "text/plain" });
    case "step":
      return new Blob([meshToStep(mesh)], { type: "application/step" });
    case "fbx":
      return new Blob([meshToFbxAscii(mesh)], { type: "text/plain" });
  }
}

function meshToAsciiStl(mesh: ImportedMesh): string {
  const { positions, indices } = mesh;
  const out: string[] = ["solid package01"];
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3,
      b = indices[i + 1] * 3,
      c = indices[i + 2] * 3;
    const [nx, ny, nz] = faceNormal(positions, a, b, c);
    out.push(`facet normal ${nx} ${ny} ${nz}`);
    out.push("  outer loop");
    out.push(`    vertex ${positions[a]} ${positions[a + 1]} ${positions[a + 2]}`);
    out.push(`    vertex ${positions[b]} ${positions[b + 1]} ${positions[b + 2]}`);
    out.push(`    vertex ${positions[c]} ${positions[c + 1]} ${positions[c + 2]}`);
    out.push("  endloop");
    out.push("endfacet");
  }
  out.push("endsolid package01");
  return out.join("\n");
}

function meshToObj(mesh: ImportedMesh): string {
  const { positions, indices } = mesh;
  const out: string[] = ["# Package 01 insert foam"];
  for (let i = 0; i < positions.length; i += 3) {
    out.push(`v ${positions[i]} ${positions[i + 1]} ${positions[i + 2]}`);
  }
  for (let i = 0; i < indices.length; i += 3) {
    out.push(`f ${indices[i] + 1} ${indices[i + 1] + 1} ${indices[i + 2] + 1}`);
  }
  return out.join("\n");
}

function faceNormal(
  p: Float32Array,
  a: number,
  b: number,
  c: number
): [number, number, number] {
  const ux = p[b] - p[a],
    uy = p[b + 1] - p[a + 1],
    uz = p[b + 2] - p[a + 2];
  const vx = p[c] - p[a],
    vy = p[c + 1] - p[a + 1],
    vz = p[c + 2] - p[a + 2];
  const nx = uy * vz - uz * vy,
    ny = uz * vx - ux * vz,
    nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

// ── FBX (ASCII 7.4) ───────────────────────────────────────────────────────────
// A minimal but complete ASCII FBX: one Mesh geometry with per-polygon-vertex
// normals, one Model, and their connections. Opens in Autodesk apps, Unity,
// Unreal, FBX Review, etc. (For Blender — which favours binary FBX — OBJ/STL are
// the safer mesh path.)
function meshToFbxAscii(mesh: ImportedMesh): string {
  const { positions, indices } = mesh;
  const normals = mesh.normals;

  // Vertices: unique positions; PolygonVertexIndex references them (last index
  // of each triangle is bit-negated to mark the polygon end, per FBX).
  const verts: number[] = [];
  for (let i = 0; i < positions.length; i++) verts.push(positions[i]);

  const polyIdx: number[] = [];
  const norm: number[] = [];
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i],
      b = indices[i + 1],
      c = indices[i + 2];
    polyIdx.push(a, b, ~c); // ~c === -(c+1): marks end of polygon
    for (const v of [a, b, c]) {
      if (normals) {
        norm.push(normals[v * 3], normals[v * 3 + 1], normals[v * 3 + 2]);
      } else {
        const [nx, ny, nz] = faceNormal(positions, a * 3, b * 3, c * 3);
        norm.push(nx, ny, nz);
      }
    }
  }

  const arr = (nums: number[]) => nums.join(",");
  const GEO = 1000000;
  const MODEL = 2000000;

  return `; FBX 7.4.0 project file
; Created by Package 01
; ----------------------------------------------------

FBXHeaderExtension:  {
\tFBXHeaderVersion: 1003
\tFBXVersion: 7400
\tCreator: "Package 01"
}
GlobalSettings:  {
\tVersion: 1000
\tProperties70:  {
\t\tP: "UpAxis", "int", "Integer", "",1
\t\tP: "UpAxisSign", "int", "Integer", "",1
\t\tP: "FrontAxis", "int", "Integer", "",2
\t\tP: "FrontAxisSign", "int", "Integer", "",1
\t\tP: "CoordAxis", "int", "Integer", "",0
\t\tP: "CoordAxisSign", "int", "Integer", "",1
\t\tP: "UnitScaleFactor", "double", "Number", "",1
\t}
}
Definitions:  {
\tVersion: 100
\tCount: 3
\tObjectType: "GlobalSettings" {
\t\tCount: 1
\t}
\tObjectType: "Geometry" {
\t\tCount: 1
\t}
\tObjectType: "Model" {
\t\tCount: 1
\t}
}
Objects:  {
\tGeometry: ${GEO}, "Geometry::insert", "Mesh" {
\t\tVertices: *${verts.length} {
\t\t\ta: ${arr(verts)}
\t\t}
\t\tPolygonVertexIndex: *${polyIdx.length} {
\t\t\ta: ${arr(polyIdx)}
\t\t}
\t\tGeometryVersion: 124
\t\tLayerElementNormal: 0 {
\t\t\tVersion: 101
\t\t\tName: ""
\t\t\tMappingInformationType: "ByPolygonVertex"
\t\t\tReferenceInformationType: "Direct"
\t\t\tNormals: *${norm.length} {
\t\t\t\ta: ${arr(norm)}
\t\t\t}
\t\t}
\t\tLayer: 0 {
\t\t\tVersion: 100
\t\t\tLayerElement:  {
\t\t\t\tType: "LayerElementNormal"
\t\t\t\tTypedIndex: 0
\t\t\t}
\t\t}
\t}
\tModel: ${MODEL}, "Model::insert", "Mesh" {
\t\tVersion: 232
\t\tProperties70:  {
\t\t\tP: "Lcl Scaling", "Lcl Scaling", "", "A",1,1,1
\t\t}
\t\tShading: T
\t\tCulling: "CullingOff"
\t}
}
Connections:  {
\tC: "OO", ${MODEL}, 0
\tC: "OO", ${GEO}, ${MODEL}
}
`;
}

// ── STEP (AP214 faceted MANIFOLD_SOLID_BREP) ───────────────────────────────────
function meshToStep(mesh: ImportedMesh): string {
  const { positions, indices } = mesh;

  // 1) Weld vertices by quantisation so faces share verts/edges (a valid closed
  //    shell needs each edge shared by two faces). 1e-4 mm tolerance.
  const Q = 1e4; // 0.0001 mm grid
  const keyOf = (x: number, y: number, z: number) =>
    `${Math.round(x * Q)}_${Math.round(y * Q)}_${Math.round(z * Q)}`;
  const vmap = new Map<string, number>();
  const vx: number[] = [];
  const vidx = (i: number): number => {
    const x = positions[i * 3],
      y = positions[i * 3 + 1],
      z = positions[i * 3 + 2];
    const k = keyOf(x, y, z);
    let id = vmap.get(k);
    if (id === undefined) {
      id = vx.length / 3;
      vx.push(x, y, z);
      vmap.set(k, id);
    }
    return id;
  };

  // Triangles over welded vertex ids; drop any that became degenerate.
  const tris: Array<[number, number, number]> = [];
  for (let i = 0; i < indices.length; i += 3) {
    const a = vidx(indices[i]),
      b = vidx(indices[i + 1]),
      c = vidx(indices[i + 2]);
    if (a !== b && b !== c && c !== a) tris.push([a, b, c]);
  }

  // 2) Shared edges: canonical (min,max) → edge record.
  type EdgeRec = { id: number; lo: number; hi: number };
  const emap = new Map<string, EdgeRec>();
  const edges: EdgeRec[] = [];
  const edgeOf = (u: number, v: number): EdgeRec => {
    const lo = Math.min(u, v),
      hi = Math.max(u, v);
    const k = `${lo}_${hi}`;
    let e = emap.get(k);
    if (!e) {
      e = { id: edges.length, lo, hi };
      emap.set(k, e);
      edges.push(e);
    }
    return e;
  };
  for (const [a, b, c] of tris) {
    edgeOf(a, b);
    edgeOf(b, c);
    edgeOf(c, a);
  }

  // 3) Emit entities. Build the string with a running id counter.
  let id = 0;
  const L: string[] = [];
  const next = () => ++id;
  const e = (s: string): number => {
    const n = next();
    L.push(`#${n}=${s};`);
    return n;
  };

  const fmt = (v: number) => {
    if (!isFinite(v)) return "0.";
    let s = v.toPrecision(12);
    if (!/[.eE]/.test(s)) s += ".";
    return s;
  };

  // CARTESIAN_POINT + VERTEX_POINT per welded vertex.
  const cpId: number[] = [];
  const vpId: number[] = [];
  for (let i = 0; i < vx.length; i += 3) {
    const cp = e(
      `CARTESIAN_POINT('',(${fmt(vx[i])},${fmt(vx[i + 1])},${fmt(vx[i + 2])}))`
    );
    cpId.push(cp);
    vpId.push(e(`VERTEX_POINT('',#${cp})`));
  }

  // EDGE_CURVE per shared edge (LINE from lo toward hi).
  const ecId: number[] = [];
  for (const ed of edges) {
    const ax = vx[ed.lo * 3],
      ay = vx[ed.lo * 3 + 1],
      az = vx[ed.lo * 3 + 2];
    const bx = vx[ed.hi * 3],
      by = vx[ed.hi * 3 + 1],
      bz = vx[ed.hi * 3 + 2];
    let dx = bx - ax,
      dy = by - ay,
      dz = bz - az;
    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len;
    dy /= len;
    dz /= len;
    const dir = e(`DIRECTION('',(${fmt(dx)},${fmt(dy)},${fmt(dz)}))`);
    const vec = e(`VECTOR('',#${dir},${fmt(len)})`);
    const line = e(`LINE('',#${cpId[ed.lo]},#${vec})`);
    ecId.push(
      e(`EDGE_CURVE('',#${vpId[ed.lo]},#${vpId[ed.hi]},#${line},.T.)`)
    );
  }

  // Merge coplanar triangles into planar REGIONS, then emit one ADVANCED_FACE per
  // region (a single clean planar face with its real outline + holes), instead of
  // one face per triangle. Flat faces (box outer, cavity floors, straight walls)
  // become a single face each; only genuinely curved strips stay faceted.
  const triCount = tris.length;
  const triEdges: number[][] = [];
  const edgeTris = new Map<number, number[]>();
  const triN: Array<[number, number, number]> = [];
  const triD: number[] = [];
  for (let ti = 0; ti < triCount; ti++) {
    const [a, b, c] = tris[ti];
    const es = [edgeOf(a, b).id, edgeOf(b, c).id, edgeOf(c, a).id];
    triEdges.push(es);
    for (const eid of es) {
      let arr = edgeTris.get(eid);
      if (!arr) edgeTris.set(eid, (arr = []));
      arr.push(ti);
    }
    const ax = vx[a * 3], ay = vx[a * 3 + 1], az = vx[a * 3 + 2];
    const bx = vx[b * 3], by = vx[b * 3 + 1], bz = vx[b * 3 + 2];
    const cx = vx[c * 3], cy = vx[c * 3 + 1], cz = vx[c * 3 + 2];
    let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    triN.push([nx, ny, nz]);
    triD.push(nx * ax + ny * ay + nz * az);
  }
  // Flood-fill coplanar regions (compared to the SEED plane to avoid curvature drift).
  const region = new Int32Array(triCount).fill(-1);
  const regRep: number[] = [];
  const COS = Math.cos((0.5 * Math.PI) / 180); // within 0.5°
  const DTOL = 5e-3; // mm
  for (let s = 0; s < triCount; s++) {
    if (region[s] >= 0) continue;
    const rid = regRep.length;
    regRep.push(s);
    region[s] = rid;
    const sn = triN[s], sd = triD[s];
    const stack = [s];
    while (stack.length) {
      const ti = stack.pop()!;
      for (const eid of triEdges[ti]) {
        for (const tj of edgeTris.get(eid)!) {
          if (region[tj] >= 0) continue;
          const nj = triN[tj];
          if (sn[0] * nj[0] + sn[1] * nj[1] + sn[2] * nj[2] > COS &&
              Math.abs(triD[tj] - sd) < DTOL) {
            region[tj] = rid;
            stack.push(tj);
          }
        }
      }
    }
  }
  // Oriented boundary half-edges per region (triangle winding gives outer CCW / holes CW).
  const regHE: Array<Array<[number, number]>> = regRep.map(() => []);
  for (let ti = 0; ti < triCount; ti++) {
    const r = region[ti];
    const [a, b, c] = tris[ti];
    const corners: Array<[number, number]> = [[a, b], [b, c], [c, a]];
    for (const [u, v] of corners) {
      const eid = edgeOf(u, v).id;
      let otherInR = false;
      for (const tj of edgeTris.get(eid)!) if (tj !== ti && region[tj] === r) otherInR = true;
      if (!otherInR) regHE[r].push([u, v]);
    }
  }
  const chainLoops = (hes: Array<[number, number]>): Array<Array<[number, number]>> => {
    const byStart = new Map<number, Array<[number, number]>>();
    for (const he of hes) {
      let a = byStart.get(he[0]);
      if (!a) byStart.set(he[0], (a = []));
      a.push(he);
    }
    const used = new Set<[number, number]>();
    const loops: Array<Array<[number, number]>> = [];
    for (const start of hes) {
      if (used.has(start)) continue;
      const loop: Array<[number, number]> = [];
      let cur: [number, number] | undefined = start;
      let guard = 0;
      while (cur && !used.has(cur) && guard++ < hes.length + 8) {
        used.add(cur);
        loop.push(cur);
        const nexts = byStart.get(cur[1]);
        let nx: [number, number] | undefined;
        if (nexts) for (const e2 of nexts) if (!used.has(e2)) { nx = e2; break; }
        cur = nx;
      }
      if (loop.length >= 3) loops.push(loop);
    }
    return loops;
  };

  const faceIds: number[] = [];
  for (let r = 0; r < regRep.length; r++) {
    const loops = chainLoops(regHE[r]);
    if (!loops.length) continue;
    // Plane basis from the region's seed normal; ref dir = first outer edge.
    const [nx, ny, nz] = triN[regRep[r]];
    // 2D projection basis (rDir, n×rDir) to measure signed loop areas.
    let rx0 = Math.abs(nx) < 0.9 ? 1 : 0, ry0 = Math.abs(nx) < 0.9 ? 0 : 1, rz0 = 0;
    // make rDir orthogonal to n
    let dot = rx0 * nx + ry0 * ny + rz0 * nz;
    rx0 -= dot * nx; ry0 -= dot * ny; rz0 -= dot * nz;
    let rl0 = Math.hypot(rx0, ry0, rz0) || 1;
    rx0 /= rl0; ry0 /= rl0; rz0 /= rl0;
    const sx = ny * rz0 - nz * ry0, sy = nz * rx0 - nx * rz0, sz = nx * ry0 - ny * rx0;
    const loopArea = (loop: Array<[number, number]>): number => {
      let area = 0;
      for (const [u, v] of loop) {
        const ux = vx[u * 3], uy = vx[u * 3 + 1], uz = vx[u * 3 + 2];
        const vX = vx[v * 3], vY = vx[v * 3 + 1], vZ = vx[v * 3 + 2];
        const a2 = ux * rx0 + uy * ry0 + uz * rz0, b2 = ux * sx + uy * sy + uz * sz;
        const c2 = vX * rx0 + vY * ry0 + vZ * rz0, d2 = vX * sx + vY * sy + vZ * sz;
        area += a2 * d2 - c2 * b2;
      }
      return area / 2;
    };
    // Largest |area| loop is the outer boundary; the rest are holes.
    let outer = 0, outerA = -1;
    loops.forEach((l, i) => { const a = Math.abs(loopArea(l)); if (a > outerA) { outerA = a; outer = i; } });

    const emitLoop = (loop: Array<[number, number]>): number => {
      const oeIds: number[] = [];
      for (const [u, v] of loop) {
        const ed = edgeOf(u, v);
        const orient = u === ed.lo ? ".T." : ".F.";
        oeIds.push(e(`ORIENTED_EDGE('',*,*,#${ecId[ed.id]},${orient})`));
      }
      return e(`EDGE_LOOP('',(${oeIds.map((n) => `#${n}`).join(",")}))`);
    };

    const bounds: number[] = [];
    loops.forEach((l, i) => {
      const lp = emitLoop(l);
      bounds.push(
        i === outer
          ? e(`FACE_OUTER_BOUND('',#${lp},.T.)`)
          : e(`FACE_BOUND('',#${lp},.T.)`)
      );
    });

    // Plane placement: origin = first vertex of the outer loop.
    const o = loops[outer][0][0];
    const nDir = e(`DIRECTION('',(${fmt(nx)},${fmt(ny)},${fmt(nz)}))`);
    const rDir = e(`DIRECTION('',(${fmt(rx0)},${fmt(ry0)},${fmt(rz0)}))`);
    const axis = e(`AXIS2_PLACEMENT_3D('',#${cpId[o]},#${nDir},#${rDir})`);
    const plane = e(`PLANE('',#${axis})`);
    faceIds.push(
      e(`ADVANCED_FACE('',(${bounds.map((n) => `#${n}`).join(",")}),#${plane},.T.)`)
    );
  }

  const shell = e(
    `CLOSED_SHELL('',(${faceIds.map((n) => `#${n}`).join(",")}))`
  );
  const brep = e(`MANIFOLD_SOLID_BREP('insert',#${shell})`);

  // Units + geometric context.
  const lenUnit = e(`(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))`);
  const angUnit = e(`(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))`);
  const solUnit = e(`(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())`);
  const unc = e(
    `UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-05),#${lenUnit},'distance_accuracy_value','')`
  );
  const ctx = e(
    `(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${unc}))GLOBAL_UNIT_ASSIGNED_CONTEXT((#${lenUnit},#${angUnit},#${solUnit}))REPRESENTATION_CONTEXT('',''))`
  );
  const originPt = e(`CARTESIAN_POINT('',(0.,0.,0.))`);
  const zDir = e(`DIRECTION('',(0.,0.,1.))`);
  const xDir = e(`DIRECTION('',(1.,0.,0.))`);
  const worldAxis = e(
    `AXIS2_PLACEMENT_3D('',#${originPt},#${zDir},#${xDir})`
  );
  const brepRep = e(
    `ADVANCED_BREP_SHAPE_REPRESENTATION('insert',(#${brep},#${worldAxis}),#${ctx})`
  );

  // Product / shape-definition boilerplate (AP214).
  const appCtx = e(`APPLICATION_CONTEXT('automotive_design')`);
  e(
    `APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#${appCtx})`
  );
  const prodCtx = e(`PRODUCT_CONTEXT('',#${appCtx},'mechanical')`);
  const product = e(`PRODUCT('insert','insert','',(#${prodCtx}))`);
  const pdf = e(
    `PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE('','',#${product},.NOT_KNOWN.)`
  );
  const pdCtx = e(`PRODUCT_DEFINITION_CONTEXT('part definition',#${appCtx},'design')`);
  const pd = e(`PRODUCT_DEFINITION('design','',#${pdf},#${pdCtx})`);
  const pds = e(`PRODUCT_DEFINITION_SHAPE('','',#${pd})`);
  e(`SHAPE_DEFINITION_REPRESENTATION(#${pds},#${brepRep})`);
  const prodCat = e(`PRODUCT_RELATED_PRODUCT_CATEGORY('part','',(#${product}))`);
  void prodCat;

  const header =
    `ISO-10303-21;\n` +
    `HEADER;\n` +
    `FILE_DESCRIPTION(('Package 01 insert foam'),'2;1');\n` +
    `FILE_NAME('package01_insert.step','${new Date().toISOString()}',(''),(''),'Package 01','Package 01','');\n` +
    `FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));\n` +
    `ENDSEC;\n` +
    `DATA;\n`;
  const footer = `ENDSEC;\nEND-ISO-10303-21;\n`;
  return header + L.join("\n") + "\n" + footer;
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
