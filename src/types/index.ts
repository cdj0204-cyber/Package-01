// ─────────────────────────────────────────────────────────────────────────────
// Package 01 — domain types
// Shared across the whole 12-step pipeline.
// ─────────────────────────────────────────────────────────────────────────────

/** The three orthographic projection views the product can be analyzed from. */
export type ViewName = "top" | "front" | "side";

export const VIEW_NAMES: ViewName[] = ["top", "front", "side"];

/** A flat 2D polygon (closed loop) in millimetres, in a given view's plane. */
export interface Silhouette {
  view: ViewName;
  /** Outer loop + any holes. Each loop is a list of [x, y] in mm. */
  loops: Array<Array<[number, number]>>;
  /** Axis-aligned bounding box of the outer loop, in mm. */
  bbox: { min: [number, number]; max: [number, number] };
}

/** Step 1 — imported product model. */
export interface ImportedModel {
  fileName: string;
  /** Triangulated meshes extracted from the STEP file (positions/indices). */
  meshes: ImportedMesh[];
  /** Overall bounding box in mm. */
  bbox: { min: [number, number, number]; max: [number, number, number] };
}

export interface ImportedMesh {
  name: string;
  positions: Float32Array;
  normals?: Float32Array;
  indices: Uint32Array;
  color?: [number, number, number];
}

/** Rigid placement of a model in the scene (rotation in radians). */
export interface ModelTransform {
  position: [number, number, number];
  rotation: [number, number, number];
}

// ── Step 2 — per-model silhouette → offset → extruded solid ────────────────────

/**
 * A signed-distance field of a model's projected silhouette in a chosen view's
 * 2D (u,v) plane (world-space mm). Negative inside, positive outside. Offsetting
 * the silhouette is just reading the iso-contour at a different level, so + / −
 * offsets are exact and handle concave shapes and holes.
 */
export interface SilhouetteField {
  view: ViewName;
  /** Grid resolution. */
  nu: number;
  nv: number;
  /** World (u,v) coordinate of grid cell (0,0)'s centre, in mm. */
  origin: [number, number];
  /** Cell size in mm. */
  cell: number;
  /** Signed distance per cell (row-major, length nu*nv), mm. Negative = inside. */
  sdf: Float32Array;
  /** Silhouette bounding box in the (u,v) plane (mm). */
  uvMin: [number, number];
  uvMax: [number, number];
  /** World axis index used as the extrude/depth direction (0=X,1=Y,2=Z). */
  depthAxis: 0 | 1 | 2;
  /** World coordinate (mm) of the silhouette's base face along the depth axis. */
  depthBase: number;
  /** Model extent along the depth axis (mm) — the default extrude depth. */
  depthSize: number;
  /** Outward grid margin (mm) — the maximum usable positive offset. */
  pad: number;
}

/** A model's extracted silhouette plus its offset and extrude settings. */
export interface ModelSilhouette {
  modelId: string;
  view: ViewName;
  field: SilhouetteField;
  /** Signed offset distance applied to the outline (mm). */
  offset: number;
  /** Extrude depth of the offset plane along the depth axis (mm). */
  extrudeDepth: number;
  /**
   * Draft (구배) angle in degrees. 0 = straight walls. Positive insets the top
   * face (walls lean inward going up); negative flares it out. Applied as a
   * gradual offset change along the extrude so the wall follows the silhouette.
   */
  draftDeg: number;
}

/** An imported product placed in the scene, independently selectable/movable. */
export interface PlacedModel {
  id: string;
  name: string;
  model: ImportedModel;
  transform: ModelTransform;
}

/** Step 3 — per-view draft (구배) angle configuration, in degrees. */
export interface DraftConfig {
  /** Which view the draft is pulled along. */
  view: ViewName;
  /** Draft angle in degrees (0 = vertical walls). */
  angleDeg: number;
  /** Pull depth in mm (how deep the cavity goes). */
  depth: number;
}

/** Step 4 — the block form the cavity is subtracted from. */
export interface BoxForm {
  /** Outer dimensions of the block in mm. */
  width: number;
  depth: number;
  height: number;
  /** Distance from the bottom face the cavity must stay above (mm). */
  floorOffset: number;
}

/** Step 5/12 — the resulting insert foam (block minus cavity). */
export interface InsertFoam {
  /** Triangulated result mesh. */
  mesh: ImportedMesh | null;
  ready: boolean;
}

/** Step 6 — a packaging box type preset (dieline template). */
export interface BoxPreset {
  id: string;
  name: string;
  /** Short description / source note. */
  description: string;
  /** Family code, e.g. "G", "tuck-end", "mailer". */
  family: string;
  /**
   * Dieline generator id — maps to a function in box/dieline.ts that produces
   * the flat layout given inner W/D/H. Kept as a string so presets stay data.
   */
  dielineKind: DielineKind;
}

export type DielineKind =
  | "g-type"
  | "tuck-end-rte"
  | "mailer"
  | "two-piece-tray"
  | "sleeve";

/** Step 7 — final box volume sizing. */
export interface BoxSizing {
  mode: "manual" | "offset";
  /** Manual inner dimensions (mm). */
  width: number;
  depth: number;
  height: number;
  /** Uniform offset from the insert foam, used when mode === "offset" (mm). */
  offset: number;
  /** Tolerance/clearance added around the insert (mm). */
  tolerance: number;
}

/** Step 9 — surface illustration style preset. */
export interface ArtworkPreset {
  id: string;
  name: string;
  background: string; // css color
  lineColor: string; // css color
}

/** Step 9 — which projection of the product is drawn on the surface. */
export interface ArtworkConfig {
  view: ViewName;
  presetId: string;
  /** Placement on the chosen box face, normalized 0..1. */
  x: number;
  y: number;
  scale: number;
}

/** Step 10 — a placed text element on the box surface. */
export interface TextElement {
  id: string;
  text: string;
  /** Normalized position on the face (0..1). */
  x: number;
  y: number;
  /** Font size in mm on the physical box. */
  sizeMm: number;
  /** Rotation in degrees. */
  angleDeg: number;
  color: string;
}

/** The full project state that flows through the pipeline. */
export interface ProjectState {
  /** All imported products in the scene (a package can hold several items). */
  models: PlacedModel[];
  /** Currently selected model for transform editing, or null. */
  selectedModelId: string | null;
  /** Step 2 — the view silhouettes are extracted from. */
  silhouetteView: ViewName;
  /** Step 2 — per-model extracted silhouettes (keyed by model id). */
  modelSilhouettes: Record<string, ModelSilhouette>;
  silhouettes: Partial<Record<ViewName, Silhouette>>;
  drafts: Partial<Record<ViewName, DraftConfig>>;
  boxForm: BoxForm;
  insertFoam: InsertFoam;
  boxPresetId: string | null;
  boxSizing: BoxSizing;
  artwork: ArtworkConfig;
  textElements: TextElement[];
}
