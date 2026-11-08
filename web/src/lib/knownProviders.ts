/**
 * Builtin pi providers and the auth methods each supports, mirroring the
 * terminal `/login` method selector: "account" (OAuth) vs API key.
 *
 * Generated from the installed pi 1.4.0 registry
 * (`ModelRuntime.create({allowModelNetwork:false, refreshOnCreate:false}).getProviders()`)
 * — pi has no CLI to enumerate this, so the table is bundled and merged with
 * the live authOverview (models.json customs, stored credentials) at render
 * time. Regenerate when the supported pi floor gains providers.
 */
export interface KnownProvider {
  id: string;
  name: string;
  oauth: boolean;
  apiKey: boolean;
  /** pi's selector label for the OAuth method, e.g. "Sign in with ChatGPT". */
  oauthLabel: string | null;
  subscription: boolean;
}

const p = (
  id: string,
  name: string,
  oauth: boolean,
  oauthLabel: string | null = null,
  subscription = false,
): KnownProvider => ({ id, name, oauth, apiKey: true, oauthLabel, subscription });

export const KNOWN_PROVIDERS: readonly KnownProvider[] = [
  p("amazon-bedrock", "Amazon Bedrock", false),
  p("ant-ling", "Ant Ling", false),
  p("anthropic", "Anthropic", true, "Anthropic (Claude Pro/Max)", true),
  p("azure", "Azure", false),
  p("baseten", "Baseten", false),
  p("cerebras", "Cerebras", false),
  p("cloudflare-ai-gateway", "Cloudflare AI Gateway", false),
  p("cloudflare-workers-ai", "Cloudflare Workers AI", false),
  p("deepseek", "DeepSeek", false),
  p("fireworks", "Fireworks", false),
  p("github-copilot", "GitHub Copilot", true, "GitHub Copilot", true),
  p("google", "Google", false),
  p("google-vertex", "Google Vertex AI", false),
  p("groq", "Groq", false),
  p("huggingface", "Hugging Face", false),
  p("kimi-coding", "Kimi For Coding", true, "Sign in with Kimi Code", true),
  p("meta", "Meta", true, "Sign in with Meta", true),
  p("minimax", "MiniMax", false),
  p("minimax-cn", "MiniMax CN", false),
  p("mistral", "Mistral", false),
  p("moonshotai", "Moonshot AI", false),
  p("moonshotai-cn", "Moonshot AI CN", false),
  p("nvidia", "NVIDIA", false),
  p("openai", "OpenAI", true, "Sign in with ChatGPT", true),
  // Legacy Codex login: OAuth only, no API key method.
  { id: "openai-codex", name: "OpenAI Codex (legacy)", oauth: true, apiKey: false, oauthLabel: "OpenAI (ChatGPT Plus/Pro)", subscription: true },
  p("opencode", "OpenCode Zen", false),
  p("opencode-go", "OpenCode Go", false),
  p("openrouter", "OpenRouter", true, "Sign in with OpenRouter"),
  p("qwen-token-plan", "Qwen Token Plan", false),
  p("qwen-token-plan-cn", "Qwen Token Plan CN", false),
  p("qwen-token-plan-individual", "Qwen Token Plan Individual", false),
  p("radius", "Radius", true, "Radius"),
  p("together", "Together", false),
  p("typesafe", "TypeSafe", false),
  p("vercel-ai-gateway", "Vercel AI Gateway", false),
  p("xai", "xAI", true, "Sign in with SuperGrok or X Premium", true),
  p("xiaomi", "Xiaomi", false),
  p("xiaomi-token-plan-ams", "Xiaomi Token Plan AMS", false),
  p("xiaomi-token-plan-cn", "Xiaomi Token Plan CN", false),
  p("xiaomi-token-plan-sgp", "Xiaomi Token Plan SGP", false),
  p("zai", "Z.AI", false),
  p("zai-coding-cn", "Z.AI Coding CN", false),
];

/** Auth methods a provider offers, resolved for the form's method selector. */
export interface ProviderOption {
  id: string;
  name: string;
  /** True when defined in models.json rather than bundled (not in the table). */
  custom: boolean;
  oauth: boolean;
  apiKey: boolean;
  oauthLabel: string | null;
  /** Stored credential type from auth.json, when one exists. */
  credType: "oauth" | "api_key" | null;
}

/** authOverview payload slice this merge needs (web/src/manage.ts). */
export interface ProviderMergeInput {
  providers?: string[];
  withCredentials?: string[];
  credentialTypes?: Record<string, string>;
}

/** Unknown/absent types degrade to null instead of flowing into the badge. */
function credTypeOf(types: Record<string, string> | undefined, id: string): "oauth" | "api_key" | null {
  const type = types?.[id];
  return type === "oauth" || type === "api_key" ? type : null;
}

/**
 * Space-separated keywords ANDed against name and id, case-insensitive —
 * the same filter contract as the model picker (011 US2). An empty query
 * returns everything in order. The "custom provider" option is pinned by the
 * picker component, not filtered here.
 */
export function filterProviderOptions(
  options: readonly ProviderOption[],
  query: string,
): ProviderOption[] {
  const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (keywords.length === 0) return [...options];
  return options.filter((o) => {
    const hay = `${o.name} ${o.id}`.toLowerCase();
    return keywords.every((k) => hay.includes(k));
  });
}

/**
 * Bundled table ∪ live overview: models.json providers missing from the table
 * join as customs; stored credentials attach configured/credType so rows show
 * a badge and the form can default to the account method for OAuth logins.
 * Sorted by display name, then id.
 */
export function mergeProviderOptions(
  known: readonly KnownProvider[],
  overview: ProviderMergeInput | null | undefined,
): ProviderOption[] {
  const withCreds = new Set(overview?.withCredentials ?? []);
  const options = new Map<string, ProviderOption>();
  for (const k of known) {
    options.set(k.id, {
      id: k.id,
      name: k.name,
      custom: false,
      oauth: k.oauth,
      apiKey: k.apiKey,
      oauthLabel: k.oauthLabel,
      credType: credTypeOf(overview?.credentialTypes, k.id),
    });
  }
  for (const id of overview?.providers ?? []) {
    if (options.has(id)) continue;
    options.set(id, {
      id,
      name: id,
      custom: true,
      oauth: false,
      apiKey: true,
      oauthLabel: null,
      credType: credTypeOf(overview?.credentialTypes, id),
    });
  }
  for (const id of withCreds) {
    const existing = options.get(id);
    if (existing) continue;
    // Credential without a table entry and without models.json (auth.json-only
    // builtin): still selectable, methods unknown → both shown.
    options.set(id, {
      id,
      name: id,
      custom: false,
      oauth: true,
      apiKey: true,
      oauthLabel: null,
      credType: credTypeOf(overview?.credentialTypes, id),
    });
  }
  return [...options.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
}
