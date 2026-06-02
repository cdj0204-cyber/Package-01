import type { ViewportKind } from "../pipeline/steps";
import { useStore } from "../store/useStore";
import { Viewport3D } from "./Viewport3D";
import { Viewport2D } from "./Viewport2D";

// Switches the central viewport between the 3D scene and the 2D canvas.
export function Viewport({ kind }: { kind: ViewportKind }) {
  const model = useStore((s) => s.model);

  return (
    <div className="viewport">
      <div className="overlay">
        {kind === "3d" ? "3D 뷰 · 드래그 회전 / 휠 줌" : "2D 뷰"}
      </div>
      {kind === "3d" ? <Viewport3D /> : <Viewport2D kind={kind} />}
      {kind === "3d" && !model && (
        <div className="empty">
          STEP 파일을 import 하면 여기에 제품이 표시됩니다.
        </div>
      )}
    </div>
  );
}
