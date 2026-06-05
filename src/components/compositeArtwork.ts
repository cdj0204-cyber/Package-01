import type { LineArt } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Composite a Step-7 layered line drawing onto a transparent 2D canvas, ready to
// use as a CanvasTexture on the 3D box face (or anywhere). Enabled layers are
// drawn back-to-front with their opacity; the shaded raster loads async and
// calls `onUpdate` so the caller can flag the texture dirty.
// ─────────────────────────────────────────────────────────────────────────────

const LAYER_Z: Record<string, number> = { shaded: 0, wireframe: 1, edges: 2, silhouette: 3 };

export function buildIllustrationCanvas(
  art: LineArt,
  lineColor: string,
  onUpdate: () => void
): HTMLCanvasElement {
  const bw = art.bbox.max[0] - art.bbox.min[0] || 1;
  const bh = art.bbox.max[1] - art.bbox.min[1] || 1;
  const iw = bw * art.aspect;
  const ih = bh;
  const PXH = 512;
  const PXW = Math.max(1, Math.round((PXH * iw) / ih));
  const canvas = document.createElement("canvas");
  canvas.width = PXW;
  canvas.height = PXH;
  const ctx = canvas.getContext("2d");

  const X = (nx: number) => ((nx - art.bbox.min[0]) / bw) * PXW;
  const Y = (ny: number) => ((art.bbox.max[1] - ny) / bh) * PXH; // flip y
  const imgs = new Map<string, HTMLImageElement>();
  const getImg = (url: string): HTMLImageElement | null => {
    let im = imgs.get(url);
    if (!im) {
      im = new Image();
      im.onload = () => {
        redraw();
        onUpdate();
      };
      im.src = url;
      imgs.set(url, im);
    }
    return im.complete && im.naturalWidth > 0 ? im : null;
  };

  function redraw() {
    if (!ctx) return;
    ctx.clearRect(0, 0, PXW, PXH);
    const ordered = art.layers
      .filter((l) => l.enabled)
      .sort((a, b) => (LAYER_Z[a.kind] ?? 0) - (LAYER_Z[b.kind] ?? 0));
    for (const layer of ordered) {
      ctx.globalAlpha = Math.max(0, Math.min(1, layer.opacity));
      if (layer.kind === "shaded" && layer.image) {
        const im = getImg(layer.image);
        if (im) ctx.drawImage(im, 0, 0, PXW, PXH);
      } else if (layer.segments) {
        ctx.strokeStyle = layer.color ?? lineColor;
        ctx.lineWidth = layer.kind === "silhouette" ? 3 : 1.5;
        ctx.beginPath();
        for (const s of layer.segments) {
          ctx.moveTo(X(s[0][0]), Y(s[0][1]));
          ctx.lineTo(X(s[1][0]), Y(s[1][1]));
        }
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
  }

  redraw();
  return canvas;
}
