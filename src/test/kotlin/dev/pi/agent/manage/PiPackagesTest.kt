package dev.pi.agent.manage

import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Spec 033: package list parsing, name normalization, registry chain,
 * preflight and the market/latest HTTP adapters. All I/O goes through
 * injected fetchers; the fixtures are the probe outputs from
 * specs/033-package-management/evidence (P3/P13/P15/P19).
 */
class PiPackagesTest {

    private fun fetchOf(status: Int, body: String = ""): PiPackages.Fetch =
        PiPackages.Fetch(status, body)

    // -- parsePiList (T1401) ----------------------------------------------------

    @Test
    fun `parses user scope with path lines`() {
        val out = """
            User packages:
              npm:openwiki
                C:\Users\Administrator\AppData\Local\Temp\pi033-probe\agent\npm\node_modules\openwiki
        """.trimIndent() + "\n"

        val entries = PiPackages.parsePiList(out)

        assertEquals(1, entries.size)
        assertEquals("npm:openwiki", entries[0].source)
        assertEquals("user", entries[0].scope)
        assertEquals("C:\\Users\\Administrator\\AppData\\Local\\Temp\\pi033-probe\\agent\\npm\\node_modules\\openwiki", entries[0].path)
        assertTrue(!entries[0].broken)
    }

    @Test
    fun `parses project scope and flags declared-not-installed entries as broken`() {
        val out = """
            Project packages:
              npm:pi-subagents
        """.trimIndent() + "\n"

        val entries = PiPackages.parsePiList(out)

        assertEquals(1, entries.size)
        assertEquals("project", entries[0].scope)
        assertNull(entries[0].path)
        assertTrue(entries[0].broken, "a source line without a path line is the broken shape (P13/P18)")
    }

    @Test
    fun `parses mixed user and project sections`() {
        val out = """
            User packages:
              npm:openwiki
                C:\agent\npm\node_modules\openwiki
            Project packages:
              npm:pi-subagents
                C:\proj\.pi\node_modules\pi-subagents
        """.trimIndent() + "\n"

        val entries = PiPackages.parsePiList(out)

        assertEquals(2, entries.size)
        assertEquals("user", entries[0].scope)
        assertEquals("project", entries[1].scope)
    }

    @Test
    fun `empty list and empty output parse to nothing`() {
        assertTrue(PiPackages.parsePiList("No packages installed.\n").isEmpty())
        assertTrue(PiPackages.parsePiList("").isEmpty())
        assertTrue(PiPackages.parsePiList("\n\n").isEmpty())
    }

    @Test
    fun `unknown lines are ignored instead of breaking the panel`() {
        val out = """
            Some future section header:
              npm:future
            User packages:
              npm:openwiki
                C:\agent\npm\node_modules\openwiki
            trailing noise without indent
        """.trimIndent() + "\n"

        val entries = PiPackages.parsePiList(out)

        assertEquals(2, entries.size)
        assertEquals("npm:future", entries[0].source)
        assertEquals("some future section header", entries[0].scope)
        assertEquals("npm:openwiki", entries[1].source)
    }

    // -- name helpers (T1402) -----------------------------------------------------

    @Test
    fun `npm name strips prefix and version suffix`() {
        assertEquals("openwiki", PiPackages.npmName("npm:openwiki"))
        assertEquals("@example/pi-tools", PiPackages.npmName("npm:@example/pi-tools@1.0.0"))
        assertEquals("@example/pi-tools", PiPackages.npmName("npm:@example/pi-tools"))
        // A @suffix that is not semver is a dist-tag; the name is still what we want.
        assertEquals("pi-tools", PiPackages.npmName("npm:pi-tools@latest-not"))
        assertNull(PiPackages.npmName("git:github.com/example/repo"))
        assertNull(PiPackages.npmName("./local/path"))
        assertNull(PiPackages.npmName("npm:"))
    }

    @Test
    fun `encode name escapes only the scoped slash`() {
        assertEquals("openwiki", PiPackages.encodeName("openwiki"))
        assertEquals("@scope%2Fpkg", PiPackages.encodeName("@scope/pkg"))
        assertEquals("@a%2Fb-c.d", PiPackages.encodeName("@a/b-c.d"))
    }

