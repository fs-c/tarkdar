import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Dev server: proxies the backend routes to a running radar-backend (live or --replay).
const backend = process.env.RADAR_BACKEND ?? "http://127.0.0.1:8080";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/ws": { target: backend.replace(/^http/, "ws"), ws: true },
      "/maps": backend,
      "/data": backend,
    },
  },
  test: { globals: true },
});
