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
    occtPromise = (async () => {
      // occt-import-js is a UMD bundle: `module.exports = factory`. Depending on
      // interop, the factory may be on `.default` or be the module object itself.
      const mod: any = await import("occt-import-js");
      const factory =
        typeof mod === "function"
          ? mod
          : typeof mod.default === "function"
          ? mod.default
          : mod.default?.default;
      if (typeof factory !== "function") {
        throw new Error("occt-import-js 로더를 찾지 못했습니다.");
      }
      // The emscripten module locates its .wasm via document.currentScript,
      // which is wrong after bundling. Point it at the asset URL Vite emits.
      const wasmUrl = (await import("occt-import-js/dist/occt-import-js.wasm?url"))
        .default;
      return factory({
        locateFile: (path: string) =>
          path.endsWith(".wasm") ? wasmUrl : path,
      });
    })();
  }
  return occtPromise;
}

/**
 * Tessellation quality for display. We triangulate finely (curvature-adaptive) so
 * the model *looks* like the true B-rep surface even though WebGL rasterizes
 * triangles — the same thing a Rhino/Fusion viewport does.
 *
 * IMPORTANT — why ABSOLUTE, not bounding-box-ratio: a ratio ties the chord error
 * to the WHOLE part's bounding box, so on a big model (e.g. a 300 mm drone frame)
 * even a 0.001 ratio is ~0.3 mm — larger than the part's thin ribs and small
 * holes, which then collapse into mangled facets. An absolute chord error keeps
 * every small feature crisp regardless of overall size; flat/shallow faces stay
 * cheap (low curvature ⇒ few triangles even at a tight tolerance), so the count
 * doesn't explode.
 *
 * - `linearDeflection` (absolute, mm): max chord error of a facet from the true
 *   surface. 0.05 mm is well below visual perception.
 * - `angularDeflection` (rad): caps the angle between adjacent facets — what makes
 *   tight cylinders/fillets read as smooth. 0.1 rad ≈ 5.7°.
 */
export interface TessellationQuality {
  linearDeflectionType: "bounding_box_ratio" | "absolute_value";
  linearDeflection: number;
  angularDeflection: number;
}

/** Smooth default: 0.05 mm absolute chord error + ~5.7° facet cap. */
export const SMOOTH_TESSELLATION: TessellationQuality = {
  linearDeflectionType: "absolute_value",
  linearDeflection: 0.05,
  angularDeflection: 0.1,
};

export async function importStepFile(
  file: File,
  quality: TessellationQuality = SMOOTH_TESSELLATION
): Promise<ImportedModel> {
  const occt = await getOcct();
  const buffer = new Uint8Array(await file.arrayBuffer());

  const result = occt.ReadStepFile(buffer, {
    linearUnit: "millimeter",
    linearDeflectionType: quality.linearDeflectionType,
    linearDeflection: quality.linearDeflection,
    angularDeflection: quality.angularDeflection,
  });
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
