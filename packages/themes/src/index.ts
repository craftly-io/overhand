import catnap from "./catnap";
import type { ThemeDefinition } from "./define";
import koi from "./koi";
import observatory from "./observatory";
import overhand from "./overhand";
import transit from "./transit";

export {
  defineTheme,
  fromInk,
  type InkState,
  type ThemeDefinition,
  type ThemeFonts,
  TOKEN_KEYS,
  type TokenKey,
  type Tokens,
} from "./define";
export { day as dayInk, night as nightInk, you } from "./overhand/palette";
export { FLAVOUR_KEYS, placeholders, plainWords, type WordKey, type Words } from "./words";

/** Every first-party world, Instrument (the house theme and the default) first. */
export const allWorlds: readonly ThemeDefinition[] = [overhand, observatory, transit, koi, catnap];

/** The looks people can pick, in order: the picker, the command bar and the share card. Every world is offered. */
export const worlds: readonly ThemeDefinition[] = allWorlds;

/** Every theme a browser can be on: the offered worlds. */
export const themes: readonly ThemeDefinition[] = worlds;

/**
 * The theme with this id, or Instrument when there's none. That fallback is also the migration: the house theme's
 * earlier id ("plain") and the retired worlds (Nexus, Legion, Syndicate, Tokenmaxx) load Instrument.
 */
export function themeById(id: string | null | undefined): ThemeDefinition {
  return themes.find((t) => t.id === id) ?? overhand;
}

/** Any first-party world by id (for code and tests that name one), or Instrument. */
export function worldById(id: string): ThemeDefinition {
  return allWorlds.find((t) => t.id === id) ?? overhand;
}
export { iconSvg, lockupSvg, MARK_GROUND, MARK_INK, type MarkOn, type MarkParts, markParts, markSvg, WORDMARK } from "./brand";
export { type Light, lightAt } from "./light";
export { type State, type Surface, SYSTEM, systemCss } from "./system";
