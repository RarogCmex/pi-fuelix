# pi-fuelix

A provider plugin for [pi](https://github.com/earendil-works/pi)
(`@earendil-works/pi-coding-agent`, the coding agent this plugs into) targeting the
**fuelix.ai** gateway (`https://api.fuelix.ai/v1`) — a LiteLLM proxy in front of
Azure OpenAI (`gpt-*`), Vertex/Anthropic (`claude-*`, `msg_vrtx_…` ids), Google
(`gemini-*`) and assorted deployments (`wasikan-*`, `luminate-*`, `clarke-1.0` on
vLLM, …). npm name: `@rarogcmex/pi-fuelix`. It registers the `fuelix` provider
with the gateway's **98 chat ids** (of 111 listed — the other 13 are image, audio
and embedding models), `/login`, a live `/v1/models` overlay and an error layer
for the gateway's particular failure dialects.

Everything a claim rests on was probed against the live gateway on **2026-09-26**
(pi 0.87.1, pi-ai 0.87.1); the measurement report is
[`research/2026-09-26-live-verification.md`](research/2026-09-26-live-verification.md)
and the verbatim response bodies are committed in `test/fixtures/`. The probe
scripts and raw ledgers are local-only (`research/raw/`, gitignored) and are not
published — wherever a claim rests on one, this README says so.

Three measured facts dominate the design, and all three were **bought or bounded,
not read**:

1. **The gateway accepts what it should reject.** `max_tokens: 99999999` returns
   200 with a normal completion, and illegal enum values are ignored. An earlier
   private measurement pass spent ≈$1.15 on two probes it had designed as free
   rejections. Everything in this plugin is therefore derived from **rejections**
   (free) or tiny capped generations, and the cap decision below exists because
   of it.
2. **Two error dialects lose their body entirely** (RFC 7807, `{"detail":…}`), and
   a third survives as a JSON blob glued to the status (`403: {"message":…}`).
   pi's classifier machinery depends on the text, so the plugin recovers and
   rewrites all three.
3. **The output-cap field is per model in pi**, and the gateway's behaviour with
   the two candidates differs by model — see § The `maxTokensField` decision,
   which is the technical centre of this plugin.

## Install / use

```
pi install git:github.com/RarogCmex/pi-fuelix@main
# or a local checkout:  pi install /path/to/pi-fuelix
# or one-shot:          pi -e /path/to/pi-fuelix/index.ts
```

