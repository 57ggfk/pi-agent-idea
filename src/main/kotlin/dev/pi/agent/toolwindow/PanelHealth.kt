package dev.pi.agent.toolwindow

/**
 * What the Pi Agent tool window should do about the page it is showing.
 *
 * 063: this decision used to live inside the panel's health timer, where the
 * crash-loop budget was a SLIDING WINDOW of rebuild timestamps (60s) that was
 * SHORTER than the silence threshold that triggers a rebuild (90s). Every
 * rebuild therefore landed as the only entry in its own window, the "give up"
 * limit could never be reached, and the panel rebuilt the embedded browser
 * every 90 seconds for as long as the page stayed dead — a white rectangle
 * the user could do nothing about (idea.log 2026-11-20: "Rebuilding Pi Agent
 * UI (no bridge poll for 90s)" at 13:30:17, 13:31:47, 13:33:17, 13:34:47).
 *
 * The budget is now counted in CONSECUTIVE failures, which no threshold can
 * outrun, and the decision is a pure function so it can be unit-tested
 * without a project, a browser or a clock.
 */
internal enum class PanelHealthDecision {
    /** The page is talking to the bridge: nothing to do. */
    ALIVE,

    /** The page was mounted recently and has not had time to answer yet. */
    PENDING,

    /** The page stopped answering: rebuild the embedded browser. */
    REBUILD,

    /** The page failed too many times in a row: stop and let the user retry. */
    GIVE_UP,
}

internal object PanelHealth {

    /**
     * How long the page may stay silent before the panel acts. The frontend
     * long-polls every 20s, so this is more than four missed rounds: long
     * enough that a slow machine cannot trip it, short enough that a dead
     * page heals itself before the user gives up on it.
     */
    const val SILENCE_MS = 90_000L

    /**
     * Rebuilds in a row before the panel stops and parks on an error card.
     * Two attempts is enough to ride out a dead renderer, and short enough
     * that a permanently broken page reaches a state the user can act on.
     */
    const val MAX_CONSECUTIVE_FAILURES = 2

    /**
     * How long ago the last poll happened, counted only for polls that
     * arrived AFTER the current browser was mounted.
     *
     * The bridge remembers the last poll per pi instance, so the previous
     * page's final poll survives a rebuild. Treating that as evidence would
     * keep a dead page looking alive forever — the panel would sit on a
     * white rectangle believing the page was fine.
     *
     * A poll is "after the mount" when it is more recent than the mount
     * itself: poll age < mount age.
     */
    fun pollAgeSinceMount(currentPollAgeMs: Long, mountAgeMs: Long): Long {
        if (currentPollAgeMs == Long.MAX_VALUE) return Long.MAX_VALUE
        if (currentPollAgeMs >= mountAgeMs) return Long.MAX_VALUE
        return currentPollAgeMs
    }

    /**
     * The panel's next move.
     *
     * @param pollAgeSinceMountMs age of the last poll that arrived after the
     *   current mount, or [Long.MAX_VALUE] when the page never answered.
     * @param mountAgeMs age of the current browser.
     * @param consecutiveFailures rebuilds already spent without a single
     *   healthy poll in between.
     */
    fun decide(
        pollAgeSinceMountMs: Long,
        mountAgeMs: Long,
        consecutiveFailures: Int,
    ): PanelHealthDecision {
        if (pollAgeSinceMountMs <= SILENCE_MS) return PanelHealthDecision.ALIVE
        if (mountAgeMs < SILENCE_MS) return PanelHealthDecision.PENDING
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return PanelHealthDecision.GIVE_UP
        return PanelHealthDecision.REBUILD
    }
}
