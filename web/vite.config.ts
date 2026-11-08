import { defineConfig } from "vite";

// Dev server: proxies the backend routes to a running radar-backend (live or --replay).
const backend = process.env.RADAR_BACKEND ?? "http://127.0.0.1:8080";

export default defineConfig({
  server: {
    proxy: {
      "/ws": { target: backend.replace(/^http/, "ws"), ws: true },
      "/maps": backend,
      "/data": backend,
    },
  },
  test: { globals: true },
});
