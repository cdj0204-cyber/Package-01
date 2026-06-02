import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div
          id="vp-error"
          style={{
            position: "absolute",
            inset: 0,
            padding: 16,
            overflow: "auto",
            color: "#ff6b6b",
            font: "12px/1.5 monospace",
            whiteSpace: "pre-wrap",
            background: "#0b0e13",
          }}
        >
          {String(this.state.error?.message)}
          {"\n\n"}
          {String(this.state.error?.stack)}
        </div>
      );
    }
    return this.props.children;
  }
}
