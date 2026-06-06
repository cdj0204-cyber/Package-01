import * as THREE from "three";
import type { LineArt, LineArtLayer } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Step-7 illustration capture. Project the chosen product into four registered
// layers from the CURRENT viewpoint:
//   • silhouette — outer/contour line (edges where facing flips)
//   • shaded     — the lit render, as a cropped raster image
//   • edges      — feature edges (≥30° dihedral) on the camera-facing side
//   • wireframe  — every mesh edge on the camera-facing side
// Edge/wireframe HIDDEN-LINE removal is done by FACE ORIENTATION: an edge is kept
// only if at least one of its adjacent triangles faces the camera, so back-side
// edges are dropped (robust for convex parts, no depth-buffer precision issues).
// Vector layers are stored in NDC (-1..1, y up); the raster fills the NDC bbox.
// ─────────────────────────────────────────────────────────────────────────────

type Seg = [[number, number], [number, number]];
const FEATURE_COS = Math.cos((30 * Math.PI) / 180); // dihedral ≥ 30° ⇒ feature edge

export function captureLineArt(
  _modelId: string,
  renderer: THREE.WebGLRenderer | undefined,
  scene: THREE.Scene | undefined,
  modelsRoot: THREE.Object3D | undefined,
  grp: { pivot: THREE.Object3D } | undefined,
  cam: THREE.Camera | undefined,
  mount: HTMLElement | null
): LineArt | null {
  if (!renderer || !scene || !modelsRoot || !grp || !cam || !mount) return null;

  cam.updateMatrixWorld(true);
  cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
  grp.pivot.updateMatrixWorld(true);
  const aspect = (mount.clientWidth || 1) / (mount.clientHeight || 1);

  const meshes: THREE.Mesh[] = [];
  grp.pivot.traverse((o) => {
    const m = o as THREE.Mesh;
    if ((m as any).isMesh && m.geometry) meshes.push(m);
  });
  if (!meshes.length) return null;

  const silSegs: Seg[] = [];
  const edgeSegs: Seg[] = [];
  const wireSegs: Seg[] = [];
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  const acc = (x: number, y: number) => {
    if (x < minx) minx = x;
    if (x > maxx) maxx = x;
    if (y < miny) miny = y;
    if (y > maxy) maxy = y;
  };

  for (const mesh of meshes) {
    classifyEdges(mesh, cam, silSegs, edgeSegs, wireSegs, acc);
  }
  if (!isFinite(minx)) return null;
  const bbox = { min: [minx, miny] as [number, number], max: [maxx, maxy] as [number, number] };

  // Capture a flat albedo + a view-space normal map so the shaded layer can be
  // re-lit (brightness/contrast/light direction) in 2D later.
  const albedo = renderCropped(renderer, scene, modelsRoot, cam, mount, bbox, () => swapBasic(modelsRoot));
  const normal = renderCropped(renderer, scene, modelsRoot, cam, mount, bbox, () => overrideMat(scene, new THREE.MeshNormalMaterial()));

  const layers: LineArtLayer[] = [
    { kind: "silhouette", enabled: false, opacity: 1, segments: silSegs },
    {
      kind: "shaded",
      enabled: false,
      opacity: 1,
      ...(albedo ? { image: albedo, albedoImage: albedo } : {}),
      ...(normal ? { normalImage: normal } : {}),
      brightness: 1,
      contrast: 1,
      lightX: 0.35,
      lightY: 0.45,
    },
    { kind: "edges", enabled: true, opacity: 1, segments: edgeSegs },
    { kind: "wireframe", enabled: false, opacity: 0.4, segments: wireSegs },
  ];
  return { bbox, aspect, layers };
}

interface Edge {
  p0: THREE.Vector3;
  p1: THREE.Vector3;
  n0: THREE.Vector3; // first adjacent face normal (unit)
  n1: THREE.Vector3 | null; // second adjacent face normal (unit)
  hasFront: boolean;
  hasBack: boolean;
  count: number;
}

