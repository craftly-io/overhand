import { GEMINI_TERMS } from "@overhand/contract";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { STATE_KEY } from "@/app/data";
import { cue } from "@/app/sound";
import { useWords } from "@/app/theme";
import { useUi } from "@/app/ui";
import { PlanUse } from "@/components/AddAccount";
import { AddProjects } from "@/components/AddProjects";
import { Checkup } from "@/components/Checkup";
import { Connections, GithubFix, Mark, type Tone } from "@/components/Connections";
import { OrganiseStep } from "@/components/organise/OrganiseStep";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SkeletonRows } from "@/components/ui/skeleton";
import { get, post } from "@/lib/api";
import { fmt } from "@/lib/format";
import { MOTION, nth, reduced, useCountUp } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { BrandMark } from "./Logo";

const Backend = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("claude") }),
  z.object({ kind: z.literal("ollama"), model: z.string() }),
]);

/** What the daemon found on this machine for the wizard, and what it proposes from it: `GET /api/setup`. */
const FactsSchema = z.object({
  needed: z.boolean(),
  owner: z.string(),
  codeRoot: z.string(),
  /** codeRoot is a folder you chose to scan ("use projects already on this computer"); else Overhand's projects folder. */
  scanned: z.boolean().default(false),
  projectsDir: z.string().default(""),
  folder: z.boolean(),
  tools: z.object({ claude: z.boolean(), git: z.boolean(), gh: z.boolean() }),
  github: z.string(),
  claude: z.boolean(),
  /** The Claude Code you're already signed in to (not one of Overhand's folders) is what the first account uses. */
  claudeExisting: z.boolean().default(false),
  /** Gemini CLI has a cached Google sign-in, which no longer works for free accounts. */
  geminiGoogle: z.boolean().default(false),
  projects: z.array(
    z.object({
      name: z.string(),
      dir: z.string(),
      prefix: z.string(),
      trackerRepo: z.string(),
      /** That owner's repos, owner/name: the choices for trackerRepo (older daemons send none). */
      trackerRepos: z.array(z.string()).default([]),
      repos: z.array(z.string()),
    }),
  ),
  elsewhere: z.array(z.string()),
  agents: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      installed: z.boolean(),
      signedIn: z.boolean(),
      /** The terminal command that installs it when missing and opens its own sign-in; "" when setup can't. */
      connect: z.string().default(""),
      /** Its vendor's install and sign-in docs. */
      docs: z.string().default(""),
    }),
  ),
  /** Models a running local Ollama has; empty when none answers. */
  ollama: z.array(z.string()),
  agent: z.string(),
  backend: Backend,
});
type Facts = z.infer<typeof FactsSchema>;
type Pick = Facts["projects"][number] & { keep: boolean };
type BackendKind = "claude" | "ollama" | "gateway";

const GIT_DOWNLOAD = "https://git-scm.com/downloads";

/** The AI chat plans setup asks about, and the agent each one already includes (onboard.ts `agentForPlan`). */
type Plan = "claude" | "chatgpt" | "gemini" | "none";
const PLAN_AGENT: Record<Plan, string> = { claude: "claude-code", chatgpt: "codex", gemini: "gemini", none: "claude-code" };
/** Where Gemini CLI's free API key comes from (onboard.ts `GEMINI_KEY_URL`). */
const GEMINI_KEY_URL = "https://aistudio.google.com/app/apikey";
/** Node.js's own download page: its installer gives npm, which Gemini CLI installs with (onboard.ts `installCommand`). */
const NODE_DOWNLOAD_URL = "https://nodejs.org/en/download";

/** The scan reveals its lines one by one, ≤2.5s in all, however fast the daemon answered. */
const SCAN_FIRST = MOTION.slow;
const SCAN_STEP = 340;
const SCAN_LINES = 6;
/** How often the GitHub slot checks again while it waits for `gh auth login`. */
const RECHECK_MS = 4000;

/** A number that climbs as the scan finds things. */
function Count({ to }: { to: number }) {
  return <span className="font-mono tabular-nums">{Math.round(useCountUp(to))}</span>;
}

/** A numbered step of the Edit form; steps really are a sequence here. */
function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="m-enter hud-pane gap-3" style={nth(n)} aria-labelledby={`step-${n}`}>
      <h2 id={`step-${n}`} className="flex items-center gap-3 font-display text-base tracking-wide">
        <span aria-hidden="true" className="grid size-7 place-items-center rounded-md border border-primary font-mono text-sm text-primary">
          {n}
        </span>
        {title}
      </h2>
      {children}
    </section>
  );
}

/** A row of toggle buttons, one pressed. */
function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { id: T; text: string; muted?: boolean }[];
  onChange: (v: T) => void;
}) {
  return (
    <fieldset className="flex flex-wrap gap-2">
      <legend className="sr-only">{label}</legend>
      {options.map((o) => (
        <Button
          key={o.id}
          type="button"
          variant="outline"
          aria-pressed={value === o.id}
          // the picked one shows solid ink (index.css .hud-btn[aria-pressed]); a muted option stays clear once picked
          className={cn("h-auto min-h-9 max-w-full shrink whitespace-normal text-left", o.muted && "opacity-60 aria-pressed:opacity-100")}
          onClick={() => onChange(o.id)}
        >
          {o.text}
        </Button>
      ))}
    </fieldset>
  );
}

