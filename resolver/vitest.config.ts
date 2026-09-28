import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["test/**/*.test.ts"],
    exclude: ["test/smoke/**"], // Smoke tests run separately
  },
  // Separate config for smoke tests
  testSmokes: {
    globals: true,
    include: ["test/smoke/**/*.ts"],
    testTimeout: 30000,
    hookTimeout: 10000,
  },
});
