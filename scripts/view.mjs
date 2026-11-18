#!/usr/bin/env node
// Serve a deck and open it in the browser. Live-reloads on any change in the deck folder.
//
//   node scripts/view.mjs <deck-dir | deck-name> [--port 4300] [--no-open]

import { spawn } from "node:child_process";
import { resolveDeck, listDecks, readIndex } from "./lib/deck.mjs";
import { createDeckServer } from "./lib/server.mjs";

const args = process.argv.slice(2);
let port = 4300;
let open = true;
let deckArg;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--port") port = Number(args[++i]);
  else if (args[i] === "--no-open") open = false;
  else if (args[i] === "-h" || args[i] === "--help") usage(0);
  else deckArg = args[i];
}

function usage(code) {
  console.log("usage: node scripts/view.mjs <deck-dir | deck-name> [--port 4300] [--no-open]");
  const decks = listDecks();
  if (decks.length) console.log("\ndecks:\n" + decks.map((n) => "  " + n).join("\n"));
  process.exit(code);
}

const deckDir = resolveDeck(deckArg);
if (!deckDir) {
  console.error(deckArg ? `No project/deck.json found for "${deckArg}".` : "Which deck?");
  usage(1);
}

const { listen } = createDeckServer(deckDir);
const actual = await listen(port);
const url = `http://127.0.0.1:${actual}/`;
let title = deckDir;
try {
  title = readIndex(deckDir).title;
} catch {}
console.log(`${title}\n  deck:   ${deckDir}\n  viewer: ${url}\n  live-reloads on save · Ctrl+C to stop`);

if (open) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
}
