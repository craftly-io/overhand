import { expect, test } from "bun:test";
import { plainWords as w } from "@overhand/themes";
import type { Model } from "@/app/data";
import { render, withDom } from "../render.test-util";
import { Cast } from "./Cast";

/** The cast: every agent run that's working has its own Stop, as a lead does. */
withDom();

const running = (m: Model, names: string[]): Model => ({
  ...m,
  s: {
    ...m.s,
    running: names.map((name, i) => ({
      name,
      account: "work",
      cwd: `/code/shop/.claude/worktrees/${name.toLowerCase()}`,
      startedAt: Date.now() - 60_000,
      pid: 9000 + i,
      model: "",
      mode: "",
    })),
  },
});

test("each running agent run has a Stop button of its own", async () => {
  const body = await render((m) => <Cast m={running(m, ["SHOP-142", "SHOP-142-fix"])} />);
  const rows = [...body.querySelectorAll("li[data-id]")].filter((li) => li.getAttribute("data-id")?.startsWith("SHOP-142"));
  expect(rows.map((li) => li.getAttribute("data-id"))).toEqual(["SHOP-142", "SHOP-142-fix"]);
  for (const li of rows) expect([...li.querySelectorAll("button")].map((b) => b.textContent)).toContain(w.stopLead);
});
