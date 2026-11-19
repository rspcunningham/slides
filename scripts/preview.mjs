#!/usr/bin/env node
// Render every slide of a deck in headless Chrome, save screenshots, and lint the layout.
//
//   node scripts/preview.mjs <deck-dir | deck-name> [--slides 3,5-7] [--scale 0.5] [--json]
//
// Writes <deck>/.preview/NN-<id>.png (one per slide) and <deck>/.preview/sheet.png (all slides,
// numbered), then prints the problems it found per slide. Needs Node 22+ and a Chrome,
// Chromium, Edge or Brave install (or CHROME_PATH).

import fs from "node:fs";
import path from "node:path";
import { resolveDeck, listDecks, readIndex } from "./lib/deck.mjs";
import { createDeckServer } from "./lib/server.mjs";
import { launch, evaluate, openDeck, scrollTo } from "./lib/chrome.mjs";

// ---------- args ----------

const args = process.argv.slice(2);
let deckArg;
let scale = 0.5;
let only = null;
let asJson = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--scale") scale = Number(args[++i]);
  else if (a === "--slides") only = parseRange(args[++i]);
  else if (a === "--json") asJson = true;
  else if (a === "-h" || a === "--help") usage(0);
  else deckArg = a;
}

function usage(code) {
  console.log("usage: node scripts/preview.mjs <deck-dir | deck-name> [--slides 3,5-7] [--scale 0.5] [--json]");
  const decks = listDecks();
  if (decks.length) console.log("\ndecks:\n" + decks.map((n) => "  " + n).join("\n"));
  process.exit(code);
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

const deckDir = resolveDeck(deckArg);
if (!deckDir) {
  console.error(deckArg ? `No project/deck.json found for "${deckArg}".` : "Which deck?");
  usage(1);
}
const index = readIndex(deckDir);

// ---------- the lint, run inside the page ----------

function lintPage() {
  const sections = [...document.querySelectorAll("body > section")].filter((s) => !s.hidden);
  const INLINE = new Set(["B", "I", "U", "A", "SPAN", "BR", "EM", "STRONG", "SUP", "SUB", "SMALL", "CODE"]);
  const icons = new Set(window.__deckIcons || []);
  const KINDS = new Set(["rect", "rounded", "ellipse", "diamond", "arrow-right", "arrow-left", "arrow-up", "arrow-down", "line"]);

  const words = (el) => (el.textContent || "").trim().replace(/\s+/g, " ");
  const label = (el) => {
    const t = words(el);
    const cls = typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).join(".") : "";
    const tag = el.tagName.toLowerCase() + cls;
    return t ? `${tag} “${t.length > 48 ? t.slice(0, 48) + "…" : t}”` : tag;
  };
  const inSvg = (el) => el.tagName.toLowerCase() !== "svg" && el.closest("svg");
  const pinnedWithin = (el, sec) => {
    for (let e = el; e && e !== sec; e = e.parentElement) {
      const p = getComputedStyle(e).position;
      if (p === "absolute" || p === "fixed") return e;
    }
    return null;
  };
  const parseColor = (c) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const intersect = (a, b) => {
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return w > 2 && h > 2 ? { w, h } : null;
  };

  const report = [];
  const headingTops = [];

  sections.forEach((sec, i) => {
    const issues = [];
    const seen = new Set();
    const add = (level, msg) => {
      if (seen.has(msg)) return;
      seen.add(msg);
      issues.push({ level, msg });
    };
    const S = sec.getBoundingClientRect();
    const scs = getComputedStyle(sec);
    const bottomLimit = S.top + S.height - parseFloat(scs.paddingBottom);
    const els = [...sec.querySelectorAll("*")].filter((e) => !e.closest("aside") && !inSvg(e) && e.tagName !== "TEMPLATE");

    // Structure limits of the format.
    const boxes = els.filter((e) => !INLINE.has(e.tagName));
    if (boxes.length > 200) add("error", `${boxes.length} elements; the format holds 200 per slide`);
    let maxDepth = 0;
    for (const e of els) {
      if (e.tagName !== "DIV") continue;
      let d = 0;
      for (let p = e; p && p !== sec; p = p.parentElement) if (p.tagName === "DIV") d++;
      maxDepth = Math.max(maxDepth, d);
    }
    if (maxDepth > 15) add("error", `<div>s nested ${maxDepth} deep; the format allows 15`);

    // Text.
    const texts = els.filter(
      (e) => !INLINE.has(e.tagName) && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && getComputedStyle(e).visibility !== "hidden",
    );
    const textRects = new Map();
    for (const el of texts) {
      const rects = [];
      for (const n of el.childNodes) {
        if (n.nodeType !== 3 || !n.textContent.trim()) continue;
        const r = document.createRange();
        r.selectNodeContents(n);
        rects.push(...[...r.getClientRects()].filter((q) => q.width > 0 && q.height > 0));
      }
      // Inline children (b, span…) count as this element's text too.
      for (const c of el.querySelectorAll("b,i,u,a,span,em,strong,sup,sub,code")) {
        const r = document.createRange();
        r.selectNodeContents(c);
        rects.push(...[...r.getClientRects()].filter((q) => q.width > 0 && q.height > 0));
      }
      if (!rects.length) continue;
      textRects.set(el, rects);
      const cs = getComputedStyle(el);
      const size = parseFloat(cs.fontSize);
      if (size < 23.5) add("error", `${Math.round(size)}px text (min 24px): ${label(el)}`);

      const box = rects.reduce((u, r) => ({ left: Math.min(u.left, r.left), top: Math.min(u.top, r.top), right: Math.max(u.right, r.right), bottom: Math.max(u.bottom, r.bottom) }));
      if (box.left < S.left - 1 || box.top < S.top - 1 || box.right > S.right + 1 || box.bottom > S.bottom + 1)
        add("error", `text runs off the slide (cut off): ${label(el)}`);
      else if (!pinnedWithin(el, sec) && box.bottom > bottomLimit + 2)
        add("error", `text goes ${Math.round(box.bottom - bottomLimit)}px below the bottom margin: ${label(el)}`);

      // Text that spills out of the painted or clipping box around it.
      for (let p = el.parentElement; p && p !== sec; p = p.parentElement) {
        const pcs = getComputedStyle(p);
        const bg = parseColor(pcs.backgroundColor);
        const painted = (bg && bg.a > 0.05) || parseFloat(pcs.borderTopWidth) > 0 || pcs.overflow !== "visible";
        if (!painted) continue;
        const R = p.getBoundingClientRect();
        if (box.right > R.right + 2 || box.bottom > R.bottom + 2 || box.left < R.left - 2 || box.top < R.top - 2)
          add("error", `text spills out of its box: ${label(el)} in ${label(p).split(" ")[0]}`);
        break;
      }

      // A word wider than its box breaks mid-word.
      if (el.clientWidth > 0) {
        const prev = [el.style.overflowWrap, el.style.wordBreak];
        el.style.overflowWrap = "normal";
        el.style.wordBreak = "normal";
        if (el.scrollWidth > el.clientWidth + 2) add("error", `a word is wider than its box and breaks mid-word: ${label(el)}`);
        [el.style.overflowWrap, el.style.wordBreak] = prev;
      }

      // Contrast against the first solid background behind it (skipped over pictures).
      const fg = parseColor(cs.color);
      let bgc = null;
      for (let p = el; p; p = p.parentElement) {
        const c = parseColor(getComputedStyle(p).backgroundColor);
        if (c && c.a >= 0.9) {
          bgc = c;
          break;
        }
        if (p === sec) break;
      }
      const overPicture = [...sec.querySelectorAll("img,video,svg")].some((m) => !m.contains(el) && pinnedWithin(m, sec) && intersect(m.getBoundingClientRect(), box));
      if (fg && bgc && !overPicture && fg.a > 0.5) {
        const need = size >= 44 || (size >= 32 && parseInt(cs.fontWeight) >= 700) ? 3 : 4.5;
        const r = ratio(fg, bgc);
        if (r < need) add("warn", `low contrast ${r.toFixed(1)}:1 (needs ${need}:1): ${label(el)}`);
      }
    }

    // Text overlapping other text.
    const list = [...textRects.keys()];
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const A = list[a], B = list[b];
        if (A.contains(B) || B.contains(A)) continue;
        let hit = null;
        for (const ra of textRects.get(A)) {
          for (const rb of textRects.get(B)) if ((hit = intersect(ra, rb))) break;
          if (hit) break;
        }
        if (hit) add("error", `text overlaps text: ${label(A)} and ${label(B)} (by ${Math.round(Math.min(hit.w, hit.h))}px)`);
      }
    }

    // Flow text sitting on top of a flow picture or drawing (pinned labels over images are fine).
    const media = els.filter((e) => /^(IMG|VIDEO|SVG|X-SHAPE|X-EMBED)$/i.test(e.tagName));
    for (const m of media) {
      if (pinnedWithin(m, sec)) continue;
      const R = m.getBoundingClientRect();
      for (const [el, rects] of textRects) {
        if (m.contains(el) || pinnedWithin(el, sec)) continue;
        if (rects.some((r) => intersect(r, R))) add("error", `text overlaps a picture or drawing: ${label(el)} on ${m.tagName.toLowerCase()}`);
      }
    }

    // Pictures.
    for (const img of sec.querySelectorAll("img")) {
      if (!img.getAttribute("src")) {
        add("note", `empty picture frame (no src): ${img.alt || "img"}`);
        continue;
      }
      if (img.complete && img.naturalWidth === 0) {
        add("error", `picture did not load: ${img.getAttribute("src")}`);
        continue;
      }
      const r = img.getBoundingClientRect();
      const cs = getComputedStyle(img);
      let shown = r.width;
      if (cs.objectFit === "contain" || cs.objectFit === "fill" || cs.objectFit === "none") {
        shown = Math.min(r.width, (r.height * img.naturalWidth) / img.naturalHeight);
      } else if (cs.objectFit === "cover") {
        shown = Math.max(r.width, (r.height * img.naturalWidth) / img.naturalHeight);
      }
      if (img.naturalWidth && shown > img.naturalWidth * 1.25)
        add("warn", `picture shown at ${(shown / img.naturalWidth).toFixed(1)}× its pixel size (soft): ${img.getAttribute("src")}`);
      else if (img.naturalWidth >= 600 && shown < img.naturalWidth * 0.65 && cs.objectFit !== "cover")
        add("warn", `figure shown at ${Math.round((100 * shown) / img.naturalWidth)}% of its pixel size: any labels drawn into it shrink too — check they still read as ≥24px, else enlarge it, crop it, or redraw it on the slide: ${img.getAttribute("src")}`);
      if (!img.hasAttribute("alt")) add("warn", `picture has no alt text: ${img.getAttribute("src")}`);
    }

    // Slides' own elements.
    for (const e of sec.querySelectorAll("x-icon")) if (!icons.has(e.getAttribute("name"))) add("error", `unknown x-icon name "${e.getAttribute("name")}"`);
    for (const e of sec.querySelectorAll("x-shape")) if (e.hasAttribute("kind") && !KINDS.has(e.getAttribute("kind"))) add("error", `unknown x-shape kind "${e.getAttribute("kind")}"`);
    for (const e of sec.querySelectorAll("svg text")) add("warn", `<text> inside an <svg> (fonts never load there; put labels in <p>s over it)`);

    // Pinned children: at most 24 in one host, and a host should be position:relative.
    for (const host of [sec, ...els.filter((e) => e.tagName === "DIV")]) {
      const pinned = [...host.children].filter((c) => getComputedStyle(c).position === "absolute");
      if (pinned.length > 24) add("error", `${pinned.length} pinned children in one ${host === sec ? "slide" : "<div>"}; the format allows 24`);
      if (host !== sec && pinned.some((c) => c.tagName !== "X-CONNECTOR") && getComputedStyle(host).position === "static")
        add("warn", `pinned elements inside a <div> that isn't position:relative (Slides measures them from the div): ${label(host)}`);
    }

    // CSS the format (and a PowerPoint export) doesn't keep.
    for (const e of els) {
      const cs = getComputedStyle(e);
      const what = [];
      if (cs.float !== "none") what.push("float");
      if (cs.position === "fixed" || cs.position === "sticky") what.push(`position:${cs.position}`);
      if (cs.clipPath !== "none") what.push("clip-path");
      if (cs.maskImage && cs.maskImage !== "none") what.push("mask");
      if (/url\(/.test(cs.backgroundImage)) what.push("url() background (use an <img>)");
      if ((cs.backgroundImage.match(/gradient\(/g) || []).length > 1) what.push("more than one gradient");
      if (cs.writingMode !== "horizontal-tb") what.push("writing-mode");
      if (cs.columnCount !== "auto") what.push("columns");
      if (/^(table|inline-table|table-cell|table-row)$/.test(cs.display) && !/^(TABLE|TR|TD|TH|THEAD|TBODY)$/.test(e.tagName)) what.push("display:table");
      if (cs.gridTemplateAreas && cs.gridTemplateAreas !== "none") what.push("grid-template-areas");
      if (/matrix3d/.test(cs.transform)) what.push("3D transform");
      if (cs.zIndex !== "auto" && !(e.parentElement === sec && e.style.zIndex === "-1")) what.push("z-index (use source order)");
      if (what.length) add("warn", `not kept by Slides/PowerPoint: ${what.join(", ")} on ${label(e)}`);
    }

    // Motion (off unless the person asked for it).
    const motion = [];
    if (sec.dataset.transition) motion.push(`transition "${sec.dataset.transition}"`);
    const animated = els.filter((e) => getComputedStyle(e).animationName !== "none").length;
    if (animated) motion.push(`${animated} animated element${animated > 1 ? "s" : ""}`);
    const steps = sec.querySelectorAll(".fragment, [data-build-in], [data-build-out]").length;
    if (steps) motion.push(`${steps} click step${steps > 1 ? "s" : ""}`);
    if (motion.length) add("note", `motion: ${motion.join(", ")}`);

    // Heading position (should not hop between content slides) and how far content reaches.
    const heading = sec.querySelector("h1, h2, h3");
    const centered = scs.justifyContent === "center" || scs.justifyContent === "flex-end" || scs.justifyContent === "end";
    if (heading && !centered) {
      const top = Math.round(heading.getBoundingClientRect().top - S.top);
      headingTops.push({ i, top });
    }
    let lowest = 0;
    for (const c of sec.children) {
      if (c.tagName === "ASIDE") continue;
      const ccs = getComputedStyle(c);
      if (ccs.position === "absolute" || ccs.display === "none") continue;
      lowest = Math.max(lowest, c.getBoundingClientRect().bottom - S.top);
    }
    if (heading && !centered && lowest > 0 && lowest < S.height * 0.6)
      add("note", `content ends at y ${Math.round(lowest)} of ${Math.round(S.height)}: the lower part of the slide is empty`);

    report.push({ n: i + 1, id: sec.id, issues });
  });

  // Headings near the top that sit at different heights from one slide to the next.
  const topOnes = headingTops.filter((h) => h.top < 420);
  if (topOnes.length >= 3) {
    const counts = new Map();
    for (const h of topOnes) counts.set(h.top, (counts.get(h.top) || 0) + 1);
    const usual = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    for (const h of topOnes)
      if (Math.abs(h.top - usual) > 6 && Math.abs(h.top - usual) < 300)
        report[h.i].issues.push({ level: "warn", msg: `heading sits at y ${h.top}, ${h.top > usual ? "lower" : "higher"} than on most slides (y ${usual}): it hops as you flip` });
  }
  return report;
}

