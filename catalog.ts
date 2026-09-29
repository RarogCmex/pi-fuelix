/**
 * Curated catalog for the **fuelix.ai** gateway (`https://api.fuelix.ai/v1`).
 *
 * Engine: LiteLLM in front of several upstreams — Azure OpenAI (`gpt-*`),
 * Vertex/Anthropic (`claude-*`, `msg_vrtx_…` ids), Google (`gemini-*`) and
 * assorted third-party deployments (`wasikan-*`, `luminate-*`, `tycho-*`, vLLM
 * for `clarke-1.0`). Provenance, in the order the numbers were bought:
 *
 *  - **Caps and windows for three models are measured** (a prior private
 *    measurement, 2026-09-26; raw output not published). That measurement
 *    cost real money (two probes were *accepted* at 411k and 210k input tokens),
 *    which is why nothing in that set is re-probed here.
 *  - **Everything else in this file is a conservative floor, marked as such.**
 *    The gateway publishes no per-model metadata and its listing carries none —
 *    `GET /v1/models` returns `{id, object, created, owned_by}` and nothing
 *    else (recorded verbatim in `test/fixtures/models-listing.json`). The floor
 *    is 32 768 / 16 384 (`UNVERIFIED_FLOOR` below) so pi compacts *before* an
 *    over-context request is sent instead of after it is billed — an early
 *    compaction is recoverable, an over-context request is not.
 *  - **No price exists anywhere.** `/pricing`, `/key/info`, `/spend/logs`,
 *    `/usage` are 404 and no body discloses a rate (probed 2026-09-26). The rule
 *    this catalog follows is: an unknown price is published as zero plus a note,
 *    never guessed. Every
 *    `cost` is therefore zero with a `priceNote` — a plausible-looking wrong
 *    number is worse than $0.00.
 *
 * What was measured directly on 2026-09-26 (`research/2026-09-26-live-verification.md`)
 * is the *request field* behaviour, not the caps: `max_completion_tokens` is
 * honoured on 11 distinct backends, and `reasoning_effort` cannot be shown to
 * control anything — see `models.ts` for both decisions.
 */

/**
 * The gateway speaks OpenAI chat-completions. `POST /v1/messages` and
 * `POST /v1/responses` exist as well but are deliberately not registered — see
 * README § Surfaces.
 */
export type GatewayApi = "openai-completions";

/** Human-readable name for a gateway id. Cosmetic only; the id is the contract. */
export function displayName(id: string): string {
  const TOKENS: Record<string, string> = { gpt: "GPT", oss: "OSS", a4b: "A4B", it: "IT", e: "E" };
  return id
    .split(/[-_]+/)
    .filter(Boolean)
    .map((token) => {
      const mapped = TOKENS[token.toLowerCase()];
      if (mapped) return mapped;
      if (/^\d+b$/i.test(token)) return `${token.slice(0, -1)}B`;
      return token[0].toUpperCase() + token.slice(1);
    })
    .join("-");
}

export interface CatalogEntry {
  /** Exact gateway model id (case-sensitive, slashes are not used by this gateway). */
  id: string;
  name: string;
  /**
   * `contextWindow` is the **input admission limit** pi compares
   * `usage.input + usage.cacheRead` against when it decides to compact. For
   * `gpt-5.4` the measured figure is the *deployment's* configured input limit
   * (922 000), which is larger than the model's advertised window — labelled
   * here rather than silently called a "context window".
   */
  contextWindow: number;
  /** Output cap (`max_completion_tokens`). `UNVERIFIED_FLOOR` unless measured. */
  maxTokens: number;
  /** pi input modalities. Only `text` is verified for every model (see README). */
  input: ("text" | "image")[];
  /**
   * pi shows thinking levels when this is true. **False for every model on this
   * gateway** — not because the models cannot reason, but because no reasoning
   * *control* could be verified; see `models.ts` `VERIFIED_REASONING_CONTROL`.
   */
  reasoning: boolean;
  /** Whether the numbers above were bought or are a deliberate floor. */
  provenance: "measured" | "floor";
  /** Human-readable caveat; pi's `Model` has no notes field. */
  priceNote: string;
}

/**
 * The 13 listed ids that are **not chat models**: image generation
 * (`dall-e-3`, `imagen-*`, `gemini-3.1-flash-image`), speech
 * (`tts-1`, `tts-1-hd`, `whisper-1`, `gpt-4o-transcribe*`) and embeddings
 * (`text-embedding-*`). They are state 2 of the README's three-state surface
 * table: *exists, deliberately not added*. Source: the recorded
 * `GET /v1/models` listing of 2026-09-26 (111 ids, of which 13 are these).
 *
 * The handoff expected "~10 non-chat" ids; the listing shows 13 — the two
 * extra are `gpt-4o-transcribe` and its dated form, which are also audio
 * models. Correcting the count matters because a discovery overlay that
 * re-added them would put speech models in pi's chat picker.
 */
