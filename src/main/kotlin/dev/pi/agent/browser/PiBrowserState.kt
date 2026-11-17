package dev.pi.agent.browser

/**
 * Browser lifecycle state machine (spec 048 T001). Pure logic, no JCEF — the
 * kernel translates CEF callbacks into [Event]s and broadcasts the resulting
 * state to carriers (tool window tab / editor panel).
 *
 * The crash path exists because the tool window panel's health watch (bridge
 * poll silence, `PiAgentPanel.checkBridgeSilence`) has no equivalent here: a
 * plain web page talks to nobody. Probe P-6 fixed the signal instead —
 * `onRenderProcessTerminated` plus main-frame `onLoadError`.
 */
enum class PiBrowserState {
    /** Kernel created, no page requested yet (browser may not even exist). */
    IDLE,

    /** A navigation is in flight (address bar reflects the target URL). */
    LOADING,

    /** Main frame finished loading (HTTP status irrelevant; errors are FAILED). */
    LOADED,

    /** Navigation failed (DNS/refused/cert-intercepted/…). Recoverable by reload. */
    FAILED,

    /** Renderer process died. Kernel rebuilds the browser; guarded by the fuse. */
    CRASHED,
}

sealed class PiBrowserEvent {
    /** Address bar submitted a URL (or an in-page navigation started). */
    data class Navigate(val url: String) : PiBrowserEvent()

    /** Main frame load ended. */
    object LoadEnd : PiBrowserEvent()

    /** Main frame load error (ERR_ABORTED excluded by the kernel, not here). */
    data class LoadError(val errorCode: String, val errorText: String) : PiBrowserEvent()

    /** Renderer process terminated (probe P-6). */
    data class RenderProcessGone(val status: String) : PiBrowserEvent()

    /** A rebuild finished; the fresh browser is IDLE until the next navigate. */
    object Rebuilt : PiBrowserEvent()
}

object PiBrowserStateMachine {

    /**
     * Total transition table. `null` = the event is illegal in that state and
     * is dropped (logged by the caller) rather than corrupting the state.
     *
     * Navigate is accepted from every state: a user can type a new URL while a
     * page is loading or after a failure, and CEF itself restarts loading.
     */
    fun transition(state: PiBrowserState, event: PiBrowserEvent): PiBrowserState? = when (event) {
        is PiBrowserEvent.Navigate -> PiBrowserState.LOADING
        PiBrowserEvent.LoadEnd -> when (state) {
            PiBrowserState.LOADING -> PiBrowserState.LOADED
            // LoadEnd for a stale navigation after the user already navigated
            // elsewhere: the new Navigate already set LOADING; a trailing
            // LoadEnd from the old frame must not regress the state.
            else -> null
        }
        is PiBrowserEvent.LoadError -> when (state) {
            PiBrowserState.LOADING -> PiBrowserState.FAILED
            PiBrowserState.LOADED, PiBrowserState.FAILED -> PiBrowserState.FAILED
            // Error for a stale frame after crash/rebuild is noise.
            else -> null
        }
        is PiBrowserEvent.RenderProcessGone -> when (state) {
            PiBrowserState.IDLE -> null
            else -> PiBrowserState.CRASHED
        }
        PiBrowserEvent.Rebuilt -> when (state) {
            PiBrowserState.CRASHED -> PiBrowserState.IDLE
            else -> null
        }
    }
}
