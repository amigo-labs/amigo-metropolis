import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/**
 * Short commit of the build, baked in for verification pins: a pin taken from a
 * stale tab is a real way to chase a bug that was already fixed. Empty string
 * when git is unavailable (tarball checkout, no history) — never fatal.
 */
function commitSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

export default defineConfig({
  define: {
    __COMMIT__: JSON.stringify(commitSha()),
  },
  resolve: {
    alias: {
      // Point straight at the sim source so vite transpiles the workspace TS
      // without a build step for the package.
      "@metropolis/sim": fileURLToPath(new URL("../sim/src/index.ts", import.meta.url)),
    },
  },
});
