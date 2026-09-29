/**
 * Provider assembly.
 *
 * Split out from `index.ts` so it loads under plain Node (and `node --test`):
 * everything here resolves through pi-ai's core entrypoint. The one symbol that
 * does not — `openAICompletionsApi`, which pi's extension loader serves from the
 * compat entrypoint — is injected by `index.ts` instead of imported here.
 */

import {
  createProvider,
  envApiKeyAuth,
  type ApiKeyAuth,
  type Provider,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { fetchFuelixModels } from "./discovery.ts";
import { buildModels, DEFAULT_BASE_URL, PROVIDER_ID, type GatewayApi } from "./models.ts";

export const API_KEY_AUTH_NAME = "fuelix.ai API key";
export const API_KEY_ENV_VAR = "FUELIX_API_KEY";
export const BASE_URL_ENV_VAR = "FUELIX_BASE_URL";

type EnvReader = (name: string) => string | undefined;

const processEnv: EnvReader = (name) =>
  typeof process !== "undefined" ? process.env?.[name] : undefined;

/** Endpoint override for a proxy or mirror; trailing slashes stripped. */
export function resolveBaseUrl(env: EnvReader = processEnv): string {
  const trimmed = env(BASE_URL_ENV_VAR)?.trim().replace(/\/+$/, "");
  return trimmed ? trimmed : DEFAULT_BASE_URL;
}

export type KeyProbeResult = "valid" | "invalid" | "unknown";

/**
 * Zero-inference key check: `POST /chat/completions` with an empty JSON body.
 *
 * Measured 2026-09-26 (the raw transcripts are local-only): an empty body is rejected
 * *before* inference with `400 {"detail":"Request body is missing"}` while an
 * invalid key is answered `401` RFC 7807. So 401 ⇒ bad key, anything else ⇒ the
 * key authenticated. A rejection is not billed, so this costs nothing — which is
 * the only reason it is allowed to run during `/login`.
 *
 * A network failure returns `"unknown"`, never `"invalid"`: `/login` must still
 * work offline, and a flaky gateway must not make a good key look bad.
 */
export async function probeKey(
  key: string,
  baseUrl: string = DEFAULT_BASE_URL,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 8_000,
): Promise<KeyProbeResult> {
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 401) return "invalid";
    return "valid";
  } catch {
    return "unknown";
  }
}

/**
 * Stored-key-then-env resolution with whitespace trimming on both paths. A key
 * pasted with a trailing newline produces the same opaque
 * `401 status code (no body)` as a revoked one (see errors.ts), which reads like
 * an account problem rather than a stray character.
 */
export function fuelixApiKeyAuth(
  baseUrl: () => string = () => resolveBaseUrl(),
  fetchImpl: typeof fetch = fetch,
): ApiKeyAuth {
  const base = envApiKeyAuth(API_KEY_AUTH_NAME, [API_KEY_ENV_VAR]);
  return {
    ...base,

    async login(interaction) {
      interaction.signal.throwIfAborted();
      interaction.notify({
        type: "info",
        message:
          "Paste a fuelix.ai gateway key (the `ak-…` value from your account's API keys page).",
      });
      const entered = await interaction.prompt({
        type: "secret",
        message: API_KEY_AUTH_NAME,
        placeholder: "ak-...",
      });
      interaction.signal.throwIfAborted();
      const key = entered.trim();
      if (!key) throw new Error("No API key entered.");
      if (!key.startsWith("ak-")) {
        // Warn, don't reject: the `ak-` prefix is what the issued key looks like,
        // not a documented contract.
        interaction.notify({
          type: "info",
          message: "That does not look like a fuelix key (expected ak-…). Checking it anyway.",
        });
      }
      const probe = await probeKey(key, baseUrl(), fetchImpl);
      if (probe === "invalid") {
        throw new Error(
          "The gateway rejected this key with 401 `Invalid or missing API key`. Nothing was saved.",
        );
      }
      if (probe === "unknown") {
        interaction.notify({
          type: "info",
          message: "Could not reach the gateway to check the key (offline?). Saving it anyway.",
        });
      }
      return { type: "api_key", key };
    },

    async resolve(input) {
      const resolved = await base.resolve(input);
      const key = resolved?.auth.apiKey?.trim();
      if (!resolved || !key) return undefined;
      return { ...resolved, auth: { ...resolved.auth, apiKey: key } };
    },
  };
}

/**
 * Build the `fuelix` provider.
 *
 * `models` is the curated baseline (always present, never network-dependent).
 * `fetchModels` layers live discovery on top: pi merges the overlay per id,
 * persists it through its own ModelsStore and restores it offline, so a new id
 * appears without a plugin release while a failed listing degrades to the
 * baseline.
 *
 * Only the `openai-completions` surface is registered. `POST /v1/messages`
 * answers 200 and `POST /v1/responses` answers 200 (both measured 2026-09-26) —
 * they are deliberately left unregistered, with the
 * reasoning recorded in the README § Surfaces.
 */
export function buildFuelixProvider(
  api: ProviderStreams,
  baseUrl: string = resolveBaseUrl(),
): Provider<GatewayApi> {
  return createProvider<GatewayApi>({
    id: PROVIDER_ID,
    name: "fuelix.ai",
    baseUrl,
    auth: { apiKey: fuelixApiKeyAuth() },
    models: buildModels(baseUrl),
    fetchModels: (context) => fetchFuelixModels(baseUrl, context),
    api: { "openai-completions": api },
  });
}
