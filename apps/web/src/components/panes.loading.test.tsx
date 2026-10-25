import { expect, test } from "bun:test";
import type { ReactNode } from "react";
import { render, withDom } from "./render.test-util";

/**
 * Every pane, section and drawer that fetches, rendered for real while its request never answers: each shows skeleton
 * blocks (`data-slot="skeleton"`) in its content's shape and nothing that spins; the whole app, before its first
 * state, shows the one loader. Now, Work, Crew and Health read only the state, so their loading is the app's loader.
 * loading.test.tsx stays as a tripwire over the source for anything new.
 */

withDom();

/** What a spinner looks like once rendered. */
const SPINNER = '.animate-spin, .animate-pulse, .m-scan, [class*="lucide-loader"], [role="progressbar"]:not([aria-valuenow])';

/** The pane draws skeletons and nothing spins. */
function loadsWithSkeleton(el: HTMLElement, name: string) {
  expect(el.querySelectorAll('[data-slot="skeleton"]').length, `${name}: skeleton`).toBeGreaterThan(0);
  expect(el.querySelector(SPINNER), `${name}: spinner`).toBeNull();
}

test("the whole app, before its first state: the one loader, no spinner", async () => {
  const { App } = await import("@/App");
  const el = await render(() => <App />, true);
  expect(el.querySelector("[data-loader]")).not.toBeNull();
  expect(el.querySelector(SPINNER)).toBeNull();
});

test("reaching your computer from the phone: the one loader", async () => {
  const { Hosted } = await import("./Hosted");
  const el = await render(() => <Hosted>{null}</Hosted>, true);
  expect(el.querySelector("[data-loader]")).not.toBeNull();
  expect(el.querySelector(SPINNER)).toBeNull();
});

test("Setup while it looks: the loader on the scan, skeletons where the projects will be", async () => {
  const { Setup } = await import("./Setup");
  const el = await render(() => <Setup />);
  expect(el.querySelector(".m-handover")).not.toBeNull();
  loadsWithSkeleton(el, "Setup");
});

test("every pane, section and drawer that fetches shows skeletons while it loads", async () => {
  const { AddAccount } = await import("./AddAccount");
  const { AddProjects } = await import("./AddProjects");
  const { Checkup } = await import("./Checkup");
  const { Connections } = await import("./Connections");
  const { Phone } = await import("./Phone");
  const { DecisionCard } = await import("./DecisionCard");
  const { SweepDrawer } = await import("./drawers/SweepDrawer");
  const { SettingsDrawer } = await import("./drawers/SettingsDrawer");
  const { ReviewDrawer } = await import("./drawers/ReviewDrawer");
  const { LeadDrawer } = await import("./drawers/LeadDrawer");
  const { ShareDrawer } = await import("./share/ShareDrawer");
  const { TeamSettings } = await import("./team/TeamSettings");
  const { OrganiseStep } = await import("./organise/OrganiseStep");
  const panes: [string, (m: import("@/app/data").Model) => ReactNode, boolean?][] = [
    ["Settings (any tab, before the config)", () => <SettingsDrawer />, true],
    ["Settings › Accounts › add an account", () => <AddAccount />],
    ["Settings › Projects › add projects", () => <AddProjects onReady={() => {}} />],
    ["Settings › Phone", () => <Phone />],
    ["Settings › Team", () => <TeamSettings />],
    ["Services", () => <Connections />],
    ["Check-up", () => <Checkup />],
    ["Needs you › a decision's brief", (m) => <DecisionCard m={m} item={`pr:${m.s.prs[0]?.key ?? "x"}`} compact />],
    ["Review drawer", (m) => <ReviewDrawer m={m} ticketKey={m.s.prs[0]?.key ?? "x"} />, true],
    ["Lead drawer › live output", (m) => <LeadDrawer m={m} leadKey={m.s.godmode[0]?.key ?? "x"} />, true],
    ["Clean up drawer", () => <SweepDrawer />, true],
    ["Share drawer", () => <ShareDrawer span="night" />, true],
    ["Organise › setup step", () => <OrganiseStep onDone={() => {}} />],
  ];
  const missing: string[] = [];
  for (const [name, ui, drawer] of panes) {
    const el = await render(ui, false, drawer);
    if (!el.querySelector('[data-slot="skeleton"]')) missing.push(`${name}: no skeleton`);
    if (el.querySelector(SPINNER)) missing.push(`${name}: a spinner`);
  }
  expect(missing).toEqual([]);
});

test("Health › Work reports: an opened report shows skeletons while it builds", async () => {
  const { act } = await import("react");
  const { WorkReports } = await import("./health/Reports");
  const el = await render((m) => <WorkReports m={m} />);
  const open = [...el.querySelectorAll("button")].find((b) => b.getAttribute("aria-expanded") === "false");
  expect(open, "a report to open").toBeDefined();
  await act(async () => open?.click());
  loadsWithSkeleton(el, "Work reports");
});

test("the brief's Undo ends the Ship sentence it belongs to and never wraps onto the next one", async () => {
  const { Prologue } = await import("./now/Story");
  const { plainWords } = await import("@overhand/themes");
  const el = await render((m) => <Prologue m={m} />);
  const undo = [...el.querySelectorAll("button")].find((b) => b.textContent === plainWords.shipUndo);
  expect(undo).toBeDefined();
  // it can't wrap apart from its sentence's last word, so a line break can only come after it
  const tie = undo?.parentElement;
  expect(tie?.matches(".whitespace-nowrap") ?? false).toBe(true);
  expect(tie?.textContent ?? "").toMatch(new RegExp(`^\\S+\\.\u00a0${plainWords.shipUndo}$`));
});

/** What the site's live pieces (piece.tsx) find in the real panes, with their data in. */
test('Needs you is findable by the site\'s pages as data-id="needs" (the live window zooms toward it)', async () => {
  const { NeedsYou } = await import("./now/Alerts");
  const el = await render((m) => <NeedsYou m={m} />);
  expect(el.querySelector('section.hud-pane[data-id="needs"]')).not.toBeNull();
});

test("the short review (the review piece) keeps its preview review, what to check before merging and the proof, and only those", async () => {
  const { ReviewDrawer } = await import("./drawers/ReviewDrawer");
  const { demoGet } = await import("@/demo/fixtures");
  const { plainWords: w } = await import("@overhand/themes");
  const pr = demoGet("/api/pr/review?key=BOOK-88");
  const preview = demoGet("/api/preview/review?key=BOOK-88");
  const el = await render((m) => <ReviewDrawer m={m} ticketKey="BOOK-88" onPreview short />, false, true, [
    [["pr-review", "BOOK-88"], pr],
    [["preview-review", "BOOK-88"], preview],
  ]);
  const sections = [...el.querySelectorAll("section[aria-label]")].map((x) => x.getAttribute("aria-label"));
  expect(sections).toEqual(expect.arrayContaining([w.pvTitle, w.cornersTitle, w.proofTitle]));
  const heads = [...el.querySelectorAll("h3")].map((x) => x.textContent);
  for (const gone of [w.reviewSummary, w.reviewChecks]) expect(heads).not.toContain(gone);
  expect(heads.some((h) => h?.startsWith(w.reviewChanges))).toBe(false);
});
