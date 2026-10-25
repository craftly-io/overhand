import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DISMISS_TEXT, ELSEWHERE_TEXT } from "@overhand/contract";
import { answerFromTerminal } from "../src/daemon";
import { CFG, OPS, OWNER, today, UI_PORT } from "../src/env";
import {
  appendAnswer,
  autoDefault,
  blankLead,
  type Godmode,
  heldOnQuestion,
  inboxPathOf,
  leadAsk,
  leadInbox,
  leadName,
  leadNotice,
  openQuestions,
  openRefs,
  questionDefault,
  RECHECK_HOURS,
  RECHECK_TEXT,
  recheckQuestion,
  recordLeadExit,
  refsIn,
  trackQuestion,
  unwatchQuestions,
  watchQuestions,
} from "../src/leads";
import { handle } from "../src/server";
import { loadNames, saveName } from "../src/state";
import { status } from "../src/status/types";
import { localRequest } from "./local";

const HOUR = 3_600_000;
const lead: Godmode = {
  key: "answers-test",
  label: "Answers test lead",
  name: "",
  dir: "answers-test",
  project: "Acme",
  goal: "",
  prompt: "",
  supervised: false, // the supervisor never starts a real agent from these tests
  onDemand: false,
  account: "",
  fallbackToAll: true,
  lockFile: "",
  lockStaleMin: 45,
  inboxFile: "",
  restartAfterMin: 5,
  maxCrashesPerHour: 3,
  answerWaitHours: 4,
  pushBranches: [],
};
const file = inboxPathOf(lead);
const ask = (text: string) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const QUESTION = "## Which issue next?\n\nBoth #12 and #13 are ready.\nI recommend #12.\n\nIf there's no answer: I start #12 next run\n";
const saved = { godmode: CFG.godmode, status: { ...status } };

beforeAll(() => {
  CFG.godmode = [...CFG.godmode, lead];
});
afterAll(() => {
  CFG.godmode = saved.godmode;
  Object.assign(status, saved.status);
  unwatchQuestions();
  rmSync(dirname(file), { recursive: true, force: true });
});

test("a question's default is its last 'If there's no answer:' line, however it's dressed", () => {
  expect(questionDefault(QUESTION)).toBe("I start #12 next run");
  expect(questionDefault("## Q\n\nWhat now?\nI'd wait.\n")).toBe("");
  const multi = [
    "## Payment provider",
    "",
    "We need one for refunds.",
    "- Stripe: cheaper",
    "- Adyen: what they use today",
    "",
    "**If there's no answer:** I keep Adyen and move on.",
  ].join("\n");
  expect(questionDefault(multi)).toBe("I keep Adyen and move on.");
  expect(questionDefault("## Q\nIf there is no answer: skip it\n\nIf there’s no answer: ship it")).toBe("ship it");
  expect(questionDefault("## Q\n- if there's no answer: leave it")).toBe("leave it");
});

test("open questions are the sections after the newest answer, reports left out", () => {
  expect(openQuestions("Just a line")).toEqual(["Just a line"]);
  expect(openQuestions("# Inbox\n\n## Q1\nA?\n\n## Answer from Sam (x)\n\nyes\n")).toEqual([]);
  expect(
    openQuestions("## Q1\nA?\n\n## Answer from Sam (x)\n\nyes\n\n## Q2\nB?\n\n## Report (x)\nfine").map((q) => q.split("\n")[0]),
  ).toEqual(["## Q2"]);
});

