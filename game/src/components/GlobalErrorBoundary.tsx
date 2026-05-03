import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportClientError } from "../net/errorReporter";

interface Props { children: ReactNode }
interface State { error: Error | null }

// Top-level React error boundary. Catches errors thrown during render,
// in lifecycle methods, or in event handlers reachable from this
// subtree. Reports to the server's client-error endpoint and shows a
// graceful fallback that lets the player reload (or wait, if it's a
// transient render glitch). Without this, an unhandled render error
// blanks the whole page with no signal anywhere.
export class GlobalErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportClientError({
      message: error.message,
      stack: error.stack ?? null,
      source: "React.ErrorBoundary",
      meta: { componentStack: info.componentStack ?? null },
    });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="error-boundary-fallback">
        <div className="error-boundary-card">
          <h2>Something broke.</h2>
          <p>The page hit an unexpected error. It's been logged and we'll look into it.</p>
          <p className="dim small">{this.state.error.message}</p>
          <div className="error-boundary-actions">
            <button
              type="button"
              className="g-btn-primary"
              onClick={() => location.reload()}
            >
              Reload
            </button>
            <button
              type="button"
              className="g-btn-ghost"
              onClick={() => this.setState({ error: null })}
            >
              Try to recover
            </button>
          </div>
        </div>
      </div>
    );
  }
}
