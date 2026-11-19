package dev.pi.agent.browser

import com.intellij.ide.BrowserUtil
import com.intellij.openapi.Disposable

import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.popup.JBPopup
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.icons.AllIcons
import com.intellij.ui.AnimatedIcon
import com.intellij.ui.SimpleListCellRenderer
import com.intellij.ui.awt.RelativePoint
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import dev.pi.agent.PiAgentBundle
import dev.pi.agent.ui.PiUiErrorPanel
import java.awt.BorderLayout
import java.awt.Dimension
import java.awt.MouseInfo
import java.awt.datatransfer.StringSelection
import java.awt.event.ActionEvent
import java.awt.event.FocusAdapter
import java.awt.event.FocusEvent
import java.awt.event.InputEvent
import java.awt.event.KeyAdapter
import java.awt.event.KeyEvent
import java.awt.event.MouseAdapter
import java.awt.event.MouseEvent
import java.net.URLEncoder
import javax.swing.AbstractAction
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.Icon
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.JProgressBar
import javax.swing.JTextField
import javax.swing.KeyStroke
import javax.swing.SwingUtilities

/**
 * The browser tab's Swing face (spec 048 T011): navigation toolbar (back /
 * forward / reload / open-external / DevTools / address bar + Go), loading
 * progress strip, URL+title echo row, the optional find bar, and the kernel's
 * browser component in the center, swapped for an error card on failure
 * (spec US7). Layout is fixed NORTH/CENTER — no runtime measurements
 * (constitution III); the kernel owns exactly one windowed browser, this
 * panel adds no second one (probe P-7).
 */
class BrowserPanel(private val project: Project, offscreen: Boolean = false) : JPanel(BorderLayout()), Disposable {

    private val log = Logger.getInstance(BrowserPanel::class.java)

    private val kernel = PiBrowserKernel(project, this, offscreen)

    // F-201: recent URLs drop down on focus/click (own popup), closing the
    // "closed the tab, lost the port" gap.
    private val addressField = JTextField()
    private val goButton = JButton(PiAgentBundle.message("browser.go"))
    private val backButton = navButton("browser.back.tooltip", AllIcons.Actions.Back)
    private val forwardButton = navButton("browser.forward.tooltip", AllIcons.Actions.Forward)
    private val reloadButton = navButton("browser.reload.tooltip", AllIcons.Actions.Refresh)

    /** F-106 (049 C1): hand the current page to the system default browser. */
    private val openExternalButton = navButton("browser.open.external.tooltip", AllIcons.Actions.MoveToTopRight)

    /** F-209: the platform DevTools window (inspector) for the current page. */
    private val devToolsButton = navButton("browser.devtools.tooltip", AllIcons.Actions.Preview)
    private val echoLabel = JLabel(" ")

    /** F-203: indeterminate strip while a navigation is in flight. */
    private val progressBar = JProgressBar()

    /** F-204: page find bar — a plain NORTH row, never a floating overlay
     * (048 hard rule 5: overlays over the windowed CEF HWND drift). */
    private val findField = JTextField()
    private val findHintLabel = JLabel(" ")
    private val findRow = JPanel(BorderLayout())

    /** Center host swaps between the browser component and the error card. */
    private val centerHost = JPanel(BorderLayout())

    /** Last submitted URL — the reload / error-card-retry target. */
    @Volatile
    private var lastUrl: String = ""

    private var titleText: String = ""
    private var lastEchoUrl: String = ""
    private var showingError = false

    /** F-203: true between Navigate and LoadEnd; drives the loading UI. */
    @Volatile
    private var loadingHint = false

    /** F-210: last main-frame failure, rendered into the FAILED card. */
    @Volatile
    private var lastErrorCode: String = ""
    @Volatile
    private var lastErrorText: String = ""

    /** F-213: live "⬇ name 45%" echo override, or null. */
    @Volatile
    private var downloadProgressText: String? = null

    /** F-204: whether the find bar is open (kernel Esc needs a sync answer). */
    @Volatile
    private var findOpen = false

    private var lastFindQuery: String = ""
    private var findNextPending = false

    /** F-201 round 2: the OWN history popup (replaces TextFieldWithHistory). */
    private var historyPopup: JBPopup? = null