test("an unanswered question goes with its default after answerWaitHours, once, and not before", () => {
  ask(QUESTION);
  const st = { ...blankLead(), waiting: true };
  const box = leadInbox(lead);
  const at = (box?.at ?? 0) + 60_000; // Overhand first sees it a minute after it was written
  expect(trackQuestion(st, box, null, at)).toBe(true);
  expect(st.question?.at).toBe(box?.at ?? -1);
  expect(leadAsk(lead, st, box, null, at)?.deadline).toBe(at + 4 * HOUR);
  expect(autoDefault(lead, st, box, at + 4 * HOUR - 1)).toBe("");
  expect(heldOnQuestion(st, leadInbox(lead))).toBe(true);
  expect(autoDefault(lead, st, box, at + 4 * HOUR)).toBe("I start #12 next run");
  const text = readFileSync(file, "utf8");
  expect(text).toContain("## Answer from Overhand (no reply in 4 h, ");
  expect(text).toContain("Go with your default: I start #12 next run");
  const after = leadInbox(lead);
  expect(after?.open).toBe(false);
  expect(st.inboxAt).toBe(after?.at ?? -1); // seen: the answer doesn't notify you that the lead needs you
  expect(heldOnQuestion(st, after)).toBe(false); // so the supervisor resumes it
  expect(autoDefault(lead, st, after, at + 9 * HOUR)).toBe(""); // once
});

test("no default, or answerWaitHours 0, waits for you", () => {
  ask("## Which issue next?\n\nI'm not sure.\n");
  const st = blankLead();
  const box = leadInbox(lead);
  trackQuestion(st, box, null);
  const at = box?.at ?? 0;
  expect(leadAsk(lead, st, box, null, at)).toMatchObject({ default: "", deadline: 0, stale: null });
  expect(autoDefault(lead, st, box, at + 100 * HOUR)).toBe("");
  ask(QUESTION);
  const forever = { ...lead, answerWaitHours: 0 };
  const box2 = leadInbox(forever);
  trackQuestion(st, box2, null);
  expect(leadAsk(forever, st, box2, null)?.deadline).toBe(0);
  expect(autoDefault(forever, st, box2, (box2?.at ?? 0) + 100 * HOUR)).toBe("");
  expect(readFileSync(file, "utf8")).not.toContain("Answer from");
});

test("a question with no default is sent back once after RECHECK_HOURS to re-check and re-ask with a default", () => {
  ask("## Which issue next?\n\nI'm not sure.\n");
  const st = blankLead();
  const box = leadInbox(lead);
  const seen = 1_000_000;
  trackQuestion(st, box, null, seen);
  expect(leadAsk(lead, st, box, null, seen)?.recheck).toBe(seen + RECHECK_HOURS * HOUR);
  expect(recheckQuestion(lead, st, box, seen + RECHECK_HOURS * HOUR - 1)).toBe(false);
  expect(recheckQuestion(lead, st, box, seen + RECHECK_HOURS * HOUR)).toBe(true);
  const after = leadInbox(lead);
  expect(after?.open).toBe(false);
  expect(after?.text).toContain(RECHECK_TEXT);
  // closed: nothing left to send back
  expect(recheckQuestion(lead, st, after, seen + 10 * RECHECK_HOURS * HOUR)).toBe(false);
  // a question with a default is never sent back: it goes with its default instead
  ask(QUESTION);
  const st2 = blankLead();
  const box2 = leadInbox(lead);
  trackQuestion(st2, box2, null, seen);
  expect(leadAsk(lead, st2, box2, null, seen)?.recheck).toBe(0);
  expect(recheckQuestion(lead, st2, box2, seen + 100 * HOUR)).toBe(false);
});

test("a question already old when Overhand first sees it gets the whole wait and one heads-up, never an instant answer", () => {
  ask(QUESTION);
  utimesSync(file, new Date(Date.now() - 26 * HOUR), new Date(Date.now() - 26 * HOUR)); // asked 26 h ago, e.g. before an upgrade
  const st = { ...blankLead(), waiting: true, inboxAt: 1 };
  const box = leadInbox(lead);
  const first = Date.now();
  const notice = leadNotice(lead, st, box, first);
  expect(notice?.title).toBe(
    `${lead.label} goes with its default at ${new Date(first + 4 * HOUR).toTimeString().slice(0, 5)} unless you answer`,
  );
  expect(notice?.body).toBe("I start #12 next run");
  expect(autoDefault(lead, st, box, first)).toBe(""); // not on the first tick
  expect(autoDefault(lead, st, box, first + 4 * HOUR - 1)).toBe("");
  for (const t of [1, 2, 3]) expect(leadNotice(lead, st, leadInbox(lead), first + t * HOUR)).toBeNull(); // one heads-up only
  expect(leadAsk(lead, st, box, null, first)?.stale).toEqual({ closed: [], hours: 26 }); // its age is still the file's
  expect(autoDefault(lead, st, box, first + 4 * HOUR)).toBe("I start #12 next run");
});

