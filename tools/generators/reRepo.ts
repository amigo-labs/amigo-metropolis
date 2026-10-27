// Where the private RE repo (amigo-labs/fcop-reverse-engineering) lives, for
// every generator that reads its extracted/ outputs or its fixtures/.
//
// One lookup, first hit wins:
//   1. `--re-repo <path>` on the command line (or the older `--re <path>`)
//   2. `$FCOP_RE_REPO` (or the older `$FCOP_RE`)
//   3. a `fcop-reverse-engineering` checkout beside this repo or beside any
//      folder above it, so a worktree under .claude/worktrees/ finds it too
//
// It used to be five lookups: most importers fell back to
// /workspace/fcop-reverse-engineering, gen:fx and gen:frontend searched a few
// siblings each, gen:presentation and gen:results had no fallback at all, and
// convert.ts read a private C:/MagiPacks dump that no longer exists.
// Node built-ins only: convert.ts runs before the workspace is built.

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const RE_DIR = "fcop-reverse-engineering";
/** The flags and variables, preferred spelling first. */
const FLAGS = ["--re-repo", "--re"] as const;
const ENV = ["FCOP_RE_REPO", "FCOP_RE"] as const;

/** A folder is an RE checkout when it carries the extracted/ outputs. */
export function isReRepo(dir: string): boolean {
  return existsSync(join(dir, "extracted"));
}

/**
 * The RE checkout, or null when none is given and none sits beside this tree.
 * A given path is returned resolved but unchecked, so `requireReRepo` can say
 * what is wrong with it.
 */
export function findReRepo(
  argv: readonly string[] = process.argv,
  env: Readonly<Record<string, string | undefined>> = process.env,
  from: string = REPO_ROOT,
  isRepo: (dir: string) => boolean = isReRepo,
): string | null {
  for (const flag of FLAGS) {
    const at = argv.indexOf(flag);
    const value = at >= 0 ? argv[at + 1] : undefined;
    if (value && !value.startsWith("--")) return resolve(value);
  }
  for (const name of ENV) {
    const value = env[name];
    if (value) return resolve(value);
  }
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    const sibling = join(dirname(dir), RE_DIR);
    if (isRepo(sibling)) return sibling;
    if (dirname(dir) === dir) return null;
  }
}

/** `findReRepo` plus a loud failure, so a generator never writes an artifact from nothing. */
export function requireReRepo(
  argv: readonly string[] = process.argv,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const root = findReRepo(argv, env);
  if (root === null) {
    throw new Error(
      `no RE checkout: pass --re-repo <path>, set FCOP_RE_REPO, or clone amigo-labs/${RE_DIR} beside this repo`,
    );
  }
  if (!isReRepo(root)) {
    throw new Error(
      `no RE checkout at ${root} (no extracted/): pass --re-repo <path> or set FCOP_RE_REPO`,
    );
  }
  return root;
}
