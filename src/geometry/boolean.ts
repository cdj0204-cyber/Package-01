import * as THREE from "three";
import {
  mergeVertices,
  toCreasedNormals,
} from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { Evaluator, Brush, SUBTRACTION, INTERSECTION } from "three-bvh-csg";
import type { BoxForm, ImportedMesh, InsertFoam } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Step 3 — boolean subtraction: the box-form block minus the Step-2 extruded
// solids (offset + draft applied). Real mesh CSG via three-bvh-csg.
//
// The box form is authored as a unit-ish block CENTRED ON THE ORIGIN (W×H×D on
// X/Y/Z) plus a pose (centre position + Euler rotation), so it can be freely
// moved, rotated and resized by gizmos in the viewport. The Step-2 solid tools
// live in world space (identity pose); CSG honours each brush's world matrix.
// ─────────────────────────────────────────────────────────────────────────────

/** Pose of the box form: its centre position and Euler rotation (radians). */
export type BoxPose = {
  position: [number, number, number];
  rotation: [number, number, number];
};

/**
 * Build a closed box mesh centred on the origin (W×H×D along X/Y/Z).
 *
 * Built from THREE.BoxGeometry (24 verts / 12 tris, per-face split) rather than
 * a shared-8-corner cube: three-bvh-csg's half-edge connectivity needs that
 * topology to evaluate INTERSECTION robustly (a shared-corner cube degenerates).
 */
export function buildBoxLocalMesh(
  form: BoxForm,
  color: [number, number, number] = [0.75, 0.78, 0.82]
): ImportedMesh {
  const g = new THREE.BoxGeometry(form.width, form.height, form.depth);
  const pos = g.attributes.position.array as ArrayLike<number>;
  const idx = g.index!.array as ArrayLike<number>;
  const mesh: ImportedMesh = {
    name: "block-form",
    positions: new Float32Array(pos),
    indices: new Uint32Array(idx),
    color,
  };
  g.dispose();
  return mesh;
}

function poseMatrix(pose: BoxPose): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(pose.position[0], pose.position[1], pose.position[2]),
    new THREE.Quaternion().setFromEuler(
      new THREE.Euler(pose.rotation[0], pose.rotation[1], pose.rotation[2], "XYZ")
    ),
    new THREE.Vector3(1, 1, 1)
  );
}

/** Bake a pose into a mesh's positions, returning a world-space copy. */
function applyPose(m: ImportedMesh, pose: BoxPose): ImportedMesh {
  const mat = poseMatrix(pose);
  const src = m.positions;
  const out = new Float32Array(src.length);
  const v = new THREE.Vector3();
  for (let i = 0; i < src.length; i += 3) {
    v.set(src[i], src[i + 1], src[i + 2]).applyMatrix4(mat);
    out[i] = v.x;
    out[i + 1] = v.y;
    out[i + 2] = v.z;
  }
  return { ...m, positions: out };
}

/**
 * Force a closed geometry to OUTWARD winding (positive signed volume). The
 * Step-2 extrude builder emits its caps/walls with a net INWARD orientation
 * (signed volume < 0, normals facing into the solid). three-bvh-csg decides
 * inside/outside from face winding, so subtracting an inward-wound tool does the
 * *opposite* of carving — it keeps the tool's exterior and adds volume instead
 * of removing it (the bug behind "no cavity appears"). Flipping every triangle
 * when the signed volume is negative makes the brush a proper solid.
 */
function ensureOutward(g: THREE.BufferGeometry): void {
  const idx = g.index;
  if (!idx) return;
  const pos = g.attributes.position.array as ArrayLike<number>;
  const a = idx.array as Uint32Array | Uint16Array;
  let v = 0;
  for (let i = 0; i < a.length; i += 3) {
    const p = a[i] * 3,
      q = a[i + 1] * 3,
      r = a[i + 2] * 3;
    v +=
      pos[p] * (pos[q + 1] * pos[r + 2] - pos[q + 2] * pos[r + 1]) -
      pos[p + 1] * (pos[q] * pos[r + 2] - pos[q + 2] * pos[r]) +
      pos[p + 2] * (pos[q] * pos[r + 1] - pos[q + 1] * pos[r]);
  }
  if (v < 0) {
    for (let i = 0; i < a.length; i += 3) {
      const t = a[i + 1];
      a[i + 1] = a[i + 2];
      a[i + 2] = t;
    }
    idx.needsUpdate = true;
  }
}

