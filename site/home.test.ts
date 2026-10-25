import { afterAll, beforeAll, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

/**
 * The home page's own script (site/home.ts): the live window swaps in only when the demo says it's ready, the arrival
 * is asked for once, sections enter once, and the copy buttons say so.
 */
type Home = typeof import("./home");
let home: Home;
let reduce = false;
type Seen = (entries: { target: Element; isIntersecting: boolean; intersectionRatio?: number }[]) => void;
const seen: Seen[] = [];
/** Every observer made, with its options: pieces.js keeps three (near, far, half on screen). */
const observers: { fire: Seen; opts: IntersectionObserverInit | undefined }[] = [];

beforeAll(async () => {
  GlobalRegistrator.register();
  // nothing is idle in a test: run the idle work at once
  Object.assign(globalThis, {
    requestIdleCallback: (f: () => void) => setTimeout(f, 0),
    matchMedia: (q: string) => ({ matches: q.includes("reduce") && reduce, media: q }),
    IntersectionObserver: class {
      constructor(f: Seen, opts?: IntersectionObserverInit) {
        seen.push(f);
        observers.push({ fire: f, opts });
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
  home = await import("./home");
});
afterAll(() => GlobalRegistrator.unregister());
beforeEach(() => {
  reduce = false;
  seen.length = 0;
  observers.length = 0;
  document.body.innerHTML = "";
});

/** A window like the page's: the frame (its src held back; kept off the document, which can't load frames) and the loading line. */
function page() {
  document.body.innerHTML = `<p id="loading">Loading Overhand on sample data…</p>`;
  const frame = document.createElement("iframe");
  frame.dataset.src = "about:blank";
  const loading = document.getElementById("loading") as HTMLElement;
  const posted: unknown[] = [];
  // the frame's window: any message source will do, so a port stands in for it and keeps what's posted
  const win = new MessageChannel().port1;
  win.postMessage = (m: unknown, to: unknown) => {
    // the demo is on this origin: nothing is posted anywhere else
    expect(to).toBe(location.origin);
    posted.push(m);
  };
  Object.defineProperty(frame, "contentWindow", { value: win });
  const ready = (origin = location.origin) =>
    dispatchEvent(new MessageEvent("message", { data: { type: "overhand:ready" }, source: win, origin }));
  return { frame, loading, posted, ready, win };
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("until the demo says it's ready, the loading line stays and nothing is posted", async () => {
  const p = page();
  home.swapWhenReady(p.frame, p.loading, { reduced: false, delay: 5 });
  await wait(30);
  expect(p.frame.getAttribute("src")).toBe("about:blank");
  expect(p.frame.classList.contains("ready")).toBe(false);
  expect(p.loading.hidden).toBe(false);
  expect(p.loading.classList.contains("gone")).toBe(false);
  expect(p.posted).toEqual([]);
});

test("on ready it fades the frame in, hides the loading line and asks for the arrival once, after the delay", async () => {
  const p = page();
  const onReady = mock(() => {});
  home.swapWhenReady(p.frame, p.loading, { reduced: false, delay: 20, onReady });
  await wait(5);
  p.ready();
  expect(p.frame.classList.contains("ready")).toBe(true);
  expect(p.loading.classList.contains("gone")).toBe(true);
  expect(onReady).toHaveBeenCalledTimes(1);
  expect(p.posted).toEqual([]);
  await wait(40);
  // faded, the loading line has left the page
  expect(p.loading.hidden).toBe(true);
  // a second ready (the demo reloads) never asks again
  p.ready();
  await wait(40);
  expect(p.posted).toEqual([{ type: "overhand:arrive" }]);
});

test("a message from anything but the demo changes nothing", async () => {
  const p = page();
  home.swapWhenReady(p.frame, p.loading, { reduced: false, delay: 5 });
  dispatchEvent(new MessageEvent("message", { data: { type: "overhand:ready" }, source: null }));
  await wait(20);
  expect(p.frame.classList.contains("ready")).toBe(false);
  expect(p.posted).toEqual([]);
});

test("a ready from another origin changes nothing", async () => {
  const p = page();
  home.swapWhenReady(p.frame, p.loading, { reduced: false, delay: 5 });
  p.ready("https://evil.example");
  await wait(20);
  expect(p.frame.classList.contains("ready")).toBe(false);
  expect(p.posted).toEqual([]);
});

test("under reduced motion it swaps in and asks for nothing", async () => {
  const p = page();
  home.swapWhenReady(p.frame, p.loading, { reduced: true, delay: 5 });
  await wait(5);
  p.ready();
  await wait(30);
  expect(p.frame.classList.contains("ready")).toBe(true);
  expect(p.posted).toEqual([]);
});

test("enterOnce adds .in once and never takes it away", async () => {
  document.body.innerHTML = `<p class="enter">a</p><p class="enter">b</p>`;
  const els = [...document.querySelectorAll(".enter")];
  home.enterOnce(els);
  const fire = seen.at(-1);
  if (!fire || !els[0] || !els[1]) throw new Error("no observer");
  fire([{ target: els[0], isIntersecting: true }]);
  expect(els[0].classList.contains("in")).toBe(true);
  expect(els[1].classList.contains("in")).toBe(false);
  fire([{ target: els[0], isIntersecting: false }]);
  expect(els[0].classList.contains("in")).toBe(true);
});

test("under reduced motion enterOnce adds nothing (the CSS shows the final state)", () => {
  reduce = true;
  document.body.innerHTML = `<p class="enter">a</p>`;
  const els = [...document.querySelectorAll(".enter")];
  home.enterOnce(els);
  expect(seen).toHaveLength(0);
  expect(els[0]?.classList.contains("in")).toBe(false);
});

test("a copy button copies its text and says Copied for two seconds", async () => {
  document.body.innerHTML = `<button>Copy</button>`;
  const btn = document.querySelector("button") as HTMLButtonElement;
  const wrote: string[] = [];
  Object.defineProperty(navigator, "clipboard", { value: { writeText: async (t: string) => void wrote.push(t) }, configurable: true });
  home.copyButton(btn, "curl -fsSL get.overhand.dev | sh", 20);
  btn.click();
  await wait(1);
  expect(wrote).toEqual(["curl -fsSL get.overhand.dev | sh"]);
  expect(btn.textContent).toBe("Copied");
  await wait(40);
  expect(btn.textContent).toBe("Copy");
  expect(btn.getAttribute("aria-live")).toBe("polite");
});

test("a copy the browser refuses never says Copied", async () => {
  document.body.innerHTML = `<button>Copy</button>`;
  const btn = document.querySelector("button") as HTMLButtonElement;
  Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => Promise.reject(new Error("no")) }, configurable: true });
  home.copyButton(btn, "x", 20);
  btn.click();
  await wait(5);
  expect(btn.textContent).toBe("Copy");
});

/**
 * The site's live pieces (public/pieces.js, run as the page runs it): each frame is asked to play its moment once, when
 * it has said it's ready and half of it is on screen; never under reduced motion; framed again, it opens at the end.
 */
async function piecesPage() {
  document.body.innerHTML = `<div class="piece" data-piece="needs" data-max="3"></div><div class="piece" data-piece="rules"></div>`;
  new Function(await Bun.file(new URL("./public/pieces.js", import.meta.url)).text())();
  const els = [...document.querySelectorAll<HTMLElement>("[data-piece]")];
  const by = (pick: (o: IntersectionObserverInit | undefined) => boolean) => {
    const o = observers.find((x) => pick(x.opts));
    if (!o) throw new Error("pieces.js made no such observer");
    // how much of it is on screen: all of it when it's in, unless the test says less
    return (el: Element, on: boolean, ratio = on ? 1 : 0) => o.fire([{ target: el, isIntersecting: on, intersectionRatio: ratio }]);
  };
  const near = by((o) => o?.rootMargin === "150px 0px");
  const far = by((o) => o?.rootMargin === "250px 0px");
  const half = by((o) => o?.threshold === 0.5);
  const posted = new Map<Element, unknown[]>();
  // a frame comes near, gets a window that keeps what it's sent, and can say it's ready
  const mount = (el: HTMLElement) => {
    near(el, true);
    const f = el.querySelector("iframe");
    if (!f) throw new Error("no frame");
    const win = new MessageChannel().port1;
    const got: unknown[] = [];
    win.postMessage = (m: unknown, to: unknown) => {
      expect(to).toBe(location.origin);
      got.push(m);
    };
    Object.defineProperty(f, "contentWindow", { value: win });
    posted.set(el, got);
    return {
      f,
      ready: (origin = location.origin) =>
        dispatchEvent(new MessageEvent("message", { data: { type: "overhand:ready" }, source: win, origin })),
      /** The piece says how tall it is. */
      tall: (h: number) =>
        dispatchEvent(new MessageEvent("message", { data: { type: "overhand:piece", h }, source: win, origin: location.origin })),
    };
  };
  return { els, mount, far, half, posted };
}

test("the page asks each piece to play once, when it is ready and half on screen", async () => {
  const p = await piecesPage();
  const [a, b] = p.els;
  if (!a || !b) throw new Error("no pieces");
  const fa = p.mount(a);
  const fb = p.mount(b);
  fa.ready();
  fb.ready();
  expect(p.posted.get(a)).toEqual([]);
  p.half(a, true);
  p.half(a, true);
  fa.ready();
  expect(p.posted.get(a)).toEqual([{ type: "overhand:play" }]);
  // the other piece hasn't been half on screen yet
  expect(p.posted.get(b)).toEqual([]);
  // let go and framed again, the played piece opens at its end and is never asked again
  p.far(a, false);
  const again = p.mount(a);
  expect(again.f.getAttribute("src")).toContain("p=needs&max=3&after");
  again.ready();
  expect(p.posted.get(a)).toEqual([]);
  expect(b.querySelector("iframe")?.getAttribute("src")).not.toContain("after");
});

test("a piece's ready from another origin plays nothing", async () => {
  const p = await piecesPage();
  const [a] = p.els;
  if (!a) throw new Error("no piece");
  const fa = p.mount(a);
  p.half(a, true);
  fa.ready("https://evil.example");
  expect(p.posted.get(a)).toEqual([]);
  fa.ready();
  expect(p.posted.get(a)).toEqual([{ type: "overhand:play" }]);
});

test("under reduced motion the page never asks a piece to play", async () => {
  reduce = true;
  const p = await piecesPage();
  const [a] = p.els;
  if (!a) throw new Error("no piece");
  const fa = p.mount(a);
  fa.ready();
  p.half(a, true);
  expect(p.posted.get(a)).toEqual([]);
});

test("a piece only starting to show isn't half on screen: it plays when half of it is", async () => {
  const p = await piecesPage();
  const [a] = p.els;
  if (!a) throw new Error("no piece");
  const fa = p.mount(a);
  fa.ready();
  // the browser tells the page as soon as any of it shows
  p.half(a, true, 0.1);
  expect(p.posted.get(a)).toEqual([]);
  p.half(a, true, 0.5);
  expect(p.posted.get(a)).toEqual([{ type: "overhand:play" }]);
});

test("a piece is a short slice whose frame fits it exactly, however tall: nothing scrolls inside", async () => {
  const p = await piecesPage();
  const [a, b] = p.els;
  if (!a || !b) throw new Error("no pieces");
  const fa = p.mount(a);
  // the slice is asked for by count, and only where the page says so
  expect(fa.f.getAttribute("src")).toContain("p=needs&max=3");
  expect(p.mount(b).f.getAttribute("src")).not.toContain("max=");
  for (const h of [240, 1800]) {
    fa.tall(h);
    expect(fa.f.style.height).toBe(`${h}px`);
    expect(fa.f.getAttribute("scrolling")).toBe("no");
  }
  expect(a.dataset.ready).toBe("");
});

test("under each piece, one quiet link to all of it in the live demo", async () => {
  const p = await piecesPage();
  for (const el of p.els) {
    const links = el.querySelectorAll("a.more");
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toMatch(/#try$/);
    expect(links[0]?.textContent).toBe("See it all in the live demo →");
    // the frame goes in above it, and comes and goes without moving it
    p.mount(el);
    expect(el.lastElementChild?.matches("a.more")).toBe(true);
  }
});

test("the live window's zoom toward Needs you follows the scroll in CSS only, never on a phone or under reduced motion", async () => {
  const page = await Bun.file(new URL("./pages/index.html", import.meta.url)).text();
  const css = await Bun.file(new URL("./public/site.css", import.meta.url)).text();
  const zoom = page.match(/@supports \(animation-timeline: view\(\)\) \{\s*@media ([^{]+)\{([^}]+\}){2}/);
  expect(zoom?.[1]?.trim()).toBe("(min-width: 820px) and (prefers-reduced-motion: no-preference)");
  // the only place an animation is set on the zoom, and it moves one transform
  expect(page.match(/\.zoom \{[^}]*animation:/g)).toHaveLength(1);
  expect(page).toMatch(/@keyframes zoom-in \{ to \{ transform: scale\(var\(--m-zoom\)\); \} \}/);
  // and the site's own rule stops every animation under reduced motion
  expect(css).toMatch(/prefers-reduced-motion: reduce\) \{ \*, \*::before, \*::after \{[^}]*animation: none !important/);
});

test("the zoom aims at the middle of the demo's Needs you, at the window's scale", () => {
  document.body.innerHTML = `<div id="window"></div>`;
  const win = document.getElementById("window") as HTMLElement;
  const doc = document.implementation.createHTMLDocument("demo");
  doc.body.innerHTML = `<section class="hud-pane"><h2>Needs you, in words</h2></section><section class="hud-pane" id="n" data-id="needs"><h2>Needs you 13</h2></section>`;
  const pane = doc.getElementById("n") as HTMLElement;
  pane.getBoundingClientRect = () => ({ left: 80, top: 500, width: 300, height: 400 }) as DOMRect;
  const frame = document.createElement("iframe");
  Object.defineProperty(frame, "contentDocument", { value: doc });
  home.zoomOrigin(win, frame, 0.5);
  expect(win.style.getPropertyValue("--zx")).toBe("115px");
  expect(win.style.getPropertyValue("--zy")).toBe("350px");
  // until the demo has drawn it, the CSS's own guess holds
  const empty = document.createElement("iframe");
  Object.defineProperty(empty, "contentDocument", { value: document.implementation.createHTMLDocument("x") });
  const fresh = document.createElement("div");
  home.zoomOrigin(fresh, empty, 1);
  expect(fresh.style.getPropertyValue("--zx")).toBe("");
});

test("one focus at a time: a piece due while another's holds waits --m-hold, then plays", async () => {
  document.documentElement.style.setProperty("--m-hold", "30ms");
  try {
    const p = await piecesPage();
    const [a, b] = p.els;
    if (!a || !b) throw new Error("no pieces");
    const fa = p.mount(a);
    const fb = p.mount(b);
    fa.ready();
    fb.ready();
    // side by side, both are half on screen at once
    p.half(a, true);
    p.half(b, true);
    expect(p.posted.get(a)).toEqual([{ type: "overhand:play" }]);
    expect(p.posted.get(b)).toEqual([]);
    await wait(10);
    expect(p.posted.get(b)).toEqual([]);
    await wait(40);
    expect(p.posted.get(b)).toEqual([{ type: "overhand:play" }]);
    expect(p.posted.get(a)).toEqual([{ type: "overhand:play" }]);
  } finally {
    document.documentElement.style.removeProperty("--m-hold");
  }
});

test("each review piece's frame title names what the short review shows: why it waits, the preview, the checks before merging, the proof", async () => {
  for (const page of ["makers", "studios"]) {
    const html = await Bun.file(new URL(`./pages/for/${page}.html`, import.meta.url)).text();
    const title = html.match(/data-piece="review"[^>]*data-title="([^"]+)"/)?.[1] ?? "";
    for (const part of ["why it waits", "preview", "before merging", "proof"]) expect(title, `${page}: ${part}`).toContain(part);
    // and nothing the short review leaves out
    for (const gone of ["diff", "summary"]) expect(title, `${page}: ${gone}`).not.toContain(gone);
  }
});

test("Tab passes the live demo by, and its button takes the keyboard in, to the demo's first control", async () => {
  const html = await Bun.file(new URL("./pages/index.html", import.meta.url)).text();
  expect(html).toMatch(/<iframe id="demo" tabindex="-1"/);
  expect(html.indexOf('id="enter-demo"')).toBeLessThan(html.indexOf('id="demo"'));
  const frame = document.createElement("iframe");
  const button = document.createElement("button");
  document.body.append(button, frame);
  // the demo's own page (happy-dom loads no frames)
  const demo = document.implementation.createHTMLDocument("demo");
  demo.body.innerHTML = '<p>Night report</p><button disabled>Off</button><a href="#main">Skip to content</a>';
  Object.defineProperty(frame, "contentDocument", { get: () => demo });
  let focused = "";
  for (const el of demo.querySelectorAll<HTMLElement>("a, button")) el.focus = () => (focused = el.textContent ?? "");
  home.enterDemo(button, frame);
  button.click();
  expect(focused).toBe("Skip to content");
});
