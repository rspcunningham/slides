# slides

Decks in the Claude Slides file format, written by Claude Code and shown in your browser.
A deck folder here is the same set of files as a Claude Slides artifact.

```
decks/<slug>/project/deck.json        the index: title, order, sections, fonts (faces)
decks/<slug>/project/deck.css         rules every slide shares
decks/<slug>/project/slides/<id>.html one <section> per slide, 1920×1080
decks/<slug>/project/assets/          pictures, clips, font files
decks/<slug>/.preview/                screenshots from the preview script (git-ignored)

template/                  empty starting deck
scripts/view.mjs           show a deck in the browser (live reload)
scripts/preview.mjs        screenshot every slide + lint the layout
scripts/pptx.mjs           export a deck to PowerPoint (.pptx)
scripts/pdf.mjs            export a deck to PDF
viewer/                    the viewer and renderer (x-shape, x-connector, x-icon, x-embed, motion)
.claude/skills/slides/     the skill: format, design rules, and references
```

## Use

Open Claude Code in this folder and ask for a deck. The `slides` skill writes it, starts the viewer,
runs the preview, and fixes what it finds.

```sh
node scripts/view.mjs <slug>                    # open in the browser; --port N, --no-open
node scripts/preview.mjs <slug>                 # screenshots in decks/<slug>/.preview/ + a report
node scripts/preview.mjs <slug> --slides 3,5-7  # just some slides
node scripts/pptx.mjs <slug>                    # decks/<slug>/<slug>.pptx; --out FILE, --slides 3,5-7, --basic-fonts, --pictures
```

Viewer keys: → / Space next · ← back · Home / End · G all slides · N notes · F full screen.
`#slide-5` in the URL opens slide 5. `/deck/?mode=all` shows every slide stacked (prints one per page).

**Export PDF** in the viewer's bar downloads the deck as a PDF, one slide per page at the slide's own size.
Text stays text (it can be selected and searched) and links work. Every step is shown, animations stand at
their end, and a clip is its still. `node scripts/pdf.mjs <slug>` writes the same file from the command line
(`decks/<slug>/<slug>.pdf`; `--out FILE`, `--slides 3,5-7`).

Needs Node 22+ and, for the preview and the PowerPoint and PDF exports, Chrome (or Chromium, Edge, Brave, or `CHROME_PATH`). No npm install.

## PowerPoint

`node scripts/pptx.mjs <slug>` writes a real PowerPoint file, not pictures of slides. It lays the deck out in
headless Chrome, reads every slide out as positions and styles, and writes those as PowerPoint's own objects:

| In the deck | In the file |
|---|---|
| `<h1>`–`<h3>`, `<p>`, any text | text boxes with the same runs (face, size, colour, bold, italic, underline, links, letter spacing, caps); the slide's first `<h1>` or `<h2>` is its title |
| `<ul>`, `<ol>` | one text box with real bullets or numbers, nested levels kept |
| a painted `<div>`, a pill, a card | a rectangle, rounded rectangle or ellipse with its fill (flat or gradient), border and shadow; text inside a painted box stays in that shape |
| `<img>` | the picture file itself, cropped as `object-fit` and `data-crop` showed it, with its rounding, outline and shadow |
| `<table>` | a table with the same column widths, fills, hairlines and cell text |
| `<x-shape>`, `<x-connector>`, `<hr>` | shapes, connectors with arrowheads (elbows included), lines |
| `<svg>`, `<x-icon>`, `<x-embed>`, a clip's still | a PNG at twice the size shown (`--scale N`) |
| `<aside>` | speaker notes |
| `content: counter(page)` | a slide-number field |

One slide px is half a point: a 1920×1080 deck is PowerPoint's 13.333 × 7.5 in widescreen page (4:3 its 10 × 7.5 in),
and 32px text is 16pt. Motion is left out: every step is shown and animations stand at their end. Anything else the
file can't hold (a `clip-path`, a `filter`, a skew) is listed when the export runs, and kept as a picture where it can be.

**Fonts.** The file names the deck's faces; it does not carry them. Where a face isn't installed, PowerPoint swaps in
another and text can wrap differently. The export marks the faces this computer lacks. Install them where the
file will be opened, or run with `--basic-fonts`: the deck is then laid out and exported in each font stack's
basic face (Arial, Georgia, …), which every computer has.

**Slides as pictures.** `--pictures` puts each slide in as one picture instead: exactly the viewer's look on any
computer, with nothing editable but the speaker notes.

**Line breaks.** PowerPoint breaks lines one at a time, so the export lays the deck out that way too (the viewer's
`text-wrap: pretty` is off). A paragraph can break at a different word than in the viewer; it keeps its place.
A weight of 600 or more is PowerPoint's bold, and lighter weights are regular: it has no steps between.

## Moving decks to and from Claude

The files match, with one difference: Claude stores pictures and fonts as uploaded assets (`/_blob/<id>`),
here they are files in `project/assets/` named by path. A deck copied from Claude works here once its
assets are saved into `project/assets/` under their ids. Going the other way, upload each asset and
change its `src` to the `/_blob/<id>` the upload returns.
