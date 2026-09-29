/**
 * Fake-pi entry test: import the real extension default export with a stubbed
 * `ExtensionAPI`, assert the wiring, then drive both hooks with the message
 * shapes pi passes them. The preload aliases "@earendil-works/pi-ai" to the
 * compat entrypoint, which is what makes `index.ts` importable outside pi.
 */

import assert from "node:assert/strict";
import test, { describe, beforeEach } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fuelixExtension from "../index.ts";
import { OVERFLOW_MARKER } from "../errors.ts";

/**
 * Env coupling guard: the wiring must look the same whether or not the caller has
 * exported FUELIX_* (as the live harness expects), so ambient provider variables
 * are removed before every test here.
 */
beforeEach(() => {
  delete process.env.FUELIX_API_KEY;
  delete process.env.FUELIX_BASE_URL;
});

type Handler = (event: any, context?: any) => any;

function fakePi(): { pi: ExtensionAPI; handlers: Map<string, Handler[]>; providers: any[] } {
  const handlers = new Map<string, Handler[]>();
  const providers: any[] = [];
  const pi = {
    on: (event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => {};
    },
    registerProvider: (provider: any) => {
      providers.push(provider);
    },
    registerCommand: () => {},
  } as unknown as ExtensionAPI;
  return { pi, handlers, providers };
}

function run(handlers: Map<string, Handler[]>, event: string, payload: any, context?: any): any {
  let result: any;
  for (const handler of handlers.get(event) ?? []) result = handler(payload, context);
  return result;
}

function assistantMessage(overrides: Record<string, any> = {}) {
  return {
    role: "assistant",
    provider: "fuelix",
    stopReason: "stop",
    content: [],
    ...overrides,
  };
}

describe("extension wiring", () => {
  test("registers the fuelix provider and both hooks", () => {
    const { pi, handlers, providers } = fakePi();
    fuelixExtension(pi);
    assert.equal(providers.length, 1);
    assert.equal(providers[0].id, "fuelix");
    assert.equal(providers[0].name, "fuelix.ai");
    assert.equal(providers[0].getModels().length, 98);
    assert.deepEqual([...handlers.keys()].sort(), ["message_end", "turn_end"]);
  });
});

describe("message_end", () => {
  test("turns the dropped-body 401 into the key sentence", () => {
    const { pi, handlers } = fakePi();
    fuelixExtension(pi);
    const result = run(handlers, "message_end", {
      message: assistantMessage({ stopReason: "error", errorMessage: "401 status code (no body)" }),
    });
    assert.match(result.message.errorMessage, /^fuelix: authentication failed/);
    assert.match(result.message.errorMessage, /FUELIX_API_KEY/);
  });

  test("turns the 403 entitlement envelope into an entitlement sentence", () => {
    const { pi, handlers } = fakePi();
    fuelixExtension(pi);
    const result = run(handlers, "message_end", {
      message: assistantMessage({
        stopReason: "error",
        errorMessage:
          '403: {"message":"Authorization failed for model \'llama-3.2-90b\'. The model may be unavailable…","code":403}',
      }),
    });
    assert.match(result.message.errorMessage, /not entitled to the requested model/);
    assert.doesNotMatch(result.message.errorMessage, /authentication failed/);
  });

  test("tags the measured overflow wording so pi compacts instead of dying", () => {
    const { pi, handlers } = fakePi();
    fuelixExtension(pi);
    const result = run(handlers, "message_end", {
      message: assistantMessage({
        stopReason: "error",
        errorMessage: "400 Input tokens exceed the configured limit of 922000 tokens",
      }),
    });
    assert.equal(
      result.message.errorMessage,
      `${OVERFLOW_MARKER}400 Input tokens exceed the configured limit of 922000 tokens`,
    );
  });

  test("leaves other providers, other stop reasons and unknown shapes untouched", () => {
    const { pi, handlers } = fakePi();
    fuelixExtension(pi);
    assert.equal(
      run(handlers, "message_end", {
        message: assistantMessage({ provider: "openai", stopReason: "error", errorMessage: "401 status code (no body)" }),
      }),
      undefined,
    );
    assert.equal(
      run(handlers, "message_end", {
        message: assistantMessage({ provider: "fuelix", stopReason: "error", errorMessage: "400 Request body is missing" }),
      }),
      undefined,
    );
    assert.equal(run(handlers, "message_end", { message: { role: "user", content: "hi" } }), undefined);
    assert.equal(
      run(handlers, "message_end", { message: assistantMessage({ stopReason: "stop" }) }),
      undefined,
    );
  });

  test("does not replace a message it did not change (object identity preserved)", () => {
    const { pi, handlers } = fakePi();
    fuelixExtension(pi);
    const message = assistantMessage({ content: [{ type: "text", text: "hello" }] });
    assert.equal(run(handlers, "message_end", { message }), undefined);
  });
});

describe("turn_end", () => {
  const authMessage = assistantMessage({ stopReason: "error", errorMessage: "401 status code (no body)" });
  const entitlementMessage = assistantMessage({
    stopReason: "error",
    errorMessage: "403 Authorization failed for model 'gpt-5.3-codex'. The model may be unavailable…",
  });

  test("appends a deduped, persistent TUI note for a bad key", () => {
    const { pi, handlers } = fakePi();
    fuelixExtension(pi);
    const result = run(
      handlers,
      "turn_end",
      { outcome: "error", message: authMessage, entries: [] },
      { hasUI: true },
    );
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0].customType, "fuelix-help");
    assert.equal(result.entries[0].display, true);
    assert.equal(run(handlers, "turn_end", { outcome: "error", message: authMessage, entries: result.entries }, { hasUI: true }), undefined);
  });

  test("also notes an entitlement failure, which is a different human action", () => {
    const { pi, handlers } = fakePi();
    fuelixExtension(pi);
    const result = run(
      handlers,
      "turn_end",
      { outcome: "error", message: entitlementMessage, entries: [] },
      { hasUI: true },
    );
    assert.equal(result.entries.length, 1);
    assert.match(result.entries[0].content, /not entitled to that model/);
  });

  test("stays silent in print mode so `pi -p` still prints the error", () => {
    // An entry appended after the errored assistant message makes `pi -p` print
    // nothing at all, which is why index.ts gates the note on `ctx.hasUI`.
    const { pi, handlers } = fakePi();
    fuelixExtension(pi);
    assert.equal(
      run(handlers, "turn_end", { outcome: "error", message: authMessage, entries: [] }, { hasUI: false }),
      undefined,
    );
  });

  test("stays silent for a successful turn, another provider, or a transient failure", () => {
    const { pi, handlers } = fakePi();
    fuelixExtension(pi);
    const context = { hasUI: true };
    assert.equal(run(handlers, "turn_end", { outcome: "success", message: authMessage, entries: [] }, context), undefined);
    assert.equal(
      run(
        handlers,
        "turn_end",
        { outcome: "error", message: assistantMessage({ provider: "openai", stopReason: "error", errorMessage: "401 status code (no body)" }), entries: [] },
        context,
      ),
      undefined,
    );
    assert.equal(
      run(handlers, "turn_end", { outcome: "error", message: assistantMessage({ stopReason: "error", errorMessage: "429 too many requests" }), entries: [] }, context),
      undefined,
    );
  });
});
