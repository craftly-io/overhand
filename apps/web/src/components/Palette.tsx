import { plainWords, themes } from "@overhand/themes";
import { XIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useActions } from "@/app/actions";
import type { Model } from "@/app/data";
import { FOCUS_KEY, toggleFocus } from "@/app/focus";
import { useSound } from "@/app/sound";
import { useTheme } from "@/app/theme";
import { PLACE_WORD, type Place, useUi, VIEW_META, VIEWS, type View } from "@/app/ui";
import { useVoice } from "@/app/voice";
import { Button } from "@/components/ui/button";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { DialogClose } from "@/components/ui/dialog";
import { canAssign, projectOfKey } from "@/lib/assign";
import { type Command, parseCommand } from "@/lib/commands";
import { fmt } from "@/lib/format";
import { fuzzyScore } from "@/lib/fuzzy";
import { leadName } from "@/lib/sessions";
import { guessProject, looksLikeTask } from "@/lib/task";

/**
 * ⌘K / Ctrl+K or "/" opens the command bar; W, C and H open Work, Crew and Health and F turns Focus on or off when you
 * aren't typing; Escape closes either (via Radix).
 */
function useShortcut(open: () => void, openView: (v: View) => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));
      const plain = !typing && !e.metaKey && !e.ctrlKey && !e.altKey;
      const view = VIEWS.find((v) => VIEW_META[v].key === e.key.toUpperCase());
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        open();
      } else if (e.key === "/" && !typing) {
        e.preventDefault();
        open();
      } else if (plain && !document.querySelector('[role="dialog"]') && (view || e.key.toUpperCase() === FOCUS_KEY)) {
        e.preventDefault();
        if (view) openView(view);
        else toggleFocus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, openView]);
}

/** One command bar line: the keyword you'd type, always plain, then what it does in the theme's words. */
interface Line {
  kw: string;
  desc: string;
  act: () => void;
}

/**
 * The command bar, grouped by place: every action by its plain keyword (the theme's words describe it), each place by
 * name, "KEY-123" to open a ticket and "queue KEY-123" to assign an agent to it. Themes appear when you type "theme".
 */
