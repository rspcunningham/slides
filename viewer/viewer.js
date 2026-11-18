// Deck viewer: shows /deck/ (the assembled deck page) in an iframe, one slide at a time,
// scaled to fit. Same origin, so it drives the iframe's DOM directly.

const $ = (s) => document.querySelector(s);
const frame = $("#deck");
const stage = $("#stage");
const counter = $("#counter");
const notesPanel = $("#notes");
const notesText = $("#notes-text");
const errorBox = $("#error");
const bar = $("#bar");
const gridBtn = $("#grid-btn");
const notesBtn = $("#notes-btn");

const st = {
  meta: { w: 1920, h: 1080, title: "Deck" },
  slides: [],
  index: 0,
  frag: 0, // steps shown on the current slide
  mode: "present",
  notes: false,
  anims: [],
  leaving: null,
  autoTimer: null,
};

const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const cur = () => st.slides[st.index];
const clampIndex = (i) => Math.max(0, Math.min(i, st.slides.length - 1));

// ---------- loading ----------

async function load(keep) {
  let meta;
  try {
    const r = await fetch("/api/meta", { cache: "no-store" });
    meta = await r.json();
    if (!r.ok) throw new Error(meta.error || r.statusText);
  } catch (e) {
    showError(String(e.message || e));
    return;
  }
  st.meta = meta;
  document.title = meta.title;

  await new Promise((resolve) => {
    frame.onload = resolve;
    frame.src = "/deck/?v=" + Date.now();
  });

  const doc = frame.contentDocument;
  const win = frame.contentWindow;
  applyModeClass();
  st.slides = [...doc.querySelectorAll("body > section")].filter((s) => !s.hidden);
  st.anims = [];
  st.leaving = null;
  clearTimeout(st.autoTimer);

  st.slides.forEach((s, i) => {
    s.dataset.page = String(i + 1);
    s.querySelectorAll(".page-number").forEach((e) => (e.textContent = String(i + 1)));
    s.querySelectorAll(".page-count").forEach((e) => (e.textContent = String(st.slides.length)));
    setCounters(s, i);
  });

  win.addEventListener("keydown", onKey);
  win.addEventListener("mousemove", poke);
  doc.addEventListener("click", onFrameClick);

  if (!st.slides.length) {
    showError('No slides yet.\nWrite project/slides/<id>.html and list the ids in project/deck.json "order".');
    fit();
    update();
    return;
  }
  hideError();

  const want = keep ? { index: st.index, frag: st.frag } : hashTarget() || { index: 0, frag: 0 };
  st.index = clampIndex(want.index);
  activate(st.index);
  if (st.mode === "grid") st.slides.forEach((s) => applySteps(s, Infinity));
  else {
    setSteps(want.frag);
    arrive(cur());
  }
  fit();
  update();
}

// A counter a <section> increments is its place in the deck. Only the shown slide is laid
// out, so set each slide's counters to their value at its own position.
function setCounters(section, i) {
  const inc = getComputedStyle(section).counterIncrement;
  if (!inc || inc === "none") return;
  const parts = inc.trim().split(/\s+/);
  const sets = [];
  for (let k = 0; k < parts.length; k++) {
    const name = parts[k];
    const n = Number(parts[k + 1]);
    const step = Number.isFinite(n) ? (k++, n) : 1;
    sets.push(`${name} ${(i + 1) * step}`);
  }
  section.style.counterSet = sets.join(" ");
  section.style.counterIncrement = "none";
}

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.hidden = false;
}
function hideError() {
  errorBox.hidden = true;
}

