# fuelix.ai — what this build measured (2026-09-26)

Companion to `2026-09-26-recon-handoff.md`. The handoff's **"Already measured"**
table (caps and windows, ≈$1.15 of bought data) was **not re-probed**: those
numbers are used verbatim in `catalog.ts` and labelled as bought. Everything below
is new measurement, and every claim in the README traces to a row here.

Raw evidence (gitignored): `raw/probe-errors.mjs`, `raw/probe-fields.mjs`,
`raw/probe-thinking.mjs`, `raw/probe-reasoning-forward.mjs`,
`raw/probe-effort-none.mjs`, `raw/probe-liveness.mjs`, `raw/cap-probe.mjs`, plus
`raw/part-*-ledger.json`. Committed evidence: `test/fixtures/` (verbatim bodies)
and `test/*.test.ts` (the assertions).

pi 0.87.1, pi-ai 0.87.1, openai SDK 6.40.0, key from `secret.env`.

## 1. Corrections to the handoff

| handoff claim | measurement | consequence |
|---|---|---|
| `POST /v1/responses` → `400 Unknown parameter: 'input'` ("the Responses body shape is not supported") | **`200`** with a full Responses body for `gpt-4o-mini` (model served as `gpt4o_mini_20240718-useast2`, 8 in / 11 out tokens). **This probe was billed** — it was expected to be a free rejection. | `/v1/responses` moves from "checked and absent" to "exists, deliberately not added". Recorded as a correction, not as a contradiction of the handoff's date. |
| "~10 non-chat ids" | **13**: `dall-e-3`, `imagen-3`, `imagen-3-fast`, `imagen-4`, `gemini-3.1-flash-image`, `tts-1`, `tts-1-hd`, `whisper-1`, `text-embedding-3-small`, `text-embedding-3-large`, `text-embedding-ada-002` **+ `gpt-4o-transcribe`, `gpt-4o-transcribe-2025-03-20`** | 98 chat ids registered, 13 excluded by id and by regex. The two transcriptions would otherwise have landed in pi's chat picker. |
| `403` for an unknown model id | reproduced, and **also for a *listed* id**: `llama-3.2-90b` → 403 `Authorization failed for model 'llama-3.2-90b'`. | The listing is an advertisement, not an entitlement list. Both 403s were free (rejections). |

## 2. Error bodies (probe A, all free except the two 200s)

Recorded verbatim into `test/fixtures/error-bodies.json` and replayed offline
through pi-ai's real adapter (`test/errors.test.ts`):

| request | status | body | what pi sees without recovery | with recovery |
|---|---|---|---|---|
| `GET /models` no key / bad key | 401 | RFC 7807: `{"type":"https://httpstatuses.com/401","title":"Unauthorized","detail":["Invalid or missing API key"],…}` | `401 status code (no body)` | `401 Unauthorized: Invalid or missing API key` |
| `POST /chat/completions` `{}` | 400 | `{"detail":"Request body is missing"}` | `400 status code (no body)` | `400 Request body is missing` |
| `POST /chat/completions` model only | 400 | OpenAI envelope: `{"error":{"message":"litellm.BadRequestError: AzureException BadRequestError - Invalid 'messages'…","type":"invalid_request_error",…}}` | `400: {"message":"litellm.BadRequestError: …"}` | `400 litellm.BadRequestError: …` |
| unknown / unentitled model | 403 | OpenAI-ish envelope: `{"error":{"message":"Authorization failed for model 'X'. …","type":"basicllm.schemas.errors.ModelAuthorizationError","param":{"model":"X"},"code":403}}` | `403: {"message":"Authorization failed for model 'X'. …"}` | `403 Authorization failed for model 'X'. …` |
| `POST /completions`, unknown route | 404 | `application/problem+json`: `{"title":"Not Found","detail":["Cannot POST /v1/completions"],…}` | `404 status code (no body)` | `404 Not Found: Cannot POST /v1/completions` |

