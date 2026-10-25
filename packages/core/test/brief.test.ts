import { expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { composeBrief, milestoneLine, morningBrief, nightCounts } from "../src/brief";
import { CFG, OPS } from "../src/env";

test("a brief missed while the machine slept goes out when it wakes, once that day", () => {
  const marker = join(OPS, ".brief-sent");
  rmSync(marker, { force: true });
  const at = CFG.schedule.briefAtHour;
  CFG.schedule.briefAtHour = 7;
  try {
    morningBrief(new Date(2026, 9, 19, 6, 59));
    expect(existsSync(marker)).toBe(false);
    morningBrief(new Date(2026, 9, 19, 10, 15)); // asleep from 6 to 10
    expect(readFileSync(marker, "utf8")).toBe("2026-10-19");
  } finally {
    CFG.schedule.briefAtHour = at;
    rmSync(marker, { force: true });
  }
});

test("a brief switched off (-1) never goes out", () => {
  const marker = join(OPS, ".brief-sent");
  rmSync(marker, { force: true });
  const at = CFG.schedule.briefAtHour;
  CFG.schedule.briefAtHour = -1;
  try {
    morningBrief(new Date(2026, 9, 19, 12, 0));
    expect(existsSync(marker)).toBe(false);
  } finally {
    CFG.schedule.briefAtHour = at;
  }
});

test("the night is yesterday from 18:00 plus today", () => {
  const yesterday = ["- 17:59 🎉 HONEY-1 PR merged", "- 18:00 🎉 HONEY-2 PR merged", "- 23:10 ✗ HONEY-3 attempt 1: tests red"];
  const today = ["- 02:00 🆕 Honeycrust: web#4 opened: Add login", "- 03:00 ✅ HONEY-5 (main, $1.20) → https://x", "- 07:00 💤 Lead rests"];
  expect(nightCounts(yesterday, today)).toEqual({ merged: 1, opened: 2, failed: 1, shipped: 0 });
});

test("a Ship merge is told in the brief, with where its Undo is", () => {
  const night = ["- 19:00 🎉 HONEY-2 PR merged on Ship https://github.com/o/r/pull/2", "- 20:00 🎉 HONEY-3 PR merged"];
  expect(nightCounts(night, [])).toEqual({ merged: 2, opened: 0, failed: 0, shipped: 1 });
  expect(composeBrief({ merged: 2, opened: 0, failed: 0, waiting: 0, billedYesterday: 0, shipped: 1 })?.body).toBe(
    "Overnight: 2 pull requests merged. 1 merged by itself once its checks were green; Undo is in Overhand.",
  );
  expect(composeBrief({ merged: 1, opened: 0, failed: 0, waiting: 0, billedYesterday: 0, shipped: 1 })?.body).toContain(
    "It merged by itself",
  );
});

test("the brief tells the night and what needs you in its title, the detail and cost beneath", () => {
  expect(composeBrief({ merged: 2, opened: 1, failed: 0, waiting: 1, billedYesterday: 12.5 })).toEqual({
    title: "3 pull requests overnight, 1 needs you",
    body: "Overnight: 2 pull requests merged, 1 new pull request. Yesterday was billed about $12.50, an estimate.",
  });
  expect(composeBrief({ merged: 0, opened: 1, failed: 0, waiting: 0, billedYesterday: 0 })?.title).toBe(
    "1 pull request overnight, nothing needs you",
  );
  expect(composeBrief({ merged: 0, opened: 0, failed: 2, waiting: 0, billedYesterday: 0 })?.title).toBe(
    "2 runs failed overnight, nothing needs you",
  );
  expect(composeBrief({ merged: 0, opened: 0, failed: 0, waiting: 2, billedYesterday: 0 })?.title).toBe("2 things need you");
  expect(composeBrief({ merged: 0, opened: 0, failed: 0, waiting: 0, billedYesterday: 1 })).toEqual({
    title: "A quiet night",
    body: "No agent activity overnight. Yesterday was billed about $1.00, an estimate.",
  });
});

test("corners to check and guardrail blocks each get one line, and alone still make a brief", () => {
  expect(composeBrief({ merged: 0, opened: 1, failed: 0, waiting: 1, billedYesterday: 0, toCheck: 1, blocked: 2 })?.body).toBe(
    "Overnight: 1 new pull request. 1 pull request has something to check before merging. The guardrails blocked 2 actions.",
  );
  expect(composeBrief({ merged: 0, opened: 0, failed: 0, waiting: 0, billedYesterday: 0, blocked: 1 })).toEqual({
    title: "A quiet night",
    body: "No agent activity overnight. The guardrails blocked 1 action.",
  });
});

test("a milestone gets one line, and alone still makes a brief", () => {
  const milestone = milestoneLine("Honeycrust", "merge-100");
  expect(milestone).toBe("Honeycrust reached its 100th merge.");
  expect(composeBrief({ merged: 1, opened: 0, failed: 0, waiting: 0, billedYesterday: 0, milestone })?.body).toBe(
    "Overnight: 1 pull request merged. Honeycrust reached its 100th merge.",
  );
  expect(composeBrief({ merged: 0, opened: 0, failed: 0, waiting: 0, billedYesterday: 0, milestone })?.title).toBe("A quiet night");
});

test("a night with nothing to tell sends no brief", () => {
  expect(composeBrief({ merged: 0, opened: 0, failed: 0, waiting: 0, billedYesterday: 0 })).toBeNull();
});
