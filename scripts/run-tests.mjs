/**
 * Run the test suite in a shell-independent way.
 *
 * `node --test test/*.test.mjs` relies on the *shell* expanding the glob. On
 * Windows CI the shell is PowerShell, which passes the pattern through
 * verbatim, so Node receives a literal `test/*.test.mjs`, reports "Could not
 * find ...", and the suite never actually runs while `npm test` still fails.
 *
 * Expanding the pattern here makes `npm test` behave the same in PowerShell,
 * cmd, bash, and any Node version that supports `--test`.
 */

import { readdirSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";

const testDir = path.resolve(import.meta.dirname, "..", "test");

const files = readdirSync(testDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
  .map((entry) => path.join(testDir, entry.name))
  .sort();

if (files.length === 0) {
  console.error("no test files found in", testDir);
  process.exit(1);
}

const args = ["--test", "--test-concurrency=4", ...files, ...process.argv.slice(2)];

const child = spawn(process.execPath, args, { stdio: "inherit", shell: false });
child.on("error", (error) => {
  console.error("failed to start the test runner:", error.message);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`test runner terminated by signal ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
