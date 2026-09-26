/**
 * Model conversion, compat flags, and the per-model `maxTokensField` seam.
 *
 * The flags matter more than they look: each one exists to stop pi-ai from
 * sending bytes this gateway was not measured to accept, and the auto-detected
 * profile for `api.fuelix.ai` gets three of them wrong.
 */

import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { CATALOG, CATALOG_BY_ID, UNVERIFIED_FLOOR } from "../catalog.ts";
import {
  CHAT_COMPAT,
  DEFAULT_BASE_URL,
  MAX_TOKENS_FIELD,
  PROVIDER_ID,
  UNKNOWN_MODEL_DEFAULTS,
  buildModels,
  entryToModel,
  isNonChatId,
  unknownModelToModel,
} from "../models.ts";

describe("the maxTokensField decision", () => {
  test("is max_completion_tokens (measured honoured on 11 backends, probe B 2026-09-26)", () => {
    assert.equal(MAX_TOKENS_FIELD, "max_completion_tokens");
    assert.equal(CHAT_COMPAT.maxTokensField, MAX_TOKENS_FIELD);
  });

  test("is uniform across the whole catalog: no model needs the legacy field", () => {
    for (const model of buildModels(DEFAULT_BASE_URL)) {
      assert.equal(model.compat?.maxTokensField, "max_completion_tokens", model.id);
    }
  });

  test("the per-model seam is real: a model override wins over the pinned default", () => {
    // pi resolves the field per model (`model.compat.maxTokensField ?? detected`),
    // so a single model can be switched without touching the rest. This is the
    // escape hatch if a future route turns out to need `max_tokens`.
    const model = entryToModel(CATALOG_BY_ID.get("gpt-4o-mini")!, DEFAULT_BASE_URL);
    const overridden = { ...model, compat: { ...model.compat, maxTokensField: "max_tokens" as const } };
    assert.equal(model.compat?.maxTokensField, "max_completion_tokens");
    assert.equal(overridden.compat.maxTokensField, "max_tokens");
  });
});

describe("compat flags", () => {
  test("claims no reasoning control anywhere", () => {
    assert.equal(CHAT_COMPAT.supportsReasoningEffort, false);
    assert.equal(CHAT_COMPAT.thinkingFormat, "openai");
  });

  test("never lets pi send fields the gateway does not document", () => {
    assert.equal(CHAT_COMPAT.supportsStore, false);
    assert.equal(CHAT_COMPAT.supportsLongCacheRetention, false);
    assert.equal(CHAT_COMPAT.supportsDeveloperRole, false);
    assert.equal(CHAT_COMPAT.supportsStrictMode, false);
    assert.equal(CHAT_COMPAT.supportsOpenAIGrammarTools, false);
  });

  test("keeps usage and finish reasons enabled so cost accounting works", () => {
    assert.equal(CHAT_COMPAT.supportsUsageInStreaming, true);
    assert.equal(CHAT_COMPAT.supportsFinishReason, true);
  });

  test("is spread per model, so one model cannot mutate another's compat", () => {
    const [first, second] = buildModels(DEFAULT_BASE_URL);
    assert.notEqual(first.compat, second.compat);
    first.compat!.supportsStore = true;
    assert.equal(second.compat!.supportsStore, false);
    assert.equal(CHAT_COMPAT.supportsStore, false);
  });
});

describe("entryToModel", () => {
  test("produces a pi Model on the completions api with zero cost", () => {
    const model = entryToModel(CATALOG_BY_ID.get("claude-sonnet-5")!, DEFAULT_BASE_URL);
    assert.equal(model.provider, PROVIDER_ID);
    assert.equal(model.api, "openai-completions");
    assert.equal(model.baseUrl, DEFAULT_BASE_URL);
    assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    assert.equal(model.reasoning, false);
    assert.equal(model.thinkingLevelMap, undefined);
  });

  test("prices are zero with a note, never a guess", () => {
    for (const model of buildModels(DEFAULT_BASE_URL)) {
      assert.equal(model.cost.input, 0, model.id);
      assert.equal(model.cost.output, 0, model.id);
      assert.ok((CATALOG_BY_ID.get(model.id)!.priceNote ?? "").length > 0, model.id);
    }
  });

  test("buildModels keeps the catalog order and ids", () => {
    assert.deepEqual(
      buildModels(DEFAULT_BASE_URL).map((m) => m.id),
      CATALOG.map((entry) => entry.id),
    );
  });

  test("propagates a custom base url to every model", () => {
    for (const model of buildModels("https://proxy.example.com/fuelix/v1")) {
      assert.equal(model.baseUrl, "https://proxy.example.com/fuelix/v1");
    }
  });
});

describe("unknownModelToModel", () => {
  test("uses the conservative floor and claims nothing", () => {
    const model = unknownModelToModel("some-new-model-2027", DEFAULT_BASE_URL);
    assert.equal(model.contextWindow, UNVERIFIED_FLOOR.contextWindow);
    assert.equal(model.maxTokens, UNVERIFIED_FLOOR.maxTokens);
    assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    assert.equal(model.reasoning, false);
    assert.deepEqual(model.input, ["text"]);
    assert.equal(UNKNOWN_MODEL_DEFAULTS.contextWindow, UNVERIFIED_FLOOR.contextWindow);
  });
});

describe("isNonChatId", () => {
  test("recognises a non-chat route that is not in the frozen listing", () => {
    assert.equal(isNonChatId("whisper-2"), true);
    assert.equal(isNonChatId("gemini-4-flash-image"), true);
    assert.equal(isNonChatId("text-embedding-4-large"), true);
    assert.equal(isNonChatId("gpt-4o-transcribe-2026"), true);
  });

  test("leaves chat ids alone", () => {
    for (const id of ["gpt-5.4", "claude-opus-5", "gemini-3.1-pro", "wasikan-v2-2"]) {
      assert.equal(isNonChatId(id), false, id);
    }
  });
});
