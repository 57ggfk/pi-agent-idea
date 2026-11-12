import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { installWheelGain } from "./lib/wheel";
import "./styles.css";

const root = document.getElementById("root");

/**
 * Marks the bundle as alive for the boot watchdog in index.html. Set before
 * the first render so a component throwing on mount is reported as a crash
 * (handled by ErrorBoundary) instead of "the bundle never arrived".
 */
declare global {
  interface Window {
    __piMounted?: boolean;
    __piBoot?: { start: number; scriptLoaded: boolean; errors: string[] };
    __piWheelOff?: () => void;
  }
}

window.__piMounted = true;

// One document-level wheel listener (see `lib/wheel.ts`). Removing the old one
// first matters: a hot reload that re-ran this module would otherwise stack a
// second listener and silently square the gain.
window.__piWheelOff?.();
window.__piWheelOff = installWheelGain();

if (!root) {
  // index.html and the bundle disagree — surface it instead of a blank panel.
  console.error("[pi-agent] #root is missing from index.html");
} else {
  createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

/**
 * Mirror uncaught errors into the console with a stable prefix: the IDE side
 * forwards JCEF console messages to idea.log, which is the only channel a
 * user in a locked-down environment can hand over.
 */
window.addEventListener("error", (e) => {
  console.error("[pi-agent] uncaught:", e.message, e.filename, e.lineno);
});
window.addEventListener("unhandledrejection", (e) => {
  const r = e.reason as { message?: string } | undefined;
  console.error("[pi-agent] unhandled rejection:", r?.message ?? String(e.reason));
});
