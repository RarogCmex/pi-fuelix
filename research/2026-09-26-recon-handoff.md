# fuelix — measured reconnaissance (handoff to the build)

`https://api.fuelix.ai/v1`, key `ak-...`. Two sources: my own probes **today**
(2026-09-26) and the measured table in the iteration-2 eval-4 report
(`~/pi-evals/iteration-2/runs/eval-4-with_skill/outputs/plan.md`), which spent
≈$1.15 of real money establishing the caps and windows below.

**Do not re-measure anything in the "already measured" section.** The numbers cost
money once; they are not worth buying twice — and two of those probes were
*accepted* (411 k and 210 k input tokens), which is exactly how that $1.15 was
spent (pitfalls L18/L35).

## Engine

LiteLLM in front of **Azure OpenAI** (`gpt-*`, confirmed: `gpt-5.4` →
`gpt-5.4-2026-03-05`, `gpt-4o-mini` → `gpt-4o-mini-2024-07-18`) and
**Vertex AI / Anthropic** (`claude-*`; `msg_vrtx_…` ids observed). Claude requests
were seen hitting two different upstreams (Vertex vs direct), so Claude numbers
carry that caveat.

## Measured today (my probes — all free or ≤4 tokens)

| probe | result |
|---|---|
| `GET /v1/models` **with** key | 200, **111** ids |
| `GET /v1/models` **without** key | **401**, RFC 7807 body: `{"type":"https://httpstatuses.com/401","title":"Unauthorized",…}` → **non-OpenAI envelope** |
| `POST /chat/completions {}` | `400 {"detail":"Request body is missing"}` → **non-OpenAI envelope** |
| unknown model id | **`403`** `{"error":{"message":"Authorization failed for model 'X'. The model may be unavailable, retired, or not enabled for your organization…"}}` → an *entitlement* signal, not a key error; this shape **is** OpenAI-ish and survives the SDK |
| `POST /v1/completions` | `404` RFC 7807 problem body |
| `POST /v1/messages` (claude-sonnet-5) | **200** — a real Anthropic Messages surface (`msg_vrtx_…`) |
| `POST /v1/responses` `{"input":…}` | `400 litellm.BadRequestError: AzureException BadRequestError - Unknown parameter: 'input'` → the **Responses body shape is not supported** here |

**This gateway really does lose error bodies** (unlike seekai, where the enveloped
shapes survive): RFC 7807 and `{"detail":…}` are not OpenAI envelopes, so the SDK
reduces them to `<status> status code (no body)`. A body-recovery fetch wrapper is
justified here on measured grounds — say so with the measurement, and do not
generalise the claim beyond the shapes actually observed.

## Already measured (do NOT re-probe — this is bought data)

| model | output cap | window | field that is honoured |
|---|---|---|---|
| `gpt-5.4` | **128 000** | input limit **922 000** (Azure *deployment* config, not the model's advertised window) | **`max_completion_tokens`**; `max_tokens` is **silently ignored** (200 for 99999999; `max_tokens: 8` produced 12 output tokens) |
| `claude-sonnet-5` | **128 000** (Vertex route) | **1 000 000** (Vertex route) | `max_completion_tokens`; `max_tokens` accepted numerically but not upper-validated |
| `gpt-4o-mini` | **16 384** | **128 000** | both fields validated |

Details worth keeping in the README: Azure truncates a single `content` string at
10 485 760 characters (not a model window); the `gpt-5.4` window figure is an
*input* admission limit of the deployment (`Input tokens exceed the configured limit
of 922000 tokens`), so it must be labelled as such rather than as "context window".

## Pricing

Nothing. `/pricing`, `/key/info`, `/user/info`, `/spend/logs`, `/usage`, `/me` all
404, and neither the 400 nor the 403 bodies disclose a rate. The 403 body does leak
a **balance** (`＄…` pre-billing), which is a debugging aid only.
→ By house rule: **zero price + `priceNote`**, never a guess, and no USD claim in
the cost log — report tokens and say the currency figure is unavailable.

## Catalogue shape to expect

111 ids, of which ~10 are non-chat: `dall-e-3`, `imagen-3`, `imagen-3-fast`,
`imagen-4`, `gemini-3.1-flash-image`, `tts-1`, `tts-1-hd`, `whisper-1`,
`text-embedding-3-small`, `text-embedding-3-large`, `text-embedding-ada-002`.
These are the natural "exists but deliberately not added" row of the three-state
table; the `/v1/messages` surface is the "checked and it works — decide and record
whether we register it" row.

## Constraints for the build

1. **Never send a body larger than ~8 KB.** Large bodies are billed on acceptance
   and this gateway accepts what it should reject.
2. Nothing to discover about caps/windows: they are above. If something is missing,
   mark it `unverified` rather than buying it.
3. Pace probes; keep a ledger of every 2xx (a probe is free only when it is
   *rejected*).
4. The per-model **`maxTokensField`** decision is the technical centrepiece: a
   single global `max_completion_tokens` breaks `gpt-4o-mini`… or does it? Measure
   the *cross-field* behaviour cheaply (which field a model accepts, on a tiny
   body) and record it per model, because pi sends one field for all models.
