package dev.pi.agent.browser

import java.net.URLDecoder
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * 054 变更 3：本地 HTML file:// 直开——file URL 构造的纯函数锁。
 *
 * 硬约束 2（file:// 禁入浏览器页签）按用户授权放宽为：仅限用户主动打开的
 * 本地文件（右键 Open in Pi Browser/Editor）。放宽后的安全边界依赖这里：
 * 构造必须是三斜杠绝对路径 URL，且空白 / `#` / `?` 等 URL 结构字符必须
 * 百分号编码——否则路径会被 CEF 当成 fragment/query 截断，或读到别的文件。
 */
class FileUrlsTest {

    @Test
    fun `windows backslash path becomes a triple-slash file url`() {
        assertEquals("file:///C:/x/y/demo.html", FileUrls.forLocalFile("C:\\x\\y\\demo.html"))
    }

    @Test
    fun `windows forward-slash drive path keeps the triple slash`() {
        assertEquals("file:///D:/code/demo.html", FileUrls.forLocalFile("D:/code/demo.html"))
    }

    @Test
    fun `unix absolute path becomes a triple-slash file url`() {
        assertEquals("file:///home/u/demo.html", FileUrls.forLocalFile("/home/u/demo.html"))
    }

    @Test
    fun `spaces and url-significant characters are percent-encoded`() {
        assertEquals(
            "file:///C:/my%20dir/a%20b%231%3F2.html",
            FileUrls.forLocalFile("C:\\my dir\\a b#1?2.html"),
            "space / '#' / '?' must never survive raw — CEF would split fragment or query",
        )
    }

    @Test
    fun `non-ascii path survives the round trip`() {
        val url = FileUrls.forLocalFile("D:\\项目\\页面.html")
        assertTrue(url.startsWith("file:///D:/"), url)
        assertTrue(!url.any { it.code > 127 }, "must be pure ASCII for CEF loadURL: $url")
        assertEquals(
            "/D:/项目/页面.html",
            URLDecoder.decode(url.removePrefix("file://"), Charsets.UTF_8),
            "decoding the url back must yield the original path",
        )
    }

    @Test
    fun `already-file-scheme input passes through unchanged`() {
        assertEquals("file:///D:/x/a.html", FileUrls.forLocalFile("file:///D:/x/a.html"))
    }

    @Test
    fun `unc path maps to the file-host form`() {
        assertEquals("file://srv/share/a.html", FileUrls.forLocalFile("\\\\srv\\share\\a.html"))
    }
}
