/** Everything the command bar, voice and buttons can ask for. */
export type Command =
  | { name: "queue"; key: string }
  | { name: "open"; key: string }
  | { name: "lead"; key: string }
  | { name: "review"; key: string }
  | { name: "theme"; id: string }
  | {
      name:
        | "brief"
        | "share"
        | "alerts"
        | "plan"
        | "inbox"
        | "work"
        | "pause"
        | "resume"
        | "overdrive"
        | "sweep"
        | "settings"
        | "menu"
        | "feedback"
        | "restart"
        | "shutdown";
    }
  | { name: "unknown"; text: string };

const SIMPLE = {
  brief: "brief",
  night: "brief",
  share: "share",
  alerts: "alerts",
  plan: "plan",
  inbox: "inbox",
  work: "work",
  pause: "pause",
  resume: "resume",
  overdrive: "overdrive",
  allout: "overdrive",
  unleash: "overdrive",
  sweep: "sweep",
  bury: "sweep",
  settings: "settings",
  menu: "menu",
  feedback: "feedback",
  report: "feedback",
  suggest: "feedback",
  restartops: "restart",
  restart: "restart",
  shutdown: "shutdown",
} as const;
const isSimple = (w: string): w is keyof typeof SIMPLE => Object.hasOwn(SIMPLE, w);

/** A command bar line: "queue HONEY-123", "HONEY-123", "lead fernway", "theme legion", "plan"… */
export function parseCommand(text: string): Command | null {
  const [cmd = "", arg = ""] = text.trim().split(/\s+/);
  if (!cmd) return null;
  if (/^[A-Za-z]+-\d+$/.test(cmd)) return { name: "open", key: cmd.toUpperCase() };
  const c = cmd.toLowerCase();
  if (c === "queue" && arg) return { name: "queue", key: arg.toUpperCase() };
  if (c === "open" && arg) return { name: "open", key: arg.toUpperCase() };
  if (c === "review" && arg) return { name: "review", key: arg.toUpperCase() };
  if ((c === "lead" || c === "godmode") && arg) return { name: "lead", key: arg.toLowerCase() };
  if (c === "theme") return { name: "theme", id: arg.toLowerCase() };
  if (isSimple(c)) return { name: SIMPLE[c] };
  return { name: "unknown", text: cmd };
}

/** What a spoken sentence asks for: "hand EW 123 to the agent", "night report", "pause"… */
export function parseVoice(text: string): Command {
  const s = text.toLowerCase();
  const key = s.match(/\b([a-z]{2,5})[\s-]*(\d{1,5})\b/);
  if (key) {
    const k = `${key[1]}-${key[2]}`.toUpperCase();
    return /hand|queue|give|agent|take/.test(s) ? { name: "queue", key: k } : { name: "open", key: k };
  }
  if (/brief|night report|status|what('?s| is) (up|going on)/.test(s)) return { name: "brief" };
  if (/alert|urgent|need/.test(s)) return { name: "alerts" };
  if (/\b(resume|continue)\b/.test(s)) return { name: "resume" };
  if (/\b(pause|hold)\b/.test(s)) return { name: "pause" };
  if (/plan/.test(s)) return { name: "plan" };
  if (/slack|inbox|messages/.test(s)) return { name: "inbox" };
  return { name: "unknown", text };
}
