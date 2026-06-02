# Package 01

제품 패키지 디자인 도구. 제품 3D(STEP) 데이터로부터 **인서트 폼**과 **패키지 상자 도면**을
만들어 내보내는 12단계 파이프라인을 가진 웹 앱.

스택: **Vite + React + TypeScript + three.js + occt-import-js(OpenCascade wasm)**

## 실행

```bash
cd Package01
npm install
npm run dev      # http://localhost:5173
npm run build    # 프로덕션 빌드 (dist/)
```

## 12단계 파이프라인

| # | 단계 | 상태 |
|---|------|------|
| 1 | STEP 파일 import | ✅ 구현 (occt-import-js) |
| 2 | 뷰별 아웃라인 실루엣 추출 | 🟡 스켈레톤 (투영 바운딩 외곽선 근사) |
| 3 | 구배(draft) 각도 적용 | 🟡 스켈레톤 (top 뷰 인출 로프트) |
| 4 | 박스 폼 불린 차집합 | 🟡 스켈레톤 (CSG 미적용, 미리보기) |
| 5 | 인서트 폼 확인 | ✅ |
| 6 | 박스 유형 선택 | ✅ 프리셋 5종 데이터 |
| 7 | 박스 크기/공차 | ✅ (직접입력 / 오프셋 산출) |
| 8 | 박스 3D 렌더링 | ✅ |
| 9 | 표면 일러스트 | ✅ 프리셋 3종 + 라인 드로잉 |
| 10 | 표면 텍스트 배치 | ✅ 드래그 배치 + 크기/각도 조절 |
| 11 | 도면 다운로드 | ✅ SVG/DXF / 🟡 AI(SVG 호환) |
| 12 | 인서트 폼 다운로드 | ✅ STL/OBJ / 🔴 STEP·FBX (커널 필요) |

## 구조

```
src/
  types/index.ts          도메인 타입 (전 파이프라인 공유)
  store/useStore.ts        zustand 중앙 상태 (프로젝트 + UI)
  pipeline/steps.ts        12단계 정의 (스테이지 A/B, 뷰포트 종류)
  geometry/
    stepImport.ts          STEP import (occt-import-js, 동적 로드)  ✅
    silhouette.ts          실루엣 추출                              🟡
    draft.ts               구배 솔리드 로프트                        🟡
    boolean.ts             블록 생성 + 불린 차집합                   🟡
    exporters.ts           STL/OBJ 출력 (STEP/FBX 스텁)             ✅/🔴
  box/
    presets.ts             박스 유형 + 아트워크 프리셋 (데이터 에셋)
    dieline.ts             전개도 생성 (cross 레이아웃)
    dielineExport.ts       SVG/DXF/AI 출력                          ✅
  components/
    Viewport3D.tsx         three.js 3D 뷰 (상태 기반 재구성)
    Viewport2D.tsx         실루엣/아트워크/도면 2D 캔버스 (텍스트 드래그)
    PanelHost.tsx          단계별 우측 패널 12종
```

## 다음에 채울 핵심부 (🟡/🔴)

스켈레톤에서 정밀도를 올리려면 **B-rep 지오메트리 커널**이 필요합니다.

1. **실루엣 (step 2)** — 투영 삼각형의 외곽 경계 추출(엣지 루프 / 2D 폴리곤 유니온),
   내부 구멍 검출. 또는 OCCT의 정확한 B-rep 실루엣.
2. **구배 (step 3)** — front/side 인출 방향 지원, 실루엣 구멍 반영, 정확한 드래프트 B-rep.
3. **불린 (step 4)** — 실제 CSG (OCCT `BRepAlgoAPI_Cut` 또는 three-bvh-csg),
   캐비티 깊이 = `height − floorOffset` 클램프.
4. **STEP/FBX 출력 (step 12)** — OCCT STEP writer / FBX SDK.
5. **AI 출력 (step 11)** — 네이티브 PDF/AI 작성기 (현재는 SVG 호환 바이트).

> 정밀 NURBS 불린/구배가 핵심이면, 표시용 occt-import-js 대신 **OpenCascade.js 풀
> 커널**을 붙여 B-rep을 유지하는 경로로 확장하는 것이 정공법입니다.
