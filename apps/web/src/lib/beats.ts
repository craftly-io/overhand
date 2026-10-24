/** How a beat reads at a glance. */
export type BeatTone = "ok" | "bad" | "warn" | "info" | "quiet";

/** One moment of the day's story, told in words, from ops's activity log. */
export interface Beat {
  /** "09:16", or "09:16–11:09" for a loop folded into one beat. */
  time: string;
  text: string;
  tone: BeatTone;
  /** The lead or run the beat is about, when there is one. */
  who: string | null;
  /** How many restarts a folded loop holds; 1 for an ordinary beat. */
  count: number;
}

/** A run that ends this soon after it started counts as a restart, not as work done. */
const QUICK_MIN = 5;
/** Restarts closer together than this belong to one loop. */
const LOOP_GAP_MIN = 20;
/** A loop is told as one beat from this many restarts. */
const LOOP_MIN = 3;

type Parsed = Omit<Beat, "time" | "count"> & { kind: "start" | "quick" | "other" };

type Rule = [RegExp, (x: RegExpMatchArray, raw: string) => Parsed | null];
const said = (kind: Parsed["kind"], who: string | undefined, text: string, tone: BeatTone): Parsed => ({
  kind,
  who: who ?? null,
  text,
  tone,
});

/** Log line shapes ops writes, and the sentence each one tells. The first match wins. */
const RULES: Rule[] = [
  [/^new AI word /, () => null],
  [
    /^(.+?) started headless \(pid \d+(?:, ([\w.-]+))?\)$/,
    (x) => said("start", x[1], `${x[1]} woke up${x[2] ? ` on ${x[2]}` : ""}`, "info"),
  ],
  [
    /^(.+?) exited \((?:while Overhand was restarting|Overhand restart)\) after (\d+) min$/,
    (x) => said("other", x[1], `${x[1]} was cut off by an Overhand restart after ${x[2]} min`, "warn"),
  ],
  [
    // "(code 1)", "(0, sandboxed)", "(code 1, sandboxed, 2 sandbox refusals)": the exit code first, then notes
    /^(.+?) exited \((?:code )?(-?\d+)(?:, [^)]*)?\) after (\d+) min$/,
    (x) =>
      x[2] !== "0"
        ? said("other", x[1], `${x[1]} failed after ${x[3]} min`, "bad")
        : said(Number(x[3]) <= QUICK_MIN ? "quick" : "other", x[1], `${x[1]} finished after ${x[3]} min`, "quiet"),
  ],
  [
    /^(.+?) \(pid \d+\) ended while Overhand was restarting or detached$/,
    (x) => said("other", x[1], `${x[1]} lost its session when Overhand restarted`, "warn"),
  ],
  [
    /^(.+?): crashed (\d+) times within an hour, not restarting$/,
    (x) => said("other", x[1], `${x[1]} crashed ${x[2]} times in an hour, so Overhand stood it down`, "bad"),
  ],
  [
    /^(.+?) found nothing to do; next look in (\d+) min$/,
    (x) => said("other", x[1], `${x[1]} found nothing to do and rests for ${x[2]} min`, "quiet"),
  ],
  [/^answered (.+)$/, (x) => said("other", x[1], `You answered ${x[1]}`, "ok")],
  [/^(.+?) stopped from the dashboard$/, (x) => said("other", x[1], `You stopped ${x[1]}`, "quiet")],
  [/^([A-Z][A-Z0-9]+-\d+) created from Slack: (.+)$/, (x) => said("other", undefined, `New ticket ${x[1]} from Slack: ${x[2]}`, "info")],
  [/^inbox: (\d+) items? \(/, (x) => said("other", undefined, `Slack checked: ${x[1]} new item${x[1] === "1" ? "" : "s"}`, "quiet")],
  [/^plan written: (\d+) agent tasks? ready/, (x) => said("other", undefined, `Today's plan is ready: ${x[1]} tasks for the agents`, "ok")],
  [/^([A-Z][A-Z0-9]+-\d+) \([^)]*\) → (\S+)/, (x) => said("other", undefined, `${x[1]} shipped a pull request`, "ok")],
  [/^settings saved/, () => said("other", undefined, "You saved the settings", "quiet")],
  // your pull requests, as the status refresh sees them change (leads open theirs under your account)
  [/^(.+?): (\S+#\d+) opened: (.+)$/, (x) => said("other", undefined, `${x[1]}: new pull request ${x[2]}, ${x[3]}`, "info")],
  [/^(.+?): (\S+#\d+) checks failing: (.+)$/, (x) => said("other", undefined, `${x[1]}: checks went red on ${x[2]}, ${x[3]}`, "bad")],
  [/^(.+?): (\S+#\d+) changes requested: (.+)$/, (x) => said("other", undefined, `${x[1]}: reviewers want changes on ${x[2]}`, "warn")],
  [/^(.+?): (\S+#\d+) approved: (.+)$/, (x) => said("other", undefined, `${x[1]}: ${x[2]} was approved`, "ok")],
  [/^(.+?): (\S+#\d+) merged: (.+)$/, (x) => said("other", undefined, `${x[1]}: ${x[2]} merged, ${x[3]}`, "ok")],
  [/^(.+?): (\S+#\d+) closed: (.+)$/, (x) => said("other", undefined, `${x[1]}: ${x[2]} was closed unmerged`, "quiet")],
  // the ticket agent's own pull requests
  [/^([A-Z][A-Z0-9]+-\d+) PR merged$/, (x) => said("other", undefined, `${x[1]}'s pull request merged`, "ok")],
  [
    /^([A-Z][A-Z0-9]+-\d+) PR merged on Ship \S+$/,
    (x) => said("other", undefined, `${x[1]}'s pull request merged on Ship, CI green`, "ok"),
  ],
  [/^([A-Z][A-Z0-9]+-\d+) PR closed$/, (x) => said("other", undefined, `${x[1]}'s pull request was closed unmerged`, "quiet")],
  [
    /^([A-Z][A-Z0-9]+-\d+) fix round (\d+) \([^)]*\): (.+)$/,
    (x, raw) => said("other", undefined, `${x[1]} fix round ${x[2]}: ${x[3]}`, raw.startsWith("✗") ? "bad" : "info"),
  ],
];

/** Turns one log line's text (after its time) into a sentence, or null for chatter that tells no story. */
export function parseLine(raw: string): Parsed | null {
  const t = raw.replace(/^[^\p{L}\p{N}]+/u, "").trim();
  for (const [re, tell] of RULES) {
    const x = t.match(re);
    if (x) return tell(x, raw);
  }
  const tone: BeatTone = /^[✗⚠🛑]/u.test(raw) ? "bad" : /^[✅🎉]/u.test(raw) ? "ok" : /^[❓⏸]/u.test(raw) ? "warn" : "info";
  return said("other", undefined, t, tone);
}

const minutes = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));

interface Loop {
  who: string;
  from: string;
  to: string;
  starts: number;
  beats: Beat[];
}

/**
 * The day's log as story beats, oldest first. A lead that keeps starting and exiting within minutes is one beat
 * ("keeps restarting: 94 times since 09:16") instead of a wall of start/exit lines, because the loop is the story.
 */
export function beats(lines: readonly string[]): Beat[] {
  const out: (Beat | Loop)[] = [];
  const open = new Map<string, Loop>();
  for (const line of lines) {
    const x = line.match(/^- (\d\d:\d\d) (.*)$/);
    if (!x?.[1] || x[2] === undefined) continue;
    const p = parseLine(x[2]);
    if (!p) continue;
    const beat: Beat = { time: x[1], text: p.text, tone: p.tone, who: p.who, count: 1 };
    if (p.who && (p.kind === "start" || p.kind === "quick")) {
      let loop = open.get(p.who);
      if (!loop || minutes(x[1]) - minutes(loop.to) > LOOP_GAP_MIN) {
        loop = { who: p.who, from: x[1], to: x[1], starts: 0, beats: [] };
        open.set(p.who, loop);
        out.push(loop);
      }
      loop.to = x[1];
      loop.beats.push(beat);
      if (p.kind === "start") loop.starts++;
      continue;
    }
    if (p.who) open.delete(p.who);
    out.push(beat);
  }
  return out.flatMap((b): Beat[] => {
    if (!("starts" in b)) return [b];
    if (b.starts < LOOP_MIN) return b.beats;
    return [
      {
        time: `${b.from}–${b.to}`,
        text: `${b.who} keeps restarting: ${b.starts} times since ${b.from}, each run over within ${QUICK_MIN} min`,
        tone: "warn",
        who: b.who,
        count: b.starts,
      },
    ];
  });
}

/** Restarts today per lead, summed over every loop it was caught in. */
export function restarts(story: readonly Beat[]): Map<string, number> {
  const n = new Map<string, number>();
  for (const b of story) if (b.who && b.count > 1) n.set(b.who, (n.get(b.who) ?? 0) + b.count);
  return n;
}
