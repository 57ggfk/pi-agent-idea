import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    sourcemap: false,
    target: "es2022",
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  test: {
    // Playwright specs have their own runner (playwright.config.ts).
    exclude: ["**/node_modules/**", "e2e/**"],
  },
});
