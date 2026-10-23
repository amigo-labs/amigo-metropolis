// Where the private RE repo (amigo-labs/fcop-reverse-engineering) lives, for
// every generator that reads its `extracted/` outputs.
//
// One lookup, three spellings, first hit wins:
//   1. `--re-repo <path>` on the command line
//   2. `$FCOP_RE_REPO`
//   3. a sibling checkout next to this repo (`../fcop-reverse-engineering`)
//
// It used to be three different defaults: fcopLogic.ts fell back to
// `/workspace/fcop-reverse-engineering`, analyzeGroundCast.ts to the sibling,
// and convert.ts to a private workspace (`C:/MagiPacks/...`) that no longer
// exists. Node-only on purpose: convert.ts runs before the workspace is built.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/** The sibling-checkout fallback, exported for tests. */
export const SIBLING_RE_REPO = join(REPO_ROOT, "..", "fcop-reverse-engineering");

/** Resolve the RE repo root. Pure apart from its inputs, so it can be tested. */
export function resolveReRepo(
  argv: readonly string[] = process.argv,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const at = argv.indexOf("--re-repo");
  if (at >= 0 && argv[at + 1]) return argv[at + 1];
  return env.FCOP_RE_REPO ?? SIBLING_RE_REPO;
}

/** `resolveReRepo` plus a loud failure when the checkout is missing, so a
 *  generator never silently writes an artifact from nothing. */
export function requireReRepo(argv: readonly string[] = process.argv): string {
  const root = resolveReRepo(argv);
  if (!existsSync(join(root, "extracted"))) {
    throw new Error(
      `RE repo not found at ${root} (no extracted/). Pass --re-repo <path> or set FCOP_RE_REPO.`,
    );
  }
  return root;
}

/** The RE repo's HEAD sha, or "unknown" when git cannot read it. */
export function reRepoCommit(root: string): string {
  try {
    return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}
