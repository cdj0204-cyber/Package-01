import type { ViewportKind } from "../pipeline/steps";
import { useStore, type CameraView } from "../store/useStore";
import { Viewport3D } from "./Viewport3D";
import { Viewport2D } from "./Viewport2D";

// Switches the central viewport between the 3D scene and the 2D canvas.
export function Viewport({ kind }: { kind: ViewportKind }) {
  const modelCount = useStore((s) => s.models.length);
  const step = useStore((s) => s.currentStep);
  const gizmoMode = useStore((s) => s.gizmoMode);
  const setGizmoMode = useStore((s) => s.setGizmoMode);
  const resetSelectedTransform = useStore((s) => s.resetSelectedTransform);
  const selectedModelId = useStore((s) => s.selectedModelId);
  const cameraView = useStore((s) => s.cameraView);
  const setCameraView = useStore((s) => s.setCameraView);
  const lightContrast = useStore((s) => s.lightContrast);
  const setLightContrast = useStore((s) => s.setLightContrast);
  const step7View = useStore((s) => s.step7View);

  const showGizmoControls =
    kind === "3d" &&
    modelCount > 0 &&
    !!selectedModelId &&
    (step === 1 || (step === 7 && step7View === "product"));

  const VIEW_OPTIONS: Array<{ v: CameraView; label: string }> = [
    { v: "perspective", label: "Perspective (자유 시점)" },
    { v: "top", label: "Top (위에서)" },
    { v: "bottom", label: "Bottom (아래에서)" },
    { v: "front", label: "Front (앞)" },
    { v: "rear", label: "Rear (뒤)" },
    { v: "right", label: "Right (오른쪽)" },
    { v: "left", label: "Left (왼쪽)" },
  ];

  return (
    <div className="viewport">
      <div className="overlay">
        {kind === "3d" ? "3D 뷰 · 드래그 회전 / 휠 줌" : "2D 뷰"}
      </div>

      {kind === "3d" && (
        <div className="vp-controls">
          <div className="vp-control vp-card">
            <label>뷰포트 시점</label>
            <select
              className="vp-select"
              value={cameraView}
              onChange={(e) => setCameraView(e.target.value as CameraView)}
            >
              {VIEW_OPTIONS.map((o) => (
                <option key={o.v} value={o.v}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <div className="vp-control vp-card">
            <label>
              빛 대비 <span className="val">{Math.round(lightContrast * 100)}%</span>
            </label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={lightContrast}
              onChange={(e) => setLightContrast(parseFloat(e.target.value))}
            />
          </div>

          {showGizmoControls && (
            <div className="vp-control vp-card">
              <label>검볼</label>
              <div className="vp-btn-row">
                <button
                  className={"vp-toggle" + (gizmoMode === "translate" ? " on" : "")}
                  onClick={() => setGizmoMode("translate")}
                  title="이동 (W)"
                >
                  이동
                </button>
                <button
                  className={"vp-toggle" + (gizmoMode === "rotate" ? " on" : "")}
                  onClick={() => setGizmoMode("rotate")}
                  title="회전 (E)"
                >
                  회전
                </button>
                <button
                  className="vp-toggle"
                  onClick={() => resetSelectedTransform()}
                  title="원래 위치/각도로"
                >
                  리셋
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {kind === "3d" ? <Viewport3D /> : <Viewport2D kind={kind} />}
      {kind === "3d" && modelCount === 0 && (
        <div className="empty">
          STEP 파일을 import 하면 여기에 제품이 표시됩니다. (여러 개 동시 가능)
        </div>
      )}
    </div>
  );
}
