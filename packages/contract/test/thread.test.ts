import { expect, test } from "bun:test";
import { MESSAGE_NOTE, openPart, openText, sectionHeading, threadOf } from "../src/index";

const at = (stamp: string) => Date.parse(`${stamp.replace(" ", "T")}:00Z`);

test("every heading reads as who wrote it: you, Overhand, the lead's reply, report and question", () => {
  const file = [
    "## Which issue next?\n\nBoth #12 and #13 are ready.\nOptions: #12 | #13",
    "## Answer from Sam (2026-10-23 09:00)\n\nDo #13 first",
    "## Answer from Sam (given outside Overhand, 2026-10-23 09:10)\n\nTalked to Ann",
    "## Answer from Sam (from Ann, on the team, 2026-10-23 09:15)\n\nYes",
    "## Answer from Overhand (no reply in 4 h, 2026-10-23 13:00)\n\nGo with your default: I keep both",
    "## Report (2026-10-23 14:00)\n\nTwo flaky tests.",
    "## Answer from Sam (message, 2026-10-23 15:00)\n\nWhy is #4 a draft?",
    "## Reply (2026-10-23 15:20)\n\nCI is red; fixing it.",
    "## Ship it (today)?\n\nReady.",
  ].join("\n\n");
  expect(threadOf(file).map((e) => [e.who, e.kind, e.title, e.at])).toEqual([
    ["lead", "question", "Which issue next?", 0],
    ["you", "answer", "", at("2026-10-23 09:00")],
    ["you", "answer", "", at("2026-10-23 09:10")],
    ["you", "answer", "", at("2026-10-23 09:15")],
    ["overhand", "answer", "", at("2026-10-23 13:00")],
    ["lead", "report", "", at("2026-10-23 14:00")],
    ["you", "message", "", at("2026-10-23 15:00")],
    ["lead", "reply", "", at("2026-10-23 15:20")],
    ["lead", "question", "Ship it (today)?", 0],
  ]);
  expect(threadOf(file)[7]?.body).toBe("CI is red; fixing it.");
  // a heading that only starts like Overhand's is the lead's question
  expect(threadOf("## Replying to Ann\n\nOk?")[0]).toMatchObject({ who: "lead", kind: "question", title: "Replying to Ann" });
  // a message from a teammate, on your behalf, is still a message
  expect(threadOf("## Answer from Sam (message, from Ann, on the team, 2026-10-23 16:00)\n\nhi")[0]?.kind).toBe("message");
  // what Overhand writes reads back as itself
  const written = `${sectionHeading("Answer from Sam", MESSAGE_NOTE, new Date(at("2026-10-23 15:00")))}\n\nhi`;
  expect(written.startsWith("## Answer from Sam (message, 2026-10-23 15:00)")).toBe(true);
  expect(threadOf(written)[0]).toMatchObject({ who: "you", kind: "message", at: at("2026-10-23 15:00"), body: "hi" });
});

test("a file with no headings is one question from the lead; text before the first heading is the lead's", () => {
  expect(threadOf("Should I ship? I'd wait.")).toEqual([
    { who: "lead", kind: "question", title: "", at: 0, body: "Should I ship? I'd wait." },
  ]);
  expect(threadOf("  \n\n")).toEqual([]);
  expect(threadOf("Note first.\n\n## Q?\n\nBody").map((e) => [e.who, e.title, e.body])).toEqual([
    ["lead", "", "Note first."],
    ["lead", "Q?", "Body"],
  ]);
});

test("what's open is everything the lead wrote after the newest answer, message or reply", () => {
  const t = threadOf("## Old?\n\nx\n\n## Answer from Sam (a)\n\ny\n\n## Report (b)\n\nr\n\n## New?\n\nz");
  expect(openPart(t).map((e) => e.title || e.kind)).toEqual(["report", "New?"]);
  expect(openPart(threadOf("## Answer from Sam (message, a)\n\nhi\n\n## Reply (b)\n\nhello"))).toEqual([]);
  expect(openText("## Answer from Sam (message, a)\n\nhi\n\n## Reply (b)\n\nhello\n\n## Ship?\n\nReady.")).toBe("## Ship?\n\nReady.");
});
