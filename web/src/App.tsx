import { Component, useEffect, type ReactNode } from "react";
import { usePiStore } from "./store/store";
import MessageList from "./components/MessageList";
import Composer from "./components/Composer";
import QueueBar, { QueueDiscardBanner } from "./components/QueueBar";
import ApprovalCard from "./components/ApprovalCard";
import StatusBar from "./components/StatusBar";
import SessionsView from "./components/SessionsView";
import ManageView from "./components/ManageView";
import { IconSprite } from "./components/Icon";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/** Keeps a render crash from blanking the whole JCEF tool window. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("UI crashed", error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="error-boundary" data-testid="error-boundary">
          <div className="error-title">Something went wrong</div>
          <pre className="error-detail">{String(this.state.error.message ?? this.state.error)}</pre>
          <button className="btn" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const init = usePiStore((s) => s.init);
  const ready = usePiStore((s) => s.ready);
  const tab = usePiStore((s) => s.tab);
  const setTab = usePiStore((s) => s.setTab);

  useEffect(() => {
    void init();
  }, [init]);

  return (
    <ErrorBoundary>
      <IconSprite />
      {!ready ? (
        <div className="loading">Connecting to pi…</div>
      ) : (
        <div className="app">
          <div className="tabs" role="tablist" aria-label="Pi Agent" data-testid="tabs">
            {(["chat", "sessions", "manage"] as const).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={tab === t}
                className={`tab ${tab === t ? "tab-active" : ""}`}
                data-testid={`tab-${t}`}
                onClick={() => setTab(t)}
              >
                {t === "chat" ? "Chat" : t === "sessions" ? "Sessions" : "Manage"}
              </button>
            ))}
          </div>
          <QueueDiscardBanner />
          {tab === "chat" ? (
            <>
              <MessageList />
              <ApprovalCard />
              <QueueBar />
              <Composer />
            </>
          ) : tab === "sessions" ? (
            <SessionsView />
          ) : (
            <ManageView />
          )}
          <StatusBar />
        </div>
      )}
    </ErrorBoundary>
  );
}
