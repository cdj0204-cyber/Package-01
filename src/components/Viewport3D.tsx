import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { useStore } from "../store/useStore";
import type { ImportedMesh, PlacedModel } from "../types";
import { type BoxPose } from "../geometry/boolean";
import {
  buildExtrudeMesh,
  contourAt,
  extrudeCapLoops,
  solidsPlacement,
  uvToWorld,
} from "../geometry/silhouetteField";
import type { ModelSilhouette } from "../types";
import { getBoxPreset } from "../box/presets";

// ─────────────────────────────────────────────────────────────────────────────
// three.js viewport. A package can hold several products, so every imported
// model gets its own pivot group, is independently click-selectable, and is
// moved/rotated via the TransformControls gizmo (or the numeric panel). The
// gizmo pivots about each model's own centre. Lighting contrast is store-driven.
// ─────────────────────────────────────────────────────────────────────────────

interface ModelGroup {
  pivot: THREE.Group; // gizmo target; origin at model centre
  holder: THREE.Group; // offset by -centre so meshes keep world coords
  center: [number, number, number];
  mats: THREE.MeshStandardMaterial[];
}

/**
 * Build a three.js mesh from an imported/derived mesh. `smooth` uses OCCT's
 * per-vertex surface normals so curved NURBS surfaces read smooth (no facets);
 * faceted helpers (block/plug) stay flat-shaded.
 */
function toThreeMesh(m: ImportedMesh, opacity = 1, smooth = false): THREE.Mesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(m.positions, 3));
  geo.setIndex(new THREE.BufferAttribute(m.indices, 1));
  if (smooth && m.normals) {
    geo.setAttribute("normal", new THREE.BufferAttribute(m.normals, 3));
  } else if (smooth) {
    geo.computeVertexNormals();
  }
  const color = m.color
    ? new THREE.Color(m.color[0], m.color[1], m.color[2])
    : new THREE.Color(0.7, 0.75, 0.8);
  const mat = new THREE.MeshStandardMaterial({
    color,
    metalness: 0.1,
    roughness: 0.55,
    transparent: opacity < 1,
    opacity,
    side: THREE.DoubleSide,
    flatShading: !smooth,
  });
  return new THREE.Mesh(geo, mat);
}

/**
 * Clean crease edges of a mesh as a line-segment geometry. Unlike EdgesGeometry,
 * this only emits edges SHARED by exactly two faces whose dihedral angle exceeds
 * the threshold — boundary / T-junction edges (which CSG output is full of) are
 * skipped, so the result is just the real hard edges (box edges + cavity rim),
 * not the chaotic retriangulation fan. Input should be welded + indexed.
 */
function creaseEdgesGeometry(
  geo: THREE.BufferGeometry,
  angleDeg = 28
): THREE.BufferGeometry {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const idx = geo.index;
  const out = new THREE.BufferGeometry();
  if (!idx) return out;
  const cosT = Math.cos((angleDeg * Math.PI) / 180);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  type Rec = { count: number; n1: THREE.Vector3; n2: THREE.Vector3; x: number; y: number };
  const edges = new Map<string, Rec>();
  for (let t = 0; t < idx.count; t += 3) {
    const i0 = idx.getX(t), i1 = idx.getX(t + 1), i2 = idx.getX(t + 2);
    a.fromBufferAttribute(pos, i0);
    b.fromBufferAttribute(pos, i1);
    c.fromBufferAttribute(pos, i2);
    const n = ab.subVectors(b, a).cross(ac.subVectors(c, a)).normalize().clone();
    const tri = [i0, i1, i2];
    for (let e = 0; e < 3; e++) {
      const u = tri[e], v = tri[(e + 1) % 3];
      const key = u < v ? `${u}_${v}` : `${v}_${u}`;
      let rec = edges.get(key);
      if (!rec) {
        rec = { count: 0, n1: n, n2: n, x: Math.min(u, v), y: Math.max(u, v) };
        edges.set(key, rec);
      }
      rec.count++;
      if (rec.count === 2) rec.n2 = n;
    }
  }
  const seg: number[] = [];
  const p0 = new THREE.Vector3();
  const p1 = new THREE.Vector3();
  for (const rec of edges.values()) {
    if (rec.count !== 2) continue; // skip boundary / T-junction edges
    if (rec.n1.dot(rec.n2) < cosT) {
      p0.fromBufferAttribute(pos, rec.x);
      p1.fromBufferAttribute(pos, rec.y);
      seg.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z);
    }
  }
  out.setAttribute("position", new THREE.Float32BufferAttribute(seg, 3));
  return out;
}

/** Map contrast 0..1 to ambient + directional intensities. */
function lightingFor(contrast: number) {
  return {
    ambient: 0.9 - 0.72 * contrast,
    directional: 0.3 + 1.6 * contrast,
  };
}

function disposeGroup(g: THREE.Group) {
  for (let i = g.children.length - 1; i >= 0; i--) {
    const c = g.children[i];
    g.remove(c);
    c.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else if (mat) mat.dispose();
    });
  }
}

function centerOf(m: PlacedModel["model"]): [number, number, number] {
  return [
    (m.bbox.min[0] + m.bbox.max[0]) / 2,
    (m.bbox.min[1] + m.bbox.max[1]) / 2,
    (m.bbox.min[2] + m.bbox.max[2]) / 2,
  ];
}

