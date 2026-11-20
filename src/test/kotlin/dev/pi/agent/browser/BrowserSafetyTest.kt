package dev.pi.agent.browser

import com.intellij.openapi.progress.ProcessCanceledException
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * 049 robustness contract: a platform browser call that throws must degrade
 * to the caller's default value, never escape as an "IDE Internal Errors"
 * balloon.
 *
 * The real trigger was the platform's own remote browser:
 * `RemoteBrowser.canGoBack()` unboxes a null `Boolean` and throws
 * `NullPointerException: Cannot invoke "java.lang.Boolean.booleanValue()"`
 * once its native state is missing — the renderer died, or the first state
 * change arrived before the remote browser published its navigation state.
 * Kotlin's `?.` cannot see that: the throw happens INSIDE the platform call.
 */
class BrowserSafetyTest {

    @Test
    fun `a throwing platform call degrades to the default and is reported once`() {
        var reported: String? = null
        val result = BrowserSafety.guard("canGoBack", false, { reported = it }) {
            throw NullPointerException("""Cannot invoke "java.lang.Boolean.booleanValue()" """)
        }
        assertEquals(false, result, "a dead browser must read as 'cannot go back'")
        val log = reported ?: error("the failure must be reported")
        assertTrue(log.contains("canGoBack"), "the operation name must be logged")
        assertTrue(log.contains("NullPointerException"), "the failure kind must be logged")
    }

    @Test
    fun `a healthy platform call passes its value through untouched`() {
        var reported: String? = null
        val result = BrowserSafety.guard("canGoForward", false, { reported = it }) { true }
        assertEquals(true, result)
        assertNull(reported, "a successful call must not be reported")
    }

    @Test
    fun `a null result is a value, not a failure`() {
        var reported: String? = null
        val result = BrowserSafety.guard<String?>("getURL", null, { reported = it }) { null }
        assertNull(result)
        assertNull(reported, "a null URL is normal before the first load")
    }

    @Test
    fun `cancellation is never swallowed into a default value`() {
        var reported: String? = null
        val thrown = runCatching {
            BrowserSafety.guard("loadURL", Unit, { reported = it }) { throw ProcessCanceledException() }
        }
        assertTrue(thrown.isFailure, "ProcessCanceledException must propagate")
        assertTrue(thrown.exceptionOrNull() is ProcessCanceledException)
        assertNull(reported, "a cancellation is not a failure to report")
    }

    @Test
    fun `an error inside the platform call does not escape the funnel`() {
        // The platform occasionally throws java.lang.Error subclasses on a
        // dead native peer; those must degrade too, or the EDT task dies.
        val result = BrowserSafety.guard("canGoBack", false, { }) {
            throw IllegalStateException("native peer is gone")
        }
        assertEquals(false, result)
    }
}
