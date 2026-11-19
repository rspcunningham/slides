# slides

Decks in the Claude Slides file format, written by Claude Code and shown in your browser.
A deck folder here is the same set of files as a Claude Slides artifact.

The repo has three parts, and each can change without the others:

| Part | What it is | Where |
|---|---|---|
| **The skill** | What Claude Code reads to write a deck: the format, the design rules, an empty starting deck | `.claude/skills/slides/` |
| **The viewer app** | One long-running local server that shows any number of decks and exports them | `app/` |
| **The engine** | The format reader, the renderer and the exports, which the other two both use | `engine/`, with command-line tools in `scripts/` |

What passes between the skill and the app is a **deck**: a folder, or the same folder packed into one `.deck` file.
The skill writes it; the app opens it from wherever it is on disk.

```
<deck>/project/deck.json        the index: title, order, sections, fonts (faces)
<deck>/project/deck.css         rules every slide shares
<deck>/project/slides/<id>.html one <section> per slide, 1920×1080
<deck>/project/assets/          pictures, clips, font files
<deck>/.preview/                screenshots from the preview script (git-ignored)

.claude/skills/slides/     the skill: SKILL.md, reference/, template/ (the empty starting deck)
app/slides.mjs             the app's command: open, list, close, status, stop, restart, serve
app/server.mjs             the app's server; app/ui/ its pages
engine/                    reading a deck, serving it, driving Chrome, PDF and PowerPoint, .deck files
engine/render/             what every deck page loads (x-shape, x-connector, x-icon, x-embed)
scripts/preview.mjs        screenshot every slide + lint the layout
scripts/pptx.mjs           export a deck to PowerPoint (.pptx)
scripts/pdf.mjs            export a deck to PDF
scripts/pack.mjs           pack a deck folder into one .deck file, or unpack one
decks/                     the decks Claude Code writes here
```

## Use

Open Claude Code in this folder and ask for a deck. The `slides` skill writes it under `decks/<slug>/`, opens it
in the viewer app, runs the preview, and fixes what it finds.

### The viewer app

```sh
node app/slides.mjs open <deck>     # a deck folder, a .deck file, or a name under ./decks/
node app/slides.mjs open            # the list of open decks
node app/slides.mjs list            # the open decks and their addresses
node app/slides.mjs close <deck>    # a key, folder or file; or: close all
node app/slides.mjs status
node app/slides.mjs stop
node app/slides.mjs restart         # after changing the app's own code; keeps the same decks open
node app/slides.mjs serve           # run it in this terminal instead of the background
```

`open` starts the app if it isn't running, and returns at once: the app stays up at `http://127.0.0.1:4300/`
(`--port N` or `SLIDES_PORT` for another port) until you stop it. Each deck has its own address,
`http://127.0.0.1:4300/d/<name>/`, and reloads when its files change. `open` brings up a browser tab only when
no tab is showing that deck (`--no-open`: never).

The first page lists the open decks. Open another there by its path, or choose or drop in a `.deck` file.
The app keeps no record between runs: a deck is open until you close it or the app stops.

The viewer shows the slides as thumbnails down the left, as PowerPoint does: click one to go to it. They hide in
the grid and in full screen.

Viewer keys: → / Space next · ← back · Home / End · T thumbnails · G all slides · N notes · F full screen.
`#slide-5` in the address opens slide 5. `…/d/<name>/deck/?mode=all` shows every slide stacked (prints one per page).

**PDF** and **PowerPoint** in the viewer's bar download the deck in that form. The PDF has one slide per page at
the slide's own size: text stays text (it can be selected and searched) and links work. Every step is shown,
animations stand at their end, and a clip is its still.

### One file

```sh
node scripts/pack.mjs <deck>                       # <deck>/<name>.deck; --out FILE
node scripts/pack.mjs --unpack <file.deck> [dir]   # back to a deck folder
```

A `.deck` file is a zip of the deck's `project/` folder, for sending a deck to someone. The app opens it like a
folder, and shows it again when the file changes. A `.zip` someone made of a deck folder by hand opens too.

### The tools

These work on a deck folder with no app running.

```sh
node scripts/preview.mjs <deck>                 # screenshots in <deck>/.preview/ + a report
node scripts/preview.mjs <deck> --slides 3,5-7  # just some slides
node scripts/pptx.mjs <deck>                    # <deck>/<name>.pptx; --out FILE, --slides 3,5-7, --basic-fonts, --pictures
node scripts/pdf.mjs <deck>                     # <deck>/<name>.pdf; --out FILE, --slides 3,5-7
```

`<deck>` is a path to a deck folder, or a bare name looked up under `./decks/`.

Needs Node 22+ and, for the preview and the PowerPoint and PDF exports, Chrome (or Chromium, Edge, Brave, or `CHROME_PATH`). No npm install.

## PowerPoint

`node scripts/pptx.mjs <deck>` (or the viewer's **PowerPoint** button) writes a real PowerPoint file, not pictures of slides. It lays the deck out in
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
assets are saved into `project/assets/` under their ids: the app serves `/_blob/<id>` from the deck the page belongs to. Going the other way, upload each asset and
change its `src` to the `/_blob/<id>` the upload returns.
