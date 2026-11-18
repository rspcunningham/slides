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
```

Viewer keys: → / Space next · ← back · Home / End · G all slides · N notes · F full screen.
`#slide-5` in the URL opens slide 5. `/deck/?mode=all` shows every slide stacked (prints one per page).

Needs Node 22+ and, for the preview, Chrome (or Chromium, Edge, Brave, or `CHROME_PATH`). No npm install.

## Moving decks to and from Claude

The files match, with one difference: Claude stores pictures and fonts as uploaded assets (`/_blob/<id>`),
here they are files in `project/assets/` named by path. A deck copied from Claude works here once its
assets are saved into `project/assets/` under their ids. Going the other way, upload each asset and
change its `src` to the `/_blob/<id>` the upload returns.
