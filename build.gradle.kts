import org.jetbrains.intellij.platform.gradle.IntelliJPlatformType

plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "2.4.21"
    id("org.jetbrains.kotlin.plugin.serialization") version "2.4.21"
    id("org.jetbrains.intellij.platform") version "2.10.5"
}

group = "dev.pi"
version = "0.5.2"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

// ---------------------------------------------------------------------------
// IDE dependency: compile against 2024.3.1 (243). That is the COMPILE
// baseline, NOT the lowest supported line — sinceBuild is 233 (2023.3), so
// the compile classpath is newer than what users on 2023.3–2024.2 run. Any
// API added between 233 and 243 therefore compiles here and breaks there,
// which is why pluginVerification below pins the floor and 241 as well; do
// not rely on the compile classpath to catch it. Set ideaPath to a local IDE
// only to run runIde/e2e against your real environment; it is never needed
// for building.
// ---------------------------------------------------------------------------
val localIdeaPath = providers.gradleProperty("ideaPath").orNull?.takeIf { it.isNotBlank() }

dependencies {
        intellijPlatform {
            if (localIdeaPath != null) {
                local(localIdeaPath)
            } else {
                intellijIdeaCommunity("2024.3.1")
            }
            // VCS diff integration (IdeaTextPatchBuilder) lives in this
            // platform module, which is not on the default compile classpath.
            // Present in every IDE across 233–263, so no optional loading is
            // needed. The commit panel itself is reached via public API
            // (VcsDataKeys.COMMIT_WORKFLOW_UI), no internal classes.
            bundledModule("intellij.platform.vcs.impl")
            // JCEF classes (com.intellij.ui.jcef, org.cef) live in the platform on
            // 2024.3 (no bundledPlugin needed); on 2026.2+ they moved to a bundled
            // module, linked at runtime via the optional depends in plugin.xml.
            instrumentationTools()
            // Marketplace-equivalent binary compatibility checks (see
            // intellijPlatform.pluginVerification below).
            pluginVerifier()
        }
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.12.0")
    // Explicit JUnit5 flavor: with Gradle 8.14 the plain kotlin("test")
    // resolves to the JUnit4 variant and the worker dies on missing
    // org.junit.rules.TestRule.
    testImplementation(kotlin("test-junit5"))
    testImplementation("org.junit.jupiter:junit-jupiter:5.11.4")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
    // The IntelliJ platform test framework (auto-added to the Test task by
    // the IPG plugin) initializes its logger via a JUnit5
    // LauncherSessionListener that touches JUnit4 classes; without these on
    // the worker classpath the executor dies before running any test
    // (mirrors cc gui, which carries junit:junit for the same reason).
    testRuntimeOnly("junit:junit:4.13.2")
}

kotlin {
    jvmToolchain(17)
}

java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(17))
    }
}

// ---------------------------------------------------------------------------
// Web UI (React/Vite) build integration: web/dist is served as plugin resources
// ---------------------------------------------------------------------------
val webDist = layout.projectDirectory.dir("web/dist")
// Staging dir whose `webui/` child becomes the resource entry in the jar, so
// server-side lookups use classloader paths like `webui/index.html`.
val webUiStaging = layout.buildDirectory.dir("webui-staging")

// npm on Windows resolves npm.cmd via cmd. On Unix go through a login shell
// so GUI-launched daemons see nvm-installed toolchains (see PiLocator): prefer
// the user's own shell, then zsh, bash, sh — whichever exists.
val isWindows = org.gradle.internal.os.OperatingSystem.current().isWindows
val unixLoginShell: String? = if (isWindows) null else listOf(
    System.getenv("SHELL"),
    "/bin/zsh",
    "/bin/bash",
    "/bin/sh",
).firstOrNull { it != null && File(it).isFile }

val npmInstallCmd = when {
    isWindows -> listOf("cmd", "/c", "npm", "install", "--no-audit", "--no-fund")
    else -> listOf(unixLoginShell ?: "/bin/sh", "-lic", "npm install --no-audit --no-fund")
}
val npmBuildCmd = when {
    isWindows -> listOf("cmd", "/c", "npm", "run", "build")
    else -> listOf(unixLoginShell ?: "/bin/sh", "-lic", "npm run build")
}