function toGeometry(m: ImportedMesh): THREE.BufferGeometry {
  let g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(m.positions.slice(), 3));
  g.setIndex(new THREE.BufferAttribute(Uint32Array.from(m.indices), 1));
  // Weld coincident vertices: the extrude solids duplicate vertices along the
  // cap↔wall seam, so without this the mesh is non-watertight and the CSG tears
  // the cut into slivers. A welded manifold → clean booleans.
  try {
    g = mergeVertices(g, 1e-4);
  } catch {
    /* keep unwelded geometry on failure */
  }
  // Normalise winding BEFORE computing normals so the brush is a true solid.
  ensureOutward(g);
  g.computeVertexNormals();
  return g;
}

/**
 * Drop needle/zero-area triangles from an indexed geometry. CSG retriangulation
 * of the cut faces leaves a lot of these (≈20% of the output) — they carry no
 * visible surface, but their *direction is numerically garbage* (area → 0), so
 * they poison smooth-normal averaging (the radial streaks on the cavity floor)
 * and their stray edges show up in the crease overlay. A triangle is dropped
 * when its area is ~0 OR it is a needle (its height onto the longest edge is
 * below `minHeight` mm) — neither covers real surface, so removing them can't
 * open a visible hole.
 */
function dropSliverTris(
  g: THREE.BufferGeometry,
  minHeight = 1e-3
): THREE.BufferGeometry {
  const idx = g.index;
  if (!idx) return g;
  const pos = g.attributes.position as THREE.BufferAttribute;
  const a = idx.array;
  const keep: number[] = [];
  const ax = new THREE.Vector3();
  const bx = new THREE.Vector3();
  const cx = new THREE.Vector3();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  for (let i = 0; i < a.length; i += 3) {
    ax.fromBufferAttribute(pos, a[i]);
    bx.fromBufferAttribute(pos, a[i + 1]);
    cx.fromBufferAttribute(pos, a[i + 2]);
    const area = e1.subVectors(bx, ax).cross(e2.subVectors(cx, ax)).length() * 0.5;
    const longest = Math.sqrt(
      Math.max(
        ax.distanceToSquared(bx),
        bx.distanceToSquared(cx),
        cx.distanceToSquared(ax)
      )
    );
    const height = longest > 1e-9 ? (2 * area) / longest : 0;
    if (area > 1e-9 && height >= minHeight) {
      keep.push(a[i], a[i + 1], a[i + 2]);
    }
  }
  if (keep.length === a.length) return g; // nothing dropped
  const out = g.clone();
  out.setIndex(keep);
  return out;
}

/**
 * Clean a raw CSG result for display: weld duplicate vertices (CSG leaves many
 * coincident ones along cuts), discard the sliver triangles it scatters across
 * the cut faces, then apply crease-aware normals — curved walls get smooth
 * shading while box faces and the cut edge stay crisp, so the result reads like a
 * clean solid instead of a streaky/torn mesh.
 */
function finalize(
  geo: THREE.BufferGeometry,
  color: [number, number, number]
): ImportedMesh {
  let g = geo;
  try {
    g = mergeVertices(g, 1e-4);
  } catch {
    /* keep unwelded geometry on failure */
  }
  g = dropSliverTris(g);
  // Re-weld after dropping slivers so the remaining faces share verts cleanly.
  try {
    g = mergeVertices(g, 1e-4);
  } catch {
    /* keep geometry on failure */
  }
  let out: THREE.BufferGeometry;
  try {
    out = toCreasedNormals(g, Math.PI / 4); // smooth < 45°, hard ≥ 45°
  } catch {
    g.computeVertexNormals();
    out = g;
  }
  return toImported(out, color);
}

function poseBrush(m: ImportedMesh, pose?: BoxPose): Brush {
  const b = new Brush(toGeometry(m));
  if (pose) {
    b.position.set(pose.position[0], pose.position[1], pose.position[2]);
    b.rotation.set(pose.rotation[0], pose.rotation[1], pose.rotation[2]);
  }
  b.updateMatrixWorld(true);
  return b;
}

/**
 * Over-cut: scale a (world-space) tool mesh outward from its own centroid by a
 * tiny factor. The default box pose sits the block's bottom face EXACTLY on the
 * solids' base plane, so the tool's base cap is coincident-coplanar with a block
 * face — and three-bvh-csg crashes on coincident boundaries ("Cannot read
 * properties of null (reading 'dot')"), which previously fell through to the
 * uncut block. Nudging every tool face a hair off the block faces removes the
 * degeneracy; the sub-0.1% overhang lies outside the block (or deepens a blind
 * pocket imperceptibly) and is consumed by the boolean — it never shows. This is
 * the standard CAD "make the cutter longer than the stock" trick.
 */
