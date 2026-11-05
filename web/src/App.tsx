import { Component, useEffect, useMemo, type ReactNode } from "react";
import { usePiStore } from "./store/store";
import { outlineEntries } from "./lib/outline";
import { useT } from "./i18n/useT";
import { i18n } from "./i18n";
import MessageList from "./components/MessageList";
import Composer from "./components/Composer";
import SetupCard from "./components/SetupCard";
import QueueBar, { QueueDiscardBanner } from "./components/QueueBar";
import ApprovalCard from "./components/ApprovalCard";
import StatusBar from "./components/StatusBar";
import SessionsView from "./components/SessionsView";
import ManageView from "./components/ManageView";
import ConfirmDialog from "./components/ConfirmDialog";
import SessionOutline from "./components/SessionOutline";
import SessionSearch from "./components/SessionSearch";
import Icon, { IconSprite } from "./components/Icon";

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
          {/* Class component: no hook — the module-level i18n instance is
              already initialized by the time a crash can render. */}
          <div className="error-title">{i18n.t("app.crashed")}</div>
          <pre className="error-detail">{String(this.state.error.message ?? this.state.error)}</pre>
          <button className="btn" onClick={() => location.reload()}>
            {i18n.t("common.retry")}
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
  const items = usePiStore((s) => s.items);
  const toggleOutline = usePiStore((s) => s.toggleOutline);
  const openSearch = usePiStore((s) => s.openSearch);
  const { t } = useT();
  // The outline entry is hidden while the session has no user messages
  // (spec 006 FR-003) — a button that cannot do anything is noise.
  const userCount = useMemo(() => outlineEntries(items).length, [items]);

  useEffect(() => {
    void init();
  }, [init]);

  return (
    <ErrorBoundary>
      <IconSprite />
      {!ready ? (
        <div className="loading">{t("app.loading")}</div>
      ) : (
        <div className="app">
          <div className="tabs" role="tablist" aria-label="Pi Agent" data-testid="tabs">
            {(["chat", "sessions", "manage"] as const).map((tabId) => (
              <button
                key={tabId}
                role="tab"
                aria-selected={tab === tabId}
                className={`tab ${tab === tabId ? "tab-active" : ""}`}
                data-testid={`tab-${tabId}`}
                onClick={() => setTab(tabId)}
              >
                {tabId === "chat" ? t("chat.tabs.chat") : tabId === "sessions" ? t("chat.tabs.sessions") : t("chat.tabs.manage")}
              </button>
            ))}
            {tab === "chat" ? (
              <div className="tab-tools">
                {userCount > 0 ? (
                  <button
                    type="button"
                    className="tab-tool-btn"
                    data-testid="outline-btn"
                    aria-label={t("chat.outline.label")}
                    onClick={() => toggleOutline()}
                  >
                    <Icon name="list" className="ic-sm" />
                  </button>
                ) : null}
                <button
                  type="button"
                  className="tab-tool-btn"
                  data-testid="search-btn"
                  aria-label={t("chat.search.label")}
                  onClick={() => openSearch()}
                >
                  <Icon name="search" className="ic-sm" />
                </button>
              </div>
            ) : null}
          </div>
          <QueueDiscardBanner />
          {tab === "chat" ? (
            <>
              <SetupCard />
              <MessageList />
              <SessionOutline />
              <SessionSearch />
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
          <ConfirmDialog />
        </div>
      )}
    </ErrorBoundary>
  );
}