    init {
        border = JBUI.Borders.empty()

        // F-109 round 2: BoxLayout 拉宽/挤压两轮修都没根治——按钮组 WEST、
        // 地址栏 CENTER、Go EAST 的 BorderLayout 让 Go 恒在行尾、地址栏恒吸收
        // 剩余宽度（真机复验：Go ~830px 才回归的根因是 max=pref 让按钮不可压缩）。
        val navRow = JPanel(BorderLayout())
        val navButtons = JPanel(java.awt.FlowLayout(java.awt.FlowLayout.LEFT, 2, 0))
        navButtons.border = JBUI.Borders.empty(4, 8)
        navButtons.add(backButton)
        navButtons.add(forwardButton)
        navButtons.add(reloadButton)
        navButtons.add(devToolsButton)
        navButtons.add(openExternalButton)
        navRow.add(navButtons, BorderLayout.WEST)
        navRow.add(addressField, BorderLayout.CENTER)
        navRow.add(goButton, BorderLayout.EAST)
        for (button in listOf(backButton, forwardButton, reloadButton, devToolsButton, openExternalButton, goButton)) {
            button.margin = JBUI.insets(2, 4)
        }

        val north = JPanel(BorderLayout())
        north.add(navRow, BorderLayout.NORTH)
        progressBar.isIndeterminate = true
        progressBar.isVisible = false
        // Middle band: the find bar row (F-204) sits above the loading strip.
        val mid = JPanel(BorderLayout())
        findRow.isVisible = false
        mid.add(findRow, BorderLayout.NORTH)
        mid.add(progressBar, BorderLayout.CENTER)
        north.add(mid, BorderLayout.CENTER)
        echoLabel.border = JBUI.Borders.empty(2, 10)
        north.add(echoLabel, BorderLayout.SOUTH)

        add(north, BorderLayout.NORTH)
        showPlaceholder()
        add(centerHost, BorderLayout.CENTER)

        val editor = addressField
        editor.toolTipText = PiAgentBundle.message("browser.address.tooltip")
        // F-101: the address bar is the one Swing text input users type into;
        // CJK IME composition pipelines (微信输入法 CN 模式) turn digits into
        // candidate picks and punctuation into CN mappings mid-URL, mangling
        // every typed address twice in a row. Opt the editor out of IME
        // composition entirely (java.awt.Component public API) — English/
        // paste flows are unaffected; CJK search terms ride the paste path
        // (flagged tradeoff, see F-212).
        editor.enableInputMethods(false)
        addressField.isEditable = true

        // F-201 round 2: recent URLs drop down on focus/click — OWN JBPopup,
        // not TextFieldWithHistory's (whose open popup swallowed the field's
        // Enter and submitted an empty search; walkthrough regression). The
        // field keeps keyboard focus the whole time, so Enter always submits
        // exactly what the user typed; a history pick fills + submits.
        editor.addFocusListener(object : FocusAdapter() {
            override fun focusGained(e: FocusEvent) = maybeShowHistory()
        })
        editor.addMouseListener(object : MouseAdapter() {
            override fun mouseClicked(e: MouseEvent) = maybeShowHistory()
        })
        editor.addKeyListener(object : KeyAdapter() {
            override fun keyPressed(e: KeyEvent) {
                if (e.keyCode == KeyEvent.VK_ESCAPE && historyPopup?.isVisible == true) {
                    historyPopup?.cancel()
                    e.consume()
                }
            }
        })

        // Ctrl+L jumps to the address bar (spec Q5) — the one browser habit
        // worth carrying over.
        val ctrlL = KeyStroke.getKeyStroke(KeyEvent.VK_L, InputEvent.CTRL_DOWN_MASK)
        inputMap.put(ctrlL, "focusAddress")
        actionMap.put("focusAddress", object : AbstractAction() {
            override fun actionPerformed(e: ActionEvent) {
                editor.requestFocusInWindow()
            }
        })

        // F-202: the same shortcut set on the Swing side — covers focus in
        // the toolbar/address bar (the page's own HWND is covered by the
        // kernel's CefKeyboardHandler). Ctrl+R vs the IDE's Replace is decided
        // by focus ownership; needs a real-machine pass.
        val im = getInputMap(WHEN_IN_FOCUSED_WINDOW)
        val am = actionMap
        fun bind(stroke: KeyStroke, key: String, action: () -> Unit) {
            im.put(stroke, key)
            am.put(key, object : AbstractAction() {
                override fun actionPerformed(e: ActionEvent) = action()
            })
        }
        bind(KeyStroke.getKeyStroke(KeyEvent.VK_LEFT, InputEvent.ALT_DOWN_MASK), "navBack") { kernel.back() }
        bind(KeyStroke.getKeyStroke(KeyEvent.VK_RIGHT, InputEvent.ALT_DOWN_MASK), "navForward") { kernel.forward() }
        bind(KeyStroke.getKeyStroke(KeyEvent.VK_R, InputEvent.CTRL_DOWN_MASK), "navReload") { reloadOrStop() }
        bind(KeyStroke.getKeyStroke(KeyEvent.VK_F5, 0), "navReloadF5") { reloadOrStop() }
        bind(KeyStroke.getKeyStroke(KeyEvent.VK_F, InputEvent.CTRL_DOWN_MASK), "findOpen") { toggleFindBar() }
        bind(KeyStroke.getKeyStroke(KeyEvent.VK_ESCAPE, 0), "navStop") {
            if (findOpen) closeFindBar() else if (loadingHint) kernel.stop()
        }
        // Swing-side zoom shares the CEF clamp logic (the page HWND route is
        // JcefBrowserZoom.onPreKeyEvent; this covers toolbar/address focus).
        bind(KeyStroke.getKeyStroke(KeyEvent.VK_EQUALS, InputEvent.CTRL_DOWN_MASK), "zoomIn") {
            JcefBrowserZoom.zoomIn(kernel.currentJbBrowser()?.cefBrowser)
        }
        bind(KeyStroke.getKeyStroke(KeyEvent.VK_ADD, InputEvent.CTRL_DOWN_MASK), "zoomInPad") {
            JcefBrowserZoom.zoomIn(kernel.currentJbBrowser()?.cefBrowser)
        }
        bind(KeyStroke.getKeyStroke(KeyEvent.VK_MINUS, InputEvent.CTRL_DOWN_MASK), "zoomOut") {
            JcefBrowserZoom.zoomOut(kernel.currentJbBrowser()?.cefBrowser)
        }
        bind(KeyStroke.getKeyStroke(KeyEvent.VK_SUBTRACT, InputEvent.CTRL_DOWN_MASK), "zoomOutPad") {
            JcefBrowserZoom.zoomOut(kernel.currentJbBrowser()?.cefBrowser)
        }
        bind(KeyStroke.getKeyStroke(KeyEvent.VK_0, InputEvent.CTRL_DOWN_MASK), "zoomReset") {
            JcefBrowserZoom.zoomReset(kernel.currentJbBrowser()?.cefBrowser)
        }

        val submit = { _: ActionEvent -> submitAddress() }
        goButton.addActionListener(submit)
        addressField.addActionListener(submit)
        backButton.addActionListener { kernel.back() }
        forwardButton.addActionListener { kernel.forward() }
        devToolsButton.addActionListener { kernel.openDevtools() }
        reloadButton.addActionListener { reloadOrStop() }
        openExternalButton.addActionListener {
            val url = kernel.currentUrl().ifBlank { lastUrl }
            if (url.isNotBlank()) BrowserUtil.browse(url)
        }
        openExternalButton.isEnabled = false // nothing loaded yet

        // F-204 find bar wiring.
        findField.toolTipText = PiAgentBundle.message("browser.find.tooltip")
        findHintLabel.text = PiAgentBundle.message("browser.find.hint")
        findHintLabel.border = JBUI.Borders.emptyRight(6)
        findHintLabel.foreground = UIUtil.getContextHelpForeground()
        findRow.border = JBUI.Borders.empty(2, 8)
        findRow.add(findField, BorderLayout.CENTER)
        val findActions = JPanel()
        findActions.layout = BoxLayout(findActions, BoxLayout.LINE_AXIS)
        findActions.isOpaque = false
        findActions.add(findHintLabel)
        val findClose = navButton("browser.find.close.tooltip", AllIcons.Actions.Close)
        findClose.addActionListener { closeFindBar() }
        findActions.add(findClose)
        findRow.add(findActions, BorderLayout.EAST)
        findField.addKeyListener(object : KeyAdapter() {
            override fun keyPressed(e: KeyEvent) {
                when (e.keyCode) {
                    KeyEvent.VK_ENTER -> submitFind(forward = !e.isShiftDown)
                    KeyEvent.VK_ESCAPE -> {
                        e.consume()
                        closeFindBar()
                    }
                }
            }
        })

        kernel.addStateListener { state -> SwingUtilities.invokeLater { onStateChanged(state) } }
        kernel.onAddressChanged = { url -> SwingUtilities.invokeLater { updateEcho(url) } }
        kernel.onTitleChanged = { title ->
            SwingUtilities.invokeLater {
                // F-203: a provisional title (next page's hostname) must not
                // glue itself onto the previous page's echo row mid-load.
                if (!loadingHint) {
                    titleText = title
                    updateEcho(lastEchoUrl)
                }
            }
        }
        kernel.onNavStateChanged = { back, forward ->
            backButton.isEnabled = back
            forwardButton.isEnabled = forward
        }
        kernel.onNavigationHistory = { url ->
            // F-201: page navigations feed the history; the one-shot preview
            // route is skipped — its token dies on first serve, a recorded
            // entry would always be a dead link.
            if (!url.contains("/preview/")) {
                PiBrowserHistory.getInstance(project).add(url)
            }
        }
        kernel.onLoadError = { code, text ->
            lastErrorCode = code
            lastErrorText = text
        }
        kernel.onDownloadProgress = { name, received, total ->
            downloadProgressText =
                if (total > 0) "⬇ $name ${received * 100 / total}%" else "⬇ $name ${received}B"
            echoLabel.text = downloadProgressText
        }
        kernel.onDownloadFinished = { _, _ ->
            downloadProgressText = null
            updateEcho(lastEchoUrl)
        }
        kernel.onAskPopup = { url -> showLinkSelector(url) }
        kernel.onFindRequest = { toggleFindBar() }
        kernel.onFindClose = { closeFindBar() }
        kernel.isFindBarOpen = { findOpen }
    }

