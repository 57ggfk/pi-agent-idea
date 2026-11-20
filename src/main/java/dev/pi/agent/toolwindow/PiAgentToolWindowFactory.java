package dev.pi.agent.toolwindow;

import com.intellij.openapi.actionSystem.AnAction;
import com.intellij.openapi.actionSystem.AnActionEvent;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.ui.Messages;
import com.intellij.openapi.util.Disposer;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowFactory;
import com.intellij.openapi.wm.ToolWindowManager;
import com.intellij.ui.content.Content;
import com.intellij.ui.content.ContentFactory;
import com.intellij.ui.content.ContentManager;
import com.intellij.ui.content.ContentManagerEvent;
import com.intellij.ui.content.ContentManagerListener;
import dev.pi.agent.ui.PiUiErrorPanel;
import dev.pi.agent.PiAgentBundle;
import dev.pi.agent.bridge.BridgeService;
import dev.pi.agent.process.PiConnectionState;
import dev.pi.agent.process.PiProcessManager;

import javax.swing.JComponent;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.jetbrains.annotations.NotNull;

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

    /** 019 D8: at most four pi instances per project (the "+" greys out past this). */
    private static final int MAX_INSTANCES = 4;

    /**
     * 051: minimum gap between two AUTOMATIC recreations of an emptied tool
     * window.
     *
     * The 049 build recreated the content as fast as the platform reported
     * removals: eleven fresh JBCefBrowser instances in twelve seconds on a
     * real machine (idea.log 2026-11-20 13:35:29→13:35:41), and five in
     * seventeen seconds on 2026-11-18 12:05 — every recreation was removed
     * again, and each removal asked for another one.
     *
     * A user closing the last Pi tab still gets its content back at once;
     * only a SECOND automatic recreation inside this gap is held back.
     */
    private static final long MIN_RECREATE_GAP_MS = 5_000L;

    @Override
    public void createToolWindowContent(Project project, ToolWindow toolWindow) {
        // 019 D2: the first Content is the default instance (1).
        createInstanceContent(project, toolWindow, 1);
        toolWindow.getContentManager().addContentManagerListener(new CloseGuard(project));
        // 019 D7/D8: the "+" action lives in the tool window header. Pass the
        // project explicitly — title actions do not reliably carry one in their
        // AnActionEvent data context, which used to leave "+" disabled.
        toolWindow.setTitleActions(List.of(new NewInstanceAction(project)));
    }

    /**
     * Builds and installs one instance Content (019 D7). Shared by the initial
     * open and the "+" action; [instanceId] names the pi instance the panel is
     * bound to and is echoed on the tab ({@code Pi N}).
     */
    private void createInstanceContent(Project project, ToolWindow toolWindow, int instanceId) {
        // Reserve the slot before the page starts polling so rapid "+" clicks
        // cannot allocate the same id twice.
        PiProcessManager.getInstance(project).stateOf(instanceId);
        JComponent content = buildContent(project, instanceId);
        Content toolWindowContent = ContentFactory.getInstance().createContent(
                content, "Pi " + instanceId, true);
        toolWindowContent.setCloseable(true);
        // Without this the panel's dispose() never runs and the JCEF browser leaks.
        if (content instanceof PiAgentPanel) {
            Disposer.register(toolWindowContent, (PiAgentPanel) content);
        }
        toolWindow.getContentManager().addContent(toolWindowContent);
        toolWindow.getContentManager().setSelectedContent(toolWindowContent);
    }

    /**
     * 019 D8: the header "+" action. Greys out at [MAX_INSTANCES] live
     * instances; ids are the smallest unused number, so closing Pi 2 and
     * reopening gives Pi 2 again.
     *
     * <p>Both the enabled state and the next id are derived from the ACTUAL
     * Content tabs, not from the process registry: a closed tab can leave a
     * stale slot behind (a late long-poll re-registers listeners for that id),
     * which made {@code liveInstanceIds().size()} stay at 4 forever and left
     * "+" permanently disabled after closing any tab (C3, 2026-11-15).
     */
    private final class NewInstanceAction extends AnAction {
        private final Project project;

        NewInstanceAction(Project project) {
            super(PiAgentBundle.message("toolwindow.new.instance"),
                    PiAgentBundle.message("toolwindow.new.instance.tooltip"), null);
            this.project = project;
        }

        @Override
        public void update(@NotNull AnActionEvent e) {
            ToolWindow toolWindow = toolWindowOf(project);
            // 048 (spec US8): only Pi instance tabs count against the limit —
            // a browser Content tab shares the tool window but owns no pi
            // process, so it must not eat an instance slot.
            int instanceTabs = 0;
            if (toolWindow != null) {
                for (Content content : toolWindow.getContentManager().getContents()) {
                    if (content.getComponent() instanceof PiAgentPanel) instanceTabs++;
                }
            }
            e.getPresentation().setEnabled(toolWindow != null && instanceTabs < MAX_INSTANCES);
        }

        @Override
        public void actionPerformed(@NotNull AnActionEvent e) {
            ToolWindow toolWindow = toolWindowOf(project);
            if (toolWindow == null) return;
            createInstanceContent(project, toolWindow, nextInstanceId(toolWindow));
        }
    }

    /**
     * 019 D7: closing a Content stops its pi instance. When the instance is
     * mid-run, an IDE-native confirmation guards the close (the web ConfirmDialog
     * cannot answer here — the page is going away with the Content).
     */
    private final class CloseGuard implements ContentManagerListener {
        private final Project project;

        CloseGuard(Project project) {
            this.project = project;
        }

        /**
         * 051: when the last automatic recreation happened, for the rate
         * limit in {@link #autoRecreateAllowed}.
         */
        private long lastRecreateMs = 0L;

        @Override
        public void contentRemoved(@NotNull ContentManagerEvent event) {
            Content removed = event.getContent();
            if (!(removed.getComponent() instanceof PiAgentPanel panel)) return;
            if (project.isDisposed()) return;

            int id = panel.getId();
            var manager = PiProcessManager.getInstance(project);
            boolean running = BridgeService.getInstance(project).isStreaming(id);
            if (running) {
                int answer = Messages.showYesNoDialog(
                        project,
                        PiAgentBundle.message("toolwindow.close.confirm"),
                        PiAgentBundle.message("toolwindow.close.confirm.title"),
                        Messages.getWarningIcon());
                if (answer == Messages.NO) {
                    // Content removal has already disposed the old panel. Build
                    // a fresh panel instead of reusing its dead JCEF browser.
                    ToolWindow toolWindow = toolWindowOf(project);
                    if (toolWindow != null) {
                        createInstanceContent(project, toolWindow, id);
                    }
                    return;
                }
            }
            // The panel owns only browser resources. The process lifecycle is
            // decided here so cancellation above leaves the instance alive.
            // Every Content owns a pi process — including the default instance
            // 1. The old `id != 1` exemption leaked that process, its event
            // bucket and its queue mirror when the first tab was closed.
            manager.stopInstance(id);
            BridgeService.getInstance(project).closeInstance(id);
            recreateIfLast(project);
        }

        /**
         * 046: after an accepted close, if NO Pi Agent Content remains, rebuild
         * one right away through the same creation path as the header "+"
         * (FR-002) — the "closed to empty" tool window is what produced the
         * blank panel, and its stale persisted state is the feedstock for the
         * "loads forever" startup (real-machine forensics, 2026-11-17). The id
         * comes from the real Content tabs (FR-003, 019 lesson ①). A cancelled
         * close never reaches here (FR-005): it returns above with the same
         * instance rebuilt. No loop is possible (FR-007): this only runs on a
         * contentRemoved of a PiAgentPanel content, and a rebuilt Content whose
         * panel failed to construct is an error card — not a PiAgentPanel — so
         * closing it cannot re-enter this branch; a mid-run close still goes
         * through the IDE-native dialog first (019 lesson ②).
         *
         * <p>Deferred one EDT pass (real-machine find): inside the
         * contentRemoved dispatch the platform may not have finished the
         * removal yet, and an emptied tool window is auto-hidden right after —
         * a rebuild queued inside the event lost that race (the fresh content
         * vanished with the hidden window). Running later sees the settled
         * state; if the window already hid, {@code show()} brings it back with
         * its fresh content.
         */
        private void recreateIfLast(Project project) {
            ApplicationManager.getApplication().invokeLater(() -> {
                ToolWindow toolWindow = toolWindowOf(project);
                if (toolWindow == null) return;
                ContentManager manager = toolWindow.getContentManager();
                // 051: "the IDE is going away" is several different states,
                // and none of them wants a brand new JBCefBrowser.
                boolean disposing = project.isDisposed()
                        || ApplicationManager.getApplication().isDisposed()
                        || toolWindow.isDisposed()
                        || manager.isDisposed();
                long now = System.currentTimeMillis();
                if (!autoRecreateAllowed(disposing, now, lastRecreateMs, MIN_RECREATE_GAP_MS)) {
                    if (disposing) {
                        LOG.info("Pi Agent tool window closed to empty while the IDE is closing; not recreating");
                    } else {
                        LOG.warn("Pi Agent tool window closed to empty right after an automatic recreate;"
                                + " not recreating again yet");
                    }
                    return;
                }
                for (Content content : manager.getContents()) {
                    if (content.getComponent() instanceof PiAgentPanel) return;
                }
                lastRecreateMs = now;
                LOG.info("Pi Agent tool window closed to empty; recreating a clean content");
                createInstanceContent(project, toolWindow, nextInstanceId(toolWindow));
                if (!toolWindow.isVisible()) {
                    toolWindow.show();
                }
            });
        }
    }

    private static ToolWindow toolWindowOf(Project project) {
        return ToolWindowManager.getInstance(project).getToolWindow("Pi Agent");
    }

    /** 019 D1/D8: smallest unused id taken from the real Content tabs. */
    private static int nextInstanceId(ToolWindow toolWindow) {
        Set<Integer> used = new HashSet<>();
        for (Content content : toolWindow.getContentManager().getContents()) {
            if (content.getComponent() instanceof PiAgentPanel panel) {
                used.add(panel.getId());
            }
        }
        return smallestUnusedId(used);
    }

    /** The id allocator itself, extracted pure for unit testing (046). */
    static int smallestUnusedId(Set<Integer> used) {
        int n = 1;
        while (used.contains(n)) n++;
        return n;
    }

    /**
     * 051: the rate limit for automatic recreations of an emptied tool
     * window. Pure, so it can be unit-tested without a project.
     *
     * Two gates, and both are needed:
     *
     * <ul>
     *   <li>while the IDE or the project is closing there is nothing worth
     *       recreating — the window is being torn down;</li>
     *   <li>a second automatic recreation inside {@code minGapMs} is held
     *       back, because the 049 build recreated the content as fast as the
     *       platform reported removals (eleven JBCefBrowser instances in
     *       twelve seconds on a real machine): every recreation was removed
     *       again, and each removal asked for another one.</li>
     * </ul>
     *
     * @param disposing whether the IDE/project/tool window is going away.
     * @param nowMs current wall-clock time.
     * @param lastRecreateMs when the last automatic recreation happened, or 0.
     * @param minGapMs minimum gap between two automatic recreations.
     */
    static boolean autoRecreateAllowed(boolean disposing, long nowMs, long lastRecreateMs, long minGapMs) {
        if (disposing) return false;
        if (lastRecreateMs == 0L) return true;
        return nowMs - lastRecreateMs >= minGapMs;
    }

    private JComponent buildContent(Project project, int instanceId) {
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
            return new PiAgentPanel(project, instanceId);
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
