/**
 * Live checks against the real fuelix.ai gateway — the claims the offline suite
 * cannot verify (README § "What is verified live, and how"). Not part of
 * `npm test`: run explicitly with `npm run live` after `set -a; . ./secret.env`.
 *
 * **Cost discipline.** Every request is either a *pre-inference rejection*
 * (401/403/400 — free, and the gateway is known to answer 200 for probes that
 * "should" be rejected, so nothing is assumed free until it comes back 4xx) or a
 * tiny capped generation (`maxTokens <= 64`). The harness prints a ledger row per
 * request: status, whether it was billed, tokens, and the total. No USD figure is
 * printed anywhere, because the gateway publishes no price and discloses none in
 * any body; token counts are what can be measured.
 *
 *  A. GET /v1/models          — 111 ids, and the curated catalog is not stale. Free.
 *  B. per-model field check   — `max_completion_tokens` is HONOURED (the answer is
 *                               cut at the cap) on the three measured families.
 *  C. tool round-trip         — a function tool returns a pi tool call.
 *  D. usage in the SSE stream — token accounting arrives (stream_options).
 *  E. invalid key             — 401 (free) and the clarified sentence is not retryable.
 *  F. unentitled model        — 403 (free), clarified as entitlement, not as a key problem.
 *  G. `{}` body               — 400 (free) and the body survives as readable text.
 *  H. optional sweep          — FUELIX_LIVE_SWEEP=1 drives `maxTokens: 1` over the
 *                               catalog to map entitlement + liveness (default off:
 *                               a route can bill thousands of input tokens for a
 *                               tiny body, so a full sweep is not priceable blind).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
  isContextOverflow,
  isRetryableAssistantError,
  normalizeContext,
  Type,
  type AssistantMessage,
  type Model,
  type Tool,
  type Usage,
} from "@earendil-works/pi-ai";
import { CATALOG_BY_ID, LISTED_CHAT_IDS, NON_CHAT_IDS } from "../catalog.ts";
import {
  clarifyFuelixError,
  extractGatewayMessage,
  recoverErrorBody,
  withBodyRecoveryApi,
} from "../errors.ts";
import { DEFAULT_BASE_URL, entryToModel, unknownModelToModel } from "../models.ts";
import { parseModelIds } from "../discovery.ts";

// --- key + base url ----------------------------------------------------------

function loadKey(): string {
  if (process.env.FUELIX_API_KEY?.trim()) return process.env.FUELIX_API_KEY.trim();
  const auth = JSON.parse(readFileSync(`${homedir()}/.pi/agent/auth.json`, "utf8")) as Record<
    string,
    { type?: string; key?: string }
  >;
  const key = auth["fuelix"]?.key?.trim();
  if (!key) throw new Error("no fuelix key in FUELIX_API_KEY or ~/.pi/agent/auth.json");
  return key;
}

const BASE_URL = (process.env.FUELIX_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, "");
const KEY = loadKey();
const api = withBodyRecoveryApi(openAICompletionsApi());

let failures = 0;
const ledger: { name: string; status: number; billed: boolean; input: number; output: number }[] = [];

function report(name: string, ok: boolean, detail: string): void {
  if (!ok) failures++;
  console.log(`\n[${ok ? "PASS" : "FAIL"}] ${name}\n${detail.replace(/^/gm, "  ")}`);
}

const PACE_MS = 3_000;
let lastRequest = 0;

async function pace(): Promise<void> {
  const wait = PACE_MS - (Date.now() - lastRequest);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequest = Date.now();
}

/** Paced raw fetch with one retry on a 429. Returns status + text, and ledgers the call. */
async function pacedFetch(
  name: string,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; text: string; contentType: string | null }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await pace();
    const response = await fetch(`${BASE_URL}${path}`, { ...init, signal: AbortSignal.timeout(120_000) });
    const contentType = response.headers.get("content-type");
    const text = await response.text();
    if (response.status !== 429) {
      ledger.push({ name, status: response.status, billed: response.ok, input: 0, output: 0 });
      return { status: response.status, text, contentType };
    }
    console.log(`  [429] ${name}: backing off`);
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    lastRequest = Date.now();
  }
  ledger.push({ name, status: 429, billed: false, input: 0, output: 0 });
  return { status: 429, text: "gave up after repeated 429s", contentType: null };
}

// --- driving pi's real adapter ----------------------------------------------

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

interface LiveResult {
  status: number;
  text: string;
  errorMessage?: string;
  stopReason?: string;
  usage: Usage;
  sent: Record<string, any>;
  message?: AssistantMessage;
  toolCalls: number;
}