    /**
     * F-203: while LOADING the reload button IS the stop button (the icon
     * morphs to the platform spinner); F-202③ semantics live in kernel.stop().
     */
    private fun reloadOrStop() {
        if (loadingHint) {
            kernel.stop()
        } else if (lastUrl.isNotBlank()) {
            kernel.load(lastUrl)
        } else {
            kernel.reload()
        }
    }

    private fun updateReloadButtonState() {
        if (loadingHint) {
            reloadButton.icon = AnimatedIcon.Default()
            reloadButton.toolTipText = PiAgentBundle.message("browser.stop.tooltip")
        } else {
            reloadButton.icon = AllIcons.Actions.Refresh
            reloadButton.toolTipText = PiAgentBundle.message("browser.reload.tooltip")
        }
    }

    // ---- F-204 find bar ----

    private fun toggleFindBar() {
        if (findOpen) closeFindBar() else openFindBar()
    }

    private fun openFindBar() {
        findOpen = true
        findRow.isVisible = true
        findField.requestFocusInWindow()
        revalidate()
        repaint()
    }

    private fun closeFindBar() {
        if (!findOpen) return
        findOpen = false
        findRow.isVisible = false
        findNextPending = false
        lastFindQuery = ""
        kernel.stopFinding(true)
        revalidate()
        repaint()
    }

