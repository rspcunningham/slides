// A deck as one file. A .deck file is a zip of the deck folder's project/ tree, with the same
// paths inside (project/deck.json, project/deck.css, project/slides/…, project/assets/…), so
// unpacking one gives back a deck folder.

import fs from "node:fs";
import path from "node:path";
import { safeRel } from "./deck.mjs";
import { zip, unzip } from "./zip.mjs";

export const DECK_EXT = ".deck";

export function isDeckFile(file) {
  return file.toLowerCase().endsWith(DECK_EXT) && fs.existsSync(file) && fs.statSync(file).isFile();
}

function walk(dir, rel, out) {
  for (const name of fs.readdirSync(dir).sort()) {
    if (name.startsWith(".")) continue; // .DS_Store, .gitkeep
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) walk(full, rel + name + "/", out);
    else if (stat.isFile()) out.push({ name: rel + name, data: fs.readFileSync(full) });
  }
}

/** The deck folder's project/ tree as a .deck file (a Buffer). Returns { data, files }. */
export function packDeck(deckDir) {
  const project = path.join(deckDir, "project");
  if (!fs.existsSync(path.join(project, "deck.json"))) throw new Error(`no project/deck.json in ${deckDir}`);
  const entries = [];
  walk(project, "project/", entries);
  // The index first, so a reader can tell what the file is without reading all of it.
  entries.sort((a, b) => (b.name === "project/deck.json") - (a.name === "project/deck.json"));
  return { data: zip(entries), files: entries.length };
}

/**
 * Write a .deck file's contents (a Buffer) into destDir as a deck folder, replacing any
 * project/ already there. A zip of a deck folder made by hand (one folder around project/)
 * is read too. Returns the number of files written.
 */
export function unpackDeck(data, destDir) {
  const entries = unzip(data).filter((e) => !e.name.startsWith("__MACOSX/"));
  const index = entries.map((e) => e.name).find((n) => /^(?:[^/]+\/)?project\/deck\.json$/.test(n));
  if (!index) throw new Error("this file holds no project/deck.json: it is not a deck");
  const prefix = index.slice(0, index.length - "project/deck.json".length);

  const files = [];
  for (const e of entries) {
    if (!e.name.startsWith(prefix + "project/")) continue;
    const rel = e.name.slice(prefix.length);
    if (!safeRel(rel) || rel.split("/").some((seg) => seg === "" || seg === "." || seg.startsWith("."))) continue;
    files.push({ rel, data: e.data });
  }

  fs.rmSync(path.join(destDir, "project"), { recursive: true, force: true });
  for (const f of files) {
    const file = path.join(destDir, ...f.rel.split("/"));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, f.data);
  }
  return files.length;
}
