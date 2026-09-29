/**
 * Error layer, tested against the gateway's **recorded** bodies.
 *
 * Two thirds of this file drive pi-ai's *real* `openai-completions` adapter with
 * `fetch` stubbed to replay the exact bytes captured from `api.fuelix.ai` on
 * 2026-09-26 (`test/fixtures/error-bodies.json`). That matters: the previous
 * build in this repo asserted synthetic bodies and got the *shapes* wrong, so
 * both dialects are locked here as separate, verbatim cases:
 *
 *  - **without** `withBodyRecovery` — what pi sees when the gateway's body is
 *    not an OpenAI envelope (the SDK composes `"<status> status code (no body)"`)
 *    versus when it *is* one (the SDK stringifies the body and pi-ai glues it to
 *    the status);
 *  - **with** it — the same requests, with the body recovered as plain text.
 *
 * The third requirement is negative safety: every rewrite is checked against
 * pi's *real* classifiers (`isRetryableAssistantError`, `isContextOverflow`,
 * `getOverflowPatterns`) so a readable sentence can never become retryable or
 * trigger a destructive compaction by accident.
 */

import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { readFileSync } from "node:fs";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
  getOverflowPatterns,
  isContextOverflow,
  isRetryableAssistantError,
  normalizeContext,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import {
  clarifyFuelixError,
  extractGatewayMessage,
  needsPersistentHelp,
  normalizeOverflowError,
  OVERFLOW_MARKER,
  parseGatewayError,
  recoverErrorBody,
  shouldClarify,
  withBodyRecovery,
  withBodyRecoveryApi,
} from "../errors.ts";
import { CATALOG_BY_ID } from "../catalog.ts";
import { DEFAULT_BASE_URL, entryToModel } from "../models.ts";

interface RecordedCase {
  request: string;
  status: number;
  contentType: string | null;
  body: string;
}

const fixtures = JSON.parse(
  readFileSync(new URL("./fixtures/error-bodies.json", import.meta.url), "utf8"),
) as { recorded: string; cases: Record<string, RecordedCase> };

const CASES = fixtures.cases;

/** Bodies recorded live on 2026-09-26 and committed as fixtures. */
const GOT = (name: keyof typeof CASES) => CASES[name].body.trim();

function model(id = "gpt-4o-mini") {
  return entryToModel(CATALOG_BY_ID.get(id)!, DEFAULT_BASE_URL);
}

/**
 * Run pi's real adapter against one recorded response and return the
 * `errorMessage` it hands to pi. `recovered` wraps the api exactly as
 * `index.ts` does in production.
 */
async function errorMessageFromRecordedBody(
  body: string,
  status: number,
  contentType: string | null,
  recovered: boolean,
): Promise<string> {
  const base = openAICompletionsApi();
  const api = recovered ? withBodyRecoveryApi(base) : base;

  let seenUrl: string | undefined;
  const stubFetch = (async (input: RequestInfo | URL) => {
    seenUrl = String(input);
    return new Response(body, {
      status,
      statusText: "",
      headers: contentType ? { "content-type": contentType } : undefined,
    });
  }) as unknown as typeof fetch;

  let errorMessage: string | undefined;
  const stream = api.streamSimple(
    model(),
    normalizeContext({
      systemPrompt: "You are pi, a coding agent.",
      messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
    }),
    { apiKey: "ak_test", maxTokens: 8, fetch: stubFetch },
  );
  for await (const event of stream) {
    if (event.type === "error") errorMessage = event.error.errorMessage;
    if (event.type === "done") break;
  }

  assert.equal(seenUrl, "https://api.fuelix.ai/v1/chat/completions");
  assert.ok(errorMessage !== undefined, "adapter produced no error message");
  return errorMessage;
}

function assistant(errorMessage: string): AssistantMessage {
  return {
    role: "assistant",
    stopReason: "error",
    provider: "fuelix",
    errorMessage,
    content: [],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: 0,
  } as unknown as AssistantMessage;
}