    /**
     * Enter → next match; Shift+Enter → previous. The java-cef binding has no
     * CefFindHandler, so no native match count is available — the hint text
     * says so (F-204 MVP: highlight + Enter navigation only).
     */
    private fun submitFind(forward: Boolean) {
        val text = findField.text
        if (text.isBlank()) return
        val continueSearch = text == lastFindQuery && findNextPending
        kernel.find(text, forward, false, continueSearch)
        lastFindQuery = text
        findNextPending = true
    }

    // ---- F-201 history popup ----

    private fun maybeShowHistory() {
        val entries = PiBrowserHistory.getInstance(project).entries()
        if (entries.isEmpty()) return
        if (historyPopup?.isVisible == true) return
        // setRequestFocus(false): the field KEEPS focus while suggestions show
        // — the walkthrough regression was exactly this popup stealing focus,
        // so the user's typing went into type-ahead and Enter did nothing.
        historyPopup = JBPopupFactory.getInstance()
            .createPopupChooserBuilder(entries)
            .setTitle(PiAgentBundle.message("browser.history.title"))
            .setRenderer(SimpleListCellRenderer.create("") { it })
            .setItemChosenCallback { chosen ->
                addressField.text = chosen
                submitAddress()
            }
            .setRequestFocus(false)
            .setCancelOnClickOutside(true)
            .createPopup()
            .also { it.show(RelativePoint(addressField, java.awt.Point(0, addressField.height))) }
    }

    private fun navButton(tooltipKey: String, icon: Icon): JButton {
        val button = JButton(icon)
        button.toolTipText = PiAgentBundle.message(tooltipKey)
        button.isFocusable = false
        return button
    }