Then, **inside pi** (these are pi's own slash commands, not shell):

```
/login fuelix                       # validates the key with a free zero-inference probe
```

```bash
pi --model fuelix/gpt-5.4 -p "hello"   # one-shot run
pi --list-models fuelix                # the 98 registered ids
```

Model ids take the `<provider>/<model-id>` form, so the `fuelix/` prefix is part
of every id: `fuelix/gpt-5.4`, `fuelix/claude-sonnet-5`. Thinking-level flags
(`--thinking …`) are accepted by pi but have **no effect** here — see § Thinking.

**Getting a key:** fuelix.ai is not self-serve from this repository's point of
view — the key (`ak-…`) comes from your account's API keys page, which is what
the `/login` prompt names. Nothing in this plugin can create one, and the
gateway publishes no pricing page, so the balance and entitlements behind a key
are invisible from the outside (§ What remains unverified).

Environment:

| Variable | Meaning |
|---|---|
| `FUELIX_API_KEY` | Gateway key (`ak-…`). The credential stored by `/login` wins over it. |
| `FUELIX_BASE_URL` | Endpoint override (default `https://api.fuelix.ai/v1`), trailing slashes stripped. |
| `FUELIX_LIVE_SWEEP` | `1` makes `npm run live` also run check H, the opt-in liveness sweep (see § Development). |

## The catalog

`GET /v1/models` (authenticated; 401 without a key) returns **111 ids**, of which
**13 are not chat models** and **98 are**. The 98 are frozen in `catalog.ts`
(`LISTED_CHAT_IDS`) and asserted against the recorded listing by
`test/catalog.test.ts`, so a listing change fails a test instead of drifting
silently. The counts this README states that the catalog depends on — 111 listed,
98 chat, 13 excluded — are exactly the ones that test asserts; the rest (which
ids were probed, which were not) are derived from
`research/2026-09-26-live-verification.md` and are labelled as such.

Everything in the listing is `{id, object, created, owned_by}` — **no windows, no
caps, no prices, no modalities**. The gateway publishes no pricing page
(`/pricing`, `/key/info`, `/spend/logs`, `/usage`, `/me` all 404) and no body
discloses a rate. Therefore:

- **every price is zero, with a `priceNote`** — pi shows `$0.00` rather than a
  plausible-looking wrong number. The rule the catalog follows is: an unknown
  price is published as zero plus a note, never guessed;
- **measured caps** exist for the six ids an earlier private pass bought (the
  `provenance` column of the table below);
- **everything else is a conservative floor**, `32 768` window / `16 384` cap,
  marked `provenance: "floor"` in the catalog. The window floor makes pi compact
  *before* an over-context request (which would be billed); the *cap* floor is
  16 384 rather than smaller because pi puts the catalog cap on the wire on every
  request (measured — see § The `maxTokensField` decision), so a smaller floor
  would silently truncate answers.

| id | window | `max_tokens` | provenance |
|---|---|---|---|
| `gpt-5.4` (and `-2026-03-05`) | 922 000 | 128 000 | **measured** — the window is the *deployment's input admission limit* (`Input tokens exceed the configured limit of 922000 tokens`), not the model's advertised context window |
| `claude-sonnet-5` (and the `cursor-c-sonnet-5` alias, served as `claude-sonnet-5@default`) | 1 000 000 | 128 000 | **measured** (Vertex route) |
| `gpt-4o-mini` (and `-2024-07-18`) | 128 000 | 16 384 | **measured** |
| the other 92 ids | 32 768 | 16 384 | floor (unverified), see § What remains unverified |

Two further measured quirks worth knowing: Azure truncates a single `content`
string at 10 485 760 characters (not a window), and several deployments report
**more input tokens than the request contained** (`wasikan-v2-2`: 6138 input
tokens for a 30-token body), i.e. something upstream prepends a prompt. That is
the reason no full-catalog sweep was run — it is not priceable from the outside.

### Excluded: 13 non-chat ids

`dall-e-3`, `imagen-3`, `imagen-3-fast`, `imagen-4`, `gemini-3.1-flash-image`,
`tts-1`, `tts-1-hd`, `whisper-1`, `text-embedding-3-small`,
`text-embedding-3-large`, `text-embedding-ada-002`, `gpt-4o-transcribe`,
`gpt-4o-transcribe-2025-03-20`.

They are state 2 of § Surfaces (exists, deliberately not added): none of them is a
chat-completions shape, so none can be a pi chat model. Excluded twice — by exact
id (`NON_CHAT_IDS`) and by regex (`EXCLUDED_PATTERN`) — because discovery, not the
catalog, is what would re-add a *future* `dall-e-4` or `whisper-2`;
`test/catalog.test.ts` asserts the regex matches all 13 and none of the 98.

## Design decisions

### Wire protocol: `openai-completions`, and only that

Every probe used `/chat/completions`, and the api map registers exactly one route.
A model whose `api` has no route fails closed (`test/provider.test.ts`) instead of
silently using the wrong surface. The two other live routes are deliberately not
registered — § Surfaces.

### Auth: `Authorization: Bearer ak-…`, and 401 ≠ 403

The key is resolved through pi's `envApiKeyAuth("fuelix.ai API key",
["FUELIX_API_KEY"])`, so it comes from `/login` (stored) or the env var, and the
OpenAI adapter sends it as `Authorization: Bearer <key>`. Measured: `GET /v1/models`
answers 200 with that header and 401 without it, and every chat probe used it.

`/login` runs a **zero-inference validation** — `POST /chat/completions` with an
empty JSON body:

| result | meaning |
|---|---|
| `401` | the key is wrong → `/login` refuses to save it |
| `400 {"detail":"Request body is missing"}` | the key authenticated (measured; a rejection is not billed) |
| network failure | **unknown** → the key is saved anyway, with a warning, so `/login` still works offline |

The gateway's two refusal statuses are deliberately kept apart in the error layer,
because confusing them sends users down the wrong path:

- **`401` is the key**: `{"title":"Unauthorized","detail":["Invalid or missing API key"]}`;
- **`403` is entitlement**: `Authorization failed for model 'X'. The model may be
  unavailable, retired, or not enabled for your organization.` — measured for an
  unlisted id *and* for a listed one (`llama-3.2-90b`), i.e. the `/models` listing
  is an advertisement, not an entitlement list. Re-authenticating cannot fix it,
  and the rewrite says so.

No key-management URL is printed by the plugin: the gateway's console address was
never verified, and a wrong URL in an auth error is worse than none.

### The `maxTokensField` decision (one field, evidence per model)

pi sends the cap as **one** of two fields per model
(`model.compat.maxTokensField`, resolved by `getCompat` and consumed by the
request builder, both in pi-ai's `api/openai-completions.js` — symbols, not line
offsets, because pi-ai is an unpinned optional peer and an offset rots silently),
and the gateway's behaviour differs per model, so "which field" had to be measured
rather than guessed. Method: a streaming request whose prompt asks for ~20 output
tokens, with the field under test set to **8**, aborted client-side after 300
events — `output ≤ 8` ⇒ honoured, `output ≈ 20-30` ⇒ accepted but ignored, 4xx ⇒
rejected.

| field | result on this gateway |
|---|---|
| `max_completion_tokens` | **HONOURED** (output cut at the cap, `finish_reason: length`) on 11 distinct backends: `gpt-4o-mini`, `gpt-5.4`, `o4-mini`, `gemini-2.5-flash`, `deepseek-v4.1-flash`, `clarke-1.0`, `tycho-1.0`, `wasikan-v2-2`, `gemma-4-26b-a4b-it`, `gpt-oss-20b`, `mistral-large` |
| `max_tokens` | **silently ignored** by `gpt-5.4` (recon: 200 for 99999999; `max_tokens: 8` produced 12 output tokens); `gpt-4o-mini` validates both (recon); `claude-sonnet-5` accepts it numerically (recon) |

**Decision: `max_completion_tokens` for every model.** No measured model needs the
legacy field, and the failure mode of the wrong choice is the quiet one (an ignored
cap looks exactly like a working request). The per-model seam is real and tested:
`test/wire-format.test.ts` flips one model to `max_tokens` and asserts the bytes,
so a future route that needs it is a one-line override.

Two consequences of the measurement that are easy to miss:

- **pi sends the catalog cap on every request.** pi-ai's `buildBaseOptions`
  defaults `maxTokens` to `model.maxTokens` (in `api/simple-options.js`),
  which is why a real `pi -p` run put `max_completion_tokens: 128000` (gpt-5.4) /
  `16384` (gpt-4o-mini) on the wire — and why the 92 floored models are capped at
  16 384. `test/wire-format.test.ts` locks this.
- **pi-ai also clamps the cap to the remaining context** (`clampMaxTokensToContext`,
  4096 tokens of headroom), so a floored model's cap shrinks as the transcript
  grows instead of being sent as-is.

What a real `pi -p` request body contained, measured with a throwaway
`before_provider_request` logger: exactly
`[max_completion_tokens, messages, model, stream, stream_options, tools]` — no
`store`, no `developer` role, no `prompt_cache_key`/`prompt_cache_retention`. The
compat flags in `models.ts` are what keep it that way (auto-detection would send
`store: false` and the `developer` role for a reasoning model on this host).

### Thinking: `reasoning: false` everywhere, deliberately

The gateway accepts `reasoning_effort`, and that is precisely why the plugin does
not offer it. Measured (2026-09-26):

- `reasoning_effort: "low"` / `"none"` / `"bogus-enum-value"` each returned **200**
  on `gpt-5.4`, `gemini-2.5-flash`, `mistral-large`, `clarke-1.0`,
  `deepseek-v4.1-flash`, `tycho-1.0` and `claude-haiku-4-5`;
- the **control**: `"none"` also returned 200 on `gpt-4o-mini`, a model that cannot
  reason at all — so acceptance is not evidence of anything;
- the one route that *does* forward the field to a validating upstream is o-series:
  `o4-mini` + `"none"` → **400** `Unsupported value: 'reasoning_effort' does not
  support 'none' with this model. Supported values are: 'low', 'medium', 'high',
  and 'xhigh'.`

Declaring `reasoning: true` would make pi offer thinking levels whose effect is
unproven, and a user choosing `off`/`minimal` could keep paying for the upstream's
default reasoning with nothing observable changing in the answer — a capability
flag promising something the gateway never confirmed, which is the one class of
error this catalog refuses to ship. `reasoning: false` claims nothing: pi sends no
reasoning parameter and every
model runs at the gateway's default effort. A catalog-wide wire test asserts that
for 98 ids × 6 levels. § What remains unverified says how to justify turning it on.

### Errors: recover the body, then rewrite the shape

Already summarised in the three measured dialects: a body-recovery fetch wrapper
(`withBodyRecovery`, chaining onto pi's own fetch, idempotent by symbol) re-emits a
non-OK body as `text/plain`, which is the only way the SDK's message composer
becomes readable for RFC 7807 / `{"detail"}` bodies, and which turns the enveloped
403 from `403: {"message":…}` into one sentence.

`message_end` then rewrites, in this order:

1. **overflow first** — `Input tokens exceed the configured limit of N tokens`
   (the deployment's input limit, quoted from the bought measurement of
   2026-09-26) is
   tagged `context_length_exceeded: …`. pi's own `OVERFLOW_PATTERNS` provably do
   **not** match that wording (`test/errors.test.ts` checks every pattern), so
   without the rewrite pi would never auto-compact. A rate-limit veto runs first,
   so a busy gateway can never be laundered into a compaction loop.
2. **the readable sentence** — 401 → key; 403 `Authorization failed for model` →
   entitlement (explicitly *not* a key problem); `The requested operation is
   unsupported` → the id is not served on this route (measured on
   `gpt-5.3-codex`/`-2026-02-24`).

Every rewrite is idempotent and is proven against pi's *real* classifiers: none of
them becomes retryable and none triggers compaction (only the overflow marker
does, which is the point). `turn_end` adds one deduped, persistent TUI note for the
two states a human must fix (bad key, missing entitlement), gated on `ctx.hasUI`
because an entry appended after an errored assistant message makes `pi -p` print
nothing at all.

### Discovery: additive, unknowns-only, never throws

`fetchModels` reads `GET /v1/models` with the key, keeps curated ids out (a listing
would otherwise freeze today's floors into pi's store and shadow a later catalog
fix) and filters non-chat ids through the same regex. A missing key, a 401, a bad
body or a rejected fetch returns `[]`, so an offline start degrades to "static
catalog", never to "broken provider". pi's merge never deletes, so an id the
gateway removes lingers until a catalog edit — a pi limitation, documented rather
than worked around.

## Surfaces — three states

Each state carries its own date and source, because they are not the same claim.

**In use (this plugin, 2026-09-26):** `POST /v1/chat/completions`, keyed
`openai-completions` in the api map. Every measurement made on that date used it —
the field matrix, the `reasoning_effort` probes, the liveness sweep, the error-path
probes, both `npm run live` runs and the real `pi` runs (§ What verifying this
cost).

**Exists, deliberately not added:**

- `POST /v1/messages` — **200** with a real Anthropic-shaped body
  (`msg_vrtx_…`) on `claude-sonnet-5`, measured 2026-09-26 by the earlier
  reconnaissance pass. Not
  registered: the chat route serves the same models, `claude-*` ids are already in
  the catalog, and adding an `anthropic-messages` route means a second probe pass
  for tools/streaming/thinking before it can be trusted — a later increment, not a
  free win.
- `POST /v1/responses` — **200** with a full Responses body for `gpt-4o-mini`
  (`gpt4o_mini_20240718-useast2`, 8 in / 11 out tokens), measured 2026-09-26;
  the earlier pass had recorded `400 Unknown parameter: 'input'`, and this probe
  was designed as a free rejection and was billed instead. **Independently
  re-verified by the maintainer the same day**: `200`, `status: completed`,
  `model: gpt4o_mini_20240718-useast2`, `usage: {input_tokens: 8, output_tokens: 10}`.
  The earlier 400 was model-specific (`gpt-5.4`) and never generalised to the route;
  a second maintainer probe with `max_output_tokens: 8` was rejected by the front's
  validator (`Expected a value >= 16`), which is further evidence the route is real. Not registered: same
  reasoning as above, plus the notable consequence below.
  **Consequence:** `gpt-5.3-codex` and `gpt-5.3-codex-2026-02-24` answer **400
  `AzureException - The requested operation is unsupported.`** on the
  chat-completions route (measured twice, with caps 1 and 16, so it is not a cap
  artifact). They are listed ids that this plugin cannot serve; the error layer
  says so. Whether they work over `/v1/responses` was **not** verified.
- **The 13 non-chat ids** (§ Excluded) — image generation, speech-to-text,
  text-to-speech and embeddings, from the recorded 111-id listing of 2026-09-26.
- **Region-specific deployments** — `gemini-2.5-flash-ca`, `gemini-2.5-pro-ca`,
  `gpt-4o-mini-ca-east`, `gpt-4.1-mini-canada`, `claude-sonnet-4-5-bedrock` are
  registered as ordinary catalog ids (they are listed), but whether they are
  separate regional routes, distinct deployments or unreachable aliases was not
  investigated.

**Checked and absent as of 2026-09-26:**

- `POST /v1/completions` (legacy) → **404** `application/problem+json`
  `{"title":"Not Found","detail":["Cannot POST /v1/completions"]}`; an unknown
  route returns the same shape, so the RFC 7807 dialect belongs to the gateway
  front, not to LiteLLM (LiteLLM's own errors are enveloped).
- No enterprise/pricing/usage API: `/pricing`, `/key/info`, `/user/info`,
  `/spend/logs`, `/usage`, `/me` → 404 (recon).

**Deliberately not investigated:** image/vision *input* (no model declares
`input: ["image"]` here, so pi will not attach images; a 1×1-PNG probe lies and a
correct one needs a real image plus a paid call); embeddings/rerank endpoints beyond
the listed embedding ids; whether `prompt_cache_key`/`prompt_cache_retention` are
accepted (the plugin does not send them); audio transcription via
`/audio/transcriptions`; and any billing or quota API.

## Non-goals

Multi-account key pools, i18n, a separate transport/retry layer, an
`anthropic-messages` or `openai-responses` route, a thinking-level control, command
trees, persisted stores, region routing. The pi surface this plugin needs is:
register, `/login`, `--list-models`, `pi -p`, tools, and the error paths.

## What is verified live, and how

All on **2026-09-26**, pi 0.87.1, with a real gateway key. Cost discipline: every
probe was either a **rejection** (free) or a tiny capped generation
(`maxTokens ≤ 64` after the first matrix; `1` for the liveness sweep), and the
free/billed split is *observed*, not intended — a probe counts as free only once it
came back 4xx. Full tables: `research/2026-09-26-live-verification.md`.
Re-running any of it yourself: see § Development.

- `npm run typecheck` (`tsc -p tsconfig.json`) — clean.
- `npm test` (`node --test`, with the `test/no-network.ts` preload that makes
  `globalThis.fetch` throw) — **130 passing** at the time of writing (run it
  rather than trusting the count), both with and without ambient
  `FUELIX_*` variables in the environment (the suite removes them per test, so it
  cannot quietly depend on the caller's shell). Includes the catalog-wide payload
  matrix (98 ids × 6 thinking levels), the negative-safety assertions against pi's
  real `isContextOverflow` / `isRetryableAssistantError` / `getOverflowPatterns`,
  and a hygiene test that fails if a key-like string, the gateway account id or a
  balance figure ever reaches the sources.
- `npm run live` (`live/check.ts`, paced 3 s, retry on 429) — **A–G PASS** (check
  H, the opt-in sweep, was deliberately not run — see § Development): the
  listing matches the frozen catalog (111 ids, none stale, no unknown overlay
  candidate); `max_completion_tokens` is honoured on `gpt-5.4`, `gpt-4o-mini` and
  `o4-mini` (output cut at 8, `stopReason: length`, `max_tokens` absent); a
  function tool round-trips (`stopReason: toolUse`); streamed usage arrives; an
  invalid key → 401 with a non-retryable clarification; an unentitled model → 403
  with an *entitlement* clarification; the `{}`-body probe is still a free 400 and
  its body still recovers to readable text.
- **Real `pi -e ./index.ts`** (with `--no-extensions --no-session`):
  - `--list-models` → 98 `fuelix` rows, with the measured rows showing `922K/128K`
    (`gpt-5.4`) and `1M/128K` (`claude-sonnet-5`), and no non-chat id present;
  - `-p --model fuelix/gpt-5.4 "Reply with exactly: ok"` → prints `ok`, and the
    payload logger showed the serialized body carrying exactly
    `[max_completion_tokens, messages, model, stream, stream_options, tools]`
    (`max_completion_tokens: 128000`);
  - `-p --model fuelix/gpt-4o-mini "Reply with exactly: ok"` → prints `ok`, with
    usage `in=47 cacheRead=3072 out=2`;
  - `-p --model fuelix/gpt-4o-mini "Use the bash tool to run: echo hi"` → the
    agent loop ran the tool and answered `The output of the command is: hi`;
  - **error paths in print mode**: a bad key prints the clarified 401 sentence and
    exits 1; `fuelix/llama-3.2-90b` prints the entitlement sentence; `fuelix/gpt-5.3-codex`
    prints the unsupported-operation sentence. (Print mode is the mode the
    `turn_end`/`hasUI` trap breaks, so it is the one that must be checked.)

## What verifying this cost

**No USD figure appears in this repository, on purpose.** The gateway publishes no
price list, no body discloses a rate, and every catalog price is zero with a
`priceNote`; the currency figure is simply unavailable. What can be measured is
tokens, and the free/billed split is *observed* rather than intended — a probe
counts as free only once it came back 4xx.

The whole 2026-09-26 pass bought ≈ **10.4k input + 6.1k cacheRead + ≈150 output
tokens** across 45 billed calls. Two things about that number are worth carrying
over, and the per-request ledger that produces it lives in
`research/2026-09-26-live-verification.md` §7 rather than here:

- **Almost everything was learned for free.** The listing, every error body, the
  entitlement and unsupported-operation rejections and the `--list-models` runs
  were all 4xx or non-inference and cost nothing.
- **The one large line item was not a deliberate probe.** `wasikan-v2-2` reported
  **6 138 input tokens for a ~30-token body** — that deployment appears to inject
  a large upstream prompt. It is 59 % of the pass's input tokens, and it is the
  reason no full-catalog sweep was run: a blind sweep is not priceable from the
  outside.

One correction the ledger carries against itself: the `POST /v1/responses` probe
**was billed** (8 in / 11 out). It was designed from an earlier `400,
unsupported` observation and expected to be a free rejection. It is also the
evidence that the earlier claim no longer holds (§ Surfaces).

## What remains unverified

- **Windows and output caps for 92 of the 98 ids.** They are floors (only the six
  `provenance: "measured"` ids carry bought numbers). § "How to
  measure a cap without buying it" (`research/2026-09-26-live-verification.md`)
  gives the safe recipe: fix the field first, then send a deliberately oversized
  `max_completion_tokens` **with a client-side abort guard**; a rejection discloses
  the cap for free, an acceptance means it was bought and the cap stays unknown.
  Never bracket a cap with accepted requests.
- **Whether `max_completion_tokens` is honoured on the unprobed ids.** 11 backends
  say yes and `llama-3.2-90b` could not be tested at all (403). A three-request
  probe per model (§3 of the research note) settles any one of them.
- **Whether `reasoning_effort` changes anything anywhere.** Enabling
  `reasoning: true` needs a paired-run measurement per family (same prompt,
  `minimal` vs `high`, compare `reasoning_tokens`), which was not bought.
- **Prices.** None published, no body discloses one; zero + `priceNote` is the
  honest state, and the cache reads the gateway *does* report (`cacheRead: 3072` on
  the Azure routes) are priced at zero like everything else.
- **Liveness of the 75 chat ids the 2026-09-26 pass never touched** (98 listed
  minus the 23 distinct ids named in §3–§5 of the research note), and the two
  `gpt-5.3-codex*` ids, which
  are unusable through this plugin's only route.
- **Vision/image input** for the models that surely support it upstream (see
  § Surfaces).
- **Overflow → auto-compaction end-to-end.** The rewrite is unit-tested against
  pi's real classifiers and the wording comes from the measured body of
  2026-09-26, but no
  live session was driven over the (922 000-token) edge — reproducing it needs an
  oversized body, which is exactly the probe this plugin refuses to send.
- **`pi install <path>`** specifically (as opposed to `-e`): the `pi.extensions`
  manifest is standard, but the install path was not exercised, to avoid mutating
  the global pi config.
- **TUI rendering** of the persistent `fuelix-help` note: only the print-mode
  behaviour and the `ctx.hasUI` gate are tested.

## Layout

```
index.ts      the only pi-runtime-coupled file (loader-alias import + hooks + registerProvider)
provider.ts   createProvider assembly, auth/login + the zero-inference key probe
catalog.ts    pure data: the frozen 98-id list, the 13 exclusions, measured caps, floors
models.ts     catalog -> pi Model: compat flags, the maxTokensField decision, zero cost
discovery.ts  additive /v1/models overlay (authenticated, never throws)
errors.ts     body recovery, overflow tagging, readable rewrites
live/check.ts paced A–H live harness (A–G always; H opt-in; never part of npm test)
test/*.ts     node --test suite (130 tests) + no-network preload + hygiene scan
test/fixtures recorded live bodies (listing + error dialects) used by the tests
              (the listing's `owned_by` account id is scrubbed; the ids are verbatim)
research/     the 2026-09-26 live-verification report (raw/ is gitignored)
scripts/      link-pi.mjs — dev setup only, never loaded by pi
```

## Development

```bash
node scripts/link-pi.mjs   # once: link pi's packages from your global install
npm run check              # typecheck + the 130 offline tests
npm run live               # A–G harness against the real gateway; spends money
```

**Prerequisites.** Node ≥ 22.18 — the tests and `live/check.ts` are `.ts` run
directly (type stripping, and `node --test`'s `.ts` discovery, are unflagged from
22.18), plus a pi install.

pi's own packages are not dependencies of this plugin: at runtime pi's extension
loader aliases the bare `@earendil-works/pi-ai` specifier to its own copy, so a
plain `npm install` leaves nothing to typecheck against. `scripts/link-pi.mjs`
links them from your global pi install — it probes the npm prefix, nvm, pnpm,
`~/.local`, `/usr/local` and the directory the `pi` executable resolves to, and
creates junctions on Windows. For a specific install:
`PI_ROOT=/path/to/node_modules node scripts/link-pi.mjs`. Verified against
pi 0.87.1 / pi-ai 0.87.1 / `@types/node` 22.19.19.

`npm run live` needs a key and nothing else: it resolves `FUELIX_API_KEY` or the
credential stored by `/login fuelix`. Checks A–G run every time; **check H** (a
`maxTokens: 1` sweep across the whole catalog, to map entitlement and liveness) is
behind `FUELIX_LIVE_SWEEP=1` and off by default, because at least one deployment
reports thousands of input tokens for a tiny body — a blind sweep is not
priceable from the outside.

Behaviour is pinned to pi 0.87.1 internals (the `message_end` rewrite contract,
`compat.maxTokensField`, `clampMaxTokensToContext`) while `peerDependencies` stays
`"*"`; the tested version is stated here rather than narrowed in the manifest, so
an older pi may load the plugin and silently degrade.
