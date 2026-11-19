// A headless Chrome driven over the DevTools protocol, with nothing to install:
// the preview and the PowerPoint export both lay a deck out in it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";

export function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const mac = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  ];
  for (const p of mac) if (fs.existsSync(p)) return p;
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"]) {
    try {
      return execFileSync("which", [name], { encoding: "utf8" }).trim();
    } catch {}
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launch() {
  const bin = findChrome();
  if (!bin) throw new Error("No Chrome/Chromium found. Install Chrome or set CHROME_PATH.");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "deck-preview-"));
  const proc = spawn(
    bin,
    ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", "--mute-audio", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"],
    { stdio: "ignore" },
  );
  const portFile = path.join(profile, "DevToolsActivePort");
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await sleep(100);
  if (!fs.existsSync(portFile)) throw new Error("Chrome did not start.");
  const port = fs.readFileSync(portFile, "utf8").split("\n")[0].trim();
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === "page");
    } catch {}
    if (!target) await sleep(100);
  }
  if (!target) throw new Error("No Chrome page to drive.");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const pending = new Map();
  const waiters = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) {
      const { resolve, reject } = pending.get(d.id);
      pending.delete(d.id);
      d.error ? reject(new Error(d.error.message)) : resolve(d.result);
    } else if (d.method) {
      for (const w of waiters.splice(0)) (w.method === d.method ? w.resolve : () => waiters.push(w))(d.params);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      pending.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  const once = (method) => new Promise((resolve) => waiters.push({ method, resolve }));
  const close = () => {
    try {
      ws.close();
    } catch {}
    proc.kill();
    setTimeout(() => fs.rmSync(profile, { recursive: true, force: true }), 300);
  };
  return { send, once, close };
}

export async function evaluate(send, expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

/** Open a deck's every-slide page at the slide's own size and wait for fonts and pictures. */
export async function openDeck({ send, once }, port, { w, h }, { basicFonts = false } = {}) {
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
  const loaded = once("Page.loadEventFired");
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/deck/?mode=all${basicFonts ? "&fonts=basic" : ""}` });
  await loaded;
  // The finished look: every step shown, animations at their end, no transitions.
  await evaluate(
    send,
    `(async () => {
      await (window.__deckReady || Promise.resolve());
      const s = document.createElement("style");
      s.textContent = "*,*::before,*::after{transition:none!important}";
      document.head.appendChild(s);
      document.querySelectorAll(".fragment").forEach((e) => e.classList.add("visible"));
      document.getAnimations().forEach((a) => { try { a.finish(); } catch { a.cancel(); } });
      document.querySelectorAll("svg").forEach((s) => s.pauseAnimations && s.pauseAnimations());
      await new Promise((r) => setTimeout(r, 150));
      return true;
    })()`,
  );
}

/**
 * Scroll the page so that y is at the top of the window, and let it paint. Chrome leaves a
 * sandboxed frame (an <x-embed>) blank in a screenshot while it is off screen.
 */
export async function scrollTo(send, y) {
  await evaluate(
    send,
    `(async () => {
      window.scrollTo(0, ${Math.max(0, Math.floor(y))});
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      if (document.querySelector("x-embed iframe")) await new Promise((r) => setTimeout(r, 120));
    })()`,
  );
}