function hashTarget() {
  const m = location.hash.match(/^#slide-(\d+)(?:\.(\d+))?$/);
  return m ? { index: Number(m[1]) - 1, frag: m[2] ? Number(m[2]) : 0 } : null;
}

// ---------- click steps ----------
//
// A deck with shared CSS uses reveal.js-style fragments: .fragment, .visible, .current-fragment;
// data-fragment-index groups (indexed first, lowest first, then file order).
// An inline-style deck uses data-build-in / data-build-out="effect [order] [auto]".

const EFFECTS = {
  fade: { t: [] },
  rise: { t: ["translateY(48px)", "none"] },
  drop: { t: ["translateY(-48px)", "none"] },
  left: { t: ["translateX(-80px)", "none"] },
  right: { t: ["translateX(80px)", "none"] },
  scale: { t: ["scale(.85)", "none"] },
  pop: { t: ["scale(.6)", "scale(1.06)", "none"] },
};

function stepGroups(slide) {
  const frags = [...slide.querySelectorAll(".fragment")];
  if (frags.length) {
    const isIndexed = (e) => e.dataset.fragmentIndex !== undefined && e.dataset.fragmentIndex !== "" && !Number.isNaN(Number(e.dataset.fragmentIndex));
    const byIndex = new Map();
    frags
      .filter(isIndexed)
      .sort((a, b) => Number(a.dataset.fragmentIndex) - Number(b.dataset.fragmentIndex))
      .forEach((e) => {
        const k = Number(e.dataset.fragmentIndex);
        if (!byIndex.has(k)) byIndex.set(k, []);
        byIndex.get(k).push({ el: e, kind: "fragment" });
      });
    const groups = [...byIndex.values()];
    frags.filter((e) => !isIndexed(e)).forEach((e) => groups.push([{ el: e, kind: "fragment" }]));
    return groups;
  }

  const entries = [];
  slide.querySelectorAll("[data-build-in], [data-build-out]").forEach((el, dom) => {
    for (const dir of ["in", "out"]) {
      const v = el.getAttribute(`data-build-${dir}`);
      if (v == null) continue;
      const tokens = v.trim().split(/\s+/);
      const effect = EFFECTS[tokens[0]] ? tokens[0] : "fade";
      const order = tokens.map(Number).find((n) => Number.isInteger(n) && n >= 1 && n <= 50);
      entries.push({ el, kind: "build", dir, effect, auto: tokens.includes("auto"), order: order ?? 1000 + dom });
    }
  });
  const byOrder = new Map();
  entries
    .sort((a, b) => a.order - b.order)
    .forEach((e) => {
      if (!byOrder.has(e.order)) byOrder.set(e.order, []);
      byOrder.get(e.order).push(e);
    });
  return [...byOrder.values()];
}

function playEffect(entry) {
  const { el, effect, dir } = entry;
  const fx = EFFECTS[effect];
  const opts = { duration: 450, easing: "cubic-bezier(.2,.7,.2,1)" };
  const opacity = dir === "in" ? [0, 1] : [1, 0];
  const anims = [el.animate(opacity.map((o) => ({ opacity: o })), opts)];
  if (fx.t.length) {
    const frames = dir === "in" ? fx.t : [...fx.t].reverse();
    anims.push(el.animate(frames.map((t) => ({ transform: t })), { ...opts, composite: "add" }));
  }
  if (dir === "out") anims[0].finished.then(() => (el.style.visibility = "hidden")).catch(() => {});
  return anims;
}

// Show the first n steps of a slide. animateStep: index of a step to play as it appears.
function applySteps(slide, n, animateStep = -1) {
  stepGroups(slide).forEach((group, k) =>
    group.forEach((entry) => {
      if (entry.kind === "fragment") {
        entry.el.classList.toggle("visible", k < n);
        entry.el.classList.toggle("current-fragment", k === n - 1);
        return;
      }
      const shown = entry.dir === "in" ? k < n : !(k < n);
      if (k === animateStep && !reduceMotion) {
        entry.el.style.visibility = "";
        playEffect(entry);
      } else entry.el.style.visibility = shown ? "" : "hidden";
    }),
  );
}

function setSteps(n, animate = false) {
  const count = stepGroups(cur()).length;
  const prev = st.frag;
  st.frag = Math.max(0, Math.min(n, count));
  applySteps(cur(), st.frag, animate && st.frag === prev + 1 ? st.frag - 1 : -1);
}

// Steps marked "auto" run by themselves: about 600 ms after arrival, then every 520 ms.
function scheduleAuto(first) {
  clearTimeout(st.autoTimer);
  if (st.mode !== "present" || !st.slides.length) return;
  const groups = stepGroups(cur());
  const nextGroup = groups[st.frag];
  if (!nextGroup || !nextGroup.every((e) => e.auto)) return;
  st.autoTimer = setTimeout(() => {
    setSteps(st.frag + 1, true);
    update();
    scheduleAuto(false);
  }, first ? 600 : 520);
}

// ---------- arrival: videos, auto steps ----------

function arrive(slide) {
  for (const s of st.slides) {
    if (s === slide) continue;
    s.querySelectorAll("video").forEach((v) => v.pause());
  }
  slide.querySelectorAll("video").forEach((v) => {
    if (v.getAttribute("data-video-start") === "click") return;
    const delay = Math.min(60, Number(v.getAttribute("data-video-delay")) || 0);
    v.currentTime = 0;
    setTimeout(() => v.play().catch(() => {}), delay * 1000);
  });
  scheduleAuto(true);
}

// ---------- navigation ----------

function activate(i) {
  st.slides.forEach((s, k) => s.classList.toggle("is-active", k === i));
}

function go(i, frag, dir) {
  if (!st.slides.length) return;
  i = clampIndex(i);
  finishTransition();
  const from = cur();
  const to = st.slides[i];
  const kind = from && from !== to && dir && st.mode === "present" && !reduceMotion ? (dir > 0 ? from : to).dataset.transition : null;
  const before = kind === "magic" ? measureIds(from) : null;
  st.index = i;
  activate(i);
  setSteps(frag);
  if (kind) transition(kind, from, to, dir, before);
  arrive(to);
  update();
}

function next() {
  if (st.mode !== "present" || !st.slides.length) return;
  if (st.frag < stepGroups(cur()).length) {
    setSteps(st.frag + 1, true);
    update();
    scheduleAuto(false);
  } else if (st.index < st.slides.length - 1) {
    go(st.index + 1, 0, 1);
  }
}

function prev() {
  if (st.mode !== "present" || !st.slides.length) return;
  clearTimeout(st.autoTimer);
  if (st.frag > 0) {
    setSteps(st.frag - 1);
    update();
  } else if (st.index > 0) {
    go(st.index - 1, Infinity, -1);
  }
}

// ---------- transitions: data-transition on a slide says how it leaves ----------

function measureIds(section) {
  const base = section.getBoundingClientRect();
  const out = new Map();
  section.querySelectorAll("[id]").forEach((el) => {
    const r = el.getBoundingClientRect();
    out.set(el.id, { x: r.left - base.left, y: r.top - base.top, w: r.width, h: r.height });
  });
  return out;
}

function transition(kind, from, to, dir, before) {
  const anims = [];
  if (kind === "fade") {
    // Out, then in: the two slides' text never shows at once.
    from.classList.add("is-leaving");
    anims.push(from.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, easing: "ease-in", fill: "forwards" }));
    anims.push(to.animate([{ opacity: 0 }, { opacity: 0, offset: 0.45 }, { opacity: 1 }], { duration: 500, easing: "ease-out" }));
  } else if (kind === "push") {
    from.classList.add("is-leaving");
    const opts = { duration: 550, easing: "cubic-bezier(.65,0,.35,1)" };
    anims.push(from.animate([{ transform: "translateX(0)" }, { transform: `translateX(${-100 * dir}%)` }], opts));
    anims.push(to.animate([{ transform: `translateX(${100 * dir}%)` }, { transform: "translateX(0)" }], opts));
  } else if (kind === "magic") {
    // Elements with the same id on both slides move from their old place to the new one;
    // everything else on the new slide fades in after them.
    const base = to.getBoundingClientRect();
    const moved = [];
    to.querySelectorAll("[id]").forEach((el) => {
      const old = before.get(el.id);
      if (!old) return;
      const r = el.getBoundingClientRect();
      const nx = r.left - base.left, ny = r.top - base.top;
      if (!r.width || !r.height) return;
      const sx = old.w / r.width, sy = old.h / r.height;
      moved.push(el);
      anims.push(
        el.animate(
          [
            { transformOrigin: "0 0", transform: `translate(${old.x - nx}px, ${old.y - ny}px) scale(${sx}, ${sy})` },
            { transformOrigin: "0 0", transform: "none" },
          ],
          { duration: 650, easing: "cubic-bezier(.4,0,.2,1)" },
        ),
      );
    });
    for (const child of to.children) {
      if (child.tagName === "ASIDE" || moved.some((m) => child === m || child.contains(m))) continue;
      anims.push(child.animate([{ opacity: 0 }, { opacity: 0, offset: 0.4 }, { opacity: 1 }], { duration: 650, easing: "ease-out" }));
    }
  } else return;
  st.anims = anims;
  st.leaving = from.classList.contains("is-leaving") ? from : null;
  const leaving = st.leaving;
  Promise.all(anims.map((a) => a.finished))
    .catch(() => {})
    .finally(() => {
      if (st.leaving === leaving) finishTransition();
    });
}

