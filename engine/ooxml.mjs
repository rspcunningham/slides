// Writes the parts of a PowerPoint file from the values scripts/lib/extract.mjs read off a deck.
// One slide px is 6350 EMU: a 1920×1080 deck is PowerPoint's own 13.333 × 7.5 in widescreen
// page (a 4:3 deck its 10 × 7.5 in page), and a font size in px is twice its size in points.

import crypto from "node:crypto";

const EMU = 6350;
const emu = (px) => Math.round((Number(px) || 0) * EMU);
const pos = (px) => Math.max(0, emu(px));
const clean = (s) => String(s ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "");
const esc = (s) => clean(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const CT = "application/vnd.openxmlformats-officedocument.presentationml";

// ---------- paint ----------

const clr = (c) => `<a:srgbClr val="${c.hex}">${c.a < 1 ? `<a:alpha val="${Math.round(c.a * 100000)}"/>` : ""}</a:srgbClr>`;
const solid = (c) => `<a:solidFill>${clr(c)}</a:solidFill>`;

function fillXml(f) {
  if (!f) return "<a:noFill/>";
  if (!f.stops) return solid(f);
  const gs = f.stops.slice(0, 10).map((s) => `<a:gs pos="${Math.round(s.pos * 1000)}">${clr(s)}</a:gs>`).join("");
  // CSS measures a gradient's angle from "up"; PowerPoint from "to the right". Both turn clockwise.
  const dir =
    f.type === "radial"
      ? '<a:path path="circle"><a:fillToRect l="50000" t="50000" r="50000" b="50000"/></a:path>'
      : `<a:lin ang="${Math.round((((f.angle - 90) % 360) + 360) % 360 * 60000)}" scaled="0"/>`;
  return `<a:gradFill rotWithShape="1"><a:gsLst>${gs}</a:gsLst>${dir}</a:gradFill>`;
}

function lnXml(line, ends = "") {
  if (!line) return "<a:ln><a:noFill/></a:ln>";
  const cap = line.cap === "round" ? ' cap="rnd"' : line.cap === "flat" ? ' cap="flat"' : "";
  return `<a:ln w="${Math.max(1, emu(line.w))}"${cap}>${solid(line)}${line.dash ? `<a:prstDash val="${line.dash}"/>` : ""}${line.cap === "round" ? "<a:round/>" : '<a:miter lim="800000"/>'}${ends}</a:ln>`;
}

function shadowXml(s) {
  if (!s) return "";
  const dist = Math.hypot(s.dx, s.dy);
  const dir = ((Math.atan2(s.dy, s.dx) * 180) / Math.PI + 360) % 360;
  return `<a:effectLst><a:outerShdw blurRad="${pos(s.blur)}" dist="${pos(dist)}" dir="${Math.round(dir * 60000)}" algn="ctr" rotWithShape="0">${clr(s)}</a:outerShdw></a:effectLst>`;
}

const GUIDES = { roundRect: ["adj"], round2SameRect: ["adj1", "adj2"] };

function geomXml(item) {
  const g = item.geom || "rect";
  if (g === "poly") {
    // A closed outline given as fractions of the box. The path is written at the shape's own
    // size: Apple's importer (Keynote, Quick Look) doesn't scale a path drawn in other units.
    const W = Math.max(1, pos(item.w)), H = Math.max(1, pos(item.h));
    const pt = (p) => `<a:pt x="${Math.round(p[0] * W)}" y="${Math.round(p[1] * H)}"/>`;
    const path = `<a:moveTo>${pt(item.pts[0])}</a:moveTo>` + item.pts.slice(1).map((p) => `<a:lnTo>${pt(p)}</a:lnTo>`).join("") + "<a:close/>";
    return `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst><a:path w="${W}" h="${H}">${path}</a:path></a:pathLst></a:custGeom>`;
  }
  const av = (item.adj || []).map((v, i) => (GUIDES[g]?.[i] ? `<a:gd name="${GUIDES[g][i]}" fmla="val ${Math.round(v)}"/>` : "")).join("");
  return `<a:prstGeom prst="${g}"><a:avLst>${av}</a:avLst></a:prstGeom>`;
}

function xfrmXml(item, tag = "a:xfrm", flips = "") {
  const rot = item.rot ? ` rot="${Math.round(((item.rot % 360) + 360) % 360 * 60000)}"` : "";
  return `<${tag}${rot}${flips}><a:off x="${emu(item.x)}" y="${emu(item.y)}"/><a:ext cx="${pos(item.w)}" cy="${pos(item.h)}"/></${tag}>`;
}

// ---------- text ----------

function rPr(r, lang, links, tag = "a:rPr") {
  const size = Math.min(400000, Math.max(100, Math.round(r.size * 50)));
  let at = ` lang="${lang}" sz="${size}" b="${r.bold ? 1 : 0}" i="${r.italic ? 1 : 0}"`;
  if (r.u) at += ' u="sng"';
  if (r.strike) at += ' strike="sngStrike"';
  at += ' kern="1200"';
  if (r.cap) at += ` cap="${r.cap}"`;
  if (r.spc) at += ` spc="${Math.round(r.spc * 50)}"`;
  if (r.base) at += ` baseline="${r.base}"`;
  at += ' dirty="0"';
  const font = esc(r.font);
  let kids = solid(r.color) + `<a:latin typeface="${font}"/><a:ea typeface="${font}"/><a:cs typeface="${font}"/>`;
  if (r.link && links) kids += `<a:hlinkClick r:id="${links(r.link)}"/>`;
  return `<${tag}${at}>${kids}</${tag}>`;
}

function paraXml(p, env) {
  let at = ` marL="${pos(p.marL || 0)}" indent="${p.bullet ? -pos(p.hang) : 0}"`;
  if (p.level) at += ` lvl="${Math.min(8, p.level)}"`;
  at += ` algn="${p.algn || "l"}"`;
  let kids = p.L ? `<a:lnSpc><a:spcPts val="${Math.min(158400, Math.max(100, Math.round(p.L * 50)))}"/></a:lnSpc>` : '<a:lnSpc><a:spcPct val="100000"/></a:lnSpc>';
  kids += `<a:spcBef><a:spcPts val="${Math.min(158400, Math.max(0, Math.round((p.before || 0) * 50)))}"/></a:spcBef><a:spcAft><a:spcPts val="0"/></a:spcAft>`;
  if (p.bullet) {
    if (p.bullet.color) kids += `<a:buClr>${clr(p.bullet.color)}</a:buClr>`;
    kids += '<a:buSzPct val="100000"/>';
    kids += p.bullet.char
      ? `<a:buFont typeface="Arial"/><a:buChar char="${esc(p.bullet.char)}"/>`
      : `<a:buFontTx/><a:buAutoNum type="${p.bullet.auto}"${p.bullet.start > 1 ? ` startAt="${Math.min(32767, p.bullet.start)}"` : ""}/>`;
  } else kids += "<a:buNone/>";
  const text = p.runs.filter((r) => !r.br);
  let out = "";
  p.runs.forEach((r, i) => {
    if (r.br) {
      const near = p.runs.slice(i + 1).find((x) => !x.br) || text[text.length - 1];
      out += `<a:br>${near ? rPr({ ...near, link: null }, env.lang) : ""}</a:br>`;
    } else if (r.field === "slidenum") {
      out += `<a:fld id="{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}" type="slidenum">${rPr(r, env.lang)}<a:t>${esc(r.text)}</a:t></a:fld>`;
    } else out += `<a:r>${rPr(r, env.lang, env.links)}<a:t>${esc(r.text)}</a:t></a:r>`;
  });
  const last = text[text.length - 1];
  return `<a:p><a:pPr${at}>${kids}</a:pPr>${out}${last ? rPr({ ...last, link: null, u: false, strike: false }, env.lang, null, "a:endParaRPr") : ""}</a:p>`;
}

function bodyXml(body, env, tag = "p:txBody") {
  const i = body.ins;
  const pr = `<a:bodyPr vert="horz" wrap="${body.wrap ? "square" : "none"}" lIns="${pos(i.l)}" tIns="${pos(i.t)}" rIns="${pos(i.r)}" bIns="${pos(i.b)}" rtlCol="0" anchor="${body.anchor || "t"}"><a:noAutofit/></a:bodyPr>`;
  return `<${tag}>${pr}<a:lstStyle/>${body.paras.map((p) => paraXml(p, env)).join("")}</${tag}>`;
}

// ---------- the things on a slide ----------

function shapeXml(it, id, env) {
  const name = esc(`${it.title ? "Title" : it.name || "Shape"} ${id - 1}`);
  const plain = !it.fill && !it.line;
  const nv = it.title
    ? `<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr>`
    : `<p:cNvSpPr${it.text && plain ? ' txBox="1"' : ""}/><p:nvPr/>`;
  const sp = `${xfrmXml(it)}${geomXml(it)}${fillXml(it.fill)}${it.line ? lnXml(it.line) : plain ? "" : "<a:ln><a:noFill/></a:ln>"}${shadowXml(it.shadow)}`;
  const empty = `<p:txBody><a:bodyPr rtlCol="0" anchor="ctr"/><a:lstStyle/><a:p><a:endParaRPr lang="${env.lang}"/></a:p></p:txBody>`;
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/>${nv}</p:nvSpPr><p:spPr>${sp}</p:spPr>${it.text ? bodyXml(it.text, env) : empty}</p:sp>`;
}

function picXml(it, id, env) {
  const c = it.crop || {};
  // A negative crop shows the picture short of its frame's edge (under an outline).
  const f = (v) => Math.round(Math.min(0.99, Math.max(-1, v || 0)) * 100000);
  const crop = [c.l, c.t, c.r, c.b].some((v) => f(v) !== 0) ? `<a:srcRect l="${f(c.l)}" t="${f(c.t)}" r="${f(c.r)}" b="${f(c.b)}"/>` : "";
  const alpha = it.alpha ? `<a:alphaModFix amt="${Math.round(it.alpha * 100000)}"/>` : "";
  return (
    `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${esc(it.name || "Picture")} ${id - 1}" descr="${esc(it.alt || "")}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>` +
    `<p:blipFill><a:blip r:embed="${env.image(it)}">${alpha}</a:blip>${crop}<a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
    `<p:spPr>${xfrmXml(it)}${geomXml(it)}${it.line ? lnXml(it.line) : ""}${shadowXml(it.shadow)}</p:spPr></p:pic>`
  );
}