/**
 * One thing setup waits on, in amber, with the one action that clears it. `quiet` draws it in plain ink: when another
 * ask is already amber, so only one thing on the page asks to be looked at.
 */
function Action({ title, children, quiet = false }: { title: string; children: ReactNode; quiet?: boolean }) {
  return (
    <section
      role={quiet ? undefined : "alert"}
      className={cn("m-enter grid gap-2.5 rounded-lg border p-4", quiet ? "border-border bg-card" : "border-warn/50 bg-warn/5")}
      aria-label={title}
    >
      <h3 className={cn("flex items-center gap-2 text-sm font-semibold", !quiet && "text-warn")}>
        <Mark tone={quiet ? "pending" : "warn"} />
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * The first run of an install, in the browser, as a launch sequence. Overhand comes online and scans the machine (your
 * name from git, your code folder and its projects, the agent CLIs and their logins, a Claude sign-in or API key or a
 * local Ollama model, the GitHub login), each line locking on as it's confirmed. A loadout of four slots (GitHub,
 * agent, model, projects) fills as they're ready; one that needs you turns amber with its one action, and GitHub
 * checks again by itself until you've signed in. Edit opens the full form. Start saves the config and the dashboard
 * assembles.
 */
export function Setup({ onSaved }: { onSaved?: (projects: number) => void } = {}) {
  const w = useWords();
  const ui = useUi();
  const qc = useQueryClient();
  const [scanDir, setScanDir] = useState("");
  const [asked, setAsked] = useState("");
  const [signingIn, setSigningIn] = useState(false);
  const [agent, setAgent] = useState("");
  const facts = useQuery({
    queryKey: ["setup", asked],
    queryFn: () => get(`/api/setup${asked ? `?codeRoot=${encodeURIComponent(asked)}` : ""}`, FactsSchema),
    staleTime: Number.POSITIVE_INFINITY,
    placeholderData: keepPreviousData,
    // waiting on `gh auth login` (or installing gh), or on an agent's install and sign-in: look again every few seconds
    // until it passes
    refetchInterval: (q) => {
      const d = q.state.data;
      const picked = d?.agents.find((a) => a.id === agent);
      // (Gemini CLI waits only on its install: its key is typed right here)
      const done = picked?.installed && (picked.signedIn || picked.id === "gemini");
      return d && (!(d.tools.gh && d.github) || (signingIn && !done)) ? RECHECK_MS : false;
    },
  });
  const f = facts.data;
  const looking = facts.isPending || facts.isPlaceholderData;
  const [name, setName] = useState("");
  const [picks, setPicks] = useState<Pick[]>([]);
  const [kind, setKind] = useState<"login" | "key">("login");
  const [secret, setSecret] = useState("");
  const [geminiKey, setGeminiKey] = useState("");
  const [plan, setPlan] = useState<Plan | "">("");
  const [backend, setBackend] = useState<BackendKind | "">("");
  const [model, setModel] = useState("");
  const [gatewayUrl, setGatewayUrl] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [launched, setLaunched] = useState(false);
  const [error, setError] = useState("");
  const [shown, setShown] = useState(() => (reduced() ? Number.POSITIVE_INFINITY : 0));
  const start = useRef<HTMLButtonElement>(null);
  // where projects live: the folder you chose to scan, else Overhand's own projects folder
  const root = f?.codeRoot ?? "";

  // what the daemon found becomes the editable defaults; a project it finds again (a repo landed, GitHub checked
  // again) keeps your edits
  useEffect(() => {
    if (!f) return;
    setName((n) => n || f.owner);
    setPicks((ps) =>
      f.projects.map((p) => {
        const old = ps.find((x) => x.dir === p.dir);
        return old ? { ...p, name: old.name, prefix: old.prefix, keep: old.keep, trackerRepo: old.trackerRepo } : { ...p, keep: true };
      }),
    );
    setAgent((a) => a || f.agent);
    setBackend((b) => b || f.backend.kind);
    setModel((m) => m || (f.backend.kind === "ollama" ? f.backend.model : ""));
  }, [f]);

  // the AI you already pay for picks the agent: the one its plan includes, signed in by itself; none means an API key
  const choosePlan = (p: Plan) => {
    setPlan(p);
    setAgent(PLAN_AGENT[p]);
    setKind(p === "none" ? "key" : "login");
    setBackend("claude");
    setSigningIn(false);
  };
  const connect = () =>
    void post("/api/agent/connect", { agent }, z.object({ ok: z.boolean() }))
      .then(() => setSigningIn(true))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));

  const kept = picks.filter((p) => p.keep);
  // only Claude Code on Claude needs a Claude sign-in or API key; other CLIs use their own login, local models none
  const needsCredential = agent === "claude-code" && backend === "claude" && !f?.claude;
  const backendReady = backend === "claude" || (backend === "ollama" && model) || (backend === "gateway" && model && gatewayUrl);
  // agents work through the GitHub CLI, so setup waits until it's installed and signed in
  const github = Boolean(f?.tools.gh && f.github);
  const prefixesOk = kept.every((p) => /^[A-Z][A-Z0-9]+$/.test(p.prefix));
  // Claude Code's own sign-in is ready once the daemon sees it (needsCredential turns false); a key once it's typed
  const credentialReady = !needsCredential || (kind === "key" && Boolean(secret.trim()));
  const chosen = f?.agents.find((a) => a.id === agent);
  const agentLabel = chosen?.label ?? agent;
  // the agent is ready once it's installed and signed in by itself (a local model or gateway needs no sign-in, and
  // Claude Code may run on an API key instead)
  const agentOk = Boolean(
    chosen?.installed &&
      (backend !== "claude" ||
        chosen.signedIn ||
        (agent === "claude-code" && kind === "key") ||
        (agent === "gemini" && geminiKey.trim() !== "")),
  );
  // once you've answered which AI you pay for, the question stays and locks on in place
  const askPlan = !agentOk || plan !== "";
  // a project too: the first win needs a repo to work in, and Overhand with none has nothing to show
  const ready = Boolean(name.trim() && github && kept.length && agentOk && backendReady && credentialReady && prefixesOk);
  const edit = (i: number, patch: Partial<Pick>) => setPicks((ps) => ps.map((p, k) => (k === i ? { ...p, ...patch } : p)));
  const modelReady = Boolean(backendReady && credentialReady);
  const modelLabel =
    backend === "ollama"
      ? `${w.setupModelOllama}: ${model}`
      : backend === "gateway"
        ? `${gatewayUrl} · ${model}`
        : agent === "claude-code"
          ? w.setupModelClaude
          : w.setupModelOwn;
  const repoCount = picks.reduce((n, p) => n + p.repos.length, 0) + (f?.elsewhere.length ?? 0);

  // the scan: what the daemon found, one line at a time, each locking on as it's confirmed
  const rows: { id: string; label: string; tone: Tone; value: ReactNode }[] = f
    ? [
        { id: "you", label: w.setupRowYou, tone: name.trim() ? "ok" : "warn", value: name || "—" },
        {
          id: "github",
          label: w.setupRowGithub,
          tone: github ? "ok" : "warn",
          value: github ? (
            fmt(w.setupGithubIn, { login: f.github })
          ) : (
            <span className="text-warn">{f.tools.gh ? w.setupGithubOut : fmt(w.setupToolMissing, { tool: "gh" })}</span>
          ),
        },
        {
          id: "code",
          label: f.scanned ? w.setupRowCode : w.setupRowProjectsDir,
          tone: f.scanned && !f.folder ? "warn" : "ok",
          value: <span className="font-mono text-[13px] break-all">{root}</span>,
        },
        {
          id: "repos",
          label: w.setupRowRepos,
          tone: picks.length ? "ok" : "idle",
          value: (
            <>
              <Count to={repoCount} />
              <span className="text-muted-foreground">
                {" · "}
                {kept.length ? `${fmt(w.setupProjectCount, { n: kept.length })}: ${kept.map((p) => p.name).join(", ")}` : w.setupNoProjects}
              </span>
            </>
          ),
        },
        {
          id: "agents",
          label: w.setupRowAgent,
          tone: agentOk ? "ok" : "warn",
          value: f.agents.some((a) => a.installed) ? (
            <span className="flex flex-wrap gap-1.5">
              {f.agents
                .filter((a) => a.installed)
                .map((a) => (
                  <span
                    key={a.id}
                    className={cn(
                      "rounded-md border px-1.5 py-px text-xs",
                      a.id === agent ? "border-primary/50 bg-primary/10 text-foreground" : "border-border text-muted-foreground",
                    )}
                  >
                    {a.label}
                    {a.signedIn ? <span className="text-ok"> · {w.setupAgentSignedIn}</span> : null}
                  </span>
                ))}
            </span>
          ) : (
            <span className="text-warn">{w.setupNoAgents}</span>
          ),
        },
        {
          id: "model",
          label: w.setupRowModel,
          tone: modelReady ? "ok" : "warn",
          value: (
            <>
              {modelLabel}
              {needsCredential && chosen?.installed && !secret.trim() ? <span className="text-warn"> · {w.setupNeedsToken}</span> : null}
              {f.ollama.length && backend !== "ollama" ? (
                <span className="text-muted-foreground"> · {fmt(w.setupLocalModels, { n: f.ollama.length })}</span>
              ) : null}
            </>
          ),
        },
      ]
    : [];
  const scanned = f !== undefined && shown >= rows.length;
  const seen = (id: string) => rows.findIndex((r) => r.id === id) < shown && f !== undefined;

  // reveal a line at a time, however fast the answer came, so it reads as a scan
  useEffect(() => {
    if (!f || shown >= SCAN_LINES) return;
    const t = setTimeout(() => setShown((n) => n + 1), shown === 0 ? SCAN_FIRST : SCAN_STEP);
    return () => clearTimeout(t);
  }, [f, shown]);
  // any key or click skips to the end
  useEffect(() => {
    if (scanned) return;
    const skip = () => setShown(Number.POSITIVE_INFINITY);
    addEventListener("keydown", skip);
    addEventListener("pointerdown", skip);
    return () => {
      removeEventListener("keydown", skip);
      removeEventListener("pointerdown", skip);
    };
  }, [scanned]);
  // scan done and nothing to fix: Start takes the focus, so Enter launches
  useEffect(() => {
    if (!scanned || editing || !ready) return;
    if (document.activeElement === document.body || document.activeElement === null) start.current?.focus();
  }, [scanned, editing, ready]);
  // the world's start sound when the scan completes, its merge sound when GitHub locks on by itself (off unless sound is on)
  const wasGithub = useRef<boolean | null>(null);
  useEffect(() => {
    if (!scanned) return;
    if (wasGithub.current === null) {
      cue("start");
    } else if (!wasGithub.current && github) cue("merged");
    wasGithub.current = github;
  }, [scanned, github]);

  const slots: { id: string; label: string; tone: Tone; value: string }[] = [
    {
      id: "github",
      label: w.setupSlotGithub,
      tone: !seen("github") ? "pending" : github ? "ok" : "warn",
      value: github ? (f?.github ?? "") : w.setupSlotSignIn,
    },
    {
      id: "projects",
      label: w.setupSlotProjects,
      tone: !seen("repos") ? "pending" : !prefixesOk || !kept.length ? "warn" : "ok",
      value: kept.length ? String(kept.length) : w.setupSlotPick,
    },
    {
      id: "agent",
      label: w.setupSlotAgent,
      tone: !seen("agents") ? "pending" : agentOk ? "ok" : "warn",
      value: agentOk ? agentLabel : chosen?.installed ? w.setupSlotSignIn : w.setupSlotInstall,
    },
    {
      id: "model",
      label: w.setupSlotModel,
      tone: !seen("model") ? "pending" : modelReady ? "ok" : "warn",
      value: modelReady
        ? backend === "claude"
          ? agent === "claude-code"
            ? w.setupModelClaude
            : w.setupModelOwn
          : model
        : w.setupSlotSignIn,
    },
  ];

  const finish = async () => {
    setBusy(true);
    setError("");
    try {
      await post(
        "/api/setup",
        {
          setup: {
            owner: name.trim(),
            codeRoot: root.trim(),
            projects: kept.map(({ name, dir, prefix, trackerRepo }) => ({ name, dir, prefix, trackerRepo })),
            credential: { kind, value: needsCredential && kind === "key" ? secret.trim() : "" },
            agent,
            geminiKey: agent === "gemini" ? geminiKey.trim() : "",
            backend:
              backend === "ollama"
                ? { kind: "ollama", model }
                : backend === "gateway"
                  ? { kind: "gateway", baseUrl: gatewayUrl.trim(), model: model.trim() }
                  : { kind: "claude" },
          },
        },
        z.object({ ok: z.boolean() }),
      );
      // launch: the dashboard assembles in this page's place as soon as its state
      // arrives (this page stays, charged, until then, so there's never an empty frame)
      cue("merged");
      setLaunched(true);
      // two projects or more: the dashboard opens on "Here's how we'd organise your work" first (SetupOrganise)
      onSaved?.(kept.length);
      // more agent accounts (work and personal, one per client) are one step away in Settings
      toast(w.setupStarted, { action: { label: w.addAccountLater, onClick: () => ui.openDrawer({ kind: "settings", tab: "accounts" }) } });
      await qc.invalidateQueries({ queryKey: STATE_KEY });
    } catch (e) {
      setLaunched(false);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const credential = needsCredential ? (
    <>
      <Choice
        label={w.setupClaude}
        value={kind}
        options={[
          { id: "login", text: w.setupLogin },
          { id: "key", text: w.setupKey },
        ]}
        onChange={setKind}
      />
      <p className="text-sm text-muted-foreground">{kind === "login" ? w.setupLoginHint : w.setupKeyHint}</p>
      {kind === "login" ? <PlanUse /> : null}
      {kind === "login" ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              void post("/api/claude-login", {}, z.object({ ok: z.boolean() }))
                .then(() => setSigningIn(true))
                .catch((e: unknown) => setError(String(e)))
            }
          >
            {w.setupSignIn}
          </Button>
          {signingIn ? <span className="text-sm text-muted-foreground">{w.setupWatching}</span> : null}
        </div>
      ) : (
        <Input
          type="password"
          autoComplete="off"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          aria-label={w.setupKey}
          placeholder="sk-ant-api…"
          className="font-mono text-sm"
        />
      )}
    </>
  ) : agent === "claude-code" && backend === "claude" && editing ? (
    <p className="text-sm text-ok">{w.setupClaudeFound}</p>
  ) : null;

  // which AI you already pay for: one tap picks the agent its plan includes; Overhand installs it (the vendor's own
  // command, shown first) and opens its own sign-in, then checks every few seconds until it's signed in
  const planLabels: Record<Plan, string> = {
    claude: w.setupPlanClaude,
    chatgpt: w.setupPlanChatgpt,
    gemini: w.setupPlanGemini,
    none: w.setupPlanNone,
  };
  const signInHint: Record<string, string> = {
    "claude-code": w.setupSignInClaude,
    codex: w.setupSignInCodex,
  };
  // the exact command, then the button that runs it in a terminal you can watch (Gemini CLI's is the install alone)
  const connectBlock = chosen?.connect ? (
    <>
      <p className="text-sm">{w.setupAgentRuns}</p>
      <code className="w-fit max-w-full rounded-md border border-border bg-background px-3 py-2 font-mono text-[13px] break-all select-all">
        {chosen.connect}
      </code>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" onClick={connect}>
          {fmt(agent === "gemini" ? w.setupAgentInstall : chosen.installed ? w.setupAgentSignInTo : w.setupAgentConnect, {
            tool: agentLabel,
          })}
        </Button>
        {signingIn ? (
          <span className="flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
            <span aria-hidden="true" className="m-pulse size-1.5 rounded-full bg-warn" />
            {w.setupWatching}
          </span>
        ) : null}
      </div>
      {signingIn && signInHint[agent] ? <p className="text-sm text-muted-foreground">{signInHint[agent]}</p> : null}
    </>
  ) : null;
  const docsLink = chosen?.docs ? (
    <a className="w-fit text-sm break-all text-primary underline" href={chosen.docs} target="_blank" rel="noopener noreferrer">
      {chosen.docs}
    </a>
  ) : null;
  const planAsk = (
    <section
      role={agentOk ? undefined : "alert"}
      aria-labelledby="setup-plan"
      className={cn("m-enter grid gap-2.5 rounded-lg border p-4", agentOk ? "border-border bg-card" : "border-warn/50 bg-warn/5")}
    >
      <h3 id="setup-plan" className={cn("flex items-center gap-2 text-sm font-semibold", !agentOk && "text-warn")}>
        <Mark key={String(agentOk)} tone={agentOk ? "ok" : "warn"} />
        {w.setupPlanAsk}
      </h3>
      <p className="text-sm text-muted-foreground">{w.setupPlanHint}</p>
      <Choice<Plan | "">
        label={w.setupPlanAsk}
        value={plan}
        options={(Object.keys(planLabels) as Plan[]).map((p) => {
          const a = p === "none" ? undefined : f?.agents.find((x) => x.id === PLAN_AGENT[p]);
          return { id: p, text: [planLabels[p], a?.installed && a.signedIn ? w.setupAgentSignedIn : ""].filter(Boolean).join(" · ") };
        })}
        onChange={(p) => {
          if (p) choosePlan(p);
        }}
      />
      {plan === "claude" ? <PlanUse /> : null}
      {plan === "" ? null : plan === "gemini" ? (
        // Gemini CLI on a free Gemini API key: installed if missing (the install alone), then the key; no Google sign-in
        <>
          {chosen?.installed ? null : chosen?.connect ? (
            connectBlock
          ) : (
            // no Homebrew or npm to install it with: name the one missing piece, as a normal download, not a repo link
            <p className="text-sm">
              {w.setupGeminiNeedsNode}{" "}
              <a className="text-primary underline" href={NODE_DOWNLOAD_URL} target="_blank" rel="noopener noreferrer">
                {w.setupGeminiNodeGet}
              </a>
            </p>
          )}
          {chosen?.signedIn ? (
            <p className="text-sm text-ok">{fmt(w.setupAgentReady, { tool: agentLabel })}</p>
          ) : (
            <div className="grid gap-1.5">
              {f?.geminiGoogle ? <p className="text-sm text-muted-foreground">{w.setupGeminiGoogle}</p> : null}
              <label htmlFor="gemini-key" className="text-sm font-medium">
                {w.setupGeminiKey}
              </label>
              <p className="text-sm text-muted-foreground">
                {w.setupGeminiKeyFree}{" "}
                <a className="text-primary underline" href={GEMINI_KEY_URL} target="_blank" rel="noopener noreferrer">
                  {w.setupGeminiKeyGet}
                </a>
              </p>
              <p className="text-sm text-muted-foreground">
                {w.setupGeminiKeyData}{" "}
                <a className="text-primary underline" href={GEMINI_TERMS} target="_blank" rel="noopener noreferrer">
                  {w.setupGeminiTerms}
                </a>
              </p>
              <Input
                id="gemini-key"
                type="password"
                autoComplete="off"
                value={geminiKey}
                onChange={(e) => setGeminiKey(e.target.value)}
                placeholder="AIza…"
                className="max-w-md font-mono text-sm"
              />
            </div>
          )}
        </>
      ) : agentOk ? (
        <p className="text-sm text-ok">{fmt(w.setupAgentReady, { tool: agentLabel })}</p>
      ) : plan === "none" ? (
        <>
          <p className="text-sm text-muted-foreground">{w.setupPlanNoneHint}</p>
          {chosen?.installed ? (
            credential
          ) : (
            <>
              <p className="text-sm">{fmt(w.setupAgentManual, { tool: agentLabel })}</p>
              {docsLink}
            </>
          )}
        </>
      ) : chosen?.connect ? (
        connectBlock
      ) : (
        <>
          <p className="text-sm">{fmt(w.setupAgentManual, { tool: agentLabel })}</p>
          {docsLink}
        </>
      )}
    </section>
  );

  // agent CLIs you're already signed in to, one tap each: runs use that sign-in as is, so there's no second one (Gemini
  // CLI's "signed in" is a key, and Claude Code's counts only when it's the one in your terminal)
  const reusable = (f?.agents ?? []).filter(
    (a) => a.installed && a.signedIn && a.id !== "gemini" && (a.id !== "claude-code" || f?.claudeExisting),
  );
  const reuse = reusable.length ? (
    <section aria-labelledby="setup-reuse" className="m-enter grid gap-2.5 rounded-lg border border-border bg-card p-4">
      <h3 id="setup-reuse" className="flex items-center gap-2 text-sm font-semibold">
        <Mark tone={reusable.some((a) => a.id === agent) ? "ok" : "idle"} />
        {w.setupReuseTitle}
      </h3>
      <Choice
        label={w.setupReuseTitle}
        value={agent}
        options={reusable.map((a) => ({ id: a.id, text: fmt(w.setupReuse, { tool: a.label }) }))}
        onChange={(id) => {
          setAgent(id);
          setPlan("");
          setKind("login");
          setBackend("claude");
          setSigningIn(false);
        }}
      />
      {agent === "claude-code" && f?.claudeExisting ? (
        <p className="max-w-prose text-sm text-muted-foreground">{w.setupReuseClaude}</p>
      ) : null}
    </section>
  ) : null;

  // the loadout: four slots that fill as the scan confirms them
  const loadout = (
    <ol aria-label={w.setupLoadout} className="m-enter grid grid-cols-2 gap-2 sm:grid-cols-4" style={nth(1)}>
      {slots.map((s) => (
        <li
          key={s.id}
          className={cn(
            "relative grid min-w-0 gap-1 overflow-hidden rounded-lg border bg-card px-3 pt-2.5 pb-3 transition-colors duration-(--m-base)",
            s.tone === "warn" ? "border-warn/60 bg-warn/5" : "border-border",
          )}
        >
          <span className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            {s.label}
            <Mark key={s.tone} tone={s.tone} />
          </span>
          <span
            className={cn(
              "truncate text-sm font-medium",
              s.tone === "pending" && "text-muted-foreground",
              s.tone === "warn" && "text-warn",
            )}
          >
            {s.tone === "pending" ? "…" : s.value}
          </span>
          <span className="sr-only">
            {s.tone === "ok" ? "ready" : s.tone === "warn" ? "needs you" : s.tone === "pending" ? "scanning" : "optional"}
          </span>
          {/* the slot's charge: fills from the left when it's ready, amber when it waits on you */}
          <span
            aria-hidden="true"
            className={cn(
              "absolute inset-x-0 bottom-0 h-0.5 origin-left transition-transform duration-(--m-slow) ease-(--m-arrive)",
              s.tone === "ok" ? "bg-ok" : s.tone === "warn" ? "bg-warn" : "bg-border",
              s.tone === "pending" ? "scale-x-0" : "scale-x-100",
            )}
          />
        </li>
      ))}
    </ol>
  );

  // the check-up: what Overhand found in the repos you picked, read-only, while the rest of setup waits; a finding
  // handed to an agent becomes the first win once setup is done
  const checked = kept.flatMap((p) => p.repos.slice(0, 1)).slice(0, 2); // one per project: its copies look alike
  const checkupPane =
    scanned && checked.length ? (
      <section className="m-enter hud-pane gap-3" aria-labelledby="setup-checkup">
        <h2 id="setup-checkup" className="font-display text-base tracking-wide">
          {w.paneCheckup}
        </h2>
        {checked.map((r) => (
          <Checkup key={r} repo={r} codeRoot={root} />
        ))}
      </section>
    ) : null;

  // the one action each amber slot needs
  const actions = scanned ? (
    <>
      {f && !github ? (
        // while the agent ask is amber it's the one focal point, and this one waits in plain ink
        <Action title={f.tools.gh ? w.setupGhTitle : w.setupGhInstall} quiet={!agentOk}>
          {/* in plain words for someone who has never used a terminal tool: what it's for, then the one fix */}
          <p className="text-sm">{f.tools.gh ? w.setupGhBody : w.setupGhWhy}</p>
          <GithubFix installed={f.tools.gh} />
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
              <span aria-hidden="true" className={cn("m-pulse size-1.5 rounded-full", agentOk ? "bg-warn" : "bg-muted-foreground")} />
              {facts.isFetching ? w.setupLooking : w.setupWatching}
            </span>
          </div>
        </Action>
      ) : null}
      {f?.tools.git && !editing ? (
        <>
          <AddProjects codeRoot={asked} githubAsked onReady={() => void facts.refetch()} className="m-enter" />
          <Button variant="link" className="w-fit px-0" onClick={() => setEditing(true)}>
            {w.setupPickLocal}
          </Button>
        </>
      ) : null}
      {checkupPane}
      {editing ? null : reuse}
      {f && askPlan && !editing ? planAsk : null}
      {needsCredential && !editing && !askPlan ? <Action title={w.setupClaude}>{credential}</Action> : null}
      {f && !f.tools.git ? (
        <p className="text-sm text-warn">
          {fmt(w.setupToolMissing, { tool: "git" })}:{" "}
          <a className="underline" href={GIT_DOWNLOAD} target="_blank" rel="noopener noreferrer">
            {GIT_DOWNLOAD}
          </a>
        </p>
      ) : null}
    </>
  ) : null;

  const launchRow = (
    <>
      {error ? (
        <p role="alert" className="text-sm text-bad">
          {error}
        </p>
      ) : null}
      <div className="m-enter flex flex-wrap items-center gap-x-4 gap-y-2" style={nth(3)}>
        <Button
          ref={start}
          size="lg"
          variant={ready ? "primary" : "outline"}
          className="relative min-w-40 overflow-hidden"
          disabled={!ready || busy || !scanned}
          onClick={() => void finish()}
        >
          {/* the launch: a charge fills the button while Overhand saves and starts */}
          <span
            aria-hidden="true"
            className={cn(
              "absolute inset-0 origin-left bg-primary-foreground/20 transition-transform duration-(--m-slow) ease-(--m-arrive)",
              busy || launched ? "scale-x-100" : "scale-x-0",
            )}
          />
          <span className="relative">{busy ? w.setupLaunching : w.setupFinish}</span>
        </Button>
        {ready && scanned && !busy ? <span className="text-xs text-muted-foreground">{w.setupEnter}</span> : null}
        {/* a greyed-out Start says why: the same steps the chips above mark in orange */}
        {!ready && scanned && !busy ? (
          <span className="text-sm text-muted-foreground">
            {fmt(w.setupWaitingOn, {
              list: [!name.trim() ? w.setupRowYou : "", ...slots.filter((s) => s.tone === "warn").map((s) => s.label)]
                .filter(Boolean)
                .join(", "),
            })}
          </span>
        ) : null}
        {!editing ? (
          <Button variant="link" className="-mr-2 ml-auto px-2" onClick={() => setEditing(true)}>
            {w.setupEdit}
          </Button>
        ) : null}
      </div>
    </>
  );

  const header = (
    <header className="m-enter">
      <h1 className="hud-glow font-display text-3xl font-semibold tracking-wide lg:text-4xl">{w.setupTitle}</h1>
      <p className="mt-2 text-lg text-foreground/85">{editing ? w.setupIntro : w.setupFoundHint}</p>
    </header>
  );

  const shell = "mx-auto grid max-w-2xl gap-(--space-gap) py-6 lg:py-10";

  // the launch sequence: the scan, the loadout, what still needs you, launch; Edit opens the full form
  if (!editing)
    return (
      <div className={shell}>
        {header}
        {loadout}
        <section className="hud-pane relative gap-3" style={nth(2)} aria-labelledby="setup-found" aria-busy={!scanned}>
          <p className="m-enter flex items-center gap-2 text-xs text-muted-foreground">
            {/* while the scan runs, the one loader; once it's done, a green dot */}
            {scanned ? <span aria-hidden="true" className="size-1.5 rounded-full bg-ok" /> : <BrandMark size={16} moving />}
            {w.setupBoot}
          </p>
          <header className="flex items-baseline gap-3">
            <h2 id="setup-found" className="font-display text-base tracking-wide">
              {scanned ? w.setupFound : `${w.setupScanning}…`}
            </h2>
            {scanned ? null : <span className="ml-auto text-xs text-muted-foreground">{w.setupSkip}</span>}
          </header>
          {f === undefined ? <SkeletonRows label={w.setupLooking} rows={4} /> : null}
          <ul className="grid gap-2.5 text-sm">
            {/* the scan still steps through every row, but GitHub, projects and model show once, in the loadout above */}
            {rows
              .slice(0, shown)
              .filter((r) => !["github", "repos", "model"].includes(r.id))
              .map((r) => (
                <li key={r.id} className="m-enter flex items-start gap-3">
                  <Mark key={r.tone} tone={r.tone} />
                  <div className="grid min-w-0 flex-1 gap-0.5 sm:grid-cols-[7.5rem_1fr] sm:gap-3">
                    <span className="text-xs text-muted-foreground sm:text-sm">{r.label}</span>
                    <span className="min-w-0">{r.value}</span>
                  </div>
                </li>
              ))}
          </ul>
        </section>
        {actions}
        {scanned ? <Connections className="m-enter" style={nth(3)} /> : null}
        {launchRow}
      </div>
    );

  return (
    <div className={shell}>
      {header}
      {loadout}

      <Step n={1} title={w.setupYou}>
        <Input value={name} onChange={(e) => setName(e.target.value)} aria-label={w.setupYou} className="max-w-sm" />
      </Step>

      <Step n={2} title={w.setupSlotProjects}>
        {f?.tools.git ? (
          <AddProjects
            codeRoot={asked}
            githubAsked
            onReady={() => void facts.refetch()}
            className="border-0 bg-transparent p-0 shadow-none"
          />
        ) : null}
        {/* the optional path: scan one folder you choose for repos you already have; nothing else is read */}
        <form
          className="grid gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            setAsked(scanDir.trim());
          }}
        >
          <label htmlFor="scan-dir" className="text-sm font-medium">
            {w.setupPickLocal}
          </label>
          <div className="flex gap-2">
            <Input
              id="scan-dir"
              value={scanDir}
              onChange={(e) => setScanDir(e.target.value)}
              placeholder={w.setupCode}
              className="font-mono text-sm"
            />
            <Button type="submit" variant="outline" disabled={!scanDir.trim()}>
              {w.setupRescan}
            </Button>
          </div>
        </form>
        {looking ? (
          <SkeletonRows label={w.setupLooking} rows={3} row="h-10 rounded-lg" />
        ) : picks.length ? (
          <>
            <p className="text-sm text-muted-foreground">{w.setupProjectsHint}</p>
            <ul className="m-stagger grid gap-2">
              {picks.map((p, i) => (
                <li
                  key={p.repos.join(" ")}
                  style={nth(i)}
                  className={cn(
                    "grid grid-cols-[auto_1fr_6rem] items-center gap-3 rounded-lg border border-border p-2.5",
                    !p.keep && "opacity-50",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={p.keep}
                    onChange={(e) => edit(i, { keep: e.target.checked })}
                    aria-label={p.name}
                    className="size-4 accent-(--primary)"
                  />
                  <div className="min-w-0">
                    <Input
                      value={p.name}
                      onChange={(e) => edit(i, { name: e.target.value })}
                      aria-label={`${p.name} name`}
                      className="h-8"
                    />
                    <p className="mt-1 truncate text-xs text-muted-foreground">
                      {p.dir} · {p.repos.length} repo{p.repos.length === 1 ? "" : "s"}
                    </p>
                    {/* the repo whose issues agents pick up: any of that owner's repos found here */}
                    <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                      {w.setupTrackerRepo}
                      <Select value={p.trackerRepo} onValueChange={(v) => edit(i, { trackerRepo: v })}>
                        <SelectTrigger size="sm" className="h-7 min-w-0 font-mono text-xs" aria-label={`${p.name}: ${w.setupTrackerRepo}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {[...new Set([p.trackerRepo, ...p.trackerRepos])].map((r) => (
                            <SelectItem key={r} value={r} className="font-mono text-xs">
                              {r}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <Input
                    value={p.prefix}
                    onChange={(e) => edit(i, { prefix: e.target.value.toUpperCase() })}
                    aria-label={`${p.name} ticket prefix`}
                    className="h-8 font-mono"
                  />
                </li>
              ))}
            </ul>
          </>
        ) : f?.scanned ? (
          <p className="text-sm text-warn">{f.folder ? w.setupNone : `${root} isn't a folder.`}</p>
        ) : null}
        {f?.elsewhere.length ? <p className="text-xs text-muted-foreground">{fmt(w.setupElsewhere, { n: f.elsewhere.length })}</p> : null}
      </Step>

      <Step n={3} title={w.setupAgent}>
        {reuse}
        {planAsk}
        <Choice
          label={w.setupAgent}
          value={agent}
          options={(f?.agents ?? []).map((a) => ({
            id: a.id,
            text: [a.label, a.signedIn ? w.setupAgentSignedIn : a.installed ? "" : w.setupAgentMissing].filter(Boolean).join(" · "),
            muted: !a.installed,
          }))}
          onChange={setAgent}
        />
      </Step>

      <Step n={4} title={w.setupModel}>
        <Choice<BackendKind>
          label={w.setupModel}
          value={backend || "claude"}
          options={[
            { id: "claude", text: agent === "claude-code" ? w.setupModelClaude : w.setupModelOwn },
            ...(f?.ollama.length ? [{ id: "ollama" as const, text: w.setupModelOllama }] : []),
            { id: "gateway", text: w.setupModelGateway },
          ]}
          onChange={setBackend}
        />
        {backend === "ollama" ? (
          <Choice
            label={w.setupModelOllama}
            value={model}
            options={(f?.ollama ?? []).map((m) => ({ id: m, text: m }))}
            onChange={setModel}
          />
        ) : null}
        {backend === "gateway" ? (
          <div className="grid gap-2 sm:grid-cols-2">
            <Input
              value={gatewayUrl}
              onChange={(e) => setGatewayUrl(e.target.value)}
              aria-label={w.setupGatewayUrl}
              placeholder="http://localhost:4000"
              className="font-mono text-sm"
            />
            <Input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              aria-label={w.setupGatewayModel}
              placeholder={w.setupGatewayModel}
            />
          </div>
        ) : null}
        {credential}
      </Step>

      {actions}
      <Connections className="m-enter" style={nth(7)} />
      {launchRow}
    </div>
  );
}

/**
 * Setup's last step, once the projects are saved: how Overhand would group them (with why), the rules and lead scope per
 * group, and Accept all, Adjust or Skip. Shown in setup's own frame; Done or Skip opens the dashboard.
 */
export function SetupOrganise({ onDone }: { onDone: () => void }) {
  return (
    <div className="mx-auto grid max-w-2xl gap-(--space-gap) py-6 lg:py-10">
      <section className="m-enter hud-pane gap-3" style={nth(1)}>
        <OrganiseStep onDone={onDone} />
      </section>
    </div>
  );
}
