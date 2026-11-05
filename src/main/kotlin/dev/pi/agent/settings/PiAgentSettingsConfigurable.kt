package dev.pi.agent.settings

import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.options.Configurable
import com.intellij.openapi.ui.TextBrowseFolderListener
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
            // Only the overloads that exist on the 2023.3 floor are safe here.
            // The two-arg addBrowseFolderListener(Project, descriptor) was added
            // on 2024.3 — compiling against 2024.3.1 accepts it, and 2024.1 then
            // dies with NoSuchMethodError (that is how 0.5.1 got rejected).
            // The single-arg listener form predates 2023.3 and is not deprecated.
            addBrowseFolderListener(
                TextBrowseFolderListener(FileChooserDescriptorFactory.createSingleFileNoJarsDescriptor()),
            )
            text = settings.customPiPath() ?: ""
        }
        autoOpenBox = JBCheckBox(dev.pi.agent.PiAgentBundle.message("settings.autoOpen"), settings.autoOpen())

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