const HEAD = { filled: "triangle", open: "arrow" };

function lineXml(it, id) {
  const size = it.w <= 3 ? ' w="lg" len="lg"' : ' w="med" len="med"';
  // headEnd is the decoration where the line starts, tailEnd where it ends.
  const stroke = (start, end) =>
    lnXml(it, (HEAD[start] ? `<a:headEnd type="${HEAD[start]}"${size}/>` : "") + (HEAD[end] ? `<a:tailEnd type="${HEAD[end]}"${size}/>` : ""));
  const ln = stroke(it.start, it.end);
  const xs = it.pts.map((p) => p[0]), ys = it.pts.map((p) => p[1]);
  const box = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  const name = esc(`${it.name || "Line"} ${id - 1}`);
  const connector = (prst, xfrm, av, l) =>
    `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr>${xfrm}<a:prstGeom prst="${prst}"><a:avLst>${av}</a:avLst></a:prstGeom>${l}</p:spPr></p:cxnSp>`;
  const flat = (a, b) => Math.abs(a[1] - b[1]) < 0.01, upright = (a, b) => Math.abs(a[0] - b[0]) < 0.01;
  let p = it.pts;
  if (p.length === 2) {
    const flips = (p[1][0] < p[0][0] ? ' flipH="1"' : "") + (p[1][1] < p[0][1] ? ' flipV="1"' : "");
    return connector("line", xfrmXml(box, "a:xfrm", flips), "", ln);
  }
  // One corner: PowerPoint's elbow connector runs across, then down. Down-then-across is the
  // same connector drawn from its other end.
  if (p.length === 3 && ((flat(p[0], p[1]) && upright(p[1], p[2])) || (upright(p[0], p[1]) && flat(p[1], p[2])))) {
    let l = ln;
    if (upright(p[0], p[1])) {
      p = [...p].reverse();
      l = stroke(it.end, it.start);
    }
    const flips = (p[2][0] < p[0][0] ? ' flipH="1"' : "") + (p[2][1] < p[0][1] ? ' flipV="1"' : "");
    return connector("bentConnector2", xfrmXml(box, "a:xfrm", flips), "", l);
  }
  // Two corners: across, down, across, with the middle leg at `adj1` of the width. The upright
  // one (down, across, down) is that connector turned a quarter.
  if (p.length === 4 && flat(p[0], p[1]) && upright(p[1], p[2]) && flat(p[2], p[3]) && Math.abs(p[3][0] - p[0][0]) > 0.01) {
    const adj = Math.round(((p[1][0] - p[0][0]) / (p[3][0] - p[0][0])) * 100000);
    const flips = (p[3][0] < p[0][0] ? ' flipH="1"' : "") + (p[3][1] < p[0][1] ? ' flipV="1"' : "");
    return connector("bentConnector3", xfrmXml(box, "a:xfrm", flips), `<a:gd name="adj1" fmla="val ${adj}"/>`, ln);
  }
  if (p.length === 4 && upright(p[0], p[1]) && flat(p[1], p[2]) && upright(p[2], p[3]) && Math.abs(p[3][1] - p[0][1]) > 0.01) {
    const adj = Math.round(((p[1][1] - p[0][1]) / (p[3][1] - p[0][1])) * 100000);
    // Before the quarter turn the box is as wide as the route is tall, about the same centre.
    const turned = { x: box.x + box.w / 2 - box.h / 2, y: box.y + box.h / 2 - box.w / 2, w: box.h, h: box.w, rot: 90 };
    const flips = (p[3][1] < p[0][1] ? ' flipH="1"' : "") + (p[3][0] > p[0][0] ? ' flipV="1"' : "");
    return connector("bentConnector3", xfrmXml(turned, "a:xfrm", flips), `<a:gd name="adj1" fmla="val ${adj}"/>`, ln);
  }
  const W = Math.max(1, emu(box.w)), H = Math.max(1, emu(box.h));
  const pt = (p) => `<a:pt x="${emu(p[0] - box.x)}" y="${emu(p[1] - box.y)}"/>`;
  const path = `<a:moveTo>${pt(it.pts[0])}</a:moveTo>` + it.pts.slice(1).map((p) => `<a:lnTo>${pt(p)}</a:lnTo>`).join("");
  const geom = `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst><a:path w="${W}" h="${H}" fill="none">${path}</a:path></a:pathLst></a:custGeom>`;
  const xfrm = `<a:xfrm><a:off x="${emu(box.x)}" y="${emu(box.y)}"/><a:ext cx="${W}" cy="${H}"/></a:xfrm>`;
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm}${geom}<a:noFill/>${ln}</p:spPr></p:sp>`;
}

function tableXml(it, id, env) {
  const edge = (tag, e) =>
    e
      ? `<${tag} w="${Math.max(1, emu(e.w))}" cap="flat" cmpd="sng" algn="ctr">${solid(e)}<a:prstDash val="${e.dash || "solid"}"/><a:round/><a:headEnd type="none" w="med" len="med"/><a:tailEnd type="none" w="med" len="med"/></${tag}>`
      : `<${tag} w="0"><a:noFill/></${tag}>`;
  const blank = `<a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="${env.lang}"/></a:p></a:txBody>`;
  const rows = it.rows
    .map((row) => {
      const cells = row.cells
        .map((c) => {
          if (c.merged) return `<a:tc hMerge="1">${blank}<a:tcPr/></a:tc>`;
          const b = c.borders || {};
          const ins = c.ins || { l: 0, t: 0, r: 0, b: 0 };
          const text = c.text ? `<a:txBody><a:bodyPr/><a:lstStyle/>${c.text.paras.map((p) => paraXml(p, env)).join("")}</a:txBody>` : blank;
          const pr = `<a:tcPr marL="${pos(ins.l)}" marR="${pos(ins.r)}" marT="${pos(ins.t)}" marB="${pos(ins.b)}" anchor="${c.anchor || "ctr"}">${edge("a:lnL", b.l)}${edge("a:lnR", b.r)}${edge("a:lnT", b.t)}${edge("a:lnB", b.b)}${c.fill ? solid(c.fill) : "<a:noFill/>"}</a:tcPr>`;
          return `<a:tc${c.span > 1 ? ` gridSpan="${c.span}"` : ""}>${text}${pr}</a:tc>`;
        })
        .join("");
      return `<a:tr h="${Math.max(1, emu(row.h))}">${cells}</a:tr>`;
    })
    .join("");
  // Whole EMU columns that add up to the table's width.
  const widths = it.cols.map((w) => Math.max(1, emu(w)));
  return (
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table ${id - 1}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>` +
    `${xfrmXml({ ...it, w: widths.reduce((a, b) => a + b, 0) / EMU, rot: 0 }, "p:xfrm")}` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1"/><a:tblGrid>${widths.map((w) => `<a:gridCol w="${w}"/>`).join("")}</a:tblGrid>${rows}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
  );
}

