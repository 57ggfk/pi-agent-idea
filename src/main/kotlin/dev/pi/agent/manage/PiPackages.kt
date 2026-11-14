package dev.pi.agent.manage

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import dev.pi.agent.process.PiLocator
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.charset.StandardCharsets
import java.time.Duration
import java.util.concurrent.ConcurrentHashMap

/**
 * Package-management plumbing behind the Manage view (spec 033).
 *
 * Everything pi exposes about packages is CLI text plus three standard npm
 * registry endpoints (search, packument, `/latest`). This object owns the
 * pure parts — list parsing, source-name normalization, registry response
 * mapping — and the HTTP adapters around them. All I/O goes through injected
 * fetch lambdas so the degradation logic (endpoint probing, offline preflight)
 * is unit-testable without a network.
 *
 * Evidence base: `specs/033-package-management/evidence/probe-033-packages.log`
 * (P3/P13/P18 `pi list` shapes, P8 broken single-package update, P15/P16/P19
 * registry endpoints).
 */
object PiPackages {

    internal val LOG = com.intellij.openapi.diagnostic.Logger.getInstance(PiPackages::class.java)

    private val json = Json { ignoreUnknownKeys = true }

    // -- pi list parsing -----------------------------------------------------

    /** One configured package as `pi list` reports it. */
    data class Entry(
        val source: String,
        /** "user" | "project" (from the section header; anything else verbatim). */
        val scope: String,
        /** Resolved install path from the indented line under the source. */
        val path: String?,
    ) {
        /**
         * A source line without a path line: either a failed install (pi warns
         * and skips at startup) or a project declaration that is not installed
         * yet — both render as "未安装/文件缺失" with a reinstall action (P13/P18).
         */
        val broken: Boolean get() = path == null
    }

    /**
     * Parses `pi list` output (pi 1.5.0 shape):
     *
     * ```
     * User packages:
     *   npm:openwiki
     *     C:\...\node_modules\openwiki
     * Project packages:
     *   npm:pi-subagents
     * ```
     *
     * Unknown lines are ignored rather than failing the whole panel: a future
     * pi that adds section types must degrade to "less info", never to a blank
     * or broken list. Sources seen before any header count as user scope.
     */
    fun parsePiList(stdout: String): List<Entry> {
        val entries = mutableListOf<Entry>()
        var scope = "user"
        var pending: Entry? = null
        for (raw in stdout.lines()) {
            val line = raw.trimEnd()
            if (line.isBlank()) continue
            if (line == "No packages installed.") return emptyList()
            val indent = raw.indexOfFirst { it != ' ' }
            if (indent < 0) continue
            val content = raw.substring(indent).trim()
            if (content.isEmpty()) continue
            when {
                // Section header: pi 1.5.0 prints "User packages:" /
                // "Project packages:"; a future section type degrades to "less
                // info" instead of turning into a phantom source row.
                indent == 0 && content.endsWith(":") -> {
                    pending?.let { entries += it; pending = null }
                    val text = content.removeSuffix(":").trim()
                    scope = Regex("^(.+?) packages?$").find(text)
                        ?.groupValues?.get(1)?.trim()?.lowercase()
                        ?: text.lowercase()
                }
                // Top-level noise without a colon is never a source.
                indent == 0 -> continue
                indent <= 2 -> {
                    pending?.let { entries += it }
                    pending = Entry(source = content, scope = scope, path = null)
                }
                // The 4-space path line; anything deeper is decoration.
                else -> pending?.let { pending = it.copy(path = content) }
            }
        }
        pending?.let { entries += it }
        return entries
    }

    // -- source / name helpers -------------------------------------------------

    /**
     * npm package name from a source string: `npm:@scope/pkg@1.2.3` → `@scope/pkg`.
     * A version suffix is only stripped when it looks like one — the name itself
     * may contain `@` (scoped packages), so the split happens after the last `/`.
     * Non-npm sources return null.
     */
    fun npmName(source: String): String? {
        if (!source.startsWith("npm:")) return null
        val spec = source.removePrefix("npm:").trim()
        if (spec.isEmpty()) return null
        if (spec.startsWith("@")) {
            val slash = spec.indexOf('/')
            if (slash < 0) return spec
            val rest = spec.substring(slash + 1)
            val at = rest.indexOf('@')
            return if (at > 0 && rest.substring(at + 1).matches(VERSION_SUFFIX)) {
                spec.substring(0, slash + 1) + rest.substring(0, at)
            } else {
                spec
            }
        }
        val at = spec.indexOf('@')
        return if (at > 0 && spec.substring(at + 1).matches(VERSION_SUFFIX)) spec.substring(0, at) else spec
    }

