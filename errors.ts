/**
 * Error layer for the fuelix.ai gateway.
 *
 * **The gateway really does lose error bodies**, and the 2026-09-26 pass measured exactly
 * which ones (fixtures: `test/fixtures/error-bodies.json`, logic:
 * `test/errors.test.ts` drives pi-ai's *real* adapter with them):
 *
 * | response | pi saw without the fix (0.87.1) | pi sees with it |
 * |---|---|---|
 * | 401 RFC 7807 `{"type","title","detail":[…]}` (no key / bad key) | `401 status code (no body)` | `401 Unauthorized: Invalid or missing API key` |
 * | 400 `{"detail":"Request body is missing"}` | `400 status code (no body)` | `400 Request body is missing` |
 * | 403 `{"error":{"message":"Authorization failed for model 'X'…"}}` | `403: {"message":"Authorization failed…"}` | `403 Authorization failed for model 'X'…` |
 *
 * **The middle column is generation-specific, and the newer generation does not
 * lose those bodies.** Measured 2026-09-30 on pi 0.99.1 / pi-ai 0.99.1 by
 * replaying all nine fixtures through the same harness: the two 401 shapes arrive
 * as `401 {"type":…,"detail":["Invalid or missing API key"],…}` and the 400 as
 * `400 {"detail":"Request body is missing"}`. The reason is in the bundled SDK,
 * `openai` 7.19.0 `core/error.js:20-33` — `APIError.makeMessage` falls back to
 * `JSON.stringify(error)` when the body carries no `error.message`, so
 * `<status> status code (no body)` is now reached only when there is genuinely no
 * body. The right column is unchanged: `withBodyRecovery` flattens to the same
 * bytes on both generations, so on 0.99.1 it is a no-op rather than a rescue.
 * It stays because `peerDependencies` is `"*"` and pi 0.87.x still loads this.
 *
 * The mechanism on 0.87.1 was the OpenAI SDK's, not the gateway's: `APIError.makeMessage`
 * composed `<status> <error.message>` from the body's `error` key only, and for
 * a JSON body it passed `message = undefined` — so a body without an `error`
 * envelope became literally "no body" (the `openai` SDK's own error
 * construction, in its `core/error.js` — `openai` is not a declared dependency of
 * this package, it arrives with pi-ai).
 * pi-ai then composes `"<status>: <json body>"` when the SDK's error object does
 * carry a body that its message does not include (`formatProviderError` in
 * pi-ai's `utils/error-body.js`). Both shapes are
 * locked as separate regression tests, because they are different failures.
 *
 * `recoverErrorBody` is the standard dropped-body fix: re-emit a non-OK body as
 * `text/plain` so the SDK's `errMessage` fallback carries the text. It buys two
 * things here — the genuinely lost bodies come back, and both dialects arrive as
 * one uniform `<status> <text>` that `clarifyFuelixError` can parse once.
 *
 * The rewrites are deliberately narrow: only shapes that were *measured* are
 * rewritten (a 429 was never observed on this gateway, so no 429 wording is
 * invented), each is idempotent, and `test/errors.test.ts` proves against pi's
 * real classifiers that none of them becomes retryable and none of them — except
 * the overflow normalization, which must — triggers auto-compaction.
 */

import type { ProviderStreams } from "@earendil-works/pi-ai";
import { PROVIDER_ID } from "./models.ts";

/** Prefix marking a message this module already rewrote, so rewrites are idempotent. */
const SENTINEL = "fuelix:";

/** The marker pi-ai's generic overflow pattern recognises (`utils/overflow.js`). */
export const OVERFLOW_MARKER = "context_length_exceeded: ";

/**
 * No key-management URL is printed anywhere in this plugin: the gateway's
 * console address was never verified, and a wrong URL in an auth error is worse
 * than none. The measured 401 body names only the instance path.
 */
export const AUTH_HELP = `run \`/login ${PROVIDER_ID}\` or set \`FUELIX_API_KEY\` to a valid key`;