const GROUP = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

function slideXml(slide, env) {
  let id = 1;
  const shapes = slide.items
    .map((it) => {
      id++;
      if (it.t === "shape") return shapeXml(it, id, env);
      if (it.t === "pic") return it.bytes ? picXml(it, id, env) : "";
      if (it.t === "line") return lineXml(it, id);
      if (it.t === "table") return tableXml(it, id, env);
      return "";
    })
    .join("");
  return `${XML}<p:sld ${NS}><p:cSld name="${esc(slide.id || "")}"><p:bg><p:bgPr>${fillXml(slide.bg)}<a:effectLst/></p:bgPr></p:bg><p:spTree>${GROUP}${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

// ---------- the fixed parts ----------

function themeXml(name, major, minor) {
  const font = (f) => `<a:latin typeface="${esc(f)}"/><a:ea typeface=""/><a:cs typeface=""/>`;
  return `${XML}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="${esc(name)}"><a:themeElements>
<a:clrScheme name="${esc(name)}"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>
<a:fontScheme name="${esc(name)}"><a:majorFont>${font(major)}</a:majorFont><a:minorFont>${font(minor)}</a:minorFont></a:fontScheme>
<a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>
<a:lnStyleLst><a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln><a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln><a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln></a:lnStyleLst>
<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>
</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;
}