// Build the per-edge map (adjacent face normals + camera-facing), then emit the
// silhouette / feature-edge / wireframe segment sets.
function classifyEdges(
  mesh: THREE.Mesh,
  cam: THREE.Camera,
  sil: Seg[],
  edges: Seg[],
  wire: Seg[],
  acc: (x: number, y: number) => void
) {
  const geom = mesh.geometry;
  const posAttr = geom.getAttribute("position");
  if (!posAttr) return;
  const index = geom.getIndex();
  const triCount = index ? Math.floor(index.count / 3) : Math.floor(posAttr.count / 3);
  const mat = mesh.matrixWorld;
  const isPersp = !!(cam as any).isPerspectiveCamera;
  const camPos = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
  const camDir = new THREE.Vector3();
  cam.getWorldDirection(camDir);

  const vi = (k: number) => (index ? index.getX(k) : k);
  const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), nrm = new THREE.Vector3();
  const view = new THREE.Vector3(), ctr = new THREE.Vector3();

  const map = new Map<string, Edge>();
  const q = (x: number) => Math.round(x * 100); // 0.01 mm quantization
  const addEdge = (p: THREE.Vector3, r: THREE.Vector3, n: THREE.Vector3, front: boolean) => {
    const ka = `${q(p.x)},${q(p.y)},${q(p.z)}`;
    const kb = `${q(r.x)},${q(r.y)},${q(r.z)}`;
    const key = ka < kb ? ka + "|" + kb : kb + "|" + ka;
    let e = map.get(key);
    if (!e) {
      e = { p0: p.clone(), p1: r.clone(), n0: n.clone(), n1: null, hasFront: false, hasBack: false, count: 0 };
      map.set(key, e);
    } else if (e.count === 1) {
      e.n1 = n.clone();
    }
    if (front) e.hasFront = true;
    else e.hasBack = true;
    e.count++;
  };

  for (let t = 0; t < triCount; t++) {
    A.fromBufferAttribute(posAttr, vi(t * 3)).applyMatrix4(mat);
    B.fromBufferAttribute(posAttr, vi(t * 3 + 1)).applyMatrix4(mat);
    C.fromBufferAttribute(posAttr, vi(t * 3 + 2)).applyMatrix4(mat);
    e1.subVectors(B, A);
    e2.subVectors(C, A);
    nrm.crossVectors(e1, e2).normalize();
    ctr.copy(A).add(B).add(C).multiplyScalar(1 / 3);
    if (isPersp) view.subVectors(camPos, ctr);
    else view.copy(camDir).multiplyScalar(-1);
    const front = nrm.dot(view) > 0;
    addEdge(A, B, nrm, front);
    addEdge(B, C, nrm, front);
    addEdge(C, A, nrm, front);
  }

  const pa = new THREE.Vector3(), pb = new THREE.Vector3();
  for (const e of map.values()) {
    pa.copy(e.p0).project(cam);
    pb.copy(e.p1).project(cam);
    const seg: Seg = [[pa.x, pa.y], [pb.x, pb.y]];
    acc(pa.x, pa.y);
    acc(pb.x, pb.y);

    const boundary = e.count === 1;
    const contour = (e.hasFront && e.hasBack) || boundary;
    if (contour) sil.push(seg);

    // Camera-facing side only (drop purely back-facing edges).
    if (!e.hasFront) continue;
    wire.push(seg);
    const feature = boundary || !e.n1 || e.n0.dot(e.n1) < FEATURE_COS;
    if (feature) edges.push(seg);
  }
}

