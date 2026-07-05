import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Plain Node environment: the code uses only WebCrypto, fetch, Request/
    // Response (all global in Node >=20) and node:sqlite via the test adapters
    // (loaded through createRequire), so no Workers pool is needed here.
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