// --- measured shapes ---------------------------------------------------------

/** 401 `{"type":"https://httpstatuses.com/401","title":"Unauthorized","detail":["Invalid or missing API key"]}`. */
const AUTH_RE = /\bunauthorized\b|invalid or missing api key|invalid_api_key|\b401\b/i;

/** 403 `{"error":{"message":"Authorization failed for model 'X'. …","type":"basicllm.schemas.errors.ModelAuthorizationError","code":403}}`. */
const ENTITLEMENT_RE = /authorization failed for model|modelauthorizationerror|not enabled for your organization/i;

/** 400 `litellm.BadRequestError: AzureException - The requested operation is unsupported.` (measured on the `gpt-5.3-codex*` ids). */
const UNSUPPORTED_OPERATION_RE = /the requested operation is unsupported/i;

/**
 * Veto list for the overflow normalizer, taken from pi-ai's own
 * `NON_OVERFLOW_PATTERNS` (`utils/overflow.js`) plus the status prefix:
 * a throttle must never be laundered into a compaction trigger.
 */
const RATE_LIMIT_RE = /\brate.?limit\b|too many requests|throttl|\b429\b/i;

/**
 * The overflow wording this gateway discloses, quoted from the measured table in
 * `research/2026-09-26-live-verification.md`: OpenAI on Azure rejects with
 * `Input tokens exceed the configured limit of 922000 tokens` — a *pre-inference*
 * rejection that discloses the deployment's input limit for free. No
 * `OVERFLOW_PATTERNS` entry matches it: pi knows
 * `/exceeds the context window/`, `/input token count.*exceeds the maximum/` and
 * `/exceeds the limit of \d+/`, none of which fire on "tokens exceed the
 * configured limit of N tokens", so pi would never compact (verified in
 * `test/errors.test.ts` against `getOverflowPatterns()`).
 *
 * Not re-measured here on purpose: reproducing it needs a ~922 000-token body,
 * and this gateway accepts bodies it ought to reject — so the probe would be
 * billed, not refused. Prove limits from rejections; an accepted probe is a paid
 * probe.
 */
const OVERFLOW_RE = /tokens? exceed(?:s|ed)? the configured limit of [\d,]+ tokens?/i;

// --- parsing -----------------------------------------------------------------

export interface ParsedGatewayError {
  /** HTTP status parsed from the leading `<status>[ :]` token, when present. */
  status?: number;
  /** Human-readable cause (JSON `error.message` / `message` / RFC 7807 title+detail, or raw text). */
  message: string;
  /** Original composed message, unchanged. */
  raw: string;
}

/** Compose a readable sentence out of an RFC 7807 problem document. */
function fromProblemBody(body: Record<string, unknown>): string | undefined {
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const detail = body.detail;
  const detailText = Array.isArray(detail)
    ? detail.filter((d): d is string => typeof d === "string").join("; ")
    : typeof detail === "string"
      ? detail
      : "";
  if (title && detailText) return `${title}: ${detailText}`;
  return title || detailText || undefined;
}

/** Pull a human cause out of an already-parsed error body. */
function messageFromBody(parsed: unknown): string | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const body = parsed as Record<string, unknown>;
  const error = body.error;
  if (typeof error === "object" && error !== null) {
    const inner = (error as Record<string, unknown>).message;
    if (typeof inner === "string" && inner.trim()) return inner.trim();
  }
  if (typeof body.message === "string" && body.message.trim()) return body.message.trim();
  return fromProblemBody(body);
}

/**
 * Split pi's composed `<status>[ :] <body>` message into status and cause. The
 * body may be JSON (both the recovered and the un-recovered dialect) or plain
 * text.
 */
export function parseGatewayError(errorMessage: string): ParsedGatewayError {
  const raw = errorMessage;
  let rest = errorMessage.trim();
  let status: number | undefined;

  const head = /^(\d{3})\s*:?\s*/.exec(rest);
  if (head) {
    status = Number(head[1]);
    rest = rest.slice(head[0].length).trim();
  }

  if (rest.startsWith("{")) {
    try {
      const message = messageFromBody(JSON.parse(rest));
      if (message) return { status, message, raw };
    } catch {
      // Truncated body — fall through to the raw text.
    }
  }

  return { status, message: rest, raw };
}

