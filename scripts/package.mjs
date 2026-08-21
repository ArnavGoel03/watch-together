// Builds the two store packages, and refuses to produce one that is wrong.
//
// This used to be a `zip` one-liner in the docs, typed by hand, with the exclusions
// remembered by whoever was doing it. Running it verbatim shipped this project's Claude
// Code working directories into the Chrome Web Store package. A release step that depends
// on someone remembering four -x flags at midnight is not a release step.
//
// The Chrome and Firefox builds differ in which manifest and which background script they
// carry, and shipping the wrong one is silent: the extension simply does nothing.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, cpSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const staging = join(dist, ".staging");

const version = JSON.parse(readFileSync(join(root, "extension/manifest.json"), "utf8")).version;

// Anything matching these never belongs in a published package: editor and agent state,
// version control, dependencies, tests, and OS litter.
const EXCLUDE = [
  /(^|\/)\.claude(\/|$)/,
  /(^|\/)\.git(\/|$)/,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)\.DS_Store$/,
  /(^|\/)\.env/,
  /\.test\.(js|mjs)$/,
  /\.map$/,
];

function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = relative(base, full);
    if (EXCLUDE.some((re) => re.test(rel))) continue;
    if (statSync(full).isDirectory()) out.push(...walk(full, base));
    else out.push(rel);
  }
  return out;
}

/**
 * @param {"chrome"|"firefox"} target
 */
function build(target) {
  const work = join(staging, target);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  for (const rel of walk(join(root, "extension"))) {
    cpSync(join(root, "extension", rel), join(work, rel), { recursive: false, force: true, errorOnExist: false, dereference: true, mkdir: true });
  }

  // Each store gets exactly one manifest and one background script. Leaving the other
  // browser's files in the package is how a reviewer finds a manifest that contradicts
  // the one they are reviewing.
  if (target === "chrome") {
    rmSync(join(work, "manifest.firefox.json"), { force: true });
    rmSync(join(work, "background-firefox.js"), { force: true });
  } else {
    cpSync(join(work, "manifest.firefox.json"), join(work, "manifest.json"), { force: true });
    rmSync(join(work, "manifest.firefox.json"), { force: true });
    rmSync(join(work, "background.js"), { force: true });
  }

  const shipped = walk(work);

  // Verify rather than trust. Every file listed in the manifest must actually be present,
  // because a missing content script is not an error at install time: the extension loads
  // and quietly does nothing.
  const manifest = JSON.parse(readFileSync(join(work, "manifest.json"), "utf8"));
  const required = [
    ...(manifest.content_scripts ?? []).flatMap((cs) => cs.js ?? []),
    ...(manifest.background?.scripts ?? []),
    ...(manifest.background?.service_worker ? [manifest.background.service_worker] : []),
    ...Object.values(manifest.icons ?? {}),
  ];
  const missing = required.filter((f) => !existsSync(join(work, f)));
  if (missing.length) {
    throw new Error(`${target}: manifest references files that are not in the package: ${missing.join(", ")}`);
  }

  // And nothing that should never ship made it in.
  const leaked = shipped.filter((f) => EXCLUDE.some((re) => re.test(f)));
  if (leaked.length) {
    throw new Error(`${target}: excluded files leaked into the package: ${leaked.join(", ")}`);
  }
  const strayManifest = shipped.filter((f) => f !== "manifest.json" && f.startsWith("manifest"));
  if (strayManifest.length) {
    throw new Error(`${target}: more than one manifest in the package: ${strayManifest.join(", ")}`);
  }

  const zipPath = join(dist, `watch-together-${target}-v${version}.zip`);
  rmSync(zipPath, { force: true });
  execFileSync("zip", ["-r", "-q", "-X", zipPath, "."], { cwd: work });

  const bytes = statSync(zipPath).size;
  console.log(`${target.padEnd(8)} ${(bytes / 1024).toFixed(0).padStart(5)} KB  ${shipped.length} files  ${relative(root, zipPath)}`);
  return { zipPath, files: shipped };
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

console.log(`Packaging Watch Together v${version}\n`);
const chrome = build("chrome");
const firefox = build("firefox");
rmSync(staging, { recursive: true, force: true });

writeFileSync(
  join(dist, "MANIFEST.txt"),
  `Watch Together v${version}\n\nchrome:\n${chrome.files.map((f) => "  " + f).join("\n")}\n\nfirefox:\n${firefox.files.map((f) => "  " + f).join("\n")}\n`
);

console.log(`\nBoth packages verified: every file the manifest names is present, nothing excluded leaked in.`);
console.log(`File listing written to dist/MANIFEST.txt`);
