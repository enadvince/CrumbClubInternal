import { defineConfig } from "vitest/config";
import path from "node:path";

/** Integration tests against the local Postgres started by supabase/tests/run.sh. */
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    include: ["src/**/*.integration.test.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
