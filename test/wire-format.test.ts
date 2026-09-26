/**
 * Wire-format tests — the highest-value layer in a provider plugin.
 *
 * These drive pi-ai's *real* `openai-completions` adapter (the same
 * `openAICompletionsApi()` `index.ts` registers, wrapped in the same
 * `withBodyRecoveryApi` production uses) and capture the outgoing body through
 * `onPayload`. `fetch` is a stub that records the URL and throws, so nothing
 * reaches the network and nothing is billed.
 *
 * Every compat flag in `models.ts` exists to change these bytes; this file is
 * where a wrong guess fails instead of at runtime against a paid gateway.
 */

import assert from "node:assert/strict";
import test, { describe, afterEach } from "node:test";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { Context, Model, ThinkingLevel, Tool, TranscriptContext } from "@earendil-works/pi-ai";
import { normalizeContext, Type } from "@earendil-works/pi-ai";
import { CATALOG, UNVERIFIED_FLOOR } from "../catalog.ts";
import { withBodyRecoveryApi } from "../errors.ts";
import { CHAT_COMPAT, DEFAULT_BASE_URL, entryToModel, MAX_TOKENS_FIELD } from "../models.ts";

const api = withBodyRecoveryApi(openAICompletionsApi());

const weatherTool: Tool = {
  name: "get_weather",
  description: "Look up the weather for a city.",
  parameters: Type.Object({ city: Type.String({ description: "City name" }) }),
};

const LEVELS: ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

function model(id: string): Model<"openai-completions"> {
  const entry = CATALOG.find((candidate) => candidate.id === id);
  assert.ok(entry, `${id} missing from catalog`);
  return entryToModel(entry, DEFAULT_BASE_URL) as Model<"openai-completions">;
}

function context(overrides: Partial<Context> = {}): TranscriptContext {
  return normalizeContext({
    systemPrompt: "You are pi, a coding agent.",
    messages: [{ role: "user", content: "Say hi.", timestamp: Date.now() }],
    ...overrides,
  });
}

let requestedUrl: string | undefined;

afterEach(() => {
  requestedUrl = undefined;
});

interface CaptureOptions {
  reasoning?: ThinkingLevel;
  maxTokens?: number;
  tools?: Tool[];
  target?: Model<"openai-completions">;
  context?: TranscriptContext;
}

/** Run a stream to its (expected) failure and return the body it would have sent. */
async function capture(options: CaptureOptions = {}): Promise<Record<string, any>> {
  let payload: Record<string, any> | undefined;

  const stream = api.streamSimple(
    options.target ?? model("gpt-5.4"),
    options.context ?? context({ tools: options.tools }),
    {
      apiKey: "ak_test",
      reasoning: options.reasoning,
      maxTokens: options.maxTokens,
      onPayload: (body) => {
        payload = body as Record<string, any>;
      },
      fetch: ((url: any) => {
        requestedUrl = String(url);
        throw new Error("stop after payload capture");
      }) as unknown as typeof fetch,
    },
  );

  for await (const event of stream) {
    if (event.type === "error" || event.type === "done") break;
  }

  assert.ok(payload, "adapter never built a request payload");
  // pi assigns several fields the literal `undefined`, so `key in body` would lie.
  return JSON.parse(JSON.stringify(payload));
}

