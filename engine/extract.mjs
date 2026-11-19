// Reads a laid-out deck page into plain drawing values: for every slide, a list of shapes,
// text boxes, pictures, lines and tables in paint order, each with its position in slide px.
//
// extractDeck is run INSIDE the deck page (scripts/pptx.mjs sends its source to Chrome), so it
// must stay self-contained: no imports, nothing from this module's scope.

export async function extractDeck(opts = {}) {
  const basicFonts = Boolean(opts.basicFonts);
  // pictures: every slide goes in as one picture, so only its notes and a description are read.
  const pictures = Boolean(opts.pictures);
  // How much of a line's leading the reader of the file puts ABOVE the text. PowerPoint hangs a
  // line of fixed height from its bottom, so all of it (1); CSS splits it in two (0.5). Each
  // text box is moved by the difference, so that its first baseline lands where the browser's did.
  const leadAbove = typeof opts.leadAbove === "number" ? opts.leadAbove : 1;
  const baselineShift = (contentHeight, lineHeight) => (contentHeight - lineHeight) * (leadAbove - 0.5);
  const num = (v) => parseFloat(v) || 0;
  const warnings = [];
  const fonts = new Map(); // face → characters set in it (a count)
  const jobs = [];
  let shotId = 0;
  let slideNo = 0;
  const warn = (msg) => {
    if (!warnings.some((w) => w.slide === slideNo && w.msg === msg)) warnings.push({ slide: slideNo, msg });
  };
  const label = (el) => {
    const cls = typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/).join(".") : "";
    return `<${el.tagName.toLowerCase()}${cls}>`;
  };

  // ---------- colours ----------

  const cvs = document.createElement("canvas");
  cvs.width = cvs.height = 1;
  const ctx2d = cvs.getContext("2d", { willReadFrequently: true });
  const colorCache = new Map();
  const hex2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0").toUpperCase();

  /** Any CSS colour → { hex: "RRGGBB", a: 0–1 }, or null when it paints nothing. */
  function color(c, op = 1) {
    if (!c) return null;
    let v = colorCache.get(c);
    if (v === undefined && !CSS.supports("color", c)) colorCache.set(c, (v = null));
    if (v === null) return null;
    if (v === undefined) {
      const m = c.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/);
      if (m) {
        v = { hex: hex2(+m[1]) + hex2(+m[2]) + hex2(+m[3]), a: m[4] === undefined ? 1 : m[5] ? +m[4] / 100 : +m[4] };
      } else {
        ctx2d.clearRect(0, 0, 1, 1);
        ctx2d.fillStyle = "#000";
        ctx2d.fillStyle = c;
        ctx2d.fillRect(0, 0, 1, 1);
        const d = ctx2d.getImageData(0, 0, 1, 1).data;
        v = { hex: hex2(d[0]) + hex2(d[1]) + hex2(d[2]), a: d[3] / 255 };
      }
      colorCache.set(c, v);
    }
    const a = v.a * op;
    return a < 0.004 ? null : { hex: v.hex, a: Math.round(a * 1000) / 1000 };
  }

  /** Split on commas that sit outside brackets. */
  function splitTop(s) {
    const out = [];
    let depth = 0, cur = "";
    for (const ch of s) {
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      if (ch === "," && depth === 0) {
        out.push(cur.trim());
        cur = "";
      } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }

  function gradient(str, op, w, h) {
    if (!str || str === "none") return null;
    const layer = splitTop(str)[0];
    const m = layer.match(/^(repeating-)?(linear|radial)-gradient\(([\s\S]*)\)$/);
    if (!m || m[1]) return null;
    const parts = splitTop(m[3]);
    const linear = m[2] === "linear";
    let angle = 180;
    const head = parts[0] || "";
    if (linear) {
      const am = head.match(/^(-?[\d.]+)(deg|turn|rad|grad)$/);
      const corner = Math.atan2(h, w) * (180 / Math.PI);
      if (am) {
        angle = +am[1] * { deg: 1, turn: 360, rad: 180 / Math.PI, grad: 0.9 }[am[2]];
        parts.shift();
      } else if (head.startsWith("to ")) {
        const to = head.slice(3).split(/\s+/).sort().join(" ");
        angle = { top: 0, right: 90, bottom: 180, left: 270, "right top": corner, "bottom right": 180 - corner, "bottom left": 180 + corner, "left top": 360 - corner }[to] ?? 180;
        parts.shift();
      }
    } else if (!color(head.replace(/\s+-?[\d.]+(%|px)$/, ""))) {
      parts.shift(); // a shape, size or position: the export draws a plain centred circle
    }
    const rad = (angle * Math.PI) / 180;
    const len = linear ? Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad)) : Math.hypot(w, h) / 2;
    const stops = [];
    for (const p of parts) {
      const pm = p.match(/^([\s\S]*?)(?:\s+(-?[\d.]+)(%|px))?$/);
      const c = color(pm[1].trim(), op) || { hex: "FFFFFF", a: 0 };
      const pos = pm[2] === undefined ? null : pm[3] === "%" ? +pm[2] : len ? (+pm[2] / len) * 100 : 0;
      stops.push({ ...c, pos });
    }
    if (stops.length < 2) return null;
    if (stops[0].pos === null) stops[0].pos = 0;
    if (stops[stops.length - 1].pos === null) stops[stops.length - 1].pos = 100;
    for (let i = 1; i < stops.length - 1; i++) {
      if (stops[i].pos !== null) continue;
      let j = i;
      while (stops[j].pos === null) j++;
      const from = stops[i - 1].pos, step = (stops[j].pos - from) / (j - i + 1);
      for (let k = i; k < j; k++) stops[k].pos = from + step * (k - i + 1);
    }
    let floor = 0;
    for (const s of stops) floor = s.pos = Math.min(100, Math.max(floor, s.pos));
    return { type: m[2], angle: ((angle % 360) + 360) % 360, stops };
  }

  function shadow(str, op, sc) {
    if (!str || str === "none") return null;
    for (const layer of splitTop(str)) {
      if (/\binset\b/.test(layer)) continue;
      const nums = [...layer.matchAll(/(-?[\d.]+(?:e-?\d+)?)px/g)].map((m) => +m[1] * sc);
      const c = color(layer.replace(/-?[\d.]+(?:e-?\d+)?px/g, "").trim(), op);
      if (!c || nums.length < 2) continue;
      const [dx, dy, blur = 0, spread = 0] = nums;
      // The spread is folded into the blur: PowerPoint has no spread.
      return { ...c, dx, dy, blur: Math.max(0, blur + Math.max(0, spread)) };
    }
    return null;
  }

  // ---------- fonts ----------

  const GENERIC = {
    "sans-serif": "Arial", serif: "Times New Roman", monospace: "Courier New", cursive: "Brush Script MT", fantasy: "Impact",
    "system-ui": "Arial", "ui-sans-serif": "Arial", "ui-serif": "Times New Roman", "ui-monospace": "Courier New", "ui-rounded": "Arial",
    "-apple-system": "Arial", blinkmacsystemfont: "Arial", math: "Cambria Math", emoji: "Apple Color Emoji",
  };
  const BASIC = new Set(["arial", "verdana", "tahoma", "trebuchet ms", "georgia", "times new roman", "courier new", "brush script mt"]);
  const faceCache = new Map();
  function face(stack) {
    let f = faceCache.get(stack);
    if (f) return f;
    const names = stack.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    if (basicFonts) {
      f = names.find((n) => BASIC.has(n.toLowerCase())) || GENERIC[(names.find((n) => GENERIC[n.toLowerCase()]) || "").toLowerCase()] || "Arial";
    } else {
      f = GENERIC[(names[0] || "").toLowerCase()] || names[0] || "Arial";
    }
    faceCache.set(stack, f);
    return f;
  }

  // ---------- pseudo-elements become real elements, so they can be measured ----------

  function materializePseudos(sec) {
    const made = [];
    const increments = getComputedStyle(sec).counterIncrement || "";
    for (const el of [sec, ...sec.querySelectorAll("*")]) {
      if (el.closest("aside, svg, x-embed, template, x-icon, x-shape, x-connector")) continue;
      for (const which of ["::before", "::after"]) {
        const ps = getComputedStyle(el, which);
        const content = ps.content;
        if (!content || content === "none" || content === "normal" || ps.display === "none") continue;
        let text = "", field = false;
        for (const t of content.matchAll(/"((?:[^"\\]|\\.)*)"|counter\(\s*([\w-]+)[^)]*\)|url\([^)]*\)/g)) {
          if (t[1] !== undefined) text += t[1].replace(/\\([0-9a-fA-F]{1,6}) ?/g, (_m, h) => String.fromCodePoint(parseInt(h, 16))).replace(/\\(.)/g, "$1");
          else if (t[2] && new RegExp(`(^|\\s)${t[2]}\\s`).test(increments + " ")) {
            text += String(slideNo);
            field = true;
          } else warn(`${which} content on ${label(el)} could not be read (${t[0]}); it is left out`);
        }
        let css = "";
        for (const p of ps) css += `${p}:${ps.getPropertyValue(p)};`;
        made.push({ el, which, css, text, field });
      }
    }
    for (const m of made) {
      const span = document.createElement("span");
      span.style.cssText = m.css + "animation:none;transition:none;";
      span.textContent = m.text;
      if (m.field) span.dataset.pptxField = "slidenum";
      m.el.setAttribute(m.which === "::before" ? "data-pptx-nb" : "data-pptx-na", "");
      if (m.which === "::before") m.el.prepend(span);
      else m.el.append(span);
    }
    return made.length;
  }

  const fix = document.createElement("style");
  fix.textContent =
    // PowerPoint breaks lines greedily: lay the deck out the same way before measuring it.
    (pictures ? "" : "*{text-wrap-style:auto!important}") +
    "[data-pptx-nb]::before,[data-pptx-na]::after{content:none!important}" +
    "html.pptx-shot,html.pptx-shot body{background:transparent!important}" +
    "html.pptx-shot body *{visibility:hidden!important}" +
    "html.pptx-shot [data-pptx-on],html.pptx-shot [data-pptx-on] *{visibility:visible!important}";
  document.head.appendChild(fix);

  // ---------- one slide ----------

  const REPLACED = /^(IMG|VIDEO|CANVAS|IFRAME|OBJECT|X-ICON|X-EMBED|X-SHAPE|X-CONNECTOR|HR|TABLE|UL|OL)$/;
  const isSvg = (el) => el.namespaceURI === "http://www.w3.org/2000/svg";
  const RASTER = /^(VIDEO|CANVAS|IFRAME|OBJECT|X-ICON|X-EMBED)$/;

  function readSlide(sec) {
    const S = sec.getBoundingClientRect();
    const items = [];
    const push = (item) => {
      items.push(item);
      return item;
    };

    function rectOf(el, ctx) {
      const r = el.getBoundingClientRect();
      if (!ctx.rot && ctx.sc === 1) return { x: r.left - S.left, y: r.top - S.top, w: r.width, h: r.height, rot: 0 };
      const cs = getComputedStyle(el);
      const w = (el.offsetWidth ?? num(cs.width)) * ctx.sc, h = (el.offsetHeight ?? num(cs.height)) * ctx.sc;
      const cx = (r.left + r.right) / 2 - S.left, cy = (r.top + r.bottom) / 2 - S.top;
      return { x: cx - w / 2, y: cy - h / 2, w, h, rot: ctx.rot };
    }

    /** padding + border on each side, in slide px. */
    function insets(cs, sc, borders = true) {
      const b = (side) => (borders && cs[`border${side}Style`] !== "none" ? num(cs[`border${side}Width`]) : 0);
      return {
        l: (num(cs.paddingLeft) + b("Left")) * sc,
        t: (num(cs.paddingTop) + b("Top")) * sc,
        r: (num(cs.paddingRight) + b("Right")) * sc,
        b: (num(cs.paddingBottom) + b("Bottom")) * sc,
      };
    }

    /** The corner shape of a box: rect, roundRect (adj = radius ÷ short side) or ellipse. */
    function corners(cs, w, h, sc, inset = 0) {
      const short = Math.min(w, h);
      const one = (v) => {
        const first = String(v).split(" ")[0];
        return first.endsWith("%") ? (num(first) / 100) * short : num(first) * sc;
      };
      const r = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map(one);
      if (r.every((v) => v <= 0.5) || short <= 0) return { geom: "rect" };
      const pct = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].every((v) => /%/.test(v) && num(v) >= 50);
      const max = Math.max(...r);
      if (pct || (max >= short / 2 - 0.5 && Math.abs(w - h) < 1 && r.every((v) => v >= short / 2 - 0.5))) return { geom: "ellipse" };
      const adj = (v) => Math.round(Math.min(0.5, Math.max(0, v - inset) / Math.max(1, short - 2 * inset)) * 100000);
      if (r[0] > 0.5 && r[1] > 0.5 && r[2] <= 0.5 && r[3] <= 0.5) return { geom: "round2SameRect", adj: [adj(Math.max(r[0], r[1])), 0] };
      if (r.filter((v) => v <= 0.5).length >= 2) return { geom: "rect" };
      return { geom: "roundRect", adj: [adj(max)] };
    }

    const DASH = { dashed: "dash", dotted: "sysDot" };

    /** What a box paints of its own: fill, an even border or separate sides, a shadow. */
    function boxPaint(el, cs, ctx, R) {
      const fill = gradient(cs.backgroundImage, ctx.op, R.w, R.h) || color(cs.backgroundColor, ctx.op);
      if (/url\(/.test(cs.backgroundImage)) warn(`a url() background on ${label(el)} is left out (use an <img>)`);
      const sides = ["Top", "Right", "Bottom", "Left"].map((s) => {
        const style = cs[`border${s}Style`];
        const w = style === "none" || style === "hidden" ? 0 : num(cs[`border${s}Width`]) * ctx.sc;
        const c = w ? color(cs[`border${s}Color`], ctx.op) : null;
        return c ? { w, c, style } : null;
      });
      let line = null, edges = null;
      const live = sides.filter(Boolean);
      if (live.length === 4 && live.every((s) => s.w === live[0].w && s.c.hex === live[0].c.hex && s.c.a === live[0].c.a && s.style === live[0].style)) {
        line = { w: live[0].w, ...live[0].c, dash: DASH[live[0].style] || null };
      } else if (live.length) edges = sides;
      const sh = shadow(cs.boxShadow, ctx.op, ctx.sc);
      return { fill, line, edges, shadow: sh };
    }

    /** Emit a box's paint; `text` (a text body) rides in the same shape when it can. */
    function paintBox(el, cs, ctx, R, text) {
      const p = boxPaint(el, cs, ctx, R);
      if (!p.fill && !p.line && !p.edges) return null;
      const bw = p.line ? p.line.w : 0;
      const g = corners(cs, R.w, R.h, ctx.sc, bw / 2);
      let shape = null;
      if (p.fill || p.line) {
        // PowerPoint centres a line on the edge; CSS draws it inside. Pull the edge in by half.
        shape = push({
          t: "shape", name: text ? "Text" : "Shape", ...g,
          x: R.x + bw / 2, y: R.y + bw / 2, w: Math.max(0, R.w - bw), h: Math.max(0, R.h - bw), rot: R.rot,
          fill: p.fill, line: p.line, shadow: p.fill ? p.shadow : null,
        });
        if (text && !p.edges) {
          shape.text = text;
          for (const k of ["l", "t", "r", "b"]) text.ins[k] = Math.max(0, text.ins[k] - bw / 2);
        }
      }
      if (p.edges) {
        const [t, r, b, l] = p.edges;
        const bar = (s, x, y, w, h) => s && w > 0 && h > 0 && push({ t: "shape", name: "Rule", geom: "rect", x, y, w, h, rot: 0, fill: s.c });
        if (R.rot) warn(`a turned box with uneven borders keeps only its fill: ${label(el)}`);
        else {
          bar(t, R.x, R.y, R.w, t?.w);
          bar(b, R.x, R.y + R.h - (b?.w || 0), R.w, b?.w);
          bar(l, R.x, R.y, l?.w, R.h);
          bar(r, R.x + R.w - (r?.w || 0), R.y, r?.w, R.h);
        }
      }
      return shape && shape.text ? shape : null;
    }

    // ----- text -----

    const inlineNode = (n) => {
      if (n.nodeType === 3) return true;
      if (n.nodeType !== 1) return null; // comments
      if (n.tagName === "BR") return true;
      if (REPLACED.test(n.tagName) || isSvg(n)) return false;
      const d = getComputedStyle(n).display;
      return d === "inline" || d === "contents";
    };

    /** Children as runs of inline content and block boxes, in order. */
    function groupChildren(el) {
      const groups = [];
      let cur = null;
      const close = () => {
        if (cur && cur.some((n) => (n.nodeType === 3 ? n.data.trim() : n.tagName !== "BR" && n.textContent.trim()))) groups.push({ inline: cur });
        cur = null;
      };
      for (const n of el.childNodes) {
        const k = inlineNode(n);
        if (k === null) continue;
        if (k) {
          if (!cur && n.nodeType === 3 && !n.data.trim()) continue;
          (cur ||= []).push(n);
        } else {
          close();
          if (!/^(ASIDE|TEMPLATE|SCRIPT|STYLE|NOSCRIPT)$/.test(n.tagName)) groups.push({ block: n });
        }
      }
      close();
      return groups;
    }

    const styleCache = new Map();
    function runStyle(el, blockEl, ctx) {
      const key = el;
      let st = styleCache.get(key);
      if (st && st.sc === ctx.sc && st.op === ctx.op) return st.v;
      const cs = getComputedStyle(el);
      let u = false, strike = false, link = null, base = 0, field = null;
      for (let e = el; e; e = e.parentElement) {
        const ecs = e === el ? cs : getComputedStyle(e);
        const d = ecs.textDecorationLine || "";
        if (d.includes("underline")) u = true;
        if (d.includes("line-through")) strike = true;
        if (!link && e.tagName === "A" && /^(https?:|mailto:)/i.test(e.href || "")) link = e.href;
        if (!base && ecs.verticalAlign === "super") base = 30000;
        if (!base && ecs.verticalAlign === "sub") base = -25000;
        if (e.dataset && e.dataset.pptxField) field = e.dataset.pptxField;
        if (e === blockEl) break;
      }
      let size = num(cs.fontSize) * ctx.sc;
      // PowerPoint shrinks raised and lowered text itself.
      if (base) size = num(getComputedStyle(blockEl).fontSize) * ctx.sc;
      const tt = cs.textTransform;
      const v = {
        font: face(cs.fontFamily),
        size,
        bold: parseInt(cs.fontWeight) >= 600,
        italic: cs.fontStyle !== "normal",
        u, strike, link, base, field,
        color: color(cs.color, ctx.op) || { hex: "000000", a: 0 },
        spc: cs.letterSpacing === "normal" ? 0 : num(cs.letterSpacing) * ctx.sc,
        cap: tt === "uppercase" ? "all" : cs.fontVariantCaps === "small-caps" ? "small" : null,
        tt: tt === "lowercase" || tt === "capitalize" ? tt : null,
        pre: /^pre/.test(cs.whiteSpace) ? cs.whiteSpace : null,
      };
      v.key = [v.font, v.size, v.bold, v.italic, v.u, v.strike, v.link, v.base, v.field, v.color.hex, v.color.a, v.spc, v.cap].join("|");
      styleCache.set(key, { sc: ctx.sc, op: ctx.op, v });
      return v;
    }

    /** Inline nodes → runs with collapsed white space: [{ text, …style } | { br: true }]. */
    function collectRuns(nodes, blockEl, ctx) {
      const raw = [];
      const visit = (n) => {
        if (n.nodeType === 3) {
          if (n.data) raw.push({ text: n.data, el: n.parentElement });
        } else if (n.nodeType === 1) {
          if (n.tagName === "BR") raw.push({ br: true });
          else if (isSvg(n) || /^(ASIDE|TEMPLATE|SCRIPT|STYLE|X-ICON|IMG)$/.test(n.tagName)) return;
          else if (getComputedStyle(n).display !== "none") for (const c of n.childNodes) visit(c);
        }
      };
      nodes.forEach(visit);
      const out = [];
      let spaced = true; // at a line start, or just after a space
      const trimEnd = () => {
        const last = out[out.length - 1];
        if (last && !last.br && !last.pre) {
          last.text = last.text.replace(/ $/, "");
          if (!last.text) out.pop();
        }
      };
      for (const r of raw) {
        if (r.br) {
          trimEnd();
          out.push({ br: true });
          spaced = true;
          continue;
        }
        const st = runStyle(r.el, blockEl, ctx);
        if (st.pre && st.pre !== "pre-line") {
          const lines = r.text.split("\n");
          lines.forEach((line, i) => {
            if (i) out.push({ br: true });
            if (line) out.push({ ...st, text: line.replace(/\t/g, "    ") });
          });
          spaced = false;
          continue;
        }
        let t = r.text.replace(/[ \t\n\r\f]+/g, " ");
        if (spaced) t = t.replace(/^ /, "");
        if (!t) continue;
        if (st.tt === "lowercase") t = t.toLowerCase();
        else if (st.tt === "capitalize") t = t.replace(/(^|[\s\-(])(\p{L})/gu, (_m, a, b) => a + b.toUpperCase());
        spaced = t.endsWith(" ");
        const last = out[out.length - 1];
        if (last && !last.br && last.key === st.key) last.text += t;
        else out.push({ ...st, text: t });
      }
      trimEnd();
      while (out.length && out[out.length - 1].br) out.pop();
      for (const r of out) {
        delete r.tt;
        delete r.pre;
        if (!r.br) fonts.set(r.font, (fonts.get(r.font) || 0) + r.text.length);
      }
      return out;
    }

    /** The lines the browser laid these inline nodes out in. */
    function measure(nodes) {
      const range = document.createRange();
      range.setStartBefore(nodes[0]);
      range.setEndAfter(nodes[nodes.length - 1]);
      const rects = [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5);
      const lines = [];
      for (const r of rects.sort((a, b) => a.top + a.height / 2 - (b.top + b.height / 2))) {
        const cy = r.top + r.height / 2;
        const line = lines[lines.length - 1];
        if (line && Math.abs(cy - line.cy) < Math.max(line.ch, r.height) * 0.45) {
          line.left = Math.min(line.left, r.left);
          line.right = Math.max(line.right, r.right);
          if (r.height > line.ch) {
            line.ch = r.height;
            line.cy = cy;
          }
        } else lines.push({ left: r.left, right: r.right, cy, ch: r.height });
      }
      return lines;
    }

    const ALIGN = { left: "l", start: "l", "-webkit-left": "l", center: "ctr", "-webkit-center": "ctr", right: "r", end: "r", "-webkit-right": "r", justify: "just" };

    /** Line height in slide px (null = the font's own), and the lines' pitch as laid out. */
    function lineHeight(cs, lines, ctx) {
      if (cs.lineHeight !== "normal") return { L: num(cs.lineHeight) * ctx.sc, exact: true };
      const pitch = lines.length > 1 ? (lines[lines.length - 1].cy - lines[0].cy) / (lines.length - 1) : lines[0].ch;
      return { L: pitch, exact: false };
    }

    /**
     * A text body for inline content laid out in `content` (the box the text may fill, slide px).
     * Returns { paras, ins, anchor, wrap, shift } where ins is measured from `outer`.
     */
    function textBody(nodes, blockEl, cs, ctx, outer, content) {
      const runs = collectRuns(nodes, blockEl, ctx);
      if (!runs.some((r) => !r.br)) return null;
      const lines = measure(nodes).map((l) => ({ ...l, left: l.left - S.left, right: l.right - S.left, cy: l.cy - S.top }));
      const { L, exact } = lines.length ? lineHeight(cs, lines, ctx) : { L: 0, exact: false };
      let algn = ALIGN[cs.textAlign] || "l";
      let anchor = "t";
      const ins = { l: content.x - outer.x, t: content.y - outer.y, r: outer.x + outer.w - (content.x + content.w), b: outer.y + outer.h - (content.y + content.h) };
      let shift = 0;
      if (lines.length && !ctx.rot) {
        const top = lines[0].cy - L / 2, bottom = lines[lines.length - 1].cy + L / 2;
        const above = top - content.y, below = content.y + content.h - bottom;
        if (Math.abs(above) <= 2) anchor = "t";
        else if (Math.abs(above - below) <= 2.5) anchor = "ctr";
        else if (Math.abs(below) <= 2) anchor = "b";
        else ins.t += above;
        const left = Math.min(...lines.map((l) => l.left)), right = Math.max(...lines.map((l) => l.right));
        const gapL = left - content.x, gapR = content.x + content.w - right;
        if (algn === "l" && gapL > 2) {
          if (Math.abs(gapL - gapR) <= 2.5) algn = "ctr";
          else if (gapR <= 2) algn = "r";
          else ins.l += gapL;
        }
        if (exact) shift = baselineShift(lines[0].ch, L);
      } else if (ctx.rot) {
        const flex = /flex|grid/.test(cs.display);
        if (flex && /center/.test(cs.alignItems) && !/column/.test(cs.flexDirection)) anchor = "ctr";
        if (flex && /center/.test(cs.justifyContent) && !/column/.test(cs.flexDirection)) algn = "ctr";
        if (exact) shift = baselineShift(num(cs.fontSize) * ctx.sc * 1.2, L);
      }
      const nowrap = cs.whiteSpace === "nowrap" || cs.whiteSpace === "pre";
      const single = lines.length === 1 && !ctx.rot;
      return {
        paras: [{ algn, L: exact ? L : null, runs }],
        ins, anchor, shift,
        wrap: !(nowrap || lines.length <= 1),
        lineWidth: single ? lines[0].right - lines[0].left : null,
      };
    }

    /** Emit an unpainted text box, moved by the body's baseline shift. */
    function pushText(body, R, name) {
      settle(body, false);
      let { x, w } = R;
      // One line in a box that only just holds it: a program that wraps anyway, or another
      // font, would break it. Give the box room on the side the text doesn't start from.
      if (body.lineWidth) {
        const short = body.lineWidth * 1.08 + 8 - (w - body.ins.l - body.ins.r);
        const algn = body.paras[0].algn;
        if (short > 0) {
          w += short;
          if (algn === "r") x -= short;
          else if (algn === "ctr") x -= short / 2;
        }
      }
      delete body.lineWidth;
      push({ t: "shape", name, geom: "rect", x, y: R.y + body.dy, w, h: R.h, rot: R.rot, text: body });
    }

    /** Turn the baseline shift into a move of the box (free text) or of its insets (a painted box, a cell). */
    function settle(body, fixed) {
      body.dy = 0;
      const s = body.shift || 0;
      delete body.shift;
      if (!fixed) {
        // A free box can simply move; an inset can't go below nothing.
        body.dy = s + Math.min(0, body.ins.t);
        body.ins.t = Math.max(0, body.ins.t);
        return;
      }
      if (!s) return;
      if (body.anchor === "ctr") {
        const d = Math.max(-body.ins.t, Math.min(body.ins.b, s));
        body.ins.t += d;
        body.ins.b -= d;
      } else if (body.anchor === "b") body.ins.b = Math.max(0, body.ins.b - s);
      else body.ins.t = Math.max(0, body.ins.t + s);
    }

    // ----- lists -----

    const BULLET = { disc: "•", circle: "◦", square: "▪" };
    const NUMBER = { decimal: "arabicPeriod", "lower-alpha": "alphaLcPeriod", "lower-latin": "alphaLcPeriod", "upper-alpha": "alphaUcPeriod", "upper-latin": "alphaUcPeriod", "lower-roman": "romanLcPeriod", "upper-roman": "romanUcPeriod" };

    function listPlan(list) {
      const plan = [];
      for (const li of list.children) {
        if (li.tagName !== "LI") return null;
        const cs = getComputedStyle(li);
        if (cs.display === "none") continue;
        if (cs.display !== "list-item") return null;
        const type = cs.listStyleType;
        if (!BULLET[type] && !NUMBER[type]) return null;
        const groups = groupChildren(li);
        const inline = groups.filter((g) => g.inline);
        const subs = [];
        for (const g of groups) {
          if (!g.block) continue;
          if (!/^(UL|OL)$/.test(g.block.tagName)) return null;
          const sub = listPlan(g.block);
          if (!sub) return null;
          subs.push(sub);
        }
        if (inline.length !== 1) return null;
        plan.push({ li, cs, nodes: inline[0].inline, subs, type });
      }
      return plan.length ? plan : null;
    }

    function listBody(list, plan, ctx, R) {
      const paras = [];
      let prevBottom = null, firstTop = null, rightIns = Infinity;
      const add = (items, level, parent) => {
        const start = parent.tagName === "OL" ? parseInt(parent.getAttribute("start")) || 1 : 1;
        let n = start;
        for (const it of items) {
          const runs = collectRuns(it.nodes, it.li, ctx);
          const lines = measure(it.nodes).map((l) => ({ ...l, left: l.left - S.left, right: l.right - S.left, cy: l.cy - S.top }));
          if (!runs.length || !lines.length) continue;
          const { L, exact } = lineHeight(it.cs, lines, ctx);
          const top = lines[0].cy - L / 2, bottom = lines[lines.length - 1].cy + L / 2;
          const lr = it.li.getBoundingClientRect();
          const pad = insets(it.cs, ctx.sc);
          const textLeft = lr.left - S.left + pad.l;
          rightIns = Math.min(rightIns, R.x + R.w - (lr.right - S.left - pad.r));
          const size = num(it.cs.fontSize) * ctx.sc;
          const mc = color(getComputedStyle(it.li, "::marker").color, ctx.op);
          const bullet = BULLET[it.type] ? { char: BULLET[it.type] } : { auto: NUMBER[it.type], start };
          if (mc) bullet.color = mc;
          const hang = Math.min(textLeft - R.x, size * (bullet.char ? 0.75 : String(n).length > 1 ? 1.65 : 1.1));
          const p = { algn: ALIGN[it.cs.textAlign] || "l", L: exact ? L : null, runs, level, bullet, marL: textLeft - R.x, hang, before: prevBottom === null ? 0 : Math.max(0, top - prevBottom) };
          if (firstTop === null) {
            firstTop = top;
            p.firstShift = exact ? baselineShift(lines[0].ch, L) : 0;
          }
          prevBottom = bottom;
          paras.push(p);
          n++;
          for (const sub of it.subs) add(sub, level + 1, sub[0].li.parentElement);
        }
      };
      add(plan, 0, list);
      if (!paras.length) return null;
      const lines1 = paras.length === 1 && measure(plan[0].nodes).length <= 1;
      return {
        paras,
        ins: { l: 0, t: firstTop - R.y, r: Math.max(0, rightIns === Infinity ? 0 : rightIns), b: 0 },
        anchor: "t",
        shift: paras[0].firstShift || 0,
        wrap: !lines1,
      };
    }

    // ----- pictures -----

    const intersect = (a, b) => {
      const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
      const r = Math.min(a.x + a.w, b.x + b.w), bt = Math.min(a.y + a.h, b.y + b.h);
      return { x, y, w: Math.max(0, r - x), h: Math.max(0, bt - y) };
    };

    /** A screenshot of this element alone stands in for it. */
    function raster(el, ctx, name, alt) {
      const r = el.getBoundingClientRect();
      const vis = intersect({ x: r.left - S.left, y: r.top - S.top, w: r.width, h: r.height }, { x: 0, y: 0, w: S.width, h: S.height });
      if (vis.w < 1 || vis.h < 1) return;
      const id = String(++shotId);
      el.setAttribute("data-pptx-shot", id);
      push({ t: "pic", name, alt: alt || "", shot: id, x: vis.x, y: vis.y, w: vis.w, h: vis.h, rot: 0, geom: "rect", pageX: vis.x + S.left + scrollX, pageY: vis.y + S.top + scrollY });
    }

    const imageCache = new Map();
    function imageData(img) {
      const src = img.currentSrc || img.src;
      if (!imageCache.has(src)) {
        imageCache.set(
          src,
          (async () => {
            let type = "";
            try {
              type = (await (await fetch(src)).blob()).type;
            } catch {}
            if (/^image\/(png|jpeg|gif)$/.test(type)) return { src };
            // PowerPoint doesn't read webp, avif or svg: redraw as a PNG.
            const vector = /svg/.test(type);
            const r = img.getBoundingClientRect();
            const k = vector ? Math.max(1, (2 * Math.max(r.width, 1)) / img.naturalWidth, (2 * Math.max(r.height, 1)) / img.naturalHeight) : 1;
            const c = document.createElement("canvas");
            c.width = Math.round(img.naturalWidth * k);
            c.height = Math.round(img.naturalHeight * k);
            c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
            return { data: c.toDataURL("image/png").split(",")[1] };
          })(),
        );
      }
      return imageCache.get(src);
    }

    function picture(el, cs, ctx) {
      const alt = el.getAttribute("alt") || "";
      const R = rectOf(el, ctx);
      if (!el.getAttribute("src")) {
        warn(`an empty picture frame is left out: ${alt || "img"}`);
        return;
      }
      if (!el.naturalWidth) {
        warn(`a picture that did not load is left out: ${el.getAttribute("src")}`);
        return;
      }
      const p = boxPaint(el, cs, ctx, R);
      const pad = insets(cs, ctx.sc);
      const box = { x: R.x + pad.l, y: R.y + pad.t, w: R.w - pad.l - pad.r, h: R.h - pad.t - pad.b };
      if (box.w < 0.5 || box.h < 0.5) return;
      const backed = Boolean(p.fill);
      if (backed) paintBox(el, cs, ctx, R, null);

      const nw = el.naturalWidth, nh = el.naturalHeight;
      const vb = { x: 0, y: 0, w: nw, h: nh };
      const ovb = (cs.objectViewBox || "").match(/^inset\(([^)]*)\)/);
      if (ovb) {
        const v = ovb[1].trim().split(/\s+/);
        const side = (s, ref) => (s.endsWith("%") ? (num(s) / 100) * ref : num(s));
        const t = side(v[0], nh), r = side(v[1] ?? v[0], nw), b = side(v[2] ?? v[0], nh), l = side(v[3] ?? v[1] ?? v[0], nw);
        Object.assign(vb, { x: l, y: t, w: Math.max(1, nw - l - r), h: Math.max(1, nh - t - b) });
      }
      const fit = cs.objectFit;
      let rw = box.w, rh = box.h;
      if (fit !== "fill") {
        const contain = Math.min(box.w / vb.w, box.h / vb.h), cover = Math.max(box.w / vb.w, box.h / vb.h);
        const s = fit === "cover" ? cover : fit === "contain" ? contain : fit === "scale-down" ? Math.min(ctx.sc, contain) : ctx.sc;
        rw = vb.w * s;
        rh = vb.h * s;
      }
      const pos = cs.objectPosition.split(/\s+/);
      const at = (v, free) => (v && v.endsWith("%") ? (free * num(v)) / 100 : v ? num(v) * ctx.sc : free / 2);
      const drawn = { x: box.x + at(pos[0], box.w - rw), y: box.y + at(pos[1], box.h - rh), w: rw, h: rh };
      let frame = intersect(drawn, box);
      const fills = frame.w >= R.w - 1 && frame.h >= R.h - 1;
      let round = fills ? corners(cs, R.w, R.h, ctx.sc) : { geom: "rect" };
      if (!ctx.rot) {
        // Clipping parents crop it further; a rounded one that it fills lends its corners.
        for (let a = el.parentElement; a; a = a === sec ? null : a.parentElement) {
          const acs = getComputedStyle(a);
          if (a !== sec && acs.overflowX === "visible" && acs.overflowY === "visible") continue;
          const ar = a.getBoundingClientRect();
          const ab = { l: num(acs.borderLeftWidth), t: num(acs.borderTopWidth), r: num(acs.borderRightWidth), b: num(acs.borderBottomWidth) };
          const clip = { x: ar.left - S.left + ab.l, y: ar.top - S.top + ab.t, w: ar.width - ab.l - ab.r, h: ar.height - ab.t - ab.b };
          const cut = intersect(frame, clip);
          if (a !== sec && cut.w >= clip.w - 1 && cut.h >= clip.h - 1) {
            const c = corners(acs, ar.width, ar.height, 1);
            if (c.geom !== "rect") round = c;
          } else if (cut.w < frame.w - 0.5 || cut.h < frame.h - 0.5) round = { geom: "rect" };
          frame = cut;
        }
      }
      if (frame.w < 0.5 || frame.h < 0.5) return;
      // A picture's outline is centred on its edge, half of it over the picture; a CSS border
      // sits outside. Grow the frame by half the border and show that much more of the image
      // (or of nothing), so the picture itself stays where it was.
      const line = backed ? null : p.line;
      if (line) frame = { x: frame.x - line.w / 2, y: frame.y - line.w / 2, w: frame.w + line.w, h: frame.h + line.w };
      const fl = (frame.x - drawn.x) / rw, ft = (frame.y - drawn.y) / rh;
      const fr = (drawn.x + rw - frame.x - frame.w) / rw, fb = (drawn.y + rh - frame.y - frame.h) / rh;
      const crop = {
        l: (vb.x + fl * vb.w) / nw,
        t: (vb.y + ft * vb.h) / nh,
        r: (nw - vb.x - vb.w + fr * vb.w) / nw,
        b: (nh - vb.y - vb.h + fb * vb.h) / nh,
      };
      const item = push({
        t: "pic", name: "Picture", alt, x: frame.x, y: frame.y, w: frame.w, h: frame.h, rot: R.rot, ...round, crop,
        line, shadow: backed ? null : p.shadow, alpha: ctx.op < 0.995 ? ctx.op : null,
      });
      jobs.push(imageData(el).then((d) => Object.assign(item, d)));
    }

    // ----- Slides' own shapes -----

    function xShape(el, cs, ctx) {
      const kind = (el.getAttribute("kind") || "rect").toLowerCase();
      const d = el._drawn;
      if (!d || kind === "rect" || kind === "rounded" || kind === "ellipse") return false;
      const R = rectOf(el, ctx);
      const fill = color(d.fill, ctx.op);
      const stroke = d.bw ? color(d.stroke, ctx.op) : null;
      // Its own box is sized without the border the viewer hid; the drawing covers the border too.
      const W = el.offsetWidth * ctx.sc, H = el.offsetHeight * ctx.sc;
      if (kind === "line") {
        const sw = (d.bw || Math.max(2, Math.min(el.offsetWidth, el.offsetHeight))) * ctx.sc;
        const c = d.bw ? stroke : fill;
        if (!c) return true;
        const flat = W >= H;
        const cx = R.x + R.w / 2, cy = R.y + R.h / 2;
        const rad = (R.rot * Math.PI) / 180, half = (flat ? W : H) / 2;
        const ux = flat ? Math.cos(rad) : -Math.sin(rad), uy = flat ? Math.sin(rad) : Math.cos(rad);
        push({ t: "line", name: "Line", pts: [[cx - ux * half, cy - uy * half], [cx + ux * half, cy + uy * half]], w: sw, ...c, dash: DASH[d.dash] || null, start: "none", end: "none", cap: "flat" });
        return true;
      }
      // A block arrow as the viewer draws it: the head is the last 40% of its length and the
      // shaft half its thickness, as fractions of the box, so it keeps that shape at any size.
      const right = [[0, 0.25], [0.6, 0.25], [0.6, 0], [1, 0.5], [0.6, 1], [0.6, 0.75], [0, 0.75]];
      const pts = {
        "arrow-right": right,
        "arrow-left": right.map(([x, y]) => [1 - x, y]),
        "arrow-down": right.map(([x, y]) => [y, x]),
        "arrow-up": right.map(([x, y]) => [y, 1 - x]),
      }[kind];
      if (kind !== "diamond" && !pts) return false;
      const bw = d.bw * ctx.sc;
      const item = { t: "shape", name: kind === "diamond" ? "Diamond" : "Arrow", geom: pts ? "poly" : "diamond", pts, x: R.x + bw / 2, y: R.y + bw / 2, w: R.w - bw, h: R.h - bw, rot: R.rot, fill, line: stroke ? { w: bw, ...stroke, dash: DASH[d.dash] || null } : null };
      if (fill || stroke) push(item);
      return true;
    }

    function xConnector(el, cs, ctx) {
      const d = el._drawn, g = el._line;
      if (!d || !g || g.pts.length < 2) return;
      const c = color(d.color, ctx.op);
      if (!c) return;
      const o = el.getBoundingClientRect();
      const pts = g.pts.map(([x, y]) => [o.left - S.left + x * ctx.sc, o.top - S.top + y * ctx.sc]);
      push({ t: "line", name: "Connector", pts, w: d.sw * ctx.sc, ...c, dash: DASH[d.style] || null, start: g.heads.start, end: g.heads.end, cap: "round" });
    }

    // ----- tables -----

    function table(el, cs, ctx) {
      const R = rectOf(el, ctx);
      const trs = [...el.rows].filter((tr) => getComputedStyle(tr).display !== "none" && tr.cells.length);
      if (!trs.length) return;
      const ncols = Math.max(...trs.map((tr) => [...tr.cells].reduce((n, c) => n + (c.colSpan || 1), 0)));
      // Column edges, from the cells that start and end on them.
      const xs = new Array(ncols + 1).fill(null);
      for (const tr of trs) {
        let c = 0;
        for (const cell of tr.cells) {
          const r = cell.getBoundingClientRect();
          if (xs[c] === null) xs[c] = r.left - S.left;
          c += cell.colSpan || 1;
          if (xs[c] === null) xs[c] = r.right - S.left;
        }
      }
      xs[0] = R.x;
      xs[ncols] = R.x + R.w;
      for (let i = 1; i < ncols; i++) if (xs[i] === null) xs[i] = xs[i - 1] + (R.x + R.w - xs[i - 1]) / (ncols - i + 1);
      const cols = xs.slice(1).map((x, i) => Math.max(1, x - xs[i]));

      const edge = (ecs, side) => {
        const style = ecs[`border${side}Style`];
        const w = style === "none" || style === "hidden" ? 0 : num(ecs[`border${side}Width`]) * ctx.sc;
        const c = w ? color(ecs[`border${side}Color`], ctx.op) : null;
        return c ? { w, ...c, dash: DASH[style] || null } : null;
      };
      const pick = (...e) => e.find(Boolean) || null;

      // Every grid slot's own borders, so that neighbours can agree on a shared edge.
      const grid = trs.map((tr) => {
        const row = [];
        for (const cell of tr.cells) {
          const ccs = getComputedStyle(cell);
          const b = { t: edge(ccs, "Top"), r: edge(ccs, "Right"), b: edge(ccs, "Bottom"), l: edge(ccs, "Left") };
          const span = Math.min(cell.colSpan || 1, ncols - row.length);
          for (let k = 0; k < span; k++) row.push({ cell: k === 0 ? cell : null, ccs, b, span: k === 0 ? span : 0 });
        }
        while (row.length < ncols) row.push({ cell: null, ccs: null, b: {}, span: 1, filler: true });
        return row;
      });
      const tb = { t: edge(cs, "Top"), r: edge(cs, "Right"), b: edge(cs, "Bottom"), l: edge(cs, "Left") };

      const rows = trs.map((tr, ri) => {
        const trcs = getComputedStyle(tr);
        const group = tr.parentElement && tr.parentElement !== el ? getComputedStyle(tr.parentElement) : null;
        const h = tr.getBoundingClientRect().height;
        const cells = grid[ri].map((slot, ci) => {
          if (!slot.cell) return slot.filler ? { text: null } : { merged: true };
          const { cell, ccs } = slot;
          const last = ci + slot.span - 1;
          const borders = {
            l: ci === 0 ? pick(slot.b.l, tb.l) : pick(grid[ri][ci - 1].b.r, slot.b.l),
            r: last === ncols - 1 ? pick(slot.b.r, tb.r) : pick(slot.b.r, grid[ri][last + 1].b.l),
            t: ri === 0 ? pick(slot.b.t, tb.t) : pick(grid[ri - 1][ci].b.b, slot.b.t),
            b: ri === trs.length - 1 ? pick(slot.b.b, tb.b) : pick(slot.b.b, grid[ri + 1][ci].b.t),
          };
          const fill = color(ccs.backgroundColor, ctx.op) || color(trcs.backgroundColor, ctx.op) || (group && color(group.backgroundColor, ctx.op)) || color(cs.backgroundColor, ctx.op);
          const cr = cell.getBoundingClientRect();
          const outer = { x: cr.left - S.left, y: cr.top - S.top, w: cr.width, h: cr.height };
          const pad = insets(ccs, ctx.sc, false);
          const content = { x: outer.x + pad.l, y: outer.y + pad.t, w: outer.w - pad.l - pad.r, h: outer.h - pad.t - pad.b };
          const groups = groupChildren(cell);
          let body = null;
          const va = ccs.verticalAlign;
          const anchor = va === "top" || va === "baseline" ? "t" : va === "bottom" ? "b" : "ctr";
          for (const g of groups) {
            const nodes = g.inline || [g.block];
            const runs = collectRuns(nodes, cell, ctx);
            if (!runs.length) continue;
            const lines = measure(nodes);
            const lh = lines.length ? lineHeight(ccs, lines, ctx) : { L: 0, exact: false };
            const para = { algn: ALIGN[ccs.textAlign] || "l", L: lh.exact ? lh.L : null, runs };
            if (!body) body = { paras: [], ins: pad, anchor, wrap: true, shift: lh.exact && lines.length ? baselineShift(lines[0].ch, lh.L) : 0 };
            body.paras.push(para);
          }
          if (body) settle(body, true);
          return { text: body, fill, borders, span: slot.span, ins: body ? body.ins : pad, anchor };
        });
        return { h, cells };
      });
      push({ t: "table", name: "Table", x: R.x, y: R.y, w: R.w, h: R.h, cols, rows });
    }

    // ----- the walk -----

    function walk(el, parent) {
      const tag = el.tagName;
      if (/^(ASIDE|TEMPLATE|SCRIPT|STYLE|NOSCRIPT)$/.test(tag)) return;
      const cs = getComputedStyle(el);
      if (cs.display === "none") return;
      const ctx = { op: parent.op * (cs.opacity === "" ? 1 : +cs.opacity), rot: parent.rot, sc: parent.sc };
      if (ctx.op < 0.01) return;
      if (cs.transform && cs.transform !== "none") {
        const m = new DOMMatrixReadOnly(cs.transform);
        ctx.rot += (Math.atan2(m.b, m.a) * 180) / Math.PI;
        ctx.sc *= Math.hypot(m.a, m.b) || 1;
        if (Math.abs(m.a * m.c + m.b * m.d) > 0.01) warn(`a skew is left out: ${label(el)}`);
      }
      const shown = cs.visibility !== "hidden";

      if (isSvg(el)) return shown && raster(el, ctx, "Drawing", el.getAttribute("aria-label"));
      if (RASTER.test(tag)) return shown && raster(el, ctx, tag === "X-ICON" ? "Icon" : tag === "X-EMBED" ? "Embed" : "Picture", el.getAttribute("aria-label") || (tag === "X-ICON" ? el.getAttribute("name") : ""));
      if (tag === "IMG") return shown && picture(el, cs, ctx);
      if (tag === "X-CONNECTOR") return shown && xConnector(el, cs, ctx);
      if (tag === "X-SHAPE" && shown && xShape(el, cs, ctx)) return;
      if (tag === "TABLE" && /table/.test(cs.display)) return shown && table(el, cs, ctx);

      const needsPicture = [];
      if (cs.clipPath && cs.clipPath !== "none") needsPicture.push("clip-path");
      if (cs.maskImage && cs.maskImage !== "none") needsPicture.push("mask");
      if (cs.filter && cs.filter !== "none") needsPicture.push("filter");
      if (/conic-gradient|repeating-/.test(cs.backgroundImage)) needsPicture.push("gradient");
      if (cs.mixBlendMode && cs.mixBlendMode !== "normal") needsPicture.push("blend mode");
      if (needsPicture.length && el !== sec && shown) {
        warn(`kept as a picture, not editable (${needsPicture.join(", ")}): ${label(el)}`);
        return raster(el, ctx, "Picture", (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 200));
      }

      const R = rectOf(el, ctx);
      const role = /^H[1-6]$/.test(tag) ? "Heading" : "Text";

      if ((tag === "UL" || tag === "OL") && shown) {
        const plan = listPlan(el);
        if (plan) {
          paintBox(el, cs, ctx, R, null);
          const body = listBody(el, plan, ctx, R);
          if (body) pushText(body, R, "List");
          return;
        }
      }

      const groups = groupChildren(el);
      const allInline = groups.length === 1 && groups[0].inline;
      if (allInline && shown) {
        const pad = insets(cs, ctx.sc);
        const content = { x: R.x + pad.l, y: R.y + pad.t, w: R.w - pad.l - pad.r, h: R.h - pad.t - pad.b };
        const body = textBody(groups[0].inline, el, cs, ctx, R, content);
        if (body && /^H[12]$/.test(tag)) body.heading = tag === "H1" ? 1 : 2;
        const merged = el !== sec && body ? paintBox(el, cs, ctx, R, body) : el !== sec && paintBox(el, cs, ctx, R, null);
        if (merged) {
          settle(body, true);
          // One line in a painted box: the padding on its free side is room it may use.
          if (body.lineWidth) {
            const algn = body.paras[0].algn;
            if (algn === "l") body.ins.r = 0;
            else if (algn === "r") body.ins.l = 0;
            else if (Math.abs(body.ins.l - body.ins.r) < 1) body.ins.l = body.ins.r = 0;
          }
          delete body.lineWidth;
        } else if (body) pushText(body, R, role);
        return;
      }

      if (el !== sec && shown) paintBox(el, cs, ctx, R, null);

      // Paint order: pinned children under the flow, the flow in order, pinned children over it.
      const under = [], flow = [], over = [];
      for (const g of groups) {
        if (g.inline) {
          flow.push(g);
          continue;
        }
        const ccs = getComputedStyle(g.block);
        if (ccs.position === "absolute" || ccs.position === "fixed") {
          const z = parseInt(ccs.zIndex) || 0;
          (z < 0 ? under : over).push({ z, g });
        } else flow.push(g);
      }
      under.sort((a, b) => a.z - b.z);
      over.sort((a, b) => a.z - b.z);
      for (const g of [...under.map((u) => u.g), ...flow, ...over.map((o) => o.g)]) {
        if (g.block) {
          walk(g.block, ctx);
          continue;
        }
        if (!shown) continue;
        // Loose text beside block children: a box around just its lines.
        const lines = measure(g.inline);
        if (!lines.length) continue;
        const { L } = lineHeight(cs, lines, ctx);
        const left = Math.min(...lines.map((l) => l.left)) - S.left, right = Math.max(...lines.map((l) => l.right)) - S.left;
        const top = lines[0].cy - S.top - L / 2, bottom = lines[lines.length - 1].cy - S.top + L / 2;
        const tight = { x: left, y: top, w: (right - left) * (lines.length > 1 ? 1.02 : 1) + (lines.length > 1 ? 2 : 0), h: bottom - top, rot: 0 };
        const body = textBody(g.inline, el, cs, ctx, tight, tight);
        if (body) {
          body.paras[0].algn = "l";
          pushText(body, tight, role);
        }
      }
    }

    const scs = getComputedStyle(sec);
    const bg = gradient(scs.backgroundImage, 1, S.width, S.height) || color(scs.backgroundColor) || { hex: "FFFFFF", a: 1 };
    if (!pictures) walk(sec, { op: 1, rot: 0, sc: 1 });

    const aside = sec.querySelector(":scope > aside");
    let notes = [];
    if (aside) {
      const blocks = aside.children.length ? [...aside.children] : [aside];
      notes = blocks.flatMap((b) => (b.innerHTML || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").split("\n")).map((s) => {
        const t = document.createElement("textarea");
        t.innerHTML = s;
        return t.value.replace(/\s+/g, " ").trim();
      }).filter(Boolean);
    }

    // The slide's title: its first h1, else its first h2.
    const heads = items.filter((i) => i.t === "shape" && i.text && i.text.heading && !i.fill && !i.line && !i.rot);
    const title = heads.find((i) => i.text.heading === 1) || heads[0];
    if (title) title.title = true;

    const words = (sel) => [...sec.querySelectorAll(sel)].filter((e) => !e.closest("aside")).map((e) => e.textContent.trim().replace(/\s+/g, " ")).filter(Boolean);
    const alt = pictures ? [...words("h1, h2, h3"), ...words("p, li, td, th")].join(" · ").slice(0, 1000) : "";
    return { id: sec.id, bg, items, notes, alt, pageY: S.top + scrollY };
  }

  const sections = [...document.querySelectorAll("body > section")].filter((s) => !s.hidden);
  if (!pictures)
    sections.forEach((sec, i) => {
      slideNo = i + 1;
      materializePseudos(sec);
    });
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  if (window.__deckRedraw) window.__deckRedraw();

  const slides = sections.map((sec, i) => {
    slideNo = i + 1;
    return readSlide(sec);
  });
  await Promise.all(jobs);

  // Which of the faces this computer has, so the report can say which ones PowerPoint will swap.
  const used = [...fonts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  const local = {};
  await Promise.all(
    used.map(async (name, i) => {
      const safe = name.replace(/["\\]/g, "");
      try {
        await new FontFace(`pptx-probe-${i}`, `local("${safe}"), local("${safe} Regular")`).load();
        local[name] = true;
      } catch {
        local[name] = false;
      }
    }),
  );

  const first = sections[0];
  const pick = (sel) => {
    const el = first && (first.querySelector(sel) || document.querySelector(`section ${sel}`));
    return el ? face(getComputedStyle(el).fontFamily) : null;
  };
  return {
    slides,
    warnings,
    fonts: used.map((name) => ({ name, local: local[name] })),
    headingFont: pick("h1") || pick("h2") || used[0] || "Arial",
    bodyFont: used[0] || "Arial",
  };
}
