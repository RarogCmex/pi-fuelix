/**
 * Secret hygiene: the recorded fixtures and the sources must not carry a key, an
 * account identifier or a balance figure. The rule is a test rather than a habit
 * because all three are easy to paste in by accident — a key inside an example
 * command, an account id inside a recorded `owned_by`, a balance inside a quoted
 * 4xx body — and none of them breaks anything, so nothing else would catch them.
 *
 * `secret.env` and `research/raw/` are deliberately out of scope: the first is the
 * real key's home by design (and gitignored), the second holds raw probe output.
 *
 * The committed `test/fixtures/models-listing.json` is the recorded listing with
 * every `owned_by` value replaced by `account-id-scrubbed` — the ids (the part the
 * catalog and the discovery tests use) are verbatim; the gateway's account
 * identifier is not something to publish.
 */

import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKIP_DIRS = new Set(["node_modules", ".git", "raw"]);

function sourceFiles(dir = ROOT): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (entry === "secret.env" || entry.endsWith(".env")) continue;
    if (/\.(ts|json|md)$/.test(entry)) out.push(full);
  }
  return out;
}

const files = sourceFiles();

describe("no secrets in the sources or fixtures", () => {
  test("no gateway key prefix anywhere", () => {
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const match = /\bak-[A-Za-z0-9]{10,}/.exec(text);
      assert.equal(match, null, `${relative(ROOT, file)} contains a key-like string`);
    }
  });

  test("no gateway account identifier (UUID-shaped) anywhere", () => {
    // Asserted by SHAPE, not by value. Embedding the real id here in order to
    // check for it publishes the very thing the check exists to keep out, and
    // splitting it across array parts — as an earlier revision did, "so this
    // test's own source cannot trip the scan" — only defeats a substring scan
    // while leaving the value trivially reconstructable by any reader.
    //
    // A shape assertion needs no secret and is strictly stronger: it also
    // catches a future account id, not just the one recorded in 2026-09.
    const UUID_SHAPED = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      assert.equal(
        UUID_SHAPED.exec(text),
        null,
        `${relative(ROOT, file)} contains a UUID-shaped string (gateway account id?)`,
      );
    }
  });

  test("no currency figure from a gateway body was copied into the repo", () => {
    // This gateway's 403 body discloses the account balance in the clear, and it
    // publishes no prices at all, so no currency figure belongs in this repo:
    // no `＄`-prefixed amount (U+FF04 — the gateway answers in local typography)
    // may appear anywhere in the scanned tree.
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      assert.equal(/＄\s?\d/.test(text), false, `${relative(ROOT, file)} carries a balance figure`);
    }
  });

  test("the file list is non-trivial (the scan actually walked the repo)", () => {
    assert.ok(files.length >= 15, `only scanned ${files.length} files`);
    assert.ok(files.some((file) => file.endsWith("README.md")));
    assert.ok(files.some((file) => file.endsWith("test/fixtures/models-listing.json")));
  });
});
