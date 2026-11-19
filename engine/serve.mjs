// Serving a deck over HTTP: the assembled page, the deck's files, and the renderer.
//
//   serveDeck(deckDir, rel, url, res)   what lives under a deck's own address:
//       ""                the assembled deck (?mode=all: every slide stacked, no viewer classes;
//                         &fonts=basic: without the deck's faces, each stack's basic face shows)
//       _blob/<id>        a Claude asset id, looked up in project/assets/
//       <path>            a file from the deck folder (project/deck.css, project/assets/…)
//   serveRender(rel, res)               base.css and elements.js, at /render/
//   createRenderServer(deckDir)         a private server for one deck, for headless Chrome:
//       /deck/…  /render/…  /_blob/<id>
//
// The preview and the exports start their own render server, so they need no viewer app.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { RENDER_DIR, buildDeck, findBlob } from "./deck.mjs";

export const MIME = {
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

export function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

export function sendJson(res, status, value) {
  send(res, status, JSON.stringify(value), MIME[".json"]);
}

export function sendFile(res, file) {
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return send(res, 404, "Not found");
    const type = MIME[path.extname(file).toLowerCase()] || sniff(file);
    res.writeHead(200, { "Content-Type": type, "Content-Length": stat.size, "Cache-Control": "no-store" });
    fs.createReadStream(file).pipe(res);
  });
}

/** Send root/rel, refusing a path that leaves root. */
export function serveUnder(res, root, rel) {
  const file = path.resolve(root, "." + path.sep + rel);
  if (file !== root && !file.startsWith(root + path.sep)) return send(res, 403, "Forbidden");
  sendFile(res, file);
}

export function serveBlob(res, deckDir, id) {
  const file = findBlob(deckDir, id);
  return file ? sendFile(res, file) : send(res, 404, `No local file for asset ${id} (put it in project/assets/)`);
}

export function serveRender(rel, res) {
  serveUnder(res, RENDER_DIR, rel);
}

/** rel: the path after the deck's own address ("" is the assembled page). url: the request's URL. */
export function serveDeck(deckDir, rel, url, res) {
  if (rel === "") {
    try {
      const mode = url.searchParams.get("mode") === "all" ? "all" : "present";
      return send(res, 200, buildDeck(deckDir, { mode, fonts: url.searchParams.get("fonts") !== "basic" }), MIME[".html"]);
    } catch (e) {
      return send(res, 500, e.message);
    }
  }
  const blob = rel.match(/^_blob\/([^/]+)$/);
  if (blob) return serveBlob(res, deckDir, blob[1]);
  serveUnder(res, deckDir, rel);
}

/** Parse a request's URL with its path decoded, or null when it is malformed. */
export function requestUrl(req) {
  try {
    const url = new URL(req.url, "http://x");
    url.pathname = decodeURIComponent(url.pathname);
    return url;
  } catch {
    return null;
  }
}

/** A server for one deck on a free local port. Returns { port, url, close }. */
export async function createRenderServer(deckDir) {
  const server = http.createServer((req, res) => {
    const url = requestUrl(req);
    if (!url) return send(res, 400, "Bad request");
    const p = url.pathname;
    if (p.startsWith("/render/")) return serveRender(p.slice("/render/".length), res);
    if (p === "/deck") {
      res.writeHead(302, { Location: "/deck/" + url.search });
      return res.end();
    }
    if (p.startsWith("/deck/")) return serveDeck(deckDir, p.slice("/deck/".length), url, res);
    const blob = p.match(/^\/_blob\/([^/]+)$/);
    if (blob) return serveBlob(res, deckDir, blob[1]);
    send(res, 404, "Not found");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  return {
    port,
    url: `http://127.0.0.1:${port}/deck/`,
    close: () => {
      server.close();
      server.closeAllConnections?.();
    },
  };
}