function finishTransition() {
  st.anims.forEach((a) => a.cancel());
  st.anims = [];
  if (st.leaving) st.leaving.classList.remove("is-leaving");
  st.leaving = null;
}

// ---------- modes ----------

function applyModeClass() {
  const de = frame.contentDocument?.documentElement;
  if (!de) return;
  de.classList.toggle("mode-present", st.mode === "present");
  de.classList.toggle("mode-grid", st.mode === "grid");
}

function setMode(mode) {
  if (!st.slides.length) return;
  finishTransition();
  clearTimeout(st.autoTimer);
  st.mode = mode;
  applyModeClass();
  document.body.classList.toggle("grid", mode === "grid");
  gridBtn.setAttribute("aria-pressed", String(mode === "grid"));
  if (mode === "grid") {
    st.slides.forEach((s) => applySteps(s, Infinity));
    st.slides.forEach((s) => s.querySelectorAll("video").forEach((v) => v.pause()));
  } else {
    st.slides.forEach((s) => s !== cur() && applySteps(s, 0));
    setSteps(st.frag);
    arrive(cur());
  }
  fit();
  update();
}

function toggleNotes() {
  st.notes = !st.notes;
  notesPanel.hidden = !st.notes;
  notesBtn.setAttribute("aria-pressed", String(st.notes));
  update();
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.();
}

