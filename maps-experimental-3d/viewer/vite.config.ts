import { defineConfig } from "vitest/config";

export default defineConfig({
  // 5173 is used by web/.
  server: { port: 5174 },
  test: { globals: true },
});
