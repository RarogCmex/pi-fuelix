/**
 * Provider assembly, base-url resolution and the auth flow (including the
 * zero-inference key probe `/login` uses).
 */

import assert from "node:assert/strict";
import test, { describe, afterEach } from "node:test";
import type { AuthContext, ProviderAuthInteraction, ProviderStreams } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { CATALOG } from "../catalog.ts";
import { DEFAULT_BASE_URL, PROVIDER_ID } from "../models.ts";
import {
  API_KEY_AUTH_NAME,
  API_KEY_ENV_VAR,
  BASE_URL_ENV_VAR,
  buildFuelixProvider,
  fuelixApiKeyAuth,
  probeKey,
  resolveBaseUrl,
} from "../provider.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  // The preload's throwing global fetch is restored so an accidental dial-out in
  // another test still fails loudly.
  globalThis.fetch = realFetch;
});

const unused: ProviderStreams = {
  stream: () => {
    throw new Error("not used");
  },
  streamSimple: () => {
    throw new Error("not used");
  },
};

const respondWith = (status: number, body = "{}"): typeof fetch =>
  (async () => new Response(body, { status })) as unknown as typeof fetch;

function authContext(env: Record<string, string>): AuthContext {
  return {
    env: async (name: string) => env[name],
    fileExists: async () => false,
  };
}

function interaction(entered: string): ProviderAuthInteraction & {
  notifications: { message: string; links?: readonly { url: string; label?: string }[] }[];
} {
  const notifications: { message: string; links?: readonly { url: string; label?: string }[] }[] = [];
  return {
    signal: new AbortController().signal,
    notifications,
    notify: (event) => {
      if (event.type === "info") notifications.push({ message: event.message, links: event.links });
    },
    prompt: async () => entered,
  };
}

describe("resolveBaseUrl", () => {
  test("defaults to the gateway v1 endpoint", () => {
    assert.equal(resolveBaseUrl(() => undefined), DEFAULT_BASE_URL);
    assert.equal(DEFAULT_BASE_URL, "https://api.fuelix.ai/v1");
  });

  test("honours an override, trimmed and without a trailing slash", () => {
    assert.equal(
      resolveBaseUrl(() => "  https://proxy.example.com/fuelix/v1///  "),
      "https://proxy.example.com/fuelix/v1",
    );
  });

  test("ignores a blank override", () => {
    assert.equal(resolveBaseUrl(() => "   "), DEFAULT_BASE_URL);
  });

  test("reads the documented env var", () => {
    assert.equal(BASE_URL_ENV_VAR, "FUELIX_BASE_URL");
  });
});

describe("probeKey (the zero-inference key check)", () => {
  test("401 means the key is rejected", async () => {
    assert.equal(await probeKey("ak_bad", DEFAULT_BASE_URL, respondWith(401)), "invalid");
  });

  test("anything else means the key authenticated — the probe is a rejection, never an inference", async () => {
    for (const status of [400, 403, 429, 200]) {
      assert.equal(await probeKey("ak_ok", DEFAULT_BASE_URL, respondWith(status)), "valid", String(status));
    }
  });

  test("a network failure is unknown, never invalid (login must work offline)", async () => {
    const failing = (async () => {
      throw new Error("ENOTFOUND");
    }) as unknown as typeof fetch;
    assert.equal(await probeKey("ak_ok", DEFAULT_BASE_URL, failing), "unknown");
  });

  test("posts an empty JSON body to chat/completions — the shape that costs nothing", async () => {
    let seenUrl: string | undefined;
    let seenBody: string | undefined;
    let seenAuth: string | null = null;
    const fetchImpl = (async (input: any, init: any) => {
      seenUrl = String(input);
      seenBody = init?.body;
      seenAuth = new Headers(init?.headers).get("authorization");
      return new Response('{"detail":"Request body is missing"}', { status: 400 });
    }) as unknown as typeof fetch;
    assert.equal(await probeKey("ak_probe", "https://api.fuelix.ai/v1/", fetchImpl), "valid");
    assert.equal(seenUrl, "https://api.fuelix.ai/v1/chat/completions");
    assert.equal(seenBody, "{}");
    assert.equal(seenAuth, "Bearer ak_probe");
  });
});

