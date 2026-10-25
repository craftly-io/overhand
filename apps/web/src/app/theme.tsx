import { plainWords, type ThemeDefinition, TOKEN_KEYS, themeById, type WordKey, type Words } from "@overhand/themes";
import { createContext, type ReactNode, use, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { z } from "zod";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { post } from "@/lib/api";
import { fmt } from "@/lib/format";
import { cn } from "@/lib/utils";
import { store } from "./store";

/** Light or dark, or whatever the system says; every theme has both. */
export type Appearance = "system" | "light" | "dark";
const toAppearance = (a: string | null): Appearance => (a === "light" || a === "dark" ? a : "system");

interface ThemeContext {
  /** The active theme with the tokens and hues of the appearance it's drawn in. */
  theme: ThemeDefinition;
  words: Words;
  /** Picks a look: kept in this browser, and told to the daemon so the menu bar item draws in it too. */
  setTheme: (id: string) => void;
  /** Shows and keeps a look without telling the daemon: the menu bar item following the dashboard's pick. */
  showTheme: (id: string) => void;
  appearance: Appearance;
  /** Whether the page is drawn light right now. */
  light: boolean;
  /** Takes any string, as a select hands it over; anything but light or dark means system. */
  setAppearance: (a: string) => void;
}

const Ctx = createContext<ThemeContext | null>(null);

const darkQuery = () => matchMedia("(prefers-color-scheme: dark)");
const subscribeDark = (f: () => void) => {
  const q = darkQuery();
  q.addEventListener("change", f);
  return () => q.removeEventListener("change", f);
};

/** Applies the chosen theme's tokens and fonts to the page and remembers the choice. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [base, setThemeState] = useState(() => themeById(store.get("overhand-theme")));
  // a retired world (or an id from before) has loaded Instrument: remember that, so the choice is what's shown
  useEffect(() => {
    const saved = store.get("overhand-theme");
    if (saved && saved !== base.id) store.set("overhand-theme", base.id);
  }, [base.id]);
  const [appearance, setAppearanceState] = useState(() => toAppearance(store.get("overhand-appearance")));
  const systemDark = useSyncExternalStore(subscribeDark, () => darkQuery().matches);
  const light = appearance === "light" || (appearance === "system" && !systemDark);
  const theme = useMemo(
    () => (light ? { ...base, tokens: base.light, hues: base.lightHues ?? base.hues, ink: base.lightInk ?? base.ink } : base),
    [base, light],
  );

  useEffect(() => {
    const root = document.documentElement;
    for (const k of TOKEN_KEYS) root.style.setProperty(`--${k}`, theme.tokens[k]);
    // the house theme's ink scale, --ink-1 … --ink-12; themes without one leave it unset
    for (let n = 1; n <= 12; n++) {
      const v = theme.ink?.[n - 1];
      if (v) root.style.setProperty(`--ink-${n}`, v);
      else root.style.removeProperty(`--ink-${n}`);
    }
    // native controls, scrollbars and shadcn's dark: variants follow the appearance
    root.dataset.appearance = light ? "light" : "dark";
    root.style.colorScheme = light ? "light" : "dark";
    root.classList.toggle("dark", !light);
    root.style.setProperty("--font-display", theme.fonts.display);
    root.style.setProperty("--font-body", theme.fonts.body);
    root.style.setProperty("--font-mono", theme.fonts.mono);
    root.style.setProperty("--font-greeting", theme.fonts.greeting ?? theme.fonts.display);
    root.dataset.theme = theme.id;
    // the house chrome (palette A: ink, hairlines, squared controls) for every world with an ink scale
    if (theme.ink) root.dataset.chrome = "house";
    else delete root.dataset.chrome;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme.tokens.background);
    const href = theme.fonts.href;
    if (href && !document.querySelector(`link[href="${href}"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      document.head.append(link);
    }
  }, [theme, light]);

  const showTheme = useCallback((id: string) => {
    const next = themeById(id);
    store.set("overhand-theme", next.id);
    setThemeState(next);
  }, []);
  const setTheme = useCallback(
    (id: string) => {
      showTheme(id);
      // the menu bar item has its own browser storage: it reads the pick from the daemon. Not told is no harm.
      post("/api/settings/quick", { look: themeById(id).id }, z.object({})).catch(() => undefined);
    },
    [showTheme],
  );
  const setAppearance = useCallback((a: string) => {
    const next = toAppearance(a);
    store.set("overhand-appearance", next);
    setAppearanceState(next);
  }, []);
  return <Ctx value={{ theme, words: theme.words, setTheme, showTheme, appearance, light, setAppearance }}>{children}</Ctx>;
}

/** The active theme, its words and a way to switch. */
export function useTheme(): ThemeContext {
  const ctx = use(Ctx);
  if (!ctx) throw new Error("useTheme needs a ThemeProvider");
  return ctx;
}

/** Just the active theme's words. */
export function useWords(): Words {
  return useTheme().words;
}

/**
 * A label in the theme's language, for pane headings and secondary buttons. When the theme renames it, hovering (or a
 * screen reader) gives the plain term ("Commanders = Leads"), because what changes is the name, not the meaning. No
 * underline: on this dashboard an underline means a link.
 */
export function Term({ k }: { k: WordKey }) {
  const w = useWords();
  const word = w[k];
  const plain = plainWords[k];
  if (word === plain) return <>{word}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span aria-description={plain}>{word}</span>
      </TooltipTrigger>
      <TooltipContent>
        {word} = {plain}
      </TooltipContent>
    </Tooltip>
  );
}

/** A word in the theme's language and in plain English, with its placeholders filled. */
function useNamed(k: WordKey, vars?: Record<string, string | number>): { word: string; plain: string; themed: boolean } {
  const w = useWords();
  const word = fmt(w[k], vars);
  const plain = fmt(plainWords[k], vars);
  return { word, plain, themed: word !== plain };
}

/**
 * A theme word with its plain meaning always visible: for places, drawer titles, the menu and primary or danger
 * buttons, where guessing isn't good enough. Stacked (a second line) or inline (a quieter word beside it); `hint` shows
 * in the plain word's place when the theme doesn't rename it.
 */
export function Named({
  k,
  vars,
  hint,
  inline = false,
  className,
}: {
  k: WordKey;
  vars?: Record<string, string | number>;
  hint?: string;
  inline?: boolean;
  className?: string;
}) {
  const { word, plain, themed } = useNamed(k, vars);
  const sub = themed ? plain : hint;
  if (!sub) return <>{word}</>;
  return inline ? (
    <span className={cn("inline-flex items-baseline gap-1.5", className)}>
      <span>{word}</span>
      <span className="named-plain text-[0.85em] font-normal opacity-75">{sub}</span>
    </span>
  ) : (
    <span className={cn("grid text-left leading-tight", className)}>
      <span>{word}</span>
      <span className="named-plain mt-0.5 text-xs font-normal opacity-70">{sub}</span>
    </span>
  );
}