// Temporarily isolate the product (lights kept) and run `render`, restoring all
// state afterwards.
function withProductOnly(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  modelsRoot: THREE.Object3D,
  clear: [number, number],
  run: () => void
): void {
  const hidden: THREE.Object3D[] = [];
  for (const child of scene.children) {
    if (child === modelsRoot || (child as any).isLight) continue;
    if (child.visible) {
      hidden.push(child);
      child.visible = false;
    }
  }
  const prevModelsVis = modelsRoot.visible;
  modelsRoot.visible = true;
  const prevTarget = renderer.getRenderTarget();
  const prevClear = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  try {
    renderer.setClearColor(clear[0], clear[1]);
    run();
  } finally {
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);
    modelsRoot.visible = prevModelsVis;
    for (const o of hidden) o.visible = true;
  }
}

// Temporarily swap every product mesh to an unlit MeshBasicMaterial that keeps
// its base colour/texture — yields a flat albedo render. Returns a restore fn.
function swapBasic(modelsRoot: THREE.Object3D): () => void {
  const saved: Array<[THREE.Mesh, THREE.Material | THREE.Material[]]> = [];
  modelsRoot.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!(m as any).isMesh || !m.material) return;
    saved.push([m, m.material]);
    const src: any = Array.isArray(m.material) ? m.material[0] : m.material;
    m.material = new THREE.MeshBasicMaterial({
      color: src?.color ? src.color.clone() : new THREE.Color(0xb4b4b4),
      map: src?.map ?? null,
      vertexColors: !!src?.vertexColors,
      side: src?.side ?? THREE.FrontSide,
    });
  });
  return () => {
    for (const [m, mat] of saved) {
      (m.material as any)?.dispose?.();
      m.material = mat;
    }
  };
}

// Force a single override material on the whole scene (e.g. MeshNormalMaterial
// for a view-space normal pass). Returns a restore fn.
function overrideMat(scene: THREE.Scene, mat: THREE.Material): () => void {
  const prev = scene.overrideMaterial;
  scene.overrideMaterial = mat;
  return () => {
    scene.overrideMaterial = prev;
    mat.dispose();
  };
}

// Render only the product to an offscreen target (optionally with a material
// `prep` applied), crop to the NDC bbox, and return a PNG dataURL.
function renderCropped(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  modelsRoot: THREE.Object3D,
  cam: THREE.Camera,
  mount: HTMLElement,
  bbox: { min: [number, number]; max: [number, number] },
  prep?: () => () => void
): string | null {
  const H = Math.min(720, Math.max(240, mount.clientHeight || 480));
  const W = Math.max(
    1,
    Math.round(H * ((mount.clientWidth || 640) / (mount.clientHeight || 480)))
  );
  const target = new THREE.WebGLRenderTarget(W, H);
  let url: string | null = null;

  withProductOnly(renderer, scene, modelsRoot, [0x000000, 0], () => {
    const restore = prep ? prep() : () => {};
    renderer.setRenderTarget(target);
    renderer.clear();
    renderer.render(scene, cam);
    restore();

    const clampX = (v: number) => Math.max(0, Math.min(W, v));
    const clampY = (v: number) => Math.max(0, Math.min(H, v));
    const x0 = clampX(Math.floor((bbox.min[0] * 0.5 + 0.5) * W));
    const x1 = clampX(Math.ceil((bbox.max[0] * 0.5 + 0.5) * W));
    const y0 = clampY(Math.floor((bbox.min[1] * 0.5 + 0.5) * H));
    const y1 = clampY(Math.ceil((bbox.max[1] * 0.5 + 0.5) * H));
    const cw = Math.max(1, x1 - x0);
    const ch = Math.max(1, y1 - y0);
    const buf = new Uint8Array(cw * ch * 4);
    renderer.readRenderTargetPixels(target, x0, y0, cw, ch, buf);

    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const img = ctx.createImageData(cw, ch);
      for (let y = 0; y < ch; y++) {
        const src = (ch - 1 - y) * cw * 4; // flip bottom-up → top-down
        img.data.set(buf.subarray(src, src + cw * 4), y * cw * 4);
      }
      ctx.putImageData(img, 0, 0);
      url = canvas.toDataURL("image/png");
    }
  });
  target.dispose();
  return url;
}
