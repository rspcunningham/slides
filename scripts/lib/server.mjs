// HTTP server for one deck: the viewer, the assembled deck page, its files, and live-reload events.
//
//   /                viewer UI
//   /viewer/…        viewer assets (base.css, elements.js, …)
//   /deck/           the assembled deck (?mode=all: every slide stacked, no viewer classes;
//                    &fonts=basic: without the deck's faces, each stack's basic face shows)
//   /deck/<path>     files from the deck folder (project/deck.css, project/assets/…)
//   /_blob/<id>      a Claude asset id, looked up in project/assets/ (also /deck/_blob/<id>)
//   /api/meta        { title, w, h, count }
//   /api/pdf         the deck as a PDF, one slide per page (printed by headless Chrome)
//   /events          server-sent events: one message per change in the deck folder

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { ROOT, buildDeck, readIndex, slideIds, findBlob } from "./deck.mjs";
import { exportPdf } from "./pdf.mjs";

const VIEWER = path.join(ROOT, "viewer");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
};

// Files saved without an extension (Claude asset ids): guess the type from the first bytes.
function sniff(file) {
  const b = Buffer.alloc(16);
  const fd = fs.openSync(file, "r");
  fs.readSync(fd, b, 0, 16, 0);
  fs.closeSync(fd);
  const s = b.toString("latin1");
  if (b[0] === 0x89 && s.slice(1, 4) === "PNG") return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (s.startsWith("GIF8")) return "image/gif";
  if (s.startsWith("RIFF") && s.slice(8, 12) === "WEBP") return "image/webp";
  if (s.startsWith("wOF2")) return "font/woff2";
  if (s.startsWith("wOFF")) return "font/woff";
  if (s.slice(4, 8) === "ftyp") return "video/mp4";
  if (s.trimStart().startsWith("<")) return "image/svg+xml";
  return "application/octet-stream";
}

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

function sendFile(res, file) {
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return send(res, 404, "Not found");
    const type = MIME[path.extname(file).toLowerCase()] || sniff(file);
    res.writeHead(200, { "Content-Type": type, "Content-Length": stat.size, "Cache-Control": "no-store" });
    fs.createReadStream(file).pipe(res);
  });
}

function serveUnder(res, root, rel) {
  const file = path.resolve(root, "." + path.sep + rel);
  if (file !== root && !file.startsWith(root + path.sep)) return send(res, 403, "Forbidden");
  sendFile(res, file);
}

export function createDeckServer(deckDir, { watch = true } = {}) {
  const clients = new Set();

  // One export at a time: a second request while Chrome is printing gets the same file.
  let pdfJob = null;
  const pdf = () => (pdfJob ??= exportPdf(server.address().port, readIndex(deckDir)).finally(() => (pdfJob = null)));

  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, "http://x");
      url.pathname = decodeURIComponent(url.pathname);
    } catch {
      return send(res, 400, "Bad request");
    }
    const p = url.pathname;

    if (p === "/") return serveUnder(res, VIEWER, "index.html");
    if (p.startsWith("/viewer/")) return serveUnder(res, VIEWER, p.slice("/viewer/".length));

    if (p === "/api/meta") {
      try {
        const idx = readIndex(deckDir);
        const { ids } = slideIds(deckDir, idx.order);
        return send(res, 200, JSON.stringify({ title: idx.title, w: idx.w, h: idx.h, count: ids.length }), MIME[".json"]);
      } catch (e) {
        return send(res, 500, JSON.stringify({ error: e.message }), MIME[".json"]);
      }
    }

    if (p === "/api/pdf") {
      const name = path.basename(deckDir).replace(/[^A-Za-z0-9._-]+/g, "-") || "deck";
      new Promise((resolve) => resolve(pdf())).then(
        ({ pdf }) => {
          res.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": pdf.length, "Content-Disposition": `attachment; filename="${name}.pdf"`, "Cache-Control": "no-store" });
          res.end(pdf);
        },
        (e) => send(res, 500, JSON.stringify({ error: e.message }), MIME[".json"]),
      );
      return;
    }

    if (p === "/deck") {
      res.writeHead(302, { Location: "/deck/" + url.search });
      return res.end();
    }
    if (p === "/deck/") {
      try {
        return send(res, 200, buildDeck(deckDir, { mode: url.searchParams.get("mode") === "all" ? "all" : "present", fonts: url.searchParams.get("fonts") !== "basic" }), MIME[".html"]);
      } catch (e) {
        return send(res, 500, e.message);
      }
    }

    const blob = p.match(/^\/(?:deck\/)?_blob\/([^/]+)$/);
    if (blob) {
      const file = findBlob(deckDir, blob[1]);
      return file ? sendFile(res, file) : send(res, 404, `No local file for asset ${blob[1]} (put it in project/assets/)`);
    }

    if (p.startsWith("/deck/")) return serveUnder(res, deckDir, p.slice("/deck/".length));

    if (p === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      res.write(": connected\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }

    send(res, 404, "Not found");
  });

  let watcher;
  if (watch) {
    let timer;
    watcher = fs.watch(deckDir, { recursive: true }, (_event, file) => {
      // Ignore dot-folders such as .preview/ (screenshots) and editor temp files.
      if (file && String(file).split(path.sep).some((seg) => seg.startsWith("."))) return;
      clearTimeout(timer);
      timer = setTimeout(() => clients.forEach((c) => c.write("data: change\n\n")), 100);
    });
    setInterval(() => clients.forEach((c) => c.write(": ping\n\n")), 25000).unref();
  }

  function listen(port, tries = 20) {
    return new Promise((resolve, reject) => {
      const onError = (e) => {
        server.off("listening", onListening);
        if (e.code === "EADDRINUSE" && tries > 0) resolve(listen(port + 1, tries - 1));
        else reject(e);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve(server.address().port);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "127.0.0.1");
    });
  }

  function close() {
    watcher?.close();
    clients.forEach((c) => c.end());
    server.close();
  }

  return { server, listen, close };
}