/**
 * Extract a human message from a raw (non-OK) response body, for the recovery
 * wrapper. Returns undefined when there is nothing useful, in which case the
 * response is passed through untouched.
 */
export function extractGatewayMessage(body: string): string | undefined {
  const trimmed = body.trim();
  if (!trimmed) return undefined;

  if (trimmed.startsWith("{")) {
    try {
      const message = messageFromBody(JSON.parse(trimmed));
      if (message) return message;
    } catch {
      // Not JSON after all.
    }
    return undefined;
  }

  const firstLine = trimmed.split(/\r?\n/, 1)[0].trim();
  // A body with no words at all (`[]`, `{`, punctuation) carries no message:
  // pass it through untouched rather than replacing it with itself.
  if (!firstLine || !/[a-z0-9]/i.test(firstLine)) return undefined;
  return firstLine.slice(0, 300);
}

// --- body recovery (the dropped-body fix) ------------------------------------

/**
 * Re-emit a non-OK response body as `text/plain` so the OpenAI SDK stops
 * dropping it. A successful response is returned untouched, as is a non-OK
 * response whose body carries no usable message.
 */
export async function recoverErrorBody(response: Response): Promise<Response> {
  if (response.ok) return response;
  let body: string;
  try {
    // clone() so the original stream stays intact if we decide not to replace it.
    body = await response.clone().text();
  } catch {
    return response;
  }
  const message = extractGatewayMessage(body);
  if (!message) return response;
  // Preserve the original headers (retry hints, request ids) — only the encoding changes.
  const headers = new Headers(response.headers);
  headers.set("content-type", "text/plain; charset=utf-8");
  return new Response(message, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const BODY_RECOVERY_MARK = Symbol.for("pi-fuelix.bodyRecovery");

/** Wrap a fetch so every non-OK response gets the recovery treatment. Idempotent and chaining. */
export function withBodyRecovery(inner?: typeof fetch): typeof fetch {
  const base = inner ?? globalThis.fetch;
  if ((base as unknown as Record<symbol, unknown>)?.[BODY_RECOVERY_MARK]) return base;
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) =>
    recoverErrorBody(await base(input, init))) as typeof fetch;
  Object.defineProperty(wrapped, BODY_RECOVERY_MARK, { value: true, enumerable: false });
  return wrapped;
}

/**
 * Apply the fetch recovery to a registered api surface. pi passes its own
 * `fetch` per call; we chain onto it rather than replacing it, and preserve
 * every other option field (`onPayload`, `onResponse`, `maxRetries`, …).
 */
export function withBodyRecoveryApi(api: ProviderStreams): ProviderStreams {
  const wrapped: ProviderStreams = {
    stream: (model, context, options) =>
      api.stream(model, context, { ...options, fetch: withBodyRecovery(options?.fetch) }),
    streamSimple: (model, context, options) =>
      api.streamSimple(model, context, { ...options, fetch: withBodyRecovery(options?.fetch) }),
  };
  if (api.fetchDeferred) wrapped.fetchDeferred = api.fetchDeferred;
  if (api.cancelDeferred) wrapped.cancelDeferred = api.cancelDeferred;
  return wrapped;
}

// --- overflow normalization --------------------------------------------------

/**
 * Tag an overflow rejection with pi's marker so auto-compaction fires.
 *
 * Order matters: the rate-limit veto runs **first**, so a busy gateway can never
 * be laundered into a destructive compaction loop. Idempotent — the marker is
 * checked before it is added — and it leaves every other message alone.
 */
export function normalizeOverflowError(errorMessage: string): string | undefined {
  if (!errorMessage || errorMessage.startsWith(OVERFLOW_MARKER)) return undefined;
  if (RATE_LIMIT_RE.test(errorMessage)) return undefined;
  if (!OVERFLOW_RE.test(errorMessage)) return undefined;
  return `${OVERFLOW_MARKER}${errorMessage}`;
}

