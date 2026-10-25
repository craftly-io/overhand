/**
 * Patterns: the dashboard's real panes, cards and drawers on the demo's sample night. A pane takes the model as the
 * bridge gives it; a drawer, the command bar and Quick settings open over the whole dashboard, in a frame, the way a
 * person opens them.
 */
import { teamBrief } from "@overhand/contract";
import { plainWords } from "@overhand/themes";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef } from "react";
import { z } from "zod";
import { type Model, STATE_KEY } from "@/app/data";
import { useTheme } from "@/app/theme";
import { DecisionCard, InsightLine } from "@/components/DecisionCard";
import { Header } from "@/components/Header";
import { Accounts } from "@/components/health/Accounts";
import { Guardrails } from "@/components/health/Guardrails";
import { HealthPane } from "@/components/health/HealthPane";
import { Machine } from "@/components/health/Machine";
import { Plugins } from "@/components/health/Plugins";
import { WorkReports } from "@/components/health/Reports";
import { Scorecard } from "@/components/health/Scorecard";
import { Spend } from "@/components/health/Spend";
import { Systems } from "@/components/health/Systems";
import { Updates } from "@/components/health/Updates";
import { Week } from "@/components/health/Week";
import { Activity } from "@/components/now/Activity";
import { AnsweredElsewhere, NeedsList, NeedsYou, needs } from "@/components/now/Alerts";
import { Cast } from "@/components/now/Cast";
import { ControlRoom } from "@/components/now/ControlRoom";
import { DayRibbon } from "@/components/now/DayRibbon";
import { FirstRun } from "@/components/now/FirstRun";
import { FirstWin } from "@/components/now/FirstWin";
import { BeatCaption, Prologue } from "@/components/now/Story";
import { Today } from "@/components/now/Today";
import { MapWindow } from "@/components/now/Window";
import { Worktrees } from "@/components/now/Worktrees";
import { PlaceNav } from "@/components/PlaceBar";
import { Facepile } from "@/components/team/Facepile";
import { type TeamActs, TeamMap, TeamView } from "@/components/team/TeamView";
import { InFlight } from "@/components/work/InFlight";
import { Pipeline } from "@/components/work/Pipeline";
import { post } from "@/lib/api";
import { briefing } from "@/lib/briefing";
import type { Entry } from "../catalog";
import { allHere, alone, busy, crowd, crowdedDown, empty, failing, morning, team, working } from "../fixtures";
import { Live, Screen } from "../stage";

/** A pane-less piece sits on a pane, as it does on the bridge. */
const OnPane = ({ children }: { children: ReactNode }) => <section className="hud-pane">{children}</section>;

/** The map fills the column it's in, as Now's centre column is: here, a column of the frame's height. */
const Sized = ({ children }: { children: ReactNode }) => (
  <div className="flex h-[calc(100dvh-2rem)] min-h-[360px] flex-col">{children}</div>
);

/** A pattern drawn from the model on the morning after: one state. */
const pane = (id: string, name: string, title: string, about: string, render: (m: Model) => ReactNode): Entry => ({
  id,
  group: "patterns",
  title,
  about,
  covers: [name],
  states: { default: () => <Live>{render}</Live> },
});

/** A drawer opened over the whole dashboard on the morning after. */
const drawer = (id: string, title: string, about: string, covers: string[], states: Entry["states"], height = 760): Entry => ({
  id,
  group: "patterns",
  title,
  about,
  covers,
  states,
  frame: { height },
});

/**
 * A plan from a sentence: the sample request goes to the demo the way the command bar sends it, then only its card
 * from Needs you (as the site's plan piece does, apps/web/src/piece.tsx).
 */
