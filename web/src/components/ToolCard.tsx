import { useState } from "react";
import type { ContentBlock } from "../store/types";
import { usePiStore } from "../store/store";
import { useT } from "../i18n/useT";
import Icon from "./Icon";

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
  const { t } = useT();
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
          {t("tool.showAll", { count: lines.length })}
        </button>
      ) : null}
    </div>
  );
}

export default function ToolCard({
  block,
  forceOpen,
}: {
  block: Extract<ContentBlock, { kind: "toolcall" }>;
  /** Session search points at this card's output: expand it (spec 006 T011). */
  forceOpen?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const isOpen = open || forceOpen === true;
  const { t } = useT();
  const running = !block.done && block.result !== undefined;
  const isError = block.result?.isError ?? false;
  const output = block.result?.output ?? "";
  const duration = block.result?.durationMs;
  const diff = diffLinesFor(block.toolName, block.argsJson);
  const filePath = filePathOf(block.argsJson);

  const longOutput = output.length > 400;
  const shownOutput = longOutput && !isOpen ? output.slice(0, 400) + "…" : output;
  // A finished call with an empty output still has a detail pane worth opening
  // ("(no output)"): otherwise the whole card looks dead. A call that is still
  // running only expands once it has something to show.
  const hasResult = block.result !== undefined;
  const canExpand = hasResult && (output.length > 0 || block.done);

  return (
    <div className={`tool-card ${isError ? "tool-error" : ""}`} data-testid="tool-card">
      <div
        className="tool-card-head"
        data-expandable={canExpand}
        aria-expanded={canExpand ? isOpen : undefined}
        onClick={() => canExpand && setOpen((o) => !o)}
      >
        <span className="tool-icon">{toolIcon(block.toolName)}</span>
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
              title={t("tool.diffTitle")}
              onClick={(e) => {
                e.stopPropagation();
                void usePiStore.getState().showFileDiff(filePath);
              }}
            >
              {t("tool.diff")}
            </button>
          ) : null}
          {running ? <span className="spinner" /> : null}
          {isError ? <span className="tool-error-tag">error</span> : null}
          {duration != null ? <span className="tool-duration">{(duration / 1000).toFixed(1)}s</span> : null}
        </span>
      </div>
      {diff ? <DiffView lines={diff} /> : null}
      {isOpen && canExpand ? <pre className="tool-output">{shownOutput || t("tool.noOutput")}</pre> : null}
    </div>
  );
}

function toolIcon(toolName: string) {
  switch (toolName) {
    case "bash":
    case "powershell":
      return <Icon name="terminal" className="ic-sm" />;
    case "read":
      return <Icon name="file" className="ic-sm" />;
    case "edit":
      return <Icon name="pencil" className="ic-sm" />;
    case "write":
      return <Icon name="download" className="ic-sm" />;
    case "grep":
    case "find":
      return <Icon name="search" className="ic-sm" />;
    default:
      return <Icon name="settings" className="ic-sm" />;
  }
}
