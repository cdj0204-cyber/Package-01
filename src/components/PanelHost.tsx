import { useEffect, useRef, useState } from "react";
import { useStore, type CameraView } from "../store/useStore";
import { getStep, STEPS } from "../pipeline/steps";
import { VIEW_NAMES, type BoxFace, type ViewName, type ModelSilhouette, type LidSide, type LineArt, type LineArtLayerKind } from "../types";
import { lineArtBridge } from "./lineArtBridge";
import { ColorPicker } from "./ColorPicker";
import { drawIllustration, composeIllustration } from "./illustrationRender";
import { importStepFile } from "../geometry/stepImport";
import {
  buildBoxLocalMesh,
  subtractSolids,
  type BoxPose,
} from "../geometry/boolean";
import {
  buildExtrudeMesh,
  extrudeAABB,
  solidsPlacement,
} from "../geometry/silhouetteField";
import { exportMesh, downloadBlob, type MeshFormat } from "../geometry/exporters";
import { exportFoamStep } from "../geometry/ocBrep";
import {
  worldAlignValue,
  type AlignAxis,
  type AlignPick,
} from "../geometry/align";
import { BOX_PRESETS, ARTWORK_PRESETS, getBoxPreset, getArtworkPreset } from "../box/presets";
import { generateDieline } from "../box/dieline";
import { exportDieline, type VectorFormat } from "../box/dielineExport";

// ─────────────────────────────────────────────────────────────────────────────
// Renders the contextual right-hand panel for the active step, plus prev/next.
// ─────────────────────────────────────────────────────────────────────────────

export function PanelHost({ step }: { step: number }) {
  const def = getStep(step);
  const setStep = useStore((s) => s.setStep);

  return (
    <div>
      <h2>
        <span className="step-id">STEP {def.id}</span> · {def.title}
      </h2>
      <div style={{ marginTop: 12 }}>
        <StepBody step={step} />
      </div>
      <div className="nav-row">
        <button
          className="btn secondary"
          disabled={step <= 1}
          onClick={() => setStep(step - 1)}
        >
          ← 이전
        </button>
        <button
          className="btn"
          disabled={step >= STEPS.length}
          onClick={() => setStep(step + 1)}
        >
          다음 →
        </button>
      </div>
    </div>
  );
}

function StepBody({ step }: { step: number }) {
  switch (step) {
    case 1: return <Step1Import />;
    case 2: return <Step2Silhouette />;
    case 3: return <Step4Boolean />;
    case 4: return <Step5Insert />;
    case 5: return <Step6BoxType />;
    case 6: return <Step7Sizing />;
    case 7: return <Step7Illustration />;
    case 8: return <Step8Render />;
    case 9: return <Step11Dieline />;
    case 10: return <Step12FoamExport />;
    default: return null;
  }
}

// ── Step 1 ────────────────────────────────────────────────────────────────────
const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;
/** Round for display without fighting the user's typing. */
const r2 = (n: number) => Math.round(n * 100) / 100;

// Match the TransformControls gizmo axis colours (X=red, Y=green, Z=blue),
// brightened a touch so they read clearly on the dark panel.
const AXIS_COLORS = ["#ff4d4d", "#46d160", "#4d8bff"] as const;

// ── Alignment options (Step 1) ────────────────────────────────────────────────
type AlignIconKind =
  | "h-center"
  | "h-top"
  | "h-bottom"
  | "p-east"
  | "p-west"
  | "p-north"
  | "p-south"
  | "p-cx"
  | "p-cz";

interface AlignOpt {
  key: string;
  label: string;
  sub: string;
  axis: AlignAxis;
  pick: AlignPick;
  icon: AlignIconKind;
}

const HEIGHT_OPTS: AlignOpt[] = [
  { key: "h-center", label: "중심 높이", sub: "세로 중앙", axis: 1, pick: "center", icon: "h-center" },
  { key: "h-top", label: "꼭대기", sub: "윗면", axis: 1, pick: "max", icon: "h-top" },
  { key: "h-bottom", label: "바닥", sub: "바닥면", axis: 1, pick: "min", icon: "h-bottom" },
];

const POS_OPTS: AlignOpt[] = [
  { key: "p-north", label: "북 (N)", sub: "뒤쪽 −Z", axis: 2, pick: "min", icon: "p-north" },
  { key: "p-south", label: "남 (S)", sub: "앞쪽 +Z", axis: 2, pick: "max", icon: "p-south" },
  { key: "p-east", label: "동 (E)", sub: "오른쪽 +X", axis: 0, pick: "max", icon: "p-east" },
  { key: "p-west", label: "서 (W)", sub: "왼쪽 −X", axis: 0, pick: "min", icon: "p-west" },
  { key: "p-cx", label: "동서 중앙", sub: "X축 중앙 정렬", axis: 0, pick: "center", icon: "p-cx" },
  { key: "p-cz", label: "남북 중앙", sub: "Z축 중앙 정렬", axis: 2, pick: "center", icon: "p-cz" },
];

// Small diagram showing where models snap to (guide line = accent, rects = models).
function AlignIcon({ kind }: { kind: AlignIconKind }) {
  const rectFill = "#7d93ab";
  const guide = "#f0883e";
  let rects: Array<[number, number, number, number]> = [];
  let line: [number, number, number, number] = [0, 0, 0, 0];
  switch (kind) {
    case "h-bottom":
      rects = [[7, 7, 11, 20], [22, 15, 11, 12]];
      line = [2, 27, 38, 27];
      break;
    case "h-center":
      rects = [[7, 6, 11, 20], [22, 10, 11, 12]];
      line = [2, 16, 38, 16];
      break;
    case "h-top":
      rects = [[7, 5, 11, 20], [22, 5, 11, 12]];
      line = [2, 5, 38, 5];
      break;
    case "p-east":
      rects = [[23, 4, 14, 11], [17, 18, 20, 10]];
      line = [37, 3, 37, 29];
      break;
    case "p-west":
      rects = [[3, 4, 14, 11], [3, 18, 20, 10]];
      line = [3, 3, 3, 29];
      break;
    case "p-north":
      rects = [[6, 3, 11, 18], [21, 3, 11, 12]];
      line = [3, 3, 37, 3];
      break;
    case "p-south":
      rects = [[6, 11, 11, 18], [21, 17, 11, 12]];
      line = [3, 29, 37, 29];
      break;
    case "p-cx": // centre on the X (east-west) axis → vertical centre line
      rects = [[13, 4, 14, 11], [10, 18, 20, 10]];
      line = [20, 3, 20, 29];
      break;
    case "p-cz": // centre on the Z (north-south) axis → horizontal centre line
      rects = [[6, 7, 11, 18], [21, 10, 11, 12]];
      line = [3, 16, 37, 16];
      break;
  }
  return (
    <svg width="40" height="32" viewBox="0 0 40 32" aria-hidden>
      {rects.map((r, i) => (
        <rect
          key={i}
          x={r[0]}
          y={r[1]}
          width={r[2]}
          height={r[3]}
          rx={1.5}
          fill={rectFill}
          fillOpacity={0.55}
          stroke={rectFill}
        />
      ))}
      <line
        x1={line[0]}
        y1={line[1]}
        x2={line[2]}
        y2={line[3]}
        stroke={guide}
        strokeWidth={2}
        strokeDasharray="3 2"
      />
    </svg>
  );
}

