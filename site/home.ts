// The site's script, bundled to public/home.js by site/build.ts. On the home page: the live window (the real Overhand on sample data,
// apps/web's demo) swaps in once it says it's ready and plays its one arrival; section text enters once; the copy
// buttons copy. Only the live window's zoom toward Needs you follows the scroll, in CSS (index.html); this script only
// tells it where Needs you is. Under reduced motion nothing moves and the demo opens at its end.

/** How the live window swaps in. */
export interface SwapOptions {
  /** Reduced motion: never ask for the arrival (the demo then opens at the morning on its own). */
  reduced: boolean;
  /** How long after ready the arrival is asked for, in ms. */
  delay: number;
  /** Called once, when the demo first says it's ready. */
  onReady?: () => void;
}

/**
 * Loads the demo into `frame` when the page is idle (its URL waits in `data-src`), and when it posts `overhand:ready`
 * fades the frame in and the loading line out (opacity only, so nothing moves) and, unless reduced, posts
 * `overhand:arrive` once after `delay`. Until then the loading line stays and nothing is posted.
 */
export function swapWhenReady(frame: HTMLIFrameElement, loading: HTMLElement, opts: SwapOptions): void {
  let ready = false;
  addEventListener("message", (e: MessageEvent) => {
    if (ready || e.origin !== location.origin || e.source === null || e.source !== frame.contentWindow) return;
    if (typeof e.data !== "object" || e.data === null || e.data.type !== "overhand:ready") return;
    ready = true;
    frame.classList.add("ready");
    loading.classList.add("gone");
    // once it has faded, the loading line leaves the page (and the accessibility tree)
    const fade = Number.parseFloat(getComputedStyle(loading).getPropertyValue("--m-base")) || 0;
    setTimeout(
      () => {
        loading.hidden = true;
      },
      opts.reduced ? 0 : fade,
    );
    opts.onReady?.();
    if (!opts.reduced) setTimeout(() => frame.contentWindow?.postMessage({ type: "overhand:arrive" }, location.origin), opts.delay);
  });
  const load = () => {
    const src = frame.dataset.src;
    if (src) frame.src = src;
  };
  if (typeof requestIdleCallback === "function") requestIdleCallback(load, { timeout: 1500 });
  else setTimeout(load, 1500);
}

/** Adds `.in` to each element the first time it scrolls into view, and never takes it away; under reduced motion it does nothing and the CSS shows the final state. */
export function enterOnce(els: Element[]): void {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || !els.length) return;
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add("in");
        io.unobserve(e.target);
      }
    },
    { rootMargin: "0px 0px -10% 0px" },
  );
  for (const el of els) io.observe(el);
}

/**
 * Copies `text` when `btn` is pressed; once the copy has worked the button says "Copied" for `ms` (2 s) at its own width,
 * announced politely, then its own label again. A copy the browser refuses changes nothing.
 */
export function copyButton(btn: HTMLButtonElement, text: string, ms = 2000): void {
  const label = btn.textContent ?? "Copy";
  btn.setAttribute("aria-live", "polite");
  let timer: ReturnType<typeof setTimeout> | undefined;
  btn.addEventListener("click", () => {
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        // keep the button's width while it says "Copied", so nothing beside it moves
        btn.style.minWidth = `${btn.offsetWidth}px`;
        btn.textContent = "Copied";
        clearTimeout(timer);
        timer = setTimeout(() => {
          btn.textContent = label;
        }, ms);
      })
      .catch(() => {});
  });
}

/**
 * The live window: the real app 900px tall, scaled to the page's width but never below 3/4, so its words stay readable;
 * a narrower window lays the app out narrower instead (--w). Under 820px wide it shows its own phone layout.
 */
function fit(win: HTMLElement, frame: HTMLIFrameElement): () => void {
  const set = () => {
    const w = win.clientWidth;
    const s = innerWidth < 820 ? 1 : Math.min(1, Math.max(0.75, w / 1440));
    win.style.setProperty("--s", String(s));
    win.style.setProperty("--w", `${Math.round(w / s)}px`);
    zoomOrigin(win, frame, s);
  };
  set();
  new ResizeObserver(set).observe(win);
  return set;
}

/**
 * Where the live window zooms toward as it scrolls away (index.html, `.zoom`): the middle of the demo's Needs you, in
 * the window's px (`--zx`, `--zy`), the demo drawn at scale `s`. Until the demo has drawn it, the CSS's own guess holds.
 */
