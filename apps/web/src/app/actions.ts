import {
  AlloutResultSchema,
  type CardButton,
  type DashboardState,
  type FeedbackDraft,
  type FeedbackHits,
  type FeedbackPreview,
  FeedbackPreviewSchema,
  type FeedbackRequest,
  FeedbackSentSchema,
  LeadStartResultSchema,
  LeadStopResultSchema,
  type LeakHit,
  LeakHitSchema,
  PrReadyResultSchema,
  RestartResultSchema,
  SelfUpdateResultSchema,
  type SplitPart,
} from "@overhand/contract";
import { themes } from "@overhand/themes";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { z } from "zod";
import { DEMO } from "@/demo/demo";
import { computeAlerts } from "@/lib/alerts";
import { post } from "@/lib/api";
import type { AssignOffer } from "@/lib/assign";
import { briefing } from "@/lib/briefing";
import type { Command } from "@/lib/commands";
import { fmt, hm } from "@/lib/format";
import { parsePlan } from "@/lib/plan";
import { leadName } from "@/lib/sessions";
import { speak } from "@/lib/voice";
import { STATE_KEY } from "./data";
import { useTheme } from "./theme";
import { cardSpanNow, useUi } from "./ui";

const Ok = z.object({});
/** What Edit and post did: sent, or the spans your text still names. */
const ReleasedSchema = z.object({ hits: z.array(LeakHitSchema).optional() });
/** What Add rule did: a draft PR, or (watch) the line to add yourself. */
const RuleAddedSchema = z.union([z.object({ url: z.string() }), z.object({ suggest: z.string(), file: z.string() })]);