// ---------- layout ----------

function fit() {
  const r = stage.getBoundingClientRect();
  const { w, h } = st.meta;
  if (st.mode === "grid") {
    Object.assign(frame.style, { width: r.width + "px", height: r.height + "px", transform: "none" });
    const de = frame.contentDocument?.documentElement;
    if (de) {
      const avail = r.width - 48 - 16;
      const cols = avail > 1500 ? 4 : avail > 900 ? 3 : 2;
      const zoom = (avail - 24 * (cols - 1)) / cols / w;
      de.style.setProperty("--thumb-zoom", String(zoom));
    }
    return;
  }
  const s = Math.min(r.width / w, r.height / h);
  const x = (r.width - w * s) / 2;
  const y = (r.height - h * s) / 2;
  Object.assign(frame.style, { width: w + "px", height: h + "px", transform: `translate(${x}px, ${y}px) scale(${s})` });
}

function update() {
  const n = st.slides.length;
  counter.textContent = n ? `${st.index + 1} / ${n}` : "– / –";
  $("#prev").disabled = st.mode !== "present" || (st.index === 0 && st.frag === 0);
  $("#next").disabled = st.mode !== "present" || !n || (st.index === n - 1 && st.frag >= stepGroups(cur()).length);
  if (!n) return;
  const hash = `#slide-${st.index + 1}` + (st.frag ? `.${st.frag}` : "");
  if (location.hash !== hash) history.replaceState(null, "", hash);
  const aside = cur().querySelector(":scope > aside");
  notesText.textContent = aside ? aside.textContent.trim() : "No notes for this slide.";
  if (st.mode === "grid") cur().scrollIntoView({ block: "nearest" });
}

// ---------- input ----------

function onKey(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  let handled = true;
  if (st.mode === "grid") {
    if (k === "ArrowRight" || k === "ArrowDown") {
      st.index = clampIndex(st.index + 1);
      activate(st.index);
      update();
    } else if (k === "ArrowLeft" || k === "ArrowUp") {
      st.index = clampIndex(st.index - 1);
      activate(st.index);
      update();
    } else if (k === "Enter" || k === "Escape" || k === "g" || k === "G") {
      st.frag = 0;
      setMode("present");
    } else handled = false;
  } else if (["ArrowRight", "ArrowDown", "PageDown", "l", "j"].includes(k) || (k === " " && !e.shiftKey)) {
    next();
  } else if (["ArrowLeft", "ArrowUp", "PageUp", "h", "k"].includes(k) || (k === " " && e.shiftKey)) {
    prev();
  } else if (k === "Home") {
    go(0, 0, 0);
  } else if (k === "End") {
    go(st.slides.length - 1, 0, 0);
  } else if (k === "g" || k === "G") {
    setMode("grid");
  } else handled = false;

  if (!handled) {
    if (k === "n" || k === "N") toggleNotes();
    else if (k === "f" || k === "F") toggleFullscreen();
    else return;
  }
  e.preventDefault();
}

function onFrameClick(e) {
  if (st.mode === "present") {
    const v = e.target.closest("video");
    if (v) v.paused ? v.play().catch(() => {}) : v.pause();
    return;
  }
  const s = e.target.closest("section");
  const i = st.slides.indexOf(s);
  if (i < 0) return;
  st.index = i;
  st.frag = 0;
  activate(i);
  setMode("present");
}

let pokeTimer;
function poke() {
  bar.classList.add("show");
  clearTimeout(pokeTimer);
  pokeTimer = setTimeout(() => bar.classList.remove("show"), 2200);
}

window.addEventListener("keydown", onKey);
window.addEventListener("mousemove", poke);
window.addEventListener("hashchange", () => {
  const t = hashTarget();
  if (t && st.mode === "present" && (t.index !== st.index || t.frag !== st.frag)) go(t.index, t.frag, 0);
});
new ResizeObserver(fit).observe(stage);

$("#prev").addEventListener("click", prev);
$("#next").addEventListener("click", next);
gridBtn.addEventListener("click", () => setMode(st.mode === "grid" ? "present" : "grid"));
notesBtn.addEventListener("click", toggleNotes);
$("#fs-btn").addEventListener("click", toggleFullscreen);

// Live reload: the server pings on any change in the deck folder.
let reloadTimer;
const events = new EventSource("/events");
events.onmessage = () => {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => load(true), 150);
};

load(false);
poke();
