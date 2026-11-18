package dev.pi.agent.browser

import com.intellij.ide.BrowserUtil
import com.intellij.openapi.Disposable

import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.ui.SimpleListCellRenderer
import com.intellij.ui.awt.RelativePoint
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.icons.AllIcons
import com.intellij.util.ui.JBUI
import dev.pi.agent.PiAgentBundle
import dev.pi.agent.browser.LinkOption
import dev.pi.agent.browser.LinkRouting
import dev.pi.agent.ui.PiUiErrorPanel
import java.awt.BorderLayout
import java.awt.Dimension
import java.awt.MouseInfo
import java.awt.datatransfer.StringSelection
import java.awt.event.ActionEvent
import java.awt.event.InputEvent
import java.awt.event.KeyEvent
import javax.swing.AbstractAction
import javax.swing.BorderFactory
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.Icon
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.JTextField
import javax.swing.KeyStroke
import javax.swing.SwingUtilities

/**
 * The browser tab's Swing face (spec 048 T011): navigation toolbar (back /
 * forward / reload / address bar + Go), URL+title echo row, and the kernel's
 * browser component in the center, swapped for an error card on failure
 * (spec US7). Layout is fixed NORTH/CENTER — no runtime measurements
 * (constitution III); the kernel owns exactly one windowed browser, this
 * panel adds no second one (probe P-7).
 */
class BrowserPanel(private val project: Project, offscreen: Boolean = false) : JPanel(BorderLayout()), Disposable {

    private val log = Logger.getInstance(BrowserPanel::class.java)

    private val kernel = PiBrowserKernel(project, this, offscreen)

    private val addressField = JTextField()
    private val goButton = JButton(PiAgentBundle.message("browser.go"))
    private val backButton = navButton("browser.back.tooltip", AllIcons.Actions.Back)
    private val forwardButton = navButton("browser.forward.tooltip", AllIcons.Actions.Forward)
    private val reloadButton = navButton("browser.reload.tooltip", AllIcons.Actions.Refresh)

    /** 049 US5: hand the current page to the system default browser. */
    private val openExternalButton = navButton("browser.open.external.tooltip", AllIcons.Actions.MoveToTopRight)

    /** 049 易用性：加载卡住时可中止（真实用户走查项）。 */
    private val stopButton = navButton("browser.stop.tooltip", AllIcons.Actions.Suspend)
    private val echoLabel = JLabel(" ")

    /** Center host swaps between the browser component and the error card. */
    private val centerHost = JPanel(BorderLayout())

    /** Last submitted URL — the reload / error-card-retry target. */
    @Volatile
    private var lastUrl: String = ""

    private var titleText: String = ""
    private var lastEchoUrl: String = ""
    private var showingError = false
    private var loadingHint = false

