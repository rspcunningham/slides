#!/usr/bin/env node
// The viewer app's command. The app is one background server that shows any number of decks;
// this starts it when it isn't running, and tells it what to open.
//
//   node app/slides.mjs open [deck]     show a deck (a folder, a .deck file, or a name under ./decks/)
//                                       in the app; with no deck, the list of open decks
//   node app/slides.mjs list            the open decks
//   node app/slides.mjs close <deck>    close a deck (its key, folder or file); "all" closes every deck
//   node app/slides.mjs status          is the app running?
//   node app/slides.mjs stop            stop the app
//   node app/slides.mjs restart         stop and start it, with the same decks open
//   node app/slides.mjs serve           run the app in this terminal instead of the background
//
//   --port N     the app's port (default 4300, or SLIDES_PORT)
//   --no-open    don't open a browser tab
//
// `open` returns at once and the app keeps running. It opens a browser tab only when no tab is
// showing that deck already.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveDeck, listDecks } from "../engine/deck.mjs";
import { isDeckFile } from "../engine/bundle.mjs";
import { DEFAULT_PORT } from "./server.mjs";

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), "server.mjs");
const LOG = path.join(os.tmpdir(), "slides-app.log");
const COMMANDS = ["open", "list", "close", "status", "stop", "restart", "serve"];

const argv = process.argv.slice(2);
let port = Number(process.env.SLIDES_PORT) || DEFAULT_PORT;
let openTab = true;
const words = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--port") port = Number(argv[++i]);
  else if (argv[i] === "--no-open") openTab = false;
  else if (argv[i] === "-h" || argv[i] === "--help") usage(0);
  else words.push(argv[i]);
}
// A deck with no command means open it.
const command = COMMANDS.includes(words[0]) ? words.shift() : words.length ? "open" : usage(1);
const base = `http://127.0.0.1:${port}`;

function usage(code) {
  console.log(
    [
      "usage: node app/slides.mjs <command> [--port N] [--no-open]",
      "",
      "  open [deck]    show a deck in the app: a folder, a .deck file, or a name under ./decks/",
      "  list           the open decks",
      "  close <deck>   close a deck (its key, folder or file), or all",
      "  status         is the app running?",
      "  stop           stop the app",
      "  restart        stop and start it, with the same decks open",
      "  serve          run the app in this terminal",
    ].join("\n"),
  );
  const decks = listDecks();
  if (decks.length) console.log("\ndecks under ./decks/:\n" + decks.map((n) => "  " + n).join("\n"));
  process.exit(code);
}

function die(msg) {
  console.error(msg);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** null: nothing answers on the port. false: something else does. Else the app's ping. */
async function ping() {
  try {
    const r = await fetch(base + "/api/ping", { signal: AbortSignal.timeout(1500) });
    const j = await r.json().catch(() => null);
    return j && j.app === "slides" ? j : false;
  } catch (e) {
    return e.name === "TimeoutError" ? false : null;
  }
}

async function call(pathname, body) {
  const r = await fetch(base + pathname, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) die(j.error || `${pathname}: ${r.status} ${r.statusText}`);
  return j;
}

async function ensureRunning() {
  const up = await ping();
  if (up) return false;
  if (up === false) die(`Port ${port} is in use by something else. Pick another with --port N or SLIDES_PORT.`);
  const log = fs.openSync(LOG, "a");
  spawn(process.execPath, [SERVER, "--port", String(port)], { detached: true, stdio: ["ignore", log, log] }).unref();
  fs.closeSync(log);
  for (let i = 0; i < 50; i++) {
    await sleep(100);
    if (await ping()) return true;
  }
  die(`The app did not start. Its log: ${LOG}`);
}

function browse(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
}

/** A deck argument as an absolute path to a folder or a .deck file, or null. */
function deckPath(arg) {
  const abs = path.resolve(arg);
  return isDeckFile(abs) ? abs : resolveDeck(arg);
}

async function stopApp() {
  await call("/api/stop", {});
  for (let i = 0; i < 50 && (await ping()) !== null; i++) await sleep(100);
}

if (command === "serve") {
  if (await ping()) die(`The app is already running at ${base}/`);
  spawn(process.execPath, [SERVER, "--port", String(port)], { stdio: "inherit" }).on("exit", (code) => process.exit(code ?? 0));
} else if (command === "open") {
  const target = words[0] ? deckPath(words[0]) : null;
  if (words[0] && !target) {
    console.error(`No deck at "${words[0]}": it needs a project/deck.json, or to be a .deck file.`);
    usage(1);
  }
  const started = await ensureRunning();
  if (!target) {
    console.log(`slides app${started ? " (started)" : ""}: ${base}/`);
    if (openTab) browse(base + "/");
  } else {
    const d = await call("/api/open", { path: target });
    console.log(`${d.title}\n  deck:   ${d.source}\n  viewer: ${d.url}\n  the app keeps running and reloads the deck when its files change`);
    if (d.error) console.log(`  ! ${d.error}`);
    if (openTab && !d.viewers) browse(d.url);
  }
} else if (command === "status") {
  const up = await ping();
  if (!up) console.log(up === false ? `Port ${port} is in use by something else.` : "The app is not running.");
  else {
    const { decks } = await call("/api/decks");
    console.log(`The app is running at ${base}/ (pid ${up.pid}), ${decks.length} deck${decks.length === 1 ? "" : "s"} open.`);
  }
} else if (!(await ping())) {
  console.log("The app is not running.");
  if (command === "restart") {
    await ensureRunning();
    console.log(`slides app (started): ${base}/`);
  }
} else if (command === "list") {
  const { decks } = await call("/api/decks");
  if (!decks.length) console.log("No decks open.");
  for (const d of decks) console.log(`${d.title}\n  deck:   ${d.source}\n  viewer: ${d.url}`);
} else if (command === "close") {
  if (!words[0]) die("Which deck? Give its key, folder or file, or all.");
  const { decks } = await call("/api/decks");
  const target = deckPath(words[0]);
  const hits = words[0] === "all" ? decks : decks.filter((d) => d.key === words[0] || (target && d.source === fs.realpathSync(target)));
  if (!hits.length) die(`No open deck matches "${words[0]}".`);
  for (const d of hits) {
    await call("/api/close", { key: d.key });
    console.log(`closed ${d.key}`);
  }
} else if (command === "stop") {
  await stopApp();
  console.log("The app is stopped.");
} else if (command === "restart") {
  const { decks } = await call("/api/decks");
  await stopApp();
  await ensureRunning();
  const kept = decks.filter((d) => d.kind !== "upload");
  for (const d of kept) await call("/api/open", { path: d.source });
  console.log(`slides app (restarted): ${base}/  ${kept.length} deck${kept.length === 1 ? "" : "s"} open`);
  if (kept.length < decks.length) console.log("Decks dropped into the browser were not kept: open them again.");
}
