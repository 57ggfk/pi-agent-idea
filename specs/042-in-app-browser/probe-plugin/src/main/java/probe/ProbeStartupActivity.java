package probe;

import com.intellij.openapi.project.Project;
import com.intellij.openapi.startup.StartupActivity;
import com.intellij.openapi.wm.ToolWindowManager;
import org.jetbrains.annotations.NotNull;

/** Legacy StartupActivity (still functional in 243): auto-activates the probe
 *  tool window when the project opens so probes run without GUI interaction. */
public class ProbeStartupActivity implements StartupActivity {
    @Override
    public void runActivity(@NotNull Project project) {
        ProbeLog.line("startup activity fired for " + project.getName());
        ToolWindowManager.getInstance(project).invokeLater(() -> {
            var tw = ToolWindowManager.getInstance(project).getToolWindow("JCEF Probe");
            if (tw != null) {
                tw.activate(null);
                ProbeLog.line("tool window activated");
            } else {
                ProbeLog.line("tool window NOT found");
            }
        });
    }
}
