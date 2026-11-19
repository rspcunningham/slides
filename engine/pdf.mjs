// A deck as a PDF, one slide per page. Headless Chrome lays the deck out and prints it, so text
// stays text (it can be selected and searched, and is sharp at any zoom) and links still work.

import { readIndex } from "./deck.mjs";
import { createRenderServer } from "./serve.mjs";
import { launch, evaluate, openDeck } from "./chrome.mjs";

/**
 * Print the deck in the folder deckDir.
 * only: a Set of slide numbers to keep (1-based), or null for every slide.
 * Returns { pdf: Buffer, pages, total, index }.
 */
export async function exportPdf(deckDir, { only = null } = {}) {
  const index = readIndex(deckDir);
  const server = await createRenderServer(deckDir);
  let browser;
  try {
    browser = await launch();
    const { send } = browser;
    await openDeck(browser, server.url, index);

    // A clip prints as its still: put the picture back where elements.js made a <video>.
    const total = await evaluate(
      send,
      `(async () => {
        const stills = [...document.querySelectorAll("video[data-deck-video]")].map((v) => {
          const img = document.createElement("img");
          for (const a of v.attributes) if (!["src", "poster", "preload", "aria-label"].includes(a.name) && !a.name.startsWith("data-")) img.setAttribute(a.name, a.value);
          img.src = v.poster;
          img.alt = v.getAttribute("aria-label") || "";
          v.replaceWith(img);
          return img.decode().catch(() => {});
        });
        await Promise.all(stills);
        return document.querySelectorAll("body > section:not([hidden])").length;
      })()`,
    );
    if (!total) throw new Error("the deck has no slides");

    const pages = only ? [...only].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b) : null;
    if (pages && !pages.length) throw new Error(`no slide in that range (the deck has ${total})`);

    // One CSS px is 1/96 in, so the page is the slide at its own size.
    const { stream } = await send("Page.printToPDF", {
      printBackground: true,
      paperWidth: index.w / 96,
      paperHeight: index.h / 96,
      marginTop: 0,
      marginBottom: 0,
      marginLeft: 0,
      marginRight: 0,
      pageRanges: pages ? pages.join(",") : "",
      transferMode: "ReturnAsStream",
    });
    const chunks = [];
    for (;;) {
      const part = await send("IO.read", { handle: stream, size: 1 << 20 });
      chunks.push(Buffer.from(part.data, part.base64Encoded ? "base64" : "utf8"));
      if (part.eof) break;
    }
    await send("IO.close", { handle: stream });
    return { pdf: Buffer.concat(chunks), pages: pages ? pages.length : total, total, index };
  } finally {
    browser?.close();
    server.close();
  }
}
