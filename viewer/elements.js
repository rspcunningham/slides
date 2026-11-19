// Runs inside the assembled deck page. Draws the Slides format's own elements
// (<x-shape>, <x-connector>, <x-icon>, <x-embed>), plays picture-with-video and crop
// marks, and applies the format's paint-order rule. Sets window.__deckReady when done.

(() => {
  const SVGNS = "http://www.w3.org/2000/svg";
  const px = (v) => parseFloat(v) || 0;

  function mk(tag, attrs = {}, parent) {
    const e = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    if (parent) parent.appendChild(e);
    return e;
  }

  function overlay(el, w, h, left = 0, top = 0) {
    el.querySelector(":scope > svg[data-drawn]")?.remove();
    const s = mk("svg", { width: Math.max(w, 1), height: Math.max(h, 1), "data-drawn": "", "aria-hidden": "true" });
    Object.assign(s.style, { position: "absolute", left: left + "px", top: top + "px", overflow: "visible", pointerEvents: "none", display: "block" });
    el.appendChild(s);
    return s;
  }

  function dashArray(style, sw) {
    if (style === "dashed") return `${sw * 3} ${sw * 2.5}`;
    if (style === "dotted") return `0.01 ${sw * 2}`;
    return null;
  }

  // ---------- <x-shape kind="rect|rounded|ellipse|diamond|arrow-*|line"> ----------

  function arrowRight(x0, y0, w, h) {
    const hx = x0 + w * 0.6;
    return [
      [x0, y0 + h * 0.25], [hx, y0 + h * 0.25], [hx, y0], [x0 + w, y0 + h / 2],
      [hx, y0 + h], [hx, y0 + h * 0.75], [x0, y0 + h * 0.75],
    ];
  }

  function shapePoints(kind, W, H, s) {
    const x0 = s, y0 = s, w = W - 2 * s, h = H - 2 * s;
    switch (kind) {
      case "diamond":
        return [[x0 + w / 2, y0], [x0 + w, y0 + h / 2], [x0 + w / 2, y0 + h], [x0, y0 + h / 2]];
      case "arrow-right":
        return arrowRight(x0, y0, w, h);
      case "arrow-left":
        return arrowRight(x0, y0, w, h).map(([x, y]) => [W - x, y]);
      case "arrow-down":
        return arrowRight(y0, x0, h, w).map(([x, y]) => [y, x]);
      case "arrow-up":
        return arrowRight(y0, x0, h, w).map(([x, y]) => [y, H - x]);
      default:
        return null;
    }
  }

  function renderShape(el) {
    const kind = (el.getAttribute("kind") || "rect").toLowerCase();
    const cs = getComputedStyle(el);
    if (!el._drawn) {
      const bw = cs.borderTopStyle === "none" ? 0 : px(cs.borderTopWidth);
      el._drawn = { fill: cs.backgroundColor, bw, stroke: cs.borderTopColor, dash: cs.borderTopStyle };
    }
    if (kind === "rect") return;
    if (kind === "rounded") {
      if (cs.borderTopLeftRadius === "0px") el.style.borderRadius = "24px";
      return;
    }
    if (kind === "ellipse") {
      el.style.borderRadius = "50%";
      return;
    }
    const { fill, bw, stroke, dash } = el._drawn;
    el.style.background = "transparent";
    el.style.borderColor = "transparent";
    const W = el.offsetWidth, H = el.offsetHeight;
    const svg = overlay(el, W, H, -bw, -bw);
    if (kind === "line") {
      const sw = bw || Math.max(2, Math.min(W, H));
      const color = bw ? stroke : fill;
      const a = W >= H ? { x1: 0, y1: H / 2, x2: W, y2: H / 2 } : { x1: W / 2, y1: 0, x2: W / 2, y2: H };
      const line = mk("line", { ...a, stroke: color, "stroke-width": sw, "stroke-linecap": "butt" }, svg);
      const da = dashArray(dash, sw);
      if (da) line.setAttribute("stroke-dasharray", da);
      return;
    }
    const pts = shapePoints(kind, W, H, bw / 2);
    if (!pts) return;
    const poly = mk("polygon", { points: pts.map((p) => p.join(",")).join(" "), fill, "stroke-linejoin": "round" }, svg);
    if (bw) {
      poly.setAttribute("stroke", stroke);
      poly.setAttribute("stroke-width", bw);
      const da = dashArray(dash, bw);
      if (da) poly.setAttribute("stroke-dasharray", da);
    }
  }

  // ---------- <x-connector x1 y1 x2 y2 route head head-start head-end from> ----------

  function route(kind, x1, y1, x2, y2) {
    let pts;
    if (kind === "hv") pts = [[x1, y1], [x2, y1], [x2, y2]];
    else if (kind === "vh") pts = [[x1, y1], [x1, y2], [x2, y2]];
    else if (kind === "elbow") {
      if (Math.abs(x2 - x1) >= Math.abs(y2 - y1)) {
        const mx = (x1 + x2) / 2;
        pts = [[x1, y1], [mx, y1], [mx, y2], [x2, y2]];
      } else {
        const my = (y1 + y2) / 2;
        pts = [[x1, y1], [x1, my], [x2, my], [x2, y2]];
      }
    } else pts = [[x1, y1], [x2, y2]];
    return pts.filter((p, i) => i === 0 || p[0] !== pts[i - 1][0] || p[1] !== pts[i - 1][1]);
  }

  function headKinds(el) {
    const head = el.getAttribute("head") || "end";
    const start = el.getAttribute("head-start") || (head === "both" ? "filled" : "none");
    const end = el.getAttribute("head-end") || (head === "none" || head === "start" ? "none" : "filled");
    return { start, end };
  }

  function drawLine(svg, pts, { sw, style, color }, heads) {
    const L = Math.max(14, sw * 4.5);
    const hw = L * 0.48;
    const line = pts.map((p) => [...p]);
    const tips = [];
    const addHead = (atEnd, kind) => {
      if (kind !== "filled" && kind !== "open") return;
      const n = line.length;
      const tip = atEnd ? pts[n - 1] : pts[0];
      const prev = atEnd ? pts[n - 2] : pts[1];
      if (!prev) return;
      const dx = tip[0] - prev[0], dy = tip[1] - prev[1];
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      const bx = tip[0] - ux * L, by = tip[1] - uy * L;
      const a = [bx - uy * hw, by + ux * hw], b = [bx + uy * hw, by - ux * hw];
      tips.push({ kind, pts: [a, tip, b] });
      if (kind === "filled") {
        const cut = Math.min(L * 0.7, len * 0.5);
        const target = atEnd ? line[n - 1] : line[0];
        target[0] = tip[0] - ux * cut;
        target[1] = tip[1] - uy * cut;
      }
    };
    addHead(true, heads.end);
    addHead(false, heads.start);

    const path = mk(
      "path",
      {
        d: "M" + line.map((p) => p.join(" ")).join(" L"),
        fill: "none",
        stroke: color,
        "stroke-width": sw,
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
      },
      svg,
    );
    const da = dashArray(style, sw);
    if (da) path.setAttribute("stroke-dasharray", da);
    for (const t of tips) {
      const points = t.pts.map((p) => p.join(",")).join(" ");
      if (t.kind === "filled") mk("polygon", { points, fill: color, stroke: color, "stroke-width": Math.max(1, sw / 2), "stroke-linejoin": "round" }, svg);
      else mk("polyline", { points, fill: "none", stroke: color, "stroke-width": sw, "stroke-linecap": "round", "stroke-linejoin": "round" }, svg);
    }
  }

  function renderConnector(el) {
    if (!el._drawn) {
      const cs = getComputedStyle(el);
      el._drawn = {
        sw: cs.borderTopStyle === "none" ? 2 : Math.min(32, px(cs.borderTopWidth) || 2),
        style: cs.borderTopStyle,
        color: cs.color,
      };
      el.style.borderWidth = "0";
    }
    const attrs = ["x1", "y1", "x2", "y2"].map((a) => el.getAttribute(a));
    const heads = headKinds(el);

    if (attrs.every((v) => v !== null && v.trim() !== "")) {
      const host = el.parentElement;
      if (host && host.tagName !== "SECTION" && getComputedStyle(host).position === "static") host.style.position = "relative";
      const RW = host ? host.clientWidth : 0, RH = host ? host.clientHeight : 0;
      const val = (v, ref) => (v.trim().endsWith("%") ? (parseFloat(v) * ref) / 100 : parseFloat(v));
      const [x1, y1, x2, y2] = [val(attrs[0], RW), val(attrs[1], RH), val(attrs[2], RW), val(attrs[3], RH)];
      if ([x1, y1, x2, y2].some(Number.isNaN)) return;
      Object.assign(el.style, { position: "absolute", left: "0", top: "0", width: "0", height: "0", margin: "0", padding: "0" });
      const pts = route(el.getAttribute("route"), x1, y1, x2, y2);
      el._line = { pts, heads }; // read by the PowerPoint export
      drawLine(overlay(el, 1, 1), pts, el._drawn, heads);
      return;
    }

    // A flow connector: a line corner to corner across its own box (a flat box: straight).
    if (getComputedStyle(el).position === "static") el.style.position = "relative";
    const W = el.offsetWidth, H = el.offsetHeight;
    const from = el.getAttribute("from") || "tl";
    const sx = from.endsWith("r") ? W : 0, sy = from.startsWith("b") ? H : 0;
    let pts;
    if (W < 1) pts = [[0, sy], [0, H - sy]];
    else if (H < 1) pts = [[sx, 0], [W - sx, 0]];
    else pts = [[sx, sy], [W - sx, H - sy]];
    el._line = { pts, heads };
    drawLine(overlay(el, W, H), pts, el._drawn, heads);
    if (!el._observed) {
      el._observed = true;
      new ResizeObserver(() => renderConnector(el)).observe(el);
    }
  }

  // ---------- <x-icon name="…"> ----------

  const ICONS = {
    Activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
    Book: '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5Z"/><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>',
    Chart: '<path d="M3 3v18h18"/><path d="M8 17v-5"/><path d="M13 17V8"/><path d="M18 17v-9"/>',
    Chat: '<path d="M21 12a8.5 8.5 0 0 1-12.4 7.6L3 21l1.5-5.3A8.5 8.5 0 1 1 21 12Z"/>',
    Check: '<path d="M20 6 9 17l-5-5"/>',
    CheckCircle: '<circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-6"/>',
    Clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    Cloud: '<path d="M17.5 19H7a5 5 0 1 1 1.6-9.7A6 6 0 0 1 20 11a4 4 0 0 1-2.5 8Z"/>',
    Code: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
    Database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/><path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/>',
    Globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15 15 0 0 1 0 20a15 15 0 0 1 0-20Z"/>',
    GraduationCap: '<path d="M22 10 12 5 2 10l10 5 10-5Z"/><path d="M6 12v5c3 2.5 9 2.5 12 0v-5"/><path d="M22 10v6"/>',
    Home: '<path d="M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3Z"/>',
    Key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.8-9.8"/><path d="m17.5 5.5 3 3"/><path d="m14.5 8.5 2 2"/>',
    Lightbulb: '<path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.3 1 2.3h6c0-1 .4-1.8 1-2.3A7 7 0 0 0 12 2Z"/>',
    Lightning: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z"/>',
    Link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
    Lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    PaperPlane: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7Z"/>',
    Play: '<path d="M6 3l14 9-14 9V3Z"/>',
    Search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    Settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9 7 7M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1 7 17M17 7l2.1-2.1"/><circle cx="12" cy="12" r="7"/>',
    Star: '<polygon points="12 2 15.1 8.3 22 9.3 17 14.1 18.2 21 12 17.8 5.8 21 7 14.1 2 9.3 8.9 8.3"/>',
    ThumbsUp: '<path d="M7 10v12"/><path d="M15 5.9 14 10h5.8a2 2 0 0 1 2 2.3l-1.4 8A2 2 0 0 1 18.4 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.8a2 2 0 0 0 1.8-1.1L12 2a3.1 3.1 0 0 1 3 3.9Z"/>',
    Tool: '<path d="m15 12-8.5 8.5a2.1 2.1 0 0 1-3-3L12 9"/><path d="m14 4 6 6-3 3-6-6 3-3Z"/>',
    Trust: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>',
    Users: '<circle cx="9" cy="7" r="4"/><path d="M2 21v-2a4 4 0 0 1 4-4h6a4 4 0 0 1 4 4v2"/><path d="M16 3.1a4 4 0 0 1 0 7.8"/><path d="M22 21v-2a4 4 0 0 0-3-3.9"/>',
    Verified: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>',
    Warning: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    Wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9l-3.8 3.8Z"/>',
  };
  window.__deckIcons = Object.keys(ICONS);

  function renderIcon(el) {
    const body = ICONS[el.getAttribute("name")];
    if (!body) return;
    el.replaceChildren();
    const s = mk("svg", {
      viewBox: "-12 -12 48 48",
      width: "100%",
      height: "100%",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": 2,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
    });
    s.style.display = "block";
    s.innerHTML = body;
    el.appendChild(s);
  }

  // ---------- <x-embed>: a small live page in a sandboxed frame ----------

  const EMBED_HEAD =
    '<!doctype html><meta charset="utf-8">' +
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:\">" +
    "<style>html,body{margin:0;background:transparent;overflow:hidden}html{print-color-adjust:exact}</style>";

  function renderEmbed(el) {
    const tpl = el.querySelector(":scope > template");
    if (!tpl || el.querySelector(":scope > iframe")) return;
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("tabindex", "-1");
    frame.srcdoc = EMBED_HEAD + tpl.innerHTML;
    Object.assign(frame.style, { width: "100%", height: "100%", border: "0", display: "block", pointerEvents: "none", background: "transparent" });
    el.appendChild(frame);
  }

  // ---------- pictures: data-video clips and data-crop ----------

  function renderVideo(img) {
    const src = img.getAttribute("data-video");
    if (!src) return;
    const v = document.createElement("video");
    for (const a of img.attributes) if (!["src", "alt"].includes(a.name)) v.setAttribute(a.name, a.value);
    v.poster = img.getAttribute("src") || "";
    v.src = src;
    v.loop = true;
    v.playsInline = true;
    v.preload = "auto";
    v.muted = img.getAttribute("data-video-sound") !== "on";
    if (img.alt) v.setAttribute("aria-label", img.alt);
    v.dataset.deckVideo = "";
    img.replaceWith(v);
  }

  function applyCrop(img) {
    const m = (img.getAttribute("data-crop") || "").trim().match(/^([\d.]+)\s+(-?[\d.]+)%\s+(-?[\d.]+)%$/);
    if (!m) return;
    const zoom = Math.min(50, Math.max(1, Number(m[1])));
    const x = Number(m[2]) / 100, y = Number(m[3]) / 100;
    img.style.objectPosition = `${m[2]}% ${m[3]}%`;
    if (zoom > 1 && CSS.supports("object-view-box", "inset(0%)")) {
      const f = 1 - 1 / zoom;
      const pct = (n) => (n * 100).toFixed(3) + "%";
      img.style.objectViewBox = `inset(${pct(y * f)} ${pct((1 - x) * f)} ${pct((1 - y) * f)} ${pct(x * f)})`;
    }
  }

  // ---------- the format's paint order and flex rules ----------

  // All flow content paints as one layer where the first flow child sits, so pinned
  // children listed before it paint underneath. Column flex children that grow may shrink.
  function applyFormatRules(section) {
    let seenFlow = false;
    for (const child of section.children) {
      if (child.tagName === "ASIDE") continue;
      const cs = getComputedStyle(child);
      if (cs.display === "none") continue;
      const pinned = cs.position === "absolute" || cs.position === "fixed";
      if (!pinned) seenFlow = true;
      else if (!seenFlow && cs.zIndex === "auto") child.style.zIndex = "-1";
    }
    for (const el of section.querySelectorAll("*")) {
      const parent = el.parentElement;
      if (!parent) continue;
      const pcs = getComputedStyle(parent);
      if (pcs.display.includes("flex") && pcs.flexDirection.startsWith("column")) {
        const cs = getComputedStyle(el);
        if (px(cs.flexGrow) > 0 && cs.minHeight === "auto") el.style.minHeight = "0";
      }
    }
  }

  // Measure with every slide laid out (the viewer hides all but one), then put the mode back.
  // Synchronous, so nothing paints in between.
  function withAllShown(fn) {
    const de = document.documentElement;
    const cls = de.className;
    de.className = "";
    try {
      fn();
    } finally {
      de.className = cls;
    }
  }

  function renderAll() {
    document.querySelectorAll("body > section").forEach(applyFormatRules);
    document.querySelectorAll("img[data-video]").forEach(renderVideo);
    document.querySelectorAll("img[data-crop]").forEach(applyCrop);
    document.querySelectorAll("x-shape").forEach(renderShape);
    document.querySelectorAll("x-icon").forEach(renderIcon);
    document.querySelectorAll("x-embed").forEach(renderEmbed);
    document.querySelectorAll("x-connector").forEach(renderConnector);
  }

  withAllShown(renderAll);

  // Draw the shapes and connectors again after a change of layout (the PowerPoint export makes one).
  window.__deckRedraw = () =>
    withAllShown(() => {
      document.querySelectorAll("x-shape").forEach(renderShape);
      document.querySelectorAll("x-connector").forEach(renderConnector);
    });

  const settled = (img) =>
    img.complete
      ? null
      : new Promise((r) => {
          img.addEventListener("load", r, { once: true });
          img.addEventListener("error", r, { once: true });
        });
  const images = [...document.images].map(settled).filter(Boolean);
  window.__deckReady = Promise.all([document.fonts.ready, ...images]).then(() => {
    window.__deckRedraw();
    return true;
  });
})();
