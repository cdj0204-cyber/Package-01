import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { useStore } from "../store/useStore";
import type { ImportedMesh, PlacedModel } from "../types";
import { buildBlockMesh } from "../geometry/boolean";
import { buildDraftedPlug } from "../geometry/draft";
import {
  buildExtrudeMesh,
  contourAt,
  uvToWorld,
} from "../geometry/silhouetteField";
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
  // What the transform gizmo currently drives.
  const tcTargetRef = useRef<{ kind: "model" | "extrude"; id: string | null }>({
    kind: "model",
    id: null,
  });

  const step = useStore((s) => s.currentStep);
  const models = useStore((s) => s.models);
  const selectedModelId = useStore((s) => s.selectedModelId);
  const modelSilhouettes = useStore((s) => s.modelSilhouettes);
  const silhouettes = useStore((s) => s.silhouettes);
  const drafts = useStore((s) => s.drafts);
  const boxForm = useStore((s) => s.boxForm);
  const boxPresetId = useStore((s) => s.boxPresetId);
  const boxSizing = useStore((s) => s.boxSizing);
  const lightContrast = useStore((s) => s.lightContrast);
  const gizmoMode = useStore((s) => s.gizmoMode);
  const cameraView = useStore((s) => s.cameraView);

  const showModel = step <= 3;

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

    // Click-to-select models (ignore drags and gizmo-handle interactions).
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    let down: { x: number; y: number; gizmo: boolean } | null = null;
    const onPointerDown = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY, gizmo: (tc as any).axis != null };
    };
    const onPointerUp = (e: PointerEvent) => {
      const d = down;
      down = null;
      if (!d) return;
      const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y);
      if (moved > 5 || d.gizmo || draggingRef.current) return;
      const root = modelsRootRef.current;
      if (!root || !root.visible) return;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, activeCamRef.current!);
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
  }, [selectedModelId, models, showModel, step, modelSilhouettes, gizmoMode]);

  // ── step 2: silhouette outlines + extruded solids + extrude handle ────────────
  useEffect(() => {
    const root = silRootRef.current;
    const handle = extrudeHandleRef.current;
    if (!root || !handle) return;
    disposeGroup(root);
    root.visible = step === 2;
    if (step !== 2) return;

    for (const pm of models) {
      const sil = modelSilhouettes[pm.id];
      if (!sil) continue;
      const selected = pm.id === selectedModelId;
      const base = sil.field.depthBase;

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
          new THREE.LineBasicMaterial({
            color: lineColor,
            depthTest: false,
          })
        );
        line.renderOrder = 3;
        root.add(line);
      }

      // Extruded solid preview.
      const mesh = buildExtrudeMesh(
        sil,
        selected ? [0.95, 0.55, 0.25] : [0.43, 0.66, 1]
      );
      if (mesh) {
        const tm = toThreeMesh(mesh, selected ? 0.32 : 0.18);
        root.add(tm);
      }

      // Position the extrude handle at the top-centre of the SELECTED extrusion.
      if (selected) {
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
    const showInsert = step === 4 || step === 5 || step === 12;
    const showBox = step >= 6 && step <= 11;

    if (showInsert && models.length) {
      const block = buildBlockMesh(boxForm, center);
      content.add(toThreeMesh(block, 0.35));
      const sil = silhouettes.top ?? Object.values(silhouettes)[0];
      const draft = drafts.top ?? Object.values(drafts)[0];
      if (sil && draft) {
        const plug = buildDraftedPlug(sil, draft, boxForm.height);
        content.add(toThreeMesh(plug, 0.9));
      }
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
  }, [step, models, silhouettes, drafts, boxForm, boxPresetId, boxSizing]);

  return <div ref={mountRef} style={{ width: "100%", height: "100%" }} />;
}
