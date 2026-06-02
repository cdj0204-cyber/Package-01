import type { TextElement } from "../types";
import type { Dieline } from "./dieline";

// ─────────────────────────────────────────────────────────────────────────────
// Step 11 — export the dieline (+ surface artwork/text) to vector formats.
//   SVG : implemented (cut = black solid, crease = red dashed).
//   DXF : implemented (minimal R12 ASCII, LINE entities on CUT/CREASE layers).
//   AI  : Illustrator reads SVG/PDF; we emit an SVG payload with an .ai-friendly
//         note. A true native .ai writer is out of scope for the skeleton.
// ─────────────────────────────────────────────────────────────────────────────

export type VectorFormat = "svg" | "dxf" | "ai";

const CUT = "#000000";
const CREASE = "#e23b3b";

export function dielineToSvg(
  d: Dieline,
  texts: TextElement[] = []
): string {
  const { width, height } = d.sheet;
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}mm" height="${height}mm" viewBox="0 0 ${width} ${height}">`
  );
  parts.push(`<g fill="none" stroke-width="0.3">`);
  for (const line of d.lines) {
    const pts = line.pts.map((p) => `${p[0]},${height - p[1]}`).join(" ");
    const stroke = line.type === "cut" ? CUT : CREASE;
    const dash = line.type === "crease" ? ` stroke-dasharray="3 2"` : "";
    parts.push(`<polyline points="${pts}" stroke="${stroke}"${dash}/>`);
  }
  parts.push(`</g>`);

  // text elements placed on the sheet (normalized → sheet coords)
  for (const t of texts) {
    const x = t.x * width;
    const y = height - t.y * height;
    parts.push(
      `<text x="${x}" y="${y}" font-size="${t.sizeMm}" fill="${t.color}" ` +
        `transform="rotate(${-t.angleDeg} ${x} ${y})">${escapeXml(t.text)}</text>`
    );
  }

  parts.push(`</svg>`);
  return parts.join("\n");
}

export function dielineToDxf(d: Dieline): string {
  const out: string[] = [];
  const header = ["0", "SECTION", "2", "ENTITIES"];
  out.push(...header);
  for (const line of d.lines) {
    const layer = line.type === "cut" ? "CUT" : "CREASE";
    for (let i = 0; i < line.pts.length - 1; i++) {
      const [x1, y1] = line.pts[i];
      const [x2, y2] = line.pts[i + 1];
      out.push(
        "0", "LINE",
        "8", layer,
        "10", String(x1), "20", String(y1), "30", "0",
        "11", String(x2), "21", String(y2), "31", "0"
      );
    }
  }
  out.push("0", "ENDSEC", "0", "EOF");
  return out.join("\n");
}

export function exportDieline(
  d: Dieline,
  format: VectorFormat,
  texts: TextElement[] = []
): { blob: Blob; ext: string } {
  switch (format) {
    case "svg":
      return {
        blob: new Blob([dielineToSvg(d, texts)], { type: "image/svg+xml" }),
        ext: "svg",
      };
    case "ai":
      // Illustrator opens SVG; emit SVG bytes with .ai extension as a pragmatic
      // bridge until a native PDF/AI writer is added.
      return {
        blob: new Blob([dielineToSvg(d, texts)], {
          type: "application/postscript",
        }),
        ext: "ai",
      };
    case "dxf":
      return {
        blob: new Blob([dielineToDxf(d)], { type: "image/vnd.dxf" }),
        ext: "dxf",
      };
  }
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