export const NON_CHAT_IDS: readonly string[] = [
  "dall-e-3",
  "gemini-3.1-flash-image",
  "gpt-4o-transcribe",
  "gpt-4o-transcribe-2025-03-20",
  "imagen-3",
  "imagen-3-fast",
  "imagen-4",
  "text-embedding-3-small",
  "text-embedding-3-large",
  "text-embedding-ada-002",
  "tts-1",
  "tts-1-hd",
  "whisper-1",
];

/**
 * Belt-and-braces filter for ids discovered live that are not in the frozen
 * listing (a new image/audio/embedding endpoint). Applied at parse time and in
 * the overlay, so a non-chat id can never reach pi's picker.
 */
export const EXCLUDED_PATTERN =
  /(?:^|[-_/])(embedding|embed|whisper|tts|transcribe|dall-e|imagen|rerank|moderation|guard)(?:$|[-_/])|(?:^|[-_/])image(?:$|[-_/])|audio|sora|veo/i;

/**
 * Window and output cap for every model whose limits were **not** measured.
 *
 * The window is deliberately small (32 768): an early compaction is recoverable,
 * an over-context request is billed. The cap is deliberately *not* smaller than
 * 16 384, and that number needs defending because the cap is not passive —
 * pi-ai's `buildBaseOptions` (`api/simple-options.js:10`) defaults `maxTokens`
 * to `model.maxTokens` and the adapter then puts it on the wire
 * (`max_completion_tokens`), so this value caps **every** answer from an
 * unmeasured model:
 *
 *  - 16 384 is pi's own default for a provider definition that declares no cap
 *    (`core/provider-composer.js:94`), so it is the value pi would have used had
 *    this plugin declared nothing;
 *  - a lower value (4 096 is a plausible-looking floor, and other gateways do
 *    use it) silently truncates long answers — pi then sees `finish_reason: length`
 *    and may spend
 *    a compact-and-retry attempt (`isRecoverableLength`) on it;
 *  - the failure mode of a value that is too *large* is a free pre-inference
 *    rejection when the route validates the field (it does for `gpt-4o-mini`,
 *    measured 2026-09-26), not a silent charge — the charge tracks the tokens
 *    actually generated, never the ceiling.
 *
 * Replacing a floor with a measurement is described in
 * `research/2026-09-26-live-verification.md` ("How to measure a cap without
 * buying it").
 */
export const UNVERIFIED_FLOOR = {
  contextWindow: 32_768,
  maxTokens: 16_384,
  provenance: "floor" as const,
};

/**
 * The models whose caps were bought (a prior private measurement, 2026-09-26;
 * never re-probed here, and the raw ledgers are not published). Dated aliases of
 * a measured id share its numbers because the gateway serves them with the *same*
 * deployment — verified for two of them on 2026-09-26: `gpt-4o-mini` answered as
 * `gpt-4o-mini-2024-07-18` and `gpt-5.4` as `gpt-5.4-2026-03-05`, and
 * `cursor-c-sonnet-5` answered as `claude-sonnet-5@default`. The `served_as`
 * values quoted in the `source` strings below are the evidence; the transcripts
 * they came from are local-only.
 */
const MEASURED: Record<string, { contextWindow: number; maxTokens: number; source: string }> = {
  "gpt-5.4": {
    contextWindow: 922_000, // deployment INPUT ADMISSION limit ("Input tokens exceed the configured limit of 922000 tokens")
    maxTokens: 128_000,
    source: "prior private measurement 2026-09-26 (bought): cap 128000, input limit 922000; `max_tokens` is silently ignored",
  },
  "gpt-5.4-2026-03-05": {
    contextWindow: 922_000,
    maxTokens: 128_000,
    source: "same deployment as gpt-5.4 (served_as=gpt-5.4-2026-03-05, probe B 2026-09-26)",
  },
  "claude-sonnet-5": {
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    source: "prior private measurement 2026-09-26 (bought, Vertex route; `max_tokens` accepted numerically but not upper-validated)",
  },
  "cursor-c-sonnet-5": {
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    source: "alias: served_as=claude-sonnet-5@default (probe F 2026-09-26), so it inherits the measured claude-sonnet-5 route",
  },
  "gpt-4o-mini": {
    contextWindow: 128_000,
    maxTokens: 16_384,
    source: "prior private measurement 2026-09-26 (bought): cap 16384, window 128000, both fields validated",
  },
  "gpt-4o-mini-2024-07-18": {
    contextWindow: 128_000,
    maxTokens: 16_384,
    source: "same deployment as gpt-4o-mini (served_as=gpt-4o-mini-2024-07-18, probe B/C/E 2026-09-26)",
  },
};

