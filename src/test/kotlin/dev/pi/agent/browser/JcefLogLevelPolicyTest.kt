package dev.pi.agent.browser

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * 052: the JCEF log level is the only lever that makes Chromium's GPU crash
 * lines readable at all. With the default level ("disable") the Chromium log
 * stays empty — verified on 2026.2: three killed GPU processes produced a
 * 0-byte log file.
 *
 * The platform reads the level from the system property
 * "ide.browser.jcef.log.level" while it builds the CefSettings, i.e. when
 * the first browser is created (JBCefApp -> SettingsHelper.loadSettings).
 * So the level can still be chosen as long as nobody created a browser yet.
 */
class JcefLogLevelPolicyTest {

    @Test
    fun `an unset level is set to error when jcef is not up yet`() {
        assertEquals(
            JcefLogLevelPolicy.Decision.SET,
            JcefLogLevelPolicy.decide(currentValue = null, cefAlreadyStarted = false),
        )
        assertEquals(
            JcefLogLevelPolicy.Decision.SET,
            JcefLogLevelPolicy.decide(currentValue = "  ", cefAlreadyStarted = false),
        )
    }

    @Test
    fun `a level the user chose is never overwritten`() {
        assertEquals(
            JcefLogLevelPolicy.Decision.KEEP,
            JcefLogLevelPolicy.decide(currentValue = "disable", cefAlreadyStarted = false),
        )
        assertEquals(
            JcefLogLevelPolicy.Decision.KEEP,
            JcefLogLevelPolicy.decide(currentValue = "error", cefAlreadyStarted = false),
        )
    }

    @Test
    fun `setting the level after jcef started is pointless and reported as such`() {
        assertEquals(
            JcefLogLevelPolicy.Decision.TOO_LATE,
            JcefLogLevelPolicy.decide(currentValue = null, cefAlreadyStarted = true),
        )
    }

    @Test
    fun `a user level wins over the too late verdict`() {
        assertEquals(
            JcefLogLevelPolicy.Decision.KEEP,
            JcefLogLevelPolicy.decide(currentValue = "verbose", cefAlreadyStarted = true),
        )
    }

    @Test
    fun `only levels that carry error lines can show a gpu crash`() {
        // Chromium logs "GPU process exited unexpectedly" at ERROR severity.
        assertTrue(JcefLogLevelPolicy.capturesGpuCrashLines("error"))
        assertTrue(JcefLogLevelPolicy.capturesGpuCrashLines("fatal"))
        assertTrue(JcefLogLevelPolicy.capturesGpuCrashLines("warning"))
        assertTrue(JcefLogLevelPolicy.capturesGpuCrashLines("info"))
        assertTrue(JcefLogLevelPolicy.capturesGpuCrashLines("verbose"))
        assertTrue(JcefLogLevelPolicy.capturesGpuCrashLines(" ERROR "))
    }

    @Test
    fun `a disabled level hides gpu crashes`() {
        assertFalse(JcefLogLevelPolicy.capturesGpuCrashLines("disable"))
        assertFalse(JcefLogLevelPolicy.capturesGpuCrashLines(null))
        assertFalse(JcefLogLevelPolicy.capturesGpuCrashLines(""))
        assertFalse(JcefLogLevelPolicy.capturesGpuCrashLines("nonsense"))
    }
}
