import { useEffect, useRef, useState } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// Full-gradient colour picker with CMYK readout/entry. An SV gradient square +
// hue slider give broad selection; CMYK and hex fields give precise print-style
// entry. Emits a hex string via onChange.
// ─────────────────────────────────────────────────────────────────────────────

type RGB = { r: number; g: number; b: number };
type HSV = { h: number; s: number; v: number };

function clamp01(x: number) {
  return Math.max(0, Math.min(1, x));
}
function hexToRgb(hex: string): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return { r: 0, g: 0, b: 0 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function rgbToHex({ r, g, b }: RGB): string {
  const h = (v: number) => Math.round(clamp01(v / 255) * 255).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}
function rgbToHsv({ r, g, b }: RGB): HSV {
  const rr = r / 255, gg = g / 255, bb = b / 255;
  const max = Math.max(rr, gg, bb), min = Math.min(rr, gg, bb);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rr) h = ((gg - bb) / d) % 6;
    else if (max === gg) h = (bb - rr) / d + 2;
    else h = (rr - gg) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : d / max, v: max };
}
function hsvToRgb({ h, s, v }: HSV): RGB {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}
function rgbToCmyk({ r, g, b }: RGB) {
  const rr = r / 255, gg = g / 255, bb = b / 255;
  const k = 1 - Math.max(rr, gg, bb);
  if (k >= 1) return { c: 0, m: 0, y: 0, k: 100 };
  const c = (1 - rr - k) / (1 - k);
  const m = (1 - gg - k) / (1 - k);
  const y = (1 - bb - k) / (1 - k);
  return { c: Math.round(c * 100), m: Math.round(m * 100), y: Math.round(y * 100), k: Math.round(k * 100) };
}
function cmykToRgb(c: number, m: number, y: number, k: number): RGB {
  const cc = c / 100, mm = m / 100, yy = y / 100, kk = k / 100;
  return {
    r: 255 * (1 - cc) * (1 - kk),
    g: 255 * (1 - mm) * (1 - kk),
    b: 255 * (1 - yy) * (1 - kk),
  };
}

export function ColorPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (hex: string) => void;
}) {
  // Internal HSV (so hue/value survive greyscale); sync when `value` changes.
  const [hsv, setHsv] = useState<HSV>(() => rgbToHsv(hexToRgb(value)));
  const lastEmit = useRef(value);
  useEffect(() => {
    if (value.toLowerCase() !== lastEmit.current.toLowerCase()) {
      setHsv(rgbToHsv(hexToRgb(value)));
      lastEmit.current = value;
    }
  }, [value]);

  const rgb = hsvToRgb(hsv);
  const hex = rgbToHex(rgb);
  const cmyk = rgbToCmyk(rgb);

  const emit = (next: HSV) => {
    setHsv(next);
    const h = rgbToHex(hsvToRgb(next));
    lastEmit.current = h;
    onChange(h);
  };

  const svRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);

  const dragSV = (e: React.PointerEvent) => {
    const el = svRef.current;
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    const move = (clientX: number, clientY: number) => {
      const r = el.getBoundingClientRect();
      const s = clamp01((clientX - r.left) / r.width);
      const v = 1 - clamp01((clientY - r.top) / r.height);
      emit({ h: hsv.h, s, v });
    };
    move(e.clientX, e.clientY);
    const onMove = (ev: PointerEvent) => move(ev.clientX, ev.clientY);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const dragHue = (e: React.PointerEvent) => {
    const el = hueRef.current;
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    const move = (clientX: number) => {
      const r = el.getBoundingClientRect();
      emit({ ...hsv, h: clamp01((clientX - r.left) / r.width) * 360 });
    };
    move(e.clientX);
    const onMove = (ev: PointerEvent) => move(ev.clientX);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const setCmyk = (patch: Partial<{ c: number; m: number; y: number; k: number }>) => {
    const next = { ...cmyk, ...patch };
    emit(rgbToHsv(cmykToRgb(next.c, next.m, next.y, next.k)));
  };
  const hueColor = rgbToHex(hsvToRgb({ h: hsv.h, s: 1, v: 1 }));
  const num = (v: number, on: (n: number) => void) => (
    <input
      type="number"
      min={0}
      max={100}
      value={v}
      onChange={(e) => on(Math.max(0, Math.min(100, Number(e.target.value))))}
      style={{ width: "100%" }}
    />
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div
        ref={svRef}
        onPointerDown={dragSV}
        style={{
          position: "relative",
          width: "100%",
          height: 110,
          borderRadius: 4,
          cursor: "crosshair",
          background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent), ${hueColor}`,
          touchAction: "none",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: `${hsv.s * 100}%`,
            top: `${(1 - hsv.v) * 100}%`,
            width: 10,
            height: 10,
            transform: "translate(-50%,-50%)",
            borderRadius: "50%",
            border: "2px solid #fff",
            boxShadow: "0 0 0 1px #000",
            pointerEvents: "none",
          }}
        />
      </div>
      <div
        ref={hueRef}
        onPointerDown={dragHue}
        style={{
          position: "relative",
          width: "100%",
          height: 14,
          borderRadius: 4,
          cursor: "pointer",
          background:
            "linear-gradient(to right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)",
          touchAction: "none",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: `${(hsv.h / 360) * 100}%`,
            top: 0,
            bottom: 0,
            width: 3,
            transform: "translateX(-50%)",
            background: "#fff",
            boxShadow: "0 0 0 1px #000",
            pointerEvents: "none",
          }}
        />
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <span
          style={{ width: 22, height: 22, borderRadius: 4, background: hex, border: "1px solid #2a313c" }}
        />
        <input
          type="text"
          value={hex}
          onChange={(e) => {
            const v = e.target.value;
            if (/^#?[0-9a-f]{6}$/i.test(v)) emit(rgbToHsv(hexToRgb(v)));
          }}
          style={{ flex: 1 }}
        />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 4 }}>
        <label className="cmyk-cell">C{num(cmyk.c, (n) => setCmyk({ c: n }))}</label>
        <label className="cmyk-cell">M{num(cmyk.m, (n) => setCmyk({ m: n }))}</label>
        <label className="cmyk-cell">Y{num(cmyk.y, (n) => setCmyk({ y: n }))}</label>
        <label className="cmyk-cell">K{num(cmyk.k, (n) => setCmyk({ k: n }))}</label>
      </div>
    </div>
  );
}
