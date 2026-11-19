# What we learned rebuilding Claude Slides locally

These notes cover researching Claude's Slides artifact, rebuilding it as a local toolkit (this repo), and finding out why the local decks came out worse. Written 2026-11-18.

---

## 1. How Claude's Slides artifact works

### It is a "type" (an "appifact"), not a one-off page

- claude.ai has 7 built-in artifact types: Data, Design, Design System, Docs, Sheets, Slides, Whiteboard. Slides is type `8jTsAFQMFDb2oA8MsPJ2eL`.
- A type is a fixed web app. Every deck made from it gets the same files: `index.html`, `artifact-type/*.js`/`*.css`, reference docs and a `SKILL.md`.
- A deck's *content* is just files under `project/`. Claude writes those files and publishes them to the artifact. The page reads them.
- The page declares capabilities:
  - `downloads`, `assets` (uploaded files, `/_blob/<id>`), `comments`, `user`.
  - `room`: live presence. This is how Claude knows "the slide I'm on": every chat message carries an `<artifact-view-context>` block with the viewer's mode, slide id and selection.
  - `db` with admin-only writes.
  - `mcp`: Google Drive, for sending a deck to Google Slides.
  - `flags`: GrowthBook feature flags.
- It has a health/telemetry layer that reports actions (render, sync, edit, present, export…) to an alerts channel, with crash grouping and retries for failed script loads.

### The deck file format

```
project/deck.json         index
project/deck.css          shared CSS (only when deck.json has a `format` key)
project/slides/<id>.html  exactly one <section id="<id>"> per file
project/ds/<folder>/…     an installed design system (tokens.json, fonts, pictures)
```

`deck.json` (v5):

```json
{"v":5,"createdOnFiles":{"v":1,"at":"…"},"lists":"css",
 "format":{"v":1,"shared":["project/deck.css"]},
 "title":"…","cover":"<id>","order":["…"],
 "sections":{"s1":{"description":"one sentence","start":"<id>"}},
 "faces":{"inter":{"family":"Inter","href":"https://fonts.googleapis.com/css2?…"}},
 "designSystems":[]}
```

- **No `format` key** means an *inline deck*: every slide uses inline styles, and classes and fragments do nothing. Older decks and decks edited by hand in the page look like this. The reference deck we compared against was one: `"v":4`, no `deck.css`, every slide fully inline.
- **Images and fonts** are uploaded assets, referenced as `/_blob/<id>`. URLs and `data:` URIs aren't allowed.
- **Speaker notes:** one `<aside>`, the last child of the section, plain text, at most 4,000 characters.
- **Slide size:** a fixed 1920×1080 canvas (1440×1080 for 4:3). The 128px padding is the margin, leaving 1664×824 for content.
- **The format's own elements:**
  - `<x-shape kind="rect|rounded|ellipse|diamond|arrow-*|line">`
  - `<x-connector x1 y1 x2 y2 route="straight|hv|vh|elbow" head=…>`
  - `<x-icon name>` (31 fixed names)
  - `<x-embed>`: a sandboxed live page, at most 16 KB.
- **Motion:**
  - CSS `@keyframes` and `@starting-style` play when a slide arrives.
  - reveal.js-style `.fragment` / `.visible` / `.current-fragment` give click steps.
  - `data-transition="fade|push|magic"` on a section sets how it leaves.
  - Inline decks use `data-build-in` / `data-build-out` for steps instead.
- **Limits:** 200 elements per slide, `<div>`s 15 deep, 24 pinned children per `<div>`, 500 slides per deck. Past these a slide is held read-only.

### Why the format is so restricted

`format.md` lists CSS that Slides drops: z-index, floats, `clip-path`, `url()` backgrounds, more than one gradient, a second border colour, grid areas, `:has()`, and so on. The reason is that **the renderer turns each slide into plain values that map onto PowerPoint objects**. Two features depend on that:
- **The in-page editor** writes changes back into the HTML: moved elements get `transform:translate(…)`, unpatchable edits become a "flat" slide with inline styles.
- **PPTX export.**

Everything allowed has a PowerPoint equivalent.

### How PPTX export works (from the bundles)

The bundled libraries, from `third-party-licenses.js`:
- **pptxgenjs 3.12.0**: builds the PowerPoint file.
- **jszip 3.10.1**: patches the generated file afterwards.
- **wawoff2**: woff2 → TTF, for embedding fonts.
- **mediabunny**: video encoding (MP4).
- **React 19 + @base-ui/react**: the editor UI.

There is no PDF library, no html2canvas and no CSS parser. They wrote those themselves.

