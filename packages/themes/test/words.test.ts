import { expect, test } from "bun:test";
import { plainWords, allWorlds as themes, type WordKey } from "../src/index";

/**
 * What each themed noun means. `term` keys name the thing (by their head noun, the last word: "Agent instructions"
 * names instructions); `uses` keys mention it. A theme may not give two meanings
 * the same word, and a label about one thing may not borrow another thing's word unless it also names its own
 * ("Agent PRs" names PRs, so it may say "agent").
 */
const MEANINGS: Record<string, { term: WordKey[]; uses: WordKey[] }> = {
  ticket: { term: ["ticket"], uses: ["newTicket", "viewWork", "briefSomeTicket"] },
  project: { term: ["instAllProjects"], uses: ["instNone"] },
  needs: { term: ["paneAlerts"], uses: ["storyThingsOne", "storyThingsMany", "stBlocked", "viewNow"] },
  crew: {
    term: ["agent", "lead"],
    uses: [
      "agents",
      "leads",
      "kindAgent",
      "kindLead",
      "storyCrewOne",
      "storyCrewMany",
      "paneAgents",
      "storyCast",
      "viewCrew",
      "assignAgent",
    ],
  },
  pr: { term: ["pr"], uses: ["storyPrs", "stageReview"] },
  mine: { term: ["paneMine"], uses: ["stMine"] },
  brief: { term: ["briefMe"], uses: ["briefKicker"] },
  health: { term: ["viewHealth"], uses: [] },
  systems: { term: ["paneSystems"], uses: [] },
  account: { term: ["account"], uses: ["paneAccounts"] },
  instructions: { term: ["instTitle"], uses: [] },
  instructionProblems: { term: ["instChecks"], uses: ["instFlagged"] },
  guide: { term: ["guideTitle"], uses: ["guideEmpty", "guideVerbatim", "upGuide"] },
  spend: { term: ["paneSpend"], uses: [] },
  checkup: { term: ["paneCheckup"], uses: [] },
  quiet: { term: ["quiet"], uses: ["quietEnd", "stateQuiet"] },
  team: { term: ["teamTitle"], uses: ["teamBrief"] },
  // the control room: every session on the machine, and the requests and actions between them
  sessions: { term: ["paneSessions"], uses: [] },
  requests: { term: ["paneRequests"], uses: [] },
};

/** Words that carry no meaning of their own. */
const STOP = new Set(
  "a an the of for on in to and or your you my me i all no one yet is are it its this that today with by at what should do overhand n"
    .split(" ")
    .filter(Boolean),
);

/** A label's content words in order, singular and lower case, placeholders dropped. */
function list(label: string): string[] {
  const out: string[] = [];
  for (const raw of label
    .replace(/\{\w+\}/g, " ")
    .toLowerCase()
    .split(/[^a-z']+/)) {
    const w = raw.replace(/'s$/, "");
    if (!w || STOP.has(w)) continue;
    out.push(w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
  }
  return out;
}
const words = (label: string) => new Set(list(label));
const head = (label: string) => list(label).at(-1) ?? "";

const has = (k: string): k is WordKey => k in plainWords;

for (const theme of themes) {
  const term = (m: string) => new Set((MEANINGS[m]?.term ?? []).map((k) => head(theme.words[k])));

  test(`${theme.id}: one word, one meaning`, () => {
    const names = Object.keys(MEANINGS);
    for (const k of names.flatMap((m) => [...(MEANINGS[m]?.term ?? []), ...(MEANINGS[m]?.uses ?? [])]))
      expect(has(k) && plainWords[k].length > 0, `${k} has a plain meaning`).toBe(true);
    for (const a of names)
      for (const b of names) {
        if (a >= b) continue;
        const shared = [...term(a)].filter((w) => term(b).has(w));
        expect(shared, `${theme.id}: "${shared.join(", ")}" means both ${a} and ${b}`).toEqual([]);
      }
    for (const [m, { uses }] of Object.entries(MEANINGS))
      for (const k of uses) {
        const ws = words(theme.words[k]);
        const own = [...term(m)].some((w) => ws.has(w));
        for (const other of names) {
          if (other === m || own) continue;
          const borrowed = [...term(other)].filter((w) => ws.has(w));
          expect(borrowed, `${theme.id}: ${k} ("${theme.words[k]}") is about ${m} but says ${other}'s word`).toEqual([]);
        }
      }
  });

  test(`${theme.id}: "deploy" only ever means a production deploy`, () => {
    const real = new Set<WordKey>([
      "checking",
      "alDeployFailed",
      "alDeployFailedSay",
      "decOpenDeploy",
      "leadWhyCi",
      "leadWhyCiOne",
      "leadWatchesCi",
    ]);
    for (const [k, v] of Object.entries(theme.words))
      if (has(k) && !real.has(k)) expect(/\bdeploy/i.test(v), `${theme.id}: ${k} says "${v}"`).toBe(false);
  });
}
