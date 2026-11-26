package dev.pi.agent.browser

/**
 * 064: the JCEF log level — the only lever that makes Chromium's GPU crash
 * lines readable at all.
 *
 * The platform builds the CefSettings in [com.intellij.ui.jcef.SettingsHelper]
 * when the first browser is created, and it takes the log level from the
 * system property "ide.browser.jcef.log.level" (the same switch as
 * "disable | verbose | info | warning | error | fatal"). With the default
 * ("disable") the Chromium log stays EMPTY — verified on 2026.2.3: three
 * killed GPU processes produced a 0-byte `jcef_chromium_<pid>.log`, so a
 * log-based detector never sees anything.
 *
 * With "error" the same three kills produced exactly three
 * `GPU process exited unexpectedly` lines and a 381-byte file — cheap
 * enough to keep on.
 *
 * Two rules keep this polite:
 * - a level the user chose is never overwritten (Decision.KEEP);
 * - once JCEF is up the level is frozen, so the change would be a no-op
 *   (Decision.TOO_LATE) — the caller says so instead of pretending.
 *
 * Pure on purpose: the clock and the platform live in the guard, so this
 * stays unit testable.
 */
internal object JcefLogLevelPolicy {

    /** The platform's own switch, read as a system property. */
    const val PROPERTY = "ide.browser.jcef.log.level"

    /** ERROR carries the GPU crash line and keeps the file small. */
    const val DESIRED_LEVEL = "error"

    /** What to do about the log level. */
    enum class Decision {
        /** Nobody chose a level: set it to [DESIRED_LEVEL]. */
        SET,

        /** A level is already set — by the user or the platform: keep it. */
        KEEP,

        /** JCEF is already running: the level can no longer be changed. */
        TOO_LATE,
    }

    /** Decides what to do with the log level right now. */
    fun decide(currentValue: String?, cefAlreadyStarted: Boolean): Decision = when {
        !currentValue.isNullOrBlank() -> Decision.KEEP
        cefAlreadyStarted -> Decision.TOO_LATE
        else -> Decision.SET
    }

    /**
     * Does this level carry Chromium's ERROR lines? "GPU process exited
     * unexpectedly" is logged at ERROR severity, so every level from
     * "warning" upwards shows it; "disable" hides it.
     */
    fun capturesGpuCrashLines(level: String?): Boolean =
        when (level?.trim()?.lowercase()) {
            "verbose", "info", "warning", "error", "fatal" -> true
            else -> false
        }
}
