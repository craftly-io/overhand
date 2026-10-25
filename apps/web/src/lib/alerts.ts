import {
  type ActionCard,
  budgetNotice,
  comboLabel,
  type DashboardState,
  type Finding,
  isNewerVersion,
  type Lead,
  questionLine,
  RUNTIME_NAMES,
  repoPulls,
} from "@overhand/contract";
import type { WordKey, Words } from "@overhand/themes";
import { type AssignOffer, canAssign, isAssigned, onWatch, reportTitle } from "./assign";
import { cornerWord } from "./corners";
import { answerDetail } from "./decide";
import { type Explained, explainPlan } from "./explain";
import { ago, fmt, hm, minutesUntil, pct, times } from "./format";
import type { Plan } from "./plan";
import { leadName } from "./sessions";
import { billingLabel, budgetApplies } from "./spend";

/** What clicking an alert does. */
type AlertTarget =
  | { kind: "link"; url: string }
  | { kind: "ticket"; key: string }
  | { kind: "lead"; key: string }
  | { kind: "review"; key: string }
  | { kind: "notes" }
  | { kind: "update" }
  | { kind: "sweep" }
  | { kind: "settings"; tab: string; project?: string }
  /** An account to sign in once in its own folder: its Sign in button, right on the card. */
  | { kind: "signin"; account: string; tool: string }
  /** The Slack inbox's Slack sign-in expired: open it again in Claude Code. */
  | { kind: "slack" }
  /** The daemon's work loop stopped: Restart Overhand. */
  | { kind: "restart" }
  /** Today's plan failed: plan again. */
  | { kind: "replan" }
  /** A plugin's finding or failed run whose fix is to run it again. */
  | { kind: "plugin"; name: string }
  /** No daemon git in `dir` ("*" = every checkout) until you allow it again, after looking. */
  | { kind: "git"; dir: string }
  /** A lead that crashed out: Start it again, or open its log. */
  | { kind: "crashed"; key: string }
  /** A lead whose start fails on `account` before it runs: fix that account, then Try again. */
  | { kind: "cantstart"; key: string; account: string }
  /** Today's budget is used up: raise it to `usd` in one click. */
  | { kind: "raise"; usd: number }
  | { kind: "rule"; id: string; project: string }
  /** Something held for you on a watch project instead of posted: Post it (when it has a ticket and a comment) or Dismiss. */
  | { kind: "held"; id: string; key: string; post: boolean }
  /** Something the outward firewall stopped: Edit and post, Post anyway, Dismiss. */
  | { kind: "leak"; finding: Finding }
  /** The dashboard failed its own render check: Report, Reload. */
  | { kind: "selfcheck" }
  /** A control-room action card: its buttons are what Overhand does, with your authority. */
  | { kind: "card"; card: ActionCard }
  /** Quiet mode for `hours`: heavy jobs wait while you need the laptop (a meeting starting soon). */
  | { kind: "quiet"; hours: number };

export interface Alert {
  /** 3 = act now, 2 = soon, 1 = for your information. */
  sev: 1 | 2 | 3;
  /** Something is broken (red), as opposed to waiting on you (amber) or for your information. */
  broken?: true;
  title: string;
  sub: string;
  /** The line the spoken briefing uses; absent when it isn't worth saying out loud. */
  say?: string;
  /** More lines under `sub` (a lead question's default and deadline, or why it may be out of date). */
  notes?: string[];
  /** On a watch or propose project: Assign an agent to build what this is about. */
  assign?: AssignOffer;
  /** A lead question that may no longer apply, so it offers Dismiss. */
  stale?: true;
  /** What it means in plain words, behind its ? (a plan from a request you started). */
  explain?: Explained;
  /** The words on its button when its target only opens a place (a link, settings, notes); else the place's own. */
  go?: string;
  /** The item it's about, as its decision card names it (`ticket:EW-1`, `lead:core`, `ci:Proj/repo@main`); snoozable. */
  item?: string;
  target: AlertTarget;
}

const list = <T>(x: T[] | string): T[] => (Array.isArray(x) ? x : []);

/** PRs grouped by repo name (the part after "owner/"), in first-seen order. */
function byRepo<P extends { repo: string }>(ps: readonly P[]): Map<string, P[]> {
  const m = new Map<string, P[]>();
  for (const p of ps) {
    const repo = p.repo.split("/")[1] ?? p.repo;
    m.set(repo, [...(m.get(repo) ?? []), p]);
  }
  return m;
}

