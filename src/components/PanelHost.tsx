import { useRef, useState } from "react";
import { useStore } from "../store/useStore";
import { getStep, STEPS } from "../pipeline/steps";
import { VIEW_NAMES, type ViewName } from "../types";
import { importStepFile } from "../geometry/stepImport";
import { buildBlockMesh, subtractCavity } from "../geometry/boolean";
import { buildDraftedPlug } from "../geometry/draft";
import { exportMesh, downloadBlob, type MeshFormat } from "../geometry/exporters";
import {
  worldAlignValue,
  type AlignAxis,
  type AlignPick,
} from "../geometry/align";
import { BOX_PRESETS, ARTWORK_PRESETS } from "../box/presets";
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
    case 3: return <Step3Draft />;
    case 4: return <Step4Boolean />;
    case 5: return <Step5Insert />;
    case 6: return <Step6BoxType />;
    case 7: return <Step7Sizing />;
    case 8: return <Step8Render />;
    case 9: return <Step9Artwork />;
    case 10: return <Step10Text />;
    case 11: return <Step11Dieline />;
    case 12: return <Step12FoamExport />;
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
                step={1}
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

// ── Step 3 ────────────────────────────────────────────────────────────────────
function Step3Draft() {
  const drafts = useStore((s) => s.drafts);
  const setDraft = useStore((s) => s.setDraft);
  const silhouettes = useStore((s) => s.silhouettes);
  const view = useStore((s) => s.artwork.view);
  const cur = drafts[view] ?? { view, angleDeg: 3, depth: 30 };

  return (
    <div>
      <div className="note" style={{ marginTop: 0, marginBottom: 12 }}>
        구배각은 이제 <strong>Step 2</strong>에서 개체별로 설정합니다(익스트루드
        솔리드에 직접 적용). 아래 값은 기존 블록/불린 미리보기용 전역 설정입니다.
      </div>
      <p className="hint">
        선택한 뷰의 실루엣에 구배(draft) 각도와 인출 깊이를 지정합니다. 각도가
        클수록 바닥으로 갈수록 단면이 좁아집니다.
      </p>
      <div className="field">
        <label>대상 뷰</label>
        <input type="text" value={view} disabled />
      </div>
      <div className="field">
        <label>구배 각도 (°)</label>
        <input
          type="number"
          value={cur.angleDeg}
          step={0.5}
          onChange={(e) =>
            setDraft(view, { ...cur, angleDeg: Number(e.target.value) })
          }
        />
      </div>
      <div className="field">
        <label>인출 깊이 (mm)</label>
        <input
          type="number"
          value={cur.depth}
          onChange={(e) =>
            setDraft(view, { ...cur, depth: Number(e.target.value) })
          }
        />
      </div>
      {!silhouettes[view] && (
        <div className="note warn">이 뷰의 실루엣을 먼저 추출하세요 (Step 2).</div>
      )}
    </div>
  );
}

// ── Step 4 ────────────────────────────────────────────────────────────────────
function Step4Boolean() {
  const models = useStore((s) => s.models);
  const boxForm = useStore((s) => s.boxForm);
  const updateBoxForm = useStore((s) => s.updateBoxForm);
  const silhouettes = useStore((s) => s.silhouettes);
  const drafts = useStore((s) => s.drafts);
  const setInsert = useStore((s) => s.setInsertFoam);

  function run() {
    if (!models.length) return;
    // Combined XY centre of all imported models (the block holds them all).
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const pm of models) {
      minX = Math.min(minX, pm.model.bbox.min[0]);
      minY = Math.min(minY, pm.model.bbox.min[1]);
      maxX = Math.max(maxX, pm.model.bbox.max[0]);
      maxY = Math.max(maxY, pm.model.bbox.max[1]);
    }
    const center: [number, number] = [(minX + maxX) / 2, (minY + maxY) / 2];
    const block = buildBlockMesh(boxForm, center);
    const sil = silhouettes.top ?? Object.values(silhouettes)[0];
    const draft = drafts.top ?? Object.values(drafts)[0];
    if (!sil || !draft) return;
    const plug = buildDraftedPlug(sil, draft, boxForm.height);
    setInsert(subtractCavity(block, plug, boxForm));
  }

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

  return (
    <div>
      <p className="hint">
        육면체 폼에서 구배 솔리드를 빼냅니다(불린 차집합). 바닥이 뚫리지 않도록
        바닥 오프셋을 둡니다.
        <br />
        <span className="warn">(스켈레톤: 실제 CSG 미적용 — 블록/플러그 미리보기)</span>
      </p>
      {f("width", "폼 가로 W (mm)")}
      {f("depth", "폼 세로 D (mm)")}
      {f("height", "폼 높이 H (mm)")}
      {f("floorOffset", "바닥 오프셋 (mm)")}
      <button className="btn block" disabled={!models.length} onClick={run}>
        불린 차집합 실행
      </button>
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
        제작된 인서트 폼 결과를 확인합니다. 이상이 없으면 STEP 12에서 3D 포맷으로
        내보낼 수 있습니다.
      </p>
      {foam.ready ? (
        <div className="note" style={{ color: "var(--ok)" }}>
          ✓ 인서트 폼이 생성되었습니다.
          <div className="btn-row">
            <button className="btn" onClick={() => setStep(12)}>
              폼 다운로드로 이동 (Step 12)
            </button>
          </div>
        </div>
      ) : (
        <div className="note warn">Step 4에서 불린 차집합을 먼저 실행하세요.</div>
      )}
    </div>
  );
}

