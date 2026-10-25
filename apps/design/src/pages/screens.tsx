/**
 * Screens: the whole dashboard (the real App) on Now and in each view behind it, each in the five states every screen
 * has. Work, Agents, Health and Settings open as drawers over Now (docked beside it from 2200px; from the bottom on a phone).
 */
import type { Drawer } from "@/app/ui";
import type { Entry } from "../catalog";
import { broken, busy, empty, loading, type Seed } from "../fixtures";
import { Screen } from "../stage";

const NOTES = {
  loading: "Before the first state arrives from the daemon.",
  empty: "A fresh install: no projects yet.",
  busy: "07:24: the night's one call just in, pull requests open, questions waiting.",
  broken: "02:30, when BOOK-88's preview deploy fails, and the daemon has stopped answering: the last state stays, with the banner.",
  phone: "The busy moment on a 390px phone.",
};

/** Now or one view, in its five states. */
const place = (id: string, title: string, about: string, open: Drawer | undefined, extra: Partial<Entry> = {}): Entry => {
  const at = (seed: () => Seed) => () => <Screen seed={seed()} open={open} />;
  return {
    id,
    group: "screens",
    title,
    about,
    states: { loading: at(loading), empty: at(empty), busy: at(busy), broken: at(broken), phone: at(busy) },
    notes: NOTES,
    frame: { height: 820 },
    ...extra,
  };
};

/** Now and the four views behind it. */
export const SCREENS: Entry[] = [
  place("now", "Now", "Three blocks: one sentence with the Night report, Needs you, and In progress.", undefined, {
    covers: ["DrawerHost", "MeTeam"],
  }),
  place(
    "work",
    "Work",
    "The pipeline: every ticket from queued to merged, and every pull request in flight.",
    { kind: "work" },
    {
      covers: ["ViewDrawer", "DrawerHead"],
    },
  ),
  place("crew", "Agents", "Who's working, where, under which instructions, and the day so far.", { kind: "crew" }),
  place("health", "Health", "Is anything broken, and is it worth it: checks, spend and each account's usage.", { kind: "health" }),
  place(
    "settings",
    "Settings",
    "Everything Overhand is told: projects, accounts, leads, schedule, rules and the rest.",
    { kind: "settings" },
    {
      notes: { ...NOTES, empty: "A fresh install: no projects in the state; the form shows the demo's sample config." },
    },
  ),
];