/** What's broken across projects, the Health count: red builds and new errors. Facts, so they live in Health, not Needs you. */
export function brokenCount(s: Pick<DashboardState, "status">): number {
  return s.status.ci.filter((c) => c.state === "fail").length + list(s.status.sentry).filter((i) => i.isNew).length;
}

/** What the firewall marked in a held message, in words: "a secret", the word and whose it is. */
function leakTerms(f: Finding, w: Words): string {
  const said = (f.leak?.hits ?? []).map((h) => (h.why === "secret" ? w.leakSecret : `"${h.term}"${h.project ? ` (${h.project})` : ""}`));
  return [...new Set(said)].join(", ");
}

/**
 * What a lead's open question says beyond itself: why it may be out of date, and what happens if you don't answer
 * (its default and when Overhand goes with it, or that it waits for you).
 */
export function askNotes(ask: NonNullable<Lead["ask"]>, w: Words, now: number): string[] {
  const why = ask.stale
    ? [
        ask.stale.closed.length ? fmt(w.askStaleClosed, { refs: ask.stale.closed.join(", ") }) : "",
        ask.stale.hours ? fmt(w.askStaleOld, { h: ask.stale.hours }) : "",
      ]
        .filter(Boolean)
        .join("; ")
    : "";
  // with no default it can't go ahead on its own: Overhand asks the lead for one at `recheck` (leads.ts)
  // a paragraph-long default is said once, beside its "Go with the default" button: here only when it happens
  const long = answerDetail({ id: "answer-default", do: "answer", lead: "", text: `Go with your default: ${ask.default}` }) !== null;
  const next = !ask.default
    ? ask.recheck > now
      ? fmt(w.askNoDefaultUntil, { t: hm(ask.recheck) })
      : w.askNoDefault
    : !ask.deadline
      ? fmt(long ? w.askDefaultWaitsLong : w.askDefaultWaits, { default: ask.default })
      : ask.deadline > now
        ? fmt(long ? w.askDefaultAtLong : w.askDefaultAt, { t: hm(ask.deadline), default: ask.default })
        : fmt(long ? w.askDefaultLateLong : w.askDefaultLate, { default: ask.default });
  return [...(why ? [fmt(w.askStale, { why })] : []), next];
}

/**
 * What plugins need of you: one waiting for approval, changed since, or unreadable (Review it, in Settings), a failed
 * run (Run again), and each warn or bad finding with the fix it came with. Info findings stay in Health.
 */
export function pluginAlerts(plugins: DashboardState["plugins"], w: Words): Alert[] {
  return plugins.flatMap((p): Alert[] => {
    if (p.state === "waiting" || p.state === "changed" || p.state === "broken")
      return [
        {
          sev: 1,
          title: fmt(p.state === "waiting" ? w.alPluginWaiting : w.alPluginChanged, { name: p.name }),
          sub: p.state === "waiting" ? w.alPluginWaitingSub : p.state === "changed" ? w.plChanged : fmt(w.plBroken, { why: p.why }),
          go: w.alPluginReview,
          target: { kind: "settings", tab: "plugins" },
        },
      ];
    if (p.state !== "on") return [];
    if (p.last && !p.last.ok)
      return [
        { sev: 1, broken: true, title: fmt(w.alPluginFailed, { name: p.name }), sub: p.last.why, target: { kind: "plugin", name: p.name } },
      ];
    return p.findings
      .filter((f) => f.severity !== "info")
      .map(
        (f): Alert => ({
          sev: f.severity === "bad" ? 2 : 1,
          ...(f.severity === "bad" ? { broken: true } : {}),
          title: `${p.name}: ${f.title}`,
          sub: f.line,
          target: f.fix.kind === "link" ? { kind: "link", url: f.fix.url } : { kind: "plugin", name: p.name },
        }),
      );
  });
}

