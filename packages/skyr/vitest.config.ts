import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    maxWorkers: 2,
    minWorkers: 1,
    setupFiles: ["test/setup.ts"],
    // A faux step or tool left on hold fails the test instead of hanging the run.
    testTimeout: 5000,
  },
});