function AlignCategory({
  title,
  open,
  onToggle,
  options,
  disabled,
  onPick,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  options: AlignOpt[];
  disabled: boolean;
  onPick: (o: AlignOpt) => void;
}) {
  return (
    <div className={"align-cat" + (open ? " open" : "")}>
      <div className="align-cat-head" onClick={onToggle}>
        <span>{title}</span>
        <span className="chev">▾</span>
      </div>
      {open && (
        <div className="align-body">
          {options.map((o) => (
            <button
              key={o.key}
              className="align-opt"
              disabled={disabled}
              onClick={() => onPick(o)}
            >
              <AlignIcon kind={o.icon} />
              <span>
                <span className="lab">{o.label}</span>
                <br />
                <span className="sub">{o.sub}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Numeric editor for the SELECTED model's placement. Two-way bound to the
// store, so the gizmo and these fields stay in sync.
function PlacementEditor() {
  const models = useStore((s) => s.models);
  const selectedModelId = useStore((s) => s.selectedModelId);
  const setModelTransform = useStore((s) => s.setModelTransform);
  const resetSelectedTransform = useStore((s) => s.resetSelectedTransform);
  const gizmoMode = useStore((s) => s.gizmoMode);
  const setGizmoMode = useStore((s) => s.setGizmoMode);

  const placed = models.find((m) => m.id === selectedModelId);
  if (!placed) {
    return (
      <div className="note" style={{ marginTop: 14, color: "var(--text-dim)" }}>
        뷰포트나 목록에서 모델을 선택하면 위치·각도를 조절할 수 있습니다.
      </div>
    );
  }
  const t = placed.transform;
  const id = placed.id;

  const setPos = (i: number, v: number) => {
    if (Number.isNaN(v)) return;
    const position = [...t.position] as [number, number, number];
    position[i] = v;
    setModelTransform(id, { position, rotation: t.rotation });
  };
  const setRotDeg = (i: number, deg: number) => {
    if (Number.isNaN(deg)) return;
    const rotation = [...t.rotation] as [number, number, number];
    rotation[i] = deg * DEG2RAD;
    setModelTransform(id, { position: t.position, rotation });
  };

  const axes = ["X", "Y", "Z"] as const;

  return (
    <div style={{ marginTop: 18 }}>
      <div
        className="note"
        style={{ marginTop: 0, marginBottom: 8, color: "var(--accent-2)" }}
      >
        선택: {placed.name}
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 8,
        }}
      >
        <strong style={{ fontSize: 13 }}>위치 · 각도</strong>
        <div className="btn-row" style={{ margin: 0 }}>
          <button
            className={"vp-toggle" + (gizmoMode === "translate" ? " on" : "")}
            style={{ flex: "none", padding: "4px 8px" }}
            onClick={() => setGizmoMode("translate")}
          >
            이동
          </button>
          <button
            className={"vp-toggle" + (gizmoMode === "rotate" ? " on" : "")}
            style={{ flex: "none", padding: "4px 8px" }}
            onClick={() => setGizmoMode("rotate")}
          >
            회전
          </button>
        </div>
      </div>

      <div className="field">
        <label>위치 (mm)</label>
        <div className="row">
          {axes.map((ax, i) => (
            <div className="axis-cell" key={"p" + ax}>
              <span className="axis-tag" style={{ color: AXIS_COLORS[i] }}>
                {ax}
              </span>
              <input
                type="number"
                step={1}
                value={r2(t.position[i])}
                style={{ borderLeft: `3px solid ${AXIS_COLORS[i]}` }}
                onChange={(e) => setPos(i, parseFloat(e.target.value))}
              />
            </div>
          ))}
        </div>
      </div>

      <div className="field">
        <label>회전 (°)</label>
        <div className="row">
          {axes.map((ax, i) => (
            <div className="axis-cell" key={"r" + ax}>
              <span className="axis-tag" style={{ color: AXIS_COLORS[i] }}>
                {ax}
              </span>
              <input
                type="number"
                step={0.1}
                value={r2(t.rotation[i] * RAD2DEG)}
                style={{ borderLeft: `3px solid ${AXIS_COLORS[i]}` }}
                onChange={(e) => setRotDeg(i, parseFloat(e.target.value))}
              />
            </div>
          ))}
        </div>
      </div>

      <button
        className="btn secondary block"
        onClick={() => resetSelectedTransform()}
      >
        위치/각도 리셋
      </button>
    </div>
  );
}

function Step1Import() {
  const models = useStore((s) => s.models);
  const selectedModelId = useStore((s) => s.selectedModelId);
  const addModels = useStore((s) => s.addModels);
  const removeModel = useStore((s) => s.removeModel);
  const selectModel = useStore((s) => s.selectModel);
  const setModelTransform = useStore((s) => s.setModelTransform);
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [openCat, setOpenCat] = useState<"height" | "position" | null>("height");

  // Align every other model's chosen edge/center to the selected model's same
  // reference along one world axis (a pure translation, so rotation is kept).
  function alignAlong(axis: AlignAxis, pick: AlignPick) {
    const ref = models.find((m) => m.id === selectedModelId);
    if (!ref) return;
    const refV = worldAlignValue(ref, axis, pick);
    for (const m of models) {
      if (m.id === ref.id) continue;
      const delta = refV - worldAlignValue(m, axis, pick);
      if (Math.abs(delta) < 1e-6) continue;
      const position = [...m.transform.position] as [number, number, number];
      position[axis] += delta;
      setModelTransform(m.id, { position, rotation: m.transform.rotation });
    }
  }

  async function onFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;
    setBusy(true);
    setErr(null);
    const ok: Array<{ model: any; name: string }> = [];
    const failed: string[] = [];
    for (const file of files) {
      try {
        const m = await importStepFile(file);
        ok.push({ model: m, name: file.name });
      } catch {
        failed.push(file.name);
      }
    }
    if (ok.length) addModels(ok);
    if (failed.length) setErr(`불러오기 실패: ${failed.join(", ")}`);
    setBusy(false);
    e.target.value = ""; // allow re-importing the same file
  }

  return (
    <div>
      <p className="hint">
        제품의 3D 데이터를 STEP(.step/.stp) 형식으로 불러옵니다. 여러 개를 한 번에
        선택할 수 있고, 추가로 더 불러올 수도 있습니다. 각 모델은 뷰포트에서
        클릭해 선택한 뒤 이동·회전할 수 있습니다.
      </p>
      <input
        ref={inputRef}
        type="file"
        accept=".step,.stp"
        multiple
        style={{ display: "none" }}
        onChange={onFiles}
      />
      <button
        className="btn block"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
      >
        {busy ? "불러오는 중…" : models.length ? "STEP 파일 추가" : "STEP 파일 선택"}
      </button>
      {err && <div className="note warn">⚠ {err}</div>}

      {models.length > 0 && (
        <div className="model-list">
          <div className="list-head">불러온 모델 {models.length}개</div>
          {models.map((pm) => {
            const sz = [0, 1, 2].map(
              (i) => pm.model.bbox.max[i] - pm.model.bbox.min[i]
            );
            return (
              <div
                key={pm.id}
                className={
                  "model-item" + (pm.id === selectedModelId ? " sel" : "")
                }
                onClick={() => selectModel(pm.id)}
              >
                <div className="grow">
                  <div className="name">{pm.name}</div>
                  <div className="meta">
                    메쉬 {pm.model.meshes.length} · {sz[0].toFixed(0)}×
                    {sz[1].toFixed(0)}×{sz[2].toFixed(0)} mm
                  </div>
                </div>
                <button
                  className="btn secondary"
                  title="삭제"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    removeModel(pm.id);
                  }}
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>
      )}

      {models.length >= 2 && (
        <div style={{ marginTop: 14 }}>
          <div className="list-head">선택 모델 기준 정렬</div>
          {!selectedModelId && (
            <div className="note warn" style={{ marginTop: 0 }}>
              기준이 될 모델을 먼저 선택하세요.
            </div>
          )}
          <AlignCategory
            title="① 높이 정렬 (Y)"
            open={openCat === "height"}
            onToggle={() =>
              setOpenCat(openCat === "height" ? null : "height")
            }
            options={HEIGHT_OPTS}
            disabled={!selectedModelId}
            onPick={(o) => alignAlong(o.axis, o.pick)}
          />
          <AlignCategory
            title="② 위치 정렬 (탑뷰 · 동서남북)"
            open={openCat === "position"}
            onToggle={() =>
              setOpenCat(openCat === "position" ? null : "position")
            }
            options={POS_OPTS}
            disabled={!selectedModelId}
            onPick={(o) => alignAlong(o.axis, o.pick)}
          />
        </div>
      )}

      {models.length > 0 && <PlacementEditor />}
    </div>
  );
}

// ── Step 2 ────────────────────────────────────────────────────────────────────
const VIEW_LABELS: Record<ViewName, string> = {
  top: "탑 (Top)",
  front: "프론트 (Front)",
  side: "사이드 (Side)",
};

function Step2Silhouette() {
  const models = useStore((s) => s.models);
  const selectedModelId = useStore((s) => s.selectedModelId);
  const selectModel = useStore((s) => s.selectModel);
  const view = useStore((s) => s.silhouetteView);
  const setView = useStore((s) => s.setSilhouetteView);
  const modelSilhouettes = useStore((s) => s.modelSilhouettes);
  const extract = useStore((s) => s.extractModelSilhouette);
  const setOffset = useStore((s) => s.setSilhouetteOffset);
  const setExtrude = useStore((s) => s.setSilhouetteExtrude);
  const setDraft = useStore((s) => s.setSilhouetteDraft);
  const clear = useStore((s) => s.clearModelSilhouette);

  if (!models.length) {
    return (
      <div className="note warn">먼저 STEP 모델을 import 하세요 (Step 1).</div>
    );
  }

  const sel = selectedModelId ? modelSilhouettes[selectedModelId] : undefined;
  const selModel = models.find((m) => m.id === selectedModelId);
  const staleView = sel && sel.view !== view;

  return (
    <div>
      <p className="hint">
        선택한 뷰에서 각 제품의 아웃라인 실루엣을 추출합니다. 추출된 라인은
        뷰포트에 표시되며, 오프셋(+/−)을 준 뒤 평면으로 익스트루드해 인서트 폼의
        캐비티 기준 솔리드를 만듭니다.
      </p>

      <div className="field">
        <label>추출 뷰</label>
        <div className="btn-row">
          {VIEW_NAMES.map((v) => (
            <button
              key={v}
              className={"vp-toggle" + (view === v ? " on" : "")}
              style={{ flex: 1 }}
              onClick={() => setView(v)}
            >
              {VIEW_LABELS[v]}
            </button>
          ))}
        </div>
      </div>

      <div className="model-list">
        <div className="list-head">제품별 실루엣</div>
        {models.map((pm) => {
          const ms = modelSilhouettes[pm.id];
          const ok = ms && ms.view === view;
          return (
            <div
              key={pm.id}
              className={
                "model-item" + (pm.id === selectedModelId ? " sel" : "")
              }
              onClick={() => selectModel(pm.id)}
            >
              <div className="grow">
                <div className="name">{pm.name}</div>
                <div className="meta">
                  {ms
                    ? ok
                      ? "실루엣 추출됨 ✓"
                      : `다른 뷰(${ms.view})에서 추출됨`
                    : "미추출"}
                </div>
              </div>
              <button
                className={"btn " + (ok ? "secondary" : "")}
                onClick={(ev) => {
                  ev.stopPropagation();
                  selectModel(pm.id);
                  extract(pm.id);
                }}
              >
                {ok ? "재추출" : "추출"}
              </button>
            </div>
          );
        })}
      </div>

      <button
        className="btn block secondary"
        style={{ marginTop: 8 }}
        onClick={() => models.forEach((m) => extract(m.id))}
      >
        ⬇ 전체 모델 {view} 실루엣 추출
      </button>

      {selModel && !sel && (
        <div className="note warn" style={{ marginTop: 12 }}>
          “{selModel.name}”의 실루엣을 추출하면 오프셋·익스트루드를 조절할 수
          있습니다.
        </div>
      )}

      {staleView && (
        <div className="note warn" style={{ marginTop: 12 }}>
          현재 뷰({view})와 추출된 뷰({sel!.view})가 다릅니다. 재추출하세요.
        </div>
      )}

      {sel && selModel && (
        <SilhouetteEditor
          name={selModel.name}
          sil={sel}
          onOffset={(v) => setOffset(sel.modelId, v)}
          onExtrude={(v) => setExtrude(sel.modelId, v)}
          onDraft={(v) => setDraft(sel.modelId, v)}
          onClear={() => clear(sel.modelId)}
        />
      )}
    </div>
  );
}

function SilhouetteEditor({
  name,
  sil,
  onOffset,
  onExtrude,
  onDraft,
  onClear,
}: {
  name: string;
  sil: import("../types").ModelSilhouette;
  onOffset: (v: number) => void;
  onExtrude: (v: number) => void;
  onDraft: (v: number) => void;
  onClear: () => void;
}) {
  const maxOff = Math.round(sil.field.pad);
  const w = sil.field.uvMax[0] - sil.field.uvMin[0];
  const h = sil.field.uvMax[1] - sil.field.uvMin[1];

  return (
    <div style={{ marginTop: 16, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
      <div className="note" style={{ marginTop: 0, marginBottom: 10, color: "var(--accent-2)" }}>
        선택: {name} · {sil.view} 뷰 · {w.toFixed(1)} × {h.toFixed(1)} mm
      </div>

      <div className="field">
        <label>
          오프셋 (mm) <span style={{ color: "var(--text-dim)" }}>· +확대 / −축소</span>
        </label>
        <input
          type="number"
          step={0.5}
          value={r2(sil.offset)}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (!Number.isNaN(v)) onOffset(v);
          }}
        />
        <input
          type="range"
          min={-Math.min(w, h) / 2}
          max={maxOff}
          step={0.1}
          value={sil.offset}
          style={{ width: "100%", marginTop: 6 }}
          onChange={(e) => onOffset(parseFloat(e.target.value))}
        />
      </div>

      <div className="field">
        <label>
          익스트루드 길이 (mm) <span style={{ color: "var(--text-dim)" }}>· 0.1mm 단위</span>
        </label>
        <input
          type="number"
          step={0.1}
          min={0.1}
          value={r2(sil.extrudeDepth)}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (!Number.isNaN(v)) onExtrude(v);
          }}
        />
      </div>

      <div className="note">
        뷰포트의 검볼(화살표)을 드래그하면 익스트루드 길이를 직접 조절할 수
        있습니다.
      </div>

      <div className="field" style={{ marginTop: 14 }}>
        <label>
          구배각 (°){" "}
          <span style={{ color: "var(--text-dim)" }}>· +상단 좁아짐 / −넓어짐</span>
        </label>
        <input
          type="number"
          step={0.5}
          value={r2(sil.draftDeg)}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (!Number.isNaN(v)) onDraft(v);
          }}
        />
        <input
          type="range"
          min={-20}
          max={20}
          step={0.5}
          value={sil.draftDeg}
          style={{ width: "100%", marginTop: 6 }}
          onChange={(e) => onDraft(parseFloat(e.target.value))}
        />
      </div>

      <button className="btn secondary block" style={{ marginTop: 10 }} onClick={onClear}>
        실루엣 삭제
      </button>
    </div>
  );
}

// ── Step 3 (불린) ─────────────────────────────────────────────────────────────
function Step4Boolean() {
  const models = useStore((s) => s.models);
  const selectedModelId = useStore((s) => s.selectedModelId);
  const selectModel = useStore((s) => s.selectModel);
  const modelSilhouettes = useStore((s) => s.modelSilhouettes);
  const boxForm = useStore((s) => s.boxForm);
  const updateBoxForm = useStore((s) => s.updateBoxForm);
  const boxTransform = useStore((s) => s.boxTransform);
  const setBoxTransform = useStore((s) => s.setBoxTransform);
  const boxEditMode = useStore((s) => s.boxEditMode);
  const setBoxEditMode = useStore((s) => s.setBoxEditMode);
  const setInsert = useStore((s) => s.setInsertFoam);
  const foam = useStore((s) => s.insertFoam);
  const [busy, setBusy] = useState(false);

  // Solids carried over from Step 2 (offset + draft applied).
  const solids = models
    .map((m) => ({ pm: m, sil: modelSilhouettes[m.id] }))
    .filter((x) => x.sil);

  // Box pose: explicit (after align/gizmo edit) or auto-framed on all solids.
  function autoPose(): BoxPose | null {
    const place = solidsPlacement(solids.map((s) => s.sil!));
    if (!place) return null;
    return {
      position: [place.cx, place.baseY + boxForm.height / 2, place.cz],
      rotation: [0, 0, 0],
    };
  }

  // Align the box-form centre to the selected solid (XZ centre + sit on its base).
  function alignToSelected() {
    const target = solids.find((x) => x.pm.id === selectedModelId) ?? solids[0];
    if (!target) return;
    const box = extrudeAABB(target.sil!);
    if (!box) return;
    setBoxTransform({
      position: [
        (box.min[0] + box.max[0]) / 2,
        box.min[1] + boxForm.height / 2,
        (box.min[2] + box.max[2]) / 2,
      ],
      rotation: [0, 0, 0],
    });
  }

  function run() {
    if (!solids.length) return;
    const pose = boxTransform ?? autoPose();
    if (!pose) return;
    setBusy(true);
    try {
      const block = buildBoxLocalMesh(boxForm);
      const tools = solids
        .map((s) => buildExtrudeMesh(s.sil!))
        .filter(Boolean) as Array<NonNullable<ReturnType<typeof buildExtrudeMesh>>>;
      setInsert(subtractSolids(block, pose, tools));
    } finally {
      setBusy(false);
    }
  }

  const EDIT_MODES: Array<{ id: typeof boxEditMode; label: string; hint: string }> = [
    { id: "resize", label: "크기조절", hint: "면의 화살표를 잡고 늘려 볼륨 조절" },
    { id: "move", label: "이동", hint: "박스 폼 위치 이동" },
    { id: "rotate", label: "회전", hint: "박스 폼 회전" },
  ];

  const f = (k: keyof typeof boxForm, label: string) => (
    <div className="field" key={k}>
      <label>{label}</label>
      <input
        type="number"
        value={boxForm[k]}
        onChange={(e) => updateBoxForm({ [k]: Number(e.target.value) } as any)}
      />
    </div>
  );

  if (!solids.length) {
    return (
      <div className="note warn">
        먼저 Step 2에서 실루엣을 추출해 익스트루드 솔리드를 만드세요.
      </div>
    );
  }

  return (
    <div>
      <p className="hint">
        Step 2에서 만든 솔리드(오프셋·구배각 적용)를 그대로 가져옵니다. 박스 폼의
        볼륨을 만들고(면 화살표로 크기 조절 / 이동 / 회전), 솔리드가 박스 폼 안에
        들어가면 겹치는 부분이 연두색으로 미리 표시됩니다. 마지막에 불린 차집합으로
        인서트 폼을 만듭니다.
      </p>

      <div className="list-head" style={{ marginBottom: 6 }}>박스 폼 편집 모드</div>
      <div className="seg-row">
        {EDIT_MODES.map((m) => (
          <button
            key={m.id}
            className={"seg-btn" + (boxEditMode === m.id ? " on" : "")}
            onClick={() => setBoxEditMode(m.id)}
            title={m.hint}
          >
            {m.label}
          </button>
        ))}
      </div>
      <div className="note" style={{ marginTop: 6 }}>
        {EDIT_MODES.find((m) => m.id === boxEditMode)?.hint}
      </div>

      <div className="list-head" style={{ margin: "10px 0 6px" }}>박스 폼 크기</div>
      {f("width", "폼 가로 W · X (mm)")}
      {f("height", "폼 높이 H · Y (mm)")}
      {f("depth", "폼 세로 D · Z (mm)")}

      <div className="model-list">
        <div className="list-head">정렬 기준 솔리드 선택</div>
        {solids.map(({ pm }) => (
          <div
            key={pm.id}
            className={"model-item" + (pm.id === selectedModelId ? " sel" : "")}
            onClick={() => selectModel(pm.id)}
          >
            <div className="grow">
              <div className="name">{pm.name}</div>
              <div className="meta">{modelSilhouettes[pm.id]?.view} 뷰 솔리드</div>
            </div>
          </div>
        ))}
      </div>

      <button
        className="btn block secondary"
        style={{ marginTop: 8 }}
        disabled={!selectedModelId}
        onClick={alignToSelected}
        title="선택한 솔리드에 박스 폼 위치를 맞춥니다 (XZ 중심 + 바닥 높이)"
      >
        ⟱ 선택 솔리드에 박스 폼 정렬
      </button>

      <div className="note" style={{ marginTop: 6 }}>
        박스 폼 중심: {boxTransform
          ? `X ${r2(boxTransform.position[0])} · Y ${r2(boxTransform.position[1])} · Z ${r2(boxTransform.position[2])}`
          : "자동 (전체 솔리드 기준)"}
      </div>

      <button
        className="btn block"
        style={{ marginTop: 10 }}
        disabled={busy}
        onClick={run}
      >
        {busy ? "계산 중…" : `불린 차집합 실행 (솔리드 ${solids.length}개)`}
      </button>

      {foam.ready && (
        <div className="note" style={{ color: "var(--ok)", marginTop: 8 }}>
          ✓ 인서트 폼 생성 완료 — Step 4에서 확인할 수 있습니다.
        </div>
      )}
    </div>
  );
}

// ── Step 5 ────────────────────────────────────────────────────────────────────
function Step5Insert() {
  const foam = useStore((s) => s.insertFoam);
  const setStep = useStore((s) => s.setStep);
  return (
    <div>
      <p className="hint">
        제작된 인서트 폼 결과를 확인합니다. 이상이 없으면 마지막 단계에서 3D
        포맷으로 내보낼 수 있습니다.
      </p>
      {foam.ready ? (
        <div className="note" style={{ color: "var(--ok)" }}>
          ✓ 인서트 폼이 생성되었습니다.
          <div className="btn-row">
            <button className="btn" onClick={() => setStep(11)}>
              폼 다운로드로 이동 (Step 11)
            </button>
          </div>
        </div>
      ) : (
        <div className="note warn">Step 3에서 불린 차집합을 먼저 실행하세요.</div>
      )}
    </div>
  );
}

// ── Step 6 ────────────────────────────────────────────────────────────────────
function Step6BoxType() {
  const boxPresetId = useStore((s) => s.boxPresetId);
  const setBoxPreset = useStore((s) => s.setBoxPreset);
  const boxForm = useStore((s) => s.boxForm);
  const sizing = useStore((s) => s.boxSizing);
  const update = useStore((s) => s.updateBoxSizing);

  // On picking a box type, default its size to FIT the insert foam we made
  // (the boxForm block the foam was cut from) plus the offset — so Step 7 opens
  // already sized to the insert. Only on a real type change, to avoid clobbering
  // a size the user has since customised.
  function select(id: string) {
    if (boxPresetId !== id) {
      update({
        mode: "offset",
        width: boxForm.width + sizing.offset * 2,
        depth: boxForm.depth + sizing.offset * 2,
        height: boxForm.height + sizing.offset,
      });
    }
    setBoxPreset(id);
  }

  return (
    <div>
      <p className="hint">
        패키지 상자 유형을 선택합니다. 각 유형은 전개도(도면) 생성 방식이 다릅니다.
        선택 시 상자 크기는 인서트 폼에 맞춰 자동 설정됩니다.
      </p>
      {BOX_PRESETS.map((p) => (
        <div
          key={p.id}
          className={"preset-card" + (boxPresetId === p.id ? " sel" : "")}
          onClick={() => select(p.id)}
        >
          <div className="name">
            {p.name} <span className="tag">{p.family}</span>
          </div>
          <div className="desc">{p.description}</div>
        </div>
      ))}
    </div>
  );
}

// ── Step 7 ────────────────────────────────────────────────────────────────────
function Step7Sizing() {
  const sizing = useStore((s) => s.boxSizing);
  const update = useStore((s) => s.updateBoxSizing);
  const foam = useStore((s) => s.insertFoam);
  const boxForm = useStore((s) => s.boxForm);
  const boxPresetId = useStore((s) => s.boxPresetId);
  const lidSide = useStore((s) => s.boxLidSide);
  const setLidSide = useStore((s) => s.setBoxLidSide);
  const kind = getBoxPreset(boxPresetId)?.dielineKind;
  const hasLid = kind === "g-type" || kind === "mailer";

  function applyOffset() {
    update({
      mode: "offset",
      width: boxForm.width + sizing.offset * 2,
      depth: boxForm.depth + sizing.offset * 2,
      height: boxForm.height + sizing.offset,
    });
  }

  return (
    <div>
      <p className="hint">
        인서트 폼으로부터 공차를 두고 상자 볼륨을 정합니다. 직접 입력하거나, 동일
        오프셋으로 자동 산출할 수 있습니다.
      </p>
      <div className="field">
        <label>모드</label>
        <select value={sizing.mode} onChange={(e) => update({ mode: e.target.value as any })}>
          <option value="offset">인서트 폼 오프셋</option>
          <option value="manual">직접 입력</option>
        </select>
      </div>
      {sizing.mode === "offset" ? (
        <>
          <div className="field">
            <label>오프셋 거리 (mm)</label>
            <input type="number" value={sizing.offset}
              onChange={(e) => update({ offset: Number(e.target.value) })} />
          </div>
          <button className="btn block secondary" disabled={!foam.ready} onClick={applyOffset}>
            오프셋으로 크기 산출
          </button>
        </>
      ) : null}
      <div className="field" style={{ marginTop: 14 }}>
        <label>내경 가로 / 세로 / 높이 (mm)</label>
        <div className="row">
          <input type="number" value={sizing.width} onChange={(e) => update({ width: Number(e.target.value) })} />
          <input type="number" value={sizing.depth} onChange={(e) => update({ depth: Number(e.target.value) })} />
          <input type="number" value={sizing.height} onChange={(e) => update({ height: Number(e.target.value) })} />
        </div>
      </div>
      <div className="field">
        <label>공차/여유 (mm)</label>
        <input type="number" value={sizing.tolerance}
          onChange={(e) => update({ tolerance: Number(e.target.value) })} />
      </div>
      {hasLid ? (
        <div className="field" style={{ marginTop: 14 }}>
          <label>뚜껑 부착 방향 (G형)</label>
          <select value={lidSide} onChange={(e) => setLidSide(e.target.value as LidSide)}>
            <option value="width">가로면에 부착</option>
            <option value="depth">세로면에 부착</option>
          </select>
        </div>
      ) : null}
    </div>
  );
}

// ── Step 8 — render & apply saved illustrations to box faces ────────────────────
const FACE_META: Array<{ key: BoxFace; label: string; view: CameraView; lidOnly?: boolean }> = [
  { key: "front", label: "정면", view: "front" },
  { key: "back", label: "후면", view: "rear" },
  { key: "right", label: "우측", view: "right" },
  { key: "left", label: "좌측", view: "left" },
  { key: "top", label: "윗면", view: "top" },
  { key: "tuck", label: "앞 덮개", view: "front", lidOnly: true },
];

function Step8Render() {
  const presetId = useStore((s) => s.boxPresetId);
  const saved = useStore((s) => s.savedIllustrations);
  const faceArt = useStore((s) => s.boxFaceArtwork);
  const setFaceArt = useStore((s) => s.setBoxFaceArtwork);
  const setCameraView = useStore((s) => s.setCameraView);
  const boxClosed = useStore((s) => s.boxClosed);
  const setBoxClosed = useStore((s) => s.setBoxClosed);
  const [selFace, setSelFace] = useState<BoxFace>("front");

  if (!presetId) {
    return <div className="note warn">박스 유형을 먼저 선택하세요 (Step 5).</div>;
  }

  const hasLid = getBoxPreset(presetId)?.dielineKind === "g-type";
  const faces = FACE_META.filter((f) => hasLid || !f.lidOnly);
  const selMeta = FACE_META.find((f) => f.key === selFace)!;
  const assigned = faceArt[selFace];
  const pickFace = (f: (typeof FACE_META)[number]) => {
    setSelFace(f.key);
    setCameraView(f.view);
  };

  return (
    <div>
      <p className="hint">
        박스 면을 선택하고, Step 7에서 저장한 일러스트를 적용합니다. 면을 고르면
        좌측 3D 뷰가 해당 면을 바라봅니다.
      </p>

      {hasLid && (
        <>
          <div className="list-head" style={{ marginBottom: 6 }}>뚜껑 상태</div>
          <div className="seg-row" style={{ marginBottom: 12 }}>
            <button
              className={"seg-btn" + (!boxClosed ? " on" : "")}
              onClick={() => setBoxClosed(false)}
            >
              열린 모습
            </button>
            <button
              className={"seg-btn" + (boxClosed ? " on" : "")}
              onClick={() => setBoxClosed(true)}
            >
              닫힌 모습
            </button>
          </div>
        </>
      )}

      <div className="list-head" style={{ marginBottom: 6 }}>면 선택</div>
      <div className="seg-row" style={{ flexWrap: "wrap", gap: 4 }}>
        {faces.map((f) => (
          <button
            key={f.key}
            className={"seg-btn" + (selFace === f.key ? " on" : "")}
            onClick={() => pickFace(f)}
            title={faceArt[f.key] ? "적용됨" : "비어 있음"}
          >
            {f.label}
            {faceArt[f.key] ? " ●" : ""}
          </button>
        ))}
      </div>

      <div className="list-head" style={{ margin: "14px 0 6px" }}>
        ‘{selMeta.label}’ 면에 적용할 일러스트
      </div>
      {!saved.length ? (
        <div className="note warn">
          저장된 일러스트가 없습니다. Step 7에서 먼저 렌더링을 저장하세요.
        </div>
      ) : (
        <div className="ill-grid">
          <button
            className={"ill-cell" + (!assigned ? " on" : "")}
            onClick={() => setFaceArt(selFace, null)}
          >
            <span className="ill-none">비우기</span>
          </button>
          {saved.map((item) => (
            <button
              key={item.id}
              className={"ill-cell" + (assigned === item.id ? " on" : "")}
              onClick={() => setFaceArt(selFace, item.id)}
              title={`${item.name} · ${item.view} 뷰`}
            >
              <img src={item.thumbnail} alt={item.name} />
              <span className="ill-name">{item.name}</span>
            </button>
          ))}
        </div>
      )}

      <div className="list-head" style={{ margin: "16px 0 6px" }}>면별 적용 현황</div>
      <div className="face-summary">
        {faces.map((f) => {
          const it = saved.find((s) => s.id === faceArt[f.key]);
          return (
            <div className="face-row" key={f.key}>
              <span className="grow">{f.label}</span>
              <span style={{ color: it ? "var(--text)" : "var(--text-dim)" }}>
                {it ? it.name : "—"}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Step 7 — illustration (extract + edit, merged) ─────────────────────────────
// (Viewpoint switching now lives in the 3D viewport's "뷰포트 시점" menu.)
// Display order + labels + draw color/z-order for the four illustration layers.
const LAYER_META: Record<
  LineArtLayerKind,
  { label: string; color: string; z: number }
> = {
  silhouette: { label: "외곽 실루엣 라인", color: "#ffd33d", z: 3 },
  shaded: { label: "음영 렌더링", color: "#9aa3ad", z: 0 },
  edges: { label: "라인 드로잉 (엣지)", color: "#f0883e", z: 2 },
  wireframe: { label: "라인 드로잉 (와이어프레임)", color: "#7d93ab", z: 1 },
};
const LAYER_ORDER: LineArtLayerKind[] = ["silhouette", "shaded", "edges", "wireframe"];

// Layered preview (SVG): raster <image> for shaded, <path> for vector layers,
// each with its own opacity, drawn back-to-front by z-order.
function LineArtPreview({ art }: { art: LineArt }) {
  const bw = (art.bbox.max[0] - art.bbox.min[0]) || 1;
  const bh = (art.bbox.max[1] - art.bbox.min[1]) || 1;
  const w = bw * art.aspect;
  const VW = 230, VH = 170, pad = 8;
  const k = Math.min((VW - pad * 2) / w, (VH - pad * 2) / bh);
  const dw = w * k, dh = bh * k;
  const ox = (VW - dw) / 2, oy = (VH - dh) / 2;
  const X = (nx: number) => ox + ((nx - art.bbox.min[0]) / bw) * dw;
  const Y = (ny: number) => oy + ((art.bbox.max[1] - ny) / bh) * dh; // flip y
  const ordered = art.layers
    .filter((l) => l.enabled)
    .sort((a, b) => LAYER_META[a.kind].z - LAYER_META[b.kind].z);
  return (
    <div style={{ marginTop: 10 }}>
      <div className="list-head" style={{ marginBottom: 6 }}>미리보기</div>
      <svg
        width="100%"
        viewBox={`0 0 ${VW} ${VH}`}
        style={{ background: "#0d1117", border: "1px solid var(--border)", borderRadius: 4 }}
      >
        {ordered.map((layer) => {
          if (layer.kind === "shaded") {
            return layer.image ? (
              <image
                key="shaded"
                href={layer.image}
                x={ox}
                y={oy}
                width={dw}
                height={dh}
                opacity={layer.opacity}
                preserveAspectRatio="none"
              />
            ) : null;
          }
          if (!layer.segments) return null;
          const d = layer.segments
            .map((s) => `M${X(s[0][0]).toFixed(1)} ${Y(s[0][1]).toFixed(1)}L${X(s[1][0]).toFixed(1)} ${Y(s[1][1]).toFixed(1)}`)
            .join("");
          return (
            <path
              key={layer.kind}
              d={d}
              fill="none"
              stroke={layer.color ?? LAYER_META[layer.kind].color}
              strokeWidth={layer.kind === "silhouette" ? 1.6 : 0.7}
              opacity={layer.opacity}
            />
          );
        })}
      </svg>
    </div>
  );
}

// ── Step 7 — illustration split workspace (3D viewport ‖ live preview) ──────────
// Left-column options drive the 3D VIEWPORT (which product, viewpoint, placement,
// extraction). Used by App's two-pane Step-7 layout and the stacked fallback.
export function Step7LeftOptions() {
  const models = useStore((s) => s.models);
  const selectedModelId = useStore((s) => s.selectedModelId);
  const selectModel = useStore((s) => s.selectModel);
  const setLineArt = useStore((s) => s.setLineArt);
  const setStep7View = useStore((s) => s.setStep7View);

  const targetId = selectedModelId ?? models[0]?.id ?? null;

  // Step 7 only views the product (for extraction); keep the viewport in product
  // mode and auto-select a model so the gizmo + numeric controls are live.
  useEffect(() => {
    setStep7View("product");
  }, [setStep7View]);
  useEffect(() => {
    if (!selectedModelId && models.length) selectModel(models[0].id);
  }, [selectedModelId, models, selectModel]);

  // Capture all four illustration layers from the CURRENT viewpoint at once.
  function generate() {
    if (!targetId) return;
    if (selectedModelId !== targetId) selectModel(targetId);
    setLineArt(lineArtBridge.capture?.(targetId) ?? null);
  }

  if (!models.length) {
    return <div className="note warn">먼저 Step 1에서 제품(STEP)을 불러오세요.</div>;
  }

  return (
    <div>
      <div className="list-head" style={{ marginBottom: 8 }}>
        ① 3D 뷰포트 — 제품 · 시점 · 위치
      </div>

      <div className="field">
        <label>대상 제품</label>
        <select
          value={targetId ?? ""}
          onChange={(e) => selectModel(e.target.value)}
          style={{ width: "100%" }}
        >
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </div>
      <div className="note" style={{ color: "var(--text-dim)" }}>
        시점 변경은 뷰포트 상단 <b>뷰포트 시점</b> 메뉴에서, 위치·회전은 아래 수치값
        또는 뷰포트 검볼(이동/회전)로 조절합니다.
      </div>
      <PlacementEditor />
      <button
        className="btn block"
        style={{ marginTop: 12 }}
        disabled={!targetId}
        onClick={generate}
      >
        현재 시점에서 일러스트 추출
      </button>
    </div>
  );
}

// Large illustration preview canvas — fills its container, drawing the artwork
// background, the relit shaded raster, and the vector layers (colour/opacity).
export function IllustrationPreview() {
  const lineArt = useStore((s) => s.lineArt);
  const artwork = useStore((s) => s.artwork);
  const ref = useRef<HTMLCanvasElement>(null);
  const [ver, setVer] = useState(0);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const parent = cv.parentElement!;
    const draw = () => {
      const W = (cv.width = parent.clientWidth);
      const H = (cv.height = parent.clientHeight);
      const ctx = cv.getContext("2d");
      if (!ctx) return;
      const preset = getArtworkPreset(artwork.presetId);
      const bg = artwork.background ?? preset.background;
      const drew = drawIllustration(ctx, W, H, lineArt, bg, () => setVer((v) => v + 1));
      if (!drew) {
        ctx.fillStyle = "#8b949e";
        ctx.font = "13px system-ui";
        ctx.textAlign = "center";
        ctx.fillText("왼쪽에서 일러스트를 추출하면 여기에 표시됩니다.", W / 2, H / 2);
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [lineArt, artwork, ver]);

  return <canvas ref={ref} style={{ width: "100%", height: "100%", display: "block" }} />;
}

// Korean labels for the capture viewpoint stored with a saved illustration.
const CAMERA_VIEW_LABELS: Record<string, string> = {
  perspective: "투시",
  top: "윗면",
  bottom: "아랫면",
  front: "정면",
  rear: "후면",
  right: "우측",
  left: "좌측",
};

// Right-column options drive the PREVIEW rendering (layers, shading, background,
// style, box-apply size) and save finished illustrations to a reusable list.
export function Step7RightOptions() {
  const lineArt = useStore((s) => s.lineArt);
  const updateLayer = useStore((s) => s.updateLineArtLayer);
  const artwork = useStore((s) => s.artwork);
  const update = useStore((s) => s.updateArtwork);
  const cameraView = useStore((s) => s.cameraView);
  const saved = useStore((s) => s.savedIllustrations);
  const addSaved = useStore((s) => s.addSavedIllustration);
  const [open, setOpen] = useState<string | null>(null); // which colour picker is open

  const preset = getArtworkPreset(artwork.presetId);
  const bg = artwork.background ?? preset.background;
  const toggle = (k: string) => setOpen((cur) => (cur === k ? null : k));

  let saveCounter = 0;
  function saveCurrent() {
    if (!lineArt) return;
    const snapshot: LineArt = JSON.parse(JSON.stringify(lineArt));
    const thumbnail = composeIllustration(snapshot, bg, 320, 240).toDataURL("image/png");
    const viewLabel = CAMERA_VIEW_LABELS[cameraView] ?? cameraView;
    const id = `ill_${saved.length}_${viewLabel}_${saveCounter++}`;
    addSaved({
      id,
      name: `일러스트 ${saved.length + 1}`,
      thumbnail,
      lineArt: snapshot,
      background: bg,
      view: viewLabel,
    });
  }

  return (
    <div>
      <div className="list-head" style={{ marginBottom: 8 }}>② 미리보기 — 렌더링 옵션</div>

      <Collapsible title={`저장된 일러스트 (${saved.length})`} defaultOpen>
        <button
          className="btn block"
          disabled={!lineArt}
          onClick={saveCurrent}
          title={lineArt ? "현재 미리보기를 목록에 저장" : "먼저 일러스트를 추출하세요"}
        >
          ＋ 현재 렌더링 저장
        </button>
        <SavedIllustrationList />
        <div className="note" style={{ marginTop: 6, color: "var(--text-dim)" }}>
          저장한 일러스트는 다음 스텝에서 박스 면에 적용합니다.
        </div>
      </Collapsible>

      {!lineArt && (
        <div className="note">
          왼쪽에서 일러스트를 추출하면 색·음영·배경 편집 옵션이 표시됩니다.
        </div>
      )}

      {lineArt && (
      <>
          <Collapsible title="레이어 — 표시·색·투명도·겹치기" defaultOpen>
            {LAYER_ORDER.map((kind) => {
              const layer = lineArt.layers.find((l) => l.kind === kind);
              if (!layer) return null;
              const col = layer.color ?? LAYER_META[kind].color;
              const isRaster = kind === "shaded";
              return (
                <div
                  key={kind}
                  className="field"
                  style={{ borderLeft: `3px solid ${col}`, paddingLeft: 8 }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <input
                      type="checkbox"
                      checked={layer.enabled}
                      onChange={(e) => updateLayer(kind, { enabled: e.target.checked })}
                    />
                    <span className="grow">{LAYER_META[kind].label}</span>
                    {!isRaster && (
                      <button
                        onClick={() => toggle(kind)}
                        title="레이어 색상 (CMYK)"
                        style={{ width: 20, height: 20, borderRadius: 4, background: col, border: "1px solid #2a313c", cursor: "pointer" }}
                      />
                    )}
                  </div>
                  {open === kind && !isRaster && (
                    <div style={{ margin: "6px 0" }}>
                      <ColorPicker value={col} onChange={(hex) => updateLayer(kind, { color: hex })} />
                    </div>
                  )}
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={layer.opacity}
                      disabled={!layer.enabled}
                      onChange={(e) => updateLayer(kind, { opacity: Number(e.target.value) })}
                      style={{ flex: 1 }}
                    />
                    <input
                      type="number"
                      min={0}
                      max={100}
                      value={Math.round(layer.opacity * 100)}
                      disabled={!layer.enabled}
                      onChange={(e) =>
                        updateLayer(kind, { opacity: Math.max(0, Math.min(100, Number(e.target.value))) / 100 })
                      }
                      style={{ width: 56 }}
                    />
                  </div>
                </div>
              );
            })}
          </Collapsible>

          <Collapsible title="음영 보정 — 밝기·대비·빛 방향">
            {(() => {
              const sh = lineArt.layers.find((l) => l.kind === "shaded");
              if (!sh || !sh.albedoImage || !sh.normalImage) {
                return (
                  <div className="note">
                    음영 보정은 일러스트를 다시 추출한 뒤 사용할 수 있습니다 (음영
                    데이터 없음).
                  </div>
                );
              }
              const brightness = sh.brightness ?? 1;
              const contrast = sh.contrast ?? 1;
              const lx = sh.lightX ?? 0.35;
              const ly = sh.lightY ?? 0.45;
              return (
                <div>
                  <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <input
                      type="checkbox"
                      checked={sh.enabled}
                      onChange={(e) => updateLayer("shaded", { enabled: e.target.checked })}
                    />
                    <span>음영 렌더링 표시</span>
                  </label>

                  <div className="field" style={{ marginTop: 8 }}>
                    <label>밝기 {Math.round(brightness * 100)}%</label>
                    <input
                      type="range"
                      min={0.2}
                      max={2}
                      step={0.01}
                      value={brightness}
                      onChange={(e) => updateLayer("shaded", { brightness: Number(e.target.value) })}
                      style={{ width: "100%" }}
                    />
                  </div>
                  <div className="field">
                    <label>대비 {Math.round(contrast * 100)}%</label>
                    <input
                      type="range"
                      min={0.2}
                      max={2}
                      step={0.01}
                      value={contrast}
                      onChange={(e) => updateLayer("shaded", { contrast: Number(e.target.value) })}
                      style={{ width: "100%" }}
                    />
                  </div>

                  <div className="field">
                    <label>빛 방향</label>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <LightPad
                        x={lx}
                        y={ly}
                        onChange={(nx, ny) => updateLayer("shaded", { lightX: nx, lightY: ny })}
                      />
                      <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.7 }}>
                        X {lx.toFixed(2)}
                        <br />
                        Y {ly.toFixed(2)}
                        <br />
                        <button
                          className="btn secondary"
                          style={{ marginTop: 4 }}
                          onClick={() => updateLayer("shaded", { lightX: 0.35, lightY: 0.45 })}
                        >
                          기본값
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })()}
          </Collapsible>

          <Collapsible title="스타일 프리셋">
            <div className="seg-row" style={{ flexWrap: "wrap", gap: 4 }}>
              {ARTWORK_PRESETS.map((p) => (
                <button
                  key={p.id}
                  className={"seg-btn" + (artwork.presetId === p.id ? " on" : "")}
                  onClick={() => update({ presetId: p.id, background: undefined })}
                  title={p.name}
                >
                  {p.name}
                </button>
              ))}
            </div>
          </Collapsible>

          <Collapsible title="배경 색 (CMYK)">
            <button
              className="swatch-row"
              onClick={() => toggle("bg")}
              style={{ display: "flex", alignItems: "center", gap: 8, width: "100%" }}
            >
              <span style={{ width: 22, height: 22, borderRadius: 4, background: bg, border: "1px solid #2a313c" }} />
              <span className="grow" style={{ textAlign: "left" }}>{bg}</span>
              <span>{open === "bg" ? "▴" : "▾"}</span>
            </button>
            {open === "bg" && (
              <div style={{ marginTop: 6 }}>
                <ColorPicker value={bg} onChange={(hex) => update({ background: hex })} />
              </div>
            )}
          </Collapsible>

          <Collapsible title="박스 적용 크기">
            <div className="field">
              <label>페이스 대비 {(artwork.scale * 100).toFixed(0)}%</label>
              <input
                type="range"
                min={0.1}
                max={1}
                step={0.02}
                value={artwork.scale}
                onChange={(e) => update({ scale: Number(e.target.value) })}
                style={{ width: "100%" }}
              />
            </div>
          </Collapsible>
      </>
      )}
    </div>
  );
}

// The saved-illustration list: thumbnail + editable name + load/delete. Reads the
// store directly so it stays in sync regardless of where it's mounted.
function SavedIllustrationList() {
  const saved = useStore((s) => s.savedIllustrations);
  const remove = useStore((s) => s.removeSavedIllustration);
  const rename = useStore((s) => s.renameSavedIllustration);
  const setLineArt = useStore((s) => s.setLineArt);
  const update = useStore((s) => s.updateArtwork);

  if (!saved.length) {
    return (
      <div className="note" style={{ marginTop: 8 }}>
        아직 저장된 일러스트가 없습니다.
      </div>
    );
  }

  function load(item: (typeof saved)[number]) {
    setLineArt(JSON.parse(JSON.stringify(item.lineArt)));
    update({ background: item.background });
  }

  return (
    <div className="saved-list">
      {saved.map((item) => (
        <div className="saved-item" key={item.id}>
          <img className="saved-thumb" src={item.thumbnail} alt={item.name} />
          <div className="saved-meta">
            <input
              className="saved-name"
              type="text"
              value={item.name}
              onChange={(e) => rename(item.id, e.target.value)}
            />
            <span className="saved-view">{item.view} 뷰</span>
            <div className="saved-actions">
              <button className="btn secondary" onClick={() => load(item)} title="이 일러스트를 편집기로 불러오기">
                불러오기
              </button>
              <button className="btn secondary" onClick={() => remove(item.id)} title="삭제">
                삭제
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// Stacked fallback for any non-split context (the App routes step 7 to the
// two-pane workspace, so this is only a safety net).
function Step7Illustration() {
  const lineArt = useStore((s) => s.lineArt);
  return (
    <div>
      <Step7LeftOptions />
      {lineArt && (
        <div style={{ margin: "12px 0" }}>
          <LineArtPreview art={lineArt} />
        </div>
      )}
      <Step7RightOptions />
    </div>
  );
}

// ── shared panel helpers ───────────────────────────────────────────────────────
// A lightweight collapsible "dropdown" section used to tidy long panels.
function Collapsible({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="collapsible">
      <button className="collapsible-head" onClick={() => setOpen((o) => !o)}>
        <span className="grow" style={{ textAlign: "left" }}>{title}</span>
        <span className="collapsible-caret">{open ? "▾" : "▸"}</span>
      </button>
      {open && <div className="collapsible-body">{children}</div>}
    </div>
  );
}

// A small square pad to pick a 2D light direction (x right, y up, -1..1).
function LightPad({
  x,
  y,
  onChange,
}: {
  x: number;
  y: number;
  onChange: (x: number, y: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const pick = (e: React.PointerEvent) => {
    const el = ref.current;
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    const move = (cx: number, cy: number) => {
      const r = el.getBoundingClientRect();
      const nx = Math.max(-1, Math.min(1, ((cx - r.left) / r.width) * 2 - 1));
      const ny = Math.max(-1, Math.min(1, -(((cy - r.top) / r.height) * 2 - 1)));
      onChange(Number(nx.toFixed(2)), Number(ny.toFixed(2)));
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
  return (
    <div
      ref={ref}
      onPointerDown={pick}
      title="빛 방향 (드래그)"
      style={{
        position: "relative",
        width: 96,
        height: 96,
        borderRadius: "50%",
        cursor: "crosshair",
        touchAction: "none",
        background:
          "radial-gradient(circle at 50% 50%, #3a4250 0%, #1b2027 75%), #161b22",
        border: "1px solid #2a313c",
      }}
    >
      <div
        style={{
          position: "absolute",
          left: `${((x + 1) / 2) * 100}%`,
          top: `${((1 - y) / 2) * 100}%`,
          width: 12,
          height: 12,
          transform: "translate(-50%,-50%)",
          borderRadius: "50%",
          background: "#f0c674",
          border: "2px solid #fff",
          boxShadow: "0 0 8px 2px rgba(240,198,116,0.7)",
          pointerEvents: "none",
        }}
      />
    </div>
  );
}

// ── (legacy text-on-box editor; not currently routed) ─────────────────────────
function Step10Text() {
  const texts = useStore((s) => s.textElements);
  const add = useStore((s) => s.addText);
  const update = useStore((s) => s.updateText);
  const remove = useStore((s) => s.removeText);
  const [draft, setDraft] = useState("");
  const [sel, setSel] = useState<string | null>(null);

  let idCounter = 0;
  function addText() {
    if (!draft.trim()) return;
    const id = `t_${texts.length}_${draft.length}_${idCounter++}`;
    add({ id, text: draft, x: 0.5, y: 0.5, sizeMm: 12, angleDeg: 0, color: "#ffffff" });
    setDraft("");
    setSel(id);
  }

  const selEl = texts.find((t) => t.id === sel);

  return (
    <div>
      <p className="hint">
        상자 표면에 들어갈 텍스트를 작성/배치합니다. 추가 후 좌측 미리보기에서
        드래그로 위치를 옮기고, 아래에서 크기·각도를 조절하세요.
      </p>
      <div className="field">
        <label>텍스트 입력</label>
        <input type="text" value={draft} placeholder="예: PRODUCT NAME"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addText()} />
      </div>
      <button className="btn block" onClick={addText}>+ 텍스트 추가</button>

      <div className="text-list">
        {texts.map((t) => (
          <div className="item" key={t.id}>
            <span className="grow" onClick={() => setSel(t.id)}
              style={{ cursor: "pointer", color: sel === t.id ? "var(--accent)" : undefined }}>
              {t.text}
            </span>
            <button className="btn secondary" onClick={() => remove(t.id)}>삭제</button>
          </div>
        ))}
      </div>

      {selEl && (
        <div style={{ marginTop: 14, borderTop: "1px solid var(--border)", paddingTop: 12 }}>
          <div className="field">
            <label>크기 (mm): {selEl.sizeMm}</label>
            <input type="range" min={4} max={60} value={selEl.sizeMm} style={{ width: "100%" }}
              onChange={(e) => update(selEl.id, { sizeMm: Number(e.target.value) })} />
          </div>
          <div className="field">
            <label>각도 (°): {selEl.angleDeg}</label>
            <input type="range" min={-180} max={180} value={selEl.angleDeg} style={{ width: "100%" }}
              onChange={(e) => update(selEl.id, { angleDeg: Number(e.target.value) })} />
          </div>
          <div className="field">
            <label>색상</label>
            <input type="text" value={selEl.color}
              onChange={(e) => update(selEl.id, { color: e.target.value })} />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Step 11 ───────────────────────────────────────────────────────────────────
function Step11Dieline() {
  const presetId = useStore((s) => s.boxPresetId);
  const sizing = useStore((s) => s.boxSizing);
  const texts = useStore((s) => s.textElements);
  const presetObj = BOX_PRESETS.find((p) => p.id === presetId);

  function dl(fmt: VectorFormat) {
    if (!presetObj) return;
    const d = generateDieline(presetObj.dielineKind, sizing);
    const { blob, ext } = exportDieline(d, fmt, texts);
    downloadBlob(blob, `package01_dieline.${ext}`);
  }

  return (
    <div>
      <p className="hint">
        일러스트와 텍스트가 포함된 상태로 상자 제작용 도면을 내보냅니다.
        (재단=실선, 접지=점선)
      </p>
      {!presetObj && <div className="note warn">박스 유형을 먼저 선택하세요 (Step 5).</div>}
      <div className="btn-row">
        <button className="btn" disabled={!presetObj} onClick={() => dl("svg")}>SVG</button>
        <button className="btn" disabled={!presetObj} onClick={() => dl("dxf")}>DXF</button>
        <button className="btn secondary" disabled={!presetObj} onClick={() => dl("ai")}>AI</button>
      </div>
      <div className="note">
        AI는 현재 SVG 호환 데이터로 출력됩니다(일러스트레이터에서 열림). 네이티브
        .ai/PDF 작성기는 추후 추가 예정.
      </div>
    </div>
  );
}

// ── Step 12 ───────────────────────────────────────────────────────────────────
function Step12FoamExport() {
  const foam = useStore((s) => s.insertFoam);
  const boxForm = useStore((s) => s.boxForm);
  const boxTransform = useStore((s) => s.boxTransform);
  const models = useStore((s) => s.models);
  const modelSilhouettes = useStore((s) => s.modelSilhouettes);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const sils = models
    .map((m) => modelSilhouettes[m.id])
    .filter(Boolean) as ModelSilhouette[];

  function poseFor(): BoxPose | null {
    if (boxTransform) return boxTransform;
    const place = solidsPlacement(sils);
    if (!place) return null;
    return {
      position: [place.cx, place.baseY + boxForm.height / 2, place.cz],
      rotation: [0, 0, 0],
    };
  }

  // STL / OBJ / FBX — straight from the tessellated foam mesh.
  function dlMesh(fmt: MeshFormat) {
    setErr(null);
    setNote(null);
    if (!foam.mesh) return;
    try {
      downloadBlob(exportMesh(foam.mesh, fmt), `package01_insert.${fmt}`);
    } catch (e: any) {
      setErr(e?.message ?? "export 실패");
    }
  }

  // STEP — true-NURBS B-rep via the OpenCascade kernel (box minus B-spline-walled
  // drafted prisms). Falls back to the faceted mesh STEP if the kernel fails.
  async function dlStepNurbs() {
    setErr(null);
    setNote(null);
    const pose = poseFor();
    if (!pose || !sils.length) {
      setErr("실루엣 솔리드가 필요합니다 (Step 2/3을 먼저 진행하세요).");
      return;
    }
    setBusy(true);
    setNote("NURBS B-rep 생성 중… (커널 첫 로드는 몇 초 걸립니다)");
    try {
      const blob = await exportFoamStep(boxForm, pose, sils);
      downloadBlob(blob, "package01_insert_nurbs.step");
      setNote("✓ NURBS STEP 출력 완료 (평면 + B-spline 곡면).");
    } catch (e: any) {
      try {
        if (foam.mesh) {
          downloadBlob(exportMesh(foam.mesh, "step"), "package01_insert_faceted.step");
          setNote(null);
          setErr("NURBS 생성 실패 — 패싯 STEP으로 대체 출력했습니다.");
        } else throw e;
      } catch (e2: any) {
        setNote(null);
        setErr(e?.message ?? "STEP export 실패");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="hint">
        1~3번 과정으로 만든 인서트 폼을 3D 포맷으로 내보냅니다. STEP은 OpenCascade
        커널로 진짜 B-rep(평면 + B-spline 곡면) NURBS로 출력합니다.
      </p>
      {!foam.ready && <div className="note warn">먼저 인서트 폼을 생성하세요 (Step 3).</div>}
      <div className="btn-row">
        <button className="btn" disabled={!foam.ready || busy} onClick={() => dlMesh("stl")}>STL</button>
        <button className="btn" disabled={!foam.ready || busy} onClick={() => dlMesh("obj")}>OBJ</button>
        <button className="btn" disabled={!foam.ready || busy} onClick={() => dlMesh("fbx")}>FBX</button>
      </div>
      <button
        className="btn block"
        style={{ marginTop: 8 }}
        disabled={!foam.ready || busy}
        onClick={dlStepNurbs}
        title="OpenCascade 커널로 진짜 NURBS STEP 생성"
      >
        {busy ? "STEP(NURBS) 생성 중…" : "STEP 내보내기 (NURBS)"}
      </button>
      {note && <div className="note" style={{ color: "var(--ok)", marginTop: 8 }}>{note}</div>}
      {err && <div className="note warn">⚠ {err}</div>}
      <div className="note">
        STL·OBJ·FBX는 메시로 즉시 출력됩니다. STEP은 NURBS B-rep이라 라이노 등에서
        매끈한 곡면으로 열립니다(첫 출력 시 커널 로딩에 수 초 소요).
      </div>
    </div>
  );
}
