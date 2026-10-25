import { beforeEach, expect, test } from "bun:test";
import type { FirstWin as Win } from "@overhand/contract";
import { plainWords as w } from "@overhand/themes";
import type { Model } from "@/app/data";
import { render, withDom } from "../render.test-util";
import { FirstWin } from "./FirstWin";

/** The first win's card: steps ticking over while it runs, tonight's cards beside them, and a done state of its own. */
withDom();
beforeEach(() => localStorage.clear());

const at = (m: Model, win: Partial<Win>): Model => {
  const base = m.s.firstWin;
  if (!base) throw new Error("the sample morning has a first win");
  return { ...m, s: { ...m.s, firstWin: { ...base, ...win } } };
};

test("while it runs, the card ticks through the steps the run reached and sets up tonight", async () => {
  const body = await render((m) => <FirstWin m={at(m, { state: "running", step: "checks", url: "", message: "" })} />);
  const steps = [...body.querySelectorAll("ol li")].map((li) => [li.textContent, li.getAttribute("aria-current")]);
  expect(steps).toEqual([
    [w.winStepRead, null],
    [w.winStepChange, null],
    [w.winStepChecks, "step"],
    [w.winStepPr, null],
  ]);
  const text = body.textContent ?? "";
  expect(text).toContain(w.tonightTitle);
  expect(text).toContain("08:00"); // the night report's default hour, before Settings answers
  expect(text).toContain(w.autonomyActName); // Mobile app's level, shown, not asked
  expect(text).not.toContain(w.winPr);
});

test("done is its own state: in green, with time and cost, what changed, the proof in words, and Review", async () => {
  const body = await render((m) => <FirstWin m={m} />);
  const text = body.textContent ?? "";
  expect(body.querySelector(".text-ok")?.textContent).toBe(w.winPr);
  expect(text).toContain("4 min · about $0.30 of your plan");
  expect(text).toContain("1 file, +38 −0");
  expect(text).toContain("The tests ran and passed.");
  expect([...body.querySelectorAll("button")].some((b) => b.textContent === w.review)).toBe(true);
  expect(body.querySelector("ol")).toBeNull(); // the steps are over
});

test("a card accepted once is gone, in this browser", async () => {
  localStorage.setItem("overhand-tonight", JSON.stringify(["report", "queue", "howFar"]));
  const body = await render((m) => <FirstWin m={at(m, { state: "running", step: "read" })} />);
  expect(body.textContent).not.toContain(w.tonightTitle);
});
