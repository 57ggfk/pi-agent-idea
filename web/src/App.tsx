import { useEffect } from "react";
import { usePiStore } from "./store/store";
import TopBar from "./components/TopBar";
import MessageList from "./components/MessageList";
import Composer from "./components/Composer";
import StatusBar from "./components/StatusBar";

export default function App() {
  const init = usePiStore((s) => s.init);
  const ready = usePiStore((s) => s.ready);

  useEffect(() => {
    void init();
  }, [init]);

  if (!ready) {
    return <div className="loading">Connecting to pi…</div>;
  }

  return (
    <div className="app">
      <TopBar />
      <MessageList />
      <Composer />
      <StatusBar />
    </div>
  );
}