The pipeline:
1. Lay out each slide **in a real browser**.
2. Read the results with `getComputedStyle`, `getBoundingClientRect` and `Range.getClientRects` (line by line).
3. Map each element to a pptxgenjs object: text → text box, painted div → shape, table → native table, img → picture, `<aside>` → notes.
4. **Rasterize what can't be mapped** (SVG, connectors, embeds): wrap the HTML in `<svg><foreignObject>`, draw it to a canvas, save a PNG.
5. **Re-open the .pptx with JSZip to embed fonts:** add `fonts/fontN.fntdata`, the content type and `<p:embeddedFontLst>`. pptxgenjs can't embed fonts itself.
6. **PDF:** a hand-written PDF writer (objects, xref, trailer, Unicode font embedding).

**Takeaway:** the browser does the layout and the exporter copies the results. No CSS parsing is needed.

### Getting at the files

- **The type's text files can be read directly:** `Artifact read` with the type URL and `paths`. Large JS bundles can only be read through an artifact *made from* the type: create an empty one, then read with `out_dir`.
- **Uploaded assets** are read **one per call** (`path` = the asset id). Several ids in one `paths` call fail.

---

## 2. What we built (this repo)

```
decks/<slug>/project/…   decks, in exactly Claude's file format
.claude/skills/slides/   the skill: SKILL.md + Claude's reference docs, adapted; template/ (empty starting deck)
app/                     the viewer app: one long-running server for any number of decks (slides.mjs, server.mjs, ui/)
engine/                  deck assembly, serving, headless Chrome via the DevTools protocol, PDF, PowerPoint, .deck files
engine/render/           base.css, elements.js (x-shape/x-connector/x-icon/x-embed)
scripts/                 preview.mjs (screenshots + layout lint), pptx.mjs, pdf.mjs, pack.mjs
```

No dependencies; Node 22+ and a system Chrome. Commands:

```sh
node app/slides.mjs open <slug>                 # → http://127.0.0.1:4300/d/<slug>/
node scripts/preview.mjs <slug> [--slides 3,5-7]
```

The skill and the viewer were one thing at first: `scripts/view.mjs` served one deck per process, and the skill
started it. They were split on 2026-11-19. The app now runs by itself and takes a deck (a folder, or a `.deck`
zip of one) from anywhere on disk; the skill only writes decks and hands them over with `open`; the engine is
what both use, and the preview and exports start their own private server, so they need no app.

### Design decisions that worked

- **Same format as Claude, not a look-alike.** Our first version invented its own `deck.json` and dropped the `x-*` elements. That made Claude's reference docs unusable, because `diagrams.md` and `diagram-recipes.md` depend on `x-connector` and `x-shape`. Matching the format exactly meant the docs could be copied with only their tooling bits changed.
- **The browser is the renderer.** Each slide is inserted as raw HTML into one document (`…/deck/`) and shown in a same-origin **iframe**, which keeps deck CSS away from the viewer's controls. The same page is what the preview script drives, and what a PPTX exporter would use later.
- **Assets live in `project/assets/`**, referenced by path. `/_blob/<id>` is also served, looked up by file name, so decks copied from Claude work.
- **`<x-embed>` content is wrapped in `<template>` on the server,** so its scripts never run in the deck page. A client script moves it into a sandboxed iframe with a strict content security policy.

### Gotchas we hit

- **Hiding slides with `display:none` breaks things.**
  - CSS counters (`counter-increment` on section) stop counting. Fixed by setting `counter-set` on each section for its own position.
  - Measuring hidden elements gives 0×0. `elements.js` briefly removes the mode class (synchronously, so nothing paints), measures, and puts it back.
- **A crossfade overlaps two slides' text.** That was the "text overlaps" complaint. Fade is now sequential: out (220ms), then in.
- **`border-width` reads as 0 when `border-style` is none,** so connectors default to `border:2px solid; border-color:transparent !important` in base CSS.
- **Their paint-order rule:** all flow content paints as one layer where the first flow child sits, so pinned elements listed before it paint *under* it. We copy it with `z-index:-1` plus `isolation:isolate` on sections. A pinned child is also measured from its `<div>` even when the div isn't `position:relative`; we lint for it instead.
- **Chrome's `--screenshot` flag times out** on a page with an open EventSource connection. Drive Chrome over the DevTools protocol instead: `--remote-debugging-port=0`, read `DevToolsActivePort` from the profile directory, then use Node's built-in `WebSocket`.
- **The file watcher must ignore dot-folders,** or writing `.preview/` screenshots triggers live reloads.

### The preview/lint (`scripts/preview.mjs`)

