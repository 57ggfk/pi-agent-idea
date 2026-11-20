package dev.pi.agent.browser

import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity

/**
 * 052: raises the JCEF log level at application start.
 *
 * The platform reads the level when it creates the first browser, so the
 * plugin has to speak before that happens. Application start is the
 * earliest project-level hook a plugin gets. The panel's own browser may
 * be created before any post-startup activity runs (measured on 2026.2.3:
 * the panel loaded at 21:55:02, the post-startup activity logged at
 * 21:55:04), so the panel asks for the level again right before it
 * creates its own browser.
 */
class JcefLogLevelSetup : ProjectActivity {

    override suspend fun execute(project: Project) {
        JcefLogLevelGuard.ensure()
    }
}