// ---------- run ----------

const outDir = path.join(deckDir, ".preview");
fs.mkdirSync(outDir, { recursive: true });
for (const f of fs.readdirSync(outDir)) if (f.endsWith(".png")) fs.rmSync(path.join(outDir, f));

const { listen, close: closeServer } = createDeckServer(deckDir, { watch: false });
const port = await listen(0);
let browser;
try {
  browser = await launch();
  const { send } = browser;
  await openDeck(browser, port, index);

  const report = await evaluate(send, `(${lintPage.toString()})()`);
  const tops = await evaluate(send, `[...document.querySelectorAll("body > section")].filter(s => !s.hidden).map(s => s.getBoundingClientRect().top + scrollY)`);

  const files = [];
  for (let i = 0; i < tops.length; i++) {
    if (only && !only.has(i + 1)) continue;
    await scrollTo(send, tops[i]);
    const shot = await send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: { x: 0, y: tops[i], width: index.w, height: index.h, scale },
    });
    const name = `${String(i + 1).padStart(2, "0")}-${report[i]?.id || "slide"}.png`;
    fs.writeFileSync(path.join(outDir, name), Buffer.from(shot.data, "base64"));
    files.push(name);
  }

  // Contact sheet: four slides per row, numbered.
  const sheetW = 2000;
  const zoom = (sheetW - 32 - 48) / 4 / index.w;
  const sheetH = await evaluate(
    send,
    `(() => {
      const st = document.createElement("style");
      st.textContent = "html{background:#141416}body{display:flex;flex-wrap:wrap;gap:16px;padding:16px;width:${sheetW}px;box-sizing:border-box}body>section{zoom:${zoom}}";
      document.head.appendChild(st);
      [...document.querySelectorAll("body > section")].filter(s => !s.hidden).forEach((s, i) => {
        const n = document.createElement("div");
        n.textContent = i + 1;
        n.style.cssText = "position:absolute;left:0;top:0;padding:8px 28px;background:#000c;color:#fff;font:600 80px system-ui,sans-serif;z-index:999";
        s.appendChild(n);
      });
      return document.body.scrollHeight;
    })()`,
  );
  await send("Emulation.setDeviceMetricsOverride", { width: sheetW, height: Math.ceil(sheetH), deviceScaleFactor: 1, mobile: false });
  const sheet = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, width: sheetW, height: Math.ceil(sheetH), scale: 1 } });
  fs.writeFileSync(path.join(outDir, "sheet.png"), Buffer.from(sheet.data, "base64"));

  // ---------- report ----------

  const shown = report.filter((r) => !only || only.has(r.n));
  if (asJson) {
    console.log(JSON.stringify({ deck: deckDir, preview: outDir, slides: shown }, null, 2));
  } else {
    const rel = outDir.startsWith(process.cwd() + path.sep) ? path.relative(process.cwd(), outDir) : outDir;
    console.log(`${index.title}: ${report.length} slides`);
    console.log(`screenshots: ${rel}/  (sheet.png = all slides, numbered)\n`);
    const mark = { error: "✗", warn: "!", note: "·" };
    let errors = 0, warns = 0;
    for (const r of shown) {
      const lines = r.issues.sort((a, b) => ["error", "warn", "note"].indexOf(a.level) - ["error", "warn", "note"].indexOf(b.level));
      errors += lines.filter((l) => l.level === "error").length;
      warns += lines.filter((l) => l.level === "warn").length;
      console.log(`${String(r.n).padStart(2)} ${r.id}${lines.length ? "" : "  ok"}`);
      for (const l of lines) console.log(`     ${mark[l.level]} ${l.msg}`);
    }
    console.log(`\n${errors} problem${errors === 1 ? "" : "s"} (✗), ${warns} warning${warns === 1 ? "" : "s"} (!). Look at the screenshots too: the lint can't see everything.`);
  }
} catch (e) {
  console.error("preview failed:", e.message);
  process.exitCode = 1;
} finally {
  browser?.close();
  closeServer();
}
