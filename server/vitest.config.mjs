import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The *.test.mjs files are node:test suites, run by `node --test`. Vitest cannot read
    // them and reports "no test suite found", so keep it to the files that are its own.
    include: ["**/*.test.js"],
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
