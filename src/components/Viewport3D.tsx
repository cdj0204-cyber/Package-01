import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { useStore } from "../store/useStore";
import { lineArtBridge } from "./lineArtBridge";
import { captureLineArt } from "./lineArtCapture";
import { composeIllustration } from "./illustrationRender";
import type { BoxFace, BoxText, ImportedMesh, PlacedModel } from "../types";
import { type BoxPose } from "../geometry/boolean";
import {
  buildExtrudeMesh,
  contourAt,
  extrudeCapLoops,
  outerLoopsOnly,
  solidsPlacement,
  uvToWorld,
} from "../geometry/silhouetteField";
import type { ModelSilhouette } from "../types";
import { getBoxPreset } from "../box/presets";
import { buildBoxModel } from "../box/boxModel";

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

type ArtXf = {
  scale: number;
  x: number;
  y: number;
  angle: number;
  flipX: boolean;
  flipY: boolean;
};
const DEFAULT_ART_XF: ArtXf = {
  scale: 1,
  x: 0,
  y: 0,
  angle: 0,
  flipX: false,
  flipY: false,
};

/** Set a face-artwork plane's matrix from its on-face transform (scale/move/rot).
 *  `m` is the face-local→world placement; the plane geometry is the base fw×fh. */
function applyArtMatrix(
  mesh: THREE.Mesh,
  m: THREE.Matrix4,
  t: ArtXf | undefined,
  fw: number,
  fh: number
) {
  const s = t ? Math.max(0.05, t.scale) : 1;
  const ang = t ? (t.angle * Math.PI) / 180 : 0;
  const sx = s * (t && t.flipX ? -1 : 1); // horizontal mirror
  const sy = s * (t && t.flipY ? -1 : 1); // vertical mirror
  const local = new THREE.Matrix4().compose(
    new THREE.Vector3(t ? t.x * fw : 0, t ? t.y * fh : 0, 0),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), ang),
    new THREE.Vector3(sx, sy, 1)
  );
  mesh.matrixAutoUpdate = false;
  mesh.matrix.copy(m).multiply(local);
  mesh.matrixWorldNeedsUpdate = true;
}

/**
 * Build the on-face artwork gizmo for the face at placement `m` (size fw×fh):
 * 4 blue MOVE arrows, 4 white SCALE corners, 1 green ROTATE knob. Returns the
 * handle meshes plus a `relayout(t)` that repositions them for a transform — so
 * the gizmo follows the artwork live while dragging without a store round-trip.
 */
function buildArtGizmo(
  m: THREE.Matrix4,
  fw: number,
  fh: number
): { handles: THREE.Mesh[]; relayout: (t: ArtXf) => void } {
  const hs = Math.max(2.5, Math.min(fw, fh) * 0.05);
  const mk = (geo: THREE.BufferGeometry, color: number, gizmo: string) => {
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ color, depthTest: false })
    );
    mesh.renderOrder = 14;
    mesh.userData.gizmo = gizmo;
    return mesh;
  };
  const dirs: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const arrows = dirs.map(() =>
    mk(new THREE.ConeGeometry(hs * 0.95, hs * 2.6, 18), 0x4dabf7, "move")
  );
  const corn: Array<[number, number]> = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
  const corners = corn.map(() =>
    mk(new THREE.BoxGeometry(hs * 1.7, hs * 1.7, hs * 1.7), 0xeceff4, "scale")
  );
  const rotate = mk(new THREE.SphereGeometry(hs * 1.1, 18, 12), 0x66bb6a, "rotate");
  const handles = [...arrows, ...corners, rotate];
  const relayout = (t: ArtXf) => {
    const s = Math.max(0.05, t.scale);
    const ang = (t.angle * Math.PI) / 180;
    const ca = Math.cos(ang),
      sa = Math.sin(ang);
    const cx = t.x * fw,
      cy = t.y * fh;
    const halfX = (fw * s) / 2,
      halfY = (fh * s) / 2;
    const rot = (vx: number, vy: number): [number, number] => [
      vx * ca - vy * sa,
      vx * sa + vy * ca,
    ];
    const place = (lx: number, ly: number) =>
      new THREE.Vector3(cx + lx, cy + ly, 0.8).applyMatrix4(m);
    arrows.forEach((a, i) => {
      const [dx, dy] = dirs[i];
      const [ox, oy] = rot(dx * (halfX + hs * 2.6), dy * (halfY + hs * 2.6));
      a.position.copy(place(ox, oy));
      const [wx, wy] = rot(dx, dy);
      const wd = new THREE.Vector3(wx, wy, 0).transformDirection(m).normalize();
      a.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), wd);
    });
    corners.forEach((c, i) => {
      const [sx, sy] = corn[i];
      const [ox, oy] = rot(sx * halfX, sy * halfY);
      c.position.copy(place(ox, oy));
    });
    const [rx, ry] = rot(0, halfY + hs * 4.5);
    rotate.position.copy(place(rx, ry));
  };
  return { handles, relayout };
}

