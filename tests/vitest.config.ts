import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // One surfpool instance per file; files run sequentially to keep ports/RPC simple.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 180_000,
    include: ["**/*.test.ts"],
    // Tests within a file run in declaration order and share the surfnet.
    sequence: { concurrent: false },
  },
});
