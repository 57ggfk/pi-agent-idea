package dev.pi.agent.browser

import com.intellij.openapi.diagnostic.Logger

/**
 * 052: the glue between [JcefLogLevelPolicy] and the running IDE.
 *
 * The platform freezes the JCEF log level when it builds the CefSettings,
 * which happens when the first browser is created. So the level has to be
 * chosen before that — the earliest hook the plugin has is the application
 * start (see [JcefLogLevelSetup]); this object is also called right before
 * the plugin creates its own browser, in case somebody else got there first.
 *
 * Everything platform-specific goes through reflection: the supported IDE
 * line is 233-263 and the JCEF classes moved between the platform and a
 * separate module in 2026.2.
 */
internal object JcefLogLevelGuard {

    private val log = Logger.getInstance(JcefLogLevelGuard::class.java)

    /**
     * Makes sure Chromium's log can carry GPU crash lines, and reports what
     * was done — "did nothing" is a legitimate answer that has to be said
     * out loud, otherwise a silent watch looks like a broken feature.
     */
    fun ensure(): JcefLogLevelPolicy.Decision {
        val current = currentLevel()
        val decision = JcefLogLevelPolicy.decide(current, cefAlreadyStarted())
        when (decision) {
            JcefLogLevelPolicy.Decision.SET -> applyDesiredLevel()
            JcefLogLevelPolicy.Decision.KEEP -> log.info(
                "Pi Agent: JCEF log level left at '" + current + "' — it was set by the user or the platform",
            )
            JcefLogLevelPolicy.Decision.TOO_LATE -> log.warn(
                "Pi Agent: JCEF is already running, so its log level can no longer be raised — " +
                    "GPU crash detection may stay silent this session. Add -D" +
                    JcefLogLevelPolicy.PROPERTY + "=" + JcefLogLevelPolicy.DESIRED_LEVEL +
                    " to the IDE VM options (Help -> Edit Custom VM Options) to cover every start.",
            )
        }
        return decision
    }

    /** The level in effect right now, if any. */
    fun currentLevel(): String? = try {
        System.getProperty(JcefLogLevelPolicy.PROPERTY)
    } catch (_: Throwable) {
        null
    }

    private fun applyDesiredLevel(): Boolean = try {
        System.setProperty(JcefLogLevelPolicy.PROPERTY, JcefLogLevelPolicy.DESIRED_LEVEL)
        log.info(
            "Pi Agent: set " + JcefLogLevelPolicy.PROPERTY + "=" + JcefLogLevelPolicy.DESIRED_LEVEL +
                " so GPU crashes show up in the JCEF log",
        )
        true
    } catch (t: Throwable) {
        log.warn("Pi Agent: cannot set " + JcefLogLevelPolicy.PROPERTY + " (" + t.javaClass.simpleName + ")")
        false
    }

    /**
     * True when a CEF app already exists — its settings, and with them the
     * log level, are frozen at that point.
     *
     * JCEF's own [org.cef.CefApp.getInstanceIfAny] only reads the current
     * instance (it never creates one); the platform's
     * [com.intellij.ui.jcef.JBCefApp.isStarted] is the fallback for IDEs
     * where that JCEF method does not exist.
     */
    fun cefAlreadyStarted(): Boolean {
        try {
            val cefApp = Class.forName("org.cef.CefApp")
            if (cefApp.getMethod("getInstanceIfAny").invoke(null) != null) return true
        } catch (_: Throwable) {
            // Older JCEF (233-261) has no getInstanceIfAny — try the platform.
        }
        try {
            val platform = Class.forName("com.intellij.ui.jcef.JBCefApp")
            return platform.getMethod("isStarted").invoke(null) == true
        } catch (_: Throwable) {
            // No way to tell — assume the level can still be set.
        }
        return false
    }
}
