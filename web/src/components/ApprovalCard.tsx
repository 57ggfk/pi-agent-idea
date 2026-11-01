import { usePiStore } from "../store/store";

/**
 * Pending tool-approval dialogs forwarded by the bundled pi-approve extension
 * (extension_ui_request over RPC). Rendered above the composer; the agent run
 * is blocked until the user answers or the 5-minute timeout denies.
 */
export default function ApprovalCard() {
  const approvals = usePiStore((s) => s.approvals);
  const respondApproval = usePiStore((s) => s.respondApproval);
  if (approvals.length === 0) return null;
  // pi blocks inside the tool_call hook, so requests queue one at a time.
  const a = approvals[0];
  return (
    <div className="approval-card" data-testid="approval-card">
      <div className="approval-title" data-testid="approval-title">
        🛡 {a.title || `Allow ${a.method}?`}
      </div>
      {a.message ? (
        <pre className="approval-message" data-testid="approval-message">
          {a.message}
        </pre>
      ) : null}
      {approvals.length > 1 ? (
        <div className="approval-queued" data-testid="approval-queued">
          +{approvals.length - 1} queued
        </div>
      ) : null}
      <div className="approval-actions">
        <button
          className="btn btn-approve"
          data-testid="approval-allow"
          onClick={() => void respondApproval(a.id, true)}
        >
          Allow
        </button>
        <button
          className="btn btn-deny"
          data-testid="approval-deny"
          onClick={() => void respondApproval(a.id, false)}
        >
          Deny
        </button>
      </div>
    </div>
  );
}
