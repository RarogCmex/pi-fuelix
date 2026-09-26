/**
 * Live model discovery — the dynamic half of a semi-dynamic catalog.
 *
 * `GET /v1/models` is authenticated: with the key it returns 200 and 111 ids,
 * without it 401 (measured 2026-09-26, both bodies in
 * `test/fixtures/error-bodies.json`). Its entries carry only
 * `{id, object, created, owned_by}` — no caps, no prices, no modalities — so the
 * overlay cannot improve on the curated data and only ever adds *unknown* ids.
 *
 * The overlay is additive and unknowns-only: known ids keep their curated
 * numbers (a listing would otherwise freeze today's floors into pi's persisted
 * store and shadow a later catalog fix), and a failed/empty/keyless listing
 * returns `[]`, leaving the baseline intact. pi's merge is by id and never
 * deletes, so an id the gateway *removes* lingers until a catalog edit — a pi
 * limitation, documented rather than worked around.
 */

import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import { CATALOG_BY_ID } from "./catalog.ts";
import { isNonChatId, unknownModelToModel, type FuelixModel } from "./models.ts";

/** `GET /models` body: `{"object":"list","data":[{"id":"gpt-4o","object":"model","created":…,"owned_by":…}]}`. */
interface ModelsResponse {
  data?: { id?: unknown }[];
}

/**
 * Pull model ids out of a `/models` body. Pure so it is testable offline and
 * against the recorded listing.
 */
export function parseModelIds(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null) return [];
  const data = (payload as ModelsResponse).data;
  if (!Array.isArray(data)) return [];
  const ids: string[] = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== "string" || !id.trim()) continue;
    ids.push(id.trim());
  }
  return [...new Set(ids)];
}

/**
 * Overlay for discovered ids the catalog does not know.
 *
 * Two filters, both load-bearing:
 *  - `known` — a curated id keeps its curated data.
 *  - `isNonChatId` — the gateway lists image/speech/embedding routes, and an
 *    overlay that re-added them would put `dall-e-3` in pi's chat picker (the
 *    curated catalog excludes exactly those ids; see `catalog.ts` `NON_CHAT_IDS`).
 */
export function buildOverlay(
  ids: readonly string[],
  baseUrl: string,
  known: ReadonlySet<string> = new Set(CATALOG_BY_ID.keys()),
): FuelixModel[] {
  return ids
    .filter((id) => !known.has(id) && !isNonChatId(id))
    .map((id) => unknownModelToModel(id, baseUrl));
}

/** Resolve the effective key: refresh credential first, then the env var. Both trimmed. */
export function resolveDiscoveryKey(
  context: RefreshModelsContext,
  env: (name: string) => string | undefined = (name) => process.env[name],
  envVar = "FUELIX_API_KEY",
): string | undefined {
  const fromCredential =
    context.credential?.type === "api_key" ? context.credential.key?.trim() : undefined;
  if (fromCredential) return fromCredential;
  const fromEnv = env(envVar)?.trim();
  return fromEnv || undefined;
}

/**
 * `fetchModels` implementation. Never throws: `[]` leaves the curated baseline
 * (and any previously persisted overlay) untouched, so an offline start degrades
 * to "static catalog", never to "broken provider".
 */
export async function fetchFuelixModels(
  baseUrl: string,
  context: RefreshModelsContext,
  timeoutMs = 8_000,
): Promise<FuelixModel[]> {
  if (!context.allowNetwork || context.signal.aborted) return [];

  const key = resolveDiscoveryKey(context);
  if (!key) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  context.signal.addEventListener("abort", onAbort, { once: true });

  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    if (!response.ok) return [];
    return buildOverlay(parseModelIds(await response.json()), baseUrl);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
    context.signal.removeEventListener("abort", onAbort);
  }
}