/** Build a face-text label mesh: render the text to a transparent canvas and put
 *  it on a plane sized to its physical mm, placed on the face by its x/y/angle. */
function buildTextMesh(
  t: BoxText,
  m: THREE.Matrix4,
  fw: number,
  fh: number
): THREE.Mesh | null {
  if (!t.text.trim()) return null;
  const K = 8; // canvas px per mm (crisp text)
  const fontPx = Math.max(4, t.sizeMm * K);
  const fontStr = `${t.weight || 400} ${fontPx}px ${t.font}`;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.font = fontStr;
  const w = Math.ceil(ctx.measureText(t.text).width + fontPx * 0.6);
  const h = Math.ceil(fontPx * 1.35);
  canvas.width = Math.max(2, w);
  canvas.height = Math.max(2, h);
  ctx.font = fontStr; // resizing the canvas resets the context
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = t.color;
  ctx.fillText(t.text, canvas.width / 2, canvas.height / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  const planeW = canvas.width / K;
  const planeH = canvas.height / K;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(planeW, planeH),
    new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    })
  );
  // Anchor: shift the (centred) plane so the chosen LOCAL corner sits at (x,y).
  // x: −X is "left", +X "right"; y: +Y is "top", −Y "bottom" (face-local).
  let px = t.x * fw;
  let py = t.y * fh;
  const a = t.anchor ?? "center";
  if (a === "tl" || a === "bl") px += planeW / 2; // anchor on the −X edge
  if (a === "tr" || a === "br") px -= planeW / 2; // anchor on the +X edge
  if (a === "tl" || a === "tr") py -= planeH / 2; // anchor on the +Y edge
  if (a === "bl" || a === "br") py += planeH / 2; // anchor on the −Y edge
  const local = new THREE.Matrix4().compose(
    new THREE.Vector3(px, py, 0.6),
    new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 0, 1),
      (t.angle * Math.PI) / 180
    ),
    new THREE.Vector3(t.flipX ? -1 : 1, t.flipY ? -1 : 1, 1)
  );
  mesh.applyMatrix4(local);
  mesh.applyMatrix4(m);
  return mesh;
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
  const rendererRef = useRef<THREE.WebGLRenderer>();
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
  // Step-8 on-face artwork gizmo: handle meshes + the face frame for hit→UV maths.
  const artGizmoRef = useRef<{
    handles: THREE.Mesh[];
    faceKey: BoxFace;
    m: THREE.Matrix4; // face-local → world
    mInv: THREE.Matrix4; // world → face-local
    plane: THREE.Plane; // the face plane, in world space
    fw: number;
    fh: number;
    planeMesh: THREE.Mesh; // the artwork plane (updated live during drag)
    relayout: (t: ArtXf) => void; // reposition handles for a transform
  } | null>(null);
  const artDragRef = useRef<{
    mode: "move" | "scale" | "rotate";
    t0: ArtXf;
    live: ArtXf;
    centerLocal: THREE.Vector2; // artwork centre in face-local mm
    grab: THREE.Vector2; // grab point in face-local mm
    d0: number; // |grab − centre| for scale
    a0: number; // atan2 of (grab − centre) for rotate
  } | null>(null);
  // Lid-fold animation: current fold (0 open → 1 closed) + a box-rebuild hook.
  const foldRef = useRef(useStore.getState().boxClosed ? 1 : 0);
  const boxRebuildRef = useRef<((fold: number) => void) | null>(null);
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
  const boxLidSide = useStore((s) => s.boxLidSide);
  const step7View = useStore((s) => s.step7View);
  const savedIllustrations = useStore((s) => s.savedIllustrations);
  const boxFaceArtwork = useStore((s) => s.boxFaceArtwork);
  const boxFaceTransform = useStore((s) => s.boxFaceTransform);
  const boxTexts = useStore((s) => s.boxTexts);
  const boxSelectedFace = useStore((s) => s.boxSelectedFace);
  // Bumped once web fonts (Montserrat) finish loading, so face-text canvases
  // re-render with the real font instead of a fallback.
  const [fontsReady, setFontsReady] = useState(0);
  useEffect(() => {
    let alive = true;
    const f = (document as Document & { fonts?: { ready?: Promise<unknown> } })
      .fonts;
    f?.ready?.then(() => {
      if (alive) setFontsReady((v) => v + 1);
    });
    return () => {
      alive = false;
    };
  }, []);
  const boxClosed = useStore((s) => s.boxClosed);
  const lightContrast = useStore((s) => s.lightContrast);
  const gizmoMode = useStore((s) => s.gizmoMode);
  const cameraView = useStore((s) => s.cameraView);

  // Raw product models: Step 1-2 placement, and Step 7 "product" mode (viewing
  // the product to extract its line drawing). Step 7 "box" mode shows the box
  // with the illustration applied instead.
  // The box-design stages (5 box type, 6 sizing, 8 render) show the whole package
  // assembled — imported product + insert foam + box together — so you can judge
  // the fit from the moment you pick a box type.
  const showAssembly = step >= 5 && step <= 8 && step !== 7;
  // Step 3 also shows the imported product (as a faint ghost) so you can gauge how
  // large the foam must be to contain it; Step 4 keeps the ghost so you can check
  // the cut cavity against the product it was cut for.
  const showModel =
    step <= 4 || (step === 7 && step7View === "product") || showAssembly;
  const boxVisible = showAssembly || (step === 7 && step7View === "box");

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
    rendererRef.current = renderer;
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
      // Step-8: grab an on-face artwork gizmo handle (move / scale / rotate).
      if (stepRef.current === 8 && artGizmoRef.current) {
        setPointer(e);
        const ag = artGizmoRef.current;
        const hits = raycaster.intersectObjects(ag.handles, false);
        if (hits.length) {
          const mode = hits[0].object.userData.gizmo as
            | "move"
            | "scale"
            | "rotate";
          const t0 =
            useStore.getState().boxFaceTransform[ag.faceKey] ?? DEFAULT_ART_XF;
          const hitW = new THREE.Vector3();
          if (raycaster.ray.intersectPlane(ag.plane, hitW)) {
            const gl = hitW.applyMatrix4(ag.mInv);
            const centerLocal = new THREE.Vector2(t0.x * ag.fw, t0.y * ag.fh);
            const grab = new THREE.Vector2(gl.x, gl.y);
            artDragRef.current = {
              mode,
              t0: { ...t0 },
              live: { ...t0 },
              centerLocal,
              grab,
              d0: Math.max(1e-3, grab.distanceTo(centerLocal)),
              a0: Math.atan2(grab.y - centerLocal.y, grab.x - centerLocal.x),
            };
            orbit.enabled = false;
            draggingRef.current = true;
            down = null;
            return;
          }
        }
      }

      down = { x: e.clientX, y: e.clientY, gizmo: (tc as any).axis != null };
    };

    const clampN = (v: number, lo: number, hi: number) =>
      Math.max(lo, Math.min(hi, v));

    const onPointerMove = (e: PointerEvent) => {
      // Step-8: drag an artwork gizmo handle — update plane + handles live.
      const ad = artDragRef.current;
      const ag = artGizmoRef.current;
      if (ad && ag) {
        setPointer(e);
        const hitW = new THREE.Vector3();
        if (!raycaster.ray.intersectPlane(ag.plane, hitW)) return;
        const hl = hitW.applyMatrix4(ag.mInv);
        const next: ArtXf = { ...ad.t0 };
        if (ad.mode === "move") {
          next.x = clampN(
            (ad.t0.x * ag.fw + (hl.x - ad.grab.x)) / ag.fw,
            -1,
            1
          );
          next.y = clampN(
            (ad.t0.y * ag.fh + (hl.y - ad.grab.y)) / ag.fh,
            -1,
            1
          );
        } else if (ad.mode === "scale") {
          const d = Math.hypot(hl.x - ad.centerLocal.x, hl.y - ad.centerLocal.y);
          next.scale = clampN((ad.t0.scale * d) / ad.d0, 0.1, 5);
        } else {
          const a = Math.atan2(
            hl.y - ad.centerLocal.y,
            hl.x - ad.centerLocal.x
          );
          let deg = ad.t0.angle + ((a - ad.a0) * 180) / Math.PI;
          while (deg > 180) deg -= 360;
          while (deg < -180) deg += 360;
          next.angle = deg;
        }
        ad.live = next;
        applyArtMatrix(ag.planeMesh, ag.m, next, ag.fw, ag.fh);
        ag.relayout(next);
        return;
      }

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
      // Finish an artwork gizmo drag → commit the transform to the store.
      const ad = artDragRef.current;
      if (ad) {
        const ag = artGizmoRef.current;
        artDragRef.current = null;
        draggingRef.current = false;
        orbit.enabled = true;
        if (ag) useStore.getState().setBoxFaceTransform(ag.faceKey, ad.live);
        return;
      }

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
  // Live models ref so framing reads the latest geometry without re-running on
  // every transform edit (which would fight the gizmo while dragging).
  const modelsLiveRef = useRef(models);
  modelsLiveRef.current = models;
  const frameCurrentView = useCallback(() => {
    const persp = perspRef.current;
    const ortho = orthoRef.current;
    const orbit = orbitRef.current;
    const tc = tcRef.current;
    const mount = mountRef.current;
    if (!persp || !ortho || !orbit || !tc || !mount) return;

    const { center, radius } = combinedBox(modelsLiveRef.current);
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

  // Re-frame whenever the viewpoint changes, and when entering Step 7 (so the
  // product is centred in the chosen view ready for outline extraction).
  useEffect(() => {
    frameCurrentView();
  }, [frameCurrentView]);
  useEffect(() => {
    if (step === 7 && step7View === "product") frameCurrentView();
  }, [step, step7View, frameCurrentView]);

  // Register the Step-7 line-art capture: project a model through the CURRENT
  // camera (perspective or any face, incl. manual orbit) into FOUR stackable
  // illustration layers — outer silhouette, shaded raster, feature edges, and
  // mesh wireframe — all registered together so they line up. Refs are stable.
  useEffect(() => {
    lineArtBridge.capture = (modelId: string) =>
      captureLineArt(
        modelId,
        rendererRef.current,
        sceneRef.current,
        modelsRootRef.current,
        modelGroupsRef.current.get(modelId),
        activeCamRef.current,
        mountRef.current
      );
    // Preset capture: build a throwaway orthographic camera framed on the model
    // from the requested face and project through it (live camera untouched).
    lineArtBridge.captureView = (modelId, view) => {
      const grp = modelGroupsRef.current.get(modelId);
      const mount = mountRef.current;
      if (!grp || !mount) return null;
      const { center, radius } = combinedBox(modelsLiveRef.current);
      const vd = VIEW_DIRS[view] ?? VIEW_DIRS.perspective;
      const a = (mount.clientWidth || 1) / (mount.clientHeight || 1);
      const viewSize = Math.max(40, radius * 1.25);
      const cam = new THREE.OrthographicCamera(
        -viewSize * a,
        viewSize * a,
        viewSize,
        -viewSize,
        0.1,
        radius * 40 + 20000
      );
      const len = Math.hypot(vd.dir[0], vd.dir[1], vd.dir[2]) || 1;
      const dist = radius * 6 + 2000;
      cam.up.set(vd.up[0], vd.up[1], vd.up[2]);
      cam.position.set(
        center[0] + (vd.dir[0] / len) * dist,
        center[1] + (vd.dir[1] / len) * dist,
        center[2] + (vd.dir[2] / len) * dist
      );
      cam.lookAt(center[0], center[1], center[2]);
      cam.updateMatrixWorld(true);
      cam.updateProjectionMatrix();
      return captureLineArt(
        modelId,
        rendererRef.current,
        sceneRef.current,
        modelsRootRef.current,
        grp,
        cam,
        mount
      );
    };
    return () => {
      lineArtBridge.capture = null;
      lineArtBridge.captureView = null;
    };
  }, []);

  // ── frame the assembled box whenever it becomes visible (box 3D steps, and
  // Step 7's "box" preview mode) ───────────────────────────────────────────────
  const prevBoxVisRef = useRef(false);
  useEffect(() => {
    const wasVisible = prevBoxVisRef.current;
    prevBoxVisRef.current = boxVisible;
    if (!boxVisible || wasVisible || !boxPresetId) return;
    const persp = perspRef.current;
    const ortho = orthoRef.current;
    const orbit = orbitRef.current;
    const mount = mountRef.current;
    if (!persp || !ortho || !orbit || !mount) return;
    const c = combinedCenterXY(models);
    const { width: bw, depth: bd, height: bh } = boxSizing;
    const cy = bh * 0.55; // lids extend above, so aim a touch above mid-height
    const target = new THREE.Vector3(c[0], cy, c[1]);
    // Bounding-sphere radius of the box + its open lid (which reaches ~2.2·H up).
    const radius = 0.5 * (Math.hypot(bw, bh * 2.2, bd) || 240);
    const dir = new THREE.Vector3(0.72, 0.5, 0.95).normalize();
    if (activeCamRef.current === ortho) {
      const a = mount.clientWidth / mount.clientHeight;
      const vs = Math.max(40, radius * 1.15);
      viewSizeRef.current = vs;
      ortho.left = -vs * a;
      ortho.right = vs * a;
      ortho.top = vs;
      ortho.bottom = -vs;
      ortho.updateProjectionMatrix();
      ortho.position
        .copy(target)
        .add(dir.clone().multiplyScalar(radius * 6 + 2000));
    } else {
      persp.position.copy(target).add(dir.multiplyScalar(Math.max(240, radius * 3.1)));
    }
    orbit.target.copy(target);
    orbit.update();
  }, [boxVisible, boxPresetId, models, boxSizing]);

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
    const modelGizmoStep =
      step === 1 || (step === 7 && step7View === "product");
    if (modelGizmoStep && selectedModelId && map.get(selectedModelId)) {
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

    // In Step 3 the product is a faint reference ghost under the box form, and in
    // Step 4 it stays ghosted inside the cut foam so the cavity fit is visible.
    const ghost = step === 3 || step === 4;
    for (const [id, g] of map.entries()) {
      const on = id === selectedModelId && showModel && !ghost;
      for (const mat of g.mats) {
        mat.emissive.setHex(on ? 0x4a3000 : 0x000000);
        mat.emissiveIntensity = on ? 1 : 0;
        if (mat.transparent !== ghost || mat.opacity !== (ghost ? 0.7 : 1)) {
          mat.transparent = ghost;
          mat.opacity = ghost ? 0.7 : 1;
          mat.depthWrite = !ghost;
          mat.needsUpdate = true;
        }
      }
    }
  }, [
    selectedModelId,
    models,
    showModel,
    step,
    step7View,
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
        // Offset outline as world-space line loops at the base plane (outer
        // profile only — internal holes are ignored for the insert-foam solid).
        const loops = outerLoopsOnly(contourAt(sil.field, sil.offset));
        const lineColor = selected ? 0x4dabf7 : 0x55708e;
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
    const showBox = boxVisible;

    // Step 4 / 10 — the boolean result (insert foam). Rendered as an OPAQUE
    // shaded solid with edge lines (CAD "shaded + edges" look) so the cut cavity
    // reads clearly as a recess. The box-design stages also show it (assembled
    // package view).
    if ((step === 4 || step === 10 || showAssembly) && insertFoam.mesh) {
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

    // Steps 5–7 — the chosen box family shown ASSEMBLED with lids/flaps ajar, and
    // rendered as real corrugated board: every panel is extruded to board
    // thickness with darker brown flute edges (vertex-coloured), so it reads as a
    // realistic cardboard box rather than a flat cuboid.
    // Build the box group at a given lid-fold factor (0 open → 1 closed). Kept as
    // a closure so the fold animation can rebuild just the box each frame.
    const makeBox = (fold: number): THREE.Group | null => {
      if (!(showBox && boxPresetId)) return null;
      const preset = getBoxPreset(boxPresetId);
      const kind = preset?.dielineKind ?? "tuck-end-rte";
      const { width: bw, depth: bd, height: bh } = boxSizing;
      const model = buildBoxModel(kind, bw, bd, bh, boxLidSide, fold);
      const group = new THREE.Group();
      // Assembled package view: wrap the box around the ACTUAL insert foam —
      // centre it on the foam's X/Z and floor it at the foam's min Y — so the
      // foam (and the product nested in it) sits inside the box. Other steps keep
      // the box on the ground centred on the models.
      let bx = center[0],
        bz = center[1],
        baseY = 0;
      if (showAssembly && insertFoam.mesh) {
        const p = insertFoam.mesh.positions;
        let mnx = Infinity,
          mny = Infinity,
          mnz = Infinity,
          mxx = -Infinity,
          mxz = -Infinity;
        for (let i = 0; i < p.length; i += 3) {
          const x = p[i],
            y = p[i + 1],
            z = p[i + 2];
          if (x < mnx) mnx = x;
          if (y < mny) mny = y;
          if (z < mnz) mnz = z;
          if (x > mxx) mxx = x;
          if (z > mxz) mxz = z;
        }
        if (isFinite(mnx)) {
          bx = (mnx + mxx) / 2;
          bz = (mnz + mxz) / 2;
          baseY = mny;
        }
      }
      group.position.set(bx, baseY, bz);
      // World matrix of the group's origin offset (for the gizmo's world-space
      // face plane / hit→UV maths, since artwork planes live under this group).
      const groupWorld = new THREE.Matrix4().makeTranslation(bx, baseY, bz);

      const t = 3; // board thickness 3 mm (side walls doubled to 6 mm below)
      const face: [number, number, number] = model.color;
      const edge: [number, number, number] = [
        face[0] * 0.55,
        face[1] * 0.5,
        face[2] * 0.45,
      ]; // darker flute edge
      const pos: number[] = [];
      const col: number[] = [];
      const v3 = new THREE.Vector3();
      const e1 = new THREE.Vector3();
      const e2 = new THREE.Vector3();
      const push = (p: number[], c: [number, number, number]) => {
        pos.push(p[0], p[1], p[2]);
        col.push(c[0], c[1], c[2]);
      };
      const tri = (
        a: number[],
        b: number[],
        c: number[],
        cl: [number, number, number]
      ) => {
        push(a, cl);
        push(b, cl);
        push(c, cl);
      };
      for (const q of model.faces) {
        const n = q.length; // panels may be quads or rounded N-gons
        // panel normal (first edge × last edge, valid for any convex polygon)
        e1.set(q[1][0] - q[0][0], q[1][1] - q[0][1], q[1][2] - q[0][2]);
        e2.set(
          q[n - 1][0] - q[0][0],
          q[n - 1][1] - q[0][1],
          q[n - 1][2] - q[0][2]
        );
        v3.copy(e1).cross(e2).normalize();
        // Side walls get double board thickness, per request. Only the true
        // axis-aligned ±X walls have |nx| == 1; tilted lid/tuck wings never do,
        // so a tight threshold targets the side walls alone.
        const tf = Math.abs(v3.x) > 0.999 ? t * 2 : t;
        const o: number[] = [(v3.x * tf) / 2, (v3.y * tf) / 2, (v3.z * tf) / 2];
        const f = q.map((p) => [p[0] + o[0], p[1] + o[1], p[2] + o[2]]);
        const bk = q.map((p) => [p[0] - o[0], p[1] - o[1], p[2] - o[2]]);
        // front + back broad faces (kraft) — triangle fan from vertex 0
        for (let i = 1; i < n - 1; i++) {
          tri(f[0], f[i], f[i + 1], face);
          tri(bk[0], bk[i + 1], bk[i], face);
        }
        // flute edges (brown) — one per polygon edge
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          tri(f[i], f[j], bk[j], edge);
          tri(f[i], bk[j], bk[i], edge);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({
          vertexColors: true,
          roughness: 0.88,
          metalness: 0,
          side: THREE.DoubleSide,
        })
      );
      group.add(mesh);

      // Apply saved illustrations assigned to box faces (Step 8) as flat,
      // background-filled printed panels covering each chosen face.
      const EPS = 0.6;
      const sideT = t * 2; // doubled side walls
      const faceDefs: Partial<Record<
        BoxFace,
        { size: [number, number]; pos: [number, number, number]; rot: [number, number, number] }
      >> = {
        front: { size: [bw, bh], pos: [0, bh / 2, bd / 2 + t / 2 + EPS], rot: [0, 0, 0] },
        back: { size: [bw, bh], pos: [0, bh / 2, -bd / 2 - t / 2 - EPS], rot: [0, Math.PI, 0] },
        right: { size: [bd, bh], pos: [bw / 2 + sideT / 2 + EPS, bh / 2, 0], rot: [0, Math.PI / 2, 0] },
        left: { size: [bd, bh], pos: [-bw / 2 - sideT / 2 - EPS, bh / 2, 0], rot: [0, -Math.PI / 2, 0] },
        top: { size: [bw, bd], pos: [0, bh + t / 2 + EPS, 0], rot: [-Math.PI / 2, 0, 0] },
      };
      // Oriented placement on an arbitrary panel quad [h0,h1,f1,f0] (used for the
      // tilted lid and the front tuck flap). Lands the decal on the OUTER face.
      const quadPlacement = (quad: [number, number, number][]) => {
        const toV = (p: [number, number, number]) => new THREE.Vector3(p[0], p[1], p[2]);
        const [H0, H1, , F0] = quad.map(toV);
        const hinge = new THREE.Vector3().subVectors(H1, H0); // along the hinge
        const along = new THREE.Vector3().subVectors(F0, H0); // hinge → free edge
        const fw = hinge.length() || 1;
        const fh = along.length() || 1;
        const ctr = quad.reduce((acc, p) => acc.add(toV(p)), new THREE.Vector3()).multiplyScalar(0.25);
        const outward = ctr.clone().sub(new THREE.Vector3(0, bh / 2, 0)); // away from body
        const aUnit = along.clone().normalize();
        const vAxis = aUnit.y >= 0 ? aUnit.clone() : aUnit.clone().multiplyScalar(-1); // up
        let nAxis = new THREE.Vector3().crossVectors(hinge.clone().normalize(), aUnit).normalize();
        if (nAxis.dot(outward) < 0) nAxis.multiplyScalar(-1); // face outward
        let uAxis = hinge.clone().normalize();
        if (new THREE.Vector3().crossVectors(uAxis, vAxis).dot(nAxis) < 0) uAxis.multiplyScalar(-1);
        nAxis = new THREE.Vector3().crossVectors(uAxis, vAxis).normalize();
        const center = ctr.clone().addScaledVector(nAxis, t / 2 + EPS);
        const m = new THREE.Matrix4().makeBasis(uAxis, vAxis, nAxis).setPosition(center);
        return { fw, fh, m };
      };
      // Placement (size + world transform) for a face. "top" maps to the tilted lid
      // panel and "tuck" to the front tuck flap (g-type); others are flat body faces.
      const facePlacement = (
        faceKey: BoxFace
      ): { fw: number; fh: number; m: THREE.Matrix4 } | null => {
        const quad =
          faceKey === "top" ? model.lidQuad : faceKey === "tuck" ? model.tuckQuad : null;
        if (faceKey === "tuck") return quad && quad.length >= 4 ? quadPlacement(quad) : null;
        if (faceKey === "top" && quad && quad.length >= 4) return quadPlacement(quad);
        const def = faceDefs[faceKey];
        if (!def) return null;
        const m = new THREE.Matrix4()
          .makeRotationFromEuler(new THREE.Euler(def.rot[0], def.rot[1], def.rot[2]))
          .setPosition(def.pos[0], def.pos[1], def.pos[2]);
        return { fw: def.size[0], fh: def.size[1], m };
      };

      artGizmoRef.current = null; // rebuilt below for the selected face (step 8)
      for (const faceKey of Object.keys(boxFaceArtwork) as BoxFace[]) {
        // The front face is covered by the tuck flap once closing past halfway, so
        // hide its illustration there (the tuck face carries the closed-front art).
        if (faceKey === "front" && fold > 0.5) continue;
        const illId = boxFaceArtwork[faceKey];
        const saved = savedIllustrations.find((s) => s.id === illId);
        if (!saved) continue;
        const placement = facePlacement(faceKey);
        if (!placement) continue;
        const { fw, fh, m } = placement;
        const TEXW = 640;
        const TEXH = Math.max(1, Math.round((TEXW * fh) / fw));
        let tex: THREE.CanvasTexture | null = null;
        const canvas = composeIllustration(saved.lineArt, saved.background, TEXW, TEXH, () => {
          if (tex) tex.needsUpdate = true;
        });
        tex = new THREE.CanvasTexture(canvas);
        tex.needsUpdate = true;
        // On-face transform (scale/move/rotate) baked into the plane's matrix.
        const t = boxFaceTransform[faceKey];
        const plane = new THREE.Mesh(
          new THREE.PlaneGeometry(fw, fh),
          new THREE.MeshBasicMaterial({
            map: tex,
            side: THREE.DoubleSide,
            depthWrite: false,
            // Honour the texture's alpha so transparent-PNG uploads (empty
            // background) reveal the box surface; opaque Step-7 illustrations
            // (filled background) are unaffected.
            transparent: true,
          })
        );
        applyArtMatrix(plane, m, t, fw, fh);
        group.add(plane);

        // Step-8: draw the interactive gizmo on the selected face's artwork.
        if (step === 8 && faceKey === boxSelectedFace) {
          const giz = buildArtGizmo(m, fw, fh);
          giz.relayout(t ?? DEFAULT_ART_XF);
          for (const h of giz.handles) group.add(h);
          // Handles + artwork plane live UNDER `group` (offset by groupWorld), so
          // the raycast plane and world→face-local maths must include that offset.
          const worldM = groupWorld.clone().multiply(m);
          const origin = new THREE.Vector3().applyMatrix4(worldM);
          const nWorld = new THREE.Vector3(0, 0, 1)
            .transformDirection(worldM)
            .normalize();
          artGizmoRef.current = {
            handles: giz.handles,
            faceKey,
            m, // local (for relayout / applyArtMatrix under the group)
            mInv: worldM.clone().invert(), // world → face-local
            plane: new THREE.Plane().setFromNormalAndCoplanarPoint(nWorld, origin),
            fw,
            fh,
            planeMesh: plane,
            relayout: giz.relayout,
          };
        }
      }

      // Text labels placed on the box faces (Step 8).
      for (const tx of boxTexts) {
        if (tx.face === "front" && fold > 0.5) continue; // hidden once closed
        const placement = facePlacement(tx.face);
        if (!placement) continue;
        const mesh = buildTextMesh(tx, placement.m, placement.fw, placement.fh);
        if (mesh) group.add(mesh);
      }

      return group;
    };

    // Mount the box at the current fold, and expose a rebuild fn for the fold
    // animation to call each frame.
    let boxGroup = makeBox(foldRef.current);
    if (boxGroup) content.add(boxGroup);
    boxRebuildRef.current =
      showBox && boxPresetId
        ? (fold: number) => {
            if (boxGroup) {
              content.remove(boxGroup);
              disposeGroup(boxGroup);
            }
            boxGroup = makeBox(fold);
            if (boxGroup) content.add(boxGroup);
          }
        : null;
  }, [step, models, insertFoam, boxPresetId, boxSizing, boxLidSide, boxVisible, savedIllustrations, boxFaceArtwork, boxFaceTransform, boxTexts, boxSelectedFace, fontsReady]);

  // ── Step 8: animate the G-type lid open ⇄ closed when the toggle flips ─────────
  useEffect(() => {
    const target = boxClosed ? 1 : 0;
    const from = foldRef.current;
    if (Math.abs(from - target) < 1e-4) {
      foldRef.current = target;
      return;
    }
    let raf = 0;
    let startT = 0;
    const dur = 650;
    const ease = (t: number) =>
      t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // easeInOutQuad
    const tick = (now: number) => {
      if (!startT) startT = now;
      const t = Math.min(1, (now - startT) / dur);
      foldRef.current = from + (target - from) * ease(t);
      boxRebuildRef.current?.(foldRef.current);
      if (t < 1) raf = requestAnimationFrame(tick);
      else {
        foldRef.current = target;
        boxRebuildRef.current?.(target);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [boxClosed]);

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
