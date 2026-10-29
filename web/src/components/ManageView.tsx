import { usePiStore } from "../store/store";

/**
 * Placeholder for Phase 3 (MCP servers, packages, skills, auth, settings
 * management). Keeps the tab navigation stable from Phase 2 onward.
 */
export default function ManageView() {
  const piVersion = usePiStore((s) => s.piVersion);
  const piStatus = usePiStore((s) => s.piStatus);

  return (
    <div className="manage-view" data-testid="manage-view">
      <div className="manage-placeholder">
        <div className="empty-logo">π</div>
        <div className="empty-title">Pi management</div>
        <div className="empty-sub">
          MCP servers, packages, skills, authentication and settings arrive in Phase 3.
        </div>
        <div className="empty-sub">
          Currently detected: pi {piVersion || "(not found)"} — {piStatus}
        </div>
      </div>
    </div>
  );
}
