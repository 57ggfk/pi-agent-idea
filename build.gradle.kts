plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "2.4.21"
    id("org.jetbrains.kotlin.plugin.serialization") version "2.4.21"
    id("org.jetbrains.intellij.platform") version "2.19.0"
}

group = "dev.pi"
version = "0.1.1"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        local(providers.gradleProperty("ideaPath"))
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

val ensureWebUiDeps = tasks.register<Exec>("ensureWebUiDeps") {
    workingDir = layout.projectDirectory.dir("web").asFile
    inputs.file("package.json")
    inputs.file("package-lock.json")
    outputs.dir("node_modules")
    onlyIf { !file("web/node_modules").exists() }
    // Resolve npm through the user's login shell: GUI-launched daemons have a
    // minimal PATH that misses nvm-installed toolchains (see PiLocator).
    commandLine("/bin/zsh", "-lic", "npm install --no-audit --no-fund")
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
    commandLine("/bin/zsh", "-lic", "npm run build")
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
