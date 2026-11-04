package dev.pi.agent.ui

import com.intellij.ide.BrowserUtil
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import java.awt.BorderLayout
import java.awt.FlowLayout
import java.awt.Font
import java.awt.Toolkit
import java.awt.datatransfer.StringSelection
import javax.swing.BorderFactory
import javax.swing.JButton
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.JTextArea

/**
 * What the tool window shows when the web UI cannot be mounted at all: JCEF
 * missing, the loopback UI server failing to start, or a navigation error.
 *
 * A blank panel is the default failure mode of every one of those, and it
 * tells the user nothing — not even which URL to open in a normal browser.
 * This panel says what broke, shows the address, and offers the two escapes
 * that work without any further diagnostic: open it externally, or retry.
 *
 * Deliberately free of JCEF imports so it still works when the browser
 * classes are the thing that is missing.
 */
class PiUiErrorPanel(
    title: String,
    private val detail: List<String>,
    private val url: String?,
    private val onRetry: (() -> Unit)?,
) : JPanel(BorderLayout()) {

    init {
        border = JBUI.Borders.empty(16)
        background = UIUtil.getPanelBackground()

        val column = JPanel(BorderLayout(0, 10)).apply { isOpaque = false }

        val heading = JLabel(title).apply {
            font = font.deriveFont(Font.BOLD, font.size2D + 2f)
            foreground = UIUtil.getLabelForeground()
        }
        column.add(heading, BorderLayout.NORTH)
        column.add(detailArea(), BorderLayout.CENTER)

        val actions = JPanel(FlowLayout(FlowLayout.LEFT, 8, 0)).apply { isOpaque = false }
        if (url != null && onRetry != null) {
            actions.add(JButton("Retry").apply { addActionListener { onRetry.invoke() } })
        }
        if (url != null) {
            actions.add(JButton("Open in Browser").apply { addActionListener { BrowserUtil.browse(url) } })
            actions.add(JButton("Copy Address").apply {
                addActionListener {
                    Toolkit.getDefaultToolkit().systemClipboard
                        .setContents(StringSelection(url), null)
                }
            })
        }
        if (actions.componentCount > 0) column.add(actions, BorderLayout.SOUTH)

        add(column, BorderLayout.NORTH)
    }

    private fun detailArea(): JTextArea = JTextArea().apply {
        text = buildString {
            detail.forEach { append(it).append('\n') }
            if (url != null) {
                append('\n')
                append("Address: ").append(url).append('\n')
            }
        }.trimEnd()
        isEditable = false
        isOpaque = false
        lineWrap = true
        wrapStyleWord = true
        foreground = UIUtil.getLabelForeground()
        font = font.deriveFont(font.size2D)
        border = BorderFactory.createEmptyBorder()
    }
}