val ensureWebUiDeps = tasks.register<Exec>("ensureWebUiDeps") {
    workingDir = layout.projectDirectory.dir("web").asFile
    inputs.file(layout.projectDirectory.file("web/package.json"))
    inputs.file(layout.projectDirectory.file("web/package-lock.json"))
    outputs.dir(layout.projectDirectory.dir("web/node_modules"))
    onlyIf { !file("web/node_modules").exists() }
    commandLine(npmInstallCmd)
}

val buildWebUi = tasks.register<Exec>("buildWebUi") {
    dependsOn(ensureWebUiDeps)
    workingDir = layout.projectDirectory.dir("web").asFile
    inputs.dir(layout.projectDirectory.dir("web/src"))
    inputs.file(layout.projectDirectory.file("web/package.json"))
    inputs.file(layout.projectDirectory.file("web/vite.config.ts"))
    inputs.file(layout.projectDirectory.file("web/index.html"))
    outputs.dir(webDist)
    // Always rebuild: a silent no-op here once shipped a stale UI bundle.
    outputs.upToDateWhen { false }
    commandLine(npmBuildCmd)
    doLast {
        val index = layout.projectDirectory.file("web/dist/index.html").asFile
        require(index.isFile && System.currentTimeMillis() - index.lastModified() < 10 * 60_000) {
            "web/dist/index.html is stale — vite build did not produce a fresh bundle"
        }
    }
}

val syncWebUi = tasks.register<Sync>("syncWebUi") {
    dependsOn(buildWebUi)
    from(webDist)
    into(webUiStaging.map { it.dir("webui") })
}

sourceSets {
    main {
        resources {
            srcDir(webUiStaging)
        }
    }
}

tasks {
    processResources {
        dependsOn(syncWebUi)
    }

    test {
        useJUnitPlatform()
        testLogging {
            events("passed", "failed", "skipped")
        }
    }

    wrapper {
        gradleVersion = "8.14.4"
        distributionType = Wrapper.DistributionType.BIN
    }

    withType<JavaExec>().configureEach {
        // PI_IDE_E2E=/abs/path/to/mock-pi.mjs | "real"  [PI_IDE_E2E_PROJECT=/abs/project]
        // ./gradlew runIde — runs the IDE with JCEF remote debugging (CDP :9222)
        // and an auto-opened tool window. With a mock path the mock pi binary is
        // injected via PI_AGENT_EXECUTABLE; with "real" the user's own pi runs.
        System.getenv("PI_IDE_E2E")?.let { mode ->
            jvmArgs(
                "-Dide.browser.jcef.debug.port=9222",
                "-Dpi.agent.autoOpen=true",
                "-Didea.trust.all.projects=true",
                "-Djb.consents.confirmation.enabled=false",
                // e2e diagnostics: keep plugin INFO logs (pi stderr) in idea.log
                "-Dintellij.console.log.level=all",
            )
            if (mode != "real") {
                environment("PI_AGENT_EXECUTABLE", mode)
            }
            System.getenv("PI_IDE_E2E_PROJECT")?.let { projectPath ->
                args(projectPath)
            }
        }
    }
}

// ---------------------------------------------------------------------------
// CHANGELOG -> Marketplace "What's New" HTML
//
// Marketplace renders change notes as HTML, and HTML collapses raw newlines:
// shipping the Markdown verbatim (what 0.5.1 did) turned the whole section
// into one run-on paragraph. Convert the small Markdown subset used in
// CHANGELOG.md — "- " bullets, "**bold**" sub-headings, `code`, blank lines —
// into the tags the panel actually renders. Takes the file (not the project)
// so it stays callable from a top-level function in this script.
// ---------------------------------------------------------------------------
fun escapeHtml(s: String): String =
    s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

fun inlineHtml(line: String): String =
    escapeHtml(line)
        .replace(Regex("\\*\\*(.+?)\\*\\*"), "<b>$1</b>")
        .replace(Regex("`([^`]+)`"), "<code>$1</code>")

