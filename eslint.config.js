// Flat config. The point of lint here is not style: it is the specific class of defect
// this codebase has actually shipped. A leaked setInterval that nobody cleared, a promise
// rejection swallowed by an empty catch, a variable that survived a refactor. Those are
// the rules that earn their place; formatting opinions are left out on purpose so the
// signal stays readable.

import js from "@eslint/js";
import globals from "globals";

const sharedRules = {
  "no-unused-vars": ["error", { args: "none", varsIgnorePattern: "^_" }],
  "no-undef": "error",
  // An empty catch is how the autoplay-policy failure stayed invisible for months: the
  // browser refused to play, the rejection went into `catch {}`, and the viewer just sat
  // there watching a paused video with nothing on screen to explain it.
  "no-empty": ["error", { allowEmptyCatch: true }],
  // Deliberately off. The extension's background scripts and the popup are CLASSIC
  // scripts, not modules: top-level function declarations are exactly how they are meant
  // to be written, and an IIFE wrapper would buy nothing.
  "no-implicit-globals": "off",
  "prefer-const": "error",
  "no-var": "error",
  eqeqeq: ["error", "smart"],
  "no-throw-literal": "error",
  "no-return-await": "error",
  "require-atomic-updates": "off",
  "no-constant-condition": ["error", { checkLoops: false }],
};

export default [
  { ignores: ["node_modules/**", "**/node_modules/**", "server/fixtures/**", "bin/**", "scripts/make_icons.py"] },
  js.configs.recommended,

  // Extension surfaces: browser globals plus the extension APIs. These files are loaded
  // directly by the browser as classic scripts, so no module syntax and no imports.
  {
    files: ["extension/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "script",
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        chrome: "readonly",
        importScripts: "readonly",
        RTCPeerConnection: "readonly",
      },
    },
    rules: sharedRules,
  },

  // Node sync server: CommonJS.
  {
    files: ["server/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "commonjs",
      globals: { ...globals.node },
    },
    rules: sharedRules,
  },

  // Test files: same as above but with the test runner's globals. browser.test.js also
  // contains page-context code passed to page.evaluate(), which really does run in a
  // browser and really does see document and chrome, so it gets both sets.
  {
    files: ["server/*.test.js", "server/*.test.mjs", "server-cf/*.test.mjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...globals.node, ...globals.vitest, ...globals.browser, chrome: "readonly" },
    },
    rules: { ...sharedRules, "no-unused-vars": ["warn", { args: "none" }] },
  },

  // Config files that really are ES modules.
  {
    files: ["**/vitest.config.js", "eslint.config.js", "scripts/*.mjs"],
    languageOptions: { ecmaVersion: 2023, sourceType: "module", globals: { ...globals.node } },
    rules: sharedRules,
  },

  // Cloudflare Worker: module syntax, Workers runtime globals.
  {
    files: ["server-cf/src/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        ...globals.browser,
        WebSocketPair: "readonly",
        Response: "readonly",
        Request: "readonly",
        crypto: "readonly",
      },
    },
    rules: sharedRules,
  },
];
