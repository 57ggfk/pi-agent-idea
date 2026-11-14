import { useCallback, useEffect, useMemo, useState } from "react";
import { useT } from "../../i18n/useT";
import { OutcomeBanner } from "../ManageView";
import { restartPiProcess } from "../../manage";
import type { Bridge } from "../../bridge/types";
import type { manageApi, SkillInfo, SkillsListResult } from "../../manage";

/**
 * Skills management (spec 034): grouped by directory source (six kinds),
 * with a hard enable/disable toggle (settings exclusion entries), the soft
 * `disable-model-invocation` switch (frontmatter) and external skill sources
 * — the Claude/Codex bridge (pi reads `~/.agents/skills` natively and accepts
 * any directory via the settings `skills` array).
 *
 * History: list + create came with 002/005; project-inert marking with 002;
 * 034 adds sources, the switches and the reload bar.
 */

/** Group order = listing order of the backend sources. */
const SOURCES: Array<{
  key: NonNullable<SkillInfo["source"]>;
  titleKey: "skill.source.userPi" | "skill.source.userAgents" | "skill.source.projectPi" | "skill.source.projectAgents" | "skill.source.package" | "skill.source.external";
}> = [
  { key: "user-pi", titleKey: "skill.source.userPi" },
  { key: "user-agents", titleKey: "skill.source.userAgents" },
  { key: "project-pi", titleKey: "skill.source.projectPi" },
  { key: "project-agents", titleKey: "skill.source.projectAgents" },
  { key: "package", titleKey: "skill.source.package" },
  { key: "external", titleKey: "skill.source.external" },
];