    private val VERSION_SUFFIX = Regex("""^[\w.+-]+$""")

    /**
     * Escapes a scoped name for a registry URL: `@scope/pkg` → `@scope%2Fpkg`
     * (the slash between scope and name is part of the path segment, not a
     * separator). Plain names pass through.
     */
    fun encodeName(name: String): String {
        val slash = name.indexOf('/')
        if (!name.startsWith("@") || slash < 0) return name
        return name.substring(0, slash) + "%2F" + name.substring(slash + 1)
    }

    /**
     * Installed version from the package's resolved directory: reads
     * `<path>/package.json`. Missing file or broken JSON → null ("未知版本");
     * this must never throw into the panel.
     */
    fun readInstalledVersion(path: String?): String? {
        val file = path?.takeIf { it.isNotBlank() }?.let { java.io.File(it, "package.json") } ?: return null
        if (!file.isFile) return null
        return try {
            val parsed = json.parseToJsonElement(file.readText())
            (parsed as? JsonObject)?.get("version")?.let { (it as? JsonPrimitive)?.content?.takeIf { v -> v.isNotBlank() } }
        } catch (_: Exception) {
            null
        }
    }

    // -- registry chain ---------------------------------------------------------

    /** Official npm registry; also the fallback when npm reports nothing. */
    const val DEFAULT_REGISTRY = "https://registry.npmjs.org"

    @Volatile
    private var cachedNpmRegistry: String? = null

    /**
     * Effective registry for metadata (market search, latest check, preflight):
     * explicit override first (already validated by [PiEnvironment.normalizeCustomRegistry]),
     * then what `npm config get registry` reports (cached — the CLI call costs a
     * process spawn), then the official registry. Install/update commands carry
     * an explicit override to npm via `NPM_CONFIG_REGISTRY` instead (FR-017).
     */
    fun registryChain(
        explicitOverride: String?,
        configuredNpm: () -> String? = ::npmConfiguredRegistryCached,
    ): String {
        val explicit = explicitOverride?.takeIf { it.isNotBlank() }
        if (explicit != null) return explicit
        return configuredNpm()?.takeIf { it.isNotBlank() } ?: DEFAULT_REGISTRY
    }

    private fun npmConfiguredRegistryCached(): String? {
        cachedNpmRegistry?.let { return it }
        val npm = PiLocator.locateNpm() ?: return null
        val value = PiEnvironment.npmConfiguredRegistry(npm)
        if (!value.isNullOrBlank()) cachedNpmRegistry = value
        return value
    }

    /** Clears the cached `npm config get registry` value (tests, settings change). */
    internal fun resetRegistryCache() {
        cachedNpmRegistry = null
    }

    /** npm env for install/update children: explicit override only (FR-017). */
    fun registryEnv(explicitOverride: String?): Map<String, String> {
        val explicit = explicitOverride?.takeIf { it.isNotBlank() } ?: return emptyMap()
        return mapOf("NPM_CONFIG_REGISTRY" to explicit)
    }

    // -- HTTP -------------------------------------------------------------------

    /** Outcome of one HTTP probe, shaped for the injected-fetch seams. */
    data class Fetch(
        val status: Int,
        val body: String,
    ) {
        val ok: Boolean get() = status in 200..299
    }

