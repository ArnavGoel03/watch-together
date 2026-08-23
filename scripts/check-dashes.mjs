// Em dashes and en dashes are banned in this project, everywhere: prose, code, comments,
// commit messages, UI copy. A rule that nothing checks is a suggestion, so this checks it.
//
// The one legitimate exception is a literal that exists because some input genuinely
// contains one and the code has to match or normalise it. There is none of that here, so
// this is a flat ban.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Build output is not source. `dist` was always here for that reason; `build` and
// `xcuserdata` joined it when Safari arrived, because Xcode's module cache is full of
// binary .pcm files whose bytes contain the same sequence an em dash does. Skipping
// generated artefacts is not weakening the rule, it is pointing it at authored text.
const SKIP = new Set([
  "node_modules", ".git", "dist", ".DS_Store", "icons", "build", "xcuserdata",
]);
const BINARY = /\.(png|jpg|jpeg|gif|webm|mp4|zip|ico|woff2?)$/i;
// Built from code points rather than written out, because this file would otherwise be the
// one place in the repo that legitimately contains the characters it bans, and it would
// flag itself. This is the exception the rule allows: matching input, not authored prose.
const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);
const DASHES = new RegExp(`[${EM_DASH}${EN_DASH}]`);

const hits = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full);
      continue;
    }
    if (BINARY.test(entry)) continue;
    let text;
    try {
      text = readFileSync(full, "utf8");
    } catch {
      continue; // unreadable or not text: nothing to check
    }
    if (!DASHES.test(text)) continue;
    text.split("\n").forEach((line, i) => {
      if (DASHES.test(line)) hits.push(`${relative(root, full)}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
}

walk(root);

if (hits.length) {
  console.error(`Found ${hits.length} em/en dash${hits.length === 1 ? "" : "es"}. Use a comma, colon, or plain hyphen.\n`);
  for (const h of hits.slice(0, 40)) console.error("  " + h);
  if (hits.length > 40) console.error(`  ... and ${hits.length - 40} more`);
  process.exit(1);
}

console.log("No em or en dashes anywhere.");
