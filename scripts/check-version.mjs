// The two manifests and package.json must agree on the version, and the changelog must
// have an entry for it.
//
// A stale manifest version is an automatic Chrome Web Store rejection: an upload has to be
// strictly greater than what is published. That has already cost this project one round
// trip, and a round trip is days. It is a one-line check, so it should never cost a second.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const readJson = (p) => JSON.parse(read(p));

const sources = {
  "package.json": readJson("package.json").version,
  "extension/manifest.json": readJson("extension/manifest.json").version,
  "extension/manifest.firefox.json": readJson("extension/manifest.firefox.json").version,
};

const versions = [...new Set(Object.values(sources))];
const problems = [];

if (versions.length !== 1) {
  problems.push(
    "Version disagreement:\n" +
      Object.entries(sources).map(([file, v]) => `  ${v}  ${file}`).join("\n")
  );
}

const version = sources["extension/manifest.json"];

if (!/^\d+\.\d+\.\d+$/.test(version)) {
  problems.push(`Version "${version}" is not a plain semver triple, which is what the stores expect.`);
}

const changelog = read("CHANGELOG.md");
if (!changelog.includes(`[${version}]`) && !changelog.includes(`## ${version}`)) {
  problems.push(`CHANGELOG.md has no entry for ${version}. Shipping a version nobody wrote down is how you lose track of what users are running.`);
}

if (problems.length) {
  console.error("Release metadata is inconsistent:\n");
  for (const p of problems) console.error(p + "\n");
  process.exit(1);
}

console.log(`Release metadata agrees: ${version}`);