function Plan({ m }: { m: Model }) {
  const qc = useQueryClient();
  const started = useRef(false);
  const list = needs(m).filter((n) => "alert" in n && m.s.findings.some((f) => f.task && n.alert.item === `held:${f.id}`));
  useEffect(() => {
    if (started.current || list.length) return;
    started.current = true;
    void post(
      "/api/assign",
      { project: "Mobile app", title: "make the invite page friendlier", brief: "make the invite page friendlier", plan: true },
      z.object({ key: z.string() }),
    ).then(() => qc.invalidateQueries({ queryKey: STATE_KEY }));
  }, [list.length, qc]);
  return list.length ? <NeedsList list={list} /> : null;
}

/** The morning brief, as "Brief me" writes it from the state. */
const brief = (m: Model) => ({ kind: "brief" as const, text: briefing(m.s, m.plan, m.alerts, plainWords, new Date(Date.now())) });

const SETTINGS_TABS = [
  "projects",
  "accounts",
  "leads",
  "schedule",
  "rules",
  "integrations",
  "plugins",
  "phone",
  "team",
  "look",
  "system",
  "health",
  "json",
];

/** The map on its own, pure: what it can ask for goes nowhere here (TeamView wires it to the daemon). */
const NONE: TeamActs = { claim: () => {}, answer: () => {}, handoff: () => {}, comment: () => {}, follow: () => {}, open: () => {} };

function Team({ m, follow = null }: { m: Model; follow?: string | null }) {
  const { words: w, theme, light } = useTheme();
  const t = m.s.team;
  if (!t) return null;
  return (
    <TeamMap
      t={t}
      w={w}
      now={m.s.now}
      follow={follow}
      held={[]}
      brief={teamBrief(t, m.s.now)}
      act={NONE}
      look={{ world: theme.world, light }}
    />
  );
}

const TEAM_NOTES = {
  "on your own": "Sam alone in the team: nobody else to show.",
  "several people": "Sam, Robin and Kai, all online; Robin and Kai both have BOOK-88's pull request open.",
  "someone away": "The whole team: Noor is away, so her hub dims.",
  "following Robin": "Robin's map as Robin sees it.",
};

