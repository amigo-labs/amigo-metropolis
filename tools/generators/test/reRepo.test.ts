// The RE repo lookup every generator shares (tools/generators/reRepo.ts).
// Order is the contract: an explicit flag beats the environment, which beats
// the sibling checkout.

import { describe, expect, test } from "bun:test";
import { resolveReRepo, SIBLING_RE_REPO } from "../reRepo";

describe("resolveReRepo", () => {
  test("--re-repo wins over the environment", () => {
    expect(resolveReRepo(["bun", "x.ts", "--re-repo", "/a"], { FCOP_RE_REPO: "/b" })).toBe("/a");
  });

  test("$FCOP_RE_REPO wins over the sibling checkout", () => {
    expect(resolveReRepo(["bun", "x.ts"], { FCOP_RE_REPO: "/b" })).toBe("/b");
  });

  test("falls back to the sibling checkout", () => {
    expect(resolveReRepo(["bun", "x.ts"], {})).toBe(SIBLING_RE_REPO);
    expect(SIBLING_RE_REPO.replaceAll("\\", "/")).toEndWith("/fcop-reverse-engineering");
  });

  test("a dangling --re-repo flag is ignored", () => {
    expect(resolveReRepo(["bun", "x.ts", "--re-repo"], {})).toBe(SIBLING_RE_REPO);
  });
});
