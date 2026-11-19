#!/usr/bin/env node
// Export a deck to PowerPoint: real text boxes, shapes, pictures, lines and tables, not pictures
// of slides (unless asked: --pictures).
//
//   node scripts/pptx.mjs <deck-dir | deck-name> [--out file.pptx] [--slides 3,5-7] [--basic-fonts | --pictures] [--scale 2]
//
// The deck is laid out in headless Chrome (as in the preview), every slide is read out as plain
// positions and styles, and those are written as a .pptx. Drawings (<svg>), icons and live
// embeds go in as pictures. Needs Node 22+ and Chrome; no npm install. The viewer app need not
// be running.
//
//   --slides       only these slides
//   --basic-fonts  set the deck in each font stack's basic face (Arial, Georgia, …) instead of
//                  its first one, and lay it out that way: for computers without the deck's fonts
//   --pictures     every slide as one picture: exactly the viewer's look, needs no fonts, and no
//                  text can be edited (speaker notes are kept)
//   --scale N      pixel density of the pictures made from drawings, or of --pictures (default 2)

import fs from "node:fs";
import path from "node:path";
import { parseRange, usage, deckOrExit, shortPath } from "../engine/args.mjs";
import { exportPptx, pptxReport } from "../engine/pptx.mjs";

const USAGE = "node scripts/pptx.mjs <deck-dir | deck-name> [--out file.pptx] [--slides 3,5-7] [--basic-fonts | --pictures] [--scale 2]";

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
  else if (a === "-h" || a === "--help") usage(USAGE, 0);
  else deckArg = a;
}

const deckDir = deckOrExit(deckArg, USAGE);
const outFile = path.resolve(out || path.join(deckDir, path.basename(deckDir) + ".pptx"));

try {
  // PPTX_LEAD_ABOVE and PPTX_SHOTS are for checking the export against another renderer.
  const leadAbove = process.env.PPTX_LEAD_ABOVE ? Number(process.env.PPTX_LEAD_ABOVE) : undefined;
  const result = await exportPptx(deckDir, { only, basicFonts, pictures, scale, leadAbove, shotsDir: process.env.PPTX_SHOTS || undefined, build: !dump });
  const { pptx, model, total, index } = result;

  if (dump) {
    console.log(JSON.stringify(model, (k, v) => (k === "bytes" ? undefined : v), 1));
  } else {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, pptx);
    console.log(`${index.title}: ${only ? `${model.slides.length} of ${total}` : total} slides → ${shortPath(outFile)}  (${(pptx.length / 1e6).toFixed(1)} MB)`);
    console.log(pptxReport(result).join("\n"));
  }
} catch (e) {
  console.error("export failed:", e.stack || e.message);
  process.exitCode = 1;
}
