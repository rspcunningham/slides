#!/usr/bin/env node
// Export a deck to PowerPoint: real text boxes, shapes, pictures, lines and tables, not pictures
// of slides (unless asked: --pictures).
//
//   node scripts/pptx.mjs <deck-dir | deck-name> [--out file.pptx] [--slides 3,5-7] [--basic-fonts | --pictures] [--scale 2]
//
// The deck is laid out in headless Chrome (as in the preview), every slide is read out as plain
// positions and styles, and those are written as a .pptx. Drawings (<svg>), icons and live
// embeds go in as pictures. Needs Node 22+ and Chrome; no npm install.
//
//   --slides       only these slides
//   --basic-fonts  set the deck in each font stack's basic face (Arial, Georgia, …) instead of
//                  its first one, and lay it out that way: for computers without the deck's fonts
//   --pictures     every slide as one picture: exactly the viewer's look, needs no fonts, and no
//                  text can be edited (speaker notes are kept)
//   --scale N      pixel density of the pictures made from drawings, or of --pictures (default 2)

import fs from "node:fs";
import path from "node:path";
import { resolveDeck, listDecks, readIndex } from "./lib/deck.mjs";
import { createDeckServer } from "./lib/server.mjs";
import { launch, evaluate, openDeck, scrollTo } from "./lib/chrome.mjs";
import { extractDeck } from "./lib/extract.mjs";
import { buildPptx } from "./lib/ooxml.mjs";
import { zip } from "./lib/zip.mjs";

const args = process.argv.slice(2);
let deckArg, out, basicFonts = false, pictures = false, scale = 2, dump = false, only = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--out" || a === "-o") out = args[++i];
  else if (a === "--basic-fonts") basicFonts = true;
  else if (a === "--pictures") pictures = true;
  else if (a === "--scale") scale = Math.min(4, Math.max(1, Number(args[++i]) || 2));
  else if (a === "--json") dump = true;
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
  console.log("usage: node scripts/pptx.mjs <deck-dir | deck-name> [--out file.pptx] [--slides 3,5-7] [--basic-fonts | --pictures] [--scale 2]");
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
const outFile = path.resolve(out || path.join(deckDir, path.basename(deckDir) + ".pptx"));

function sniff(b) {
  if (b[0] === 0x89 && b.toString("latin1", 1, 4) === "PNG") return "png";
  if (b[0] === 0xff && b[1] === 0xd8) return "jpeg";
  if (b.toString("latin1", 0, 4) === "GIF8") return "gif";
  return null;
}

