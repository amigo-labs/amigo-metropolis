import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    alias: {
      // Point straight at the sim source so vite transpiles the workspace TS
      // without a build step for the package.
      "@metropolis/sim": fileURLToPath(new URL("../sim/src/index.ts", import.meta.url)),
    },
  },
});
