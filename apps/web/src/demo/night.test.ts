import { expect, test } from "bun:test";
import { tierOf } from "@overhand/contract";
import { plainWords, themeById, worldById } from "@overhand/themes";
import { beats, restarts } from "@/lib/beats";
import { briefing } from "@/lib/briefing";
import { parsePlan } from "@/lib/plan";
import { MOMENTS, minutesOf } from "./moments";
import { clockAt, NIGHT_MINUTES, nightAt } from "./night";

test("the night's named moments are the one source the site's pages are timed by", () => {
  // site/build.ts fills {{at_call}} etc. from these; the call really waits from 07:24
  expect(minutesOf(MOMENTS.call)).toBe(474);
  expect(minutesOf(MOMENTS.morning)).toBe(510);
  const asks = (m: number) => JSON.stringify(nightAt(m)).includes("remind guests by email");
  expect(asks(minutesOf(MOMENTS.call) - 1)).toBe(false);
  expect(asks(minutesOf(MOMENTS.call))).toBe(true);
});

test("every minute of the night is a valid dashboard state", () => {
  for (let m = 0; m <= NIGHT_MINUTES; m += 7) expect(() => nightAt(m)).not.toThrow();
});

test("the night tells its story in order", () => {
  const dusk = nightAt(0);
  expect(dusk.reports).toHaveLength(0);
  expect(dusk.running).toHaveLength(0);

  const late = nightAt(60); // 00:30, the first agent is at work
  expect(late.running.map((r) => r.name)).toEqual(["SHOP-142"]);

  const loop = nightAt(135); // 01:45, Company website's lead restarted three times and rests
  expect(restarts(beats(loop.reports)).get("Company website lead")).toBe(3);

  const morning = nightAt(510); // 08:00
  expect(morning.prs).toHaveLength(4); // the agents' own, Mobile app's first win among them; Sam's open PRs are listed too
  // Online shop is on Ship: SHOP-142 merged by itself once its checks passed, and waits in the shipped list with Undo
  expect(morning.prs.some((p) => p.key === "SHOP-142")).toBe(false);
  expect(morning.shipped).toMatchObject([{ key: "SHOP-142", project: "Online shop", revert: "" }]);
  expect(morning.reports.some((l) => l.includes("SHOP-142 PR merged on Ship"))).toBe(true);
  expect(nightAt(minutesOf("00:55")).prs.find((p) => p.key === "SHOP-142")?.ship).toEqual({ on: true, why: "" });
  expect(morning.godmode.find((g) => g.key === "mobile")?.open).toBe(true);
  // a calm morning: cost well under the daily cap, two questions, and the merged ticket no longer counted as to start
  expect(morning.billed).toBeLessThan(morning.budgetUsd / 2);
  expect(morning.godmode.filter((g) => g.open).map((g) => g.key)).toEqual(["mobile"]);
  expect(JSON.stringify(morning.tickets)).not.toContain("SHOP-142");
  expect(briefing(morning, parsePlan(morning.plan), [], plainWords, new Date(clockAt(510)), () => 0)).not.toContain("queued");
  expect(morning.reports.every((l) => /^- 0\d:\d\d|^- 2[34]:\d\d/.test(l))).toBe(true);
});

test("Mobile app's first win runs as the night begins, ticking through its steps, then is done with its cost", () => {
  const at = (hm: string) => nightAt(minutesOf(hm));
  expect(at("23:30").firstWin).toMatchObject({ state: "queued", since: 0 }); // found, not started yet
  expect(at("23:32").firstWin).toMatchObject({ state: "running", step: "change" });
  expect(at("23:32").running.map((r) => r.name)).toEqual(["APP-0"]);
  expect(at("23:34").firstWin?.step).toBe("pr");
  const done = at("23:40");
  expect(done.firstWin).toMatchObject({ state: "pr", cost: 0.3, billing: "plan" });
  expect(done.prs.find((p) => p.key === "APP-0")?.proof?.checks.every((c) => c.ok)).toBe(true);
});

test("the sample month scores every project and suggests Codex on Company website", () => {
  const s = nightAt(510);
  expect(s.scorecard.month.projects.map((p) => p.project)).toEqual(["Booking app", "Company website", "Mobile app", "Online shop"]);
  expect(s.scorecard.month.projects.find((p) => p.project === "Company website")?.best).toBe("codex/default");
  expect(s.routing.suggestions).toEqual([expect.objectContaining({ project: "Company website", account: "Codex", to: "codex/default" })]);
});

test("the four sample places remember different pasts, and the brief names the newest milestone", () => {
  const s = nightAt(510);
  const by = (name: string) => s.progression.projects.find((p) => p.name === name);
  // long-lived, with its 100th merge yesterday evening
  expect(tierOf(by("Online shop")?.merges ?? 0)).toBe(7);
  expect(by("Online shop")?.milestones.map((m) => m.id)).toContain("merge-100");
  // a clean week behind it
  expect(by("Booking app")?.cleanWeeks).toBeGreaterThan(0);
  // its last agent run failed and nothing has fixed it
  expect(by("Company website")?.scars.map((k) => k.kind)).toEqual(["run"]);
  // young: joined last night, so no week (clean or not) behind it yet, and its scorecard is that one night
  expect(tierOf(by("Mobile app")?.merges ?? 0)).toBeLessThanOrEqual(2);
  expect(by("Mobile app")?.milestones.map((m) => m.id)).not.toContain("clean-week");
  expect(s.scorecard.month.projects.find((p) => p.project === "Mobile app")?.rows.reduce((n, r) => n + r.runs, 0)).toBe(6);
  expect(s.progression.season).toBe("autumn");
  const said = briefing(s, parsePlan(s.plan), [], themeById("overhand").words, new Date(clockAt(510)), () => 0);
  expect(said).toContain("Online shop reached its 100th merge: a flag now flies at its quarter.");
  const cats = briefing(s, parsePlan(s.plan), [], worldById("catnap").words, new Date(clockAt(510)), () => 0);
  // the milestone is news, not flavour: it reads the same in every world
  expect(cats).toContain("Online shop reached its 100th merge: a flag now flies at its quarter.");
});