const { listen, close: closeServer } = createDeckServer(deckDir, { watch: false });
const port = await listen(0);
let browser;
try {
  browser = await launch();
  const { send } = browser;
  await openDeck(browser, port, index, { basicFonts });

  // PPTX_LEAD_ABOVE and PPTX_SHOTS are for checking the export against another renderer.
  const leadAbove = process.env.PPTX_LEAD_ABOVE ? Number(process.env.PPTX_LEAD_ABOVE) : undefined;
  const model = await evaluate(send, `(${extractDeck.toString()})(${JSON.stringify({ basicFonts, pictures, leadAbove })})`);
  if (process.env.PPTX_SHOTS) {
    fs.mkdirSync(process.env.PPTX_SHOTS, { recursive: true });
    const tops = await evaluate(send, `[...document.querySelectorAll("body > section")].filter(s => !s.hidden).map(s => s.getBoundingClientRect().top + scrollY)`);
    for (const [i, y] of tops.entries()) {
      await scrollTo(send, y);
      const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y, width: index.w, height: index.h, scale: 1 } });
      fs.writeFileSync(path.join(process.env.PPTX_SHOTS, `${String(i + 1).padStart(2, "0")}.png`), Buffer.from(shot.data, "base64"));
    }
  }
  const warn = (slide, msg) => model.warnings.push({ slide, msg });
  const total = model.slides.length;
  model.slides.forEach((s, i) => (s.n = i + 1));
  if (only) {
    model.slides = model.slides.filter((s) => only.has(s.n));
    model.warnings = model.warnings.filter((w) => only.has(w.slide));
    if (!model.slides.length) throw new Error(`no slide in that range (the deck has ${total})`);
  }

  if (pictures) {
    for (const slide of model.slides) {
      await scrollTo(send, slide.pageY);
      const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: slide.pageY, width: index.w, height: index.h, scale } });
      slide.items = [{ t: "pic", name: "Slide", alt: slide.alt, data: shot.data, x: 0, y: 0, w: index.w, h: index.h, rot: 0, geom: "rect" }];
    }
  }

  // Bring in every picture's bytes: a file from the deck, a redrawn PNG, or a screenshot.
  const files = new Map();
  let shooting = false;
  for (const slide of model.slides) {
    for (const it of slide.items) {
      if (it.t !== "pic") continue;
      if (it.data) it.bytes = Buffer.from(it.data, "base64");
      else if (it.src) {
        if (!files.has(it.src)) files.set(it.src, Buffer.from(await (await fetch(it.src)).arrayBuffer()));
        it.bytes = files.get(it.src);
      } else if (it.shot) {
        if (!shooting) {
          shooting = true;
          await send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
          await evaluate(send, `document.documentElement.classList.add("pptx-shot")`);
        }
        const sel = JSON.stringify(`[data-pptx-shot="${it.shot}"]`);
        await scrollTo(send, it.pageY - 40);
        await evaluate(send, `document.querySelector(${sel}).setAttribute("data-pptx-on", "")`);
        const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: it.pageX, y: it.pageY, width: it.w, height: it.h, scale } });
        await evaluate(send, `document.querySelector(${sel}).removeAttribute("data-pptx-on")`);
        it.bytes = Buffer.from(shot.data, "base64");
      }
      it.ext = it.bytes && sniff(it.bytes);
      if (!it.ext) {
        warn(slide.n, `a picture PowerPoint can't read is left out: ${it.alt || it.src || "picture"}`);
        delete it.bytes;
      }
      delete it.data;
    }
  }

  if (dump) {
    console.log(JSON.stringify(model, (k, v) => (k === "bytes" ? undefined : v), 1));
  } else {
    const entries = buildPptx({ title: index.title, lang: index.lang, w: index.w, h: index.h, slides: model.slides, headingFont: model.headingFont, bodyFont: model.bodyFont });
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, zip(entries));

    const rel = outFile.startsWith(process.cwd() + path.sep) ? path.relative(process.cwd(), outFile) : outFile;
    const count = (t) => model.slides.reduce((n, s) => n + s.items.filter((it) => it.t === t && (t !== "shape" || it.text)).length, 0);
    console.log(`${index.title}: ${only ? `${model.slides.length} of ${total}` : total} slides → ${rel}  (${(fs.statSync(outFile).size / 1e6).toFixed(1)} MB)`);
    console.log(pictures ? "every slide is one picture: no text in the file can be edited" : `${count("shape")} text boxes, ${count("pic")} pictures, ${count("table")} tables, ${count("line")} lines`);
    if (model.fonts.length && !pictures) {
      console.log(`\nfonts: ${model.fonts.map((f) => f.name + (f.local ? "" : " *")).join(", ")}`);
      const missing = model.fonts.filter((f) => !f.local);
      if (missing.length)
        console.log(`  * not installed on this computer. PowerPoint swaps in another face wherever a font is missing, which can\n    re-wrap text: install ${missing.length > 1 ? "them" : "it"} where the file will be opened, or export with --basic-fonts.`);
    }
    if (model.warnings.length) {
      console.log("");
      for (const w of model.warnings.sort((a, b) => a.slide - b.slide)) console.log(`${String(w.slide).padStart(2)} ${model.slides.find((s) => s.n === w.slide)?.id || ""}  ! ${w.msg}`);
    }
  }
} catch (e) {
  console.error("export failed:", e.stack || e.message);
  process.exitCode = 1;
} finally {
  browser?.close();
  closeServer();
}
