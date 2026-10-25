/**
 * The layout system's one rule the components can't say in CSS: the views that dock beside Now on wide screens. Pure,
 * so it can be tested; DrawerHost and App apply it.
 */

/** From this viewport width (CSS px, the `3xl` breakpoint) a view docks beside Now instead of covering it. */
const DOCK_FROM = 2200;

/** A view that docks beside Now on a wide screen instead of covering it. */
export type Dockable = "work" | "crew" | "health" | "settings";

/**
 * From `3xl` a view opens as a side panel docked beside Now, Now still in view: its width in CSS px, or 0 where it
 * opens as a drawer over Now. Work is wider, so the pipeline and Yours fit side by side, but always leaves Now at least
 * 960px.
 */
export function dockWidth(place: Dockable, viewport: number): number {
  if (viewport < DOCK_FROM) return 0;
  return place === "work" ? Math.min(1600, viewport - 960) : 768;
}
