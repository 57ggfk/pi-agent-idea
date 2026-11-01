plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "2.4.21"
    id("org.jetbrains.kotlin.plugin.serialization") version "2.4.21"
    id("org.jetbrains.intellij.platform") version "2.19.0"
}

group = "dev.pi"
version = "0.2.1"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

// ---------------------------------------------------------------------------
// IDE dependency: prefer a local IntelliJ install (ideaPath property or per-OS
// auto-detection); fall back to the remote Community artifact so any machine —
// CI included — can build without an IDE installed.
// ---------------------------------------------------------------------------
fun File.isIdeaInstall(): Boolean = when {
    name.endsWith(".app") && resolve("Contents").isDirectory -> true
    else -> listOf("bin/idea64.exe", "bin/idea.sh").any { resolve(it).isFile }
}

fun detectLocalIdea(): String? {
    val home = System.getProperty("user.home")
    val os = org.gradle.internal.os.OperatingSystem.current()
    val candidates = mutableListOf<String>()
    when {
        os.isWindows -> {
            val localAppData = System.getenv("LOCALAPPDATA") ?: "$home\\AppData\\Local"
            val programFiles = System.getenv("ProgramFiles") ?: "C:\\Program Files"
            candidates += listOf(
                "$localAppData\\Programs\\IntelliJ IDEA",
                "$localAppData\\Programs\\IntelliJ IDEA Ultimate",
                "$programFiles\\JetBrains\\IntelliJ IDEA",
            )
            File("$localAppData\\JetBrains\\Toolbox\\apps").takeIf { it.isDirectory }
                ?.walkTopDown()?.maxDepth(3)
                ?.filter { it.isIdeaInstall() }
                ?.forEach { candidates += it.absolutePath }
        }
        os.isMacOsX -> candidates += listOf(
            "/Applications/IntelliJ IDEA.app",
            "$home/Applications/IntelliJ IDEA.app",
        )
        else -> {
            candidates += listOf("/opt/idea", "$home/idea")
            File("$home/.local/share/JetBrains/Toolbox/apps").takeIf { it.isDirectory }
                ?.walkTopDown()?.maxDepth(3)
                ?.filter { it.isIdeaInstall() }
                ?.forEach { candidates += it.absolutePath }
            File("/snap").takeIf { it.isDirectory }
                ?.listFiles { f -> f.name.startsWith("intellij-idea") }
                ?.forEach { candidates += it.absolutePath }
            // WSL: a Windows-side IDEA (mounted at /mnt/c) is fine for
            // building the plugin; runIde from WSL is not supported.
            val inWsl = File("/proc/version").takeIf { it.isFile }
                ?.readText()?.lowercase()?.contains("microsoft") == true
            if (inWsl) {
                File("/mnt/c/Program Files/JetBrains").takeIf { it.isDirectory }
                    ?.listFiles { f -> f.name.startsWith("IntelliJ IDEA") }
                    ?.forEach { candidates += it.absolutePath }
                File("/mnt/c/Users").takeIf { it.isDirectory }
                    ?.listFiles { f -> f.isDirectory }
                    ?.forEach { user ->
                        candidates += "${user.absolutePath}/AppData/Local/Programs/IntelliJ IDEA"
                    }
            }
        }
    }
    return candidates.firstOrNull { File(it).isIdeaInstall() }
}

val explicitIdeaPath = providers.gradleProperty("ideaPath")
val localIdeaPath = explicitIdeaPath.orNull ?: detectLocalIdea()
if (explicitIdeaPath.isPresent) {
    val p = explicitIdeaPath.get()
    if (!File(p).isIdeaInstall()) {
        logger.warn("ideaPath='$p' does not look like an IntelliJ install (expected bin/idea64.exe, bin/idea.sh, or a .app bundle) — the build may fail.")
    }
} else if (localIdeaPath == null) {
    logger.lifecycle("No local IntelliJ IDEA found — falling back to remote intellijIdeaCommunity 2026.2 (first build downloads ~1 GB). Set ideaPath in gradle.properties to pin a local install.")
}

dependencies {
    intellijPlatform {
        if (localIdeaPath != null) {
            local(providers.provider { localIdeaPath })
        } else {
            intellijIdeaCommunity("2026.2")
        }
        // JCEF ships as a bundled plugin on 2026.2; its classes (com.intellij.ui.jcef, org.cef)
        // must be on the compile classpath explicitly.
        bundledPlugin("com.intellij.modules.jcef")
    }
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.12.0")
    testImplementation(kotlin("test"))
    testImplementation("org.junit.jupiter:junit-jupiter:5.11.4")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

kotlin {
    jvmToolchain(21)
}

java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(21))
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
        gradleVersion = "9.8.2"
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
            sinceBuild = "262"
            untilBuild = provider { "262.*" }
        }
    }
}