const CLRMAP = 'bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"';

function levels(tag, first) {
  let out = "";
  for (let i = 1; i <= 9; i++) out += `<a:lvl${i}pPr marL="0" indent="0" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1">${i === 1 ? first : ""}<a:buNone/><a:defRPr sz="${tag === "title" ? 3200 : 1600}" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+${tag === "title" ? "mj" : "mn"}-lt"/><a:ea typeface="+${tag === "title" ? "mj" : "mn"}-ea"/><a:cs typeface="+${tag === "title" ? "mj" : "mn"}-cs"/></a:defRPr></a:lvl${i}pPr>`;
  return out;
}

function titlePlaceholder(deck, own) {
  const xfrm = own ? `<a:xfrm><a:off x="${emu(128)}" y="${emu(128)}"/><a:ext cx="${emu(deck.w - 256)}" cy="${emu(160)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` : "";
  const body = own
    ? `<a:bodyPr vert="horz" lIns="0" tIns="0" rIns="0" bIns="0" rtlCol="0" anchor="t"><a:noAutofit/></a:bodyPr><a:lstStyle/><a:p><a:r><a:rPr lang="${deck.lang}"/><a:t>Click to edit title</a:t></a:r></a:p>`
    : `<a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="${deck.lang}"/><a:t>Click to edit title</a:t></a:r></a:p>`;
  return `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr>${xfrm}</p:spPr><p:txBody>${body}</p:txBody></p:sp>`;
}