    @Test
    fun `installed version reads package json and degrades to null`() {
        val dir = Files.createTempDirectory("pi033-ver").toFile()
        try {
            java.io.File(dir, "package.json").writeText("""{"name":"openwiki","version":"0.9.0"}""")
            assertEquals("0.9.0", PiPackages.readInstalledVersion(dir.absolutePath))

            java.io.File(dir, "package.json").writeText("{ not json")
            assertNull(PiPackages.readInstalledVersion(dir.absolutePath))

            java.io.File(dir, "package.json").delete()
            assertNull(PiPackages.readInstalledVersion(dir.absolutePath))
            assertNull(PiPackages.readInstalledVersion(null))
            assertNull(PiPackages.readInstalledVersion("  "))
        } finally {
            dir.deleteRecursively()
        }
    }

    // -- registry chain (T1405) -----------------------------------------------------

    @Test
    fun `registry chain prefers explicit then npm config then default`() {
        assertEquals(
            "https://registry.example.com",
            PiPackages.registryChain("https://registry.example.com", configuredNpm = { "https://registry.npmmirror.com" }),
        )
        assertEquals(
            "https://registry.npmmirror.com",
            PiPackages.registryChain(null, configuredNpm = { "https://registry.npmmirror.com" }),
        )
        assertEquals(
            PiPackages.DEFAULT_REGISTRY,
            PiPackages.registryChain(null, configuredNpm = { null }),
        )
        assertEquals(
            PiPackages.DEFAULT_REGISTRY,
            PiPackages.registryChain("", configuredNpm = { "  " }),
        )
    }

    @Test
    fun `registry env is injected only for an explicit override`() {
        assertTrue(PiPackages.registryEnv(null).isEmpty())
        assertTrue(PiPackages.registryEnv("  ").isEmpty())
        assertEquals(
            mapOf("NPM_CONFIG_REGISTRY" to "https://registry.example.com"),
            PiPackages.registryEnv("https://registry.example.com"),
        )
    }

    // -- preflight (T1406) -----------------------------------------------------------

    @Test
    fun `preflight fails fast offline and does not cache failures`() {
        PiPackages.resetPreflightCache()
        var calls = 0
        val failing: (String, Long) -> PiPackages.Fetch = { _, _ -> calls++; throw java.net.ConnectException("refused") }

        val first = PiPackages.preflight("https://registry.example.com", fetch = failing)
        assertTrue(!first.reachable && first.code == "offline")

        // A later success must be possible: failures are never cached.
        val ok = PiPackages.preflight("https://registry.example.com", fetch = { _, _ -> calls++; fetchOf(200, "{}") })
        assertTrue(ok.reachable)
        assertTrue(calls >= 2)
    }

    @Test
    fun `preflight caches success within the ttl`() {
        PiPackages.resetPreflightCache()
        var calls = 0
        var clock = 0L
        val fetch: (String, Long) -> PiPackages.Fetch = { _, _ -> calls++; fetchOf(200) }

        assertTrue(PiPackages.preflight("https://registry.example.com", now = { clock }, fetch = fetch).reachable)
        assertTrue(PiPackages.preflight("https://registry.example.com", now = { clock }, fetch = fetch).reachable)
        assertEquals(1, calls, "the second call inside the TTL must reuse the cached success")

        clock = 31_000
        assertTrue(PiPackages.preflight("https://registry.example.com", now = { clock }, fetch = fetch).reachable)
        assertEquals(2, calls, "after the TTL the probe runs again")
    }

    // -- latest version (T1407 groundwork / FR-019) -----------------------------------

    @Test
    fun `latest uses the shorthand endpoint first`() {
        PiPackages.resetSearchModes()
        val fetch: (String, Long) -> PiPackages.Fetch = { url, _ ->
            assertTrue(url.endsWith("/openwiki/latest"), "shorthand must be the primary path, got $url")
            fetchOf(200, """{"name":"openwiki","version":"0.9.0"}""")
        }
        val latest = PiPackages.latestVersion("https://registry.npmjs.org", "openwiki", fetch = fetch)
        assertEquals("0.9.0", latest.version)
        assertEquals("", latest.reason)
    }

    @Test
    fun `latest falls back to the packument dist-tags on 404`() {
        PiPackages.resetSearchModes()
        val fetch: (String, Long) -> PiPackages.Fetch = { url, _ ->
            if (url.endsWith("/latest")) fetchOf(404)
            else fetchOf(200, """{"name":"openwiki","dist-tags":{"latest":"0.9.1"}}""")
        }
        val latest = PiPackages.latestVersion("https://nexus.example.com/repository/npm", "openwiki", fetch = fetch)
        assertEquals("0.9.1", latest.version)
        assertEquals("", latest.reason)
    }

