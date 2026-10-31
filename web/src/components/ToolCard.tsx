import { useState } from "react";
import type { ContentBlock } from "../store/types";
import { usePiStore } from "../store/store";

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

/** The file a tool call operates on (path / file_path / file), if any. */
function filePathOf(argsJson: string): string | null {
  try {
    const args = JSON.parse(argsJson || "{}") as Record<string, unknown>;
    for (const key of ["path", "file_path", "file"]) {
      const value = args[key];
      if (typeof value === "string" && value.trim()) return value;
    }
    return null;
  } catch {
    return null;
  }
}

interface DiffLine {
  sign: "-" | "+";
  text: string;
}

const MAX_DIFF_LINES = 500;

function splitLines(value: unknown): string[] | null {
  if (typeof value !== "string") return null;
  return value.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
}

/**
 * Simple diff preview for edit / write tool calls: removed lines from
 * old_string, added lines from new_string (write shows its content as all
 * added). Other tools return null and keep the plain card.
 */
function diffLinesFor(toolName: string, argsJson: string): DiffLine[] | null {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argsJson || "{}") as Record<string, unknown>;
  } catch {
    return null;
  }
  if (toolName === "edit") {
    const oldLines = splitLines(args["old_string"]);
    const newLines = splitLines(args["new_string"]);
    if (oldLines === null && newLines === null) return null;
    return [
      ...(oldLines ?? []).map((text): DiffLine => ({ sign: "-", text })),
      ...(newLines ?? []).map((text): DiffLine => ({ sign: "+", text })),
    ];
  }
  if (toolName === "write") {
    const lines = splitLines(args["content"] ?? args["text"]);
    if (lines === null) return null;
    return lines.map((text): DiffLine => ({ sign: "+", text }));
  }
  return null;
}

function DiffView({ lines }: { lines: DiffLine[] }) {
  const [showAll, setShowAll] = useState(false);
  const collapsed = !showAll && lines.length > MAX_DIFF_LINES;
  const visible = collapsed ? lines.slice(0, MAX_DIFF_LINES) : lines;
  return (
    <div className="tool-diff" data-testid="tool-diff">
      {visible.map((l, i) => (
        <div key={i} className={`diff-line ${l.sign === "-" ? "diff-del" : "diff-add"}`}>
          {l.sign} {l.text}
        </div>
      ))}
      {collapsed ? (
        <button className="btn diff-show-all" onClick={() => setShowAll(true)}>
          Show all ({lines.length} lines)
        </button>
      ) : null}
    </div>
  );
}

export default function ToolCard({ block }: { block: Extract<ContentBlock, { kind: "toolcall" }> }) {
  const [open, setOpen] = useState(false);
  const running = !block.done && block.result !== undefined;
  const isError = block.result?.isError ?? false;
  const output = block.result?.output ?? "";
  const duration = block.result?.durationMs;
  const diff = diffLinesFor(block.toolName, block.argsJson);
  const filePath = filePathOf(block.argsJson);

  const longOutput = output.length > 400;
  const shownOutput = longOutput && !open ? output.slice(0, 400) + "…" : output;

  return (
    <div className={`tool-card ${isError ? "tool-error" : ""}`} data-testid="tool-card">
      <div className="tool-card-head" onClick={() => output && setOpen((o) => !o)}>
        <span className="tool-icon">{toolGlyph(block.toolName)}</span>
        <span className="tool-name">{block.toolName}</span>
        <span
          className={filePath ? "tool-args tool-file-link" : "tool-args"}
          title={filePath ? `${block.argsJson}  (click to open in IDE)` : block.argsJson}
          onClick={(e) => {
            if (!filePath) return;
            e.stopPropagation();
            void usePiStore.getState().openFile(filePath, 1);
          }}
        >
          {argSummary(block.argsJson, block.toolName)}
        </span>
        <span className="tool-meta">
          {diff && filePath ? (
            <button
              className="btn tool-diff-btn"
              data-testid="tool-diff-btn"
              title="Show this file's changes in the IDE diff viewer"
              onClick={(e) => {
                e.stopPropagation();
                void usePiStore.getState().showFileDiff(filePath);
              }}
            >
              Diff
            </button>
          ) : null}
          {running ? <span className="spinner" /> : null}
          {isError ? <span className="tool-error-tag">error</span> : null}
          {duration != null ? <span className="tool-duration">{(duration / 1000).toFixed(1)}s</span> : null}
        </span>
      </div>
      {diff ? <DiffView lines={diff} /> : null}
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