function masterXml(deck) {
  const spacing = '<a:lnSpc><a:spcPct val="100000"/></a:lnSpc><a:spcBef><a:spcPts val="0"/></a:spcBef>';
  return `${XML}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>${GROUP}${titlePlaceholder(deck, true)}</p:spTree></p:cSld><p:clrMap ${CLRMAP}/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/><p:sldLayoutId id="2147483650" r:id="rId2"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle>${levels("title", spacing)}</p:titleStyle><p:bodyStyle>${levels("body", spacing)}</p:bodyStyle><p:otherStyle>${levels("other", "")}</p:otherStyle></p:txStyles></p:sldMaster>`;
}

function layoutXml(deck, titled) {
  return `${XML}<p:sldLayout ${NS} type="${titled ? "titleOnly" : "blank"}" preserve="1"><p:cSld name="${titled ? "Title Only" : "Blank"}"><p:spTree>${GROUP}${titled ? titlePlaceholder(deck, false) : ""}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
}

function notesMasterXml() {
  const ph = (id, name, type, idx, geom) =>
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"${type === "sldImg" ? ' noRot="1" noChangeAspect="1"' : ""}/></p:cNvSpPr><p:nvPr><p:ph type="${type}"${idx ? ` idx="${idx}"` : ""}/></p:nvPr></p:nvSpPr><p:spPr>${geom}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>${type === "sldImg" ? "" : '<p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Click to edit notes</a:t></a:r></a:p></p:txBody>'}</p:sp>`;
  return `${XML}<p:notesMaster ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>${GROUP}${ph(2, "Slide Image Placeholder 1", "sldImg", 2, '<a:xfrm><a:off x="685800" y="1143000"/><a:ext cx="5486400" cy="3086100"/></a:xfrm>')}${ph(3, "Notes Placeholder 2", "body", 3, '<a:xfrm><a:off x="685800" y="4400550"/><a:ext cx="5486400" cy="3600450"/></a:xfrm>')}</p:spTree></p:cSld><p:clrMap ${CLRMAP}/><p:notesStyle>${levels("notes", "")}</p:notesStyle></p:notesMaster>`;
}

