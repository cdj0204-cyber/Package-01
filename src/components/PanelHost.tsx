import { useRef, useState } from "react";
import { useStore } from "../store/useStore";
import { getStep, STEPS } from "../pipeline/steps";
import { VIEW_NAMES, type ViewName } from "../types";
import { importStepFile } from "../geometry/stepImport";
import { extractSilhouette } from "../geometry/silhouette";
import { buildBlockMesh, subtractCavity } from "../geometry/boolean";
import { buildDraftedPlug } from "../geometry/draft";
import { exportMesh, downloadBlob, type MeshFormat } from "../geometry/exporters";
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
function Step1Import() {
  const setModel = useStore((s) => s.setModel);
  const model = useStore((s) => s.model);
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setErr(null);
    try {
      const m = await importStepFile(file);
      setModel(m);
    } catch (e: any) {
      setErr(e?.message ?? "import 실패");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p className="hint">
        제품의 3D 데이터를 STEP(.step/.stp) 형식으로 불러옵니다. NURBS는 표시용으로
        삼각분할되며, 실루엣 추출의 기준이 됩니다.
      </p>
      <input
        ref={inputRef}
        type="file"
        accept=".step,.stp"
        style={{ display: "none" }}
        onChange={onFile}
      />
      <button
        className="btn block"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
      >
        {busy ? "불러오는 중…" : "STEP 파일 선택"}
      </button>
      {err && <div className="note warn">⚠ {err}</div>}
      {model && (
        <div className="note" style={{ color: "var(--text-dim)" }}>
          ✓ {model.fileName}<br />
          메쉬 {model.meshes.length}개 · 크기{" "}
          {(model.bbox.max[0] - model.bbox.min[0]).toFixed(1)} ×{" "}
          {(model.bbox.max[1] - model.bbox.min[1]).toFixed(1)} ×{" "}
          {(model.bbox.max[2] - model.bbox.min[2]).toFixed(1)} mm
        </div>
      )}
    </div>
  );
}

// ── Step 2 ────────────────────────────────────────────────────────────────────
function Step2Silhouette() {
  const model = useStore((s) => s.model);
  const silhouettes = useStore((s) => s.silhouettes);
  const setSil = useStore((s) => s.setSilhouette);
  const artwork = useStore((s) => s.artwork);
  const updateArtwork = useStore((s) => s.updateArtwork);

  function extract(view: ViewName) {
    if (!model) return;
    setSil(view, extractSilhouette(model, view));
    updateArtwork({ view });
  }

  return (
    <div>
      <p className="hint">
        특정 뷰(top/front/side)에서 아웃라인 실루엣을 추출합니다. 추출된 실루엣은
        구배각·불린 차집합의 기준 단면이 됩니다.
        <br />
        <span className="warn">
          (스켈레톤: 현재 투영 바운딩 외곽선으로 근사)
        </span>
      </p>
      <div className="field">
        <label>미리볼 뷰</label>
        <select
          value={artwork.view}
          onChange={(e) => updateArtwork({ view: e.target.value as ViewName })}
        >
          {VIEW_NAMES.map((v) => (
            <option key={v} value={v}>{v}</option>
          ))}
        </select>
      </div>
      <div className="btn-row">
        {VIEW_NAMES.map((v) => (
          <button
            key={v}
            className={"btn " + (silhouettes[v] ? "" : "secondary")}
            disabled={!model}
            onClick={() => extract(v)}
          >
            {v} 추출{silhouettes[v] ? " ✓" : ""}
          </button>
        ))}
      </div>
      {!model && <div className="note warn">먼저 STEP 모델을 import 하세요.</div>}
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
  const model = useStore((s) => s.model);
  const boxForm = useStore((s) => s.boxForm);
  const updateBoxForm = useStore((s) => s.updateBoxForm);
  const silhouettes = useStore((s) => s.silhouettes);
  const drafts = useStore((s) => s.drafts);
  const setInsert = useStore((s) => s.setInsertFoam);

  function run() {
    if (!model) return;
    const center: [number, number] = [
      (model.bbox.min[0] + model.bbox.max[0]) / 2,
      (model.bbox.min[1] + model.bbox.max[1]) / 2,
    ];
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
      <button className="btn block" disabled={!model} onClick={run}>
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
