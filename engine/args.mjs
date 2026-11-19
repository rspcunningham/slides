// What the command-line tools share: reading a slide range, and naming a deck.

import path from "node:path";
import { resolveDeck, listDecks } from "./deck.mjs";

/** "3,5-7" → Set {3, 5, 6, 7}, or null when nothing in it is a number. */
export function parseRange(s) {
  const set = new Set();
  for (const part of String(s || "").split(",")) {
    const m = part.trim().match(/^(\d+)(?:-(\d+))?$/);
    if (!m) continue;
    for (let n = Number(m[1]); n <= Number(m[2] || m[1]); n++) set.add(n);
  }
  return set.size ? set : null;
}

/** Print a command's usage line and the decks under ./decks/, then exit. */
export function usage(line, code) {
  console.log("usage: " + line);
  const decks = listDecks();
  if (decks.length) console.log("\ndecks under ./decks/:\n" + decks.map((n) => "  " + n).join("\n"));
  process.exit(code);
}

/** The deck folder `arg` names (a path, or a name under ./decks/), or exit with the usage. */
export function deckOrExit(arg, usageLine) {
  const deckDir = resolveDeck(arg);
  if (deckDir) return deckDir;
  console.error(arg ? `No project/deck.json found for "${arg}".` : "Which deck?");
  usage(usageLine, 1);
}

/** A path as the person would type it: relative when it is under the current folder. */
export function shortPath(file) {
  return file.startsWith(process.cwd() + path.sep) ? path.relative(process.cwd(), file) : file;
}