    init {
        border = JBUI.Borders.empty()

        val navRow = JPanel()
        navRow.layout = BoxLayout(navRow, BoxLayout.LINE_AXIS)
        navRow.border = JBUI.Borders.empty(4, 8, 4, 8)
        navRow.add(backButton)
        navRow.add(forwardButton)
        navRow.add(reloadButton)
        navRow.add(stopButton)
        navRow.add(Box.createHorizontalStrut(4))
        navRow.add(openExternalButton)
        navRow.add(Box.createHorizontalStrut(6))
        navRow.add(addressField)
        navRow.add(Box.createHorizontalStrut(6))
        navRow.add(goButton)
        // 真机实测（049，窄工具窗）：BoxLayout 把 JTextField 压到 ~40px、Go 被裁出
        // 可视区，地址栏导航整个不可用。字段必须至少可读（120px）且吸收剩余宽度
        // （max 放开），Go 才能留在行尾、粘贴/输入才有着落。
        addressField.minimumSize = JBUI.size(120, 28)
        addressField.maximumSize = Dimension(Int.MAX_VALUE / 4, addressField.preferredSize.height)
        // 真机反馈「按钮太宽」：BoxLayout 把多余宽度摊给 max 未约束的组件
        // （JButton 默认无 max），五个按钮全被拉宽、之间出现大空隙。锁死
        // max=pref + 收紧 margin，按钮保持图标原始紧凑宽度，剩余宽度全部归地址栏。
        for (button in listOf(backButton, forwardButton, reloadButton, stopButton, openExternalButton, goButton)) {
            button.margin = JBUI.insets(2, 4)
            button.maximumSize = button.preferredSize
        }

        val north = JPanel(BorderLayout())
        north.add(navRow, BorderLayout.NORTH)
        echoLabel.border = JBUI.Borders.empty(2, 10)
        north.add(echoLabel, BorderLayout.SOUTH)

        add(north, BorderLayout.NORTH)
        showPlaceholder()
        add(centerHost, BorderLayout.CENTER)

        addressField.toolTipText = PiAgentBundle.message("browser.address.tooltip")
        // Ctrl+L jumps to the address bar (spec Q5) — the one browser habit
        // worth carrying over.
        val ctrlL = KeyStroke.getKeyStroke(KeyEvent.VK_L, InputEvent.CTRL_DOWN_MASK)
        inputMap.put(ctrlL, "focusAddress")
        actionMap.put("focusAddress", object : AbstractAction() {
            override fun actionPerformed(e: ActionEvent) {
                addressField.requestFocusInWindow()
            }
        })

        val submit = { _: ActionEvent -> submitAddress() }
        goButton.addActionListener(submit)
        addressField.addActionListener(submit)
        backButton.addActionListener { kernel.back() }
        forwardButton.addActionListener { kernel.forward() }
        reloadButton.addActionListener {
            if (lastUrl.isNotBlank()) kernel.load(lastUrl) else kernel.reload()
        }
        openExternalButton.addActionListener {
            val url = kernel.lastKnownUrl.ifBlank { lastUrl }
            if (url.isNotBlank()) BrowserUtil.browse(url)
        }
        openExternalButton.isEnabled = false // nothing loaded yet
        stopButton.addActionListener { kernel.stop() }
        stopButton.isEnabled = false
        // 049: right-click a link inside the page → same destination selector.
        kernel.onLinkContextMenu = { url -> SwingUtilities.invokeLater { showLinkSelector(url) } }

        kernel.addStateListener { state -> SwingUtilities.invokeLater { onStateChanged(state) } }
        kernel.onAddressChanged = { url -> SwingUtilities.invokeLater { updateEcho(url) } }
        kernel.onTitleChanged = { title ->
            SwingUtilities.invokeLater {
                titleText = title
                updateEcho(lastEchoUrl)
            }
        }
    }

    private fun navButton(tooltipKey: String, icon: Icon): JButton {
        val button = JButton(icon)
        button.toolTipText = PiAgentBundle.message(tooltipKey)
        button.isFocusable = false
        return button
    }

    /**
     * 049: right-click a link INSIDE the loaded page → the same
     * three-destination selector the chat uses, with one difference: EMBEDDED
     * navigates THIS kernel in place (the editor carrier must not hijack to
     * the tool window the way [PiBrowserManager.open] would).
     */
    private fun showLinkSelector(url: String) {
        val icons = mapOf(
            LinkOption.SYSTEM_BROWSER to AllIcons.Actions.MoveToTopRight,
            LinkOption.EMBEDDED to AllIcons.General.Web,
            LinkOption.COPY to AllIcons.Actions.Copy,
        )
        val renderer = object : SimpleListCellRenderer<LinkOption>() {
            override fun customize(
                list: javax.swing.JList<out LinkOption>,
                value: LinkOption,
                index: Int,
                selected: Boolean,
                hasFocus: Boolean,
            ) {
                icon = icons[value]
                text = value.label()
            }
        }
        val popup = JBPopupFactory.getInstance()
            .createPopupChooserBuilder(LinkRouting.linkOptions())
            .setTitle(PiAgentBundle.message("browser.link.selector.title"))
            .setRenderer(renderer)
            .setAdText(url)
            .setItemChosenCallback { option ->
                when (option) {
                    LinkOption.SYSTEM_BROWSER -> BrowserUtil.browse(url)
                    LinkOption.EMBEDDED -> load(url)
                    LinkOption.COPY -> CopyPasteManager.getInstance().setContents(StringSelection(url))
                }
            }
            .createPopup()
        val at = MouseInfo.getPointerInfo()?.location
        if (at != null) {
            popup.show(RelativePoint(at))
        } else {
            popup.showInFocusCenter()
        }
    }

