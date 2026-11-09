import { defineConfig } from "@playwright/test";

/**
 * `PI_E2E_PORT` lets a second checkout (git worktree) run the suite while the
 * main one is serving 5173. `reuseExistingServer` reuses *whatever* listens on
 * that port, so running two branches against the same port silently tests the
 * wrong code — hence the explicit override instead of a shared default.
 */
const port = Number(process.env.PI_E2E_PORT ?? 5173);
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL,
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `npm run dev -- --port ${port}`,
    url: baseURL,
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
