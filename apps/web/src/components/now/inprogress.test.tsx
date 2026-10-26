import { expect, test } from "bun:test";
import { plainWords as w } from "@overhand/themes";
import type { Model } from "@/app/data";
import { fmt } from "@/lib/format";
import { render, withDom } from "../render.test-util";
import { doneOf, groupsOf, InProgress, type Row, rowsOf } from "./InProgress";

/** In progress: every agent at work in one list, each row with its time and Open, today's finished runs folded away. */
withDom();

const NOW = Date.now();
const withRun = (m: Model): Model => ({
  ...m,
  s: {
    ...m.s,
    running: [{ name: "SHOP-142", account: "work", cwd: "/code/shop", startedAt: NOW - 12 * 60_000, pid: 9100, model: "", mode: "" }],
    runs: [
      ...m.s.runs,
      { name: "SHOP-140", key: "SHOP-140", project: "Online shop", start: NOW - 3_600_000, end: NOW - 60_000, cost: 0.4, ok: true },
    ],
  },
});

test("a task run is a row of its own: its project, how long it has run, its Stop and Open", async () => {
  const body = await render((m) => <InProgress m={withRun(m)} />);
  const row = body.querySelector('li[data-id="run:9100"]');
  expect(row?.textContent).toContain("Online shop: ");
  expect(row?.textContent).toContain("12 min");
  expect([...(row?.querySelectorAll("button") ?? [])].map((b) => b.textContent)).toEqual([w.stopLead, w.open]);
});

test("project agents at work, sessions and the agents' pull requests share the one list; Open goes where each lives", async () => {
  const body = await render((m) => {
    const rows = rowsOf(m, NOW, w);
    const running = m.s.godmode.filter((g) => g.running && (g.supervised || g.inbox));
    expect(rows.filter((r) => r.id.startsWith("lead:")).map((r) => r.id)).toEqual(running.map((g) => `lead:${g.key}`));
    for (const p of m.s.prs) expect(rows.find((r) => r.id === p.key)?.open).toEqual({ kind: "review", key: p.key });
    return <InProgress m={m} />;
  });
  expect(body.querySelector('[data-id="in-progress"]')).not.toBeNull();
});

test("today's finished runs fold into Done today, newest first, behind one line", async () => {
  let n = 0;
  const body = await render((m) => {
    const done = doneOf(withRun(m), NOW);
    n = done.length;
    expect(done[0]?.open).toEqual({ kind: "ticket", key: "SHOP-140" });
    return <InProgress m={withRun(m)} />;
  });
  const fold = body.querySelector("details");
  expect(fold?.hasAttribute("open")).toBe(false);
  expect(fold?.querySelector("summary")?.textContent).toBe(fmt(w.doneToday, { n }));
});

test("with nobody at work it says so plainly", async () => {
  const body = await render((m) => <InProgress m={{ ...m, s: { ...m.s, running: [], godmode: [], sessions: [], prs: [], guides: [] } }} />);
  expect(body.textContent).toContain(w.emptyInProgress);
});

test("the field's In progress groups rows by project in first-seen order, work in no project last", () => {
  const row = (id: string, project: string): Row => ({ id, project, text: id, meta: "", open: { kind: "crew" } });
  const g = groupsOf([row("a", ""), row("b", "Shop"), row("c", "App"), row("d", "Shop")]);
  expect(g.map(([p, rows]) => [p, rows.map((r) => r.id)])).toEqual([
    ["Shop", ["b", "d"]],
    ["App", ["c"]],
    ["", ["a"]],
  ]);
});