async function run(
  target: Model<"openai-completions">,
  options: { prompt: string; maxTokens?: number; tools?: Tool[]; apiKey?: string; name: string },
): Promise<LiveResult> {
  const context = normalizeContext({
    systemPrompt: "You are concise. Answer briefly.",
    messages: [{ role: "user", content: options.prompt, timestamp: Date.now() }],
    tools: options.tools,
  });

  let status = 0;
  let raw = "";
  let errorMessage: string | undefined;
  let stopReason: string | undefined;
  let final: AssistantMessage | undefined;
  let sent: Record<string, any> = {};
  let toolCalls = 0;

  const tee: typeof fetch = (async (input: any, init: any) => {
    await pace();
    const response = await fetch(input, init);
    status = response.status;
    void response
      .clone()
      .text()
      .then((text) => (raw = text))
      .catch(() => {});
    return response;
  }) as typeof fetch;

  const stream = api.streamSimple(target, context, {
    apiKey: options.apiKey ?? KEY,
    maxTokens: options.maxTokens ?? 16,
    onPayload: (body) => {
      sent = body as Record<string, any>;
    },
    fetch: tee,
  });

  for await (const event of stream) {
    if (event.type === "done") {
      final = event.message;
      stopReason = event.message.stopReason;
    }
    if (event.type === "error") {
      final = event.error;
      errorMessage = event.error.errorMessage;
      stopReason = event.error.stopReason;
    }
    if (event.type === "toolcall_end") toolCalls++;
  }

  await new Promise((resolve) => setTimeout(resolve, 200));
  const usage = final?.usage ?? ZERO_USAGE;
  ledger.push({
    name: options.name,
    status,
    billed: status >= 200 && status < 300,
    input: usage.input,
    output: usage.output,
  });
  return { status, text: raw, errorMessage, stopReason, usage, sent, message: final, toolCalls };
}

function model(id: string, baseUrl = BASE_URL): Model<"openai-completions"> {
  const entry = CATALOG_BY_ID.get(id);
  if (!entry) throw new Error(`${id} not in catalog`);
  return entryToModel(entry, baseUrl) as Model<"openai-completions">;
}

const CAP_PROMPT = "Output the numbers 1 to 20, separated by commas, and nothing else.";

/** The text pi-ai assembled from the stream (the `text` field is the raw SSE buffer). */
function assembledText(result: LiveResult): string {
  const content = result.message?.content ?? [];
  return content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("")
    .slice(0, 80);
}

/** True when a rewritten error is inert for pi: no retry, no compaction. */
function inert(errorMessage: string | undefined): boolean {
  if (!errorMessage) return false;
  const message = {
    role: "assistant",
    stopReason: "error",
    provider: "fuelix",
    errorMessage,
  } as unknown as AssistantMessage;
  return !isRetryableAssistantError(message) && !isContextOverflow(message);
}

