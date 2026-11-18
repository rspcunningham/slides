# Images and SVG

This page explains more than just `<img src="photos/reef.jpg" alt="…">`. It covers how images move through the system, SVG rules, borders and shadows on images and how those export to PPTX. For information about fonts, see the `fonts.md` page.

## How images travel

Every image FILE goes into the deck's `project/assets/` folder; the slide names it by that path, `<img src="project/assets/reef.jpg" alt="…">` (no leading `/`). A design system's picture copied into the deck with its install (`fonts.md`, "A design system") keeps its path in the deck, `project/ds/<folder>/<path>`. A deck that came from Claude names its pictures `/_blob/<id>`: the viewer looks for a file named `<id>` (with or without an extension) in `project/assets/`. Never write a `data:` URI, and never put base64 in a slide. That keeps slide files small.

- `png`, `jpg`, `webp`, and `gif` files go in as they are. If a photo is much bigger than it will show on the slide, it is worth shrinking it first to about 2× its box.

- An `svg` file can go in too, shown with `<img>`. Claude Slides strips scripts, `<style>` blocks, animation, `<foreignObject>` and embedded images from an uploaded SVG, so style it with attributes, or export it as a PNG if it needs those. A small SVG (52 KB or less) can go into the slide as `<svg>` code instead (see SVG below).

- `avif`, `bmp`, `heic` and other types: convert the file to png or webp first (for example `sips -s format png in.heic --out project/assets/out.png` on a Mac).

- If you don't have the file, do not write the image into the slide yourself. Leave an empty frame where it belongs: `<img alt="what goes here" style="width:…; height:…">` with no `src`. It keeps its box. Tell the user which images are missing.

Never use a URL in `src` — for example `src="https://…"`. Save the image as a file in `project/assets/`.

When you read a slide's file, keep every `src` exactly as it is unless you are replacing that picture.

## Video

A slide can hold a short clip: an `.mp4` (H.264) or `.webm` file of 20 MB or less. Put the clip in `project/assets/` the same way, with a still frame of it as a picture (`ffmpeg -i clip.mp4 -frames:v 1 still.png`). Then write the picture as an `<img>` and name the clip on it:

`<img src="project/assets/still.png" data-video="project/assets/clip.mp4" alt="what it shows" style="width:…; height:…">`

The clip plays, looping, while its slide is presented. Everywhere else (thumbnails, All slides, every download) the picture is shown, so always give it one; without a still the frame is dark. `data-video` takes a file in the deck (or a `/_blob/<id>`), never a URL. A click pauses and plays it. Optional settings: `data-video-sound="on"` plays its sound (muted without it); when presented, `data-video-start="click"` keeps the picture up until it is clicked (default: with the slide) and `data-video-delay="1.5"` (seconds, 60 at most) makes a clip that starts by itself wait. At most four clips play on one slide. If you edit a slide, keep its `data-video…` attributes as they are.

## SVG

Use SVG when crisp vector art matters — for example logos and diagrams. You can use `<img src="file.svg" alt="…">` or put the `<svg>…</svg>` code right in the slide. See the "Graphics & live embeds" section of `format.md` for more on this. Either way, the slide viewer treats the SVG as a sandboxed image:

- Scripts in the SVG never run.
- External references the SVG points to never load.
- Animation in `<svg>` code (CSS or SMIL) plays in the viewer; Claude Slides removes it from an uploaded file. PDF, PNG and PowerPoint draw one still: CSS animations at their end (a loop at rest). With no `format` key, SMIL stops at its end if it has a plain `dur`, `fill="freeze"`, at most a plain time as `begin`, and no `end` or repeat; other SMIL at its first frame.
- On a deck with a `format` key, SMIL plays only in `<svg>` code on the slide. A picture (`<img>`), a still, PDF, PNG, PowerPoint and Reduce Motion don't play it, so give the element's own attributes the look they should show. With no key, it also plays in a picture whose SVG is embedded in its `src`.
- If an SVG contains `<foreignObject>`, it cannot be rasterized for PPTX export. The export skips that SVG and shows a warning. Plain SVG is rasterized to a PNG.

If you put `<svg>` code directly in the slide:

- No script
- No `on*=` event handlers
- No `<foreignObject>` elements
- No URLs
- The SVG code must be 52 KB or smaller

The markup inside the `<svg>` is kept exactly as you wrote it, and comes back unchanged when you load the slide to edit it. An `aria-label` on the `<svg>` is its description (the image's alt): set one when the graphic carries meaning — a chart, a plan, a map — and leave it off pure decoration.

The slide shows the `<svg>` as an image, which a browser reads as XML. So inside it write a character only as itself (`—`), as its number (`&#8212;`) or as one of XML's five names (`&amp;` `&lt;` `&gt;` `&quot;` `&apos;`).

Fonts never load inside an SVG. Any `<text>` elements render in a system font, not the deck's font, and the text gets clipped. So keep diagram labels OUT of the SVG. Paint them as real text over the SVG instead. See the "Labels over an image" section of `layout.md`. Where a build runs, it warns you about every `<text>` element it finds in an `<svg>`.

## Display treatment

View each image and decide how it is best shown. Photos fill their box (`object-fit:cover`). For screenshots and diagrams, fit them inside the box, keeping their original shape (`object-fit:contain`). Put screenshots and diagrams on a contrasting background. Rarely put anything on top of a screenshot or diagram. Diagram labels are the exception.

If you put text on top of an image, protect it the way the deck's direction would — a card, a scrim (`background:rgba(20,20,19,.6)`), or a `backdrop-filter:blur()` panel. Do it the same way every time.

Do not use emoji or draw your own decorative art, unless the user asks for it. Use the images the user gives you or a line icon (`<x-icon>`) — but use icons sparingly. If the user does not give you any images, a deck with no images and good structure is a fine deliverable. Never make up an image. Never use an image file that you do not have. The deck can't show an image file that's missing.

## Borders and shadows

The `border`, `border-radius`, and `box-shadow` properties work the same way on an `<img>` as they do anywhere else (see reference/styles.md).

When you export to PPTX, borders and shadows on images turn into a picture outline and an outer shadow. PPTX uses its own approximations:

- `dashed` and `dotted` in CSS map to PPTX dash styles.
- `double` in CSS exports as solid.
- The spread part of a `box-shadow` gets folded into the blur.
- A named CSS color is skipped. You will see an export warning.
- Hex color codes and `rgba()` colors convert exactly.

