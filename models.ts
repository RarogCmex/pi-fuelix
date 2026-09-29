/**
 * Catalog → pi `Model` conversion, plus the compat flags for the fuelix.ai
 * gateway.
 *
 * `api.fuelix.ai` matches none of pi-ai's URL auto-detection branches
 * (`api/openai-completions.js` `detectCompat`), so the auto-detected profile is
 * a vanilla-OpenAI one that is wrong here in three places: it would send
 * `store: false` (`supportsStore` autodetects true), it would use the
 * `developer` role (`supportsDeveloperRole` autodetects true, and pi-ai picks
 * it whenever `model.reasoning` is set — `:896`), and it would allow 24 h
 * prompt-cache retention. Every flag below is pinned; the grounded ones cite
 * the probe in `research/2026-09-26-live-verification.md`.
 *
 * Prices are zero on purpose: the gateway publishes none (`catalog.ts`).
 */

import type { Model, ModelCost, OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import {
  CATALOG,
  EXCLUDED_PATTERN,
  UNVERIFIED_FLOOR,
  displayName,
  type CatalogEntry,
  type GatewayApi,
} from "./catalog.ts";

export type { GatewayApi } from "./catalog.ts";

export const PROVIDER_ID = "fuelix";
export const DEFAULT_BASE_URL = "https://api.fuelix.ai/v1";

/**
 * The request field that carries pi's output cap.
 *
 * **Decision: one field, `max_completion_tokens`, for every model on this
 * gateway — with the per-model seam available if a model ever needs the other
 * one.** pi expresses the choice per model (`model.compat.maxTokensField`,
 * resolved by `getCompat` in pi-ai's `api/openai-completions.js` — line offsets
 * omitted on purpose: pi-ai is an unpinned peer, so cite the symbol, not the
 * line). Nothing measured here needs a split, and the 2026-09-26 evidence points
 * the same way:
 *
 *  - `max_completion_tokens` was measured **honoured** (the answer was cut at
 *    the limit, `finish_reason: "length"`) on 11 distinct backends:
 *    `gpt-4o-mini`, `gpt-5.4`, `o4-mini`, `gemini-2.5-flash`,
 *    `deepseek-v4.1-flash`, `clarke-1.0`, `tycho-1.0`, `wasikan-v2-2`,
 *    `gemma-4-26b-a4b-it`, `gpt-oss-20b`, `mistral-large` (probe B, 2026-09-26;
 *    the raw ledger behind it is local-only, not published).
 *  - `gpt-5.4` **silently ignores `max_tokens`** (measured 2026-09-26: 200 for
 *    `max_tokens: 99999999`, and `max_tokens: 8` produced 12 output tokens), so
 *    the legacy field would be the wrong global choice.
 *  - `gpt-4o-mini` *validates both* and `claude-sonnet-5` honours
 *    `max_completion_tokens` (both measured 2026-09-26).
 *
 * So a single global field does **not** break any measured model. What remains
 * unverified is every id nobody probed — 98 listed minus the 23 distinct ids the
 * 2026-09-26 pass touched (listed in
 * `research/2026-09-26-live-verification.md` §3-§5): the field could be ignored on a
 * route that was never exercised (`llama-3.2-90b` answered 403, so it could not
 * be tested at all). § "What remains unverified" in the README records the
 * three-request probe that would settle any one of them.
 *
 * Note where this field is even sent: pi passes `maxTokens` only on the paths
 * that ask for a cap — compaction summarization (`core/compaction/`) and cache
 * warming (`core/cache-warmer.js`) — a normal agent request sends neither field.
 * Modules are named rather than line offsets: pi is an optional peer pinned to
 * `*`, so an offset rots on the next release while the module still resolves.
 */
export const MAX_TOKENS_FIELD: NonNullable<OpenAICompletionsCompat["maxTokensField"]> =
  "max_completion_tokens";

/**
 * pi's `reasoning: true` means "pi can control this model's thinking level", and
 * the picker then offers levels that pi translates into a request parameter.
 *
 * **Decision: `false` for every model.** The gateway accepts `reasoning_effort`
 * — but that tells us nothing:
 *
 *  - `reasoning_effort: "low"` / `"none"` / `"bogus-enum-value"` all returned
 *    **200** on seven backends — `gpt-5.4`, `gemini-2.5-flash`,
 *    `mistral-large`, `clarke-1.0`, `deepseek-v4.1-flash`, `tycho-1.0` and
 *    `claude-haiku-4-5` (probes C/E, 2026-09-26);
 *  - and `"none"` also returned 200 on `gpt-4o-mini`, a model that cannot
 *    reason at all. That control is the point: acceptance is not a signal, the
 *    gateway does not validate the field per model.
 *  - The one place it *is* forwarded to a validating upstream is the o-series
 *    route: `o4-mini` + `reasoning_effort: "none"` → **400** `AzureException
 *    BadRequestError - Unsupported value: 'reasoning_effort' does not support
 *    'none' with this model. Supported values are: 'low', 'medium', 'high', and
 *    'xhigh'.` That is a free rejection and real evidence — of one family's
 *    vocabulary, not of honoring.
 *
 * Declaring `reasoning: true` would make pi *claim* control it cannot
 * demonstrate: a user picking `off`/`minimal` would silently keep paying for the
 * upstream's default reasoning, with nothing observable changing in the answer.
 * A capability flag that makes pi promise what the gateway never confirmed is
 * the failure mode this catalog avoids above all others. Declaring `false`
 * claims nothing: pi sends no
 * reasoning parameter at all and the model runs at the gateway's default effort.
 * `research/2026-09-26-live-verification.md` records the paired-run measurement
 * that would justify turning it on.
 */
export const VERIFIED_REASONING_CONTROL = false;

/**
 * Compatibility flags for the LiteLLM completions surface. Auto-detection would
 * get four of these wrong; each line says what it is grounded on.
 */
export const CHAT_COMPAT: OpenAICompletionsCompat = {
  // Measured honoured on 11 backends (see MAX_TOKENS_FIELD above).
  maxTokensField: MAX_TOKENS_FIELD,
  // Nothing is sent for reasoning (VERIFIED_REASONING_CONTROL is false), so this
  // only pins the fallback shape: a top-level `reasoning_effort` string, which is
  // what the gateway's OpenAI/Azure routes speak. Explicit so a future change of
  // `model.reasoning` cannot silently switch pi-ai to the zai/qwen branches.
  thinkingFormat: "openai",
  supportsReasoningEffort: VERIFIED_REASONING_CONTROL,
  // `system` is measured working on every probe; `developer` is unproven, and
  // auto-detect would let pi-ai emit it for reasoning models (:896).
  supportsDeveloperRole: false,
  // Neither `store` nor 24h prompt-cache retention is documented by the gateway,
  // so pi must not send `store` / `prompt_cache_retention` / `prompt_cache_key`.
  supportsStore: false,
  supportsLongCacheRetention: false,
  // Strict JSON-schema tools are unproven here. pi 0.87 already defaults this
  // to false for an OpenAI-compatible host it does not recognise, so the
  // explicit `false` is belt-and-braces rather than a behaviour change.
  supportsStrictMode: false,
  // Measured: the SSE stream ends with `finish_reason` and a usage chunk when
  // `stream_options.include_usage` is set (probe B read token usage from it).
  supportsUsageInStreaming: true,
  supportsFinishReason: true,
  requiresToolResultName: false,
  requiresAssistantAfterToolResult: false,
  requiresThinkingAsText: false,
  supportsOpenAIGrammarTools: false,
};

const ZERO_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export type FuelixModel = Model<GatewayApi>;

export function entryToModel(entry: CatalogEntry, baseUrl: string): FuelixModel {
  return {
    id: entry.id,
    name: entry.name,
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl,
    reasoning: entry.reasoning,
    input: entry.input,
    cost: { ...ZERO_COST },
    contextWindow: entry.contextWindow,
    maxTokens: entry.maxTokens,
    compat: { ...CHAT_COMPAT },
  } satisfies Model<"openai-completions">;
}

export function buildModels(baseUrl: string): FuelixModel[] {
  return CATALOG.map((entry) => entryToModel(entry, baseUrl));
}

/**
 * Shape for an id this catalog has never seen — a future id surfaced by
 * `GET /v1/models`. Same conservative floor as the rest of the catalog, zero
 * cost, and no reasoning claim: an unknown id's capabilities are unknowable
 * without probing, and overstating them is what makes pi send a request that
 * gets billed instead of compacted.
 */
export const UNKNOWN_MODEL_DEFAULTS = {
  contextWindow: UNVERIFIED_FLOOR.contextWindow,
  maxTokens: UNVERIFIED_FLOOR.maxTokens,
} as const;

export function unknownModelToModel(id: string, baseUrl: string): FuelixModel {
  return entryToModel(
    {
      id,
      name: displayName(id),
      contextWindow: UNKNOWN_MODEL_DEFAULTS.contextWindow,
      maxTokens: UNKNOWN_MODEL_DEFAULTS.maxTokens,
      input: ["text"],
      reasoning: false,
      provenance: "floor",
      priceNote: "unknown fuelix id discovered live; no price or limits are known",
    },
    baseUrl,
  );
}

/** True for an id that must never reach the picker (image/audio/embedding routes). */
export function isNonChatId(id: string): boolean {
  return EXCLUDED_PATTERN.test(id);
}
