#!/usr/bin/env node
// The viewer app: one long-running server that shows any number of decks, each from its own
// folder or .deck file anywhere on disk. Start it with `node app/slides.mjs open <deck>`.
//
//   /                      the open decks, and a way to open another
//   /ui/…                  the app's own pages, scripts and styles (app/ui)
//   /render/…              the renderer (engine/render)
//   /d/<key>/              the viewer, on one deck
//   /d/<key>/deck/…        the assembled deck and its files (engine/serve.mjs)
//   /d/<key>/api/meta      { key, title, w, h, count, source, kind }
//   /d/<key>/api/pdf       the deck as a PDF, one slide per page
//   /d/<key>/api/pptx      the deck as a PowerPoint file (?fonts=basic, ?pictures=1)
//   /d/<key>/events        server-sent events: one message per change in the deck
//   /_blob/<id>            a Claude asset id, for the deck the request came from
//   /api/ping              { app: "slides", pid, port }
//   /api/decks             the open decks
//   POST /api/open         { path }: open a deck folder or a .deck file from disk
//   POST /api/upload       body: a .deck file (?name=…): open it
//   POST /api/close        { key }
//   POST /api/stop         shut the app down
//
// The app keeps no record between runs: a deck is open until it is closed or the app stops.

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDeck, readIndex, slideIds, findBlob } from "../engine/deck.mjs";
import { send, sendJson, sendFile, serveUnder, serveDeck, serveRender, serveBlob, requestUrl } from "../engine/serve.mjs";
import { DECK_EXT, isDeckFile, unpackDeck } from "../engine/bundle.mjs";
import { exportPdf } from "../engine/pdf.mjs";
import { exportPptx } from "../engine/pptx.mjs";

const UI = path.join(path.dirname(fileURLToPath(import.meta.url)), "ui");
export const DEFAULT_PORT = 4300;
const MAX_UPLOAD = 1024 ** 3;