/** Each kind of action card's title and detail words. */
const CARD_WORDS: Record<ActionCard["kind"], [WordKey, WordKey]> = {
  "quiet-heavy": ["cardQuietHeavy", "cardQuietHeavySub"],
  "unmanaged-heavy": ["cardUnmanaged", "cardUnmanagedSub"],
  competing: ["cardCompeting", "cardCompetingSub"],
  "foreign-pr": ["cardForeignPr", "cardForeignPrSub"],
  "same-files": ["cardSameFiles", "cardSameFilesSub"],
  silent: ["cardSilent", "cardSilentSub"],
  overdue: ["cardOverdue", "cardOverdueSub"],
  strain: ["cardStrain", "cardStrainSub"],
};

/** An action card as a Needs you entry: the machine-wide ones act-now, the rest soon; noted when an approval covers it. */
function cardAlert(c: ActionCard, w: Words): Alert {
  const [title, sub] = CARD_WORDS[c.kind];
  const now = c.kind === "quiet-heavy" || c.kind === "unmanaged-heavy" || c.kind === "competing" || c.kind === "strain";
  return {
    sev: now ? 3 : 2,
    title: fmt(w[title], c.facts),
    sub: fmt(w[sub], c.facts),
    ...(c.auto ? { notes: [w.cardAuto] } : {}),
    item: `card:${c.id}`,
    target: { kind: "card", card: c },
  };
}