    /**
     * Shared client: connect timeout 4s, requests carry their own total
     * timeout. One instance for every package HTTP call — the preflight must
     * fail fast (≤5s, P5) and the metadata calls stay bounded (FR-009).
     */
    private val client: HttpClient by lazy {
        HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(4)).build()
    }

    /**
     * Default fetch seam: GET [url] with [timeoutSeconds] total. The body is
     * **never truncated** — a truncated packument is unparseable JSON and
     * silently reads as "no data" (npmmirror's `/latest` for openwiki is 55KB
     * of manifest+readme; the search page ~100KB). Servers that ignore the
     * `identity` encoding hint get their gzip unwrapped explicitly, because
     * java.net.http does not decompress on its own.
     */
    fun httpGet(url: String, timeoutSeconds: Long, accept: String? = null): Fetch {
        val builder = HttpRequest.newBuilder()
            .uri(URI.create(url))
            .GET()
            .timeout(Duration.ofSeconds(timeoutSeconds))
            .header("Accept-Encoding", "identity")
        accept?.let { builder.header("Accept", it) }
        val started = System.currentTimeMillis()
        val response = client.send(builder.build(), HttpResponse.BodyHandlers.ofByteArray())
        val body = decodeBody(response.body(), response.headers().firstValue("Content-Encoding").orElse(""))
        LOG.info(
            "pi-packages http: ${response.statusCode()} ${body.length}B " +
                "enc=${response.headers().firstValue("Content-Encoding").orElse("-")} " +
                "in ${System.currentTimeMillis() - started}ms — $url",
        )
        return Fetch(response.statusCode(), body)
    }

    /** UTF-8 decode with an explicit gzip unwrap for servers that force it. */
    internal fun decodeBody(bytes: ByteArray, contentEncoding: String): String {
        val stream = if (contentEncoding.lowercase() == "gzip") {
            try {
                java.util.zip.GZIPInputStream(bytes.inputStream())
            } catch (_: Exception) {
                bytes.inputStream()
            }
        } else {
            bytes.inputStream()
        }
        return stream.use { it.readBytes().toString(Charsets.UTF_8) }
    }

    /**
     * Connectivity preflight against the registry base (FR-008): any response
     * (even 4xx/5xx) proves the network path works; only transport failure
     * means offline. Success is cached briefly so one user action (check →
     * upgrade) does not probe twice.
     */
    data class Preflight(val reachable: Boolean, val code: String)

    private const val PREFLIGHT_TTL_MS = 30_000L
    private val preflightCache = ConcurrentHashMap<String, Pair<Long, Preflight>>()

    fun preflight(
        registry: String,
        now: () -> Long = System::currentTimeMillis,
        fetch: (String, Long) -> Fetch = { url, t -> httpGet(url, t) },
    ): Preflight {
        val cached = preflightCache[registry]
        if (cached != null && now() - cached.first < PREFLIGHT_TTL_MS) return cached.second
        val result = try {
            fetch(registry.trimEnd('/'), 5)
            Preflight(true, "")
        } catch (_: Exception) {
            Preflight(false, "offline")
        }
        if (result.reachable) preflightCache[registry] = now() to result
        return result
    }

    internal fun resetPreflightCache() {
        preflightCache.clear()
    }

    // -- latest version (FR-019) ---------------------------------------------

    data class Latest(
        val version: String?,
        /** "" | "offline" | "auth" | "not-found" | "bad-response" */
        val reason: String,
    )

    /**
     * Latest version of an npm package: `GET /<name>/latest` first (small),
     * full packument (`Accept: install-v1`) as the 404 fallback — Nexus
     * hosted repos have a known `{name}/{version}` endpoint defect
     * (nexus-public #224). 401/403 surfaces as [Latest.reason]="auth" so the
     * UI can explain that an authenticated private registry hides metadata
     * from the plugin while npm itself still works.
     */
    fun latestVersion(
        registry: String,
        name: String,
        fetch: (String, Long) -> Fetch = { url, t -> httpGet(url, t) },
    ): Latest {
        val base = registry.trimEnd('/')
        val encoded = encodeName(name)
        return try {
            val direct = fetch("$base/$encoded/latest", 10)
            if (direct.ok) {
                return Latest(versionOfJson(direct.body, "version"), "")
            }
            if (direct.status == 401 || direct.status == 403) return Latest(null, "auth")
            if (direct.status != 404) return Latest(null, "bad-response")
            // 404: fall back to the packument (works on Nexus hosted repos).
            val packument = fetch("$base/$encoded", 15)
            if (packument.status == 401 || packument.status == 403) return Latest(null, "auth")
            if (!packument.ok) return Latest(null, if (packument.status == 404) "not-found" else "bad-response")
            val doc = runCatching { json.parseToJsonElement(packument.body).jsonObject }.getOrNull()
                ?: return Latest(null, "bad-response")
            val tags = doc["dist-tags"] as? JsonObject
            Latest(tags?.get("latest")?.let { (it as? JsonPrimitive)?.content }, "")
        } catch (_: Exception) {
            Latest(null, "offline")
        }
    }

    private fun versionOfJson(body: String, field: String): String? = try {
        (json.parseToJsonElement(body).jsonObject[field] as? JsonPrimitive)?.content
            ?.takeIf { it.isNotBlank() }
    } catch (_: Exception) {
        null
    }

    // -- market search (FR-005/FR-006/FR-018) -----------------------------------

    /** One gallery card, as mapped from a registry search hit. */
    data class MarketPackage(
        val name: String,
        val version: String,
        val description: String,
        val author: String,
        val downloads: Long,
        val updated: String,
        val badges: List<String>,
        val linkNpm: String,
        val linkRepo: String,
    )

    data class MarketResult(
        val total: Int,
        val packages: List<MarketPackage>,
        /** True when the registry did not understand the `keywords:` filter
         *  and plain-text matching was used (npmmirror, P19). */
        val degraded: Boolean,
        /** "" | "offline" | "auth" | "unavailable" */
        val code: String,
    )

    /** Search mode per registry, cached so paging does not re-probe (FR-018). */
    private enum class SearchMode { KEYWORDS, TEXT, UNAVAILABLE, AUTH }

    private val searchModes = ConcurrentHashMap<String, SearchMode>()

    internal fun resetSearchModes() {
        searchModes.clear()
    }

    private const val GALLERY_KEYWORD = "keywords:pi-package"

    /**
     * Searches the gallery: npm packages tagged `pi-package`, ranked by the
     * registry's own relevance (Q1). Endpoint probing per registry:
     * `keywords:` syntax first; when a registry accepts the route but ignores
     * the filter (npmmirror returns total=0), fall back to plain-text matching
     * ([MarketResult.degraded]); a registry without the endpoint at all
     * (404) or one that requires auth (401/403) reports [MarketResult.code].
     */
    fun marketSearch(
        registry: String,
        query: String?,
        page: Int,
        pageSize: Int,
        fetch: (String, Long) -> Fetch = { url, t -> httpGet(url, t) },
    ): MarketResult {
        val base = registry.trimEnd('/')
        val size = pageSize.coerceIn(1, 50)
        val from = (page.coerceAtLeast(1) - 1) * size
        fun url(mode: SearchMode): String {
            val text = if (mode == SearchMode.KEYWORDS) GALLERY_KEYWORD else "pi-package"
            val needle = listOf(text, query?.trim().takeUnless { it.isNullOrEmpty() })
                .filterNotNull().joinToString(" ")
            val encoded = URLEncoder.encode(needle, StandardCharsets.UTF_8)
            return "$base/-/v1/search?text=$encoded&size=$size&from=$from"
        }

        val mode = searchModes.computeIfAbsent(base) { SearchMode.KEYWORDS }
        if (mode == SearchMode.UNAVAILABLE) return MarketResult(0, emptyList(), false, "unavailable")
        if (mode == SearchMode.AUTH) return MarketResult(0, emptyList(), false, "auth")

        fun attempt(useMode: SearchMode): Pair<Fetch, SearchMode>? = try {
            val response = fetch(url(useMode), 15)
            if (response.status == 401 || response.status == 403) {
                searchModes[base] = SearchMode.AUTH
                null
            } else if (!response.ok) {
                searchModes[base] = SearchMode.UNAVAILABLE
                null
            } else {
                response to useMode
            }
        } catch (_: Exception) {
            // Transport failure: leave the cached mode untouched (could be a
            // temporary outage) and report offline for this request.
            null
        }

        var degraded = false
        if (mode == SearchMode.KEYWORDS) {
            val keywordsHit = attempt(SearchMode.KEYWORDS) ?: run {
                searchModes[base]?.takeIf { it == SearchMode.AUTH }?.let {
                    return MarketResult(0, emptyList(), false, "auth")
                }
                searchModes[base]?.takeIf { it == SearchMode.UNAVAILABLE }?.let {
                    return MarketResult(0, emptyList(), false, "unavailable")
                }
                return MarketResult(0, emptyList(), false, "offline")
            }
            val parsed = parseSearchResponse(keywordsHit.first.body)
            if (parsed.second.isNotEmpty() || query != null) {
                return MarketResult(parsed.first, parsed.second, false, "")
            }
            // keywords: understood by npmjs but not by cnpmcore-family
            // registries, which answer 200 with total=0 (P19). Distinguish by
            // probing plain text once and remembering the more permissive mode.
            degraded = true
        } else {
            degraded = true // cached TEXT mode: this registry ignores keywords:
        }

        val textHit = attempt(SearchMode.TEXT) ?: run {
            searchModes[base]?.takeIf { it == SearchMode.AUTH }?.let {
                return MarketResult(0, emptyList(), false, "auth")
            }
            searchModes[base]?.takeIf { it == SearchMode.UNAVAILABLE }?.let {
                return MarketResult(0, emptyList(), false, "unavailable")
            }
            return MarketResult(0, emptyList(), false, "offline")
        }
        if (searchModes[base] == SearchMode.KEYWORDS) searchModes[base] = SearchMode.TEXT
        val parsed = parseSearchResponse(textHit.first.body)
        return MarketResult(parsed.first, parsed.second, degraded, "")
    }

    /**
     * Maps the npm search document to cards. Pure: a malformed object degrades
     * to missing fields, never a thrown error.
     */
    fun parseSearchResponse(body: String): Pair<Int, List<MarketPackage>> {
        val doc = try {
            json.parseToJsonElement(body).jsonObject
        } catch (_: Exception) {
            return 0 to emptyList()
        }
        val total = (doc["total"] as? JsonPrimitive)?.content?.toIntOrNull() ?: 0
        val objects = doc["objects"] as? kotlinx.serialization.json.JsonArray
            ?: return total to emptyList()
        val packages = objects.mapNotNull { element ->
            val obj = element as? JsonObject ?: return@mapNotNull null
            val hit = obj["package"] as? JsonObject ?: return@mapNotNull null
            val name = hit.string("name") ?: return@mapNotNull null
            val keywords = (hit["keywords"] as? kotlinx.serialization.json.JsonArray)
                ?.mapNotNull { (it as? JsonPrimitive)?.content }
                ?: emptyList()
            val links = hit["links"] as? JsonObject
            val authorField = hit["author"]
            val author = when (authorField) {
                is JsonObject -> authorField.string("name")
                    ?: authorField.string("username")
                    ?: (hit["publisher"] as? JsonObject)?.string("username")
                is JsonPrimitive -> authorField.content
                else -> (hit["publisher"] as? JsonObject)?.string("username")
            } ?: ""
            MarketPackage(
                name = name,
                version = hit.string("version") ?: "",
                description = hit.string("description") ?: "",
                author = author,
                // The search API reports downloads on the object, beside
                // `package` — not inside it (P15 probe sample). cnpmcore
                // registries (npmmirror) expose only `all`, no `monthly` (P19).
                downloads = (obj["downloads"] as? JsonObject)?.let { d ->
                    (d["monthly"] as? JsonPrimitive)?.content?.toLongOrNull()
                        ?: (d["all"] as? JsonPrimitive)?.content?.toLongOrNull()
                } ?: 0L,
                updated = hit.string("date") ?: "",
                badges = badgesOf(keywords),
                linkNpm = links?.string("npm") ?: "https://www.npmjs.com/package/$name",
                // Raw repository values are git schemes (git+https/ssh/scp); a
                // browser needs https or nothing (ERR_UNKNOWN_URL_SCHEME report).
                linkRepo = webRepoUrl(links?.string("repository")) ?: "",
            )
        }
        return total to packages
    }

    /** Gallery type badge from `pi-*` keywords (Q4 default: missing → package). */
    fun badgesOf(keywords: List<String>): List<String> = buildList {
        when {
            "pi-extension" in keywords -> add("extension")
            "pi-skill" in keywords -> add("skill")
            "pi-theme" in keywords -> add("theme")
            "pi-prompt" in keywords -> add("prompt")
            else -> add("package")
        }
    }

    /**
     * Browsable https URL out of a package.json `repository` value. npm hands
     * the raw field over (`git+https://…`, `git://…`, `git+ssh://git@…`, the
     * `github:user/repo` shorthand), and a browser cannot open any of those
     * schemes (ERR_UNKNOWN_URL_SCHEME — real-machine user report). Returns
     * null when the value cannot be turned into an http(s) page, so the card
     * hides the link instead of shipping a dead one.
     */
    fun webRepoUrl(raw: String?): String? {
        var url = raw?.trim().takeUnless { it.isNullOrEmpty() } ?: return null
        val shorthand = Regex("^(github|gitlab|bitbucket):(.+)$").find(url)
        if (shorthand != null) {
            url = "https://${shorthand.groupValues[1]}.com/${shorthand.groupValues[2]}"
        } else if (url.startsWith("git@") && url.contains(':')) {
            // scp form `git@host:path` — no scheme, no browser can open it.
            return null
        }
        url = url.removePrefix("git+")
        url = when {
            url.startsWith("https://") || url.startsWith("http://") -> url
            url.startsWith("git://") -> "https://${url.removePrefix("git://")}"
            url.startsWith("ssh://") -> {
                val body = url.removePrefix("ssh://")
                val host = body.substringBefore('/').substringAfterLast('@')
                val path = body.substringAfter('/', missingDelimiterValue = "")
                if (host.isEmpty() || path.isEmpty()) return null
                "https://$host/$path"
            }
            else -> return null
        }
        url = url.removeSuffix(".git")
        return url
    }

    private fun JsonObject.string(key: String): String? =
        (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
}
