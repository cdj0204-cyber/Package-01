import type { ImportedMesh } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Step 12 — export the insert foam mesh to 3D formats.
//   STL (ascii) and OBJ are implemented directly from the triangle data.
//   STEP and FBX are stubbed (require a B-rep kernel / FBX SDK) and currently
//   throw a clear "not yet implemented" so the UI can surface it.
// ─────────────────────────────────────────────────────────────────────────────

export type MeshFormat = "stl" | "obj" | "step" | "fbx";

export function exportMesh(mesh: ImportedMesh, format: MeshFormat): Blob {
  switch (format) {
    case "stl":
      return new Blob([meshToAsciiStl(mesh)], { type: "model/stl" });
    case "obj":
      return new Blob([meshToObj(mesh)], { type: "text/plain" });
    case "step":
      throw new Error(
        "STEP 익스포트는 B-rep 커널 연동 후 지원됩니다 (TODO: OCCT)."
      );
    case "fbx":
      throw new Error("FBX 익스포트는 추후 지원됩니다 (TODO: FBX SDK).");
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

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