function inflateMesh(m: ImportedMesh, k: number): ImportedMesh {
  const p = m.positions;
  const n = p.length / 3;
  let cx = 0,
    cy = 0,
    cz = 0;
  for (let i = 0; i < p.length; i += 3) {
    cx += p[i];
    cy += p[i + 1];
    cz += p[i + 2];
  }
  cx /= n;
  cy /= n;
  cz /= n;
  const out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    out[i] = cx + (p[i] - cx) * k;
    out[i + 1] = cy + (p[i + 1] - cy) * k;
    out[i + 2] = cz + (p[i + 2] - cz) * k;
  }
  return { ...m, positions: out };
}

function toImported(
  geo: THREE.BufferGeometry,
  color: [number, number, number]
): ImportedMesh {
  const posAttr = geo.attributes.position as THREE.BufferAttribute;
  const nrmAttr = geo.attributes.normal as THREE.BufferAttribute | undefined;
  const positions = new Float32Array(posAttr.array as ArrayLike<number>);
  const normals = nrmAttr
    ? new Float32Array(nrmAttr.array as ArrayLike<number>)
    : undefined;
  let indices: Uint32Array;
  if (geo.index) {
    indices = Uint32Array.from(geo.index.array as ArrayLike<number>);
  } else {
    indices = new Uint32Array(positions.length / 3);
    for (let i = 0; i < indices.length; i++) indices[i] = i;
  }
  return { name: "insert-foam", positions, normals, indices, color };
}

/**
 * Subtract every solid from the posed block (block ∖ ⋃solids) via real mesh CSG.
 * `blockLocal` is centred on the origin; `pose` places it in the scene.
 * Falls back to the plain (posed) block if the CSG evaluation fails.
 */
export function subtractSolids(
  blockLocal: ImportedMesh,
  pose: BoxPose,
  solids: ImportedMesh[]
): InsertFoam {
  if (!solids.length) return { mesh: applyPose(blockLocal, pose), ready: true };
  const evaluator = new Evaluator();
  evaluator.attributes = ["position", "normal"];
  let current = poseBrush(blockLocal, pose);
  let cuts = 0;

  // Escalating over-cut factors: the first almost always succeeds; the larger
  // ones are a safety net for tougher coincidences (e.g. a box face flush with a
  // tool wall, not just the base). A tool that still won't subtract is skipped
  // rather than aborting the whole result, so one bad solid can't wipe the cut.
  const OVERCUT = [1.0008, 1.003, 1.01];
  for (const s of solids) {
    for (const k of OVERCUT) {
      try {
        const tool = poseBrush(inflateMesh(s, k));
        const next = evaluator.evaluate(current, tool, SUBTRACTION);
        next.updateMatrixWorld(true);
        current = next;
        cuts++;
        break;
      } catch {
        /* coincident-boundary degeneracy — retry with a larger over-cut */
      }
    }
  }

  try {
    return {
      mesh: finalize(current.geometry, [0.75, 0.78, 0.82]),
      // "ready" once at least one cut landed; an all-fail result is just the
      // block, so don't advertise it as a finished insert foam.
      ready: cuts > 0,
    };
  } catch {
    return { mesh: applyPose(blockLocal, pose), ready: false };
  }
}

/**
 * Per-solid intersection of the posed block with each solid (block ∩ solid).
 * Used as a live preview of exactly what the boolean will carve away. Empty
 * intersections (no overlap) are skipped. World-space meshes (pose baked in).
 */
export function intersectSolids(
  blockLocal: ImportedMesh,
  pose: BoxPose,
  solids: ImportedMesh[],
  color: [number, number, number] = [0.55, 0.95, 0.35]
): ImportedMesh[] {
  const out: ImportedMesh[] = [];
  if (!solids.length) return out;
  try {
    const evaluator = new Evaluator();
    evaluator.attributes = ["position", "normal"];
    for (const s of solids) {
      const block = poseBrush(blockLocal, pose);
      const tool = poseBrush(s);
      const res = evaluator.evaluate(block, tool, INTERSECTION);
      res.updateMatrixWorld(true);
      const pos = res.geometry.attributes.position as
        | THREE.BufferAttribute
        | undefined;
      if (pos && pos.count > 0) out.push(finalize(res.geometry, color));
    }
  } catch {
    /* preview only — ignore failures */
  }
  return out;
}
