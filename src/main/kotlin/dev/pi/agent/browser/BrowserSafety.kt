package dev.pi.agent.browser

import com.intellij.openapi.progress.ProcessCanceledException
import java.util.concurrent.CancellationException

/**
 * The one funnel for every call into the platform browser.
 *
 * The platform's remote browser is not exception-safe once its native state
 * is missing: `RemoteBrowser.canGoBack()` unboxes a null `Boolean` and
 * throws `NullPointerException: Cannot invoke "java.lang.Boolean.booleanValue()"`.
 * Kotlin's `?.` cannot see that - the throw happens INSIDE the platform call -
 * so it escaped the EDT callback of [BrowserPanel] and the IDE raised an
 * "IDE Internal Errors" balloon (049 walkthrough: `PiBrowserKernel.canGoBack`
 * -> `BrowserPanel.onStateChanged`).
 *
 * Two shapes reach it, both real: the renderer is gone (browser torn down or
 * crashed) and the startup race (the very first state change arrives before
 * the remote browser published its navigation state).
 *
 * Every platform call now goes through [guard]: a dead browser yields the
 * caller's default value instead of an IDE error dialog, and the failure is
 * logged once with the operation name.
 *
 * Cancellation is deliberately NOT swallowed: [ProcessCanceledException] and
 * [CancellationException] are the platform's cooperative-cancellation
 * signals, not failures, and eating them breaks IDE invariants.
 */
internal object BrowserSafety {

    /**
     * Runs [block]; on any failure returns [default] and reports [onError].
     * Cancellation exceptions are re-thrown untouched.
     */
    fun <T> guard(
        what: String,
        default: T,
        onError: (String) -> Unit,
        block: () -> T,
    ): T = try {
        block()
    } catch (e: ProcessCanceledException) {
        throw e
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        onError(
            "browser: " + what + " failed (" + e.javaClass.simpleName + ": " +
                (e.message ?: "no message") + ")",
        )
        default
    }
}
