package dev.pi.agent.settings

import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.options.Configurable
import com.intellij.openapi.ui.TextFieldWithBrowseButton
import com.intellij.ui.components.JBCheckBox
import java.awt.GridBagConstraints
import java.awt.GridBagLayout
import java.awt.Insets
import javax.swing.JComponent
import javax.swing.JPanel

/**
 * Settings → Tools → Pi Agent: explicit pi executable path and tool-window
 * auto-open. Plain Swing so it compiles cleanly against the 2024.3.1
 * baseline; no UI DSL.
 */
class PiAgentSettingsConfigurable : Configurable {

    private var pathField: TextFieldWithBrowseButton? = null
    private var autoOpenBox: JBCheckBox? = null

    override fun getDisplayName(): String = "Pi Agent"

    override fun createComponent(): JComponent {
        val settings = PiAgentSettings.getInstance()
        pathField = TextFieldWithBrowseButton().apply {
            // Both replacements exist unchanged since 2023.3; the old 4-arg
            // listener and createSingleFileDescriptor() are deprecated (the
            // former is scheduled for removal) on 2026.x.
            addBrowseFolderListener(null, FileChooserDescriptorFactory.createSingleFileNoJarsDescriptor())
            text = settings.customPiPath() ?: ""
        }
        autoOpenBox = JBCheckBox("Automatically open the Pi Agent tool window on project start", settings.autoOpen())

        val c = GridBagConstraints()
        c.gridx = 0
        c.weightx = 1.0
        c.fill = GridBagConstraints.HORIZONTAL
        c.insets = Insets(4, 0, 4, 0)
        val panel = JPanel(GridBagLayout())
        panel.add(pathField, c)
        c.gridy = 1
        panel.add(autoOpenBox, c)
        return panel
    }

    override fun isModified(): Boolean {
        val settings = PiAgentSettings.getInstance()
        val path = pathField?.text?.trim().orEmpty()
        return path != (settings.customPiPath() ?: "") || autoOpenBox?.isSelected != settings.autoOpen()
    }

    override fun apply() {
        val settings = PiAgentSettings.getInstance()
        val pathBefore = settings.customPiPath()
        val path = pathField?.text?.trim().orEmpty()
        settings.setCustomPiPath(path.takeIf { it.isNotBlank() })
        settings.setAutoOpen(autoOpenBox?.isSelected ?: false)
        if (pathBefore != settings.customPiPath()) {
            // pi must pick up the new executable: drop the cached discovery
            // result and restart running instances in every open project.
            dev.pi.agent.process.PiLocator.locate(forceRefresh = true)
            PiAgentSettings.restartPiEverywhere()
        }
    }

    override fun reset() {
        val settings = PiAgentSettings.getInstance()
        pathField?.text = settings.customPiPath() ?: ""
        autoOpenBox?.isSelected = settings.autoOpen()
    }

    override fun disposeUIResources() {
        pathField = null
        autoOpenBox = null
    }
}