export default function SkillsPanel({
  api,
  bridge,
  trusted = true,
}: {
  api: ReturnType<typeof manageApi>;
  bridge: Bridge;
  trusted?: boolean;
}) {
  const { t } = useT();
  const [result, setResult] = useState<SkillsListResult | null>(null);
  const [outcome, setOutcome] = useState<{ ok: boolean; error?: string; output?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: "", description: "" });
  const [customDir, setCustomDir] = useState("");

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      setResult(await api.skillsList());
    } catch (e) {
      setOutcome({ ok: false, error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const skills = result?.skills ?? [];
  const externalSources = result?.externalSources ?? [];
  const presets = result?.externalPresets;

  const groups = useMemo(
    () =>
      SOURCES.map(({ key, titleKey }) => ({
        key,
        titleKey,
        entries: skills.filter((s) => s.source === key),
      })).filter((g) => g.entries.length > 0),
    [skills],
  );

  const toggleEnabled = async (skill: SkillInfo) => {
    setBusy(true);
    setOutcome(null);
    try {
      const res = await api.skillSetEnabled({ path: skill.path, enabled: !skill.enabled, scope: skill.scope });
      if (res.ok) {
        await refresh();
        setDirty(true);
      } else {
        setOutcome(res);
      }
    } catch (e) {
      setOutcome({ ok: false, error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const toggleSoft = async (skill: SkillInfo) => {
    setBusy(true);
    setOutcome(null);
    try {
      const res = await api.skillToggleModelInvocation({ path: skill.path, disable: !skill.disableModelInvocation });
      if (res.ok) {
        await refresh();
        setDirty(true);
      } else {
        setOutcome(res);
      }
    } catch (e) {
      setOutcome({ ok: false, error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const toggleSource = async (dir: string, enabled: boolean) => {
    setBusy(true);
    setOutcome(null);
    try {
      const res = await api.skillSetSourceEnabled({ dir, enabled });
      if (res.ok) {
        await refresh();
        setDirty(true);
      } else {
        setOutcome(res);
      }
    } catch (e) {
      setOutcome({ ok: false, error: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const reload = async () => {
    setBusy(true);
    try {
      await restartPiProcess(bridge);
      setDirty(false);
    } finally {
      setBusy(false);
    }
  };

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

      {dirty ? (
        <div className="outcome-banner outcome-ok" data-testid="skills-reload-bar">
          {t("skill.reloadNeeded")}
          <button className="btn" data-testid="skills-reload-btn" disabled={busy} onClick={() => void reload()}>
            {t("skill.reload")}
          </button>
        </div>
      ) : null}

      <div className="panel-toolbar">
        <button className="btn" data-testid="skills-refresh" onClick={() => void refresh()} disabled={busy}>
          {t("skill.refresh")}
        </button>
        <button className="btn" data-testid="skills-new-toggle" onClick={() => setShowForm((s) => !s)}>
          {showForm ? t("skill.cancel") : t("skill.newToggle")}
        </button>
      </div>

      {showForm ? (
        <div className="panel-form" data-testid="skills-form">
          <input
            className="select"
            placeholder={t("skill.formName")}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <input
            className="select"
            placeholder={t("skill.formDescription")}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
          <button className="btn btn-send" data-testid="skills-create" onClick={() => void create()}>
            {t("skill.create")}
          </button>
        </div>
      ) : null}

      {/* 外接技能目录（Q2）：预设 ~/.claude/skills 与 ~/.codex/skills + 自定义目录 */}
      <div className="skill-external" data-testid="skill-external">
        <div className="skill-external-title">{t("skill.externalTitle")}</div>
        {presets
          ? (["claude", "codex"] as const).map((preset) => {
              const dir = presets[preset];
              const enabled = externalSources.includes(dir);
              return (
                <button
                  key={preset}
                  className={`btn skill-external-toggle ${enabled ? "market-type-on" : ""}`}
                  data-testid={`skill-external-${preset}`}
                  disabled={busy}
                  onClick={() => void toggleSource(dir, !enabled)}
                >
                  <span className="mono">{dir}</span>
                  <span>{enabled ? t("skill.turnOff") : t("skill.turnOn")}</span>
                </button>
              );
            })
          : null}
        <div className="panel-toolbar skill-external-add">
          <input
            className="select packages-input"
            placeholder={t("skill.externalAddPlaceholder")}
            value={customDir}
            data-testid="skill-external-input"
            onChange={(e) => setCustomDir(e.target.value)}
          />
          <button
            className="btn"
            data-testid="skill-external-add"
            disabled={busy || !customDir.trim()}
            onClick={() =>
              void toggleSource(customDir.trim(), true).then(() => setCustomDir(""))
            }
          >
            {t("skill.externalAdd")}
          </button>
        </div>
      </div>

      {skills.length === 0 && !showForm ? (
        <div className="panel-empty" data-testid="skills-empty">
          {t("skill.empty")}
        </div>
      ) : null}

      {groups.map((group) => (
        <div key={group.key} className="skill-group">
          <div className="skill-group-title" data-testid={`skill-source-${group.key}`}>
            {t(group.titleKey)}
            <span className="skill-group-count">{group.entries.length}</span>
          </div>
          {group.entries.map((s) => {
            const index = skills.indexOf(s);
            return (
              <SkillRow
                key={s.path}
                t={t}
                skill={s}
                index={index}
                trusted={trusted}
                busy={busy}
                onToggleEnabled={() => void toggleEnabled(s)}
                onToggleSoft={() => void toggleSoft(s)}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

function SkillRow({
  t,
  skill,
  index,
  trusted,
  busy,
  onToggleEnabled,
  onToggleSoft,
}: {
  t: ReturnType<typeof useT>["t"];
  skill: SkillInfo;
  index: number;
  trusted: boolean;
  busy: boolean;
  onToggleEnabled: () => void;
  onToggleSoft: () => void;
}) {
  const inert = skill.scope === "project" && !trusted;
  return (
    <div
      className={`panel-row ${inert ? "panel-row-inactive" : ""} ${!skill.enabled ? "skill-row-off" : ""}`}
      key={skill.path}
      data-testid="skill-row"
      data-scope={skill.scope}
      data-active={inert || !skill.enabled ? "false" : "true"}
    >
      <div className="panel-row-main">
        <span className="panel-row-title">
          {skill.name}
          <span className="scope-tag" data-testid="skill-scope" data-inert={inert ? "true" : "false"}>
            {skill.scope === "project" ? (inert ? t("skill.projectInert") : t("skill.project")) : t("skill.user")}
          </span>
          {!skill.enabled ? (
            <span className="pkg-status-broken" data-testid={`skill-disabled-${index}`}>
              {t("skill.disabled")}
            </span>
          ) : null}
          {skill.disableModelInvocation ? (
            <span className="pkg-scope" data-testid={`skill-manual-${index}`}>
              {t("skill.manualOnly")}
            </span>
          ) : null}
          {skill.duplicate ? (
            <span className="pkg-scope" data-testid={`skill-dup-${index}`}>
              {t("skill.duplicate")}
            </span>
          ) : null}
        </span>
        <span className="panel-row-sub">{skill.description}</span>
        {inert ? (
          <span className="panel-row-sub panel-row-warn" data-testid="skill-inert-reason">
            {t("skill.inertReason")}
          </span>
        ) : null}
      </div>
      <div className="panel-row-actions">
        <button className="btn" data-testid={`skill-soft-${index}`} disabled={busy} onClick={onToggleSoft}>
          {skill.disableModelInvocation ? t("skill.softOff") : t("skill.softOn")}
        </button>
        <button
          className={`btn ${skill.enabled ? "btn-abort" : "btn-send"}`}
          data-testid={`skill-enable-${index}`}
          disabled={busy || inert}
          onClick={onToggleEnabled}
        >
          {skill.enabled ? t("skill.turnOff") : t("skill.turnOn")}
        </button>
        <span className="panel-row-sub mono">{skill.path}</span>
      </div>
    </div>
  );
}
