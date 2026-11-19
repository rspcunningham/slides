#!/usr/bin/env node
// Pack a deck folder into one .deck file, or unpack a .deck file into a deck folder.
//
//   node scripts/pack.mjs <deck-dir | deck-name> [--out file.deck]
//   node scripts/pack.mjs --unpack <file.deck> [deck-dir]
//
// A .deck file is a zip of the deck's project/ folder: the one file to send someone. The viewer
// app opens either form. Unpacking writes <deck-dir>/project/… (default: the file's name without
// .deck, beside it) and will not write into a folder that already holds a deck unless --force.

import fs from "node:fs";
import path from "node:path";
import { usage, deckOrExit, shortPath } from "../engine/args.mjs";
import { DECK_EXT, packDeck, unpackDeck } from "../engine/bundle.mjs";

const USAGE = "node scripts/pack.mjs <deck-dir | deck-name> [--out file.deck]\n       node scripts/pack.mjs --unpack <file.deck> [deck-dir] [--force]";

const args = process.argv.slice(2);
let out, unpack = false, force = false;
const rest = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--out" || a === "-o") out = args[++i];
  else if (a === "--unpack") unpack = true;
  else if (a === "--force") force = true;
  else if (a === "-h" || a === "--help") usage(USAGE, 0);
  else rest.push(a);
}

try {
  if (unpack) {
    const file = rest[0] && path.resolve(rest[0]);
    if (!file || !fs.existsSync(file)) {
      console.error(rest[0] ? `No file at "${rest[0]}".` : "Which .deck file?");
      usage(USAGE, 1);
    }
    const dest = path.resolve(rest[1] || file.replace(/\.deck$/i, "") + (/\.deck$/i.test(file) ? "" : "-deck"));
    if (fs.existsSync(path.join(dest, "project", "deck.json")) && !force) {
      console.error(`${shortPath(dest)} already holds a deck. Name another folder, or pass --force to replace its project/ folder.`);
      process.exit(1);
    }
    const files = unpackDeck(fs.readFileSync(file), dest);
    console.log(`${shortPath(file)} → ${shortPath(dest)}/  (${files} files)`);
  } else {
    const deckDir = deckOrExit(rest[0], USAGE);
    const outFile = path.resolve(out || path.join(deckDir, path.basename(deckDir) + DECK_EXT));
    const { data, files } = packDeck(deckDir);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, data);
    console.log(`${shortPath(deckDir)} → ${shortPath(outFile)}  (${files} files, ${(data.length / 1e6).toFixed(1)} MB)`);
  }
} catch (e) {
  console.error((unpack ? "unpack" : "pack") + " failed:", e.message);
  process.exitCode = 1;
}
