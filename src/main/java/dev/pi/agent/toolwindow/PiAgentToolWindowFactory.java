package dev.pi.agent.toolwindow;

import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.util.Disposer;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowFactory;
import com.intellij.ui.content.Content;
import com.intellij.ui.content.ContentFactory;
import dev.pi.agent.ui.PiUiErrorPanel;

import javax.swing.JComponent;
import java.util.List;

/**
 * Deliberately written in Java: {@code ToolWindowFactory} is a Kotlin
 * interface whose default methods were compiled with jvm-default=all upstream,
 * so a Kotlin implementation class would carry compiler-generated forwarders
 * for every default method (getIcon/getAnchor/manage/...). The plugin verifier
 * counts those forwarders as @Internal API usages even though the source
 * overrides nothing; a Java implementation inherits the interface defaults
 * directly and stays clean.
 *
 * <p>The factory also owns the "JCEF is missing" case. It probes by class name
 * (never by touching the types) so a plugin installed into an IDE without the
 * Web Browser component still shows instructions instead of an empty window.
 */
public class PiAgentToolWindowFactory implements ToolWindowFactory {

    private static final Logger LOG = Logger.getInstance(PiAgentToolWindowFactory.class);

    private static final String JCEF_BROWSER = "com.intellij.ui.jcef.JBCefBrowser";
    private static final String JCEF_APP = "com.intellij.ui.jcef.JBCefApp";

    @Override
    public void createToolWindowContent(Project project, ToolWindow toolWindow) {
        JComponent content = buildContent(project);
        Content toolWindowContent = ContentFactory.getInstance().createContent(content, "", false);
        // Without this the panel's dispose() never runs and the JCEF browser leaks.
        if (content instanceof PiAgentPanel) {
            Disposer.register(toolWindowContent, (PiAgentPanel) content);
        }
        toolWindow.getContentManager().addContent(toolWindowContent);
    }

    private JComponent buildContent(Project project) {
        if (!canLoad(JCEF_BROWSER) || !canLoad(JCEF_APP)) {
            LOG.warn("JCEF classes are not available; Pi Agent cannot embed its UI");
            return new PiUiErrorPanel(
                    "Pi Agent needs the IDE's Web Browser component",
                    List.of(
                            "This IDE build does not ship JCEF (the embedded Chromium the panel",
                            "draws with), so the chat UI cannot be shown inside the IDE.",
                            "",
                            "Install a full JetBrains IDE build (or enable the Web Browser",
                            "component) and reopen the tool window."),
                    null,
                    null);
        }
        try {
            return new PiAgentPanel(project);
        } catch (Throwable t) {
            // Class-level failures (NoClassDefFoundError, JCEF init) must not
            // escape into the platform: the tool window would stay blank.
            LOG.warn("Pi Agent panel could not be created", t);
            return new PiUiErrorPanel(
                    "Pi Agent panel could not be created",
                    List.of(
                            "The tool window failed to build its content: "
                                    + (t.getMessage() == null ? t.getClass().getName() : t.getMessage()),
                            "",
                            "See Help → Show Log in Explorer for the full stack trace."),
                    null,
                    null);
        }
    }

    private static boolean canLoad(String className) {
        try {
            // initialize=false: a missing class is what we are probing for, and
            // JCEF static initializers must not run during the probe.
            Class.forName(className, false, PiAgentToolWindowFactory.class.getClassLoader());
            return true;
        } catch (ClassNotFoundException | LinkageError e) {
            return false;
        }
    }
}
