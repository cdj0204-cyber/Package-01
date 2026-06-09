import { create } from "zustand";
import type {
  ArtworkConfig,
  BoxFace,
  BoxForm,
  BoxSizing,
  DraftConfig,
  FaceArtTransform,
  ImportedModel,
  InsertFoam,
  LidSide,
  LineArt,
  LineArtLayer,
  LineArtLayerKind,
  ModelSilhouette,
  ModelTransform,
  PlacedModel,
  ProjectState,
  SavedIllustration,
  Silhouette,
  TextElement,
  ViewName,
} from "../types";
import {
  buildSilhouetteField,
  toLegacySilhouette,
} from "../geometry/silhouetteField";

// ─────────────────────────────────────────────────────────────────────────────
// Central app store. Holds the full pipeline project state plus UI state
// (which step is active). Each pipeline module reads/writes through here.
// ─────────────────────────────────────────────────────────────────────────────

const initialBoxForm: BoxForm = {
  width: 200,
  depth: 150,
  height: 60,
  floorOffset: 10,
};

const initialBoxSizing: BoxSizing = {
  mode: "offset",
  width: 220,
  depth: 170,
  height: 80,
  offset: 10,
  tolerance: 2,
};

const initialArtwork: ArtworkConfig = {
  view: "front",
  presetId: "black-white",
  x: 0.5,
  y: 0.5,
  scale: 0.6,
};

const initialProject: ProjectState = {
  models: [],
  selectedModelId: null,
  silhouetteView: "top",
  modelSilhouettes: {},
  silhouettes: {},
  drafts: {},
  boxForm: initialBoxForm,
  insertFoam: { mesh: null, ready: false },
  boxPresetId: null,
  boxSizing: initialBoxSizing,
  boxLidSide: "width",
  lineArt: null,
  savedIllustrations: [],
  boxFaceArtwork: {},
  boxFaceTransform: {},
  artwork: initialArtwork,
  textElements: [],
};

export type { ModelTransform } from "../types";

/** Camera viewpoints offered in the viewport. */
export type CameraView =
  | "perspective"
  | "top"
  | "bottom"
  | "front"
  | "rear"
  | "right"
  | "left";

/** Pose of the Step-3 box form: centre position + Euler rotation (radians). */
export type BoxTransform = {
  position: [number, number, number];
  rotation: [number, number, number];
};

/** How the Step-3 box-form gizmo behaves. */
export type BoxEditMode = "resize" | "move" | "rotate";

export const IDENTITY_TRANSFORM: ModelTransform = {
  position: [0, 0, 0],
  rotation: [0, 0, 0],
};

let modelCounter = 0;
function nextModelId(): string {
  modelCounter += 1;
  return `model-${modelCounter}`;
}

export interface AppStore extends ProjectState {
  // ── UI state ──────────────────────────────────────────────────────────────
  currentStep: number; // 1..12
  setStep: (step: number) => void;

  // ── Viewport display state ──────────────────────────────────────────────────
  /** Lighting contrast 0..1: 0 = flat/even, 1 = strong directional shading. */
  lightContrast: number;
  setLightContrast: (v: number) => void;
  /** Transform gizmo mode for the selected model. */
  gizmoMode: "translate" | "rotate";
  setGizmoMode: (m: "translate" | "rotate") => void;
  /** Step 8 — which box face the on-face artwork gizmo is shown on. */
  boxSelectedFace: BoxFace | null;
  setBoxSelectedFace: (f: BoxFace | null) => void;
  /** Camera viewpoint: free perspective or one of the 6 orthographic faces. */
  cameraView: CameraView;
  setCameraView: (v: CameraView) => void;
  /** Step 7 viewport: inspect the product, or preview it applied to the box. */
  step7View: "product" | "box";
  setStep7View: (v: "product" | "box") => void;
  /** Step 8: show the box with its lid open (default) or closed. */
  boxClosed: boolean;
  setBoxClosed: (v: boolean) => void;

  // ── Multi-model management ───────────────────────────────────────────────────
  /** Import one or more products; the last one becomes selected. */
  addModels: (items: Array<{ model: ImportedModel; name: string }>) => void;
  removeModel: (id: string) => void;
  selectModel: (id: string | null) => void;
  /** Update a specific model's placement (gizmo / numeric input). */
  setModelTransform: (id: string, t: ModelTransform) => void;
  /** Reset the selected model's placement to identity. */
  resetSelectedTransform: () => void;

  // ── Step 2 — per-model silhouette / offset / extrude ─────────────────────────
  setSilhouetteView: (view: ViewName) => void;
  /** Extract (or re-extract) the silhouette of a model in the current view. */
  extractModelSilhouette: (modelId: string) => void;
  setSilhouetteOffset: (modelId: string, offset: number) => void;
  setSilhouetteExtrude: (modelId: string, extrudeDepth: number) => void;
  setSilhouetteDraft: (modelId: string, draftDeg: number) => void;
  clearModelSilhouette: (modelId: string) => void;

