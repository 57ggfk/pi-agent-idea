import { useCallback, useEffect, useState } from "react";
import { OutcomeBanner } from "../ManageView";
import type { manageApi, SkillInfo } from "../../manage";

/**
 * @param trusted project trust state from `trust.get`. Project-level skills
 *   exist on disk either way, but pi ignores them until the project is
 *   trusted — so they must be marked instead of being presented as active.
 */
export default function SkillsPanel({
  api,
  trusted = true,
}: {
  api: ReturnType<typeof manageApi>;
  trusted?: boolean;
}) {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [outcome, setOutcome] = useState<{ ok: boolean; error?: string; output?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", description: "" });

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const res = await api.skillsList();
      setSkills(res.skills ?? []);
    } catch (e) {
      setOutcome({ ok: false, error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = async () => {
    if (!form.name.trim()) return;
    setBusy(true);
    setOutcome(null);
    try {
      const res = await api.skillCreate({ name: form.name.trim(), description: form.description.trim() });
      setOutcome(res);
      if (res.ok) {
        setShowForm(false);
        setForm({ name: "", description: "" });
        await refresh();
      }
    } catch (e) {
      setOutcome({ ok: false, error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="skills-panel">
      <OutcomeBanner outcome={outcome} />
      <div className="panel-toolbar">
        <button className="btn" data-testid="skills-refresh" onClick={() => void refresh()} disabled={busy}>
          Refresh
        </button>
        <button className="btn" data-testid="skills-new-toggle" onClick={() => setShowForm((s) => !s)}>
          {showForm ? "Cancel" : "+ New skill"}
        </button>
      </div>

      {showForm ? (
        <div className="panel-form" data-testid="skills-form">
          <input
            className="select"
            placeholder="name (lowercase-with-hyphens)"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <input
            className="select"
            placeholder="description (when should the model use it?)"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
          <button className="btn btn-send" data-testid="skills-create" onClick={() => void create()}>
            Create
          </button>
        </div>
      ) : null}

      {skills.length === 0 && !showForm ? (
        <div className="panel-empty" data-testid="skills-empty">
          No skills found in ~/.pi/agent/skills, .pi/skills or .agents/skills.
        </div>
      ) : null}

      {skills.map((s) => {
        // Only project-level skills are gated: user skills always load.
        const inert = s.scope === "project" && !trusted;
        return (
          <div
            className={`panel-row ${inert ? "panel-row-inactive" : ""}`}
            key={s.path}
            data-testid="skill-row"
            data-scope={s.scope}
            data-active={inert ? "false" : "true"}
          >
            <div className="panel-row-main">
              <span className="panel-row-title">
                {s.name}
                <span className="scope-tag" data-testid="skill-scope" data-inert={inert ? "true" : "false"}>
                  {s.scope === "project" ? (inert ? "项目级 · 未生效" : "项目级") : "用户级"}
                </span>
              </span>
              <span className="panel-row-sub">{s.description}</span>
              {inert ? (
                <span
                  className="panel-row-sub panel-row-warn"
                  data-testid="skill-inert-reason"
                  title="项目未被 pi 信任：该 skill 存在于仓库中，但启动时会被忽略。"
                >
                  未生效：项目未被信任
                </span>
              ) : null}
            </div>
            <div className="panel-row-actions">
              <span className="panel-row-sub mono">{s.path}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
