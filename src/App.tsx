import { useStore } from "./store/useStore";
import { getStep, STEPS, STAGE_LABELS } from "./pipeline/steps";
import { Viewport } from "./components/Viewport";
import { PanelHost } from "./components/PanelHost";
import { ErrorBoundary } from "./components/ErrorBoundary";

// ─────────────────────────────────────────────────────────────────────────────
// App shell: top bar, step sidebar, central viewport, contextual right panel.
// ─────────────────────────────────────────────────────────────────────────────

export function App() {
  const currentStep = useStore((s) => s.currentStep);
  const setStep = useStore((s) => s.setStep);
  const reset = useStore((s) => s.reset);
  const models = useStore((s) => s.models);

  const step = getStep(currentStep);

  // crude completion heuristic for the sidebar checkmarks
  const done = useStore((s) => ({
    1: s.models.length > 0,
    2: Object.keys(s.modelSilhouettes).length > 0,
    3: s.insertFoam.ready,
    4: s.insertFoam.ready,
    5: !!s.boxPresetId,
    6: true,
    7: !!s.boxPresetId,
    8: true,
    9: s.textElements.length > 0,
    10: !!s.boxPresetId,
    11: s.insertFoam.ready,
  } as Record<number, boolean>));

  const stages: Array<"A" | "B"> = ["A", "B"];

  return (
    <div className="app">
      <div className="topbar">
        <h1>Package 01</h1>
        <span className="badge">스켈레톤</span>
        <span className="spacer" />
        <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
          {models.length === 0
            ? "모델 미로드"
            : models.length === 1
            ? models[0].name
            : `${models.length}개 모델`}
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

      <ErrorBoundary>
        <Viewport kind={step.viewport} />
      </ErrorBoundary>

      <div className="panel">
        <PanelHost step={currentStep} />
      </div>
    </div>
  );
}