/** Combined XY centre of all models (raw bboxes), used to place the block/box. */
function combinedCenterXY(models: PlacedModel[]): [number, number] {
  if (!models.length) return [0, 0];
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const pm of models) {
    minX = Math.min(minX, pm.model.bbox.min[0]);
    minY = Math.min(minY, pm.model.bbox.min[1]);
    maxX = Math.max(maxX, pm.model.bbox.max[0]);
    maxY = Math.max(maxY, pm.model.bbox.max[1]);
  }
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}

/** Combined raw bbox centre + radius (mm) of all models, for camera framing. */
function combinedBox(models: PlacedModel[]): {
  center: [number, number, number];
  radius: number;
} {
  if (!models.length) return { center: [0, 0, 0], radius: 300 };
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const pm of models)
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], pm.model.bbox.min[i] + pm.transform.position[i]);
      max[i] = Math.max(max[i], pm.model.bbox.max[i] + pm.transform.position[i]);
    }
  const center: [number, number, number] = [
    (min[0] + max[0]) / 2,
    (min[1] + max[1]) / 2,
    (min[2] + max[2]) / 2,
  ];
  const radius =
    Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2 || 100;
  return { center, radius };
}

/** The box-form pose to display: explicit (from gizmo/align) or auto-framed. */
function resolveBoxPose(
  explicit: BoxPose | null,
  sils: ModelSilhouette[],
  height: number
): BoxPose | null {
  if (explicit) return explicit;
  const place = solidsPlacement(sils);
  if (!place) return null;
  return {
    position: [place.cx, place.baseY + height / 2, place.cz],
    rotation: [0, 0, 0],
  };
}

// Direction + up vector for each camera viewpoint (Y is up).
const VIEW_DIRS: Record<
  string,
  { dir: [number, number, number]; up: [number, number, number] }
> = {
  perspective: { dir: [0.6, 0.5, 0.8], up: [0, 1, 0] },
  top: { dir: [0, 1, 0], up: [0, 0, -1] },
  bottom: { dir: [0, -1, 0], up: [0, 0, 1] },
  front: { dir: [0, 0, 1], up: [0, 1, 0] },
  rear: { dir: [0, 0, -1], up: [0, 1, 0] },
  right: { dir: [1, 0, 0], up: [0, 1, 0] },
  left: { dir: [-1, 0, 0], up: [0, 1, 0] },
};

