// Static guard for the CLAUDE.md determinism hard rules: scans every source
// file in packages/sim/src for banned constructs. This cannot prove
// determinism (the golden replays do that) but catches the common violations
// at the cheapest possible point.

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");

const BANNED: { name: string; re: RegExp }[] = [
  {
    name: "engine-dependent Math.* (use simMath.ts)",
    re: /\bMath\.(?:sin|cos|tan|atan2?|asin|acos|sinh|cosh|tanh|pow|exp|expm1|log|log2|log10|log1p|cbrt|hypot|random)\b/,
  },
  { name: "wall-clock time", re: /\b(?:Date\.now|performance\.now|new Date)\b/ },
  { name: "async in sim", re: /\basync\b|\bawait\b|\bsetTimeout\b|\bsetInterval\b|\bPromise\b/ },
  { name: "DOM/engine globals", re: /\b(?:window|document|navigator|requestAnimationFrame)\b/ },
];

function listSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSources(path));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

describe("determinism guard", () => {
  const files = listSources(SRC);

  it("finds sim sources", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`bans nondeterministic constructs in ${file.slice(SRC.length + 1)}`, () => {
      const text = readFileSync(file, "utf8");
      for (const rule of BANNED) {
        const match = rule.re.exec(text);
        if (match) {
          throw new Error(`${rule.name}: found "${match[0]}" in ${file}`);
        }
      }
    });
  }

  it("sim package declares zero runtime dependencies", () => {
    const pkg = JSON.parse(readFileSync(join(SRC, "..", "package.json"), "utf8"));
    expect(pkg.dependencies).toBeUndefined();
  });
});
