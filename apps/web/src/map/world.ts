/**
 * The world contract: everything a world changes about the attention map. The map itself (rings, sectors, layout,
 * motion, labels, keyboard) is one component; a world only draws its ground, your centre, a character for each agent,
 * a companion for each subagent, and says how its rings look. Palette A holds in every world: ink first, and the one
 * colour (`--you-fill`) only for what waits on you.
 */
import type { ReactNode } from "react";
import type { MapAgent, MapModel } from "./model";

/** What a world draws with. */
export interface WorldCtx {
  model: MapModel;
  /** Map units per CSS pixel: multiply a pixel size by it to draw at that size whatever the map's size. */
  k: number;
  /** An agent's size in map units (its character is drawn about this big across), the spec's `u`. */
  u: number;
  /** Full detail, or the small map (a phone): no subagent dots, no hover-only marks. */
  lod: "small" | "full";
  /** Drawn on paper (light appearance). */
  light: boolean;
  /** An id prefix for this map's defs, so two maps on a page never share a gradient. */
  id: string;
  /** The theme's word for you, under the centre. */
  you: string;
}

export interface World {
  id: string;
  /** Behind the rings: the world's floor, light and atmosphere. Drawn once per change, on a layer of its own. */
  ground: (c: WorldCtx) => ReactNode;
  /** You, at the centre, with the count of what waits on you. */
  centre: (c: WorldCtx) => ReactNode;
  /** One agent, drawn round the origin, about `u` across. */
  character: (a: MapAgent, c: WorldCtx) => ReactNode;
  /** One subagent, the `i`th of its parent `a`, drawn round the origin, a few px across. */
  companion: (a: MapAgent, i: number, c: WorldCtx) => ReactNode;
  /**
   * Points a long character covers besides its centre (a comet's tail, a train's ends, a fish's head and tail),
   * relative to it in map units, so the names placed round it keep clear of all of it.
   */
  reach?: (a: MapAgent, c: WorldCtx) => [number, number][];
  /**
   * A project's own place, drawn round the origin about 70 units across, for the field (Now on a computer), where each
   * project sits under its name: a cushion, a lily pad, a station, a constellation. Absent: the world draws none.
   */
  hub?: (p: { name: string; index: number; broken: boolean; merged: number }, c: WorldCtx) => ReactNode;
  /** Where the `i`th subagent of `a` sits, relative to `a`, in map units. */
  orbit?: (a: MapAgent, i: number, c: WorldCtx) => [number, number];
  /** What the world draws with, once per map: gradients and patterns (the map's one atlas, in its <defs>). */
  atlas: (c: WorldCtx) => ReactNode;
  /** How the ring borders are drawn. */
  rings: "line" | "dash" | "faint" | "none";
  /** The dial's tick marks round the outer ring. */
  ticks: boolean;
  /** What runs between you and a working agent: a hairline with a staggered pulse, a short trail behind it, or nothing. */
  links: "pulse" | "trail" | "none";
  /** Agents are drawn larger (fish, trains): a little more room each. */
  big?: boolean;
  /** Moves agents and crews where the world puts them (Transit: along each project's line). */
  place?: (m: MapModel) => MapModel;
  /**
   * A thin GPU layer under the map for the world's atmosphere (`atmosphere.ts`): the night sky or the water. Its 2D
   * stand-in is the ground's `.ground-2d` group, hidden while the GPU layer draws.
   */
  atmosphere?: "sky" | "water";
}

/** A repeatable 0…1 from a string (FNV-1a), so a name looks the same tomorrow. */
export function seed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

/** A repeatable 0…1 from an integer, for stars and pads that stay where they are. */
export function hash(n: number): number {
  const x = Math.sin(n * 91.7 + 13.1) * 43758.5453;
  return x - Math.floor(x);
}

/** Many small dots as one path (a dot is two arcs), so a field of hundreds costs one element. */
export function dots(list: readonly (readonly [number, number, number])[]): string {
  return list.map(([x, y, r]) => `M${(x - r).toFixed(1)} ${y.toFixed(1)}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`).join("");
}
