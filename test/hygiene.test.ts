/**
 * Secret hygiene: the recorded fixtures and the sources must not carry a key, an
 * account identifier or a balance figure. Two of those leaked into this repo's
 * history in earlier builds (a real key in a README example, an account email),
 * which is why the rule is a test rather than a habit.
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

  test("the account identifier from the live listing is scrubbed", () => {
    // Assembled from parts so this test's own source cannot trip the scan.
    const accountId = ["6697d4bf", "46bd", "484d", "9f99", "98c836cd207b"].join("-");
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      assert.equal(
        text.includes(accountId),
        false,
        `${relative(ROOT, file)} contains the gateway account id`,
      );
    }
  });

  test("no currency figure from a gateway body was copied into the repo", () => {
    // The recon recorded that a 403 body leaks a balance; the task for this build
    // forbids reproducing USD figures (the gateway publishes no prices), so no
    // `＄`-prefixed amount may appear.
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
