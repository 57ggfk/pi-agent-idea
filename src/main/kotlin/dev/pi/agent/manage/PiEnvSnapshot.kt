package dev.pi.agent.manage

/**
 * Pure rendering and filtering for the IDE environment snapshot (spec 032).
 *
 * No IDE imports: everything arrives as plain data ([Tier] lists, maps, marker
 * file names), so unit tests can feed fake SDKs and environments without a
 * project — and the hot per-turn re-render never touches an IDE class.
 *
 * The snapshot text is consumed twice: by the pi-env extension (appended to
 * pi's system prompt each turn) and by the manage panel's read-only viewer.
 * It is written for the model first: flat facts, explicit tiers, a collection
 * timestamp (FR-007) so the model can judge staleness.
 */
object PiEnvSnapshot {

    /** One collected tier: where the facts came from and what they say. */
    data class Tier(val tier: String, val title: String, val lines: List<String>)

    /**
     * Environment variable names whose value may enter the snapshot (FR-006
     * whitelist). Everything else stays out even if harmless-looking: the
     * environment is full of one-off variables nobody audited.
     */
    val ENV_WHITELIST: Set<String> = setOf(
        "JAVA_HOME",
        "GRADLE_HOME",
        "MAVEN_HOME",
        "M2_HOME",
        "GRADLE_USER_HOME",
        "VIRTUAL_ENV",
        "ANDROID_HOME",
        "NODE_ENV",
        "NODE_OPTIONS",
        "NODE_EXTRA_CA_CERTS",
        "JAVA_TOOL_OPTIONS",
        "MAVEN_OPTS",
        "NVM_DIR",
        "PIP_INDEX_URL",
    )

    /**
     * Second gate (FR-006): a name that even LOOKS like a credential is
     * dropped even if it sits on the whitelist — one audit slip in the list
     * above must not leak a secret into the prompt (US6, P0).
     */
    private val NAME_BLACKLIST = Regex("(?i)token|secret|password|passwd|key|credential|auth")

    /** Long values are truncated: the snapshot is context, not an env dump. */
    private const val MAX_VALUE_LENGTH = 120

    /**
     * Whitelist + blacklist double filter for environment variables that may
     * enter the snapshot text (and thus the prompt and the manage viewer).
     * `JAVA_HOME` survives; a hypothetical `GITHUB_TOKEN` or `DB_PASSWORD`
     * never does (US6).
     */
    fun filterEnvVars(all: Map<String, String>): Map<String, String> =
        all.entries
            .filter { (name, _) -> name in ENV_WHITELIST && !NAME_BLACKLIST.containsMatchIn(name) }
            .associate { (name, value) ->
                name to if (value.length > MAX_VALUE_LENGTH) value.take(MAX_VALUE_LENGTH) + "…" else value
            }

    /**
     * The same whitelist gate used when ADDING variables to the pi subprocess
     * (FR-005): the additions are diff-only, so the caller keeps variables the
     * process already has. Blacklist applies here too — a whitelisted name
     * that trips the credential pattern is never forwarded either. Values are
     * NOT truncated here: the subprocess needs the real value, unlike the
     * snapshot text.
     */
    fun whitelistAdditions(current: Map<String, String>, source: Map<String, String>): Map<String, String> =
        source
            .filterKeys { name -> name in ENV_WHITELIST && !NAME_BLACKLIST.containsMatchIn(name) }
            .filterKeys { it !in current }

    /**
     * Command suggestions (Q5-b) derived ONLY from marker-file presence at the
     * project root — never from build-tool internal models (spec 禁令).
     */
    fun suggestedCommands(markers: Collection<String>): List<String> = buildList {
        if ("pom.xml" in markers) {
            add("Build: mvn -q -DskipTests package")
            add("Test: mvn -q test")
        }
        if (markers.any { it == "build.gradle.kts" || it == "build.gradle" }) {
            add("Build: ./gradlew build")
            add("Test: ./gradlew test")
        }
        if ("package.json" in markers) {
            add("Install dependencies: npm install")
            add("Test: npm test")
        }
        if (markers.any { it == "requirements.txt" || it == "pyproject.toml" }) {
            add("Install dependencies: pip install -r requirements.txt")
        }
    }

    /**
     * Renders the snapshot. `tiers` arrives already filtered; the text is
     * English on purpose — it is read by the model, and the UI viewer shows it
     * verbatim as debugging material.
     *
     * With no tiers at all the snapshot degrades to an explicit "nothing was
     * detected" block instead of throwing (FR-001) — pi still gets a stable,
     * honest answer about the environment rather than silence or an error.
     */
    fun render(collectedAt: String, tiers: List<Tier>, commands: List<String>): String {
        val header = buildString {
            appendLine("# IDE environment snapshot")
            appendLine("Provided by the Pi Agent JetBrains plugin. Collected: $collectedAt.")
            val sources = if (tiers.isEmpty()) "none detected" else tiers.joinToString(", ") { it.tier }
            appendLine("Sources present: $sources.")
            appendLine("Pick the JDK / interpreter / package manager from these facts when you run or build anything.")
        }
        val body = if (tiers.isEmpty()) {
            buildString {
                appendLine()
                appendLine(
                    "No IDE environment facts were detected " +
                        "(no project SDK, no build-relevant environment variables, no language-specific plugins).",
                )
            }
        } else {
            buildString {
                appendLine()
                tiers.forEach { tier ->
                    appendLine("## ${tier.title} (tier: ${tier.tier})")
                    tier.lines.forEach { appendLine("- $it") }
                    appendLine()
                }
                if (commands.isNotEmpty()) {
                    appendLine("## Suggested commands (tier: derived)")
                    commands.forEach { appendLine("- $it") }
                    appendLine()
                }
            }
        }
        return header + body
    }
}
