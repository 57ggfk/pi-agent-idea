package dev.pi.agent.toolwindow;

import com.intellij.openapi.project.Project;
import com.intellij.openapi.util.Disposer;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowFactory;
import com.intellij.ui.content.Content;
import com.intellij.ui.content.ContentFactory;

/**
 * Deliberately written in Java: {@code ToolWindowFactory} is a Kotlin
 * interface whose default methods were compiled with jvm-default=all upstream,
 * so a Kotlin implementation class would carry compiler-generated forwarders
 * for every default method (getIcon/getAnchor/manage/...). The plugin verifier
 * counts those forwarders as @Internal API usages even though the source
 * overrides nothing; a Java implementation inherits the interface defaults
 * directly and stays clean.
 */
public class PiAgentToolWindowFactory implements ToolWindowFactory {

    @Override
    public void createToolWindowContent(Project project, ToolWindow toolWindow) {
        PiAgentPanel panel = new PiAgentPanel(project);
        Content content = ContentFactory.getInstance().createContent(panel, "", false);
        // Without this the panel's dispose() never runs and the JCEF browser leaks.
        Disposer.register(content, panel);
        toolWindow.getContentManager().addContent(content);
    }
}
