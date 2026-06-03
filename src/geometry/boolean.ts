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
  g.computeVertexNormals();
  return g;
}

/**
 * Clean a raw CSG result for display: weld duplicate vertices (CSG leaves many
 * coincident ones along cuts), then apply crease-aware normals — curved walls
 * get smooth shading while box faces and the cut edge stay crisp, so the result
 * reads like a clean NURBS-style solid instead of a faceted/torn mesh.
 *
 * (We deliberately do NOT delete sliver triangles: the only slivers left after a
 * watertight-input boolean are coplanar retriangulation fans on flat faces —
 * invisible — and removing them would punch tiny holes in the surface.)
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
  try {
    const evaluator = new Evaluator();
    evaluator.attributes = ["position", "normal"];
    let current = poseBrush(blockLocal, pose);
    for (const s of solids) {
      const tool = poseBrush(s);
      current = evaluator.evaluate(current, tool, SUBTRACTION);
      current.updateMatrixWorld(true);
    }
    return { mesh: finalize(current.geometry, [0.75, 0.78, 0.82]), ready: true };
  } catch {
    return { mesh: applyPose(blockLocal, pose), ready: true };
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
