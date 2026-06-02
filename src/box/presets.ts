import type { ArtworkPreset, BoxPreset } from "../types";

// ─────────────────────────────────────────────────────────────────────────────
// Packaging box type presets (data assets).
// These are the "유형" library referenced in step 6. Each entry is pure data and
// points at a dieline generator kind implemented in box/dieline.ts.
//
// Sources to expand later (common industrial carton standards):
//   - FEFCO catalogue (corrugated): 0201, 0215 (G-type style), 0427 (mailer)...
//   - ECMA catalogue (folding carton): A20.20 (RTE tuck), B... trays
// For now we ship a small representative set; more can be appended as data.
// ─────────────────────────────────────────────────────────────────────────────

export const BOX_PRESETS: BoxPreset[] = [
  {
    id: "g-type",
    name: "G형 박스 (G-Type)",
    family: "G",
    description:
      "상하 분리형 뚜껑/몸체 구조. 인서트 폼을 안정적으로 안착시키는 데 적합.",
    dielineKind: "g-type",
  },
  {
    id: "rte-tuck",
    name: "RTE 턱인 박스 (Reverse Tuck End)",
    family: "tuck-end",
    description: "상하 반대 방향 턱 마감의 일반 종이 카톤. 양산성이 좋음.",
    dielineKind: "tuck-end-rte",
  },
  {
    id: "mailer",
    name: "메일러 박스 (Roll-End Mailer)",
    family: "mailer",
    description: "전자상거래 배송용. 자립형 날개와 잠금 구조.",
    dielineKind: "mailer",
  },
  {
    id: "two-piece-tray",
    name: "투피스 트레이 (Tray + Lid)",
    family: "tray",
    description: "트레이 본체 + 별도 뚜껑. 프리미엄 패키지에 사용.",
    dielineKind: "two-piece-tray",
  },
  {
    id: "sleeve",
    name: "슬리브 (Open Sleeve)",
    family: "sleeve",
    description: "트레이/내함을 감싸는 개방형 슬리브.",
    dielineKind: "sleeve",
  },
];

export function getBoxPreset(id: string | null): BoxPreset | undefined {
  if (!id) return undefined;
  return BOX_PRESETS.find((p) => p.id === id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 9 — surface illustration style presets.
// ─────────────────────────────────────────────────────────────────────────────

export const ARTWORK_PRESETS: ArtworkPreset[] = [
  {
    id: "black-white",
    name: "블랙 바탕 · 화이트 라인",
    background: "#111111",
    lineColor: "#ffffff",
  },
  {
    id: "white-black",
    name: "화이트 바탕 · 블랙 라인",
    background: "#ffffff",
    lineColor: "#111111",
  },
  {
    id: "kraft-white",
    name: "크래프트지 · 화이트 라인",
    background: "#b08d57",
    lineColor: "#ffffff",
  },
];

export function getArtworkPreset(id: string): ArtworkPreset {
  return ARTWORK_PRESETS.find((p) => p.id === id) ?? ARTWORK_PRESETS[0];
}