  // ── Step 3 — box-form pose + gizmo mode ──────────────────────────────────────
  /** Box-form pose (centre + rotation), or null for auto-framing on the solids. */
  boxTransform: BoxTransform | null;
  setBoxTransform: (t: BoxTransform | null) => void;
  /** Which gizmo the box form is edited with (resize handles / move / rotate). */
  boxEditMode: BoxEditMode;
  setBoxEditMode: (m: BoxEditMode) => void;

  // ── Step mutations ─────────────────────────────────────────────────────────
  setSilhouette: (view: ViewName, sil: Silhouette) => void;
  setDraft: (view: ViewName, draft: DraftConfig) => void;
  updateBoxForm: (patch: Partial<BoxForm>) => void;
  setInsertFoam: (foam: InsertFoam) => void;
  setBoxPreset: (id: string) => void;
  setBoxLidSide: (side: LidSide) => void;
  setLineArt: (art: LineArt | null) => void;
  updateLineArtLayer: (kind: LineArtLayerKind, patch: Partial<LineArtLayer>) => void;
  /** Step 7 — save / manage the list of finished illustrations. */
  addSavedIllustration: (item: SavedIllustration) => void;
  removeSavedIllustration: (id: string) => void;
  renameSavedIllustration: (id: string, name: string) => void;
  /** Step 8 — assign a saved illustration to a box face (null clears it). */
  setBoxFaceArtwork: (face: BoxFace, illustrationId: string | null) => void;
  /** Step 8 — adjust the on-face placement (scale/move/rotate). null resets it. */
  setBoxFaceTransform: (
    face: BoxFace,
    patch: Partial<FaceArtTransform> | null
  ) => void;
  updateBoxSizing: (patch: Partial<BoxSizing>) => void;
  updateArtwork: (patch: Partial<ArtworkConfig>) => void;
  addText: (el: TextElement) => void;
  updateText: (id: string, patch: Partial<TextElement>) => void;
  removeText: (id: string) => void;

  reset: () => void;
}

