import type { LineArtLayer } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Deferred relighting for the Step-7/8 "shaded" layer. The capture stores a flat
// albedo + a view-space normal map; here we recombine them in 2D with a simple
// Lambert term so brightness / contrast / light direction can be tuned live
// without re-rendering the 3D scene. Module-level caches are shared by all
// consumers (2D preview + 3D box decal).
// ─────────────────────────────────────────────────────────────────────────────

export interface ShadeParams {
  brightness: number; // 1 = neutral
  contrast: number; // 1 = neutral
  lightX: number; // -1..1, screen right
  lightY: number; // -1..1, screen up
}

export function shadeParams(layer: LineArtLayer): ShadeParams {
  return {
    brightness: layer.brightness ?? 1,
    contrast: layer.contrast ?? 1,
    lightX: layer.lightX ?? 0.35,
    lightY: layer.lightY ?? 0.45,
  };
}

const imgCache = new Map<string, HTMLImageElement>();
const relitCache = new Map<string, HTMLCanvasElement>();

function loadImg(url: string, onReady: () => void): HTMLImageElement | null {
  let im = imgCache.get(url);
  if (!im) {
    im = new Image();
    im.onload = onReady;
    im.src = url;
    imgCache.set(url, im);
  }
  return im.complete && im.naturalWidth > 0 ? im : null;
}

/**
 * Return a drawable (canvas) of the relit shaded layer, or the plain loaded image
 * when relight inputs are missing, or null while assets are still loading.
 * `onReady` fires when an async image finishes decoding so the caller can redraw.
 */
export function getRelitShaded(
  layer: LineArtLayer,
  onReady: () => void
): CanvasImageSource | null {
  const p = shadeParams(layer);
  if (layer.albedoImage && layer.normalImage) {
    const albedo = loadImg(layer.albedoImage, onReady);
    const normal = loadImg(layer.normalImage, onReady);
    if (!albedo || !normal) return null;
    const key = `${layer.albedoImage}|${layer.normalImage}|${p.brightness}|${p.contrast}|${p.lightX}|${p.lightY}`;
    let c = relitCache.get(key);
    if (!c) {
      c = relight(albedo, normal, p);
      if (relitCache.size > 24) relitCache.clear();
      relitCache.set(key, c);
    }
    return c;
  }
  // Fallback: no normal map — just draw the stored image (with brightness applied
  // via the caller's globalAlpha/opacity, untouched here).
  if (layer.image) return loadImg(layer.image, onReady);
  return null;
}

function relight(
  albedo: HTMLImageElement,
  normal: HTMLImageElement,
  p: ShadeParams
): HTMLCanvasElement {
  const w = albedo.naturalWidth || 1;
  const h = albedo.naturalHeight || 1;

  const read = (img: HTMLImageElement) => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const cx = c.getContext("2d")!;
    cx.drawImage(img, 0, 0, w, h);
    return cx.getImageData(0, 0, w, h);
  };
  const alb = read(albedo);
  const nrm = read(normal);

  // Light direction in view space (z toward viewer).
  let lx = p.lightX,
    ly = p.lightY;
  let lz = Math.sqrt(Math.max(0.0001, 1 - lx * lx - ly * ly));
  const ll = Math.hypot(lx, ly, lz) || 1;
  lx /= ll;
  ly /= ll;
  lz /= ll;

  const ambient = 0.35;
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const octx = out.getContext("2d")!;
  const dst = octx.createImageData(w, h);
  const A = alb.data,
    N = nrm.data,
    D = dst.data;

  for (let i = 0; i < A.length; i += 4) {
    const a = A[i + 3];
    if (a < 4) {
      D[i + 3] = 0;
      continue;
    }
    // decode view-space normal
    let nx = (N[i] / 255) * 2 - 1;
    let ny = (N[i + 1] / 255) * 2 - 1;
    let nz = (N[i + 2] / 255) * 2 - 1;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl;
    ny /= nl;
    nz /= nl;
    const diff = Math.max(0, nx * lx + ny * ly + nz * lz);
    let shade = (ambient + (1 - ambient) * diff) * p.brightness;
    for (let ch = 0; ch < 3; ch++) {
      let v = (A[i + ch] / 255) * shade;
      v = (v - 0.5) * p.contrast + 0.5; // contrast around mid-grey
      D[i + ch] = Math.max(0, Math.min(255, Math.round(v * 255)));
    }
    D[i + 3] = a;
  }
  octx.putImageData(dst, 0, 0);
  return out;
}
