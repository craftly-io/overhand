/**
 * The attention map for the public site (site/pages/index.html): the dashboard's own drawing (`MapSvg` and the worlds),
 * fed a scripted model instead of the daemon's state. site/build.ts bundles this file alone into site/public/map.js,
 * with the app's providers stubbed out, so the landing page loads the map and nothing else of the dashboard.
 */
import { plainWords, worlds } from "@overhand/themes";
import { createRoot } from "react-dom/client";
import { MapSvg } from "./AttentionMap";
import { type Draft, type MapOpen, type MapSector, place } from "./model";
import { WORLDS, type WorldId } from "./worlds";

/** What one map on the page shows. */
export interface Scene {
  world: WorldId;
  /** Drawn on paper, in the world's light set. */
  light: boolean;
  /** Freeze every motion (reduced motion, or off screen). */
  still: boolean;
  projects: readonly { name: string; broken?: boolean; merged?: number }[];
  agents: readonly Draft[];
}

/** The world's own ink and its one colour on `el`, by day or night, so a world looks like itself on any page; whether it's drawn on paper. */
export function paint(el: HTMLElement, world: WorldId, light: boolean): boolean {
  const t = worlds.find((x) => x.world === world);
  if (!t || world === "instrument") {
    for (const k of ["you", "you-fill", "you-ink", "ok", "bad", "background"]) el.style.removeProperty(`--${k}`);
    for (let n = 1; n <= 12; n++) el.style.removeProperty(`--ink-${n}`);
    return light;
  }
  const tokens = light ? t.light : t.tokens;
  (light ? (t.lightInk ?? t.ink) : t.ink)?.forEach((v, i) => {
    el.style.setProperty(`--ink-${i + 1}`, v);
  });
  for (const k of ["you", "you-fill", "you-ink", "ok", "bad", "background"] as const) el.style.setProperty(`--${k}`, tokens[k]);
  return light;
}

/**
 * Mounts a map in `el` and returns the function that shows a scene in it. The map fills the element's smaller side;
 * `onOpen` hears which agent was clicked (an agent's id).
 */
export function mount(el: HTMLElement, onOpen?: (id: string) => void): (s: Scene) => void {
  const root = createRoot(el);
  let scene: Scene | null = null;
  let size = 0;
  const draw = () => {
    if (!scene || !size) return;
    const light = paint(el, scene.world, scene.light);
    const n = Math.max(1, scene.projects.length);
    const sectors: MapSector[] = scene.projects.map((p, i) => ({
      name: p.name,
      a0: (i * 360) / n,
      span: 360 / n,
      merged: p.merged ?? 0,
      broken: Boolean(p.broken),
    }));
    const model = { waiting: scene.agents.filter((a) => a.state === "waiting").length, sectors, ...place(sectors, scene.agents) };
    el.dataset.light = light ? "" : undefined;
    root.render(
      <MapSvg
        model={model}
        size={size}
        world={WORLDS[scene.world]}
        light={light}
        still={scene.still}
        w={plainWords}
        onOpen={(o: MapOpen) => onOpen?.(o.kind === "crew" ? o.project : o.key)}
      />,
    );
  };
  new ResizeObserver(() => {
    // layout px, not the zoomed box (site.css zooms the column on very wide screens), so names keep their size
    const next = Math.min(el.offsetWidth, el.offsetHeight);
    if (next === size) return;
    size = next;
    draw();
  }).observe(el);
  return (s) => {
    scene = s;
    draw();
  };
}
