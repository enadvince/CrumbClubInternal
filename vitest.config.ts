import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: {
    include: ["src/**/*.test.ts", "supabase/functions/**/*.test.ts"],
    // Need a database: run with `npm run test:db`.
    exclude: ["**/node_modules/**", "src/**/*.integration.test.ts"],
    environment: "node",
  },
});
