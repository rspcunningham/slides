// The app's first page: the decks that are open, and ways to open another (a path on this
// computer, a .deck file chosen or dropped in).

const $ = (s) => document.querySelector(s);
const list = $("#decks");
const empty = $("#empty");
const message = $("#message");
const drop = $("#drop");

function say(msg) {
  message.textContent = msg || "";
  message.hidden = !msg;
}

function el(tag, props = {}, ...children) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children);
  return e;
}

async function post(url, init) {
  const r = await fetch(url, { method: "POST", ...init });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

// A cover is the slide at its own size, scaled to the card's width.
const fitCover = new ResizeObserver((entries) => {
  for (const e of entries) e.target.style.setProperty("--s", String(e.contentRect.width / Number(e.target.dataset.w)));
});

function card(d) {
  const href = `/d/${d.key}/`;
  const thumb = el("a", { className: "thumb", href, tabIndex: -1 });
  thumb.setAttribute("aria-hidden", "true");
  thumb.style.setProperty("--w", d.w);
  thumb.style.setProperty("--h", d.h);
  thumb.dataset.w = d.w;
  fitCover.observe(thumb);
  // The every-slide page starts with the first slide, and the frame shows just that much.
  if (d.count) thumb.append(el("iframe", { src: `${href}deck/?mode=all`, loading: "lazy", tabIndex: -1, scrolling: "no" }));

  const close = el("button", { className: "close", type: "button", title: "Close this deck in the app. Its files stay where they are." }, "Close");
  close.addEventListener("click", async () => {
    try {
      await post("/api/close", { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: d.key }) });
    } catch (e) {
      say(e.message);
    }
    refresh();
  });

  const count = d.error ? el("span", { className: "problem" }, d.error) : `${d.count} slide${d.count === 1 ? "" : "s"}`;
  return el(
    "li",
    { className: "deck" },
    thumb,
    el("div", { className: "row" }, el("a", { className: "title", href }, d.title), close),
    el("div", { className: "meta" }, count),
    el("div", { className: "meta source" }, d.source),
  );
}

// Redraw only when the list changed, so the covers aren't loaded again every few seconds.
let shown = "";
async function refresh() {
  let decks;
  try {
    decks = (await (await fetch("/api/decks", { cache: "no-store" })).json()).decks;
  } catch {
    return;
  }
  const key = JSON.stringify(decks.map((d) => [d.key, d.title, d.count, d.w, d.h, d.source, d.error]));
  if (key === shown) return;
  shown = key;
  list.replaceChildren(...decks.map(card));
  empty.hidden = decks.length > 0;
}

async function openFile(file) {
  say("");
  try {
    const d = await post("/api/upload?name=" + encodeURIComponent(file.name), { headers: { "Content-Type": "application/octet-stream" }, body: file });
    location.href = `/d/${d.key}/`;
  } catch (e) {
    say(e.message);
  }
}

$("#open-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  say("");
  try {
    const d = await post("/api/open", { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: $("#path").value }) });
    location.href = `/d/${d.key}/`;
  } catch (err) {
    say(err.message);
  }
});

$("#file").addEventListener("change", (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (file) openFile(file);
});

// A file dragged over the page, from anywhere.
let depth = 0;
const hasFile = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
window.addEventListener("dragenter", (e) => {
  if (!hasFile(e)) return;
  depth++;
  drop.hidden = false;
});
window.addEventListener("dragleave", (e) => {
  if (!hasFile(e)) return;
  if (--depth <= 0) {
    depth = 0;
    drop.hidden = true;
  }
});
window.addEventListener("dragover", (e) => hasFile(e) && e.preventDefault());
window.addEventListener("drop", (e) => {
  if (!hasFile(e)) return;
  e.preventDefault();
  depth = 0;
  drop.hidden = true;
  const file = e.dataTransfer.files[0];
  if (file) openFile(file);
});

refresh();
setInterval(refresh, 2000);
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && refresh());
