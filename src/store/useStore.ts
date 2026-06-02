import { create } from "zustand";
import type {
  ArtworkConfig,
  BoxForm,
  BoxSizing,
  DraftConfig,
  ImportedModel,
  InsertFoam,
  ProjectState,
  Silhouette,
  TextElement,
  ViewName,
} from "../types";

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
  model: null,
  silhouettes: {},
  drafts: {},
  boxForm: initialBoxForm,
  insertFoam: { mesh: null, ready: false },
  boxPresetId: null,
  boxSizing: initialBoxSizing,
  artwork: initialArtwork,
  textElements: [],
};

export interface AppStore extends ProjectState {
  // ── UI state ──────────────────────────────────────────────────────────────
  currentStep: number; // 1..12
  setStep: (step: number) => void;

  // ── Step mutations ─────────────────────────────────────────────────────────
  setModel: (model: ImportedModel | null) => void;
  setSilhouette: (view: ViewName, sil: Silhouette) => void;
  setDraft: (view: ViewName, draft: DraftConfig) => void;
  updateBoxForm: (patch: Partial<BoxForm>) => void;
  setInsertFoam: (foam: InsertFoam) => void;
  setBoxPreset: (id: string) => void;
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

  setModel: (model) => set({ model }),

  setSilhouette: (view, sil) =>
    set((s) => ({ silhouettes: { ...s.silhouettes, [view]: sil } })),

  setDraft: (view, draft) =>
    set((s) => ({ drafts: { ...s.drafts, [view]: draft } })),

  updateBoxForm: (patch) =>
    set((s) => ({ boxForm: { ...s.boxForm, ...patch } })),

  setInsertFoam: (insertFoam) => set({ insertFoam }),

  setBoxPreset: (boxPresetId) => set({ boxPresetId }),

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

  reset: () => set({ ...initialProject, currentStep: 1 }),
}));
