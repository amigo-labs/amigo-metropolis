// Wrangler [build] hook. Builds the Vite client only when
// packages/client/dist is missing so `bun run build` and `wrangler deploy`
// never write that directory at the same time.
//
// Wrangler may start this from the repo root (Workers Builds) or from
// packages/server (`bun run --filter @metropolis/server build`). Resolve
// the repo from wrangler.toml so the dist check is cwd-independent.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

function repoRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "wrangler.toml")) && existsSync(join(dir, "packages", "client"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      console.error("ensureClientDist: repo root not found from", start);
      process.exit(1);
    }
    dir = parent;
  }
}

const root = repoRoot(process.cwd());
if (existsSync(join(root, "packages", "client", "dist", "index.html"))) {
  process.exit(0);
}

const bun = process.execPath;
const run = (args: string[]): void => {
  const result = spawnSync(bun, args, { stdio: "inherit", cwd: root });
  if (result.status) process.exit(result.status);
};

run(["install", "--frozen-lockfile"]);
run(["run", "--filter", "@metropolis/client", "build"]);