    @Test
    fun `latest maps auth failure and total 404 to explicit reasons`() {
        PiPackages.resetSearchModes()
        val auth = PiPackages.latestVersion("https://nexus.example.com", "pkg", fetch = { _, _ -> fetchOf(401) })
        assertNull(auth.version)
        assertEquals("auth", auth.reason)

        val missing = PiPackages.latestVersion(
            "https://nexus.example.com",
            "pkg",
            fetch = { url, _ -> if (url.endsWith("/latest")) fetchOf(404) else fetchOf(404) },
        )
        assertEquals("not-found", missing.reason)

        val offline = PiPackages.latestVersion("https://nexus.example.com", "pkg", fetch = { _, _ -> throw java.net.ConnectException("x") })
        assertEquals("offline", offline.reason)
    }

    // -- market search mapping (T1410) -------------------------------------------------

    /** Trimmed npm search response (P15 probe sample shape). */
    private val searchSample = """
        {"total":13710,"objects":[
          {"package":{"name":"billion-context","version":"0.1.213",
            "description":"A context-compression plugin","keywords":["context","pi-package"],
            "author":{"name":"ranxianglei"},"date":"2026-11-13T16:02:38.501Z",
            "links":{"repository":"git+https://github.com/ranxianglei/billion-context.git",
                     "npm":"https://www.npmjs.com/package/billion-context"}},
           "downloads":{"monthly":3257276},"searchScore":46.8},
          {"package":{"name":"pi-mcp-extension","version":"1.15.3",
            "description":"MCP extension","keywords":["pi-package","pi","pi-extension"],
            "date":"2026-11-01T00:00:00.000Z","links":{"repository":"git+https://github.com/x/y.git"}}}
        ]}
    """.trimIndent()

    @Test
    fun `search response maps cards and type badges`() {
        val (total, packages) = PiPackages.parseSearchResponse(searchSample)

        assertEquals(13710, total)
        assertEquals(2, packages.size)
        val first = packages[0]
        assertEquals("billion-context", first.name)
        assertEquals("0.1.213", first.version)
        assertEquals("A context-compression plugin", first.description)
        assertEquals("ranxianglei", first.author)
        assertEquals(3257276L, first.downloads)
        assertEquals("2026-11-13T16:02:38.501Z", first.updated)
        assertEquals(listOf("package"), first.badges)
        assertEquals("https://www.npmjs.com/package/billion-context", first.linkNpm)
        // raw `git+https://…git` must come out as a browsable https page link
        assertEquals("https://github.com/ranxianglei/billion-context", first.linkRepo)
        assertEquals(listOf("extension"), packages[1].badges)
    }

    @Test
    fun `malformed search responses degrade to an empty page`() {
        assertEquals(0 to emptyList(), PiPackages.parseSearchResponse("not json"))
        // A total with no objects array is an odd but survivable document.
        assertEquals(5 to emptyList(), PiPackages.parseSearchResponse("""{"total":5}"""))
    }

    @Test
    fun `cnpmcore downloads without monthly fall back to all`() {
        val body = """
            {"total":1,"objects":[{"downloads":{"all":100738},"package":{"name":"pi-subagents",
              "version":"0.88.1","description":"","keywords":["pi-package"],"links":{}}}]}
        """.trimIndent()
        val (total, packages) = PiPackages.parseSearchResponse(body)
        assertEquals(1, total)
        assertEquals(100738L, packages.single().downloads)
    }

    // -- market search degradation (T1411) ----------------------------------------------

    @Test
    fun `keywords syntax falls back to plain text on cnpmcore registries`() {
        PiPackages.resetSearchModes()
        val urls = mutableListOf<String>()
        val fetch: (String, Long) -> PiPackages.Fetch = { url, _ ->
            urls += url
            if (url.contains("keywords%3Api-package") || url.contains("keywords:pi-package")) {
                fetchOf(200, """{"total":0,"objects":[]}""")
            } else {
                fetchOf(200, """{"total":10000,"objects":[${hit("pi-subagents")}]}""")
            }
        }

        val result = PiPackages.marketSearch("https://registry.npmmirror.com", null, 1, 50, fetch = fetch)

        assertTrue(result.degraded, "plain-text fallback must be flagged degraded")
        assertEquals(10000, result.total)
        assertEquals("pi-subagents", result.packages.single().name)
        assertEquals("", result.code)
        // Probe keywords → probe plain text → learn TEXT → execute the real query.
        assertTrue(urls.size == 3, "probe pair + the real query, got $urls")
    }