It renders the finished look: every step shown, animations jumped to their end, transitions off. It saves `NN-<id>.png` per slide plus a numbered `sheet.png`, and reports per slide:
- text overlapping text or flow pictures, measured on line boxes;
- text cut off at the slide edge, below the bottom margin, or spilling out of a painted box;
- words wider than their box;
- text under 24px;
- contrast against the solid background behind it;
- broken, soft (upscaled) or heavily shrunk figures;
- format limits: elements, nesting depth, pinned children;
- CSS that Slides or PowerPoint won't keep: float, clip-path, `url()` backgrounds, z-index…;
- unknown icon names or shape kinds;
- headings that sit at different heights from slide to slide;
- empty lower halves;
- motion.

It takes about 2–3 seconds for 16 slides. Its blind spot is anything inside a picture: labels baked into an essay figure can't be measured. The "figure shown at N% of its pixel size" warning is a stand-in.

---

## 3. Why our decks still looked worse than Claude's

We rendered the user's Claude-built reference deck (`CTkA316ZeCHU3UJzxhqY6D`) **through our own viewer**, and it looked as good as on claude.ai. **So the renderer and format were never the problem. The design choices were.**

| | Reference (Claude + human iteration) | Our generated deck |
|---|---|---|
| Typefaces | 1 (Geist) | 4 (Source Serif 4, IBM Plex Sans, IBM Plex Mono, STIX Two) |
| Colour | off-white on every slide, near-black text, one blue used sparingly | alternating navy, steel, mist and white; dark cover; blue statement slide |
| Decoration | none: plain 52px title, then content | mono uppercase label above every title, filled cards, big-number callouts, quote slide |
| Body text | 30–34px, black | mostly 24–30px **grey** |
| Figures | huge (up to ~1560px), cropped, the centre of each slide | ~1000px, next to a text column |
| Pictures | 22, many made for the deck (equations as images, crops, new data) | the essay's 9 web-sized figures, reused |

Causes:

1. **The design checklist itself.** Claude's Slides skill asks for:
   - two background tones and an accent statement slide;
   - dark opening and closing slides;
   - accent-coloured labels above titles;
   - turning lists into cards and big numbers.

   Followed literally, that produces a generic "AI-designed deck". The reference deck had clearly been through rounds of editing away from that: one font, white, plain titles.
2. **The reference had a human editing pass.** Its `deck.json` was a week old, its speaker notes were in the user's voice, and its slides were saved as inline styles, which is what hand edits in the page produce. A single generated pass can't be compared fairly with an edited deck.
3. **Source material.** Figures made for an essay are sized for reading on a web page; on a slide their labels shrink to 10–14px. The reference had material made for slides.
4. **Condensing the instructions made things worse.** The first local skill was a short summary of Claude's guidance (about 15 KB instead of about 100 KB) and produced poor decks. Detail in the instructions matters ("the full text is equally important").
5. **Motion by default hurts.** Arrival animations and crossfades made text overlap mid-transition, and the user doesn't want them. Default: no motion unless asked.

### What to do next (not yet done)

- **Make the reference deck's look the house default:**
  - one sans typeface;
  - an off-white background;
  - one accent colour;
  - plain titles at about 52px;
  - a 52/34/30/24 type scale;
  - black body text;
  - figure-first layouts.
- **Remove the checklist rules that produce decoration:** labels above titles, alternating backgrounds, forced cards and big numbers, a statement slide.
- **Optionally keep the reference deck in `decks/`** as a model Claude reads before making a new deck. Its assets are in the session scratchpad and would need saving into `project/assets/`.
- **Prepare figures for slides:** crop to the part that matters, re-export at slide scale, or rebuild diagrams with `x-connector` and `x-shape` so labels are real text at 24px or more.
- **PPTX export, when wanted:** load `/deck/?mode=all` in headless Chrome, walk the DOM using computed boxes, emit pptxgenjs objects, rasterize the rest, and embed fonts with JSZip. Ship the "picture slides" version (one screenshot per slide) first.

---

## 4. Process lessons

- **Look before guessing.** Render the actual output and the reference *with the same renderer* before blaming the system. That one comparison settled the question.
- **Separate content/design problems from rendering problems.** They look the same in a screenshot.
- **Don't simplify an instruction set that already works.** A short summary of a long, carefully written skill loses the details that make its output good.
- **Defaults matter most.** Whatever the skill asks for by default (motion, backgrounds, decoration) is what you get.
- **A lint can't judge taste,** and can't see inside pictures. It caught every overlap and overflow problem we planted, and none of the reasons the deck looked bad.