const PRICE_NOTE =
  "fuelix publishes no price list and reports no per-token cost; window/cap are an unverified estimate (see catalog.ts UNVERIFIED_FLOOR)";

/**
 * The 98 chat ids `GET /v1/models` lists, frozen from the recorded listing
 * (`test/fixtures/models-listing.json`, whose `owned_by` account id is scrubbed —
 * the ids are verbatim). `test/catalog.test.ts` asserts this array plus
 * `NON_CHAT_IDS` equals the fixture exactly, so a listing change is caught by the
 * offline suite instead of silently drifting.
 */
export const LISTED_CHAT_IDS: readonly string[] = [
  "c-haiku-4-5", "clarke-1.0", "claude-3-5-haiku", "claude-3-5-haiku-20241022",
  "claude-3-7-sonnet", "claude-3-7-sonnet-20250219", "claude-4-sonnet", "claude-haiku",
  "claude-haiku-4", "claude-haiku-4-5", "claude-haiku-4-5-20251001", "claude-opus",
  "claude-opus-4-8", "claude-opus-5", "claude-opus-5-0", "claude-opus-5-5", "claude-sonnet",
  "claude-sonnet-4", "claude-sonnet-4-20250514", "claude-sonnet-4-5",
  "claude-sonnet-4-5-20250929", "claude-sonnet-4-5-bedrock", "claude-sonnet-4-6",
  "claude-sonnet-4-legacy", "claude-sonnet-5", "cursor-c-3-7-sonnet", "cursor-c-4-sonnet",
  "cursor-c-sonnet-4-6", "cursor-c-sonnet-5", "deepseek-v4.1-flash", "gemini-2.5-flash",
  "gemini-2.5-flash-ca", "gemini-2.5-flash-lite", "gemini-2.5-pro", "gemini-2.5-pro-ca",
  "gemini-3-flash", "gemini-3-flash-preview", "gemini-3-pro", "gemini-3-pro-preview",
  "gemini-3.1-flash-lite", "gemini-3.1-flash-lite-preview", "gemini-3.1-pro",
  "gemini-3.1-pro-preview", "gemini-3.5-flash", "gemini-3.5-flash-lite", "gemini-3.6-flash",
  "gemini-3.7-flash", "gemini-3.8-flash", "gemma-4-26b-a4b-it", "gemma-4-31b-it", "gemma-4-saif",
  "gemma-4-saif-kidc", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-mini-canada", "gpt-4o",
  "gpt-4o-2024-05-13", "gpt-4o-2024-05-13-content-filter", "gpt-4o-2024-08-06", "gpt-4o-mini",
  "gpt-4o-mini-2024-07-18", "gpt-4o-mini-ca-east", "gpt-5", "gpt-5-2025-08-07", "gpt-5-chat",
  "gpt-5-chat-2025-08-07", "gpt-5-mini", "gpt-5-mini-2025-08-07", "gpt-5-nano",
  "gpt-5-nano-2025-08-07", "gpt-5.2-2025-12-11", "gpt-5.2-chat", "gpt-5.2-chat-2025-12-11",
  "gpt-5.3-codex", "gpt-5.3-codex-2026-02-24", "gpt-5.4", "gpt-5.4-2026-03-05", "gpt-5.4-mini",
  "gpt-5.4-nano", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-6-luna", "gpt-6-sol", "gpt-oss-20b",
  "llama-3.2-90b", "luminate-gemma-4-saif", "luminate-np-gpt-5.4-nano", "mistral-large",
  "mistral-large-24.02", "mistral-large-24.11", "mistral-small-3.2-24b", "o3-mini", "o4-mini",
  "translategemma-27b", "tycho-1.0", "wasikan-llama-3-3-70b", "wasikan-qwen-3-next-80b",
  "wasikan-v2-2",
];

export const CATALOG: readonly CatalogEntry[] = LISTED_CHAT_IDS.map((id) => {
  const measured = MEASURED[id];
  return {
    id,
    name: displayName(id),
    contextWindow: measured?.contextWindow ?? UNVERIFIED_FLOOR.contextWindow,
    maxTokens: measured?.maxTokens ?? UNVERIFIED_FLOOR.maxTokens,
    input: ["text"],
    reasoning: false, // see models.ts VERIFIED_REASONING_CONTROL
    provenance: measured ? "measured" : "floor",
    priceNote: measured ? `measured caps — ${measured.source}` : PRICE_NOTE,
  };
});

export const CATALOG_BY_ID: ReadonlyMap<string, CatalogEntry> = new Map(
  CATALOG.map((entry) => [entry.id, entry]),
);

/** Exported for the README's provenance test: which ids carry bought numbers. */
export const MEASURED_IDS: readonly string[] = Object.keys(MEASURED);
