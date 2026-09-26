/**
 * Catalog invariants. These test the *data*: a hand-edited row that breaks a rule
 * fails here rather than at runtime against a paid gateway.
 */

import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { readFileSync } from "node:fs";
import {
  CATALOG,
  CATALOG_BY_ID,
  EXCLUDED_PATTERN,
  LISTED_CHAT_IDS,
  MEASURED_IDS,
  NON_CHAT_IDS,
  UNVERIFIED_FLOOR,
  displayName,
} from "../catalog.ts";

/** The recorded `GET /v1/models` body (2026-09-26, key from secret.env). */
const listing = JSON.parse(
  readFileSync(new URL("./fixtures/models-listing.json", import.meta.url), "utf8"),
) as { data: { id: string }[] };
const listedIds = listing.data.map((entry) => entry.id);

describe("the frozen listing", () => {
  test("the gateway lists 111 ids, 98 chat + 13 non-chat", () => {
    assert.equal(listedIds.length, 111);
    assert.equal(LISTED_CHAT_IDS.length, 98);
    assert.equal(NON_CHAT_IDS.length, 13);
    assert.equal(CATALOG.length, 98);
  });

  test("catalog ids + excluded ids are exactly the recorded listing", () => {
    const combined = [...LISTED_CHAT_IDS, ...NON_CHAT_IDS].sort();
    assert.deepEqual(combined, [...listedIds].sort());
  });

  test("catalog ids are unique and match the map", () => {
    assert.equal(new Set(LISTED_CHAT_IDS).size, LISTED_CHAT_IDS.length);
    assert.equal(CATALOG_BY_ID.size, CATALOG.length);
  });

  test("the correction to the handoff: 13 non-chat ids, not ~10", () => {
    // The handoff said "~10 are non-chat"; the listing shows 13. The two extra
    // are the audio transcribers, which must not reach a chat picker either.
    for (const id of ["gpt-4o-transcribe", "gpt-4o-transcribe-2025-03-20"]) {
      assert.ok(NON_CHAT_IDS.includes(id), `${id} must be excluded`);
      assert.equal(CATALOG_BY_ID.has(id), false);
    }
  });
});

describe("exclusions", () => {
  test("EXCLUDED_PATTERN matches every non-chat id", () => {
    for (const id of NON_CHAT_IDS) {
      assert.ok(EXCLUDED_PATTERN.test(id), `${id} should be filtered from a live overlay`);
    }
  });

  test("EXCLUDED_PATTERN matches none of the chat ids", () => {
    // A false positive would silently drop a chat model from a future overlay.
    for (const id of LISTED_CHAT_IDS) {
      assert.equal(EXCLUDED_PATTERN.test(id), false, `${id} must not be filtered`);
    }
  });
});

describe("every catalog entry", () => {
  const entries = CATALOG;

  test("has a window, a cap and the window is not smaller than the cap", () => {
    for (const entry of entries) {
      assert.ok(entry.contextWindow > 0, entry.id);
      assert.ok(entry.maxTokens > 0, entry.id);
      assert.ok(entry.contextWindow >= entry.maxTokens, `${entry.id}: window < cap`);
    }
  });

  test("claims text input only, and no reasoning control", () => {
    for (const entry of entries) {
      assert.deepEqual(entry.input, ["text"], entry.id);
      assert.equal(entry.reasoning, false, `${entry.id}: reasoning control is unverified`);
    }
  });

  test("carries a provenance marker and a price note", () => {
    for (const entry of entries) {
      assert.ok(entry.priceNote.length > 0, entry.id);
      assert.ok(["measured", "floor"].includes(entry.provenance), entry.id);
      if (entry.provenance === "floor") {
        assert.equal(entry.contextWindow, UNVERIFIED_FLOOR.contextWindow, entry.id);
        assert.equal(entry.maxTokens, UNVERIFIED_FLOOR.maxTokens, entry.id);
      }
    }
  });

  test("exactly the ids the recon bought carry measured numbers", () => {
    const measured = entries.filter((entry) => entry.provenance === "measured").map((e) => e.id);
    assert.deepEqual(measured.sort(), [...MEASURED_IDS].sort());
    // The three bought measurements (plus their same-deployment aliases).
    assert.deepEqual(
      measured.sort(),
      ["claude-sonnet-5", "cursor-c-sonnet-5", "gpt-4o-mini", "gpt-4o-mini-2024-07-18", "gpt-5.4", "gpt-5.4-2026-03-05"],
    );
  });

  test("the measured rows keep the bought caps, not a floor", () => {
    assert.deepEqual(
      [CATALOG_BY_ID.get("gpt-5.4")!.contextWindow, CATALOG_BY_ID.get("gpt-5.4")!.maxTokens],
      [922_000, 128_000],
    );
    assert.deepEqual(
      [CATALOG_BY_ID.get("gpt-4o-mini")!.contextWindow, CATALOG_BY_ID.get("gpt-4o-mini")!.maxTokens],
      [128_000, 16_384],
    );
    assert.deepEqual(
      [
        CATALOG_BY_ID.get("claude-sonnet-5")!.contextWindow,
        CATALOG_BY_ID.get("claude-sonnet-5")!.maxTokens,
      ],
      [1_000_000, 128_000],
    );
  });

  test("gpt-5.4's window is labelled as a deployment input limit, not a context window", () => {
    assert.match(CATALOG_BY_ID.get("gpt-5.4")!.priceNote, /input admission limit|input limit|922000/);
  });
});

describe("displayName", () => {
  test("renders ids readably without inventing information", () => {
    assert.equal(displayName("gpt-4o-mini"), "GPT-4o-Mini");
    assert.equal(displayName("claude-sonnet-4-5"), "Claude-Sonnet-4-5");
    assert.equal(displayName("gpt-oss-20b"), "GPT-OSS-20B");
    assert.equal(displayName("gemma-4-26b-a4b-it"), "Gemma-4-26B-A4B-IT");
    assert.equal(displayName("tycho-1.0"), "Tycho-1.0");
  });

  test("every catalog entry has a non-empty name", () => {
    for (const entry of CATALOG) assert.ok(entry.name.length > 0, entry.id);
  });
});
