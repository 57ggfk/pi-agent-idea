import { useEffect } from "react";
import { usePiStore } from "./store/store";
import MessageList from "./components/MessageList";
import Composer from "./components/Composer";
import StatusBar from "./components/StatusBar";
import SessionsView from "./components/SessionsView";
import ManageView from "./components/ManageView";

export default function App() {
  const init = usePiStore((s) => s.init);
  const ready = usePiStore((s) => s.ready);
  const tab = usePiStore((s) => s.tab);
  const setTab = usePiStore((s) => s.setTab);

  useEffect(() => {
    void init();
  }, [init]);

  if (!ready) {
    return <div className="loading">Connecting to pi…</div>;
  }

  return (
    <div className="app">
      <div className="tabs" data-testid="tabs">
        {(["chat", "sessions", "manage"] as const).map((t) => (
          <button
            key={t}
            className={`tab ${tab === t ? "tab-active" : ""}`}
            data-testid={`tab-${t}`}
            onClick={() => setTab(t)}
          >
            {t === "chat" ? "Chat" : t === "sessions" ? "Sessions" : "Manage"}
          </button>
        ))}
      </div>
      {tab === "chat" ? (
        <>
          <MessageList />
          <Composer />
        </>
      ) : tab === "sessions" ? (
        <SessionsView />
      ) : (
        <ManageView />
      )}
      <StatusBar />
    </div>
  );
}