export function Palette({ m }: { m: Model | undefined }) {
  const { theme, words: w, appearance, setAppearance } = useTheme();
  const ui = useUi();
  const { run, guideRun, assign, startTask } = useActions();
  const sound = useSound();
  const listen = useVoice();
  const [text, setText] = useState("");
  const setOpen = ui.setPaletteOpen;
  const { goPlace, openPalette, paletteOpen, paletteSeed } = ui;
  useShortcut(
    useCallback(() => openPalette(""), [openPalette]),
    useCallback((v: View) => goPlace(v), [goPlace]),
  );
  // it opens with what it was asked to say (a plan to change), else empty
  useEffect(() => {
    if (paletteOpen) setText(paletteSeed);
  }, [paletteOpen, paletteSeed]);

  const close = (f: () => void) => () => {
    setOpen(false);
    f();
  };
  const cmd = (kw: string, desc: string, c: Command): Line => ({ kw, desc, act: close(() => void run(c)) });
  const place = (p: Place): Line => {
    const k = PLACE_WORD[p];
    const key = p === "now" || p === "settings" ? "" : ` (${VIEW_META[p].key})`;
    return {
      kw: p,
      desc: `${fmt(w.openPlace, { name: w[k] })}${w[k] === plainWords[k] ? "" : ` · ${plainWords[k]}`}${key}`,
      act: close(() => goPlace(p)),
    };
  };
  const theming = text.trim().toLowerCase().startsWith("theme");
  const groups: [Place, Line[]][] = [
    [
      "now",
      [
        place("now"),
        cmd("alerts", w.paneAlerts, { name: "alerts" }),
        cmd("brief", w.briefMe, { name: "brief" }),
        cmd("share", w.share, { name: "share" }),
        { kw: "focus", desc: `${w.focus} (${FOCUS_KEY})`, act: close(toggleFocus) },
        cmd("plan", w.planDay, { name: "plan" }),
        cmd("inbox", w.checkSlack, { name: "inbox" }),
        m?.s.paused ? cmd("resume", w.resume, { name: "resume" }) : cmd("pause", w.pause, { name: "pause" }),
        ...(listen ? [{ kw: "speak", desc: w.cmdSpeak, act: close(listen) }] : []),
      ],
    ],
    [
      "work",
      [
        place("work"),
        cmd("work", fmt(w.startArmed, { n: m?.armed ?? 0 }), { name: "work" }),
        cmd("overdrive", `${w.overdrive}…`, { name: "overdrive" }),
        ...(m?.s.prs ?? []).map((p) => cmd(`review ${p.key}`, fmt(w.cmdReview, { key: p.key }), { name: "review", key: p.key })),
      ],
    ],
    [
      "crew",
      [
        place("crew"),
        ...(m?.s.godmode ?? []).map((g) => cmd(`lead ${g.key}`, leadName(g, m?.s.names ?? {}), { name: "lead", key: g.key })),
        { kw: "instructions", desc: w.instTitle, act: close(() => ui.openDrawer({ kind: "instructions" })) },
        ...(m?.s.guides ?? []).flatMap((g) => [
          {
            kw: `guide ${g.project.toLowerCase()}`,
            desc: fmt(w.cmdGuideOpen, { project: g.project }),
            act: close(() => ui.openDrawer({ kind: "guide", project: g.project })),
          },
          {
            kw: `onboard ${g.project.toLowerCase()}`,
            desc: fmt(w.cmdGuide, { project: g.project }),
            act: close(() => guideRun(g.project)),
          },
        ]),
      ],
    ],
    ["health", [place("health")]],
    [
      "settings",
      [
        place("settings"),
        theming ? null : { kw: "theme", desc: `${w.theme}…`, act: () => setText("theme ") },
        ...(theming
          ? themes
              .filter((t) => t.id !== theme.id)
              .map((t) => cmd(`theme ${t.id}`, fmt(w.cmdTheme, { name: t.name }), { name: "theme", id: t.id }))
          : []),
        ...(
          [
            ["system", w.appearanceSystem],
            ["light", w.appearanceLight],
            ["dark", w.appearanceDark],
          ] as const
        )
          .filter(([a]) => a !== appearance)
          .map(([a, name]) => ({ kw: `appearance ${a}`, desc: fmt(w.cmdAppearance, { name }), act: close(() => setAppearance(a)) })),
        { kw: "sound", desc: sound.on ? w.soundOff : w.soundOn, act: close(sound.toggle) },
        cmd("sweep", `${w.sweep}…`, { name: "sweep" }),
        cmd("feedback", `${w.feedback}…`, { name: "feedback" }),
        cmd("restart", `${w.restartOps}…`, { name: "restart" }),
        cmd("shutdown", w.shutdown, { name: "shutdown" }),
      ].filter((x): x is Line => x !== null),
    ],
  ];
  const parsed = parseCommand(text);
  const key = parsed && (parsed.name === "open" || parsed.name === "queue") ? parsed.key : "";
  // assign an agent adapts to the ticket's project: on act it's handed over now, on watch or propose it's assigned
  const project = m && key ? projectOfKey(m.s, key) : "";
  const pick = (name: "open" | "queue") =>
    name === "queue" && m && project && canAssign(m.s, project) ? () => void assign({ project, key }) : () => void run({ name, key });
  // what you typed reads like work to do: start an agent on it, the likeliest project first and the rest one tap away
  const task = m && !key && looksLikeTask(text) ? guessProject(m.s.clients, text) : null;

  return (
    <CommandDialog
      className="m-dialog"
      filter={fuzzyScore}
      open={ui.paletteOpen}
      onOpenChange={setOpen}
      title={w.commandBar}
      description={w.commandBarHint}
    >
      <CommandInput
        placeholder={w.palettePlaceholder}
        value={text}
        onValueChange={setText}
        end={
          <DialogClose asChild>
            <Button variant="ghost" size="icon-xs" aria-label={w.close} className="text-muted-foreground">
              <XIcon />
            </Button>
          </DialogClose>
        }
      />
      <CommandList>
        {task ? null : <CommandEmpty>{w.paletteNoMatch}</CommandEmpty>}
        {task?.projects.length ? (
          <CommandGroup forceMount heading={w.startAgent}>
            {task.projects.map((project, i) => (
              <CommandItem
                key={project}
                forceMount
                // the guessed project's value starts with what was typed and outscores the others, whose place comes first:
                // with equal scores cmdk keeps the order from before the project was guessed
                value={i === 0 ? text : `${i} ${text}`}
                onSelect={close(() => void startTask(project, task.text))}
              >
                <span className="min-w-0 truncate">{fmt(i === 0 || !task.sure ? w.startOn : w.startOnOther, { project })}</span>
              </CommandItem>
            ))}
            <p className="px-2 pt-1 pb-2 text-xs text-muted-foreground">{w.startAgentHint}</p>
          </CommandGroup>
        ) : null}
        {key ? (
          <CommandGroup forceMount heading={fmt(w.paletteTicket, { key })}>
            {(parsed?.name === "queue" ? (["queue", "open"] as const) : (["open", "queue"] as const)).map((name) => (
              <CommandItem key={name} forceMount value={`${name} ${key}`} onSelect={close(pick(name))}>
                <span className="font-mono text-xs text-muted-foreground">{`${name} ${key}`}</span>
                <span>{fmt(name === "open" ? w.openKey : w.cmdQueue, { key })}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
        {groups.map(([p, lines]) => {
          const k = PLACE_WORD[p];
          return (
            <CommandGroup key={p} heading={w[k] === plainWords[k] ? w[k] : `${w[k]} · ${plainWords[k]}`}>
              {lines.map((l) => (
                <CommandItem key={`${l.kw} ${l.desc}`} value={`${l.kw} ${l.desc}`} onSelect={l.act}>
                  <span className="text-xs text-muted-foreground">{l.kw}</span>
                  <span className="min-w-0 truncate">{l.desc}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          );
        })}
      </CommandList>
      <div className="border-t border-border px-3 py-2.5 text-xs leading-relaxed text-muted-foreground">
        <p>{fmt(w.paletteHow, { label: m?.s.labels.queue ?? "agent" })}</p>
        {/* the ticket prefixes, wrapping as whole pairs on a narrow screen */}
        <p className="mt-1 flex flex-wrap gap-x-3">
          {m?.s.clients.map((c) => (
            <span key={c.prefix} className="whitespace-nowrap">
              <b data-data="" className="font-mono text-primary">
                {c.prefix}
              </b>{" "}
              {c.name}
            </span>
          ))}
        </p>
      </div>
    </CommandDialog>
  );
}
