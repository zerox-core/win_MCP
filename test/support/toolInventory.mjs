/**
 * Test support: the expected tool count, derived from the source of truth.
 *
 * The inventory lives in `BASE_TOOL_NAMES` in `src/index.ts`. Reading it from
 * the compiled module keeps assertions from drifting every time a tool is
 * added — the previous string of hardcoded counts (36, then 42) was stale
 * multiple times.
 *
 * `restart_service` registers only under managed launch, so it is excluded
 * from the default production count.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

const projectDir = path.resolve(import.meta.dirname, "..", "..");

/** Parse BASE_TOOL_NAMES out of the compiled entry point. */
export function baseToolNames() {
  const source = readFileSync(path.join(projectDir, "dist", "index.js"), "utf8");
  const match = source.match(/const BASE_TOOL_NAMES = \[([\s\S]*?)\];/);
  if (!match) throw new Error("BASE_TOOL_NAMES not found in dist/index.js");
  return [...match[1].matchAll(/"([a-z0-9_]+)"/g)].map((entry) => entry[1]);
}

/** Number of tools a non-managed production instance advertises. */
export function productionToolCount() {
  return baseToolNames().length;
}