test("a lead's first look at an answered or default-less file doesn't notify; a new question without a default says who asks", () => {
  ask("## Q\n\nWhat now?\n");
  const st = blankLead();
  expect(leadNotice(lead, st, leadInbox(lead))).toBeNull();
  ask("## Q\n\nWhat now?\n\n## Q2\n\nAnd then?\n");
  utimesSync(file, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  expect(leadNotice(lead, st, leadInbox(lead))?.title).toBe(`Question from ${lead.label}`);
});

test("issues and PRs a question names, and the ones that closed since it was asked", () => {
  expect(refsIn("See #12, acme/shop#7 and https://github.com/acme/api/pull/40; not ## or a#b").sort()).toEqual([
    "#12",
    "acme/api#40",
    "acme/shop#7",
  ]);
  const pr = (repo: string, number: number) => ({
    client: "Acme",
    repo,
    number,
    title: "",
    url: `https://github.com/${repo}/pull/${number}`,
    draft: false,
    review: "",
    checks: "",
    updated: "",
  });
  Object.assign(status, { at: 0, myPrs: [], reviews: [] });
  expect(openRefs("Acme")).toBeNull(); // nothing read yet: nothing can be said
  Object.assign(status, { at: Date.now(), myPrs: [pr("acme/shop", 12), pr("acme/shop", 13)], reviews: [] });
  ask(QUESTION);
  const st = blankLead();
  const box = leadInbox(lead);
  trackQuestion(st, box, openRefs("Acme"));
  expect(st.question?.seenOpen.sort()).toEqual(["#12", "#13"]);
  expect(leadAsk(lead, st, box, openRefs("Acme"))?.stale).toBeNull();
  status.myPrs = [pr("acme/shop", 13)]; // #12 merged
  trackQuestion(st, box, openRefs("Acme"));
  expect(leadAsk(lead, st, box, openRefs("Acme"))?.stale).toEqual({ closed: ["#12"], hours: 0 });
  // a day old is out of date by age alone
  status.myPrs = [pr("acme/shop", 12), pr("acme/shop", 13)];
  expect(leadAsk(lead, st, box, openRefs("Acme"), (box?.at ?? 0) + 25 * HOUR)?.stale).toEqual({ closed: [], hours: 25 });
});

const origin = `http://127.0.0.1:${UI_PORT}`;
const post = (body: object) =>
  handle(
    localRequest(`${origin}/api/lead/answer`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

test("'I answered elsewhere' and Dismiss record what happened and close the question", async () => {
  ask(QUESTION);
  expect((await post({ key: lead.key, kind: "elsewhere" })).status).toBe(200);
  let text = readFileSync(file, "utf8");
  expect(text).toContain(`## Answer from ${OWNER} (given outside Overhand, `);
  expect(text).toContain(ELSEWHERE_TEXT);
  expect(leadInbox(lead)?.open).toBe(false);
  expect((await post({ key: lead.key, kind: "dismiss" })).status).toBe(409); // nothing open to dismiss

  ask(QUESTION);
  expect((await post({ key: lead.label, kind: "elsewhere", text: "Do #13 first" })).status).toBe(200);
  expect(readFileSync(file, "utf8")).toMatch(/## Answer from .+ \(given outside Overhand, .+\)\n\nDo #13 first\n$/);

  ask(QUESTION);
  expect((await post({ key: lead.key, kind: "dismiss" })).status).toBe(200);
  text = readFileSync(file, "utf8");
  expect(text).toMatch(new RegExp(`## Answer from ${OWNER} \\(\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d\\)\\n\\n${DISMISS_TEXT}\\n$`));
  expect(leadInbox(lead)?.open).toBe(false);
  expect((await post({ key: lead.key, kind: "nope" })).status).toBe(409);
});

test("overhand answer answers through the daemon's API, by key or label, or with the lead's default", async () => {
  // a stand-in daemon on a free port: the real one (4317) is never touched
  const server = Bun.serve({
    port: 0,
    fetch: async (req) =>
      handle(
        localRequest(`${origin}${new URL(req.url).pathname}`, {
          method: req.method,
          headers: { origin: req.headers.get("origin") ?? "", "content-type": "application/json" },
          body: await req.text(),
        }),
      ),
  });
  const base = `http://127.0.0.1:${server.port}`;
  try {
    ask(QUESTION);
    const r = await answerFromTerminal([lead.label, "Go", "with", "#13"], base);
    expect(r.ok).toBe(true);
    expect(readFileSync(file, "utf8")).toMatch(/## Answer from .+\n\nGo with #13\n$/);

    ask(QUESTION);
    expect((await answerFromTerminal([lead.key, "--default"], base)).ok).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("Go with your default: I start #12 next run");

    ask("## No default here\n\nWhat now?\n");
    const none = await answerFromTerminal([lead.key, "--default"], base);
    expect(none.ok).toBe(false);
    expect(none.message).toContain("gives no default");

    expect((await answerFromTerminal(["no-such-lead", "hi"], base)).message).toContain("no lead named no-such-lead");
    expect((await answerFromTerminal([lead.key], base)).message).toContain("usage:");
  } finally {
    server.stop(true);
  }
});

test("an answer written to the questions file wakes the supervisor within seconds", async () => {
  ask(QUESTION);
  const st = { ...blankLead(), waiting: true };
  expect(heldOnQuestion(st, leadInbox(lead))).toBe(true);
  const woke = new Promise<boolean>((resolve) => {
    // an earlier write may still arrive as an event first: wait for the one that answers it
    watchQuestions(() => heldOnQuestion(st, leadInbox(lead)) || resolve(false), 50);
    setTimeout(() => resolve(true), 5000); // never woke: fails below
  });
  await Bun.sleep(100);
  const t0 = Date.now();
  appendAnswer(lead, "Sam", "Go with #13", "typed in an editor");
  expect(await woke).toBe(false); // the held lead's question is answered, so this tick resumes it
  expect(Date.now() - t0).toBeLessThan(3000);
  unwatchQuestions();
});

test("a lead you renamed goes by your name in its pushes and in the activity log, and back to its label when cleared", () => {
  saveName(`lead:${lead.key}`, "Night watch");
  try {
    expect(leadName(lead)).toBe("Night watch");
    ask("## Ship it?\n\nReady.\n");
    const st = { ...blankLead(), inboxAt: 1 };
    expect(leadNotice(lead, st, leadInbox(lead))?.title).toBe("Question from Night watch");
    const g = { ...lead, key: `${lead.key}-log` };
    saveName(`lead:${g.key}`, "Night watch two");
    recordLeadExit(g, { ...blankLead(), startedAt: Date.now() - 60 * 60_000 }, null, 0, `code 0 ${Date.now()}`);
    const log = readFileSync(`${OPS}/reports/${today()}.md`, "utf8");
    expect(log).toContain("⚡ Night watch two exited");
    expect(log).not.toContain(`⚡ ${lead.label} exited`);
  } finally {
    saveName(`lead:${lead.key}`, "");
    saveName(`lead:${lead.key}-log`, "");
  }
  expect(leadName(lead)).toBe(lead.label);
});

test("a rename keeps the names before it, newest first, so older log lines still name the lead", () => {
  const id = "lead:history-test";
  saveName(id, "Night watch");
  saveName(id, "Day watch");
  saveName(id, "Night watch"); // back to an old one: it leaves the history
  expect(loadNames()[id]).toBe("Night watch");
  expect(loadNames()[`${id}#was`]).toBe("Day watch");
  saveName(id, "");
  expect(loadNames()[id]).toBeUndefined();
  expect(loadNames()[`${id}#was`]).toBe("Night watch\nDay watch");
});