/** Every action the dashboard can take. Each one says what happened in a toast (and aloud, when asked by voice). */
export function useActions() {
  const qc = useQueryClient();
  const ui = useUi();
  const { theme, words: w, setTheme } = useTheme();
  const state = () => qc.getQueryData<DashboardState>(STATE_KEY);
  const refresh = () => void qc.invalidateQueries({ queryKey: STATE_KEY });

  const tell = (msg: string, talk: boolean) => {
    toast(msg);
    if (talk) speak(msg, theme);
  };
  /** Runs a POST and reports failure as a toast instead of throwing. */
  const guard = async (talk: boolean, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      tell(e instanceof Error ? e.message : String(e), talk);
    }
  };
  /** Actions the daemon picks up on its next tick still work while it's down; say so. */
  const later = (msg: string) => (state()?.daemon === false ? fmt(w.saidOffline, { msg }) : msg);

  const SIMPLE_POST = {
    plan: ["/api/request/plan", w.saidPlan],
    inbox: ["/api/request/inbox", w.saidInbox],
    work: ["/api/request/work", w.saidWork],
    pause: ["/api/pause", w.saidPause],
    resume: ["/api/resume", w.saidResume],
  } as const;

  const run = (cmd: Command, talk = false): Promise<void> =>
    guard(talk, async () => {
      const s = state();
      switch (cmd.name) {
        case "plan":
        case "inbox":
        case "work":
        case "pause":
        case "resume": {
          const [url, said] = SIMPLE_POST[cmd.name];
          await post(url, {}, Ok);
          tell(later(said), talk);
          return refresh();
        }
        case "queue":
          await post("/api/ticket/queue", { key: cmd.key }, Ok);
          tell(fmt(w.saidQueued, { key: cmd.key }), talk);
          return refresh();
        case "open":
          return ui.openDrawer({ kind: "ticket", key: cmd.key.toUpperCase() });
        case "lead":
          return ui.openDrawer({ kind: "lead", key: cmd.key.toLowerCase() });
        case "review":
          return ui.openDrawer({ kind: "review", key: cmd.key.toUpperCase() });
        case "theme": {
          const i = themes.findIndex((t) => t.id === theme.id);
          const next = themes.find((t) => t.id === cmd.id) ?? themes[(i + 1) % themes.length];
          if (!next) return;
          setTheme(next.id);
          toast(fmt(w.saidTheme, { name: next.name }));
          return;
        }
        case "brief": {
          if (!s) return;
          const plan = parsePlan(s.plan);
          // the drawer reads it aloud while it's open; the time is Date.now's (`new Date()` would skip the demo's clock)
          const text = briefing(s, plan, computeAlerts(s, plan, w, Date.now()), w, new Date(Date.now()));
          return ui.openDrawer({ kind: "brief", text });
        }
        case "share":
          return ui.openDrawer({ kind: "share", span: cardSpanNow(new Date(Date.now())) });
        case "alerts":
        case "overdrive":
        case "sweep":
        case "settings":
        case "menu":
        case "feedback":
          return ui.openDrawer({ kind: cmd.name });
        case "restart": {
          if (!(await ui.confirm({ title: w.confirmRestartTitle, body: w.confirmRestart, go: w.confirmRestartGo, tone: "primary" })))
            return;
          const r = await post("/api/restart", {}, RestartResultSchema);
          return tell(r.busy ? w.saidRestartBusy : w.saidRestart, talk);
        }
        case "shutdown": {
          if (!(await ui.confirm({ title: w.confirmShutdownTitle, body: w.confirmShutdown, go: w.confirmShutdownGo }))) return;
          const r = await post("/api/shutdown", {}, RestartResultSchema);
          return ui.openDrawer({ kind: "shutdown", busy: r.busy, startAgain: r.startAgain });
        }
        case "unknown":
          return tell(fmt(w.saidUnknown, { cmd: cmd.text }), talk);
      }
    });

  return {
    run,
    /** Quiet mode for `hours` ("I need my laptop"), or off with 0: heavy agent jobs wait, edits carry on. */
    quiet: (hours: number) =>
      guard(false, async () => {
        const r = await post("/api/quiet", { hours }, z.object({ quietUntil: z.number() }));
        toast(r.quietUntil ? fmt(w.saidQuiet, { time: hm(r.quietUntil) }) : w.saidQuietOff);
        refresh();
      }),
    /** Presses an action card's button: Overhand does it with your authority and says what happened. */
    cardAct: (card: string, button: CardButton) =>
      guard(false, async () => {
        const r = await post("/api/control/act", { card, button }, z.object({ result: z.string() }));
        toast(r.result);
        refresh();
      }),
    /**
     * Connects (or disconnects) a session's project: `preview` returns the settings file and what it would hold, without
     * writing; otherwise it's written. Null when it failed (said in a toast).
     */
    connectSession: async (key: string, on: boolean, preview: boolean): Promise<{ file: string; after: string } | null> => {
      try {
        const r = await post("/api/control/connect", { key, on, preview }, z.object({ file: z.string(), after: z.string() }));
        if (!preview) refresh();
        return r;
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e));
        return null;
      }
    },
    /** Lifts the pause on a session: its tool calls go through again. */
    resumeSession: (session: string) =>
      guard(false, async () => {
        await post("/api/control/resume", { session }, Ok);
        toast(w.saidResumed);
        refresh();
      }),
    /** A typed request to a connected session, handed to it at its next tool call. True when it was sent. */
    askSession: async (to: string, text: string, by: string): Promise<boolean> => {
      try {
        const r = await post("/api/requests", { to, text, by, from: "owner" }, z.object({ toLabel: z.string() }));
        toast(fmt(w.saidRequestSent, { who: r.toLabel }));
        refresh();
        return true;
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e));
        return false;
      }
    },
    /** Files the parts of a too-big ticket as tickets for the agent (listed unarmed in today's plan). */
    split: (key: string, parts: SplitPart[]) =>
      guard(false, async () => {
        const r = await post("/api/ticket/split", { key, parts }, z.object({ created: z.array(z.string()) }));
        toast(fmt(w.splitFiled, { keys: r.created.join(", ") }));
        ui.closeDrawer();
        refresh();
      }),
    /** Arms or disarms a plan line (a ticket for the agent, or a Slack request about to be filed). */
    toggle: (line: number) =>
      guard(false, async () => {
        await post("/api/plan/toggle", { line, text: state()?.plan[line] ?? "" }, Ok);
        toast(w.saidToggled);
        refresh();
      }),
    launch: () =>
      guard(false, async () => {
        ui.closeDrawer();
        const r = await post("/api/allout", {}, AlloutResultSchema);
        toast(
          r.started.length ? fmt(w.saidLaunchStarted, { n: r.armed, names: r.started.join(" and ") }) : fmt(w.saidLaunch, { n: r.armed }),
        );
        refresh();
      }),
    leadStart: (key: string) =>
      guard(false, async () => {
        const r = await post("/api/lead/start", { key }, LeadStartResultSchema);
        toast(r.running ? w.saidLeadAlready : w.saidLeadStarting);
        refresh();
      }),
    leadStop: (key: string) =>
      guard(false, async () => {
        const s = state();
        const g = s?.godmode.find((x) => x.key === key);
        if (g?.running) {
          const ok = await ui.confirm({
            title: fmt(w.confirmLeadStopTitle, { lead: leadName(g, s?.names ?? {}) }),
            body: fmt(w.confirmLeadStop, { t: hm(g.since) }),
            go: w.confirmLeadStopGo,
          });
          if (!ok) return;
        }
        const r = await post("/api/lead/stop", { key }, LeadStopResultSchema);
        toast(r.other ? fmt(w.saidLeadStoppedOther, { pid: r.other }) : w.saidLeadStopped);
        refresh();
      }),
    /** Adds a ready-made lead to a project under its job name, switched on; it wakes for the work it was suggested for. */
    leadTemplate: (project: string, template: string, name: string) =>
      guard(false, async () => {
        await post("/api/lead/template", { project, template, name }, Ok);
        toast(fmt(w.saidLeadTemplate, { lead: name }));
        refresh();
      }),
    /** Your own name for a lead or a piece of work (contract leadId/workId); "" goes back to Overhand's. */
    rename: (id: string, name: string) =>
      guard(false, async () => {
        await post("/api/name", { id, name }, Ok);
        refresh();
      }),
    /** Answers a lead's open question: your answer, "I answered elsewhere" (text optional), or dismissing it. */
    leadAnswer: (key: string, text: string, kind: "answer" | "elsewhere" | "dismiss" = "answer") =>
      guard(false, async () => {
        await post("/api/lead/answer", { key, text, kind }, Ok);
        toast(kind === "elsewhere" ? w.saidAnsweredElsewhere : kind === "dismiss" ? w.saidDismissed : w.saidAnswer);
        refresh();
      }),
    /**
     * Answers a ticket's question with a choice from its decision card: posted on the ticket and back in the agents'
     * queue, or on watch held for you to post.
     */
    ticketAnswer: (key: string, text: string) =>
      guard(false, async () => {
        const r = await post("/api/ticket/answer", { key, text }, z.object({ done: z.enum(["posted", "held"]) }));
        toast(fmt(r.done === "posted" ? w.saidAnswerPosted : w.saidAnswerHeld, { key }));
        refresh();
      }),
    /** Marks an agent's draft PR ready, approving it too when GitHub allows (you aren't its author). Never merges. */
    prReady: (key: string) =>
      guard(false, async () => {
        const r = await post("/api/pr/ready", { key }, PrReadyResultSchema);
        toast(fmt(r.approved ? w.saidReadyApproved : w.saidReady, { key }));
        ui.closeDrawer();
        refresh();
      }),
    /** Sends your note to the agent as the PR's next fix round. Resolves true when it was sent. */
    prChanges: async (key: string, text: string): Promise<boolean> => {
      let sent = false;
      await guard(false, async () => {
        await post("/api/pr/changes", { key, text }, Ok);
        toast(fmt(w.saidChangesSent, { key }));
        sent = true;
        refresh();
      });
      return sent;
    },
    prClose: (key: string) =>
      guard(false, async () => {
        if (!(await ui.confirm({ title: fmt(w.confirmCloseTitle, { key }), body: w.confirmClose, go: w.confirmCloseGo }))) return;
        await post("/api/pr/close", { key }, Ok);
        toast(fmt(w.saidClosed, { key }));
        ui.closeDrawer();
        refresh();
      }),
    /** Proposes a rule learned from review in a draft PR; on watch, copies the line to add instead. */
    ruleAdd: (id: string) =>
      guard(false, async () => {
        const r = await post("/api/rules/add", { id }, RuleAddedSchema);
        if ("url" in r) toast(fmt(w.saidRuleAdded, { file: state()?.rules.find((x) => x.id === id)?.file ?? "" }));
        else {
          await navigator.clipboard?.writeText(r.suggest).catch(() => undefined);
          toast(fmt(w.saidRuleSuggest, { file: r.file, line: r.suggest }));
        }
        refresh();
      }),
    /** Not now (30 days) or never for a rule learned from review. */
    ruleDismiss: (id: string, how: "later" | "never") =>
      guard(false, async () => {
        await post("/api/rules/dismiss", { id, how }, Ok);
        toast(how === "never" ? w.saidRuleNever : w.saidRuleLater);
        refresh();
      }),
    /**
     * Assign an agent: on a watch or propose project, an agent builds this one ticket (or a held finding, or a lead's
     * report, as a task) at the project's assigned level on the next pass. Never merges.
     */
    assign: (offer: AssignOffer) =>
      guard(false, async () => {
        const r = await post("/api/assign", offer, z.object({ key: z.string() }));
        toast(later(fmt(w.saidAssigned, { key: r.key })));
        refresh();
      }),
    /**
     * Starts an agent on what you said, on any project: its first pass plans in plain words and changes nothing; the plan
     * comes back to Needs you to go ahead with, change or drop. No ticket or tracker needed.
     */
    startTask: (project: string, text: string) =>
      guard(false, async () => {
        await post("/api/assign", { project, title: text.slice(0, 200), brief: text, plan: true }, z.object({ key: z.string() }));
        toast(fmt(w.saidPlanning, { project }));
        refresh();
      }),
    /** Posts a comment Overhand held on a watch project, as you, on its ticket. */
    heldPost: (id: string, key: string) =>
      guard(false, async () => {
        await post("/api/finding/post", { id }, Ok);
        toast(fmt(w.saidPosted, { key }));
        refresh();
      }),
    /** Hides an item from Needs you for `hours` (its decision card's Snooze); it comes back when the snooze runs out. */
    snooze: (item: string, hours: number) =>
      guard(false, async () => {
        const r = await post("/api/brief/snooze", { id: item, hours }, z.object({ until: z.number() }));
        toast(fmt(w.saidSnoozed, { t: hm(r.until) }));
        refresh();
      }),
    /**
     * Sends what the outward firewall held: `text` is your edit (checked again; what still matches comes back and nothing
     * is sent), null with `force` is Post anyway. Resolves to the spans still marked, empty once it went.
     */
    leakRelease: async (id: string, text: string | null, force: boolean): Promise<LeakHit[]> => {
      try {
        const r = await post("/api/finding/release", { id, ...(text === null ? {} : { text }), force }, ReleasedSchema);
        if (r.hits?.length) return r.hits;
        toast(w.saidLeakSent);
        refresh();
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e));
      }
      return [];
    },
    /** Suggest or report, Preview: the exact issue and what the firewall marks in it. Sends nothing; null when it failed. */
    feedbackPreview: async (req: FeedbackRequest): Promise<FeedbackPreview | null> => {
      try {
        return await post("/api/feedback/preview", req, FeedbackPreviewSchema);
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e));
        return null;
      }
    },
    /**
     * Suggest or report, Send (your click, and nothing else, calls it): posted with your gh login, or GitHub's issue page
     * opened filled in. Resolves to the spans the firewall still marks, null once it went (or failed, said in a toast).
     */
    feedbackSend: async (d: FeedbackDraft, via: "gh" | "browser"): Promise<FeedbackHits | null> => {
      // the browser path opens its tab in the click itself, so a popup blocker lets it through
      const tab = via === "browser" && !DEMO ? window.open("", "_blank") : null;
      try {
        const r = await post("/api/feedback/send", { title: d.title, body: d.body }, FeedbackSentSchema);
        if ("hits" in r) {
          tab?.close();
          return r.hits;
        }
        if (r.via === "gh") {
          tab?.close();
          toast(fmt(w.saidFeedbackSent, { url: r.url }));
        } else {
          if (tab) {
            tab.opener = null;
            tab.location.href = r.url;
          } else window.open(r.url, "_blank", "noopener");
          toast(w.saidFeedbackOpened);
        }
        ui.closeDrawer();
      } catch (e) {
        tab?.close();
        toast(e instanceof Error ? e.message : String(e));
      }
      return null;
    },
    /** Report: the self-check's diagnostic, nothing private in it, written to a local file. */
    selfCheckReport: () =>
      guard(false, async () => {
        const r = await post("/api/selfcheck/report", {}, z.object({ path: z.string() }));
        toast(fmt(w.saidReported, { path: r.path }));
      }),
    /** Reload: a fresh self-check, then the page again. */
    selfCheckReload: () =>
      guard(false, async () => {
        await post("/api/selfcheck/run", {}, z.object({}).loose());
        window.location.reload();
      }),
    /** Drops a held finding for good. */
    heldDismiss: (id: string) =>
      guard(false, async () => {
        await post("/api/finding/dismiss", { id }, Ok);
        toast(w.saidHeldDismissed);
        refresh();
      }),
    /** Has the project's agent write or refresh its onboarding guide on the next pass: a PR, or on watch a report. */
    guideRun: (project: string) =>
      guard(false, async () => {
        await post("/api/guide/run", { project }, Ok);
        toast(later(fmt(w.saidGuide, { project })));
        refresh();
      }),
    /** Copies the guide's link on the code host (the PR while it's a draft) for the team. */
    guideShare: (link: string) =>
      guard(false, async () => {
        await navigator.clipboard.writeText(link);
        toast(fmt(w.saidGuideCopied, { link }));
      }),
    /** Sends a status update channel a test now (Settings, and Health beside a failed send). */
    updateTest: (id: string, name: string) =>
      guard(false, async () => {
        await post("/api/updates/test", { id }, Ok);
        toast(fmt(w.updatesTested, { name }));
      }),
    /** Lets the daemon run git in a checkout a run flagged, after you looked and confirmed. */
    gitAllow: (dir: string) =>
      guard(false, async () => {
        const at = dir === "*" ? w.alGitBlockedAll : dir;
        if (!(await ui.confirm({ title: w.confirmGitAllowTitle, body: fmt(w.confirmGitAllow, { dir: at }), go: w.alGitAllow }))) return;
        await post("/api/git/allow", { path: dir }, Ok);
        toast(fmt(w.saidGitAllowed, { dir: at }));
        refresh();
      }),
    selfUpdate: () =>
      guard(false, async () => {
        if (!(await ui.confirm({ title: w.confirmUpdateTitle, body: w.confirmUpdate, go: w.confirmUpdateGo, tone: "primary" }))) return;
        const r = await post("/api/self-update", {}, SelfUpdateResultSchema);
        toast(r.message);
      }),
  };
}
