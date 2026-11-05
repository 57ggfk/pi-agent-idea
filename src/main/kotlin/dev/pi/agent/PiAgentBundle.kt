package dev.pi.agent

import com.intellij.DynamicBundle
import org.jetbrains.annotations.PropertyKey

/**
 * IDE-side localized strings (spec 008 D7). The bundle follows the IDE
 * language pack — there is deliberately no in-app override for it (the web
 * UI has one, and Options explains the difference). Brand names stay out of
 * the bundle entirely.
 */
private const val BUNDLE = "messages.PiAgentBundle"

object PiAgentBundle : DynamicBundle(BUNDLE) {

    @JvmStatic
    fun message(@PropertyKey(resourceBundle = BUNDLE) key: String, vararg params: Any?): String =
        getMessage(key, *params)
}
