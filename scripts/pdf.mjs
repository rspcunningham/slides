#!/usr/bin/env node
// Export a deck to PDF, one slide per page, with real text (the viewer app's Export PDF button
// does the same).
//
//   node scripts/pdf.mjs <deck-dir | deck-name> [--out file.pdf] [--slides 3,5-7]
//
// The deck is laid out and printed by headless Chrome: every step shown, animations at their
// end, a clip as its still. Needs Node 22+ and Chrome; no npm install. The viewer app need not
// be running.

import fs from "node:fs";
import path from "node:path";
import { parseRange, usage, deckOrExit, shortPath } from "../engine/args.mjs";
import { exportPdf } from "../engine/pdf.mjs";

const USAGE = "node scripts/pdf.mjs <deck-dir | deck-name> [--out file.pdf] [--slides 3,5-7]";

const args = process.argv.slice(2);
let deckArg, out, only = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--out" || a === "-o") out = args[++i];
  else if (a === "--slides") only = parseRange(args[++i]);
  else if (a === "-h" || a === "--help") usage(USAGE, 0);
  else deckArg = a;
}

const deckDir = deckOrExit(deckArg, USAGE);
const outFile = path.resolve(out || path.join(deckDir, path.basename(deckDir) + ".pdf"));

try {
  const { pdf, pages, total, index } = await exportPdf(deckDir, { only });
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, pdf);
  console.log(`${index.title}: ${only ? `${pages} of ${total}` : total} slides → ${shortPath(outFile)}  (${(pdf.length / 1e6).toFixed(1)} MB)`);
} catch (e) {
  console.error("export failed:", e.message);
  process.exitCode = 1;
}