describe("api key auth", () => {
  test("is named for the /login list", () => {
    const auth = fuelixApiKeyAuth(() => DEFAULT_BASE_URL, respondWith(400));
    assert.equal(auth.name, API_KEY_AUTH_NAME);
    assert.equal(API_KEY_ENV_VAR, "FUELIX_API_KEY");
  });

  test("login trims whitespace and saves a key the gateway accepts", async () => {
    const auth = fuelixApiKeyAuth(() => DEFAULT_BASE_URL, respondWith(400));
    const credential = await auth.login!(interaction("  ak-abc123\n"));
    assert.deepEqual(credential, { type: "api_key", key: "ak-abc123" });
  });

  test("login refuses an empty key without probing", async () => {
    let calls = 0;
    const counting = (async () => {
      calls++;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const auth = fuelixApiKeyAuth(() => DEFAULT_BASE_URL, counting);
    await assert.rejects(() => auth.login!(interaction("   \n")), /No API key entered/);
    assert.equal(calls, 0);
  });

  test("login rejects a key the gateway answers 401 for", async () => {
    const auth = fuelixApiKeyAuth(() => DEFAULT_BASE_URL, respondWith(401));
    await assert.rejects(() => auth.login!(interaction("ak-revoked")), /rejected this key with 401/);
  });

  test("login warns about an unexpected shape but still checks and saves it", async () => {
    const auth = fuelixApiKeyAuth(() => DEFAULT_BASE_URL, respondWith(400));
    const ui = interaction("some-other-format");
    const credential = await auth.login!(ui);
    assert.equal(credential.key, "some-other-format");
    assert.equal(ui.notifications.length, 2);
    assert.match(ui.notifications[1].message, /does not look like a fuelix key/);
  });

  test("login saves the key when the gateway is unreachable, and says so", async () => {
    const failing = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const auth = fuelixApiKeyAuth(() => DEFAULT_BASE_URL, failing);
    const ui = interaction("ak-offline");
    const credential = await auth.login!(ui);
    assert.equal(credential.key, "ak-offline");
    assert.ok(ui.notifications.some((n) => /Could not reach the gateway/.test(n.message)));
  });

  test("resolve prefers the stored credential and trims it", async () => {
    const auth = fuelixApiKeyAuth(() => DEFAULT_BASE_URL, respondWith(400));
    const result = await auth.resolve({
      ctx: authContext({ [API_KEY_ENV_VAR]: "ak_from_env" }),
      credential: { type: "api_key", key: "  ak_stored \n" },
      signal: new AbortController().signal,
    });
    assert.equal(result?.auth.apiKey, "ak_stored");
  });

  test("resolve falls back to the environment variable and names it", async () => {
    const auth = fuelixApiKeyAuth(() => DEFAULT_BASE_URL, respondWith(400));
    const result = await auth.resolve({
      ctx: authContext({ [API_KEY_ENV_VAR]: "  ak_from_env\n" }),
      signal: new AbortController().signal,
    });
    assert.equal(result?.auth.apiKey, "ak_from_env");
    assert.equal(result?.source, API_KEY_ENV_VAR);
  });

  test("resolve reports unconfigured when neither source has a key", async () => {
    const auth = fuelixApiKeyAuth(() => DEFAULT_BASE_URL, respondWith(400));
    assert.equal(await auth.resolve({ ctx: authContext({}), signal: new AbortController().signal }), undefined);
    assert.equal(
      await auth.resolve({
        ctx: authContext({}),
        credential: { type: "api_key", key: "   " },
        signal: new AbortController().signal,
      }),
      undefined,
    );
  });
});

describe("buildFuelixProvider", () => {
  test("registers under the expected identity with api-key auth", () => {
    const provider = buildFuelixProvider(unused);
    assert.equal(provider.id, PROVIDER_ID);
    assert.equal(PROVIDER_ID, "fuelix");
    assert.equal(provider.name, "fuelix.ai");
    assert.equal(provider.baseUrl, DEFAULT_BASE_URL);
    assert.ok(provider.auth.apiKey, "api-key auth must be present");
    assert.equal(provider.auth.oauth, undefined);
    assert.equal(typeof provider.auth.apiKey!.login, "function");
    assert.equal(typeof provider.auth.apiKey!.resolve, "function");
  });

  test("serves the curated 98-model catalog synchronously, on completions only", () => {
    const provider = buildFuelixProvider(unused);
    const models = provider.getModels();
    assert.equal(models.length, CATALOG.length);
    for (const model of models) {
      assert.equal(model.provider, PROVIDER_ID);
      assert.equal(model.api, "openai-completions");
      assert.equal(model.baseUrl, DEFAULT_BASE_URL);
      assert.ok(model.maxTokens > 0);
    }
  });

  test("opts into dynamic refresh so new ids appear", () => {
    assert.equal(typeof buildFuelixProvider(unused).refreshModels, "function");
  });

  test("propagates a custom base url to every model", () => {
    const provider = buildFuelixProvider(unused, "https://proxy.example.com/fuelix/v1");
    assert.equal(provider.baseUrl, "https://proxy.example.com/fuelix/v1");
    for (const model of provider.getModels()) {
      assert.equal(model.baseUrl, "https://proxy.example.com/fuelix/v1");
    }
  });

  test("routes every model through the injected completions adapter", () => {
    let calls = 0;
    const counting: ProviderStreams = {
      stream: () => {
        calls++;
        throw new Error("completions");
      },
      streamSimple: unused.streamSimple,
    };
    const provider = buildFuelixProvider(counting);
    const model = provider.getModels().find((candidate) => candidate.id === "gpt-5.4");
    assert.ok(model);
    assert.equal(model.api, "openai-completions");
    assert.throws(() => provider.stream(model, normalizeContext({ messages: [] })), /completions/);
    assert.equal(calls, 1);
  });

  test("fails closed for a model whose api has no route in the map", async () => {
    // The api map only knows "openai-completions"; a stray api id must not
    // silently fall back to the wrong surface — pi-ai emits a stream error.
    const provider = buildFuelixProvider(unused);
    const stray = { ...provider.getModels()[0], api: "anthropic-messages" as const };
    const stream: any = provider.stream(stray as any, normalizeContext({ messages: [] }));
    const events: any[] = [];
    for await (const event of stream) events.push(event);
    const error = events.find((event) => event.type === "error");
    assert.ok(error, "expected a stream error for an unrouted api");
    assert.match(String(error.error.errorMessage), /anthropic-messages/);
  });
});
