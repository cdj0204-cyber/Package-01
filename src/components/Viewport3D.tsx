import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { useStore } from "../store/useStore";
import type { ImportedMesh } from "../types";
import { buildBlockMesh } from "../geometry/boolean";
import { buildDraftedPlug } from "../geometry/draft";
import { getBoxPreset } from "../box/presets";

// ─────────────────────────────────────────────────────────────────────────────
// three.js viewport. Rebuilds its content from the store whenever relevant
// pipeline state changes, choosing what to show based on the current step.
// ─────────────────────────────────────────────────────────────────────────────

function toThreeMesh(m: ImportedMesh, opacity = 1): THREE.Mesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(m.positions, 3));
  geo.setIndex(new THREE.BufferAttribute(m.indices, 1));
  if (m.normals) geo.setAttribute("normal", new THREE.BufferAttribute(m.normals, 3));
  else geo.computeVertexNormals();
  const color = m.color
    ? new THREE.Color(m.color[0], m.color[1], m.color[2])
    : new THREE.Color(0.7, 0.75, 0.8);
  const mat = new THREE.MeshStandardMaterial({
    color,
    metalness: 0.1,
    roughness: 0.7,
    transparent: opacity < 1,
    opacity,
    side: THREE.DoubleSide,
    flatShading: true,
  });
  return new THREE.Mesh(geo, mat);
}

export function Viewport3D() {
  const mountRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<THREE.Scene>();
  const contentRef = useRef<THREE.Group>();

  const step = useStore((s) => s.currentStep);
  const model = useStore((s) => s.model);
  const silhouettes = useStore((s) => s.silhouettes);
  const drafts = useStore((s) => s.drafts);
  const boxForm = useStore((s) => s.boxForm);
  const boxPresetId = useStore((s) => s.boxPresetId);
  const boxSizing = useStore((s) => s.boxSizing);

  // ── one-time scene setup ────────────────────────────────────────────────────
  useEffect(() => {
    const mount = mountRef.current!;
    const scene = new THREE.Scene();
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(
      45,
      mount.clientWidth / mount.clientHeight,
      0.1,
      100000
    );
    camera.position.set(300, 250, 400);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const dir = new THREE.DirectionalLight(0xffffff, 0.9);
    dir.position.set(1, 2, 1.5);
    scene.add(dir);
    const grid = new THREE.GridHelper(1000, 20, 0x2a313c, 0x1c232d);
    scene.add(grid);
    scene.add(new THREE.AxesHelper(80));

    const content = new THREE.Group();
    contentRef.current = content;
    scene.add(content);

    let raf = 0;
    const animate = () => {
      controls.update();
      renderer.render(scene, camera);
      raf = requestAnimationFrame(animate);
    };
    animate();

    const onResize = () => {
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(mount);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      mount.removeChild(renderer.domElement);
    };
  }, []);

  // ── rebuild content on state/step change ────────────────────────────────────
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    // clear
    while (content.children.length) content.remove(content.children[0]);

    const center: [number, number] = model
      ? [
          (model.bbox.min[0] + model.bbox.max[0]) / 2,
          (model.bbox.min[1] + model.bbox.max[1]) / 2,
        ]
      : [0, 0];

    const showModel = step <= 3;
    const showInsert = step === 4 || step === 5 || step === 12;
    const showBox = step >= 6 && step <= 11;

    if (showModel && model) {
      for (const m of model.meshes) content.add(toThreeMesh(m));
    }

    if (showInsert && model) {
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
      // simple box volume preview from sizing
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
      void getBoxPreset; // preset metadata used in panels
    }
  }, [step, model, silhouettes, drafts, boxForm, boxPresetId, boxSizing]);

  return <div ref={mountRef} style={{ width: "100%", height: "100%" }} />;
}
