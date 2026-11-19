// A deck as a PowerPoint file: real text boxes, shapes, pictures, lines and tables, not pictures
// of slides (unless asked). Headless Chrome lays the deck out, every slide is read out as plain
// positions and styles (extract.mjs), and those are written as a .pptx (ooxml.mjs).

import fs from "node:fs";
import path from "node:path";
import { readIndex } from "./deck.mjs";
import { createRenderServer } from "./serve.mjs";
import { launch, evaluate, openDeck, scrollTo } from "./chrome.mjs";
import { extractDeck } from "./extract.mjs";
import { buildPptx } from "./ooxml.mjs";
import { zip } from "./zip.mjs";

function sniff(b) {
  if (b[0] === 0x89 && b.toString("latin1", 1, 4) === "PNG") return "png";
  if (b[0] === 0xff && b[1] === 0xd8) return "jpeg";
  if (b.toString("latin1", 0, 4) === "GIF8") return "gif";
  return null;
}

/**
 * Export the deck in the folder deckDir.
 *   only        a Set of slide numbers to keep (1-based), or null for every slide
 *   basicFonts  set the deck in each font stack's basic face, and lay it out that way
 *   pictures    every slide as one picture (speaker notes are kept)
 *   scale       pixel density of the pictures made from drawings, or of `pictures`
 *   leadAbove, shotsDir   for checking the export against another renderer
 *   build       false: stop after reading the deck out (pptx is null)
 * Returns { pptx: Buffer | null, model, total, index, pictures, only }.
 */
export async function exportPptx(deckDir, { only = null, basicFonts = false, pictures = false, scale = 2, leadAbove, shotsDir, build = true } = {}) {
  const index = readIndex(deckDir);
  const server = await createRenderServer(deckDir);
  let browser;
  try {
    browser = await launch();
    const { send } = browser;
    await openDeck(browser, server.url, index, { basicFonts });

    const model = await evaluate(send, `(${extractDeck.toString()})(${JSON.stringify({ basicFonts, pictures, leadAbove })})`);
    if (shotsDir) {
      fs.mkdirSync(shotsDir, { recursive: true });
      const tops = await evaluate(send, `[...document.querySelectorAll("body > section")].filter(s => !s.hidden).map(s => s.getBoundingClientRect().top + scrollY)`);
      for (const [i, y] of tops.entries()) {
        await scrollTo(send, y);
        const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y, width: index.w, height: index.h, scale: 1 } });
        fs.writeFileSync(path.join(shotsDir, `${String(i + 1).padStart(2, "0")}.png`), Buffer.from(shot.data, "base64"));
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
    if (!model.slides.length) throw new Error("the deck has no slides");

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

    const pptx = build
      ? zip(buildPptx({ title: index.title, lang: index.lang, w: index.w, h: index.h, slides: model.slides, headingFont: model.headingFont, bodyFont: model.bodyFont }))
      : null;
    return { pptx, model, total, index, pictures, only };
  } finally {
    browser?.close();
    server.close();
  }
}

/** What the export made, the faces this computer lacks, and what it left out: lines of text. */
export function pptxReport({ model, pictures }) {
  const lines = [];
  const count = (t) => model.slides.reduce((n, s) => n + s.items.filter((it) => it.t === t && (t !== "shape" || it.text)).length, 0);
  lines.push(pictures ? "every slide is one picture: no text in the file can be edited" : `${count("shape")} text boxes, ${count("pic")} pictures, ${count("table")} tables, ${count("line")} lines`);
  if (model.fonts.length && !pictures) {
    lines.push("", `fonts: ${model.fonts.map((f) => f.name + (f.local ? "" : " *")).join(", ")}`);
    const missing = model.fonts.filter((f) => !f.local);
    if (missing.length)
      lines.push(`  * not installed on this computer. PowerPoint swaps in another face wherever a font is missing, which can\n    re-wrap text: install ${missing.length > 1 ? "them" : "it"} where the file will be opened, or export with --basic-fonts.`);
  }
  if (model.warnings.length) {
    lines.push("");
    for (const w of [...model.warnings].sort((a, b) => a.slide - b.slide)) lines.push(`${String(w.slide).padStart(2)} ${model.slides.find((s) => s.n === w.slide)?.id || ""}  ! ${w.msg}`);
  }
  return lines;
}
