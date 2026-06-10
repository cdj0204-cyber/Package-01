import type { BoxFace } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Step 9 — where each Step-8 box face lands on the PDF preset dieline
// (종이 G형 박스 200×185×100). Coordinates are sheet mm, y-up, matching
// pdfDieline.ts. Panel rects were measured from the dieline's crease lines.
//
// Layout (display, top → bottom): front flap / [glue·left(5)·bottom·right(4)·
// glue] / back(3) / lid·top(2) / front tuck(1).
//
// `rotDeg` is the CCW rotation (in sheet y-up coords) of the FACE-LOCAL frame
// (+x right, +y up — the same frame Step 8's gizmo/text math uses) on the
// sheet, chosen by fold continuity so artwork prints the right way up on the
// assembled box:
//   • front flap & tuck hinge at their top edge → upright (0°)
//   • back & lid hinge "below" their body panel → 180°
//   • side walls stand up sideways → ±90° (wall top faces away from the body)
// ─────────────────────────────────────────────────────────────────────────────

export interface FacePanel {
  /** Panel centre on the sheet (mm, y-up). */
  cx: number;
  cy: number;
  /** Face size along the face-local x / y axes (mm) — Step 8's fw × fh. */
  fw: number;
  fh: number;
  /** CCW rotation of the face frame on the sheet (degrees). */
  rotDeg: number;
}

export const PDF_FACE_PANELS: Partial<Record<BoxFace, FacePanel>> = {
  front: { cx: 311.7, cy: 630.0, fw: 198, fh: 100, rotDeg: 0 },
  back: { cx: 311.7, cy: 344.5, fw: 199, fh: 101, rotDeg: 180 },
  top: { cx: 311.7, cy: 201.0, fw: 198.6, fh: 186, rotDeg: 180 },
  tuck: { cx: 311.7, cy: 58.0, fw: 198.6, fh: 100, rotDeg: 0 },
  right: { cx: 461.7, cy: 487.5, fw: 185, fh: 100, rotDeg: -90 },
  left: { cx: 161.7, cy: 487.5, fw: 185, fh: 100, rotDeg: 90 },
};