// ── Step 6 ────────────────────────────────────────────────────────────────────
function Step6BoxType() {
  const boxPresetId = useStore((s) => s.boxPresetId);
  const setBoxPreset = useStore((s) => s.setBoxPreset);
  return (
    <div>
      <p className="hint">
        패키지 상자 유형을 선택합니다. 각 유형은 전개도(도면) 생성 방식이 다릅니다.
      </p>
      {BOX_PRESETS.map((p) => (
        <div
          key={p.id}
          className={"preset-card" + (boxPresetId === p.id ? " sel" : "")}
          onClick={() => setBoxPreset(p.id)}
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
    </div>
  );
}

// ── Step 8 ────────────────────────────────────────────────────────────────────
function Step8Render() {
  const sizing = useStore((s) => s.boxSizing);
  const presetId = useStore((s) => s.boxPresetId);
  return (
    <div>
      <p className="hint">
        설정된 볼륨값으로 박스를 3D로 렌더링해 확인합니다. 좌측 뷰에서 회전/줌으로
        살펴보세요.
      </p>
      <div className="note" style={{ color: "var(--text-dim)" }}>
        유형: {presetId ?? "(미선택)"}<br />
        볼륨: {sizing.width} × {sizing.depth} × {sizing.height} mm
      </div>
      {!presetId && <div className="note warn">박스 유형을 먼저 선택하세요 (Step 6).</div>}
    </div>
  );
}

// ── Step 9 ────────────────────────────────────────────────────────────────────
function Step9Artwork() {
  const artwork = useStore((s) => s.artwork);
  const update = useStore((s) => s.updateArtwork);
  return (
    <div>
      <p className="hint">
        제품 데이터를 선택한 각도(front/side/top)의 라인 드로잉으로 상자 표면에
        적용합니다. 스타일 프리셋을 선택하세요.
      </p>
      <div className="field">
        <label>드로잉 뷰</label>
        <select value={artwork.view} onChange={(e) => update({ view: e.target.value as ViewName })}>
          {VIEW_NAMES.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
      </div>
      {ARTWORK_PRESETS.map((p) => (
        <div key={p.id}
          className={"preset-card" + (artwork.presetId === p.id ? " sel" : "")}
          onClick={() => update({ presetId: p.id })}>
          <div className="name">{p.name}</div>
          <div className="desc" style={{ display: "flex", gap: 6, marginTop: 6 }}>
            <span style={{ width: 16, height: 16, background: p.background, border: "1px solid #2a313c", display: "inline-block" }} />
            <span style={{ width: 16, height: 16, background: p.lineColor, border: "1px solid #2a313c", display: "inline-block" }} />
          </div>
        </div>
      ))}
      <div className="field" style={{ marginTop: 12 }}>
        <label>크기 (페이스 대비 {(artwork.scale * 100).toFixed(0)}%)</label>
        <input type="range" min={0.1} max={1} step={0.05} value={artwork.scale}
          onChange={(e) => update({ scale: Number(e.target.value) })} style={{ width: "100%" }} />
      </div>
    </div>
  );
}

// ── Step 10 ───────────────────────────────────────────────────────────────────
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
      {!presetObj && <div className="note warn">박스 유형을 먼저 선택하세요 (Step 6).</div>}
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
  const [err, setErr] = useState<string | null>(null);

  function dl(fmt: MeshFormat) {
    setErr(null);
    if (!foam.mesh) return;
    try {
      const blob = exportMesh(foam.mesh, fmt);
      downloadBlob(blob, `package01_insert.${fmt}`);
    } catch (e: any) {
      setErr(e?.message ?? "export 실패");
    }
  }

  return (
    <div>
      <p className="hint">
        1~4번 과정으로 만든 인서트 폼을 3D 포맷으로 내보냅니다.
      </p>
      {!foam.ready && <div className="note warn">먼저 인서트 폼을 생성하세요 (Step 4).</div>}
      <div className="btn-row">
        <button className="btn" disabled={!foam.ready} onClick={() => dl("stl")}>STL</button>
        <button className="btn" disabled={!foam.ready} onClick={() => dl("obj")}>OBJ</button>
        <button className="btn secondary" disabled={!foam.ready} onClick={() => dl("step")}>STEP</button>
        <button className="btn secondary" disabled={!foam.ready} onClick={() => dl("fbx")}>FBX</button>
      </div>
      {err && <div className="note warn">⚠ {err}</div>}
      <div className="note">
        STL/OBJ는 즉시 출력됩니다. STEP/FBX는 B-rep 커널/FBX SDK 연동 후 지원 예정.
      </div>
    </div>
  );
}