    @Test
    fun `the degraded mode is cached so paging skips the keywords probe`() {
        PiPackages.resetSearchModes()
        var keywordsCalls = 0
        val fetch: (String, Long) -> PiPackages.Fetch = { url, _ ->
            if (url.contains("keywords%3Api-package") || url.contains("keywords:pi-package")) {
                keywordsCalls++
                fetchOf(200, """{"total":0,"objects":[]}""")
            } else {
                fetchOf(200, """{"total":1,"objects":[${hit("pi-subagents")}]}""")
            }
        }

        PiPackages.marketSearch("https://registry.npmmirror.com", null, 1, 50, fetch = fetch)
        val second = PiPackages.marketSearch("https://registry.npmmirror.com", null, 2, 50, fetch = fetch)

        assertEquals(1, keywordsCalls, "the keywords probe must run once per registry")
        assertEquals(1, second.total)
        assertTrue(second.degraded)
    }

    @Test
    fun `a registry without the search endpoint reports unavailable and caches it`() {
        PiPackages.resetSearchModes()
        var calls = 0
        val fetch: (String, Long) -> PiPackages.Fetch = { _, _ -> calls++; fetchOf(404) }

        val first = PiPackages.marketSearch("https://nexus.example.com/repository/npm-hosted", null, 1, 50, fetch = fetch)
        assertEquals("unavailable", first.code)
        val second = PiPackages.marketSearch("https://nexus.example.com/repository/npm-hosted", null, 1, 50, fetch = fetch)
        assertEquals("unavailable", second.code)
        assertEquals(1, calls, "the unavailable verdict must be cached")
    }

    @Test
    fun `an authenticated registry reports auth`() {
        PiPackages.resetSearchModes()
        val result = PiPackages.marketSearch("https://nexus.example.com/auth", null, 1, 50, fetch = { _, _ -> fetchOf(401) })
        assertEquals("auth", result.code)
    }

    @Test
    fun `a transport failure reports offline for this request`() {
        PiPackages.resetSearchModes()
        val result = PiPackages.marketSearch("https://registry.npmjs.org", null, 1, 50, fetch = { _, _ -> throw java.net.ConnectException("x") })
        assertEquals("offline", result.code)
    }

    @Test
    fun `type filter refines the keywords query server-side and never degrades on empty`() {
        PiPackages.resetSearchModes()
        val seen = mutableListOf<String>()
        val fetch: (String, Long) -> PiPackages.Fetch = { url, _ ->
            seen += java.net.URLDecoder.decode(url.substringAfter("text=").substringBefore("&"), "UTF-8")
            if (seen.size == 1) {
                // The base-dialect probe: npmjs answers with hits → KEYWORDS.
                fetchOf(200, """{"total":13710,"objects":[${hit("billion-context")}]}""")
            } else {
                // A typed/empty answer is a real answer — no fuzzy fallback.
                fetchOf(200, """{"total":0,"objects":[]}""")
            }
        }

        val result = PiPackages.marketSearch("https://registry.npmjs.org", null, 1, 50, type = "extension", fetch = fetch)

        // P21: the type rides as a second keywords: qualifier (server-side AND)…
        assertTrue(seen[1].contains("keywords:pi-package keywords:pi-extension"), "got ${seen[1]}")
        // …and an empty result for a typed filter is a real answer — no fuzzy fallback.
        assertEquals(2, seen.size)
        assertTrue(result.packages.isEmpty())
        assertTrue(!result.degraded)
    }