fun changeNotesHtml(changelog: File, version: String): String {
    val lines = changelog.readText()
        .substringAfter("## $version", "")
        .substringBefore("\n## ")
        .lines()
        .drop(1) // the rest of the "## <version> — <date>" heading line

    val out = StringBuilder()
    var inList = false
    fun closeList() {
        if (inList) {
            out.append("</ul>\n")
            inList = false
        }
    }
    for (line in lines) {
        val text = line.trim()
        when {
            text.isEmpty() -> closeList()
            text.startsWith("- ") -> {
                if (!inList) {
                    out.append("<ul>\n")
                    inList = true
                }
                out.append("  <li>").append(inlineHtml(text.removePrefix("- "))).append("</li>\n")
            }
            text.startsWith("**") && text.endsWith("**") -> {
                closeList()
                out.append("<p><b>").append(escapeHtml(text.removeSurrounding("**"))).append("</b></p>\n")
            }
            else -> {
                closeList()
                out.append("<p>").append(inlineHtml(text)).append("</p>\n")
            }
        }
    }
    closeList()
    return out.toString().trim().ifEmpty { "Release $version" }
}

intellijPlatform {
    pluginConfiguration {
        id = "dev.pi.agent"
        name = "Pi Agent"
        version = project.version.toString()
        description = """
            Pi coding agent, embedded in your IDE. Chat with the pi coding agent,
            review its tool calls, manage models, sessions, MCP servers, packages
            and skills — all from a JCEF-based tool window.
        """.trimIndent()
        ideaVersion {
            // Support range mirrors cc gui: 2023.3 .. 2026.3. Compilation
            // targets the LOWEST line (2024.3.1) so newer-API accidents fail
            // the build instead of the users on older IDEs.
            sinceBuild = "233"
            untilBuild = provider { "263.*" }
        }
        // Marketplace change-notes ("What's New"): the topmost CHANGELOG
        // section for the current version (## <version> ... up to the next
        // section), heading line dropped, converted to HTML — see
        // changeNotesHtml() above. Shipping the Markdown as-is rendered as a
        // single run-on paragraph, because HTML collapses newlines.
        changeNotes = provider { changeNotesHtml(file("CHANGELOG.md"), project.version.toString()) }
    }

    pluginVerification {
        // Verify across the RANGE, not just the compile baseline. The baseline
        // is 2024.3.1 (243) while sinceBuild is 233, so any API added between
        // 233 and 243 compiles here and only fails on older IDEs — 0.5.1 shipped
        // exactly that (addBrowseFolderListener(Project, descriptor), 2024.3
        // only) and was rejected by Marketplace for 2024.1 users. The floor and
        // the reported-broken line are pinned so this cannot recur silently.
        ides {
            ide(IntelliJPlatformType.IntellijIdeaCommunity, "2023.3.1") // floor (233)
            ide(IntelliJPlatformType.IntellijIdeaCommunity, "2023.3.8") // last 233 patch
            ide(IntelliJPlatformType.IntellijIdeaCommunity, "2024.1.7") // 241
            ide(IntelliJPlatformType.IntellijIdeaCommunity, "2024.2.6") // 242 — still no 2-arg overload
            ide(IntelliJPlatformType.IntellijIdeaCommunity, "2024.3.1") // compile baseline (243)
        }
        // Marketplace rejection criteria: binary incompatibilities and
        // internal API usage only.
        failureLevel = listOf(
            org.jetbrains.intellij.platform.gradle.tasks.VerifyPluginTask.FailureLevel.COMPATIBILITY_PROBLEMS,
            org.jetbrains.intellij.platform.gradle.tasks.VerifyPluginTask.FailureLevel.INTERNAL_API_USAGES,
        )
    }

    publishing {
        // JetBrains Marketplace credentials. Create the token at
        // plugins.jetbrains.com → profile icon → My Tokens, then either
        //   PI_MARKETPLACE_TOKEN=... ./gradlew publishPlugin
        // or -PpublishToken=... . Channel: "default" for stable releases,
        // any name (e.g. "beta") for pre-releases.
        token = providers.environmentVariable("PI_MARKETPLACE_TOKEN")
            .orElse(providers.gradleProperty("publishToken"))
        channels.add(providers.gradleProperty("publishChannel").orElse("default"))
    }
}