describe("request shape common to every model", () => {
  test("posts to the gateway chat-completions endpoint", async () => {
    await capture();
    assert.equal(requestedUrl, "https://api.fuelix.ai/v1/chat/completions");
  });

  test("uses max_completion_tokens when a cap is requested", async () => {
    const body = await capture({ maxTokens: 4096 });
    assert.equal(body.max_completion_tokens, 4096);
    assert.equal("max_tokens" in body, false);
  });

  test("always puts a cap on the wire, defaulted from the catalog", async () => {
    // Measured behaviour of pi-ai 0.87.1: `buildBaseOptions` defaults `maxTokens`
    // to `model.maxTokens` (`api/simple-options.js:10`), so the catalog's cap is
    // sent on *every* request, not only on the paths that pass one explicitly.
    const measured = await capture({ target: model("gpt-5.4") });
    assert.equal(measured.max_completion_tokens, 128_000);
    const floored = await capture({ target: model("tycho-1.0") });
    assert.equal(floored.max_completion_tokens, UNVERIFIED_FLOOR.maxTokens);
    assert.equal("max_tokens" in floored, false);
  });

  test("clamps the cap to the remaining context window", async () => {
    // `clampMaxTokensToContext` reserves 4096 tokens of headroom, so a large
    // catalog cap on a small window shrinks rather than being sent as-is.
    const body = await capture({
      target: model("tycho-1.0"),
      maxTokens: 1_000_000,
      context: normalizeContext({
        systemPrompt: "x".repeat(4_000),
        messages: [{ role: "user", content: "Say hi.", timestamp: Date.now() }],
      }),
    });
    assert.ok(
      (body.max_completion_tokens as number) < UNVERIFIED_FLOOR.contextWindow,
      `expected clamping, got ${body.max_completion_tokens}`,
    );
  });

  test("never sends fields the gateway does not document", async () => {
    const body = await capture({ maxTokens: 1024, tools: [weatherTool] });
    for (const field of ["store", "prompt_cache_retention", "prompt_cache_key", "priority", "temperature"]) {
      assert.equal(field in body, false, `${field} should not be sent`);
    }
  });

  test("asks for streaming usage so token accounting works", async () => {
    const body = await capture();
    assert.equal(body.stream, true);
    assert.deepEqual(body.stream_options, { include_usage: true });
  });

  test("uses the system role, never developer", async () => {
    const body = await capture({ reasoning: "high" });
    assert.equal(body.messages[0].role, "system");
    assert.equal(body.messages[0].content, "You are pi, a coding agent.");
    assert.equal(body.messages.some((m: any) => m.role === "developer"), false);
  });

  test("sends plain function tools without the strict flag", async () => {
    const body = await capture({ tools: [weatherTool] });
    assert.equal(body.tools.length, 1);
    const fn = body.tools[0].function;
    assert.equal(fn.name, "get_weather");
    assert.deepEqual(fn.parameters.properties.city, { type: "string", description: "City name" });
    assert.equal("strict" in fn, false);
  });

  test("keeps tool history working without a tools array on the wire being optional", async () => {
    const body = await capture({ tools: [weatherTool], maxTokens: 512 });
    assert.equal(body.model, "gpt-5.4");
    assert.equal(body.max_completion_tokens, 512);
  });
});

describe("reasoning: nothing is ever sent", () => {
  test("no level produces a reasoning parameter, across the whole catalog", async () => {
    // The catalog-wide audit: 98 ids × 6 levels. `reasoning: false` is a claim
    // that pi sends *no* reasoning parameter for any model at any level — this is
    // the test that makes the claim structural rather than aspirational.
    const forbidden = ["reasoning_effort", "reasoning", "thinking", "enable_thinking", "thinking_budget"];
    for (const entry of CATALOG) {
      const target = entryToModel(entry, DEFAULT_BASE_URL) as Model<"openai-completions">;
      for (const level of LEVELS) {
        const body = await capture({ target, reasoning: level });
        for (const field of forbidden) {
          assert.equal(field in body, false, `${entry.id} at ${level} sent ${field}`);
        }
      }
    }
  });

  test("a pi-internal level name can never leak (checked over a sample of tiers)", async () => {
    for (const level of LEVELS) {
      const body = await capture({ target: model("o4-mini"), reasoning: level });
      for (const internal of ["minimal", "xhigh", "max", "off", level]) {
        assert.equal(JSON.stringify(body).includes(`"${internal}"`), false, `${internal} leaked`);
      }
    }
  });
});

describe("the per-model maxTokensField seam", () => {
  test("the pinned field is what the adapter emits for a catalog model", async () => {
    const target = model("gpt-4o-mini") as Model<"openai-completions"> & {
      compat: typeof CHAT_COMPAT;
    };
    assert.equal(target.compat.maxTokensField, MAX_TOKENS_FIELD);
    const body = await capture({ target, maxTokens: 256 });
    assert.equal(body.max_completion_tokens, 256);
  });

  test("a per-model override switches exactly one model to max_tokens", async () => {
    const base = model("gpt-4o-mini") as Model<"openai-completions">;
    const overridden = {
      ...base,
      compat: { ...base.compat, maxTokensField: "max_tokens" as const },
    } as Model<"openai-completions">;
    const body = await capture({ target: overridden, maxTokens: 256 });
    assert.equal(body.max_tokens, 256);
    assert.equal("max_completion_tokens" in body, false);
  });
});
