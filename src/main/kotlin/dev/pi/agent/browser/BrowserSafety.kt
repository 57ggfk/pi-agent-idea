package dev.pi.agent.browser

import com.intellij.openapi.progress.ProcessCanceledException
import java.util.concurrent.CancellationException

/**
 * The single funnel for every platform call the plugin makes.
 *
 * 061/062: a platform browser call that throws must degrade to the caller's
 * default value, never escape as an "IDE Internal Errors" balloon. The
 * trigger was the platform's own remote browser: `RemoteBrowser.canGoBack()`
 * unboxes a null `Boolean` and throws `NullPointerException` once its
 * native state is missing.
 *
 * 063: catching `Exception` was still not enough. A dead native peer also
 * answers with `Error` subclasses — `NoClassDefFoundError` when the JCEF
 * classes cannot be linked any more, `LinkageError` when the runtime and the
 * shipped browser disagree — and those sailed straight past the funnel into
 * the EDT, which is exactly the crash the user reported ("the plugin went
 * blank after an exception"). The funnel therefore catches `Throwable`.
 *
 * Three things are deliberately NOT swallowed:
 *
 * - [ProcessCanceledException] and [CancellationException]: cooperative
 *   cancellation is not a failure, and turning it into a default value
 *   breaks the platform's own invariants;
 * - [VirtualMachineError]: an exhausted heap or a blown stack is fatal by
 *   contract. Reporting it as a "browser glitch" and carrying on would hide
 *   the real cause.
 */
internal object BrowserSafety {

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
    } catch (e: VirtualMachineError) {
        throw e
    } catch (t: Throwable) {
        onError(
            "browser: " + what + " failed (" + t.javaClass.simpleName + ": " +
                (t.message ?: "no message") + ")",
        )
        default
    }
}