function notesXml(notes, lang) {
  const paras = notes.map((t) => `<a:p><a:r><a:rPr lang="${lang}" dirty="0"/><a:t>${esc(t)}</a:t></a:r></a:p>`).join("");
  return `${XML}<p:notes ${NS}><p:cSld><p:spTree>${GROUP}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paras}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`;
}

const rels = (list) =>
  `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.map(([id, type, target, external]) => `<Relationship Id="${id}" Type="${type.startsWith("http") ? type : `${REL}/${type}`}" Target="${esc(target)}"${external ? ' TargetMode="External"' : ""}/>`).join("")}</Relationships>`;

/**
 * deck: { title, lang, w, h, slides, headingFont, bodyFont } where a slide is what extractDeck
 * returned and each picture item carries `bytes` (a Buffer) and `ext` ("png" | "jpeg" | "gif").
 * Returns the zip entries of the .pptx.
 */
export function buildPptx(deck) {
  // PowerPoint proofs text by this tag, and wants a region on English.
  const lang = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(deck.lang || "") && deck.lang.toLowerCase() !== "en" ? deck.lang : "en-US";
  const entries = [];
  const add = (name, data) => entries.push({ name, data });
  const overrides = [];
  const part = (name, type, data) => {
    add(name, data);
    overrides.push(`<Override PartName="/${name}" ContentType="${type}"/>`);
  };

  // Pictures, one file per distinct image.
  const media = new Map();
  const mediaName = (it) => {
    const hash = crypto.createHash("sha1").update(it.bytes).digest("hex");
    if (!media.has(hash)) {
      media.set(hash, `image${media.size + 1}.${it.ext}`);
      add(`ppt/media/${media.get(hash)}`, it.bytes);
    }
    return media.get(hash);
  };

  const anyNotes = deck.slides.some((s) => s.notes && s.notes.length);
  const slideParts = [];
  deck.slides.forEach((slide, i) => {
    const n = i + 1;
    const rl = [["rId1", "slideLayout", `../slideLayouts/slideLayout${slide.items.some((it) => it.title) ? 1 : 2}.xml`]];
    const seen = new Map();
    const ref = (key, type, target, external) => {
      if (!seen.has(key)) {
        seen.set(key, `rId${rl.length + 1}`);
        rl.push([seen.get(key), type, target, external]);
      }
      return seen.get(key);
    };
    const env = {
      lang,
      links: (href) => ref("link:" + href, "hyperlink", href, true),
      image: (it) => {
        const name = mediaName(it);
        return ref("img:" + name, "image", `../media/${name}`);
      },
    };
    const xml = slideXml(slide, env);
    if (slide.notes && slide.notes.length) {
      rl.push([`rId${rl.length + 1}`, "notesSlide", `../notesSlides/notesSlide${n}.xml`]);
      part(`ppt/notesSlides/notesSlide${n}.xml`, `${CT}.notesSlide+xml`, notesXml(slide.notes, lang));
      add(`ppt/notesSlides/_rels/notesSlide${n}.xml.rels`, rels([["rId1", "notesMaster", "../notesMasters/notesMaster1.xml"], ["rId2", "slide", `../slides/slide${n}.xml`]]));
    }
    slideParts.push({ n, xml, rl });
  });
  for (const s of slideParts) {
    part(`ppt/slides/slide${s.n}.xml`, `${CT}.slide+xml`, s.xml);
    add(`ppt/slides/_rels/slide${s.n}.xml.rels`, rels(s.rl));
  }

  const THEME = "application/vnd.openxmlformats-officedocument.theme+xml";
  part("ppt/theme/theme1.xml", THEME, themeXml(deck.title || "Deck", deck.headingFont, deck.bodyFont));
  part("ppt/slideMasters/slideMaster1.xml", `${CT}.slideMaster+xml`, masterXml({ ...deck, lang }));
  add("ppt/slideMasters/_rels/slideMaster1.xml.rels", rels([["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"], ["rId2", "slideLayout", "../slideLayouts/slideLayout2.xml"], ["rId3", "theme", "../theme/theme1.xml"]]));
  part("ppt/slideLayouts/slideLayout1.xml", `${CT}.slideLayout+xml`, layoutXml({ ...deck, lang }, true));
  part("ppt/slideLayouts/slideLayout2.xml", `${CT}.slideLayout+xml`, layoutXml({ ...deck, lang }, false));
  for (const n of [1, 2]) add(`ppt/slideLayouts/_rels/slideLayout${n}.xml.rels`, rels([["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"]]));
  if (anyNotes) {
    part("ppt/theme/theme2.xml", THEME, themeXml("Notes", deck.bodyFont, deck.bodyFont));
    part("ppt/notesMasters/notesMaster1.xml", `${CT}.notesMaster+xml`, notesMasterXml());
    add("ppt/notesMasters/_rels/notesMaster1.xml.rels", rels([["rId1", "theme", "../theme/theme2.xml"]]));
  }

  // The presentation itself.
  const prl = [["rId1", "slideMaster", "slideMasters/slideMaster1.xml"]];
  const ids = slideParts.map((s) => {
    prl.push([`rId${prl.length + 1}`, "slide", `slides/slide${s.n}.xml`]);
    return `<p:sldId id="${255 + s.n}" r:id="rId${prl.length}"/>`;
  });
  let notesRef = "";
  if (anyNotes) {
    prl.push([`rId${prl.length + 1}`, "notesMaster", "notesMasters/notesMaster1.xml"]);
    notesRef = `<p:notesMasterIdLst><p:notesMasterId r:id="rId${prl.length}"/></p:notesMasterIdLst>`;
  }
  for (const [type, file] of [["presProps", "presProps.xml"], ["viewProps", "viewProps.xml"], ["theme", "theme/theme1.xml"], ["tableStyles", "tableStyles.xml"]]) prl.push([`rId${prl.length + 1}`, type, file]);
  part(
    "ppt/presentation.xml",
    `${CT}.presentation.main+xml`,
    `${XML}<p:presentation ${NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>${notesRef}<p:sldIdLst>${ids.join("")}</p:sldIdLst><p:sldSz cx="${emu(deck.w)}" cy="${emu(deck.h)}"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle><a:defPPr><a:defRPr lang="${lang}"/></a:defPPr>${levels("other", "")}</p:defaultTextStyle></p:presentation>`,
  );
  add("ppt/_rels/presentation.xml.rels", rels(prl));
  part("ppt/presProps.xml", `${CT}.presProps+xml`, `${XML}<p:presentationPr ${NS}/>`);
  part("ppt/viewProps.xml", `${CT}.viewProps+xml`, `${XML}<p:viewPr ${NS}/>`);
  part("ppt/tableStyles.xml", `${CT}.tableStyles+xml`, `${XML}<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BB5C7BCD86}"/>`);

  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  part(
    "docProps/core.xml",
    "application/vnd.openxmlformats-package.core-properties+xml",
    `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(deck.title || "")}</dc:title><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`,
  );
  part(
    "docProps/app.xml",
    "application/vnd.openxmlformats-officedocument.extended-properties+xml",
    `${XML}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Microsoft Office PowerPoint</Application><Slides>${deck.slides.length}</Slides></Properties>`,
  );
  add(
    "_rels/.rels",
    rels([
      ["rId1", "officeDocument", "ppt/presentation.xml"],
      ["rId2", "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties", "docProps/core.xml"],
      ["rId3", "extended-properties", "docProps/app.xml"],
    ]),
  );
  const types = `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/>${overrides.join("")}</Types>`;
  return [{ name: "[Content_Types].xml", data: types }, ...entries];
}
