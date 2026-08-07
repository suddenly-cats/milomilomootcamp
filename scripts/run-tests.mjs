/**
 * Test runner.
 *
 * `tsx --test src/*.test.ts` relies on the shell expanding the glob, which cmd
 * and PowerShell do not do, and Node 20's --test does not expand globs itself.
 * So discover the files here and pass them explicitly — works on every shell.
 */

import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "src");

const tests = readdirSync(srcDir)
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => join("src", f));

if (tests.length === 0) {
  console.error("no *.test.ts files found in src/");
  process.exit(1);
}

const result = spawnSync("npx", ["tsx", "--test", ...tests], {
  cwd: root,
  stdio: "inherit",
  shell: true,
});

process.exit(result.status ?? 1);
