/**
 * Pi Agent plugin — model catalog reload extension.
 *
 * Loaded by the JetBrains plugin via `pi --extension <path>` (spec 016). It
 * exists for one reason: pi re-reads auth.json on its own, but a *models.json*
 * change made while pi runs does not enter the availability snapshot until the
 * runtime is refreshed. An RPC client has no refresh command, so this extension
 * exposes one as a normal pi command and the plugin triggers it through
 * `prompt`.
 *
 * `allowNetwork: false` is deliberate: the trigger always follows a local file
 * write (credentials or models.json), so there is nothing to fetch — and a
 * network probe would make "save key" feel slow or fail offline.
 */
export default function (pi) {
  pi.registerCommand("pi-agent-reload-models", {
    description: "Reload the model catalog (Pi Agent plugin)",
    handler: async (_args, ctx) => {
      await ctx.modelRegistry.refresh({ allowNetwork: false });
    },
  });
}
