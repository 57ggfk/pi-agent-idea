import { useState } from "react";
import type { ContentBlock } from "../store/types";

function argSummary(argsJson: string, toolName: string): string {
  try {
    const args = JSON.parse(argsJson || "{}") as Record<string, unknown>;
    if (typeof args["command"] === "string") return args["command"];
    if (typeof args["file_path"] === "string") return args["file_path"];
    if (typeof args["path"] === "string") return args["path"];
    const first = Object.values(args)[0];
    if (typeof first === "string") return first;
    return toolName;
  } catch {
    return argsJson.slice(0, 120);
  }
}

export default function ToolCard({ block }: { block: Extract<ContentBlock, { kind: "toolcall" }> }) {
  const [open, setOpen] = useState(false);
  const running = !block.done && block.result !== undefined;
  const isError = block.result?.isError ?? false;
  const output = block.result?.output ?? "";
  const duration = block.result?.durationMs;

  const longOutput = output.length > 400;
  const shownOutput = longOutput && !open ? output.slice(0, 400) + "…" : output;

  return (
    <div className={`tool-card ${isError ? "tool-error" : ""}`} data-testid="tool-card">
      <div className="tool-card-head" onClick={() => output && setOpen((o) => !o)}>
        <span className="tool-icon">{toolGlyph(block.toolName)}</span>
        <span className="tool-name">{block.toolName}</span>
        <span className="tool-args" title={block.argsJson}>
          {argSummary(block.argsJson, block.toolName)}
        </span>
        <span className="tool-meta">
          {running ? <span className="spinner" /> : null}
          {isError ? <span className="tool-error-tag">error</span> : null}
          {duration != null ? <span className="tool-duration">{(duration / 1000).toFixed(1)}s</span> : null}
        </span>
      </div>
      {open && output ? <pre className="tool-output">{shownOutput}</pre> : null}
    </div>
  );
}

function toolGlyph(toolName: string): string {
  switch (toolName) {
    case "bash":
    case "powershell":
      return "❯";
    case "read":
      return "📄";
    case "edit":
      return "✏️";
    case "write":
      return "💾";
    case "grep":
    case "find":
      return "🔍";
    default:
      return "⚙";
  }
}