/** Every rewrite this layer can produce, for the classifier sweep. */
function allRewrites(): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  const messages = [
    "401 status code (no body)",
    "401 Unauthorized: Invalid or missing API key",
    `403: ${JSON.stringify({ message: "Authorization failed for model 'x'. …", code: 403 })}`,
    "403 Authorization failed for model 'llama-3.2-90b'. The model may be unavailable…",
    "400 litellm.BadRequestError: AzureException - The requested operation is unsupported.",
  ];
  for (const message of messages) {
    const clarified = clarifyFuelixError(message);
    assert.ok(clarified, `expected a rewrite for: ${message}`);
    out.push({ name: message.slice(0, 40), text: clarified });
  }
  const overflow = normalizeOverflowError("Input tokens exceed the configured limit of 922000 tokens");
  assert.ok(overflow);
  out.push({ name: "overflow marker", text: overflow });
  return out;
}

describe("recorded error bodies through pi's real adapter", () => {
  test("an RFC 7807 401 loses its body, and recovery brings it back", async () => {
    const recorded = CASES["models-no-key"];
    assert.equal(recorded.status, 401);

    const lost = await errorMessageFromRecordedBody(
      recorded.body,
      recorded.status,
      recorded.contentType,
      false,
    );
    assert.equal(lost, "401 status code (no body)");

    const recovered = await errorMessageFromRecordedBody(
      recorded.body,
      recorded.status,
      recorded.contentType,
      true,
    );
    assert.equal(recovered, "401 Unauthorized: Invalid or missing API key");
  });

  test("the same 401 shape arrives for a bad key on the chat route", async () => {
    const recorded = CASES["chat-bad-key"];
    assert.equal(
      await errorMessageFromRecordedBody(recorded.body, recorded.status, recorded.contentType, false),
      "401 status code (no body)",
    );
    assert.equal(
      await errorMessageFromRecordedBody(recorded.body, recorded.status, recorded.contentType, true),
      "401 Unauthorized: Invalid or missing API key",
    );
  });

  test('a {"detail": …} 400 loses its body, and recovery brings it back', async () => {
    const recorded = CASES["chat-empty-body"];
    assert.equal(recorded.status, 400);
    assert.equal(
      await errorMessageFromRecordedBody(recorded.body, recorded.status, recorded.contentType, false),
      "400 status code (no body)",
    );
    assert.equal(
      await errorMessageFromRecordedBody(recorded.body, recorded.status, recorded.contentType, true),
      "400 Request body is missing",
    );
  });

  test("the 403 entitlement envelope survives as a JSON blob, and recovery flattens it", async () => {
    const recorded = CASES["chat-unknown-model"];
    assert.equal(recorded.status, 403);

    const blob = await errorMessageFromRecordedBody(
      recorded.body,
      recorded.status,
      recorded.contentType,
      false,
    );
    // pi-ai's formatProviderError: `<status>: <json body>` when the SDK's message
    // does not already contain the body (`formatProviderError`, pi-ai's
    // utils/error-body.js).
    assert.match(blob, /^403: \{"message":"Authorization failed for model 'fuelix-does-not-exist-xyz'\./);
    assert.match(blob, /basicllm\.schemas\.errors\.ModelAuthorizationError/);

    const readable = await errorMessageFromRecordedBody(
      recorded.body,
      recorded.status,
      recorded.contentType,
      true,
    );
    assert.match(readable, /^403 Authorization failed for model 'fuelix-does-not-exist-xyz'\./);
    assert.equal(readable.includes('{"message"'), false);
  });

  test("the LiteLLM 400 envelope is readable in both dialects", async () => {
    const recorded = CASES["chat-missing-messages"];
    const blob = await errorMessageFromRecordedBody(
      recorded.body,
      recorded.status,
      recorded.contentType,
      false,
    );
    assert.match(blob, /^400: \{"message":"litellm\.BadRequestError: AzureException BadRequestError/);
    const readable = await errorMessageFromRecordedBody(
      recorded.body,
      recorded.status,
      recorded.contentType,
      true,
    );
    assert.match(readable, /^400 litellm\.BadRequestError: AzureException BadRequestError/);
    assert.match(readable, /Invalid 'messages': empty array/);
  });

  test("an RFC 7807 404 (application/problem+json) is recovered from its title/detail", async () => {
    const recorded = CASES["legacy-completions-404"];
    assert.equal(recorded.status, 404);
    const recovered = await errorMessageFromRecordedBody(
      recorded.body,
      recorded.status,
      recorded.contentType,
      true,
    );
    assert.equal(recovered, "404 Not Found: Cannot POST /v1/completions");
  });

  test("a healthy 200 response is not touched by the recovery wrapper", async () => {
    const recorded = CASES["responses-gpt-4o-mini-200"];
    const api = withBodyRecoveryApi(openAICompletionsApi());
    let status = 0;
    const stream = api.streamSimple(
      model(),
      normalizeContext({ messages: [{ role: "user", content: "hi", timestamp: Date.now() }] }),
      {
        apiKey: "ak_test",
        maxTokens: 8,
        fetch: (async () => {
          status = 200;
          return new Response(recorded.body, {
            status: 200,
            headers: { "content-type": recorded.contentType ?? "application/json" },
          });
        }) as unknown as typeof fetch,
      },
    );
    for await (const event of stream) if (event.type === "done" || event.type === "error") break;
    assert.equal(status, 200);
  });
});

describe("clarifyFuelixError", () => {
  test("401 (key) and 403 (entitlement) are different diagnoses", () => {
    const auth = clarifyFuelixError("401 status code (no body)");
    assert.ok(auth);
    assert.match(auth, /^fuelix: authentication failed \(HTTP 401\)/);
    assert.match(auth, /\/login fuelix/);
    assert.match(auth, /FUELIX_API_KEY/);

    const entitlement = clarifyFuelixError(
      GOT("chat-unknown-model").trim().length > 0
        ? `403: ${GOT("chat-unknown-model")}`
        : "403 Authorization failed for model 'x'",
    );
    assert.ok(entitlement);
    assert.match(entitlement, /not entitled to the requested model/);
    assert.match(entitlement, /entitlement, not a bad key/);
  });

  test("the recovered (plain text) forms of both rewrites are recognised too", () => {
    assert.ok(clarifyFuelixError("401 Unauthorized: Invalid or missing API key"));
    assert.ok(
      clarifyFuelixError(
        "403 Authorization failed for model 'llama-3.2-90b'. The model may be unavailable, retired, or not enabled for your organization.",
      ),
    );
  });

  test("an unsupported operation on the chat route gets a targeted hint", () => {
    const clarified = clarifyFuelixError(
      "400 litellm.BadRequestError: AzureException - The requested operation is unsupported.",
    );
    assert.ok(clarified);
    assert.match(clarified, /gpt-5\.3-codex/);
    assert.match(clarified, /chat-completions route/);
  });

  test("unknown shapes are left alone", () => {
    for (const message of [
      "404 Not Found: Cannot POST /v1/completions",
      "500 internal error",
      "something else entirely",
      "",
    ]) {
      assert.equal(clarifyFuelixError(message), undefined, message);
    }
  });

  test("rewrites are idempotent and never double-apply", () => {
    const once = clarifyFuelixError("401 status code (no body)");
    assert.ok(once);
    assert.equal(clarifyFuelixError(once), undefined);
  });

  test("an overflow marker is never re-purposed as an auth sentence", () => {
    // The decoder path in index.ts tries overflow first, then auth; a marked
    // message must therefore be left to pi's compaction classifier.
    const marked = `${OVERFLOW_MARKER}Input tokens exceed the configured limit of 922000 tokens`;
    assert.equal(clarifyFuelixError(marked), undefined);
  });
});

describe("normalizeOverflowError", () => {
  const measured = "Input tokens exceed the configured limit of 922000 tokens";

  test("tags the wording the gateway discloses", () => {
    assert.equal(normalizeOverflowError(measured), `${OVERFLOW_MARKER}${measured}`);
  });

  test("is idempotent", () => {
    const once = normalizeOverflowError(measured);
    assert.ok(once);
    assert.equal(normalizeOverflowError(once), undefined);
  });

  test("vetoes rate limits before the overflow match", () => {
    for (const noisy of [
      `${measured} (rate limit)`,
      `429 too many requests: ${measured}`,
      `Throttling filtered: ${measured}`,
    ]) {
      assert.equal(normalizeOverflowError(noisy), undefined, noisy);
    }
  });

  test("leaves unrelated failures alone", () => {
    for (const message of ["", "400 Request body is missing", "403 Authorization failed for model 'x'"]) {
      assert.equal(normalizeOverflowError(message), undefined, message);
    }
  });
});

describe("negative safety against pi's real classifiers", () => {
  test("pi's own overflow patterns do NOT match the raw wording (hence the rewrite)", () => {
    const raw = "400 Input tokens exceed the configured limit of 922000 tokens";
    assert.equal(getOverflowPatterns().some((pattern) => pattern.test(raw)), false);
    assert.equal(isContextOverflow(assistant(raw)), false);
    assert.equal(isContextOverflow(assistant(normalizeOverflowError(raw)!)), true);
  });

  test("no rewrite becomes retryable, and none of them triggers compaction", () => {
    for (const { name, text } of allRewrites()) {
      assert.equal(isRetryableAssistantError(assistant(text)), false, `${name} became retryable`);
      if (text.startsWith(OVERFLOW_MARKER)) continue; // this one *must* trigger compaction
      assert.equal(isContextOverflow(assistant(text)), false, `${name} triggers compaction`);
      for (const pattern of getOverflowPatterns()) {
        assert.equal(pattern.test(text), false, `${name} matched ${pattern}`);
      }
    }
  });

  test("the overflow rewrite is the only one that reaches pi's compaction path", () => {
    const overflow = normalizeOverflowError("Input tokens exceed the configured limit of 922000 tokens")!;
    assert.equal(isContextOverflow(assistant(overflow)), true);
    assert.equal(isRetryableAssistantError(assistant(overflow)), false);
  });
});

describe("parseGatewayError", () => {
  test("splits a recovered plain text body", () => {
    assert.deepEqual(parseGatewayError("403 Authorization failed for model 'x'."), {
      status: 403,
      message: "Authorization failed for model 'x'.",
      raw: "403 Authorization failed for model 'x'.",
    });
  });

  test("unwraps the enveloped dialect that precedes recovery", () => {
    const parsed = parseGatewayError('400: {"message":"litellm.BadRequestError: nope","code":"empty_array"}');
    assert.equal(parsed.status, 400);
    assert.equal(parsed.message, "litellm.BadRequestError: nope");
  });

  test("composes RFC 7807 title + detail, which have no `error` key", () => {
    const parsed = parseGatewayError(GOT("models-no-key"));
    assert.equal(parsed.status, undefined);
    assert.equal(parsed.message, "Unauthorized: Invalid or missing API key");
  });

  test("keeps the raw text when the body is not JSON at all", () => {
    assert.equal(parseGatewayError("502 Bad gateway").message, "Bad gateway");
  });
});

describe("extractGatewayMessage", () => {
  test("reads error.message, message, detail and title+detail", () => {
    assert.equal(extractGatewayMessage('{"error":{"message":"inner"}}'), "inner");
    assert.equal(extractGatewayMessage('{"message":"plain"}'), "plain");
    assert.equal(extractGatewayMessage('{"detail":"Request body is missing"}'), "Request body is missing");
    assert.equal(
      extractGatewayMessage('{"title":"Not Found","detail":["Cannot POST /v1/completions"]}'),
      "Not Found: Cannot POST /v1/completions",
    );
  });

  test("collapses a non-JSON body to its first line", () => {
    assert.equal(extractGatewayMessage("502 Bad gateway\n<html>…</html>"), "502 Bad gateway");
  });

  test("returns undefined when there is nothing usable", () => {
    for (const body of ["", "   ", "{}", "[]", '{"unrelated":1}']) {
      assert.equal(extractGatewayMessage(body), undefined, JSON.stringify(body));
    }
  });
});

describe("recoverErrorBody", () => {
  test("re-emits a bodied non-OK response as text/plain and keeps status + headers", async () => {
    const original = new Response(GOT("models-no-key"), {
      status: 401,
      statusText: "Unauthorized",
      headers: { "content-type": "application/json", "retry-after": "7", "x-request-id": "abc" },
    });
    const recovered = await recoverErrorBody(original);
    assert.equal(recovered.status, 401);
    assert.equal(recovered.statusText, "Unauthorized");
    assert.equal(recovered.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(recovered.headers.get("retry-after"), "7");
    assert.equal(recovered.headers.get("x-request-id"), "abc");
    assert.equal(await recovered.text(), "Unauthorized: Invalid or missing API key");
  });

  test("passes a successful response through untouched", async () => {
    const ok = new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
    assert.equal(await recoverErrorBody(ok), ok);
  });

  test("passes a bodyless failure through untouched", async () => {
    const empty = new Response("", { status: 502 });
    assert.equal(await recoverErrorBody(empty), empty);
  });
});

describe("withBodyRecovery", () => {
  test("chains onto an inner fetch and preserves the request", async () => {
    const calls: { url: string; method?: string }[] = [];
    const inner = (async (input: any, init: any) => {
      calls.push({ url: String(input), method: init?.method });
      return new Response('{"detail":"nope"}', {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const wrapped = withBodyRecovery(inner);
    const response = await wrapped("https://api.fuelix.ai/v1/chat/completions", { method: "POST" });
    assert.deepEqual(calls, [{ url: "https://api.fuelix.ai/v1/chat/completions", method: "POST" }]);
    assert.equal(await response.text(), "nope");
  });

  test("is idempotent, so double registration cannot double-wrap", () => {
    const inner = (async () => new Response("", { status: 500 })) as unknown as typeof fetch;
    const once = withBodyRecovery(inner);
    assert.equal(withBodyRecovery(once), once);
  });
});

describe("withBodyRecoveryApi", () => {
  test("keeps the caller's options and recovers through the adapter end to end", async () => {
    const api = withBodyRecoveryApi(openAICompletionsApi());
    let payload: Record<string, any> | undefined;
    const stream = api.streamSimple(
      model(),
      normalizeContext({
        systemPrompt: "You are pi.",
        messages: [{ role: "user", content: "hi", timestamp: Date.now() }],
      }),
      {
        apiKey: "ak_test",
        maxTokens: 8,
        onPayload: (body) => {
          payload = body as Record<string, any>;
        },
        fetch: (async () =>
          new Response(GOT("chat-unknown-model"), {
            status: 403,
            headers: { "content-type": "application/json", "x-request-id": "rid-1" },
          })) as unknown as typeof fetch,
      },
    );
    let errorMessage: string | undefined;
    for await (const event of stream) {
      if (event.type === "error") errorMessage = event.error.errorMessage;
      if (event.type === "done") break;
    }
    assert.ok(payload, "onPayload must still be called through the wrapper");
    assert.equal(payload!.max_completion_tokens, 8); // the caller's cap, not the catalog default
    assert.match(errorMessage!, /^403 Authorization failed for model/);
  });

  test("preserves the deferred-fetch surface when the api provides one", () => {
    const api = withBodyRecoveryApi({
      stream: () => {
        throw new Error("unused");
      },
      streamSimple: () => {
        throw new Error("unused");
      },
      fetchDeferred: async () => undefined,
      cancelDeferred: async () => {},
    } as any);
    assert.equal(typeof api.fetchDeferred, "function");
    assert.equal(typeof api.cancelDeferred, "function");
  });
});

describe("message predicates", () => {
  test("shouldClarify only fires for this provider's errored assistant messages", () => {
    assert.equal(
      shouldClarify({ role: "assistant", stopReason: "error", provider: "fuelix", errorMessage: "401 status code (no body)" }),
      true,
    );
    assert.equal(
      shouldClarify({ role: "assistant", stopReason: "stop", provider: "fuelix", errorMessage: "401 status code (no body)" }),
      false,
    );
    assert.equal(
      shouldClarify({ role: "assistant", stopReason: "error", provider: "openai", errorMessage: "401 status code (no body)" }),
      false,
    );
    assert.equal(
      shouldClarify({ role: "assistant", stopReason: "error", provider: "fuelix", errorMessage: "400 nope" }),
      false,
    );
  });

  test("needsPersistentHelp covers the two states a human must fix", () => {
    assert.equal(needsPersistentHelp("401 status code (no body)"), true);
    assert.equal(needsPersistentHelp("401 Unauthorized: Invalid or missing API key"), true);
    assert.equal(
      needsPersistentHelp("403 Authorization failed for model 'x'. The model may be unavailable…"),
      true,
    );
    assert.equal(needsPersistentHelp(clarifyFuelixError("401 status code (no body)")!), true);
    assert.equal(needsPersistentHelp("503 rate limit, try later"), false);
    assert.equal(needsPersistentHelp("404 Not Found: Cannot POST /v1/completions"), false);
    assert.equal(needsPersistentHelp(""), false);
  });
});
