#!/usr/bin/env node
// Export a deck to PDF, one slide per page, with real text (the viewer's Export PDF button does
// the same).
//
//   node scripts/pdf.mjs <deck-dir | deck-name> [--out file.pdf] [--slides 3,5-7]
//
// The deck is laid out and printed by headless Chrome: every step shown, animations at their
// end, a clip as its still. Needs Node 22+ and Chrome; no npm install.

import fs from "node:fs";
import path from "node:path";
import { resolveDeck, listDecks, readIndex } from "./lib/deck.mjs";
import { createDeckServer } from "./lib/server.mjs";
import { exportPdf } from "./lib/pdf.mjs";

const args = process.argv.slice(2);
let deckArg, out, only = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--out" || a === "-o") out = args[++i];
  else if (a === "--slides") only = parseRange(args[++i]);
  else if (a === "-h" || a === "--help") usage(0);
  else deckArg = a;
}

function parseRange(s) {
  const set = new Set();
  for (const part of String(s || "").split(",")) {
    const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!m) continue;
    for (let n = Number(m[1]); n <= Number(m[2] || m[1]); n++) set.add(n);
  }
  return set.size ? set : null;
}

function usage(code) {
  console.log("usage: node scripts/pdf.mjs <deck-dir | deck-name> [--out file.pdf] [--slides 3,5-7]");
  const decks = listDecks();
  if (decks.length) console.log("\ndecks:\n" + decks.map((n) => "  " + n).join("\n"));
  process.exit(code);
}

const deckDir = resolveDeck(deckArg);
if (!deckDir) {
  console.error(deckArg ? `No project/deck.json found for "${deckArg}".` : "Which deck?");
  usage(1);
}
const index = readIndex(deckDir);
const outFile = path.resolve(out || path.join(deckDir, path.basename(deckDir) + ".pdf"));

const { listen, close } = createDeckServer(deckDir, { watch: false });
const port = await listen(0);
try {
  const { pdf, pages, total } = await exportPdf(port, index, { only });
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, pdf);
  const rel = outFile.startsWith(process.cwd() + path.sep) ? path.relative(process.cwd(), outFile) : outFile;
  console.log(`${index.title}: ${only ? `${pages} of ${total}` : total} slides → ${rel}  (${(pdf.length / 1e6).toFixed(1)} MB)`);
} catch (e) {
  console.error("export failed:", e.message);
  process.exitCode = 1;
} finally {
  close();
}
