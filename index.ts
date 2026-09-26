/**
 * fuelix.ai provider for pi (`https://api.fuelix.ai/v1`).
 *
 * Registers `fuelix` as a first-class pi-ai provider: a curated 98-id chat
 * catalog (frozen from the gateway's 111-id listing, minus the 13 non-chat
 * routes), `/login`, a live `/v1/models` overlay, and an error layer for the
 * gateway's three failure dialects.
 *
 * pi 0.87 boundaries: `message_end` rewrites the *finalized* assistant message
 * (overflow marker first, then the readable sentence) before it is persisted —
 * so the transcript, the next turn and the display all agree — while `turn_end`
 * appends one persistent TUI note for the two failures a human must act on.
 */

// NOTE on this import: pi's extension loader aliases the bare
// "@earendil-works/pi-ai" specifier to pi-ai's compat entrypoint, a strict
// superset of the core one that re-exports `openAICompletionsApi`. Subpaths
// other than /compat, /oauth and /providers/all are NOT aliased. tsconfig.json
// mirrors the loader's alias so `npm run typecheck` sees what pi sees. This is
// the only pi-runtime-only import in the package; everything else lives in
// modules plain Node can load, which is what makes them testable.
import { openAICompletionsApi } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  clarifyFuelixError,
  needsPersistentHelp,
  normalizeOverflowError,
  withBodyRecoveryApi,
} from "./errors.ts";
import { PROVIDER_ID } from "./models.ts";
import { buildFuelixProvider } from "./provider.ts";

const HELP_ENTRY_TYPE = "fuelix-help";

export default function (pi: ExtensionAPI) {
  // One rewrite per finalized assistant message, guarded twice (this provider,
  // then the message role). Overflow normalization runs first so a rejection
  // that is *also* opaque still reaches pi's compaction classifier; the
  // readable sentence runs second and never touches an overflow-marked message
  // (its rewrite is undefined for that shape).
  pi.on("message_end", (event) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    if (message.provider !== PROVIDER_ID) return;
    if (message.stopReason !== "error") return;

    const original = message.errorMessage ?? "";
    const rewritten = normalizeOverflowError(original) ?? clarifyFuelixError(original);
    if (!rewritten) return;
    return { message: { ...message, errorMessage: rewritten } };
  });

  // A persistent TUI note for the two states the user has to fix (invalid key,
  // model not entitled to this key). The `ctx.hasUI` gate is load-bearing: an
  // entry appended *after* the errored assistant message makes `pi -p` print
  // nothing at all (pitfall P23), so print mode keeps only the rewritten error
  // bubble. Deduped via customType because `turn_end` can re-fire.
  pi.on("turn_end", (event, ctx) => {
    if (!ctx.hasUI) return;
    if (event.outcome !== "error") return;
    const message = event.message as unknown as {
      role: string;
      provider?: string;
      errorMessage?: string;
    };
    if (message.role !== "assistant" || message.provider !== PROVIDER_ID) return;
    if (!needsPersistentHelp(message.errorMessage ?? "")) return;
    if (event.entries.some((entry) => (entry as { customType?: string }).customType === HELP_ENTRY_TYPE)) {
      return;
    }
    return {
      entries: [
        ...event.entries,
        {
          type: "custom_message" as const,
          customType: HELP_ENTRY_TYPE,
          content:
            "fuelix rejected the request before generation. The gateway answers HTTP 401 " +
            "`Invalid or missing API key` when the key is wrong (check for a trailing newline, then " +
            `\`/login ${PROVIDER_ID}\` or \`FUELIX_API_KEY\`), and HTTP 403 \`Authorization failed ` +
            "for model '…'\` when the key is valid but not entitled to that model — for the 403, " +
            "switch model: the `/models` listing advertises ids the gateway knows, not the ones your " +
            "key can actually run.",
          display: true,
        },
      ],
    };
  });

  pi.registerProvider(buildFuelixProvider(withBodyRecoveryApi(openAICompletionsApi())));
}
