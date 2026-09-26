import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In development the engine runs on :8787; in production it serves this app itself.
const engine = process.env["ENGINE_URL"] ?? "http://localhost:8787";

export default defineConfig({
  plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), react(), tailwindcss()],
  resolve: { tsconfigPaths: true },
  server: {
    port: 5173,
    proxy: Object.fromEntries(
      ["/v1", "/files", "/webhooks", "/app-config.json"].map((p) => [p, engine]),
    ),
  },
});