// --- readable rewrites -------------------------------------------------------

/**
 * Turn a measured fuelix failure into an actionable sentence, or return
 * undefined when the message is not a known shape (or was already rewritten).
 *
 * `401` and `403` are deliberately different diagnoses: **401 is the key,
 * 403 is the model's entitlement**. The gateway answers 403
 * `Authorization failed for model 'X'` for a model the key may not run, even
 * when the id is in its own listing — `llama-3.2-90b` and
 * `fuelix-does-not-exist-xyz` both produced it on 2026-09-26. Telling a user to
 * re-authenticate in that case sends them down the wrong path.
 */
export function clarifyFuelixError(errorMessage: string): string | undefined {
  if (!errorMessage || errorMessage.startsWith(SENTINEL)) return undefined;
  const { status, message, raw } = parseGatewayError(errorMessage);
  const both = `${message} ${raw}`;

  // Entitlement first: its body also contains words like "Authorization", which
  // the auth regex below would otherwise claim.
  if (ENTITLEMENT_RE.test(both)) {
    return (
      `${SENTINEL} this key is not entitled to the requested model (HTTP ${status ?? 403}). ` +
      "The gateway answered `Authorization failed for model '…'. The model may be unavailable, " +
      "retired, or not enabled for your organization.` — that is an entitlement, not a bad key, so " +
      "`/login` will not fix it: pick another model (the `/models` listing advertises ids the " +
      "gateway knows, not the ids your key can run). Original: " +
      message
    );
  }

  // status === 401 covers both dialects of a rejected key: the dropped-body one
  // (`401 status code (no body)`, pi 0.87.1) and the raw RFC 7807 body that
  // pi 0.99.1 passes through (`401 {"type":…,"detail":[…]}`). Measured
  // 2026-09-30: both reach this branch and produce the same sentence.
  if (AUTH_RE.test(both) || status === 401) {
    return (
      `${SENTINEL} authentication failed (HTTP ${status ?? 401}) — the gateway rejected the key ` +
      `with \`Invalid or missing API key\`. Check for a trailing newline in the pasted key, then ` +
      `${AUTH_HELP}, and note that ` +
      "a key can be valid and still not entitled to a model (that is a 403, not this error). " +
      "Original: " +
      message
    );
  }

  if (UNSUPPORTED_OPERATION_RE.test(both)) {
    return (
      `${SENTINEL} the upstream deployment rejected the operation on the chat-completions route ` +
      `(HTTP ${status ?? 400}). Measured on the \`gpt-5.3-codex*\` ids, which are listed but answer ` +
      "`The requested operation is unsupported.` there; whether they work on another API route " +
      "was not verified (this plugin registers only chat-completions). Try another model. Original: " +
      message
    );
  }

  return undefined;
}

/** True when an assistant message is a fuelix failure worth rewriting. */
export function shouldClarify(message: {
  role: string;
  stopReason?: string;
  provider?: string;
  errorMessage?: string;
}): boolean {
  return (
    message.role === "assistant" &&
    message.stopReason === "error" &&
    message.provider === PROVIDER_ID &&
    typeof message.errorMessage === "string" &&
    clarifyFuelixError(message.errorMessage) !== undefined
  );
}

/**
 * Whether the failure should also leave a persistent TUI note: the two states a
 * human has to act on (bad key, missing entitlement). Called from `turn_end`,
 * which runs *after* `message_end` may already have replaced the text with a
 * sentinel-prefixed sentence, so both dialects are accepted.
 */
export function needsPersistentHelp(errorMessage: string): boolean {
  if (!errorMessage) return false;
  const text = errorMessage.startsWith(SENTINEL)
    ? errorMessage
    : `${parseGatewayError(errorMessage).message} ${errorMessage}`;
  return AUTH_RE.test(text) || ENTITLEMENT_RE.test(text);
}