    /**
     * F-104: right-clicked link menu items and ASK-mode popups share this
     * three-destination selector. One difference from the chat panel: EMBEDDED
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

    /**
     * Address bar entry point (F-212): URL-shaped input loads as before; a
     * search-shaped query goes to the search engine (https, reachable from
     * CN networks). The query travels in the URL's query string, so LogSafe
     * keeps it out of idea.log.
     */
    fun load(rawUrl: String) {
        when (val parsed = UrlNormalizer.parseAddressBar(rawUrl)) {
            is UrlNormalizer.AddressInput.Url -> submitUrl(parsed.url)
            is UrlNormalizer.AddressInput.Search -> submitUrl(searchUrl(parsed.query))
        }
    }

    private fun searchUrl(query: String): String =
        SEARCH_ENGINE + URLEncoder.encode(query, Charsets.UTF_8.name())

    private fun submitUrl(url: String) {
        lastUrl = url
        // F-201: address-bar submissions are recorded too (the CEF-side
        // onAddressChange echo dedups through the history service).
        PiBrowserHistory.getInstance(project).add(url)
        // F-105: during LOADING/FAILED the status row must describe the
        // TARGET page, not a mix of the old page's title and URL. The echo is
        // raw (F-103) so the post-commit onAddressChange replay is byte-identical.
        titleText = ""
        updateEcho(url)
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
        submitUrl(url)
    }

    /** Agent reload of the last submitted URL (mirrors the reload button). EDT only. */
    fun agentReload() {
        if (lastUrl.isNotBlank()) kernel.load(lastUrl) else kernel.reload()
    }

    /** Kernel handle for the agent state polling and page read. */
    fun agentKernel(): PiBrowserKernel = kernel

    /**
     * F-103 round 2: tab re-selection re-syncs the echo row and address bar
     * from THIS tab's kernel (the walkthrough caught a tab showing another
     * tab's URL after switching back - the echo only updates from kernel
     * callbacks that fired while the tab was selected). EDT only.
     */
    fun refreshFromKernel() {
        titleText = kernel.lastKnownTitle
        updateEcho(kernel.lastKnownUrl)
    }

    /** F-208: the tab's target URL, for the manager's per-URL reuse rule. */
    fun currentUrl(): String = lastUrl

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
        val text = addressField.text
        if (text.isBlank()) return // Enter on an empty field never navigates
        load(text)
    }

    private fun onStateChanged(state: PiBrowserState) {
        backButton.isEnabled = kernel.canGoBack()
        forwardButton.isEnabled = kernel.canGoForward()
        loadingHint = state == PiBrowserState.LOADING
        updateReloadButtonState()
        progressBar.isVisible = loadingHint
        when (state) {
            PiBrowserState.LOADING -> {
                // F-203: drop the previous page's title, show the target URL
                // (set by load()/updateEcho) under the loading prefix.
                titleText = ""
                updateEcho(lastEchoUrl)
            }
            PiBrowserState.FAILED -> {
                val detail = buildList {
                    add(PiAgentBundle.message("browser.error.detail"))
                    // F-210: the CEF error code/text behind "Page failed to load".
                    if (lastErrorCode.isNotBlank()) {
                        add("Reason: $lastErrorText ($lastErrorCode)")
                    }
                    add("")
                    add(PiAgentBundle.message("browser.error.hint"))
                }
                showErrorCard(PiAgentBundle.message("browser.error.title"), detail)
            }
            PiBrowserState.CRASHED -> showErrorCard(
                if (kernel.rebuildGaveUp) PiAgentBundle.message("browser.crash.permanent.title")
                else PiAgentBundle.message("browser.crash.title"),
                listOf(PiAgentBundle.message("browser.crash.detail")),
            )
            else -> {
                if (state == PiBrowserState.LOADED) {
                    lastErrorCode = ""
                    lastErrorText = ""
                }
                if (showingError) {
                    showingError = false
                    attachBrowserComponent()
                }
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
        // F-106: external hand-off only makes sense once a page is up.
        openExternalButton.isEnabled = url.isNotBlank() || lastUrl.isNotBlank()
        // F-103: echo navigation into the address bar (raw URL). Update unless
        // the user has typed something different from the last echoed URL —
        // nav buttons are non-focusable, so hasFocus() alone would go stale
        // after a Back/Forward.
        if (url.isNotBlank() && (addressField.getText().isBlank() || addressField.getText() == previous)) {
            addressField.setText(url)
        }
    }

    override fun dispose() {
        // Kernel disposes through Disposer (registered under this panel);
        // keep the hook explicit so the chain stays obvious.
        log.debug("browser panel disposed")
    }

    private companion object {
        /** F-212: search fallback for non-URL input (Q1 re-answer). */
        const val SEARCH_ENGINE = "https://www.bing.com/search?q="
    }
}