    @Test
    fun `type filter uses plain text on degraded text-mode registries`() {
        PiPackages.resetSearchModes()
        val seen = mutableListOf<String>()
        val fetch: (String, Long) -> PiPackages.Fetch = { url, _ ->
            seen += java.net.URLDecoder.decode(url.substringAfter("text=").substringBefore("&"), "UTF-8")
            if (url.contains("keywords%3Api-package") || url.contains("keywords:pi-package")) {
                fetchOf(200, """{"total":0,"objects":[]}""")
            } else {
                fetchOf(200, """{"total":2,"objects":[${hit("pi-x")},${hit("pi-y")}]}""")
            }
        }

        val first = PiPackages.marketSearch("https://registry.npmmirror.com", null, 1, 50, type = "extension", fetch = fetch)

        assertTrue(seen[2].startsWith("pi-package pi-extension"), "text mode keeps the type as a plain word, got ${seen[2]}")
        assertTrue(first.degraded)
        assertEquals(2, first.total)
    }

    @Test
    fun `keyword queries ride along in both modes`() {
        PiPackages.resetSearchModes()
        val seen = mutableListOf<String>()
        val fetch: (String, Long) -> PiPackages.Fetch = { url, _ ->
            seen += java.net.URLDecoder.decode(url.substringAfter("text=").substringBefore("&"), "UTF-8")
            if (seen.size == 1) {
                fetchOf(200, """{"total":1,"objects":[${hit("billion-context")}]}""")
            } else {
                fetchOf(200, """{"total":0,"objects":[]}""")
            }
        }
        PiPackages.marketSearch("https://registry.example.com", "mcp", 1, 50, fetch = fetch)

        // The dialect probe runs on the bare keyword first; the user's words
        // ride along in the learned mode's real query.
        assertTrue(seen[0].contains("keywords:pi-package"), "probe is base-only, got ${seen[0]}")
        assertTrue(seen[1].contains("keywords:pi-package mcp"), "keywords mode keeps the user query, got ${seen[1]}")
    }

    // -- repo link normalization (user report: git+https link = ERR_UNKNOWN_URL_SCHEME) --

    @Test
    fun `repo links normalize to browsable https or disappear`() {
        assertEquals("https://github.com/x/y", PiPackages.webRepoUrl("git+https://github.com/x/y.git"))
        assertEquals("https://github.com/x/y", PiPackages.webRepoUrl("git://github.com/x/y"))
        assertEquals("https://github.com/x/y", PiPackages.webRepoUrl("git+ssh://git@github.com/x/y.git"))
        assertEquals("https://github.com/x/y", PiPackages.webRepoUrl("github:x/y"))
        assertEquals("https://gitlab.com/a/b", PiPackages.webRepoUrl("https://gitlab.com/a/b"))
        assertNull(PiPackages.webRepoUrl("git@gitlab.com:a/b.git"))
        assertNull(PiPackages.webRepoUrl("file:///local/repo"))
        assertNull(PiPackages.webRepoUrl("  "))
        assertNull(PiPackages.webRepoUrl(null))
        // The search mapper routes repository values through the normalizer.
        val body = """{"total":1,"objects":[{"package":{"name":"p","version":"1.0.0",
          "description":"","keywords":["pi-package"],
          "links":{"repository":"git+https://github.com/ranxianglei/billion-context.git"}}}]}"""
        assertEquals("https://github.com/ranxianglei/billion-context", PiPackages.parseSearchResponse(body).second.single().linkRepo)
    }

    private fun hit(name: String, version: String = "1.0.0"): String =
        """{"package":{"name":"$name","version":"$version","description":"","keywords":["pi-package"],
            "date":"2026-11-01T00:00:00.000Z","links":{}},"downloads":{"monthly":10}}"""

    // -- body decoding (npmmirror /latest is a 55KB manifest; bodies are never cut) --

    @Test
    fun `plain bodies decode as utf8 and gzip is unwrapped`() {
        val plain = "npmmirror {\"version\":\"0.9.0\"}".toByteArray(Charsets.UTF_8)
        assertEquals("npmmirror {\"version\":\"0.9.0\"}", PiPackages.decodeBody(plain, "identity"))

        val payload = "{\"version\":\"0.9.0\"}".toByteArray(Charsets.UTF_8)
        val gzipped = java.io.ByteArrayOutputStream().also { out ->
            java.util.zip.GZIPOutputStream(out).use { it.write(payload) }
        }.toByteArray()
        assertTrue(PiPackages.decodeBody(gzipped, "gzip").contains("0.9.0"))

        // A gzip claim on non-gzip bytes falls back to the raw stream.
        assertEquals("{\"version\":\"0.9.0\"}", PiPackages.decodeBody(payload, "gzip"))
    }
}