function slug(name) {
  return name.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "deck";
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      if ((size += c.length) > limit) {
        reject(Object.assign(new Error("too large"), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const fail = (status, message) => Object.assign(new Error(message), { status });

export function createApp() {
  const decks = new Map(); // key → { key, dir, source, kind, temp, clients, stopWatching, jobs }
  let tempRoot = null;
  let port = 0;
  let onStop = () => {};

  const tempDir = (key) => {
    tempRoot ??= fs.mkdtempSync(path.join(os.tmpdir(), "slides-app-"));
    return fs.mkdtempSync(path.join(tempRoot, key + "-"));
  };

  function freeKey(base) {
    let key = base;
    for (let n = 2; decks.has(key); n++) key = `${base}-${n}`;
    return key;
  }

  const notify = (deck) => deck.clients.forEach((c) => c.write("data: change\n\n"));

  function watchFolder(deck) {
    let timer;
    let watcher;
    try {
      watcher = fs.watch(deck.dir, { recursive: true }, (_event, file) => {
        // Ignore dot-folders such as .preview/ (screenshots) and editor temp files.
        if (file && String(file).split(path.sep).some((seg) => seg.startsWith("."))) return;
        clearTimeout(timer);
        timer = setTimeout(() => notify(deck), 100);
      });
      watcher.on("error", () => {});
    } catch {}
    return () => {
      clearTimeout(timer);
      watcher?.close();
    };
  }

  // A .deck file is shown from an unpacked copy: unpack it again whenever the file changes.
  function watchFile(deck) {
    const listener = (now, before) => {
      if (!now.mtimeMs || (now.mtimeMs === before.mtimeMs && now.size === before.size)) return;
      try {
        unpackDeck(fs.readFileSync(deck.source), deck.dir);
        notify(deck);
      } catch {}
    };
    fs.watchFile(deck.source, { interval: 500 }, listener);
    return () => fs.unwatchFile(deck.source, listener);
  }

  function add(deck) {
    deck.clients = new Set();
    deck.jobs = new Map();
    deck.stopWatching = deck.kind === "folder" ? watchFolder(deck) : deck.kind === "file" ? watchFile(deck) : () => {};
    decks.set(deck.key, deck);
    return deck;
  }

  /** Open a deck folder or a .deck file by its path on disk. The same path twice is one deck. */
  function openPath(p) {
    if (typeof p !== "string" || !p.trim()) throw fail(400, "Which deck? Give a folder or a .deck file.");
    const abs = path.resolve(p.trim().replace(/^~(?=$|\/)/, os.homedir()));

    if (isDeckFile(abs)) {
      const file = fs.realpathSync(abs);
      const open = [...decks.values()].find((d) => d.kind === "file" && d.source === file);
      if (open) return open;
      const key = freeKey(slug(path.basename(file, path.extname(file))));
      const dir = tempDir(key);
      try {
        unpackDeck(fs.readFileSync(file), dir);
      } catch (e) {
        fs.rmSync(dir, { recursive: true, force: true });
        throw fail(400, `${path.basename(file)}: ${e.message}`);
      }
      return add({ key, dir, source: file, kind: "file", temp: true });
    }

    const dir = resolveDeck(abs);
    if (!dir) throw fail(404, fs.existsSync(abs) ? `No project/deck.json in ${abs}: it is not a deck folder or a ${DECK_EXT} file.` : `Nothing at ${abs}.`);
    const real = fs.realpathSync(dir);
    const open = [...decks.values()].find((d) => d.kind === "folder" && d.dir === real);
    if (open) return open;
    return add({ key: freeKey(slug(path.basename(real))), dir: real, source: real, kind: "folder", temp: false });
  }

  /** Open a .deck file sent by the browser. The same name again replaces what that deck shows. */
  function openUpload(name, data) {
    const base = slug(path.basename(String(name || "deck")).replace(/\.(deck|zip)$/i, ""));
    const source = `${base}${DECK_EXT} (dropped in)`;
    const open = [...decks.values()].find((d) => d.kind === "upload" && d.source === source);
    const dir = open ? open.dir : tempDir(base);
    try {
      unpackDeck(data, dir);
    } catch (e) {
      if (!open) fs.rmSync(dir, { recursive: true, force: true });
      throw fail(400, `${base}${DECK_EXT}: ${e.message}`);
    }
    if (open) {
      notify(open);
      return open;
    }
    return add({ key: freeKey(base), dir, source, kind: "upload", temp: true });
  }

  function closeDeck(deck) {
    deck.stopWatching();
    deck.clients.forEach((c) => c.end());
    if (deck.temp) fs.rmSync(deck.dir, { recursive: true, force: true });
    decks.delete(deck.key);
  }

  function describe(deck) {
    const out = { key: deck.key, url: `http://127.0.0.1:${port}/d/${deck.key}/`, source: deck.source, kind: deck.kind, viewers: deck.clients.size };
    try {
      const idx = readIndex(deck.dir);
      const { ids } = slideIds(deck.dir, idx.order);
      Object.assign(out, { title: idx.title, w: idx.w, h: idx.h, count: ids.length });
    } catch (e) {
      Object.assign(out, { title: deck.key, w: 1920, h: 1080, count: 0, error: e.code === "ENOENT" ? "The deck's files are gone." : e.message });
    }
    return out;
  }

  // One export of a kind at a time per deck: a second request while Chrome works gets the same file.
  function job(deck, name, run) {
    if (!deck.jobs.has(name)) deck.jobs.set(name, run().finally(() => deck.jobs.delete(name)));
    return deck.jobs.get(name);
  }

  function download(res, promise, pick, file, type) {
    promise.then(
      (result) => {
        const body = pick(result);
        res.writeHead(200, { "Content-Type": type, "Content-Length": body.length, "Content-Disposition": `attachment; filename="${file}"`, "Cache-Control": "no-store", ...(result.headers || {}) });
        res.end(body);
      },
      (e) => sendJson(res, 500, { error: e.message }),
    );
  }

  function deckRoute(deck, rest, url, req, res) {
    if (rest === "") return serveUnder(res, UI, "index.html");
    if (rest === "deck") {
      res.writeHead(302, { Location: `/d/${deck.key}/deck/${url.search}` });
      return res.end();
    }
    if (rest.startsWith("deck/")) return serveDeck(deck.dir, rest.slice("deck/".length), url, res);

    if (rest === "api/meta") {
      const d = describe(deck);
      return sendJson(res, d.error ? 500 : 200, d);
    }
    if (rest === "api/pdf")
      return download(res, job(deck, "pdf", () => exportPdf(deck.dir)), (r) => r.pdf, `${deck.key}.pdf`, "application/pdf");
    if (rest === "api/pptx") {
      const basicFonts = url.searchParams.get("fonts") === "basic";
      const pictures = url.searchParams.get("pictures") === "1";
      const run = () =>
        exportPptx(deck.dir, { basicFonts, pictures }).then((r) => {
          // What the browser can't see in the file: the faces this computer lacks, and what was left out.
          const missing = pictures ? [] : r.model.fonts.filter((f) => !f.local).map((f) => f.name);
          const notes = { missingFonts: missing, leftOut: r.model.warnings.length };
          return { pptx: r.pptx, headers: { "X-Export-Notes": encodeURIComponent(JSON.stringify(notes)) } };
        });
      return download(res, job(deck, `pptx:${basicFonts}:${pictures}`, run), (r) => r.pptx, `${deck.key}.pptx`, "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    }

    if (rest === "events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      res.write(": connected\n\n");
      deck.clients.add(res);
      req.on("close", () => deck.clients.delete(res));
      return;
    }
    send(res, 404, "Not found");
  }

  async function api(p, url, req, res) {
    if (p === "/api/ping") return sendJson(res, 200, { app: "slides", pid: process.pid, port });
    if (p === "/api/decks") return sendJson(res, 200, { decks: [...decks.values()].map(describe) });

    if (req.method !== "POST") return send(res, 405, "Method not allowed");
    if (p === "/api/upload") {
      const deck = openUpload(url.searchParams.get("name"), await readBody(req, MAX_UPLOAD));
      return sendJson(res, 200, describe(deck));
    }
    let body = {};
    try {
      const raw = await readBody(req, 1 << 20);
      if (raw.length) body = JSON.parse(raw.toString("utf8"));
    } catch (e) {
      if (e.status) throw e;
      throw fail(400, "The request body is not JSON.");
    }
    if (p === "/api/open") return sendJson(res, 200, describe(openPath(body.path)));
    if (p === "/api/close") {
      const deck = decks.get(body.key);
      if (!deck) throw fail(404, `No open deck "${body.key}".`);
      closeDeck(deck);
      return sendJson(res, 200, { closed: body.key });
    }
    if (p === "/api/stop") {
      sendJson(res, 200, { stopped: true });
      return setTimeout(stop, 50);
    }
    send(res, 404, "Not found");
  }

  const server = http.createServer((req, res) => {
    // Only this computer's own pages may talk to the app: a web page elsewhere can't reach it
    // under another name, or post to it.
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!hosts.includes(req.headers.host)) return send(res, 403, "Forbidden");
    if (req.method !== "GET" && req.method !== "HEAD") {
      const origin = req.headers.origin;
      if (origin && !hosts.some((h) => origin === `http://${h}`)) return send(res, 403, "Forbidden");
    }

    const url = requestUrl(req);
    if (!url) return send(res, 400, "Bad request");
    const p = url.pathname;

    if (p.startsWith("/api/"))
      return api(p, url, req, res).catch((e) => (res.headersSent ? res.end() : sendJson(res, e.status || 500, { error: e.message })));
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");

    if (p === "/") return sendFile(res, path.join(UI, "home.html"));
    if (p.startsWith("/ui/")) return serveUnder(res, UI, p.slice("/ui/".length));
    if (p.startsWith("/render/")) return serveRender(p.slice("/render/".length), res);

    const m = p.match(/^\/d\/([^/]+)(?:\/(.*))?$/);
    if (m) {
      const deck = decks.get(m[1]);
      if (!deck) {
        // The viewer page itself still loads, and says the deck is not open.
        if (m[2] === "") return serveUnder(res, UI, "index.html");
        if (m[2] === undefined) {
          res.writeHead(302, { Location: `/d/${m[1]}/` });
          return res.end();
        }
        return sendJson(res, 404, { error: "This deck is not open in the app.", closed: true });
      }
      if (m[2] === undefined) {
        res.writeHead(302, { Location: `/d/${deck.key}/${url.search}` });
        return res.end();
      }
      return deckRoute(deck, m[2], url, req, res);
    }

    // A deck that came from Claude names its pictures /_blob/<id>, with no deck in the path:
    // take the deck from the page that asked, else look in every open deck.
    const blob = p.match(/^\/_blob\/([^/]+)$/);
    if (blob) {
      let from;
      try {
        from = decks.get(new URL(req.headers.referer).pathname.match(/^\/d\/([^/]+)\//)?.[1]);
      } catch {}
      from ??= [...decks.values()].find((d) => findBlob(d.dir, blob[1]));
      return from ? serveBlob(res, from.dir, blob[1]) : send(res, 404, `No open deck has asset ${blob[1]}`);
    }

    send(res, 404, "Not found");
  });

  const pings = setInterval(() => decks.forEach((d) => d.clients.forEach((c) => c.write(": ping\n\n"))), 25000);
  pings.unref();

  function listen(wanted) {
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(wanted, "127.0.0.1", () => {
        port = server.address().port;
        resolve(port);
      });
    });
  }

  function stop() {
    clearInterval(pings);
    [...decks.values()].forEach(closeDeck);
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
    server.close();
    server.closeAllConnections?.();
    onStop();
  }

  return { listen, stop, openPath, set onStop(fn) { onStop = fn; } };
}

// Run directly: `node app/server.mjs [--port N]`.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf("--port");
  const wanted = at > 0 ? Number(process.argv[at + 1]) : Number(process.env.SLIDES_PORT) || DEFAULT_PORT;
  const app = createApp();
  app.onStop = () => process.exit(0);
  process.on("SIGINT", () => app.stop());
  process.on("SIGTERM", () => app.stop());
  try {
    const port = await app.listen(wanted);
    console.log(`slides app: http://127.0.0.1:${port}/  (pid ${process.pid})`);
  } catch (e) {
    console.error(e.code === "EADDRINUSE" ? `Port ${wanted} is in use. Pick another with --port N or SLIDES_PORT.` : e.message);
    process.exit(1);
  }
}
