package dev.pi.agent.process

import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.project.Project

/**
 * Remembers the user's last selected model per project so the pi process
 * starts on it (`--provider X --model Y`).
 *
 * 051 adds the memory of a provider pi has rejected: it is deliberately
 * **in-memory only**. The stored preference itself is never destroyed — a
 * provider that comes back (the user re-adds it to `models.json`) must find
 * the user's choice intact, so the plugin only stops *using* it while pi says
 * it is gone.
 */
@Service(Service.Level.PROJECT)
class PiModelPreferences(private val project: Project) {

    private val properties: PropertiesComponent get() = PropertiesComponent.getInstance(project)

    fun get(): Pair<String, String>? {
        val provider = properties.getValue(PROVIDER_KEY) ?: return null
        val model = properties.getValue(MODEL_KEY) ?: return null
        if (provider.isBlank() || model.isBlank()) return null
        return provider to model
    }

    fun set(provider: String, model: String) {
        properties.setValue(PROVIDER_KEY, provider)
        properties.setValue(MODEL_KEY, model)
        // The user just picked a model themselves: any earlier rejection is
        // history, not a verdict about this one.
        blocked = null
    }

    /**
     * 051: the provider pi refused to start with (or the preflight found gone).
     *
     * While a provider is blocked the plugin starts pi **without** the model
     * override instead of handing pi a name it does not know. The block wears
     * off after [BLOCK_TTL_MS] so a provider that comes back is picked up
     * again without restarting the IDE.
     */
    fun blockedProvider(): String? {
        val entry = blocked ?: return null
        if (System.currentTimeMillis() - entry.second > BLOCK_TTL_MS) {
            blocked = null
            return null
        }
        return entry.first
    }

    /** Remembers that [provider] must not be passed to pi for now. */
    fun blockProvider(provider: String) {
        blocked = provider to System.currentTimeMillis()
    }

    /** A provider pi refused, and when. Memory only — never persisted. */
    @Volatile
    private var blocked: Pair<String, Long>? = null

    companion object {
        private const val PROVIDER_KEY = "dev.pi.agent.lastProvider"
        private const val MODEL_KEY = "dev.pi.agent.lastModel"

        /** How long a rejected provider stays blocked. */
        private const val BLOCK_TTL_MS = 5 * 60_000L

        @JvmStatic
        fun getInstance(project: Project): PiModelPreferences =
            project.getService(PiModelPreferences::class.java)
    }
}
