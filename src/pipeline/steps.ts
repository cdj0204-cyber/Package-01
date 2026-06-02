// ─────────────────────────────────────────────────────────────────────────────
// The 12-step pipeline definition. Grouped into two stages:
//   Stage A — Insert foam (geometry):       steps 1..5 + export 12
//   Stage B — Package box (box & artwork):  steps 6..11
// Each step renders a contextual panel (see components/panels) and a viewport.
// ─────────────────────────────────────────────────────────────────────────────

export type ViewportKind = "3d" | "2d-silhouette" | "2d-artwork" | "2d-dieline";

export interface StepDef {
  id: number;
  title: string;
  short: string;
  stage: "A" | "B";
  viewport: ViewportKind;
}

export const STEPS: StepDef[] = [
  { id: 1, title: "제품 3D 데이터 import (STEP)", short: "Import", stage: "A", viewport: "3d" },
  { id: 2, title: "뷰별 아웃라인 실루엣 추출", short: "실루엣", stage: "A", viewport: "2d-silhouette" },
  { id: 3, title: "구배 각도 적용", short: "구배각", stage: "A", viewport: "2d-silhouette" },
  { id: 4, title: "박스 폼에서 불린 차집합", short: "불린", stage: "A", viewport: "3d" },
  { id: 5, title: "인서트 폼 제작 확인", short: "인서트", stage: "A", viewport: "3d" },
  { id: 6, title: "패키지 박스 유형 선택", short: "박스유형", stage: "B", viewport: "3d" },
  { id: 7, title: "박스 크기/공차 설정", short: "박스크기", stage: "B", viewport: "3d" },
  { id: 8, title: "박스 렌더링 확인", short: "렌더링", stage: "B", viewport: "3d" },
  { id: 9, title: "표면 일러스트 적용", short: "일러스트", stage: "B", viewport: "2d-artwork" },
  { id: 10, title: "표면 텍스트 작성/배치", short: "텍스트", stage: "B", viewport: "2d-artwork" },
  { id: 11, title: "도면 데이터 다운로드 (AI/DXF/SVG)", short: "도면출력", stage: "B", viewport: "2d-dieline" },
  { id: 12, title: "인서트 폼 다운로드 (STL/STEP/FBX/OBJ)", short: "폼출력", stage: "A", viewport: "3d" },
];

export function getStep(id: number): StepDef {
  return STEPS.find((s) => s.id === id) ?? STEPS[0];
}

export const STAGE_LABELS: Record<"A" | "B", string> = {
  A: "인서트 폼 (지오메트리)",
  B: "패키지 박스 (디자인)",
};
