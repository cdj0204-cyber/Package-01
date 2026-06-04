import { useEffect, useRef } from "react";
import { useStore } from "../store/useStore";
import type { ViewportKind } from "../pipeline/steps";
import { getArtworkPreset, getBoxPreset } from "../box/presets";
import { generateDieline } from "../box/dieline";
import type { Silhouette } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// 2D canvas viewport for silhouette / artwork / dieline steps.
// Artwork step supports interactive drag of text elements.
// ─────────────────────────────────────────────────────────────────────────────

export function Viewport2D({ kind }: { kind: ViewportKind }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragId = useRef<string | null>(null);

  const silhouettes = useStore((s) => s.silhouettes);
  const lineArt = useStore((s) => s.lineArt);
  const artwork = useStore((s) => s.artwork);
  const texts = useStore((s) => s.textElements);
  const updateText = useStore((s) => s.updateText);
  const boxPresetId = useStore((s) => s.boxPresetId);
  const boxSizing = useStore((s) => s.boxSizing);

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const parent = canvas.parentElement!;
    const W = (canvas.width = parent.clientWidth);
    const H = (canvas.height = parent.clientHeight);
    ctx.clearRect(0, 0, W, H);

    if (kind === "2d-silhouette") drawSilhouette(ctx, W, H, silhouettes[artwork.view] ?? Object.values(silhouettes)[0]);
    else if (kind === "2d-artwork") drawArtwork(ctx, W, H);
    else if (kind === "2d-dieline") drawDieline(ctx, W, H);

    function drawSilhouette(c: CanvasRenderingContext2D, w: number, h: number, sil?: Silhouette) {
      if (!sil) {
        c.fillStyle = "#8b949e";
        c.font = "13px system-ui";
        c.textAlign = "center";
        c.fillText("실루엣이 아직 추출되지 않았습니다.", w / 2, h / 2);
        return;
      }
      const { fit } = makeFit(sil.bbox.min, sil.bbox.max, w, h, 60);
      c.strokeStyle = "#f0883e";
      c.lineWidth = 2;
      for (const loop of sil.loops) {
        c.beginPath();
        loop.forEach((p, i) => {
          const [x, y] = fit(p[0], p[1]);
          if (i === 0) c.moveTo(x, y);
          else c.lineTo(x, y);
        });
        c.closePath();
        c.stroke();
      }
      c.fillStyle = "#8b949e";
      c.font = "12px system-ui";
      c.textAlign = "left";
      c.fillText(
        `${artwork.view} 뷰 · ${(sil.bbox.max[0] - sil.bbox.min[0]).toFixed(1)} × ${(sil.bbox.max[1] - sil.bbox.min[1]).toFixed(1)} mm`,
        12,
        h - 14
      );
    }

    function drawArtwork(c: CanvasRenderingContext2D, w: number, h: number) {
      const preset = getArtworkPreset(artwork.presetId);
      // box face = front face: width × height
      const faceW = boxSizing.width;
      const faceH = boxSizing.height;
      const { fit, scale } = makeFit([0, 0], [faceW, faceH], w, h, 80);
      const o = fit(0, 0);
      const px = scale;
      // face background
      c.fillStyle = preset.background;
      c.fillRect(o[0], o[1] - faceH * px, faceW * px, faceH * px);
      c.strokeStyle = "#2a313c";
      c.strokeRect(o[0], o[1] - faceH * px, faceW * px, faceH * px);

      // Product line drawing centred per artwork cfg. Prefer the Step-7 projected
      // edge line drawing (`lineArt`); fall back to the legacy silhouette outline.
      const cx = o[0] + artwork.x * faceW * px;
      const cy = o[1] - artwork.y * faceH * px;
      const target = Math.min(faceW, faceH) * artwork.scale;
      c.strokeStyle = preset.lineColor;
      c.lineWidth = 2;
      if (lineArt) {
        const sw = lineArt.bbox.max[0] - lineArt.bbox.min[0] || 1;
        const sh = lineArt.bbox.max[1] - lineArt.bbox.min[1] || 1;
        const k = (target / Math.max(sw, sh)) * px;
        const mx = lineArt.bbox.min[0] + sw / 2;
        const my = lineArt.bbox.min[1] + sh / 2;
        c.lineWidth = 1;
        c.beginPath();
        for (const s of lineArt.segments) {
          // segment coords are screen-y-down; box face is y-up → negate.
          c.moveTo(cx + (s[0][0] - mx) * k, cy + (s[0][1] - my) * k);
          c.lineTo(cx + (s[1][0] - mx) * k, cy + (s[1][1] - my) * k);
        }
        c.stroke();
      } else {
        const sil = silhouettes[artwork.view] ?? Object.values(silhouettes)[0];
        if (sil) {
          const sw = sil.bbox.max[0] - sil.bbox.min[0];
          const sh = sil.bbox.max[1] - sil.bbox.min[1];
          const k = (target / Math.max(sw, sh)) * px;
          for (const loop of sil.loops) {
            c.beginPath();
            loop.forEach((p, i) => {
              const x = cx + (p[0] - (sil.bbox.min[0] + sw / 2)) * k;
              const y = cy - (p[1] - (sil.bbox.min[1] + sh / 2)) * k;
              if (i === 0) c.moveTo(x, y);
              else c.lineTo(x, y);
            });
            c.closePath();
            c.stroke();
          }
        }
      }

      // text elements
      for (const t of texts) {
        const x = o[0] + t.x * faceW * px;
        const y = o[1] - t.y * faceH * px;
        c.save();
        c.translate(x, y);
        c.rotate((-t.angleDeg * Math.PI) / 180);
        c.fillStyle = t.color;
        c.font = `${Math.max(8, t.sizeMm * px)}px system-ui`;
        c.textAlign = "center";
        c.textBaseline = "middle";
        c.fillText(t.text, 0, 0);
        c.restore();
      }

      c.fillStyle = "#8b949e";
      c.font = "12px system-ui";
      c.textAlign = "left";
      c.fillText("정면(front) 페이스 미리보기 · 텍스트를 드래그해 배치", 12, h - 14);
    }

    function drawDieline(c: CanvasRenderingContext2D, w: number, h: number) {
      const preset = getBoxPreset(boxPresetId);
      if (!preset) {
        c.fillStyle = "#8b949e";
        c.font = "13px system-ui";
        c.textAlign = "center";
        c.fillText("박스 유형을 먼저 선택하세요 (Step 6).", w / 2, h / 2);
        return;
      }
      const d = generateDieline(preset.dielineKind, boxSizing);
      const { fit } = makeFit([0, 0], [d.sheet.width, d.sheet.height], w, h, 60);
      for (const line of d.lines) {
        c.beginPath();
        line.pts.forEach((p, i) => {
          const [x, y] = fit(p[0], p[1]);
          if (i === 0) c.moveTo(x, y);
          else c.lineTo(x, y);
        });
        if (line.type === "cut") {
          c.strokeStyle = "#e6edf3";
          c.setLineDash([]);
        } else {
          c.strokeStyle = "#e23b3b";
          c.setLineDash([5, 4]);
        }
        c.lineWidth = 1.2;
        c.stroke();
      }
      c.setLineDash([]);
      c.fillStyle = "#8b949e";
      c.font = "12px system-ui";
      c.textAlign = "left";
      c.fillText(
        `${preset.name} · 시트 ${d.sheet.width.toFixed(0)} × ${d.sheet.height.toFixed(0)} mm  (흰색=재단, 빨강=접지)`,
        12,
        h - 14
      );
    }
  }, [kind, silhouettes, lineArt, artwork, texts, boxPresetId, boxSizing]);

  // ── interactive text drag (artwork step) ────────────────────────────────────
  function onPointerDown(e: React.PointerEvent) {
    if (kind !== "2d-artwork") return;
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const faceW = boxSizing.width;
    const faceH = boxSizing.height;
    const { fit, scale } = makeFit([0, 0], [faceW, faceH], canvas.width, canvas.height, 80);
    const o = fit(0, 0);
    // find nearest text
    let nearest: string | null = null;
    let best = 30;
    for (const t of texts) {
      const x = o[0] + t.x * faceW * scale;
      const y = o[1] - t.y * faceH * scale;
      const dist = Math.hypot(mx - x, my - y);
      if (dist < best) {
        best = dist;
        nearest = t.id;
      }
    }
    dragId.current = nearest;
  }

  function onPointerMove(e: React.PointerEvent) {
    if (kind !== "2d-artwork" || !dragId.current) return;
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const faceW = boxSizing.width;
    const faceH = boxSizing.height;
    const { fit, scale } = makeFit([0, 0], [faceW, faceH], canvas.width, canvas.height, 80);
    const o = fit(0, 0);
    const nx = (mx - o[0]) / (faceW * scale);
    const ny = (o[1] - my) / (faceH * scale);
    updateText(dragId.current, {
      x: Math.max(0, Math.min(1, nx)),
      y: Math.max(0, Math.min(1, ny)),
    });
  }

  function onPointerUp() {
    dragId.current = null;
  }

  return (
    <canvas
      ref={canvasRef}
      style={{ width: "100%", height: "100%", cursor: kind === "2d-artwork" ? "move" : "default" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
    />
  );
}

/** Builds a fitter mapping model coords → canvas coords (y-up → y-down). */
function makeFit(
  min: [number, number],
  max: [number, number],
  w: number,
  h: number,
  pad: number
) {
  const dx = max[0] - min[0] || 1;
  const dy = max[1] - min[1] || 1;
  const scale = Math.min((w - pad * 2) / dx, (h - pad * 2) / dy);
  const offX = (w - dx * scale) / 2 - min[0] * scale;
  const offY = (h + dy * scale) / 2 + min[1] * scale; // flip y
  const fit = (x: number, y: number): [number, number] => [
    offX + x * scale,
    offY - y * scale,
  ];
  return { fit, scale };
}