export function zoomOrigin(win: HTMLElement, frame: HTMLIFrameElement, s: number): void {
  const pane = frame.contentDocument?.querySelector('[data-id="needs"]');
  if (!pane) return;
  const r = pane.getBoundingClientRect();
  win.style.setProperty("--zx", `${Math.round((r.left + r.width / 2) * s)}px`);
  win.style.setProperty("--zy", `${Math.round((r.top + r.height / 2) * s)}px`);
}

/** The guided steps: each points at the real control inside the live window and rings it once. */
function guide(frame: HTMLIFrameElement, buttons: HTMLButtonElement[], reduced: boolean): () => void {
  const doc = () => frame.contentDocument;
  const find = (sel: string, text?: string): HTMLElement | undefined =>
    [...(doc()?.querySelectorAll<HTMLElement>(sel) ?? [])].find((e) => !text || e.textContent?.includes(text));
  const ring = (el: HTMLElement | undefined) => {
    const d = doc();
    if (!el || !d) return;
    const css = getComputedStyle(d.documentElement);
    const you = css.getPropertyValue("--you-fill").trim();
    // bring it into view inside the window only: scrollIntoView also scrolls this page, so the page goes back
    const y = scrollY;
    el.scrollIntoView({ block: "center" });
    scrollTo(0, y);
    const slow = Number.parseFloat(css.getPropertyValue("--m-slow")) || 0;
    if (reduced) {
      // no motion: a still ring for a moment
      el.style.outline = `3px solid ${you}`;
      el.style.outlineOffset = "4px";
      setTimeout(() => {
        el.style.outline = "";
        el.style.outlineOffset = "";
      }, slow * 4);
      return;
    }
    el.animate(
      [
        { outline: `3px solid ${you}`, outlineOffset: "4px" },
        { outline: "3px solid transparent", outlineOffset: "10px" },
      ],
      {
        duration: slow * 2,
        iterations: 2,
      },
    );
  };
  const quick = () => {
    if (!find('[data-slot="popover-content"]')) find('[aria-label="Quick settings"]')?.click();
  };
  const later = (f: () => void) => setTimeout(f, 250);
  const steps: Record<string, () => void> = {
    answer: () => ring(find("button", "Answer:") ?? find("button", "Answer")),
    rules: () => {
      quick();
      later(() => ring(find("label", "Booking app")?.querySelector<HTMLElement>("select") ?? undefined));
    },
    quiet: () => {
      quick();
      later(() => ring(find('[aria-label="Quiet mode"]')));
    },
  };
  for (const b of buttons)
    b.addEventListener("click", () => {
      if (b.getAttribute("aria-disabled") === "true") return;
      for (const o of buttons) o.setAttribute("aria-pressed", String(o === b));
      steps[b.dataset.try ?? ""]?.();
    });
  // ready: the steps work, and no longer point at the loading line
  return () => {
    for (const b of buttons) {
      b.removeAttribute("aria-disabled");
      b.removeAttribute("aria-describedby");
    }
  };
}

/**
 * The button that takes the keyboard into the live demo, which Tab otherwise passes by: focus goes to the demo's first
 * control (the frame itself while it's still loading), and Tab carries on inside it, then back out to the page.
 */
export function enterDemo(button: HTMLElement, frame: HTMLIFrameElement): void {
  button.addEventListener("click", () => {
    const first = frame.contentDocument?.querySelector<HTMLElement>("a[href], button:not(:disabled), input, select, textarea");
    frame.contentWindow?.focus();
    if (first) first.focus();
    else frame.focus();
  });
}

const frame = document.getElementById("demo");
const loading = document.getElementById("loading");
const enter = document.getElementById("enter-demo");
if (frame instanceof HTMLIFrameElement && enter) enterDemo(enter, frame);
const win = document.getElementById("window");
if (frame instanceof HTMLIFrameElement && loading && win) {
  const refit = fit(win, frame);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const steps = guide(frame, [...document.querySelectorAll<HTMLButtonElement>("button[data-try]")], reduced);
  const onReady = () => {
    steps();
    refit();
  };
  swapWhenReady(frame, loading, { reduced, delay: 1200, onReady });
}
// on every page that loads this script: section text waits to enter only once it runs (without it, everything is
// simply there), and the copy buttons copy
document.documentElement.classList.add("js");
enterOnce([...document.querySelectorAll(".enter")]);
for (const b of document.querySelectorAll<HTMLButtonElement>("button[data-copy]")) {
  const src = document.getElementById(b.dataset.copy ?? "");
  if (src?.textContent) copyButton(b, src.textContent.replace(/\s+/g, " ").trim());
}