export const useStore = create<AppStore>((set) => ({
  ...initialProject,
  currentStep: 1,

  setStep: (step) => set({ currentStep: step }),

  lightContrast: 0.5,
  setLightContrast: (lightContrast) => set({ lightContrast }),
  gizmoMode: "rotate",
  setGizmoMode: (gizmoMode) => set({ gizmoMode }),
  boxSelectedFace: "front",
  setBoxSelectedFace: (boxSelectedFace) => set({ boxSelectedFace }),
  cameraView: "perspective",
  setCameraView: (cameraView) => set({ cameraView }),
  step7View: "product",
  setStep7View: (step7View) => set({ step7View }),
  boxClosed: false,
  setBoxClosed: (boxClosed) => set({ boxClosed }),
  boxTransform: null,
  setBoxTransform: (boxTransform) => set({ boxTransform }),
  boxEditMode: "resize",
  setBoxEditMode: (boxEditMode) => set({ boxEditMode }),

  addModels: (items) =>
    set((s) => {
      const placed: PlacedModel[] = items.map(({ model, name }) => ({
        id: nextModelId(),
        name,
        model,
        transform: {
          position: [...IDENTITY_TRANSFORM.position] as [number, number, number],
          rotation: [...IDENTITY_TRANSFORM.rotation] as [number, number, number],
        },
      }));
      const models = [...s.models, ...placed];
      return {
        models,
        selectedModelId: placed.length
          ? placed[placed.length - 1].id
          : s.selectedModelId,
      };
    }),

  removeModel: (id) =>
    set((s) => {
      const models = s.models.filter((m) => m.id !== id);
      const selectedModelId =
        s.selectedModelId === id
          ? models.length
            ? models[models.length - 1].id
            : null
          : s.selectedModelId;
      const modelSilhouettes = { ...s.modelSilhouettes };
      delete modelSilhouettes[id];
      return { models, selectedModelId, modelSilhouettes };
    }),

  selectModel: (selectedModelId) => set({ selectedModelId }),

  setModelTransform: (id, transform) =>
    set((s) => ({
      models: s.models.map((m) => (m.id === id ? { ...m, transform } : m)),
    })),

  resetSelectedTransform: () =>
    set((s) => ({
      models: s.models.map((m) =>
        m.id === s.selectedModelId
          ? {
              ...m,
              transform: {
                position: [0, 0, 0],
                rotation: [0, 0, 0],
              },
            }
          : m
      ),
    })),

  setSilhouetteView: (silhouetteView) => set({ silhouetteView }),

  extractModelSilhouette: (modelId) =>
    set((s) => {
      const pm = s.models.find((m) => m.id === modelId);
      if (!pm) return {};
      const field = buildSilhouetteField(pm.model, pm.transform, s.silhouetteView);
      const prev = s.modelSilhouettes[modelId];
      const sil: ModelSilhouette = {
        modelId,
        view: s.silhouetteView,
        field,
        // Keep the user's offset; reset extrude to the model depth on re-extract.
        offset: prev && prev.view === s.silhouetteView ? prev.offset : 0,
        extrudeDepth:
          prev && prev.view === s.silhouetteView
            ? prev.extrudeDepth
            : field.depthSize,
        draftDeg: prev && prev.view === s.silhouetteView ? prev.draftDeg : 0,
      };
      return {
        modelSilhouettes: { ...s.modelSilhouettes, [modelId]: sil },
        // Keep the legacy global silhouette alive for steps 3/4 continuity.
        silhouettes: {
          ...s.silhouettes,
          [s.silhouetteView]: toLegacySilhouette(field),
        },
      };
    }),

  setSilhouetteOffset: (modelId, offset) =>
    set((s) => {
      const cur = s.modelSilhouettes[modelId];
      if (!cur) return {};
      return {
        modelSilhouettes: {
          ...s.modelSilhouettes,
          [modelId]: { ...cur, offset },
        },
      };
    }),

  setSilhouetteExtrude: (modelId, extrudeDepth) =>
    set((s) => {
      const cur = s.modelSilhouettes[modelId];
      if (!cur) return {};
      return {
        modelSilhouettes: {
          ...s.modelSilhouettes,
          [modelId]: { ...cur, extrudeDepth: Math.max(0.1, extrudeDepth) },
        },
      };
    }),

  setSilhouetteDraft: (modelId, draftDeg) =>
    set((s) => {
      const cur = s.modelSilhouettes[modelId];
      if (!cur) return {};
      return {
        modelSilhouettes: {
          ...s.modelSilhouettes,
          [modelId]: { ...cur, draftDeg },
        },
      };
    }),

  clearModelSilhouette: (modelId) =>
    set((s) => {
      const modelSilhouettes = { ...s.modelSilhouettes };
      delete modelSilhouettes[modelId];
      return { modelSilhouettes };
    }),

  setSilhouette: (view, sil) =>
    set((s) => ({ silhouettes: { ...s.silhouettes, [view]: sil } })),

  setDraft: (view, draft) =>
    set((s) => ({ drafts: { ...s.drafts, [view]: draft } })),

  updateBoxForm: (patch) =>
    set((s) => ({ boxForm: { ...s.boxForm, ...patch } })),

  setInsertFoam: (insertFoam) => set({ insertFoam }),

  setBoxPreset: (boxPresetId) => set({ boxPresetId }),
  setBoxLidSide: (boxLidSide) => set({ boxLidSide }),
  setLineArt: (lineArt) => set({ lineArt }),
  updateLineArtLayer: (kind, patch) =>
    set((s) =>
      s.lineArt
        ? {
            lineArt: {
              ...s.lineArt,
              layers: s.lineArt.layers.map((l) =>
                l.kind === kind ? { ...l, ...patch } : l
              ),
            },
          }
        : {}
    ),

  addSavedIllustration: (item) =>
    set((s) => ({ savedIllustrations: [...s.savedIllustrations, item] })),
  removeSavedIllustration: (id) =>
    set((s) => {
      const boxFaceArtwork = { ...s.boxFaceArtwork };
      for (const f of Object.keys(boxFaceArtwork) as BoxFace[]) {
        if (boxFaceArtwork[f] === id) delete boxFaceArtwork[f];
      }
      return {
        savedIllustrations: s.savedIllustrations.filter((i) => i.id !== id),
        boxFaceArtwork,
      };
    }),
  renameSavedIllustration: (id, name) =>
    set((s) => ({
      savedIllustrations: s.savedIllustrations.map((i) =>
        i.id === id ? { ...i, name } : i
      ),
    })),
  setBoxFaceArtwork: (face, illustrationId) =>
    set((s) => {
      const next = { ...s.boxFaceArtwork };
      if (illustrationId) next[face] = illustrationId;
      else delete next[face];
      return { boxFaceArtwork: next };
    }),

  setBoxFaceTransform: (face, patch) =>
    set((s) => {
      const next = { ...s.boxFaceTransform };
      if (patch === null) {
        delete next[face];
      } else {
        const cur = next[face] ?? {
          scale: 1,
          x: 0,
          y: 0,
          angle: 0,
          flipX: false,
          flipY: false,
        };
        next[face] = { ...cur, ...patch };
      }
      return { boxFaceTransform: next };
    }),

  updateBoxSizing: (patch) =>
    set((s) => ({ boxSizing: { ...s.boxSizing, ...patch } })),

  updateArtwork: (patch) =>
    set((s) => ({ artwork: { ...s.artwork, ...patch } })),

  addText: (el) => set((s) => ({ textElements: [...s.textElements, el] })),

  updateText: (id, patch) =>
    set((s) => ({
      textElements: s.textElements.map((t) =>
        t.id === id ? { ...t, ...patch } : t
      ),
    })),

  removeText: (id) =>
    set((s) => ({ textElements: s.textElements.filter((t) => t.id !== id) })),

  reset: () =>
    set({
      ...initialProject,
      currentStep: 1,
      boxTransform: null,
      boxEditMode: "resize",
    }),
}));

/** The currently selected placed model, or undefined. */
export function selectedPlacedModel(s: AppStore): PlacedModel | undefined {
  return s.models.find((m) => m.id === s.selectedModelId) ?? s.models[0];
}