    private fun showPlaceholder() {
        centerHost.removeAll()
        val hint = JLabel(PiAgentBundle.message("browser.empty.hint"))
        hint.horizontalAlignment = JLabel.CENTER
        centerHost.add(hint, BorderLayout.CENTER)
        revalidate()
        repaint()
    }

    /** Address bar entry point: normalize, then navigate (spec US1). */
    fun load(rawUrl: String) {
        val url = UrlNormalizer.normalizeAddressBar(rawUrl) ?: return
        lastUrl = url
        // kernel.load() lazily creates the browser; attach AFTER it so the
        // first open from an action shows the page instead of the placeholder.
        kernel.load(url)
        attachBrowserComponent()
    }

    // ---- 049 agent entries (AgentBrowserTool; caller owns threading — EDT) ----

    /**
     * Agent navigate: same shape as [load] minus address-bar normalization —
     * the tool endpoint sends an already-absolute URL. EDT only.
     */
    fun agentLoad(url: String) {
        lastUrl = url
        kernel.load(url)
        attachBrowserComponent()
    }

    /** Agent reload of the last submitted URL (mirrors the reload button). EDT only. */
    fun agentReload() {
        if (lastUrl.isNotBlank()) kernel.load(lastUrl) else kernel.reload()
    }

    /** Kernel handle for the agent state polling and page read. */
    fun agentKernel(): PiBrowserKernel = kernel

    private fun attachBrowserComponent() {
        val component = kernel.component() ?: return
        if (!showingError && centerHost.componentCount == 1 && centerHost.getComponent(0) === component) return
        centerHost.removeAll()
        centerHost.add(component, BorderLayout.CENTER)
        showingError = false
        revalidate()
        repaint()
    }

    private fun submitAddress() {
        load(addressField.text)
    }

    private fun onStateChanged(state: PiBrowserState) {
        backButton.isEnabled = kernel.canGoBack()
        forwardButton.isEnabled = kernel.canGoForward()
        loadingHint = state == PiBrowserState.LOADING
        stopButton.isEnabled = state == PiBrowserState.LOADING
        updateEcho(lastEchoUrl)
        when (state) {
            PiBrowserState.FAILED -> showErrorCard(
                PiAgentBundle.message("browser.error.title"),
                listOf(
                    PiAgentBundle.message("browser.error.detail"),
                    "",
                    PiAgentBundle.message("browser.error.hint"),
                ),
            )
            PiBrowserState.CRASHED -> showErrorCard(
                if (kernel.rebuildGaveUp) PiAgentBundle.message("browser.crash.permanent.title")
                else PiAgentBundle.message("browser.crash.title"),
                listOf(PiAgentBundle.message("browser.crash.detail")),
            )
            else -> if (showingError) {
                showingError = false
                attachBrowserComponent()
            }
        }
    }

    private fun showErrorCard(title: String, detail: List<String>) {
        showingError = true
        centerHost.removeAll()
        centerHost.add(
            PiUiErrorPanel(title, detail, lastUrl.ifBlank { null }, onRetry = { kernel.manualReload(lastUrl) }),
            BorderLayout.CENTER,
        )
        revalidate()
        repaint()
    }

    private fun updateEcho(url: String) {
        val previous = lastEchoUrl
        lastEchoUrl = url
        val loadingPrefix = if (loadingHint) PiAgentBundle.message("browser.loading.prefix") else ""
        echoLabel.text = loadingPrefix + if (titleText.isBlank()) url else "$titleText  —  $url"
        // 049 US5: external hand-off only makes sense once a page is up.
        openExternalButton.isEnabled = url.isNotBlank() || lastUrl.isNotBlank()
        // US1: echo navigation into the address bar. Update unless the user
        // has typed something different from the last echoed URL — nav
        // buttons are non-focusable, so hasFocus() alone would go stale after
        // a Back/Forward.
        if (url.isNotBlank() && (addressField.text.isBlank() || addressField.text == previous)) {
            addressField.text = url
        }
    }

    override fun dispose() {
        // Kernel disposes through Disposer (registered under this panel);
        // keep the hook explicit so the chain stays obvious.
        log.debug("browser panel disposed")
    }
}