async function main(): Promise<void> {
  // A. the listing is what the catalog claims.
  {
    const { status, text } = await pacedFetch("A listing", "/models", {
      headers: { Authorization: `Bearer ${KEY}` },
    });
    if (status !== 200) {
      report("A: GET /v1/models", false, `status ${status}: ${text.slice(0, 200)}`);
    } else {
      const ids = parseModelIds(JSON.parse(text));
      const known = new Set([...LISTED_CHAT_IDS, ...NON_CHAT_IDS]);
      const stale = [...known].filter((id) => !ids.includes(id));
      const unknown = ids.filter((id) => !known.has(id));
      report(
        "A: GET /v1/models is what the catalog was frozen from (free)",
        ids.length === 111 && stale.length === 0 && unknown.length === 0,
        [
          `${ids.length} ids listed (catalog expects 111)`,
          `curated ids no longer listed: ${stale.join(", ") || "none"}`,
          `listed ids not in the catalog (overlay candidates): ${unknown.join(", ") || "none"}`,
        ].join("\n"),
      );
    }
  }

  // B. the per-model maxTokensField decision, on the measured families.
  for (const id of ["gpt-5.4", "gpt-4o-mini", "o4-mini"]) {
    const result = await run(model(id), { prompt: CAP_PROMPT, maxTokens: 8, name: `B field ${id}` });
    const cut = result.usage.output <= 8;
    report(
      `B: ${id} honours max_completion_tokens`,
      result.status === 200 &&
        !result.errorMessage &&
        cut &&
        result.sent.max_completion_tokens === 8 &&
        result.sent.max_tokens === undefined,
      [
        `sent: max_completion_tokens=${result.sent.max_completion_tokens} max_tokens=${result.sent.max_tokens ?? "(absent)"}`,
        `output tokens: ${result.usage.output} (cap 8) — stopReason ${result.stopReason}`,
        `answer (assembled by pi-ai): ${JSON.stringify(assembledText(result))}`,
        `raw SSE bytes: ${result.text.length}`,
      ].join("\n"),
    );
  }

  // C. tools round-trip through the gateway.
  {
    const weatherTool: Tool = {
      name: "get_weather",
      description: "Look up the weather for a city.",
      parameters: Type.Object({ city: Type.String({ description: "City" }) }),
    };
    const result = await run(model("gpt-4o-mini"), {
      prompt: "What is the weather in Paris? Use the tool.",
      maxTokens: 64,
      tools: [weatherTool],
      name: "C tools gpt-4o-mini",
    });
    report(
      "C: a function tool returns a pi tool call",
      result.toolCalls >= 1 && !result.errorMessage,
      [
        `toolcall_end events: ${result.toolCalls}`,
        `stopReason: ${result.stopReason}`,
        `sent tools: ${Array.isArray(result.sent.tools) ? result.sent.tools.length : 0}`,
        `tokens: in=${result.usage.input} out=${result.usage.output}`,
      ].join("\n"),
    );
  }

  // D. usage arrives in the SSE stream (the supportsUsageInStreaming flag).
  {
    const result = await run(model("gpt-4o-mini"), {
      prompt: "Reply with exactly: ok",
      maxTokens: 8,
      name: "D usage gpt-4o-mini",
    });
    report(
      "D: usage is reported in the streamed response",
      result.usage.input > 0 && result.usage.output > 0,
      [
        `stream_options sent: ${JSON.stringify(result.sent.stream_options)}`,
        `usage: in=${result.usage.input} out=${result.usage.output} total=${result.usage.totalTokens}`,
      ].join("\n"),
    );
  }

  // E. invalid key: free, and the rewrite must not become retryable.
  {
    const result = await run(model("gpt-5.4"), {
      prompt: "hi",
      maxTokens: 8,
      apiKey: "ak-invalid-key-for-the-auth-check",
      name: "E bad key",
    });
    const clarified = clarifyFuelixError(result.errorMessage ?? "");
    report(
      "E: an invalid key is rejected with 401 and clarified (free)",
      result.status === 401 &&
        !!clarified &&
        /authentication failed/.test(clarified) &&
        inert(clarified),
      [
        `http status: ${result.status} (rejection → not billed)`,
        `pi sees: ${JSON.stringify(result.errorMessage)}`,
        `clarified: ${(clarified ?? "(none)").slice(0, 180)}`,
      ].join("\n"),
    );
  }

  // F. a model the key is not entitled to: free, 403, entitlement (not auth).
  {
    const ghost = unknownModelToModel("fuelix-does-not-exist-xyz", BASE_URL) as Model<"openai-completions">;
    const result = await run(ghost, { prompt: "hi", maxTokens: 8, name: "F unentitled" });
    const clarified = clarifyFuelixError(result.errorMessage ?? "");
    report(
      "F: an unentitled model is rejected with 403 and clarified as entitlement (free)",
      result.status === 403 &&
        !!clarified &&
        /not entitled/.test(clarified) &&
        !/authentication failed/.test(clarified) &&
        inert(clarified),
      [
        `http status: ${result.status} (rejection → not billed)`,
        `pi sees: ${JSON.stringify((result.errorMessage ?? "").slice(0, 160))}`,
        `clarified: ${(clarified ?? "(none)").slice(0, 180)}`,
      ].join("\n"),
    );
  }

  // G. the free empty-body probe still produces the recorded shapes (drift check).
  {
    const { status, text, contentType } = await pacedFetch(
      "G empty body",
      "/chat/completions",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
        body: "{}",
      },
    );
    const replay = await recoverErrorBody(
      new Response(text, { status, headers: contentType ? { "content-type": contentType } : undefined }),
    );
    const readable = await replay.text();
    report(
      "G: the empty-body probe is still a free 400 with a readable recovered body",
      status === 400 && readable.includes("Request body is missing"),
      [
        `http status: ${status} (rejection → not billed)`,
        `raw body: ${text.trim().slice(0, 120)}`,
        `after recoverErrorBody: ${JSON.stringify(readable.slice(0, 120))}`,
        `extractGatewayMessage: ${JSON.stringify(extractGatewayMessage(text))}`,
      ].join("\n"),
    );
  }

  // H. optional entitlement/liveness sweep (opt-in: some routes bill thousands of
  //    input tokens for a tiny body, so the sweep is not run by default).
  if (process.env.FUELIX_LIVE_SWEEP === "1") {
    const results: string[] = [];
    for (const id of LISTED_CHAT_IDS) {
      const result = await run(model(id), { prompt: "Reply with exactly: ok", maxTokens: 1, name: `H ${id}` });
      results.push(
        `${String(result.status).padEnd(4)} ${id.padEnd(30)} ${
          result.status >= 200 && result.status < 300 ? `in=${result.usage.input} out=${result.usage.output}` : "rejected"
        }`,
      );
    }
    report("H: opt-in liveness sweep", true, results.join("\n"));
  }

  // ledger + cost accounting (tokens only; the gateway publishes no price).
  const billed = ledger.filter((row) => row.billed && row.input + row.output > 0);
  const totals = billed.reduce(
    (acc, row) => ({ input: acc.input + row.input, output: acc.output + row.output }),
    { input: 0, output: 0 },
  );
  console.log(
    [
      "",
      "Ledger — every request this run made",
      ...ledger.map(
        (row) =>
          `  ${String(row.status).padEnd(4)} ${row.name.padEnd(24)} ${
            row.billed && row.input + row.output > 0
              ? `BILLED in=${row.input} out=${row.output}`
              : row.billed
                ? "2xx, no inference (not billed)"
                : "rejected (not billed)"
          }`,
      ),
      "",
      `  paid calls: ${billed.length}, paid tokens: ${totals.input} in / ${totals.output} out`,
      "  USD: currency figure unavailable — the gateway publishes no price list and no body",
      "  (403/400/401/404 included above) discloses a rate; the token counts are the measurement.",
    ].join("\n"),
  );

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
