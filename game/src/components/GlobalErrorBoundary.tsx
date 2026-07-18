import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportClientError } from "../net/errorReporter";
import { useT } from "../i18n/useT";

interface Props { children: ReactNode }
interface State { error: Error | null }

// Fallback UI as its own function component: useT() is a hook and hooks
// can only be called from a function component (or another hook), never
// directly inside a class component's render() method — this keeps the
// hook call legal while GlobalErrorBoundary itself stays a class (it has
// to be, for getDerivedStateFromError/componentDidCatch).
function ErrorBoundaryFallback({
  message,
  onReload,
  onRecover,
}: {
  message: string;
  onReload: () => void;
  onRecover: () => void;
}) {
  const t = useT();
  return (
    <div className="error-boundary-fallback">
      <div className="error-boundary-card">
        <h2>{t("Something broke.")}</h2>
        <p>{t("The page hit an unexpected error. It's been logged and we'll look into it.")}</p>
        <p className="dim small">{message}</p>
        <div className="error-boundary-actions">
          <button
            type="button"
            className="g-btn-primary"
            onClick={onReload}
          >
            {t("Reload")}
          </button>
          <button
            type="button"
            className="g-btn-ghost"
            onClick={onRecover}
          >
            {t("Try to recover")}
          </button>
        </div>
      </div>
    </div>
  );
}

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
      <ErrorBoundaryFallback
        message={this.state.error.message}
        onReload={() => location.reload()}
        onRecover={() => this.setState({ error: null })}
      />
    );
  }
}