/** The dashboard's panes, cards, bars and drawers. */
export const PATTERNS: Entry[] = [
  // Now
  {
    id: "needs-you",
    group: "patterns",
    title: "Needs you",
    about: "The calls that are yours, each as a decision card with the recommended answer on its one orange button.",
    covers: ["NeedsYou", "NeedsList", "InboxRow", "SlackRead", "Explain"],
    states: {
      waiting: () => <Live>{(m) => <NeedsYou m={m} />}</Live>,
      nothing: () => <Live seed={empty()}>{(m) => <NeedsYou m={m} />}</Live>,
      busy: () => <Live seed={busy()}>{(m) => <NeedsYou m={m} />}</Live>,
    },
    notes: {
      waiting: "The morning after: two questions from the night.",
      nothing: "Nothing waits on you.",
      busy: "07:24, the moment the night's one call arrives.",
    },
    frame: { height: 520, only: ["busy"] },
  },
  {
    id: "decision-card",
    group: "patterns",
    title: "Decision card",
    about: "One decision: what it is, why it's yours, the recommendation and its reason, every option, and what happens if you wait.",
    covers: ["DecisionCard", "InsightLine"],
    states: {
      full: () => <Live>{(m) => <OnPane>{<DecisionCard m={m} item="pr:BOOK-88" />}</OnPane>}</Live>,
      compact: () => <Live>{(m) => <OnPane>{<DecisionCard m={m} item="lead:mobile" compact />}</OnPane>}</Live>,
      "a draft to mark ready": () => <Live>{(m) => <OnPane>{<DecisionCard m={m} item="pr:WEB-31" />}</OnPane>}</Live>,
      insight: () => (
        <Live>
          {(m) => (
            <OnPane>
              <InsightLine m={m} surface="now" fallback={<p className="text-sm text-muted-foreground">No insight yet.</p>} />
            </OnPane>
          )}
        </Live>
      ),
    },
  },
  {
    id: "answered-elsewhere",
    group: "patterns",
    title: "I answered elsewhere",
    about: "After you settled a lead's question outside Overhand: an optional line of what you decided, then the lead resumes.",
    covers: ["AnsweredElsewhere"],
    states: {
      default: () => <Live>{() => <OnPane>{<AnsweredElsewhere leadKey="mobile" onDone={() => {}} />}</OnPane>}</Live>,
    },
  },
  {
    id: "plan-card",
    group: "patterns",
    title: "Plan card",
    about: "A request typed as a sentence comes back as its agent's plan, in Needs you, to go ahead with or change.",
    states: { default: () => <Live>{(m) => <OnPane>{<Plan m={m} />}</OnPane>}</Live> },
    frame: { height: 520 },
  },
  {
    id: "cast",
    group: "patterns",
    title: "Crew",
    covers: ["Cast", "Suggested"],
    about:
      "Who's working and where: each lead and agent as a row, with what it's doing now and its project · branch; under them, the ready-made leads this work could use.",
    states: {
      glance: () => <Live>{(m) => <Cast m={m} glance />}</Live>,
      full: () => <Live>{(m) => <Cast m={m} />}</Live>,
      "on a project": () => <Live>{(m) => <Cast m={m} project="Online shop" />}</Live>,
      "at work": () => <Live seed={working()}>{(m) => <Cast m={m} glance />}</Live>,
    },
    notes: {
      "at work": "01:30: four agents at work at once.",
      "on a project": "Online shop's own view: every lead its work suggests, each with the count behind it; a click previews it.",
    },
    frame: { height: 560, only: ["at work"] },
  },
  pane(
    "worktrees",
    "Worktrees",
    "Worktrees",
    "A project's checkouts on this machine, yours and the agents': who is in each now, its PR, its size, and whether Cleanup offers it.",
    (m) => <Worktrees m={m} project="Online shop" />,
  ),
  {
    id: "attention-map",
    group: "patterns",
    title: "Attention map",
    about: "The centre of Now: each project in its place, lit where something needs you.",
    covers: ["MapWindow"],
    states: {
      morning: function Morning() {
        const { theme } = useTheme();
        return <Live>{(m) => <Sized>{<MapWindow m={m} world={theme.world} />}</Sized>}</Live>;
      },
      "at work": function Busy() {
        const { theme } = useTheme();
        return <Live seed={working()}>{(m) => <Sized>{<MapWindow m={m} world={theme.world} />}</Sized>}</Live>;
      },
    },
    frame: { height: 620 },
  },
  {
    id: "story",
    group: "patterns",
    title: "Greeting and story",
    about: "The line at the top of Now that says what happened and what's next.",
    covers: ["Prologue", "BeatCaption"],
    states: {
      default: () => (
        <Live>
          {(m) => (
            <OnPane>
              <Prologue m={m} />
              <BeatCaption m={m} />
            </OnPane>
          )}
        </Live>
      ),
    },
  },
  pane("day-ribbon", "DayRibbon", "Day ribbon", "The day along the bottom of Now: when agents ran, and what landed.", (m) => (
    <OnPane>
      <DayRibbon m={m} />
    </OnPane>
  )),
  pane("today", "Today", "Today", "What's on today: the calendar beside what the agents will do.", (m) => <Today m={m} />),
  pane("activity", "Activity", "The day so far", "Everything that happened, newest first, in plain words.", (m) => <Activity m={m} />),
  pane("first-win", "FirstWin", "First win", "A new project's first pull request, made right after setup.", (m) => <FirstWin m={m} />),
  {
    id: "first-run",
    group: "patterns",
    title: "First run",
    covers: ["FirstRun"],
    about: "Now before any project is added: the steps to the first agent.",
    states: { default: () => <Live seed={empty()}>{(m) => <FirstRun m={m} />}</Live> },
  },
  // the team
  {
    id: "team-map",
    group: "patterns",
    title: "Team map",
    about: "Now's Team view, drawn: the team brief, what waits on you, every person as a small map of their own, the team's items.",
    covers: ["TeamMap"],
    states: {
      "on your own": () => <Live seed={team(alone)}>{(m) => <Team m={m} />}</Live>,
      "several people": () => <Live seed={team(allHere)}>{(m) => <Team m={m} />}</Live>,
      "someone away": () => <Live>{(m) => <Team m={m} />}</Live>,
      "following Robin": () => <Live>{(m) => <Team m={m} follow="robin" />}</Live>,
    },
    notes: TEAM_NOTES,
  },
  {
    id: "team-view",
    group: "patterns",
    title: "Team view",
    about: "The Team map wired to the daemon (claim, answer, hand off, comment), and Now's Me / Team switch that opens it.",
    covers: ["TeamView", "MeTeam"],
    states: {
      default: () => <Live>{(m) => <TeamView m={m} brief={m.s.team ? teamBrief(m.s.team, m.s.now) : []} />}</Live>,
      "on Now": () => <Screen seed={morning()} press={`fieldset[aria-label="${plainWords.teamSwitch}"] button:last-of-type`} />,
    },
    notes: { "on Now": "All of Overhand with Team picked on Now's switch." },
    frame: { height: 820, only: ["on Now"] },
  },
  {
    id: "facepile",
    group: "patterns",
    title: "Who's here",
    about:
      "In the header, from 1024px wide: up to three teammates online as initials and a count of the rest; pick one to follow them. A quiet teammate is dimmed.",
    covers: ["Facepile"],
    states: {
      "two here": () => <Live>{(m) => <Facepile m={m} />}</Live>,
      "on your own": () => <Live seed={team(alone)}>{(m) => <Facepile m={m} />}</Live>,
      "a full room": () => <Live seed={team(crowd)}>{(m) => <Facepile m={m} />}</Live>,
      "in the header": () => <Screen seed={crowdedDown()} />,
    },
    notes: {
      "two here": "Robin and Kai online (Kai on quiet mode, dimmed); Noor is away, so she isn't shown.",
      "on your own": "Draws nothing: there's nobody else to show.",
      "a full room": "Six teammates online: three faces and a count of the rest.",
      "in the header":
        "The widest header: the daemon down mid-night, every place counting, Pause new work, and six teammates here. It fits from 1024 with nothing cut.",
    },
    frame: { height: 300, only: ["in the header"] },
  },
  // Work
  {
    id: "in-flight",
    group: "patterns",
    title: "In flight",
    covers: ["InFlight"],
    about: "Every pull request the agents opened, with its checks, its preview and its proof.",
    states: {
      default: () => <Live>{(m) => <InFlight m={m} />}</Live>,
      failing: () => <Live seed={failing()}>{(m) => <InFlight m={m} />}</Live>,
    },
    notes: { failing: "02:30: BOOK-88's preview deploy fails, before its fix round." },
    frame: { height: 640, only: ["failing"] },
  },
  // a list of catalog entries, alike by design, not copied logic
  // jscpd:ignore-start
  pane("pipeline", "Pipeline", "Pipeline", "Work: every ticket from queued to merged, per project.", (m) => <Pipeline m={m} />),
  pane(
    "control-room",
    "ControlRoom",
    "Control room",
    "Crew: each session on this machine, what it holds, and whether the house rules reach it.",
    // two panes, one gap apart, as Crew lays them out
    (m) => (
      <div className="grid gap-(--space-gap)">
        <ControlRoom m={m} />
      </div>
    ),
  ),
  // Health
  pane("systems", "Systems", "Systems", "The bridge's glance at Health: checks, deploys and errors per project.", (m) => <Systems m={m} />),
  pane("health-pane", "HealthPane", "Health", "Is anything broken: every project's checks, deploys and errors.", (m) => (
    <HealthPane m={m} />
  )),
  pane("machine", "Machine", "This machine", "What's running here and what it costs the machine.", (m) => <Machine m={m} />),
  pane("accounts", "Accounts", "Accounts", "Each account the agents run on, and how much of its window is used.", (m) => (
    <Accounts m={m} />
  )),
  pane("guardrails", "Guardrails", "Guardrails", "What the house rules stopped, and why.", (m) => <Guardrails m={m} />),
  pane("spend", "Spend", "Spend", "What was billed against the budget, what the plans covered, and the work at API prices.", (m) => (
    <Spend m={m} />
  )),
  pane("scorecard", "Scorecard", "Scorecard", "How each agent and model does on each project: merged, fixed, cost.", (m) => (
    <Scorecard m={m} />
  )),
  pane("week", "Week", "The week", "Agent PRs opened, and first-try success.", (m) => <Week m={m} />),
  pane("updates", "Updates", "Updates", "What changed in the agents and Overhand itself.", (m) => <Updates m={m} />),
  pane("plugins", "Plugins", "Plugins", "Each plugin, its last run, and every finding with its fix.", (m) => <Plugins m={m} />),
  pane("work-reports", "WorkReports", "Reports", "The work report per project, to send to whoever needs it.", (m) => <WorkReports m={m} />),
  // jscpd:ignore-end
  // the chrome
  {
    id: "header",
    group: "patterns",
    title: "Header",
    about: "The bar across the top: the places, ask anything, Quick settings, more, and the clock with today's spend.",
    covers: ["PlaceNav"],
    states: {
      default: () => <Live>{(m) => <Header m={m} unreachable={false} />}</Live>,
      unreachable: () => <Live>{(m) => <Header m={m} unreachable />}</Live>,
      places: () => <Live>{(m) => <PlaceNav m={m} />}</Live>,
    },
    // the bar spans the whole screen: it needs a screen's width, not the stage's
    frame: { height: 120, only: ["default", "unreachable"] },
  },
  {
    id: "place-bar",
    group: "patterns",
    title: "Place bar",
    about: "On a phone, the places as a bar along the bottom.",
    covers: ["PlaceBar"],
    states: { phone: () => <Screen seed={morning()} /> },
    notes: { phone: "All of Overhand on a phone; the bar sits at the bottom." },
    frame: { height: 760 },
  },
  {
    id: "quick-settings",
    group: "patterns",
    title: "Quick settings",
    about: "One tap from the header: pause, quiet mode, the daily budget, pacing, sound, and how far agents go per project.",
    covers: ["QuickSettings"],
    states: { open: () => <Screen seed={morning()} press={`header button[aria-label="${plainWords.quickSettings}"]`} /> },
    frame: { height: 760 },
  },
  {
    id: "command-bar",
    group: "patterns",
    title: "Command bar",
    about: "Ask anything (⌘K): open a place, run a command, or type a request for an agent.",
    covers: ["Palette"],
    states: {
      open: () => <Screen seed={morning()} palette="" />,
      typing: () => <Screen seed={morning()} palette="book" />,
      "a request": () => <Screen seed={morning()} palette="Mobile app: make the invite page friendlier" />,
      "no match": () => <Screen seed={morning()} palette="thehe" />,
    },
    frame: { height: 640 },
  },
  // drawers
  drawer("ticket-drawer", "Ticket", "One ticket: its status, its agent, and the decision it waits on.", ["TicketDrawer"], {
    default: () => <Screen seed={morning()} open={{ kind: "ticket", key: "SHOP-151" }} />,
  }),
  drawer("lead-drawer", "Lead", "A project's lead: what it's watching, what it asked, and how to answer.", ["LeadDrawer"], {
    asking: () => <Screen seed={morning()} open={{ kind: "lead", key: "mobile" }} />,
    quiet: () => <Screen seed={morning()} open={{ kind: "lead", key: "shop" }} />,
  }),
  drawer(
    "review-drawer",
    "Review",
    "A pull request to review: the change, its proof, the corners the agent cut, and the preview to pin notes on.",
    ["ReviewDrawer", "PreviewReview", "PreviewLink", "Proof", "Corners"],
    {
      review: () => <Screen seed={morning()} open={{ kind: "review", key: "BOOK-88" }} />,
      "on the preview": () => <Screen seed={morning()} open={{ kind: "review", key: "BOOK-88", preview: true }} />,
      draft: () => <Screen seed={morning()} open={{ kind: "review", key: "WEB-31" }} />,
    },
  ),
  drawer("needs-you-drawer", "Needs you, in full", "Every call that's yours, not just the first six.", ["AlertsDrawer"], {
    default: () => <Screen seed={morning()} open={{ kind: "alerts" }} />,
  }),
  drawer("notes", "Notes", "What the agents left for you to read, nothing to decide.", ["NotesDrawer"], {
    default: () => <Screen seed={morning()} open={{ kind: "notes" }} />,
  }),
  drawer("brief", "Morning brief", "The night in a few sentences, read aloud when you ask.", ["BriefDrawer"], {
    default: () => <Screen seed={morning()} open={brief} />,
  }),
  drawer("shutdown", "Turned off", "After Turn Overhand off: how to start it again.", ["ShutdownDrawer"], {
    default: () => (
      <Screen seed={morning()} open={{ kind: "shutdown", busy: false, startAgain: "cd /Users/sam/Overhand && bun run.ts daemon" }} />
    ),
    "agents still working": () => (
      <Screen seed={morning()} open={{ kind: "shutdown", busy: true, startAgain: "cd /Users/sam/Overhand && bun run.ts daemon" }} />
    ),
  }),
  drawer("overdrive", "Overdrive", "Everything the agents could start right now, to start at once.", ["OverdriveDrawer"], {
    default: () => <Screen seed={morning()} open={{ kind: "overdrive" }} />,
  }),
  drawer("sweep", "Sweep", "Old branches, stale tickets and leftovers, to clear in one go.", ["SweepDrawer"], {
    default: () => <Screen seed={morning()} open={{ kind: "sweep" }} />,
  }),
  drawer(
    "instructions",
    "Instructions",
    "What each project's agents are told, and what Overhand suggests adding.",
    ["InstructionsDrawer"],
    {
      default: () => <Screen seed={morning()} open={{ kind: "instructions" }} />,
    },
  ),
  drawer("guide", "Guide", "A project's guide: how its agents should work there.", ["GuideDrawer"], {
    default: () => <Screen seed={morning()} open={{ kind: "guide", project: "Online shop" }} />,
  }),
  drawer("share", "Share card", "The night, the day or the week as a card to post.", ["ShareDrawer"], {
    night: () => <Screen seed={morning()} open={{ kind: "share", span: "night" }} />,
    week: () => <Screen seed={morning()} open={{ kind: "share", span: "week" }} />,
  }),
  drawer("menu", "More", "Everything else: brief, share, sweep, instructions, restart and turn off.", ["MenuDrawer"], {
    default: () => <Screen seed={morning()} open={{ kind: "menu" }} />,
  }),
  drawer(
    "feedback",
    "Suggest or report",
    "Feedback as a public GitHub issue: written, previewed exactly, sent by you.",
    ["FeedbackDrawer"],
    {
      default: () => <Screen seed={morning()} open={{ kind: "feedback" }} />,
    },
  ),
  drawer("whats-new", "What's new", "Every built feature, newest first, each with a link to its docs.", ["NewsDrawer"], {
    default: () => <Screen seed={morning()} open={{ kind: "news" }} />,
  }),
  drawer(
    "settings-tabs",
    "Settings, tab by tab",
    "Every Settings tab on the demo's sample config.",
    [
      "SettingsDrawer",
      "LookTab",
      "SystemTab",
      "HouseRulesTab",
      "SettingsReports",
      "StatusUpdates",
      "PluginsTab",
      "AgentTuning",
      "TeamSettings",
      "Field",
      "FieldCard",
      "CheckRows",
    ],
    Object.fromEntries(SETTINGS_TABS.map((tab) => [tab, () => <Screen seed={morning()} open={{ kind: "settings", tab }} />] as const)),
  ),
];
