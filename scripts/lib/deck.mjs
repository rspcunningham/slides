// Reading a deck folder in the Claude Slides file format and assembling it into one page.
//
// A deck folder holds project/deck.json, project/deck.css (when the index's `format`
// lists it), project/slides/<id>.html, and the files those reference
// (project/assets/…, project/ds/<folder>/…, or /_blob/<id> looked up locally).

import fs from "node:fs";
import path from "node:path";

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..");
export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const FAMILY_RE = /^[A-Za-z][A-Za-z0-9 _-]{0,39}$/;
const SIZES = { "16:9": [1920, 1080], "4:3": [1440, 1080] };

export function resolveDeck(arg) {
  const candidates = arg ? [path.resolve(arg), path.join(ROOT, "decks", arg)] : [process.cwd()];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "project", "deck.json"))) return c;
    // Pointed at the project/ folder itself.
    if (path.basename(c) === "project" && fs.existsSync(path.join(c, "deck.json"))) return path.dirname(c);
  }
  return null;
}

export function listDecks() {
  const dir = path.join(ROOT, "decks");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => fs.existsSync(path.join(dir, n, "project", "deck.json")));
}

export function readIndex(deckDir) {
  const raw = fs.readFileSync(path.join(deckDir, "project", "deck.json"), "utf8");
  let idx;
  try {
    idx = JSON.parse(raw);
  } catch (e) {
    throw new Error(`project/deck.json is not valid JSON: ${e.message}`);
  }
  if (!idx || typeof idx !== "object" || Array.isArray(idx)) throw new Error("project/deck.json must be a JSON object");
  const [w, h] = SIZES[idx.size] || SIZES["16:9"];
  return {
    raw: idx,
    title: typeof idx.title === "string" && idx.title.trim() ? idx.title : path.basename(deckDir),
    lang: typeof idx.lang === "string" ? idx.lang : "en",
    w,
    h,
    order: Array.isArray(idx.order) ? idx.order.filter((id) => typeof id === "string" && ID_RE.test(id)) : [],
    shared:
      idx.format && Array.isArray(idx.format.shared) ? idx.format.shared.filter((p) => typeof p === "string" && safeRel(p)) : [],
    hasFormat: Boolean(idx.format),
    faces: idx.faces && typeof idx.faces === "object" ? idx.faces : {},
  };
}

/** A relative path that stays inside the deck folder. */
export function safeRel(p) {
  return !p.startsWith("/") && !p.includes("\\") && !p.split("/").includes("..");
}

export function slideIds(deckDir, order) {
  const dir = path.join(deckDir, "project", "slides");
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith(".html")).map((f) => f.slice(0, -5)).filter((id) => ID_RE.test(id))
    : [];
  const extra = files.filter((id) => !order.includes(id)).sort();
  return { ids: [...order, ...extra], present: new Set(files) };
}

/** Find the local file for /_blob/<id>: project/assets/<id>[.ext], project/_blob/…, _blob/… */
export function findBlob(deckDir, id) {
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(id) || id.startsWith(".")) return null;
  for (const dir of ["project/assets", "project/_blob", "_blob", "assets"]) {
    const d = path.join(deckDir, dir);
    if (!fs.existsSync(d)) continue;
    const exact = path.join(d, id);
    if (fs.existsSync(exact) && fs.statSync(exact).isFile()) return exact;
    const hit = fs.readdirSync(d).find((f) => f.slice(0, f.length - path.extname(f).length) === id);
    if (hit) return path.join(d, hit);
  }
  return null;
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fontHead(faces) {
  const links = [];
  const rules = [];
  for (const face of Object.values(faces)) {
    if (!face || typeof face !== "object" || !FAMILY_RE.test(face.family || "")) continue;
    if (typeof face.href === "string" && face.href.startsWith("https://fonts.googleapis.com/css2?")) {
      links.push(`<link rel="stylesheet" href="${esc(face.href)}">`);
    } else if (typeof face.src === "string" && (face.src.startsWith("/_blob/") || face.src.startsWith("_blob/") || safeRel(face.src))) {
      rules.push(`@font-face { font-family: "${face.family}"; src: url("${face.src.replace(/"/g, "")}"); font-display: block; }`);
    }
  }
  const uniq = [...new Set(links)];
  return (
    (uniq.length
      ? '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n' +
        uniq.join("\n")
      : "") + (rules.length ? `\n<style>\n${rules.join("\n")}\n</style>` : "")
  );
}

// <x-embed> holds a whole small page. Wrap its content in an inert <template> so its
// scripts never run in the deck page; elements.js moves it into a sandboxed iframe.
function inertEmbeds(html) {
  return html.replace(/<x-embed\b([^>]*)>([\s\S]*?)<\/x-embed>/gi, (_m, attrs, body) => `<x-embed${attrs}><template>${body}</template></x-embed>`);
}

/**
 * The deck as one HTML page, served at /deck/ (so `project/…` paths resolve).
 * mode "present": the viewer shows one slide at a time. mode "all": every slide stacked.
 */
export function buildDeck(deckDir, { mode = "present" } = {}) {
  const idx = readIndex(deckDir);
  const { ids, present } = slideIds(deckDir, idx.order);
  const sections = ids.map((id) =>
    present.has(id)
      ? inertEmbeds(fs.readFileSync(path.join(deckDir, "project", "slides", id + ".html"), "utf8").trim())
      : `<section id="${id}" style="background:#2a1417;color:#ffd5d5;display:flex;align-items:center;justify-content:center;font:40px system-ui,sans-serif">Missing slide file: project/slides/${esc(id)}.html</section>`,
  );
  const sharedLinks = idx.shared.map((p) => `<link rel="stylesheet" href="${esc(p)}">`).join("\n");
  const cls = mode === "present" ? ' class="mode-present"' : "";
  return `<!doctype html>
<html lang="${esc(idx.lang)}"${cls} data-format="${idx.hasFormat ? "css" : "inline"}" style="--slide-w:${idx.w}px;--slide-h:${idx.h}px">
<head>
<meta charset="utf-8">
<title>${esc(idx.title)}</title>
${fontHead(idx.faces)}
<link rel="stylesheet" href="/viewer/base.css">
${sharedLinks}
</head>
<body>
${sections.join("\n\n")}
<script src="/viewer/elements.js"></script>
</body>
</html>
`;
}