/** Everything that needs you, most urgent first. Pure: `now` is passed in. */
export function computeAlerts(s: DashboardState, plan: Plan, w: Words, now: number): Alert[] {
  const a: Alert[] = s.control.cards.map((c) => cardAlert(c, w));
  // a plan for a request you started blocks its agent like a question does, and you asked for it: right after the cards.
  // It changed nothing; its card says Go ahead, Change the plan or Drop it.
  for (const f of s.findings.filter((x) => !x.leak && x.task))
    a.push({
      sev: 3,
      title: fmt(w.alPlan, { title: s.assigned.find((t) => t.key === f.task)?.title ?? f.title }),
      sub: f.project,
      say: fmt(w.alPlanSay, { project: f.project }),
      explain: explainPlan(f.project, w),
      item: `held:${f.id}`,
      target: { kind: "held", id: f.id, key: "", post: false },
    });
  const st = s.status;
  for (const [client, tickets] of Object.entries(s.tickets)) {
    if (!Array.isArray(tickets)) {
      a.push({
        sev: 2,
        broken: true,
        title: fmt(w.alTrackerDown, { client }),
        sub: tickets.slice(0, 80),
        say: fmt(w.alTrackerDownSay, { client }),
        go: w.alTrackerFix,
        target: { kind: "settings", tab: "integrations", project: client },
      });
      continue;
    }
    for (const t of tickets)
      if (t.labels.includes(s.labels.blocked))
        a.push({
          sev: 3,
          title: fmt(s.splits[t.key] ? w.alSplitProposed : w.alNeedsAnswer, { key: t.key }),
          sub: t.title,
          say: fmt(w.alNeedsAnswerSay, { client }),
          item: `ticket:${t.key}`,
          target: { kind: "ticket", key: t.key },
          ...(canAssign(s, client) && !isAssigned(s, t.key) ? { assign: { project: client, key: t.key } } : {}),
        });
  }
  for (const d of list(st.deploys))
    if (/ERROR|CANCELED/.test(d.state))
      a.push({
        sev: 3,
        broken: true,
        title: fmt(w.alDeployFailed, { project: d.project }),
        sub: `${d.client} · ${ago(d.created, now)}`,
        say: fmt(w.alDeployFailedSay, { client: d.client }),
        go: w.decOpenDeploy,
        target: { kind: "link", url: d.url },
      });
  // red builds and new errors are facts, not decisions: Health counts and lists them (brokenCount). An agent's own PR
  // with failing checks still comes through its PR item; a failed deploy (above) still needs you.
  // an agent's PR opens in the Review drawer; anyone else's on GitHub
  const prTarget = (url: string): AlertTarget => {
    const mine = s.prs.find((p) => p.url === url);
    return mine ? { kind: "review", key: mine.key } : { kind: "link", url };
  };
  const prItem = (url: string) => {
    const mine = s.prs.find((p) => p.url === url);
    return mine ? `pr:${mine.key}` : `review:${url}`;
  };
  for (const p of s.prs) {
    // a PR whose diff may have cut a corner worth stopping for: one item, which also covers its review
    const block = p.corners.filter((c) => c.severity === "block");
    if (block.length)
      a.push({
        sev: 3,
        title: fmt(w.alCorners, { key: p.key }),
        sub: [...new Set(block.map((c) => `${cornerWord(w, c.kind)} · ${c.file}`))].join(", "),
        say: w.alCornersSay,
        item: `pr:${p.key}`,
        target: { kind: "review", key: p.key },
      });
    else if (p.draft)
      a.push({
        sev: 2,
        title: fmt(w.alReadyForReview, { key: p.key }),
        sub: st.myPrs.find((x) => x.url === p.url)?.title ?? p.branch,
        say: w.alReadyForReviewSay,
        item: `pr:${p.key}`,
        target: { kind: "review", key: p.key },
      });
  }
  for (const p of st.myPrs)
    if (/FAILURE|ERROR/.test(p.checks))
      a.push({
        sev: 3,
        broken: true,
        title: fmt(w.alChecksFailing, { repo: p.repo.split("/")[1] ?? p.repo, n: p.number }),
        sub: p.title,
        say: fmt(w.alChecksFailingSay, { client: p.client }),
        item: prItem(p.url),
        target: prTarget(p.url),
      });
  // your PRs with changes asked for, one item per repo: three in one repo are one job, not three calls
  for (const [repo, ps] of byRepo(st.myPrs.filter((p) => !/FAILURE|ERROR/.test(p.checks) && p.review === "CHANGES_REQUESTED"))) {
    const [one] = ps;
    if (!one) continue;
    a.push({
      sev: 2,
      title: ps.length > 1 ? fmt(w.alChangesRequestedMany, { n: ps.length, repo }) : fmt(w.alChangesRequested, { n: one.number }),
      sub: ps.length > 1 ? ps.map((p) => `#${p.number} ${p.title}`).join(" · ") : one.title,
      say: fmt(w.alChangesRequestedSay, { client: one.client }),
      item: ps.length > 1 ? `changes:${repo}` : prItem(one.url),
      target: ps.length > 1 ? { kind: "link", url: repoPulls(one.url, "author:@me") } : prTarget(one.url),
    });
  }
  // this checkout being behind lives in Settings → Look (a fact, not a call); an installed copy's release is the one
  // way its owner hears of an update: a calm note, no voice line; the update itself runs from a terminal
  if (isNewerVersion(s.update.latest, s.update.current))
    a.push({
      sev: 1,
      title: fmt(w.alRelease, { version: s.update.latest }),
      sub: fmt(w.alReleaseSub, { current: s.update.current, command: s.update.command }),
      go: w.confirmUpdateGo,
      target: { kind: "update" },
    });
  for (const g of s.godmode) {
    if (g.open && g.inbox)
      a.push({
        sev: 3,
        title: fmt(w.alLeadNeeds, { lead: leadName(g, s.names) }),
        sub: questionLine(g.inbox.text),
        say: fmt(w.alLeadNeedsSay, { lead: leadName(g, s.names) }),
        ...(g.ask ? { notes: askNotes(g.ask, w, now) } : {}),
        ...(g.ask?.stale ? { stale: true as const } : {}),
        item: `lead:${g.key}`,
        // a lead on watch reports and never builds: what it found can go to an agent, as a task of its own
        ...(onWatch(s, g.project)
          ? { assign: { project: g.project, title: `${leadName(g, s.names)}: ${reportTitle(g.inbox.text)}`, brief: g.inbox.text } }
          : {}),
        target: { kind: "lead", key: g.key },
      });
    if (g.supervised && !g.stopped && g.cantStart)
      a.push({
        sev: 3,
        broken: true,
        title: fmt(w.alLeadCantStart, { lead: leadName(g, s.names) }),
        sub: g.cantStart.why,
        say: fmt(w.alLeadCantStartSay, { lead: leadName(g, s.names) }),
        target: { kind: "cantstart", key: g.key, account: g.cantStart.account },
      });
    if (g.supervised && g.stopped && /crashed/.test(g.reason))
      a.push({
        sev: 3,
        broken: true,
        title: fmt(w.alLeadCrashed, { lead: leadName(g, s.names) }),
        sub: g.reason,
        say: fmt(w.alLeadCrashedSay, { lead: leadName(g, s.names) }),
        target: { kind: "crashed", key: g.key },
      });
  }
  // people waiting on a reply are listed one by one beside these (see `needs`), so they aren't summed up here;
  // reviews asked of you, one item per repo
  for (const [repo, ps] of byRepo(st.reviews)) {
    const [one] = ps;
    if (!one) continue;
    a.push({
      sev: 2,
      title: ps.length > 1 ? fmt(w.alReviewMany, { n: ps.length, repo }) : fmt(w.alReview, { repo, n: one.number }),
      sub: ps.length > 1 ? ps.map((p) => `#${p.number} ${p.title}`).join(" · ") : one.title,
      item: ps.length > 1 ? `reviews:${repo}` : `review:${one.url}`,
      target: { kind: "link", url: ps.length > 1 ? repoPulls(one.url, "review-requested:@me") : one.url },
    });
  }
  for (const e of list(st.calendar))
    if (!e.allDay && e.start > now && e.start - now < 15 * 60000) {
      const n = minutesUntil(e.start, now);
      a.push({
        sev: 2,
        title: fmt(w.alMeeting, { title: e.title, n }),
        sub: fmt(w.alMeetingSub, { start: hm(e.start), end: hm(e.end) }),
        say: fmt(w.alMeetingSay, { title: e.title, n }),
        // the laptop is needed for the call: hold heavy jobs until it's over
        target: { kind: "quiet", hours: 1 },
      });
    }
  // the scorecard's suggestion: calm, and only ever a pointer to the project's accounts
  for (const r of s.routing.suggestions)
    a.push({
      sev: 1,
      title: fmt(w.alRouteSuggest, { to: comboLabel(r.to), x: times(r.toRate, r.fromRate), project: r.project }),
      sub: fmt(w.alRouteSuggestSub, { toRate: pct(r.toRate), fromRate: pct(r.fromRate), from: comboLabel(r.from) }),
      target: { kind: "settings", tab: "projects", project: r.project },
    });
  // guidance you gave on two PRs, or once as a standing answer to a lead, offered as a rule: calm, answered in place (Add rule, Not now, Never)
  for (const r of s.rules)
    a.push({
      sev: 1,
      title: fmt(r.standing ? w.alRuleStanding : r.times === 2 ? w.alRuleTwice : w.alRuleTimes, { rule: r.rule, n: r.times }),
      sub: fmt(w.alRuleSub, { file: r.file }),
      target: { kind: "rule", id: r.id, project: r.project },
    });
  // what agents and the Slack inbox found on watch projects, held instead of posted: you decide what goes out or gets built
  if (!s.selfCheck.ok)
    a.push({
      sev: 3,
      broken: true,
      title: fmt(w.alSelfCheck, { error: s.selfCheck.error }),
      sub: w.alSelfCheckSub,
      say: w.alSelfCheckSay,
      target: { kind: "selfcheck" },
    });
  // what the outward firewall stopped: you decide whether it goes, edited or as it is
  for (const f of s.findings.filter((x) => x.leak))
    a.push({
      sev: 2,
      title: fmt(w.alLeak, { title: f.title }),
      sub: fmt(w.alLeakSub, { dest: f.leak?.dest ?? "", terms: leakTerms(f, w) }),
      say: fmt(w.alLeakSay, { dest: f.leak?.dest ?? "" }),
      target: { kind: "leak", finding: f },
    });
  for (const f of s.findings.filter((x) => !x.leak && !x.task))
    a.push({
      sev: 2,
      title: fmt(w.alHeld, { title: f.title }),
      sub: `${f.project} · ${f.text.split("\n").find((l) => l.trim()) ?? ""}`,
      say: fmt(w.alHeldSay, { project: f.project }),
      item: `held:${f.id}`,
      ...(canAssign(s, f.project) && !isAssigned(s, f.key) ? { assign: { project: f.project, id: f.id } } : {}),
      target: { kind: "held", id: f.id, key: f.key, post: Boolean(f.key && f.post) },
    });
  if (plan.notes.length) a.push({ sev: 1, title: w.alNotes, sub: plan.notes.join(" ").slice(0, 90), target: { kind: "notes" } });
  // the budget holds billed accounts (and ones not known yet) until tomorrow; Needs you is where you look for what's stopped
  if (s.budgetUsd > 0 && s.budgetSpent >= s.budgetUsd && budgetApplies(s))
    a.push({
      sev: 3,
      title: fmt(w.alBudget, { cap: `$${s.budgetUsd}` }),
      sub: budgetNotice(
        w,
        s.accounts.some((x) => !x.billingSure),
      ),
      say: w.alBudgetSay,
      target: { kind: "raise", usd: s.budgetUsd * 2 },
    });
  // an account the OS sandbox keeps off your own sign-in: red when no other account can carry its work
  const waiting = s.accounts.filter((x) => x.waitsSignIn);
  for (const acc of waiting) {
    const tool = RUNTIME_NAMES[acc.runtime] ?? acc.runtime;
    const others = waiting.length < s.accounts.length;
    a.push({
      sev: others ? 2 : 3,
      ...(others ? {} : { broken: true as const }),
      title: fmt(w.alSignIn, { account: acc.name }),
      sub: fmt(others ? w.alSignInSubOthers : w.alSignInSub, { tool }),
      say: fmt(w.alSignInSay, { account: acc.name }),
      target: { kind: "signin", account: acc.name, tool },
    });
  }
  if (s.slackSignIn?.clients.length)
    a.push({
      sev: 2,
      broken: true,
      title: fmt(w.alSlackSignIn, { clients: s.slackSignIn.clients.join(", ") }),
      sub: w.alSlackSignInSub,
      target: { kind: "slack" },
    });
  // an account whose billing isn't known counts toward the budget until the person says: asked once, until they pick
  for (const acc of s.accounts.filter((x) => !x.billingSure))
    a.push({
      sev: 2,
      title: fmt(w.alBillingAsk, { account: acc.name }),
      sub: fmt(w.alBillingAskSub, { guess: billingLabel(acc, w) }),
      say: fmt(w.alBillingAskSay, { account: acc.name }),
      target: { kind: "settings", tab: "accounts" },
    });
  // a fresh install's first day: one calm line on how careful it starts, while a project is still on propose
  if (s.dayOne && s.clients.some((c) => c.autonomy === "propose"))
    a.push({ sev: 1, title: w.alDayOne, sub: "", target: { kind: "settings", tab: "projects" } });
  if (s.disk && s.disk.freeGb < s.disk.floorGb)
    a.push({
      sev: 3,
      title: fmt(w.alDiskLow, { gb: s.disk.freeGb.toFixed(1) }),
      sub: w.alDiskLowSub,
      say: w.alDiskLowSay,
      item: "disk",
      target: { kind: "sweep" },
    });
  else if (s.disk && s.disk.freeGb < s.disk.warnGb)
    a.push({
      sev: 2,
      title: fmt(w.alDiskWarn, { gb: s.disk.freeGb.toFixed(1) }),
      sub: s.disk.freeGb < s.disk.heavyGb ? w.alDiskHeavySub : w.alDiskWarnSub,
      say: w.alDiskWarnSay,
      item: "disk",
      target: { kind: "sweep" },
    });
  if (s.sandboxRefuse)
    a.push({
      sev: 3,
      broken: true,
      title: w.alSandboxRefuse,
      sub: s.sandboxRefuse,
      say: w.alSandboxRefuseSay,
      go: w.alSandboxFix,
      target: { kind: "settings", tab: "system" },
    });
  // today's plan failed when its newest word is a failure, not "plan written"
  const planned = s.reports.findLastIndex((l) => l.includes("plan written"));
  if (s.reports.findLastIndex((l) => l.includes("plan failed")) > planned)
    a.push({ sev: 2, broken: true, title: w.alPlanFailed, sub: w.alPlanFailedSub, say: w.alPlanFailedSay, target: { kind: "replan" } });
  a.push(...pluginAlerts(s.plugins, w));
  for (const dir of s.gitBlocked)
    a.push({
      sev: 3,
      broken: true,
      title: dir === "*" ? w.alGitBlockedAll : fmt(w.alGitBlocked, { dir }),
      sub: w.alGitBlockedSub,
      target: { kind: "git", dir },
    });
  if (!s.daemon)
    a.push({
      sev: 3,
      broken: true,
      title: w.alOffline,
      sub: w.alOfflineSub,
      say: w.alOfflineSay,
      target: { kind: "restart" },
    });
  // what you snoozed from its decision card stays out until the snooze runs out
  return a.filter((x) => !x.item || !((s.snoozed[x.item] ?? 0) > now)).sort((x, y) => y.sev - x.sev);
}
