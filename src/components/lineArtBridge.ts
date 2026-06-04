import type { LineArt } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Bridge between the 3D viewport (which owns the live camera + model meshes) and
// the Step-7 panel button. Viewport3D registers a `capture` function that, given
// a model id, projects that model's feature edges through the CURRENT camera
// (perspective or any orthographic face, reflecting any manual orbit) and returns
// a 2D line drawing. The panel calls it on demand.
// ─────────────────────────────────────────────────────────────────────────────

export const lineArtBridge: {
  capture: ((modelId: string) => LineArt | null) | null;
} = { capture: null };
