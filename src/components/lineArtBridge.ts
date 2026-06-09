import type { LineArt } from "../types";
import type { CameraView } from "../store/useStore";

// ─────────────────────────────────────────────────────────────────────────────
// Bridge between the 3D viewport (which owns the live camera + model meshes) and
// the Step-7 panel buttons. Viewport3D registers:
//   • capture(modelId)         — project a model through the CURRENT camera
//     (perspective or any face, reflecting manual orbit) → a 2D line drawing.
//   • captureView(modelId,view)— same, but from a TEMPORARY orthographic camera
//     framed on a preset face (front/rear/left/right/top…) without touching the
//     live camera, so the panel can batch-extract a whole set at once.
// ─────────────────────────────────────────────────────────────────────────────

export const lineArtBridge: {
  capture: ((modelId: string) => LineArt | null) | null;
  captureView: ((modelId: string, view: CameraView) => LineArt | null) | null;
} = { capture: null, captureView: null };
