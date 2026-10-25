/**
 * One small vocabulary (issue #98): project, agent, task, pull request, Needs you, Night report, quiet and safety. The
 * words Overhand retired for those ideas fail here wherever a person reads them: the interface's words, the demo's
 * text, the site and its docs, the setup guide and the skill. Code, commands and config keys may keep them, so text
 * inside `code`, <code>, <pre>, {placeholders}, tags and links is left out, and in code only literals with a space in
 * them (sentences, not identifiers) are read.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import { plainWords } from "../packages/themes/src/words";

const ROOT = join(import.meta.dir, "..");
const PAGES = ["site/pages/**/*.{html,md}", "skills/**/*.md", "README.md"];
const CODE = ["site/site.ts", "apps/web/src/demo/*.ts", "packages/contract/src/*.ts"];

/** Each retired word, and what says the same in the eight words. */
const RETIRED: readonly (readonly [RegExp, string])[] = [
  [/\bleads?\b/i, "an agent on a project (a project agent)"],
  [/\btickets?\b/i, "task, or issue for the tracker's item"],
  [/\b(un)?arm(s|ed|ing)?\b/i, "queue, queued"],
  [/\bnext pass\b/i, "soon"],
  [/\bthe cast\b/i, "agents"],
  [/\bcrews?\b/i, "agents"],
  [/\boverdrive\b/i, "Start everything"],
  [/\bfix rounds?\b/i, "round of fixes"],
  [/\bplaces\b/i, "views, or projects"],
  [/\bslightly bored\b/i, "standing by"],
  [/\bno CI\b/i, "no checks"],
  [/\bkeychain\b/i, "secret store"],
  [/\bPRs\b/, "pull requests"],
  [/\bPlan and warn only\b/, "Look only"],
  [/\bShip\b/, "Merge when green"],
];

/** "PR" is for tight app labels only: a phrase of this many words or more says "pull request". */
const PR_LABEL_WORDS = 4;

/** What a reader sees: code, commands, placeholders, tags and links taken out. */
function readable(text: string): string {
  return text
    .replace(/<(script|style|code|pre)[\s\S]*?<\/\1>/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/```[\s\S]*?```|`[^`\n]*`/g, " ")
    .replace(/\{\{[^}]*\}\}|\{[^}]*\}/g, " ")
    .replace(/\]\([^)]*\)|https?:\/\/\S+/g, " ");
}

/** Where a text uses a retired word: "file: the word, in: the words around it (say: what instead)". */
function findings(file: string, text: string): string[] {
  const seen = readable(text).replace(/\s+/g, " ").trim();
  const around = (at: number) => seen.slice(Math.max(0, at - 30), at + 40);
  const out = RETIRED.flatMap(([re, say]) => {
    const m = seen.match(re);
    return m ? [`${file}: "${m[0]}", in: ${around(m.index ?? 0)} (say: ${say})`] : [];
  });
  const words = seen.split(" ").filter((w) => /[a-z]/i.test(w)).length;
  const pr = seen.search(/\bPR\b/);
  if (pr >= 0 && words >= PR_LABEL_WORDS) out.push(`${file}: "PR" in a sentence, in: ${around(pr)} (say: pull request)`);
  return out;
}

/** A line of the day's log in the daemon's own format (an emoji, a key, then its words): parsed back, not copy. */
const LOG_LINE = /^\p{Extended_Pictographic}/u;

/**
 * The literals in code that read as text: quoted and template strings with a space in them (a template's `${…}`
 * reads as "$"), comments left out, days-log lines too. A small scanner, so quotes inside `${…}` don't pair up wrong.
 */
function literals(code: string): string[] {
  const out: string[] = [];
  /** Scans code from `i` until an unmatched `}` (inside `${…}`) or the end; returns where it stopped. */
  const scan = (from: number): number => {
    let depth = 0;
    for (let i = from; i < code.length; i++) {
      const c = code[i];
      if (c === "/" && code[i + 1] === "/") i = code.indexOf("\n", i) < 0 ? code.length : code.indexOf("\n", i);
      else if (c === "/" && code[i + 1] === "*") i = code.indexOf("*/", i + 2) < 0 ? code.length : code.indexOf("*/", i + 2) + 1;
      else if (c === "/" && /(^|[(,=:[!&|?{};]|return)\s*$/.test(code.slice(Math.max(0, i - 8), i))) {
        // a regex literal: skip it, classes included, so its quotes aren't read as strings
        let j = i + 1;
        for (let inClass = false; j < code.length && code[j] !== "\n" && (inClass || code[j] !== "/"); j++) {
          if (code[j] === "\\") j++;
          else if (code[j] === "[") inClass = true;
          else if (code[j] === "]") inClass = false;
        }
        i = j;
      } else if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < code.length && code[j] !== c && code[j] !== "\n") j += code[j] === "\\" ? 2 : 1;
        out.push(code.slice(i + 1, j));
        i = j;
      } else if (c === "`") {
        let text = "";
        let j = i + 1;
        while (j < code.length && code[j] !== "`") {
          if (code[j] === "\\") {
            text += code.slice(j, j + 2);
            j += 2;
          } else if (code[j] === "$" && code[j + 1] === "{") {
            text += "$";
            j = scan(j + 2) + 1;
          } else text += code[j++];
        }
        out.push(text);
        i = j;
      } else if (c === "{") depth++;
      else if (c === "}" && depth-- === 0) return i;
    }
    return code.length;
  };
  scan(0);
  return out.filter((s) => s.includes(" ") && !LOG_LINE.test(s));
}

/** Every finding across the words, the pages and the code literals. */
function sweep(): string[] {
  const out = Object.entries(plainWords).flatMap(([key, word]) => findings(`words.ts ${key}`, word));
  for (const pattern of PAGES)
    for (const file of new Glob(pattern).scanSync({ cwd: ROOT })) {
      const src = readFileSync(join(ROOT, file), "utf8");
      for (const part of src.split(/\n\s*\n|(?<=[.!?])\s+/)) out.push(...findings(file, part));
    }
  for (const pattern of CODE)
    for (const file of new Glob(pattern).scanSync({ cwd: ROOT }))
      if (!file.endsWith(".test.ts")) for (const s of literals(readFileSync(join(ROOT, file), "utf8"))) out.push(...findings(file, s));
  return [...new Set(out)];
}

test("no retired word is left where people read it", () => {
  expect(sweep()).toEqual([]);
});

test("the check catches a retired word and lets code keep it", () => {
  expect(findings("a.html", "<p>Arm the lead for the next pass.</p>").length).toBe(3);
  expect(findings("a.html", "<p>Run <code>overhand lead</code> to start it.</p>")).toEqual([]);
  expect(findings("words.ts x", "Open PR")).toEqual([]);
  expect(findings("words.ts x", "The agent opened a PR for you")).toEqual([
    'words.ts x: "PR" in a sentence, in: The agent opened a PR for you (say: pull request)',
  ]);
  // code keeps its words: a kind, a path, a regex; a template's own quotes don't pair with the next string
  const code = ['const k = "lead"; const r = /"x/; f(`$', '{n ? "a" : " "} the lead waits`, "/api/lead/log");'].join("");
  expect(literals(code)).toEqual([" ", "$ the lead waits"]);
});
