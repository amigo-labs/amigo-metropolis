// The RE repo lookup every generator shares (tools/generators/reRepo.ts).
// Order is the contract: a flag beats the environment, which beats a checkout
// found beside this tree or a folder above it.

import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { findReRepo } from "../reRepo";

const FROM = resolve("/code/amigo-labs/amigo-metropolis");
const SIBLING = resolve("/code/amigo-labs/fcop-reverse-engineering");
const none = (): boolean => false;
const only =
  (dir: string) =>
  (d: string): boolean =>
    d === dir;

describe("findReRepo", () => {
  test("--re-repo wins over --re and the environment", () => {
    const argv = ["bun", "x.ts", "--re", "/b", "--re-repo", "/a"];
    expect(findReRepo(argv, { FCOP_RE_REPO: "/c" }, FROM, none)).toBe(resolve("/a"));
  });

  test("the older --re still works", () => {
    expect(findReRepo(["bun", "x.ts", "--re", "/b"], {}, FROM, none)).toBe(resolve("/b"));
  });

  test("$FCOP_RE_REPO wins over $FCOP_RE and the sibling checkout", () => {
    const env = { FCOP_RE_REPO: "/c", FCOP_RE: "/d" };
    expect(findReRepo(["bun", "x.ts"], env, FROM, only(SIBLING))).toBe(resolve("/c"));
    expect(findReRepo(["bun", "x.ts"], { FCOP_RE: "/d" }, FROM, none)).toBe(resolve("/d"));
  });

  test("falls back to the checkout beside this repo", () => {
    expect(findReRepo(["bun", "x.ts"], {}, FROM, only(SIBLING))).toBe(SIBLING);
  });

  test("a worktree finds the checkout beside the repo it lives in", () => {
    const worktree = join(FROM, ".claude", "worktrees", "agent-x");
    expect(findReRepo(["bun", "x.ts"], {}, worktree, only(SIBLING))).toBe(SIBLING);
  });

  test("a dangling or flag-valued --re-repo is ignored", () => {
    expect(findReRepo(["bun", "x.ts", "--re-repo"], {}, FROM, only(SIBLING))).toBe(SIBLING);
    expect(findReRepo(["bun", "x.ts", "--re-repo", "--check"], {}, FROM, only(SIBLING))).toBe(
      SIBLING,
    );
  });

  test("null when nothing is given and nothing is found", () => {
    expect(findReRepo(["bun", "x.ts"], {}, FROM, none)).toBeNull();
  });
});
