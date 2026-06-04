import * as THREE from "three";
import type { BoxForm, ModelSilhouette } from "../types";
import { extrudeOuterRings } from "./silhouetteField";
import type { BoxPose } from "./boolean";

// ─────────────────────────────────────────────────────────────────────────────
// True-NURBS export via the full OpenCascade kernel (opencascade.js, OCCT 7.x in
// wasm). Instead of triangulating the boolean result, we rebuild the insert foam
// as a real B-rep — box (planar faces) minus drafted prisms whose side walls are
// smooth B-spline surfaces lofted between the offset/draft contours — and let
// OCCT write a native STEP. Result: clean analytic surfaces, not facets.
//
// The 65 MB wasm + the modelling run only happen when the user exports STEP, so
// the cost is on-demand and one-time (kernel init is cached).
// ─────────────────────────────────────────────────────────────────────────────

let ocPromise: Promise<any> | null = null;

/** Lazily initialise the OpenCascade kernel (cached). */
export function initOcct(): Promise<any> {
  if (!ocPromise) {
    ocPromise = (async () => {
      // Import the emscripten factory + the wasm URL separately (like the
      // occt-import-js setup) rather than the package's bare-.wasm import, which
      // the bundler mishandles.
      const mod: any = await import("opencascade.js/dist/opencascade.wasm.js");
      const factory =
        typeof mod === "function" ? mod : mod.default ?? mod.default?.default;
      const wasmUrl = (
        await import("opencascade.js/dist/opencascade.wasm.wasm?url")
      ).default;
      return factory({
        locateFile: (p: string) => (p.endsWith(".wasm") ? wasmUrl : p),
      });
    })();
  }
  return ocPromise;
}

/** Pre-warm the kernel (optional) so the first export feels instant. */
export function warmOcct(): void {
  void initOcct();
}

/**
 * Build the insert foam as a true B-rep and return a native STEP file.
 * `pose` is the box-form centre + rotation; `sils` are the Step-2 silhouettes
 * whose drafted extrusions are subtracted from the box.
 */
export async function exportFoamStep(
  boxForm: BoxForm,
  pose: BoxPose,
  sils: ModelSilhouette[]
): Promise<Blob> {
  const oc = await initOcct();
  const P = (x: number, y: number, z: number) => new oc.gp_Pnt_3(x, y, z);
  const cont = oc.GeomAbs_Shape.GeomAbs_C2;

  // A closed smooth B-spline wire approximating a world-space ring of points.
  const bsplineWire = (pts: Array<[number, number, number]>) => {
    const closed = pts.concat([pts[0]]); // close the loop
    const arr = new oc.TColgp_Array1OfPnt_2(1, closed.length);
    closed.forEach((p, i) => arr.SetValue(i + 1, P(p[0], p[1], p[2])));
    // Approximation (tol 0.05 mm) smooths the marching-squares stair-step.
    const bspl = new oc.GeomAPI_PointsToBSpline_2(arr, 3, 8, cont, 0.05).Curve();
    const hc = new oc.Handle_Geom_Curve_2(bspl.get());
    const edge = new oc.BRepBuilderAPI_MakeEdge_24(hc).Edge();
    return new oc.BRepBuilderAPI_MakeWire_2(edge).Wire();
  };

  // 1) Box centred on the origin, then placed at the pose (rotation + position).
  let box = new oc.BRepPrimAPI_MakeBox_2(
    P(-boxForm.width / 2, -boxForm.height / 2, -boxForm.depth / 2),
    boxForm.width,
    boxForm.height,
    boxForm.depth
  ).Shape();
  const mat = new THREE.Matrix4().compose(
    new THREE.Vector3(pose.position[0], pose.position[1], pose.position[2]),
    new THREE.Quaternion().setFromEuler(
      new THREE.Euler(pose.rotation[0], pose.rotation[1], pose.rotation[2], "XYZ")
    ),
    new THREE.Vector3(1, 1, 1)
  );
  const e = mat.elements; // column-major
  const trsf = new oc.gp_Trsf_1();
  trsf.SetValues(
    e[0], e[4], e[8], e[12],
    e[1], e[5], e[9], e[13],
    e[2], e[6], e[10], e[14]
  );
  box = new oc.BRepBuilderAPI_Transform_2(box, trsf, false).Shape();

  // 2) Subtract each drafted-prism tool (smooth B-spline walls) from the box.
  let result = box;
  let cuts = 0;
  for (const sil of sils) {
    const rings = extrudeOuterRings(sil, 80);
    if (!rings) continue;
    const baseW = bsplineWire(rings.base);
    const topW = bsplineWire(rings.top);
    const ts = new oc.BRepOffsetAPI_ThruSections(true, false, 1e-6);
    ts.AddWire(baseW);
    ts.AddWire(topW);
    ts.Build();
    const tool = ts.Shape();
    const cut = new oc.BRepAlgoAPI_Cut_3(result, tool);
    cut.Build();
    result = cut.Shape();
    cuts++;
  }
  if (!cuts) throw new Error("실루엣 솔리드가 없어 NURBS STEP을 만들 수 없습니다.");

  // 3) Native STEP (AP214, millimetres).
  try {
    oc.Interface_Static.SetCVal("write.step.unit", "MM");
  } catch {
    /* default unit is fine */
  }
  const writer = new oc.STEPControl_Writer_1();
  writer.Transfer(result, oc.STEPControl_StepModelType.STEPControl_AsIs, true);
  // NOTE: this opencascade.js build garbles long virtual-FS paths passed to
  // Write() (anything past ~9 chars lands under a corrupted name), so we write
  // to a deliberately short path and read it straight back.
  const path = "/o.step";
  writer.Write(path);
  const data: string = oc.FS.readFile(path, { encoding: "utf8" });
  return new Blob([data], { type: "application/step" });
}