The mechanism is the SDK's, not the gateway's: the OpenAI SDK composes its message
from the body's `error` key only, and for a JSON body it passes `message =
undefined` (`openai@6.40.0 core/error.js:25-38`) — so an RFC 7807 or `{"detail"}`
body becomes literally "no body". pi-ai then glues a *present* body to the status
as `<status>: <json>` (`pi-ai/dist/utils/error-body.js:111`). Two dialects, two
different failures, both locked as separate tests.

**No 429 was ever observed** on this gateway, so no 429 wording is invented.

## 3. `maxTokensField` (probe B — the technical centre)

Method: one streaming request per (model, field), prompt
`Output the numbers 1 to 20, separated by commas, and nothing else.`, the field
under test set to **8**; a stream aborted client-side after 300 events.
`output <= 8` + `finish_reason: length` ⇒ **honoured**; `output ≈ 20-30` +
`finish_reason: stop` ⇒ **accepted but ignored**; 4xx ⇒ **rejected** (free).

| model | field | status | output tokens | verdict |
|---|---|---|---|---|
| `gpt-4o-mini` | `max_completion_tokens` | 200 | 8 | **HONOURED** |
| `gpt-5.4` (+`reasoning_effort:"low"`) | `max_completion_tokens` | 200 | 8 | **HONOURED** |
| `o4-mini` (+effort) | `max_completion_tokens` | 200 | 8 | **HONOURED** |
| `gemini-2.5-flash` (+effort) | `max_completion_tokens` | 200 | 1 | **HONOURED** |
| `deepseek-v4.1-flash` (+effort) | `max_completion_tokens` | 200 | 8 | **HONOURED** |
| `clarke-1.0` | `max_completion_tokens` | 200 | 8 | **HONOURED** |
| `tycho-1.0` | `max_completion_tokens` | 200 | 8 | **HONOURED** |
| `wasikan-v2-2` | `max_completion_tokens` | 200 | 8 | **HONOURED** (in=6138 — see §6) |
| `gemma-4-26b-a4b-it` | `max_completion_tokens` | 200 | 5 | **HONOURED** |
| `gpt-oss-20b` | `max_completion_tokens` | 200 | 8 | **HONOURED** |
| `mistral-large` | `max_completion_tokens` | 200 | 8 | **HONOURED** |
| `llama-3.2-90b` | both fields | 403 | – | not entitled → unmeasurable |

**Decision: one global `max_completion_tokens`.** No measured model needed
`max_tokens`; the handoff measured that `gpt-5.4` *silently ignores* `max_tokens`,
which is the one failure mode that would matter (an ignored cap looks like a
working request). The choice is expressed per model
(`model.compat.maxTokensField`) and the seam is exercised by
`test/wire-format.test.ts` (one model overridden to `max_tokens`).

Where the field is even sent: a real `pi -p` run put
`max_completion_tokens: 128000` (gpt-5.4) / `16384` (gpt-4o-mini) on the wire — the
catalog cap, because pi-ai's `buildBaseOptions` defaults `maxTokens` to
`model.maxTokens` (`api/simple-options.js:10`). Measured with a throwaway
`before_provider_request` logger; the serialized body contained exactly
`[max_completion_tokens, messages, model, stream, stream_options, tools]` — no
`store`, no `developer` role, no `prompt_cache_key`/`prompt_cache_retention`.

## 4. `reasoning_effort` (probes C/D/E — the reason there is no thinking control)

| probe | result |
|---|---|
| `gpt-4o-mini` + `reasoning_effort:"low"` / `"none"` | 200 (a **control**: this model cannot reason) |
| `gpt-5.4` + `"low"` / `"none"` / `"bogus-enum-value"` | 200 each |
| `gemini-2.5-flash`, `mistral-large`, `clarke-1.0`, `deepseek-v4.1-flash`, `claude-haiku-4-5`, `tycho-1.0` + `"none"` | 200 each |
| `o4-mini` + `"none"` | **400** `AzureException BadRequestError - Unsupported value: 'reasoning_effort' does not support 'none' with this model. Supported values are: 'low', 'medium', 'high', and 'xhigh'.` (free) |

The control is the finding: the gateway answers 200 for `reasoning_effort` on a
model that cannot reason, so **acceptance is not a signal**. Exactly one route
(o-series) proved it forwards the field to a validating upstream. Nothing here
shows that the field *changes* anything, and declaring `reasoning: true` would make
pi offer levels that may silently do nothing while the user pays for the
upstream's default reasoning (pitfalls T5/T26). **Decision: `reasoning: false` and
`supportsReasoningEffort: false` for every model** — pi sends no reasoning
parameter at all, which the catalog-wide wire test asserts for 98 ids × 6 levels.

## 5. Liveness / entitlement (probe F + the failures above)

Cheapest possible accepted request (`max_completion_tokens: 1`):

| id | status | served as |
|---|---|---|
| `gpt-4o` | 200 | `gpt-4o-2024-11-20` |
| `gpt-4.1-mini` | 200 | `gpt-4.1-mini-2025-04-14` |
| `gpt-5-nano` | 200 | `gpt5_nano_20250807-useast2` |
| `gpt-5.6-luna` | 200 | `gpt-5-6-luna-useast2` |
| `gpt-6-sol` | 200 | `gpt-6-sol-uswest` |
| `o3-mini` | 200 | `o3-mini-2025-01-31` |
| `gemini-2.5-flash-lite` | 200 | `gemini-2.5-flash-lite` |
| `cursor-c-sonnet-5` | 200 | `claude-sonnet-5@default` |
| `gpt-5.3-codex` / `-2026-02-24` | **400** | `AzureException - The requested operation is unsupported.` (also with `max_completion_tokens: 16`, so not a cap artifact) |
| `llama-3.2-90b` | **403** | not entitled to this key |

Plus liveness already established by §3/§4 for `gpt-5.4`, `gpt-4o-mini`, `o4-mini`,
`gemini-2.5-flash`, `deepseek-v4.1-flash`, `clarke-1.0`, `tycho-1.0`,
`wasikan-v2-2`, `gemma-4-26b-a4b-it`, `gpt-oss-20b`, `mistral-large`,
`claude-haiku-4-5`, `gpt-5-chat`.

**Not run: a full 98-id sweep.** `wasikan-v2-2` reported **6138 input tokens for a
~30-token body**, i.e. at least one deployment appears to inject a large upstream
prompt; a blind sweep is therefore not priceable from the outside. The harness has
it behind `FUELIX_LIVE_SWEEP=1` so it can be run deliberately, not by accident.

## 6. How to measure a cap without buying it

The handoff's rule (L18/L35) is "prove limits from rejections". For this gateway
that needs one precondition this build did establish: **the route must validate
the field** — `gpt-5.4` accepted `max_tokens: 99999999` with a 200, which is how
the original $1.15 was spent. A safe recipe, in order:

1. Fix the field first (§3): `max_completion_tokens` is honoured everywhere
   measured, `max_tokens` is not.
2. Then send `max_completion_tokens: 99999999` **bound client-side** (streaming
   with an abort guard, `maxTokens ≤ 8` on every other probe). If it is rejected,
   the error discloses the model's real cap for free. If it is *accepted*, it was
   billed — stop and record the cap as unverified.
3. Never bracket a cap with accepted requests: `gpt-4o-mini`'s 16384 was read from
   a rejection, and each acceptance only tells you `N ≤ cap`.

The 32 768 / 16 384 floors in `catalog.ts` exist because steps 2-3 were not
purchased for 92 of the 98 ids. The 16 384 *cap* floor has a second, measured
reason: pi puts `model.maxTokens` on every request (§3), so a smaller floor would
truncate answers.

## 7. Cost ledger (tokens only)

The gateway publishes no price list (`/pricing`, `/key/info`, `/spend/logs`,
`/usage`, `/me` → 404; neither 400 nor 403 bodies disclose a rate) and reports no
per-token cost. **No USD figure is given anywhere in this report or the README:
the currency figure is unavailable.** Tokens are the measurement; the
free/billed split is *observed*, not intended — a probe counts as free only when it
came back 4xx.

### Probes (34 billed calls, plus the rejections)

| probe | billed calls | input tokens | output tokens |
|---|---|---|---|
| A error bodies | 2 (the `/models` 200 is not inference; the `/v1/responses` 200 was **8 in / 11 out**) | 8 | 11 |
| B field matrix (two sweeps) | 11 | 6638 | 78 |
| C `reasoning_effort` acceptance | 3 | 60 | 6 |
| D illegal effort values | 2 | 16 | 4 |
| E `reasoning_effort:"none"` sweep | 8 | 112 | 20 |
| F liveness sweep | 8 | 93 | 4 |
| `gpt-5.3-codex` follow-up (×2, `max_completion_tokens: 16`) | 0 (400) | 0 | 0 |
| **total** | **34** | **6927** | **123** |

`wasikan-v2-2` alone accounts for 6138 of those input tokens (§5).

### `npm run live` (A–G, twice: before and after a display-only fix)

| run | billed calls | input | output |
|---|---|---|---|
| run 1 | 5 | 192 | 39 |
| run 2 (final code) | 5 | 192 | 39 |

### Real `pi -e ./index.ts` runs

| run | tokens |
|---|---|
| `-p --mode json` gpt-4o-mini "reply ok" | 47 in + 3072 cacheRead + 2 out |
| `-p --mode json` gpt-5.4 "reply ok" | 131 in + 3072 cacheRead + 4 out |
| `-p --mode json` claude-sonnet-5 "reply ok" | 2873 in + 0 cacheRead + 1 out |
| `-p` gpt-5.4 / gpt-4o-mini (text mode, first payload-dump runs) | not captured; same request shape as the json runs |
| `-p` gpt-4o-mini with the bash tool | not captured; larger (tool schema + tool result) |
| `--list-models` × 3, error-path runs (bad key, `llama-3.2-90b`, `gpt-5.3-codex`) | 0 — listing and rejections are not billed |

The three json runs also show **this gateway reports prompt-cache hits**
(`cacheRead: 3072` on the two Azure routes, 0 on the Vertex/Anthropic route), which
pi-ai parses natively — the catalog prices them at 0 like everything else.

**Totals:** ≈ 10.4k input + 6.1k cacheRead (captured on the three `--mode json`
runs only; the two text-mode runs are the same request shape but were not captured)
+ ≈ 150 output tokens across every
billed call this build made, plus ~5 non-inference 2xx responses. The stage budget
was "no excess, ≤ $0.05"; with no published price the only honest statement is the
token total above — the single largest line item (6138 tokens) came from a
*deployment that injects a prompt*, not from a deliberately expensive probe.