export function Viewport3D() {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene>();
  const contentRef = useRef<THREE.Group>();
  const modelsRootRef = useRef<THREE.Group>();
  const modelGroupsRef = useRef<Map<string, ModelGroup>>(new Map());
  const ambientRef = useRef<THREE.AmbientLight>();
  const dirRef = useRef<THREE.DirectionalLight>();
  const orbitRef = useRef<OrbitControls>();
  const perspRef = useRef<THREE.PerspectiveCamera>();
  const orthoRef = useRef<THREE.OrthographicCamera>();
  const activeCamRef = useRef<THREE.Camera>();
  const viewSizeRef = useRef(300); // ortho half-height (mm)
  const tcRef = useRef<TransformControls>();
  const draggingRef = useRef(false);
  const silRootRef = useRef<THREE.Group>();
  const extrudeHandleRef = useRef<THREE.Object3D>();
  // Step-3 box form: pivot (gizmo target) + its resize face-arrow handles, plus
  // the green boolean-overlap preview group.
  const boxRootRef = useRef<THREE.Group>();
  const boxPivotRef = useRef<THREE.Group>();
  const boxHandlesRef = useRef<THREE.Mesh[]>([]);
  const overlapRootRef = useRef<THREE.Group>();
  const boxDimsRef = useRef({ w: 0, h: 0, d: 0 });
  // Rebuilds the box child meshes (fill/edges/handles) at given dims — set by
  // the box-editing effect so the pointer handlers can resize live during drag.
  const rebuildBoxRef = useRef<(w: number, h: number, d: number) => void>();
  // Live face-drag state (resize gizmo).
  const faceDragRef = useRef<{
    active: boolean;
    axis: 0 | 1 | 2;
    sign: 1 | -1;
    axisWorld: THREE.Vector3;
    center0: THREE.Vector3;
    start: { w: number; h: number; d: number };
  } | null>(null);
  // Latest step + box edit mode for the (one-time) pointer handlers.
  const stepRef = useRef(1);
  const boxModeRef = useRef<"resize" | "move" | "rotate">("resize");
  // What the transform gizmo currently drives.
  const tcTargetRef = useRef<{
    kind: "model" | "extrude" | "box";
    id: string | null;
  }>({
    kind: "model",
    id: null,
  });

  const step = useStore((s) => s.currentStep);
  const models = useStore((s) => s.models);
  const selectedModelId = useStore((s) => s.selectedModelId);
  const modelSilhouettes = useStore((s) => s.modelSilhouettes);
  const boxForm = useStore((s) => s.boxForm);
  const boxTransform = useStore((s) => s.boxTransform);
  const boxEditMode = useStore((s) => s.boxEditMode);
  const insertFoam = useStore((s) => s.insertFoam);
  const boxPresetId = useStore((s) => s.boxPresetId);
  const boxSizing = useStore((s) => s.boxSizing);
  const lightContrast = useStore((s) => s.lightContrast);
  const gizmoMode = useStore((s) => s.gizmoMode);
  const cameraView = useStore((s) => s.cameraView);

  const showModel = step <= 2;

  // ── one-time scene setup ────────────────────────────────────────────────────
  useEffect(() => {
    const mount = mountRef.current!;
    const scene = new THREE.Scene();
    sceneRef.current = scene;

    const aspect = mount.clientWidth / mount.clientHeight;
    const persp = new THREE.PerspectiveCamera(45, aspect, 0.1, 100000);
    persp.position.set(300, 250, 400);
    const ortho = new THREE.OrthographicCamera(
      -300 * aspect,
      300 * aspect,
      300,
      -300,
      0.1,
      100000
    );
    ortho.position.set(300, 250, 400);
    perspRef.current = persp;
    orthoRef.current = ortho;
    activeCamRef.current = persp;
    const camera = persp; // controls are created against the perspective cam

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.localClippingEnabled = true; // Step-3 overlap preview clips to box
    mount.appendChild(renderer.domElement);

    const orbit = new OrbitControls(camera, renderer.domElement);
    orbit.enableDamping = true;
    orbitRef.current = orbit;

    const initial = lightingFor(useStore.getState().lightContrast);
    const ambient = new THREE.AmbientLight(0xffffff, initial.ambient);
    ambientRef.current = ambient;
    scene.add(ambient);
    const dir = new THREE.DirectionalLight(0xffffff, initial.directional);
    dir.position.set(1, 2, 1.5);
    dirRef.current = dir;
    scene.add(dir);
    const fill = new THREE.DirectionalLight(0xffffff, 0.15);
    fill.position.set(-1.5, -0.5, -1);
    scene.add(fill);

    scene.add(new THREE.GridHelper(1000, 20, 0x2a313c, 0x1c232d));
    scene.add(new THREE.AxesHelper(80));

    // Compass labels (E=+X, W=−X, S=+Z, N=−Z) as a DOM overlay so the text is
    // real CSS px (matches the side panel font) and stays crisp. Their screen
    // position is reprojected from the world grid edges every frame.
    const overlay = document.createElement("div");
    overlay.className = "vp-compass";
    mount.appendChild(overlay);
    const compassDefs: Array<[string, [number, number, number]]> = [
      ["동 E", [520, 4, 0]],
      ["서 W", [-520, 4, 0]],
      ["남 S", [0, 4, 520]],
      ["북 N", [0, 4, -520]],
    ];
    const compassLabels = compassDefs.map(([t, p]) => {
      const el = document.createElement("span");
      el.className = "vp-compass-label";
      el.textContent = t;
      overlay.appendChild(el);
      return { el, pos: new THREE.Vector3(p[0], p[1], p[2]) };
    });

    const content = new THREE.Group();
    contentRef.current = content;
    scene.add(content);

    const modelsRoot = new THREE.Group();
    modelsRootRef.current = modelsRoot;
    scene.add(modelsRoot);

    // Silhouette outlines + extruded planes (step 2).
    const silRoot = new THREE.Group();
    silRootRef.current = silRoot;
    scene.add(silRoot);

    // Invisible handle the extrude gizmo grabs (step 2).
    const extrudeHandle = new THREE.Object3D();
    extrudeHandleRef.current = extrudeHandle;
    scene.add(extrudeHandle);

    // Step-3 box form: pivot holds the fill/edges/resize-handles; overlap holds
    // the green boolean-preview meshes (already world-space, so kept separate).
    const boxRoot = new THREE.Group();
    boxRoot.visible = false;
    boxRootRef.current = boxRoot;
    scene.add(boxRoot);
    const boxPivot = new THREE.Group();
    boxPivotRef.current = boxPivot;
    boxRoot.add(boxPivot);
    const overlapRoot = new THREE.Group();
    overlapRoot.visible = false;
    overlapRootRef.current = overlapRoot;
    scene.add(overlapRoot);

    // Transform gizmo (drives either a model's pivot or the extrude handle).
    const tc = new TransformControls(camera, renderer.domElement);
    tcRef.current = tc;
    tc.setMode(useStore.getState().gizmoMode);
    tc.setSize(0.85);
    tc.detach();
    scene.add(tc.getHelper());
    tc.addEventListener("dragging-changed", (e: any) => {
      orbit.enabled = !e.value;
      draggingRef.current = e.value;
      if (e.value) return;
      const target = tcTargetRef.current;
      if (target.kind === "box") {
        // Move/rotate gizmo finished — persist the box pose.
        const pivot = boxPivotRef.current;
        if (pivot) {
          useStore.getState().setBoxTransform({
            position: [pivot.position.x, pivot.position.y, pivot.position.z],
            rotation: [pivot.rotation.x, pivot.rotation.y, pivot.rotation.z],
          });
        }
        return;
      }
      if (target.kind === "extrude") {
        // Drag finished — convert handle height into extrude depth (0.1mm snap).
        const id = target.id;
        const sil = id ? useStore.getState().modelSilhouettes[id] : undefined;
        const handle = extrudeHandleRef.current;
        if (id && sil && handle) {
          const axisVal = [handle.position.x, handle.position.y, handle.position.z][
            sil.field.depthAxis
          ];
          const depth = Math.max(0.1, axisVal - sil.field.depthBase);
          useStore.getState().setSilhouetteExtrude(id, Math.round(depth * 10) / 10);
        }
        return;
      }
      // Model placement — persist delta from the model centre.
      const id = useStore.getState().selectedModelId;
      const grp = id ? modelGroupsRef.current.get(id) : undefined;
      if (id && grp) {
        const { pivot, center } = grp;
        useStore.getState().setModelTransform(id, {
          position: [
            pivot.position.x - center[0],
            pivot.position.y - center[1],
            pivot.position.z - center[2],
          ],
          rotation: [pivot.rotation.x, pivot.rotation.y, pivot.rotation.z],
        });
      }
    });

    // Click-to-select models (ignore drags and gizmo-handle interactions);
    // plus Step-3 box-form face-arrow resize dragging.
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let down: { x: number; y: number; gizmo: boolean } | null = null;

    const setPointer = (e: PointerEvent) => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, activeCamRef.current!);
    };

    // Closest signed distance along the drag axis (line through center0) to the
    // pointer ray — gives where the dragged face should sit.
    const axisParam = (fd: NonNullable<typeof faceDragRef.current>): number => {
      const ro = raycaster.ray.origin;
      const rd = raycaster.ray.direction; // unit
      const a = fd.axisWorld; // unit
      const r = ro.clone().sub(fd.center0);
      const b = rd.dot(a);
      const denom = 1 - b * b;
      if (Math.abs(denom) < 1e-6) return a.dot(r);
      const d1 = rd.dot(r);
      const e2 = a.dot(r);
      return (e2 - b * d1) / denom;
    };

    const onPointerDown = (e: PointerEvent) => {
      // Step-3 resize: try to grab a box face arrow first.
      if (
        stepRef.current === 3 &&
        boxModeRef.current === "resize" &&
        boxHandlesRef.current.length
      ) {
        setPointer(e);
        const hits = raycaster.intersectObjects(boxHandlesRef.current, false);
        if (hits.length) {
          const pivot = boxPivotRef.current!;
          const h = hits[0].object;
          const axis = h.userData.faceAxis as 0 | 1 | 2;
          const sign = h.userData.faceSign as 1 | -1;
          const local = new THREE.Vector3(0, 0, 0);
          local.setComponent(axis, 1);
          const axisWorld = local
            .applyQuaternion(pivot.quaternion)
            .normalize();
          faceDragRef.current = {
            active: true,
            axis,
            sign,
            axisWorld,
            center0: pivot.position.clone(),
            start: { ...boxDimsRef.current },
          };
          orbit.enabled = false;
          draggingRef.current = true;
          down = null;
          return;
        }
      }
      down = { x: e.clientX, y: e.clientY, gizmo: (tc as any).axis != null };
    };

    const onPointerMove = (e: PointerEvent) => {
      const fd = faceDragRef.current;
      if (!fd || !fd.active) return;
      setPointer(e);
      const s = axisParam(fd);
      const half0 =
        (fd.axis === 0 ? fd.start.w : fd.axis === 1 ? fd.start.h : fd.start.d) /
        2;
      const fixed = -fd.sign * half0; // opposite face stays put
      const center = (s + fixed) / 2; // new centre offset along the axis
      const dim = Math.max(2, Math.abs(s - fixed));
      const pivot = boxPivotRef.current!;
      pivot.position.copy(
        fd.center0.clone().add(fd.axisWorld.clone().multiplyScalar(center))
      );
      const dims = { ...fd.start };
      if (fd.axis === 0) dims.w = dim;
      else if (fd.axis === 1) dims.h = dim;
      else dims.d = dim;
      rebuildBoxRef.current?.(dims.w, dims.h, dims.d);
    };

    const onPointerUp = (e: PointerEvent) => {
      // Finish a face-resize drag → commit dims + pose.
      const fd = faceDragRef.current;
      if (fd && fd.active) {
        faceDragRef.current = null;
        draggingRef.current = false;
        orbit.enabled = true;
        const pivot = boxPivotRef.current!;
        const { w, h, d } = boxDimsRef.current;
        useStore.getState().updateBoxForm({ width: w, height: h, depth: d });
        useStore.getState().setBoxTransform({
          position: [pivot.position.x, pivot.position.y, pivot.position.z],
          rotation: [pivot.rotation.x, pivot.rotation.y, pivot.rotation.z],
        });
        return;
      }

      const d = down;
      down = null;
      if (!d) return;
      const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y);
      if (moved > 5 || d.gizmo || draggingRef.current) return;
      // No model selection outside the steps that show models.
      if (stepRef.current > 2) return;
      const root = modelsRootRef.current;
      if (!root || !root.visible) return;
      setPointer(e);
      const hits = raycaster.intersectObjects(root.children, true);
      if (hits.length) {
        let o: THREE.Object3D | null = hits[0].object;
        while (o && o.userData.modelId === undefined) o = o.parent;
        if (o && o.userData.modelId)
          useStore.getState().selectModel(o.userData.modelId as string);
      } else {
        useStore.getState().selectModel(null);
      }
    };
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerup", onPointerUp);

    const projV = new THREE.Vector3();
    const updateCompass = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      const pad = 16;
      for (const { el, pos } of compassLabels) {
        projV.copy(pos).project(activeCamRef.current!);
        let x = (projV.x * 0.5 + 0.5) * w;
        let y = (-projV.y * 0.5 + 0.5) * h;
        // Points behind the camera invert through the origin — mirror them so
        // the label is pinned to the opposite screen edge, not flipped wrongly.
        if (projV.z > 1) {
          x = w - x;
          y = h - y;
        }
        // Keep every label on-screen (compass pinned to the viewport border).
        x = Math.max(pad, Math.min(w - pad, x));
        y = Math.max(pad, Math.min(h - pad, y));
        el.style.transform = `translate(-50%, -50%) translate(${x}px, ${y}px)`;
      }
    };

    let raf = 0;
    const animate = () => {
      orbit.update();
      renderer.render(scene, activeCamRef.current!);
      updateCompass();
      raf = requestAnimationFrame(animate);
    };
    animate();

    const onResize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      const a = w / h;
      persp.aspect = a;
      persp.updateProjectionMatrix();
      const vs = viewSizeRef.current;
      ortho.left = -vs * a;
      ortho.right = vs * a;
      ortho.top = vs;
      ortho.bottom = -vs;
      ortho.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(mount);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      tc.detach();
      // three r0.169 TransformControls.dispose() calls this.traverse() but the
      // class isn't an Object3D, so it throws — tear down manually instead.
      tc.disconnect();
      const helper = tc.getHelper();
      scene.remove(helper);
      helper.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else if (mat) mat.dispose();
      });
      for (const grp of modelGroupsRef.current.values())
        disposeGroup(grp.holder);
      modelGroupsRef.current.clear();
      disposeGroup(silRoot);
      disposeGroup(boxPivot);
      disposeGroup(overlapRoot);
      overlay.remove();
      orbit.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, []);

  // ── live lighting contrast ───────────────────────────────────────────────────
  useEffect(() => {
    const l = lightingFor(lightContrast);
    if (ambientRef.current) ambientRef.current.intensity = l.ambient;
    if (dirRef.current) dirRef.current.intensity = l.directional;
  }, [lightContrast]);

  // ── gizmo mode (only applies when the gizmo drives a model) ──────────────────
  useEffect(() => {
    if (tcTargetRef.current.kind === "model") tcRef.current?.setMode(gizmoMode);
  }, [gizmoMode]);

  // ── keep step / box-mode refs fresh for the one-time pointer handlers ─────────
  useEffect(() => {
    stepRef.current = step;
  }, [step]);
  useEffect(() => {
    boxModeRef.current = boxEditMode;
  }, [boxEditMode]);

  // ── camera viewpoint: free perspective, or a flat orthographic face ──────────
  useEffect(() => {
    const persp = perspRef.current;
    const ortho = orthoRef.current;
    const orbit = orbitRef.current;
    const tc = tcRef.current;
    const mount = mountRef.current;
    if (!persp || !ortho || !orbit || !tc || !mount) return;

    const { center, radius } = combinedBox(models);
    const { dir, up } = VIEW_DIRS[cameraView] ?? VIEW_DIRS.perspective;
    const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    const cam: THREE.Camera = cameraView === "perspective" ? persp : ortho;

    if (cameraView === "perspective") {
      const dist = Math.max(120, radius * 3.2);
      persp.up.set(up[0], up[1], up[2]);
      persp.position.set(
        center[0] + (dir[0] / len) * dist,
        center[1] + (dir[1] / len) * dist,
        center[2] + (dir[2] / len) * dist
      );
    } else {
      // Orthographic = no perspective distortion (flat, 2D-like) face view.
      const a = mount.clientWidth / mount.clientHeight;
      const viewSize = Math.max(40, radius * 1.25);
      viewSizeRef.current = viewSize;
      ortho.left = -viewSize * a;
      ortho.right = viewSize * a;
      ortho.top = viewSize;
      ortho.bottom = -viewSize;
      ortho.near = 0.1;
      ortho.far = radius * 40 + 20000;
      ortho.updateProjectionMatrix();
      const dist = radius * 6 + 2000; // ortho scale is distance-independent
      ortho.up.set(up[0], up[1], up[2]);
      ortho.position.set(
        center[0] + (dir[0] / len) * dist,
        center[1] + (dir[1] / len) * dist,
        center[2] + (dir[2] / len) * dist
      );
    }

    // Point the active camera and rebind the controls/gizmo to it.
    activeCamRef.current = cam;
    (orbit as any).object = cam;
    (tc as any).camera = cam;
    orbit.target.set(center[0], center[1], center[2]);
    orbit.update();
  }, [cameraView]);

  // ── reconcile model groups + apply each transform ────────────────────────────
  useEffect(() => {
    const root = modelsRootRef.current;
    if (!root) return;
    const map = modelGroupsRef.current;
    const liveIds = new Set(models.map((m) => m.id));

    // Remove groups for models that no longer exist.
    for (const [id, grp] of [...map.entries()]) {
      if (!liveIds.has(id)) {
        root.remove(grp.pivot);
        disposeGroup(grp.holder);
        map.delete(id);
      }
    }

    // Create groups for new models.
    for (const pm of models) {
      if (map.has(pm.id)) continue;
      const center = centerOf(pm.model);
      const pivot = new THREE.Group();
      pivot.userData.modelId = pm.id;
      const holder = new THREE.Group();
      holder.position.set(-center[0], -center[1], -center[2]);
      const mats: THREE.MeshStandardMaterial[] = [];
      for (const m of pm.model.meshes) {
        const mesh = toThreeMesh(m, 1, true);
        mats.push(mesh.material as THREE.MeshStandardMaterial);
        holder.add(mesh);
      }
      pivot.add(holder);
      root.add(pivot);
      map.set(pm.id, { pivot, holder, center, mats });
    }

    // Apply each model's stored transform (skip the one being dragged).
    const draggedId = draggingRef.current ? selectedModelId : null;
    for (const pm of models) {
      if (pm.id === draggedId) continue;
      const grp = map.get(pm.id);
      if (!grp) continue;
      const { pivot, center } = grp;
      pivot.position.set(
        center[0] + pm.transform.position[0],
        center[1] + pm.transform.position[1],
        center[2] + pm.transform.position[2]
      );
      pivot.rotation.set(
        pm.transform.rotation[0],
        pm.transform.rotation[1],
        pm.transform.rotation[2]
      );
    }

    root.visible = showModel;
  }, [models, showModel, selectedModelId]);

  // ── selection: attach the right gizmo + highlight selected model ──────────────
  useEffect(() => {
    const tc = tcRef.current;
    const map = modelGroupsRef.current;
    const handle = extrudeHandleRef.current;
    if (!tc) return;

    const sil = selectedModelId ? modelSilhouettes[selectedModelId] : undefined;
    const boxPivot = boxPivotRef.current;
    if (step === 1 && selectedModelId && map.get(selectedModelId)) {
      tcTargetRef.current = { kind: "model", id: selectedModelId };
      tc.setMode(gizmoMode);
      tc.showX = tc.showY = tc.showZ = true;
      tc.attach(map.get(selectedModelId)!.pivot);
    } else if (step === 2 && selectedModelId && sil && handle) {
      tcTargetRef.current = { kind: "extrude", id: selectedModelId };
      tc.setMode("translate");
      const ax = sil.field.depthAxis;
      tc.showX = ax === 0;
      tc.showY = ax === 1;
      tc.showZ = ax === 2;
      tc.attach(handle);
    } else if (step === 3 && boxPivot && boxEditMode !== "resize") {
      // Box form move/rotate. (Resize uses the face-arrow handles, not the tc.)
      tcTargetRef.current = { kind: "box", id: null };
      tc.setMode(boxEditMode === "rotate" ? "rotate" : "translate");
      tc.showX = tc.showY = tc.showZ = true;
      tc.attach(boxPivot);
    } else {
      tcTargetRef.current = { kind: "model", id: null };
      tc.detach();
    }

    for (const [id, g] of map.entries()) {
      const on = id === selectedModelId && showModel;
      for (const mat of g.mats) {
        mat.emissive.setHex(on ? 0x4a3000 : 0x000000);
        mat.emissiveIntensity = on ? 1 : 0;
      }
    }
  }, [
    selectedModelId,
    models,
    showModel,
    step,
    modelSilhouettes,
    gizmoMode,
    boxEditMode,
  ]);

  // ── Step 2/3: extruded solids (+ outlines & extrude handle in Step 2) ─────────
  // The Step-2 solids (offset + draft) are shown unchanged in Step 3 at their
  // fixed positions; Step 3 only adds outlines/gizmo in Step 2.
  useEffect(() => {
    const root = silRootRef.current;
    const handle = extrudeHandleRef.current;
    if (!root || !handle) return;
    disposeGroup(root);
    const active = step === 2 || step === 3;
    root.visible = active;
    if (!active) return;

    for (const pm of models) {
      const sil = modelSilhouettes[pm.id];
      if (!sil) continue;
      const selected = pm.id === selectedModelId;
      const base = sil.field.depthBase;

      if (step === 2) {
        // Offset outline as world-space line loops at the base plane.
        const loops = contourAt(sil.field, sil.offset);
        const lineColor = selected ? 0xf0883e : 0x6fa8ff;
        for (const loop of loops) {
          if (loop.length < 2) continue;
          const pts = loop.map((p) => {
            const w = uvToWorld(p[0], p[1], base, sil.view);
            return new THREE.Vector3(w[0], w[1], w[2]);
          });
          const geo = new THREE.BufferGeometry().setFromPoints(pts);
          const line = new THREE.LineLoop(
            geo,
            new THREE.LineBasicMaterial({ color: lineColor, depthTest: false })
          );
          line.renderOrder = 3;
          root.add(line);
        }
      }

      // Extruded solid (more opaque in Step 3 since it's the boolean tool).
      const mesh = buildExtrudeMesh(
        sil,
        selected ? [0.95, 0.55, 0.25] : [0.43, 0.66, 1]
      );
      if (mesh) {
        // Step 3: keep the full solids faint so the bold green cut-preview pops.
        const opacity = step === 3 ? (selected ? 0.26 : 0.2) : selected ? 0.32 : 0.18;
        root.add(toThreeMesh(mesh, opacity));
      }

      // Position the extrude handle at the top-centre of the SELECTED extrusion.
      if (step === 2 && selected) {
        const cu = (sil.field.uvMin[0] + sil.field.uvMax[0]) / 2;
        const cv = (sil.field.uvMin[1] + sil.field.uvMax[1]) / 2;
        const w = uvToWorld(cu, cv, base + sil.extrudeDepth, sil.view);
        handle.position.set(w[0], w[1], w[2]);
      }
    }
  }, [step, models, modelSilhouettes, selectedModelId]);

  // ── block / insert / box preview (steps 4+) ──────────────────────────────────
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    disposeGroup(content);

    const center = combinedCenterXY(models);
    const showBox = step >= 5 && step <= 10;

    // Step 4 / 11 — the boolean result (insert foam). Rendered as an OPAQUE
    // shaded solid with edge lines (CAD "shaded + edges" look) so the cut cavity
    // reads clearly as a recess — no transparency to wash the form out.
    if ((step === 4 || step === 11) && insertFoam.mesh) {
      const foam = toThreeMesh(insertFoam.mesh, 1, true);
      const fmat = foam.material as THREE.MeshStandardMaterial;
      fmat.color.setHex(0x9aa3ad);
      fmat.metalness = 0.0;
      fmat.roughness = 0.85;
      fmat.flatShading = false; // creased normals: smooth curves, hard box edges
      // Push faces slightly back so the edge lines sit crisply on top.
      fmat.polygonOffset = true;
      fmat.polygonOffsetFactor = 1;
      fmat.polygonOffsetUnits = 1;
      content.add(foam);
      // Clean crease-edge overlay (box edges + cavity rim only — no T-junction
      // mess). Weld first so coincident CSG verts pair into shared edges.
      let welded = foam.geometry;
      try {
        welded = mergeVertices(foam.geometry.clone(), 1e-4);
      } catch {
        /* fall back to raw geometry */
      }
      // 45° threshold: keeps the genuine hard edges (box corners ~90°, cavity
      // rim ~85°) but ignores the shallow facet-to-facet seams along the smooth
      // drafted walls, so no stray vertical lines are drawn on the rounding.
      const edges = new THREE.LineSegments(
        creaseEdgesGeometry(welded, 45),
        new THREE.LineBasicMaterial({ color: 0x20262e })
      );
      content.add(edges);
    }

    if (showBox && boxPresetId) {
      const { width, depth, height } = boxSizing;
      const g = new THREE.BoxGeometry(width, height, depth);
      const edges = new THREE.EdgesGeometry(g);
      const line = new THREE.LineSegments(
        edges,
        new THREE.LineBasicMaterial({ color: 0xf0883e })
      );
      line.position.set(center[0], height / 2, center[1]);
      content.add(line);
      const fill = new THREE.Mesh(
        g,
        new THREE.MeshStandardMaterial({
          color: 0xb08d57,
          transparent: true,
          opacity: 0.25,
        })
      );
      fill.position.copy(line.position);
      content.add(fill);
      void getBoxPreset;
    }
  }, [step, models, insertFoam, boxPresetId, boxSizing]);

  // ── Step 3: editable box form (resize face-arrows / move / rotate) ────────────
  useEffect(() => {
    const boxRoot = boxRootRef.current;
    const pivot = boxPivotRef.current;
    if (!boxRoot || !pivot) return;

    const active = step === 3;
    boxRoot.visible = active;
    boxHandlesRef.current = [];
    if (!active) {
      rebuildBoxRef.current = undefined;
      return;
    }

    const sils = models.map((m) => modelSilhouettes[m.id]).filter(Boolean) as
      ModelSilhouette[];
    const pose = resolveBoxPose(boxTransform, sils, boxForm.height);

    // (Re)build the box child meshes at given dims; also used live while dragging
    // a face arrow. Pivot pose is managed separately (below / during drag).
    const buildBoxObjects = (w: number, h: number, d: number) => {
      disposeGroup(pivot);
      boxHandlesRef.current = [];
      boxDimsRef.current = { w, h, d };

      const geo = new THREE.BoxGeometry(w, h, d);
      const fill = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({
          color: 0xbfc6cf,
          metalness: 0.1,
          roughness: 0.6,
          transparent: true,
          opacity: 0.26,
          side: THREE.DoubleSide,
        })
      );
      pivot.add(fill);
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo),
        new THREE.LineBasicMaterial({ color: 0x9fb0c4 })
      );
      pivot.add(edges);

      // Six outward-pointing face arrows (resize handles).
      if (boxModeRef.current === "resize") {
        const len = Math.min(40, Math.max(9, Math.min(w, h, d) * 0.28));
        const rad = len * 0.42;
        const half: [number, number, number] = [w / 2, h / 2, d / 2];
        const faces: Array<{ axis: 0 | 1 | 2; sign: 1 | -1 }> = [
          { axis: 0, sign: 1 },
          { axis: 0, sign: -1 },
          { axis: 1, sign: 1 },
          { axis: 1, sign: -1 },
          { axis: 2, sign: 1 },
          { axis: 2, sign: -1 },
        ];
        for (const { axis, sign } of faces) {
          const cone = new THREE.Mesh(
            new THREE.ConeGeometry(rad, len, 16),
            new THREE.MeshBasicMaterial({ color: 0xffc94d, depthTest: false })
          );
          cone.renderOrder = 6;
          const dir = new THREE.Vector3(0, 0, 0);
          dir.setComponent(axis, sign);
          cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
          const pos = new THREE.Vector3(0, 0, 0);
          pos.setComponent(axis, sign * (half[axis] + len * 0.5 + 1));
          cone.position.copy(pos);
          cone.userData.faceAxis = axis;
          cone.userData.faceSign = sign;
          pivot.add(cone);
          boxHandlesRef.current.push(cone);
        }
      }
    };
    rebuildBoxRef.current = buildBoxObjects;

    // Apply pose from the store (a face-drag mutates the pivot live, so skip it
    // then — its pointer-up commits the final pose back to the store).
    if (pose && !faceDragRef.current?.active) {
      pivot.position.set(pose.position[0], pose.position[1], pose.position[2]);
      pivot.rotation.set(pose.rotation[0], pose.rotation[1], pose.rotation[2]);
    }
    buildBoxObjects(boxForm.width, boxForm.height, boxForm.depth);
  }, [step, models, modelSilhouettes, boxTransform, boxForm, boxEditMode]);

  // ── Step 3: green overlap preview (the part of each solid inside the box) ─────
  // Instead of a CSG intersection (which leaves sliver/spike triangles along the
  // cut), we render the CLEAN Step-2 solid and clip it to the box's 6 planes on
  // the GPU. Clipping is mathematically exact → no protruding faces at all, and
  // it follows box rotation. A thin outline traces the solid's edges in the box.
  useEffect(() => {
    const root = overlapRootRef.current;
    if (!root) return;
    disposeGroup(root);
    if (step !== 3) {
      root.visible = false;
      return;
    }

    const sils = models.map((m) => modelSilhouettes[m.id]).filter(Boolean) as
      ModelSilhouette[];
    const pose = resolveBoxPose(boxTransform, sils, boxForm.height);
    if (!pose || !sils.length) {
      root.visible = false;
      return;
    }

    // Six inward-facing clipping planes = the box interior (honours rotation).
    const C = new THREE.Vector3(pose.position[0], pose.position[1], pose.position[2]);
    const Q = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(pose.rotation[0], pose.rotation[1], pose.rotation[2], "XYZ")
    );
    const half = [boxForm.width / 2, boxForm.height / 2, boxForm.depth / 2];
    const planes: THREE.Plane[] = [];
    for (let a = 0; a < 3; a++) {
      for (const s of [1, -1] as const) {
        const axis = new THREE.Vector3();
        axis.setComponent(a, 1);
        axis.applyQuaternion(Q);
        const faceC = C.clone().add(axis.clone().multiplyScalar(s * half[a]));
        const inward = axis.clone().multiplyScalar(-s);
        planes.push(new THREE.Plane().setFromNormalAndCoplanarPoint(inward, faceC));
      }
    }

    for (const sil of sils) {
      const m = buildExtrudeMesh(sil);
      if (!m) continue;
      // Welded + smooth normals so the clipped solid reads clean (NURBS-like).
      let geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(m.positions.slice(), 3));
      geo.setIndex(new THREE.BufferAttribute(Uint32Array.from(m.indices), 1));
      try {
        geo = mergeVertices(geo, 1e-4);
      } catch {
        /* keep raw geometry */
      }
      geo.computeVertexNormals();

      const fill = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({
          color: 0x9be564,
          emissive: 0x356b18,
          emissiveIntensity: 0.55,
          metalness: 0.0,
          roughness: 0.5,
          transparent: true,
          opacity: 0.55,
          side: THREE.DoubleSide,
          clippingPlanes: planes,
          clipIntersection: false, // keep only the region inside ALL planes
          depthTest: false, // always visible (no spikes now, so this stays clean)
          depthWrite: false,
        })
      );
      fill.renderOrder = 10;
      root.add(fill);

      // Outline: ONLY the top + bottom cap rims of the solid (no wall edges),
      // clipped to the box — the clean horizontal boundary of the cut region.
      const rimMat = new THREE.LineBasicMaterial({
        color: 0xeaffca,
        transparent: true,
        clippingPlanes: planes,
        clipIntersection: false,
        depthTest: false,
        depthWrite: false,
      });
      const caps = extrudeCapLoops(sil);
      for (const loop of [...caps.base, ...caps.top]) {
        if (loop.length < 2) continue;
        const lg = new THREE.BufferGeometry().setFromPoints(
          loop.map((w) => new THREE.Vector3(w[0], w[1], w[2]))
        );
        const line = new THREE.LineLoop(lg, rimMat);
        line.renderOrder = 11;
        root.add(line);
      }
    }
    root.visible = true;
  }, [step, models, modelSilhouettes, boxTransform, boxForm]);

  return <div ref={mountRef} style={{ width: "100%", height: "100%" }} />;
}
