import type { LineArt } from "../types";
import { getRelitShaded } from "./relightShaded";

// ─────────────────────────────────────────────────────────────────────────────
// Shared 2D compositing for the Step-7 illustration: background + relit shaded
// raster + vector layers (silhouette / edges / wireframe), drawn back-to-front.
// Used by the live preview canvas and by saved-illustration thumbnails so both
// look identical.
// ─────────────────────────────────────────────────────────────────────────────

const LAYER_Z: Record<string, number> = {
  shaded: 0,
  wireframe: 1,
  edges: 2,
  silhouette: 3,
};
const LAYER_COLOR: Record<string, string> = {
  silhouette: "#ffd33d",
  shaded: "#9aa3ad",
  edges: "#f0883e",
  wireframe: "#7d93ab",
};

/**
 * Draw the illustration into `ctx` sized W×H. `background` fills the canvas first
 * (pass null for transparent). `onShadedReady` fires when the async shaded raster
 * finishes decoding so the caller can redraw. Returns true if `lineArt` was drawn.
 */
export function drawIllustration(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  lineArt: LineArt | null,
  background: string | null,
  onShadedReady: () => void
): boolean {
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, W, H);
  } else {
    ctx.clearRect(0, 0, W, H);
  }
  if (!lineArt) return false;

  const bw = lineArt.bbox.max[0] - lineArt.bbox.min[0] || 1;
  const bh = lineArt.bbox.max[1] - lineArt.bbox.min[1] || 1;
  const ew = bw * lineArt.aspect;
  const pad = Math.max(8, Math.min(W, H) * 0.08);
  const k = Math.min((W - pad * 2) / ew, (H - pad * 2) / bh);
  const dw = ew * k;
  const dh = bh * k;
  const left = (W - dw) / 2;
  const top = (H - dh) / 2;
  const X = (nx: number) => left + ((nx - lineArt.bbox.min[0]) / bw) * dw;
  const Y = (ny: number) => top + ((lineArt.bbox.max[1] - ny) / bh) * dh; // flip y

  const ordered = lineArt.layers
    .filter((l) => l.enabled)
    .sort((a, b) => (LAYER_Z[a.kind] ?? 0) - (LAYER_Z[b.kind] ?? 0));
  for (const layer of ordered) {
    ctx.globalAlpha = Math.max(0, Math.min(1, layer.opacity));
    if (layer.kind === "shaded") {
      const src = getRelitShaded(layer, onShadedReady);
      if (src) ctx.drawImage(src, left, top, dw, dh);
    } else if (layer.segments) {
      ctx.strokeStyle = layer.color ?? LAYER_COLOR[layer.kind] ?? "#fff";
      ctx.lineWidth = layer.kind === "silhouette" ? 2.4 : 1.2;
      ctx.beginPath();
      for (const s of layer.segments) {
        ctx.moveTo(X(s[0][0]), Y(s[0][1]));
        ctx.lineTo(X(s[1][0]), Y(s[1][1]));
      }
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
  return true;
}

/**
 * Build a standalone composited canvas (background + layers) at W×H. If the
 * shaded raster decodes asynchronously the canvas is redrawn and `onReady` fires
 * (use it to flag a texture dirty).
 */
export function composeIllustration(
  lineArt: LineArt,
  background: string | null,
  W: number,
  H: number,
  onReady?: () => void
): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d");
  const redraw = () => {
    if (!ctx) return;
    drawIllustration(ctx, W, H, lineArt, background, () => {
      redraw();
      onReady?.();
    });
  };
  redraw();
  return c;
}
