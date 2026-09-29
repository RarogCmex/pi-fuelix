/**
 * Discovery: the additive, unknowns-only `/v1/models` overlay.
 *
 * `GET /v1/models` is authenticated here (401 without a key, recorded in
 * `test/fixtures/error-bodies.json`), so the refresh must carry the key. Its
 * entries carry no caps or prices, which is exactly why the overlay can only add
 * ids — never "improve" a curated row.
 */

import assert from "node:assert/strict";
import test, { describe, afterEach, beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import { CATALOG_BY_ID, UNVERIFIED_FLOOR } from "../catalog.ts";
import { buildOverlay, fetchFuelixModels, parseModelIds, resolveDiscoveryKey } from "../discovery.ts";
import { DEFAULT_BASE_URL } from "../models.ts";

const realFetch = globalThis.fetch;

/**
 * Env coupling guard: this suite must pass whether or not the caller has
 * `FUELIX_*` exported (e.g. because they just ran the live harness in the same
 * shell), so the ambient provider variables are removed for the duration and
 * restored after.
 */
const AMBIENT = ["FUELIX_API_KEY", "FUELIX_BASE_URL"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const name of AMBIENT) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const name of AMBIENT) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

function makeContext(overrides: Partial<RefreshModelsContext> = {}): RefreshModelsContext {
  return {
    allowNetwork: true,
    signal: new AbortController().signal,
    publish: async () => true,
    ...overrides,
  } as RefreshModelsContext;
}

const payload = (...ids: string[]) => ({
  object: "list",
  data: ids.map((id) => ({ id, object: "model", created: 1790421394, owned_by: "account" })),
});

const recordedListing = JSON.parse(
  readFileSync(new URL("./fixtures/models-listing.json", import.meta.url), "utf8"),
) as { data: { id: string }[] };

describe("parseModelIds", () => {
  test("reads the recorded 111-id listing", () => {
    const ids = parseModelIds(recordedListing);
    assert.equal(ids.length, 111);
    assert.ok(ids.includes("gpt-5.4"));
    assert.ok(ids.includes("dall-e-3"));
  });

  test("dedupes and trims", () => {
    assert.deepEqual(parseModelIds(payload("gpt-5.4", " gpt-5.4 ", "tycho-1.0")), [
      "gpt-5.4",
      "tycho-1.0",
    ]);
  });

  test("survives malformed payloads", () => {
    assert.deepEqual(parseModelIds(null), []);
    assert.deepEqual(parseModelIds({}), []);
    assert.deepEqual(parseModelIds({ data: "nope" }), []);
    assert.deepEqual(parseModelIds({ data: [null, 1, {}, { id: "" }] }), []);
  });
});

describe("buildOverlay", () => {
  test("the recorded listing adds nothing: every chat id is already curated", () => {
    assert.deepEqual(buildOverlay(parseModelIds(recordedListing), DEFAULT_BASE_URL), []);
  });

  test("keeps known ids out so curated data wins", () => {
    assert.deepEqual(buildOverlay(["gpt-5.4", "claude-sonnet-5"], DEFAULT_BASE_URL), []);
  });

  test("adds an unknown id with the conservative floor and zero cost", () => {
    const overlay = buildOverlay(["brand-new-model"], DEFAULT_BASE_URL);
    assert.equal(overlay.length, 1);
    assert.equal(overlay[0].id, "brand-new-model");
    assert.equal(overlay[0].contextWindow, UNVERIFIED_FLOOR.contextWindow);
    assert.equal(overlay[0].maxTokens, UNVERIFIED_FLOOR.maxTokens);
    assert.equal(overlay[0].reasoning, false);
    assert.deepEqual(overlay[0].cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    assert.equal(CATALOG_BY_ID.has("brand-new-model"), false);
  });

  test("filters non-chat routes out of the overlay even when they are unknown", () => {
    // The overlay is the second chance for a `dall-e-4`/`whisper-2` to reach the
    // chat picker; the curated exclusion list cannot catch an id it has never seen.
    const overlay = buildOverlay(
      ["dall-e-4", "whisper-2", "text-embedding-4-large", "gemini-4-pro-image", "real-chat-model"],
      DEFAULT_BASE_URL,
    );
    assert.deepEqual(overlay.map((model) => model.id), ["real-chat-model"]);
  });
});

describe("resolveDiscoveryKey", () => {
  test("prefers the refresh credential and trims it", () => {
    const key = resolveDiscoveryKey(
      makeContext({ credential: { type: "api_key", key: "  ak_cred \n" } as any }),
      () => "ak_env",
    );
    assert.equal(key, "ak_cred");
  });

  test("falls back to the environment variable", () => {
    assert.equal(resolveDiscoveryKey(makeContext(), () => "  ak_env\n"), "ak_env");
  });

  test("reports no key when neither source has one", () => {
    assert.equal(resolveDiscoveryKey(makeContext(), () => undefined), undefined);
    assert.equal(resolveDiscoveryKey(makeContext(), () => "   "), undefined);
    assert.equal(
      resolveDiscoveryKey(makeContext({ credential: { type: "oauth" } as any }), () => ""),
      undefined,
    );
  });
});

describe("fetchFuelixModels", () => {
  test("returns [] without a key and never dials out", async () => {
    let called = 0;
    globalThis.fetch = (async () => {
      called++;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    assert.deepEqual(await fetchFuelixModels(DEFAULT_BASE_URL, makeContext()), []);
    assert.equal(called, 0);
  });

  test("returns [] when the refresh context forbids network access", async () => {
    assert.deepEqual(
      await fetchFuelixModels(
        DEFAULT_BASE_URL,
        makeContext({ allowNetwork: false, credential: { type: "api_key", key: "ak_x" } as any }),
      ),
      [],
    );
  });

  test("returns [] when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    assert.deepEqual(
      await fetchFuelixModels(
        DEFAULT_BASE_URL,
        makeContext({ signal: controller.signal, credential: { type: "api_key", key: "ak_x" } as any }),
      ),
      [],
    );
  });

  test("sends the key and overlays only the unknown, non-chat ids", async () => {
    let seenUrl: string | undefined;
    let seenAuth: string | null = null;
    globalThis.fetch = (async (input: any, init: any) => {
      seenUrl = String(input);
      seenAuth = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify(payload("gpt-5.4", "brand-new-model", "whisper-2")), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const models = await fetchFuelixModels(
      `${DEFAULT_BASE_URL}/`,
      makeContext({ credential: { type: "api_key", key: "ak_live" } as any }),
    );
    assert.equal(seenUrl, "https://api.fuelix.ai/v1/models");
    assert.equal(seenAuth, "Bearer ak_live");
    assert.deepEqual(models.map((model) => model.id), ["brand-new-model"]);
  });

  test("never throws: a rejected fetch, a bad status and a bad body all yield []", async () => {
    const key = { credential: { type: "api_key", key: "ak_live" } as any };
    globalThis.fetch = (async () => {
      throw new Error("ENOTFOUND");
    }) as unknown as typeof fetch;
    assert.deepEqual(await fetchFuelixModels(DEFAULT_BASE_URL, makeContext(key)), []);

    globalThis.fetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    assert.deepEqual(await fetchFuelixModels(DEFAULT_BASE_URL, makeContext(key)), []);

    globalThis.fetch = (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
    assert.deepEqual(await fetchFuelixModels(DEFAULT_BASE_URL, makeContext(key)), []);
  });
});
