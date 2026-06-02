import { useStore } from "./store/useStore";
import { getStep, STEPS, STAGE_LABELS } from "./pipeline/steps";
import { Viewport } from "./components/Viewport";
import { PanelHost } from "./components/PanelHost";

// ─────────────────────────────────────────────────────────────────────────────
// App shell: top bar, step sidebar, central viewport, contextual right panel.
// ─────────────────────────────────────────────────────────────────────────────

export function App() {
  const currentStep = useStore((s) => s.currentStep);
  const setStep = useStore((s) => s.setStep);
  const reset = useStore((s) => s.reset);
  const model = useStore((s) => s.model);

  const step = getStep(currentStep);

  // crude completion heuristic for the sidebar checkmarks
  const done = useStore((s) => ({
    1: !!s.model,
    2: Object.keys(s.silhouettes).length > 0,
    3: Object.keys(s.drafts).length > 0,
    4: s.insertFoam.ready,
    5: s.insertFoam.ready,
    6: !!s.boxPresetId,
    7: true,
    8: !!s.boxPresetId,
    9: true,
    10: s.textElements.length > 0,
    11: !!s.boxPresetId,
    12: s.insertFoam.ready,
  } as Record<number, boolean>));

  const stages: Array<"A" | "B"> = ["A", "B"];

  return (
    <div className="app">
      <div className="topbar">
        <h1>Package 01</h1>
        <span className="badge">스켈레톤</span>
        <span className="spacer" />
        <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
          {model ? model.fileName : "모델 미로드"}
        </span>
        <button className="btn secondary" onClick={reset}>
          새 프로젝트
        </button>
      </div>

      <div className="sidebar">
        {stages.map((stage) => (
          <div key={stage}>
            <div className="stage-label">
              {stage === "A" ? "STAGE A" : "STAGE B"} · {STAGE_LABELS[stage]}
            </div>
            {STEPS.filter((s) => s.stage === stage).map((s) => (
              <div
                key={s.id}
                className={
                  "step-item" +
                  (s.id === currentStep ? " active" : "") +
                  (done[s.id] ? " done" : "")
                }
                onClick={() => setStep(s.id)}
              >
                <span className="num">{s.id}</span>
                <span>{s.short}</span>
              </div>
            ))}
          </div>
        ))}
      </div>

      <Viewport kind={step.viewport} />

      <div className="panel">
        <PanelHost step={currentStep} />
      </div>
    </div>
  );
}
