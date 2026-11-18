plugins {
    id("java")
    id("org.jetbrains.intellij.platform") version "2.10.5"
}

group = "dev.probe"
version = "0.0.1"

repositories {
    mavenCentral()
    intellijPlatform { defaultRepositories() }
}

dependencies {
    intellijPlatform {
        intellijIdeaCommunity("2024.3.1")
    }
}

java { sourceCompatibility = JavaVersion.VERSION_17 }

intellijPlatform {
    pluginConfiguration {
        ideaVersion {
            sinceBuild = "243"
            untilBuild = provider { "243.*" }
        }
    }
}

// Sandbox IDE CDP on 9223 — the user's real WebStorm owns 9222.
tasks {
    runIde {
        jvmArgs("-Dide.browser.jcef.debug.port=9223")
        // skip the Trust Project dialog (CI pattern) — probe project is disposable
        jvmArgs("-Didea.trust.all.projects=true")
        // open the probe project so StartupActivity fires without GUI interaction
        args("D:/code/probe-042/pi-project")
    }
}
