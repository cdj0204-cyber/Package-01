import type { ImportedMesh, ImportedModel } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Step 1 — STEP file import via occt-import-js (OpenCascade compiled to wasm).
// Reads a .step/.stp file buffer and returns triangulated meshes + bbox.
//
// NOTE: occt-import-js triangulates NURBS for display. The original B-rep is not
// retained here; later boolean/draft work that needs true NURBS will require the
// full OpenCascade.js kernel (occt). This is sufficient for the skeleton and for
// silhouette extraction from the tessellation.
// ─────────────────────────────────────────────────────────────────────────────

let occtPromise: Promise<any> | null = null;

function getOcct(): Promise<any> {
  if (!occtPromise) {
    // Loaded lazily: occt-import-js references node built-ins at module scope,
    // so importing it eagerly would break the browser app. Dynamic import keeps
    // that cost (and any shim issues) confined to the moment a STEP is opened.
    occtPromise = import("occt-import-js").then((mod) => mod.default());
  }
  return occtPromise;
}

export async function importStepFile(
  file: File
): Promise<ImportedModel> {
  const occt = await getOcct();
  const buffer = new Uint8Array(await file.arrayBuffer());

  const result = occt.ReadStepFile(buffer, null);
  if (!result || !result.success) {
    throw new Error("STEP 파일을 읽지 못했습니다.");
  }

  const meshes: ImportedMesh[] = [];
  let min: [number, number, number] = [Infinity, Infinity, Infinity];
  let max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  for (const m of result.meshes as any[]) {
    const positions = new Float32Array(m.attributes.position.array);
    const indices = new Uint32Array(m.index.array);
    const normals = m.attributes.normal
      ? new Float32Array(m.attributes.normal.array)
      : undefined;

    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i],
        y = positions[i + 1],
        z = positions[i + 2];
      if (x < min[0]) min[0] = x;
      if (y < min[1]) min[1] = y;
      if (z < min[2]) min[2] = z;
      if (x > max[0]) max[0] = x;
      if (y > max[1]) max[1] = y;
      if (z > max[2]) max[2] = z;
    }

    meshes.push({
      name: m.name || `mesh_${meshes.length}`,
      positions,
      normals,
      indices,
      color: m.color
        ? [m.color[0], m.color[1], m.color[2]]
        : undefined,
    });
  }

  if (!meshes.length) {
    throw new Error("STEP 파일에 메쉬 데이터가 없습니다.");
  }

  return { fileName: file.name, meshes, bbox: { min, max } };
}
