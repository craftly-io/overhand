import { guardOnly, SANDBOX_SWITCH, type SandboxStatus, SITE, sandboxLine } from "@overhand/contract";
import { useEffect, useId, useState } from "react";
import { useModel } from "@/app/data";
import { useWords } from "@/app/theme";
import { FeatureTip } from "@/components/FeatureTip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { fmt } from "@/lib/format";
import { getAt, isObject, type Json, type JsonObject } from "@/lib/json";
import { budgetApplies } from "@/lib/spend";
import { Field, FieldCard, More, useForm } from "./SettingsFields";

/** Standing approvals, as Settings names them; the keys are the config's. */
const APPROVALS: Record<string, string> = {
  "stop-heavy-in-quiet": "During quiet mode, Overhand may stop heavy jobs sessions start",
  "one-at-a-time": "When three or more heavy jobs compete, Overhand may make them run one at a time",
  "close-foreign-pr": "Overhand may close a PR a session opens in another project's repo",
  "pause-same-files": "Overhand may pause the later of two sessions editing the same files on one branch",
  "stop-silent": "Overhand may stop a heavy job that has printed nothing for half its limit",
  "allow-heavy-in-quiet": "Heavy jobs may run during quiet mode and hold windows",
};

const KINDS = ["browser", "simulator", "suite", "build", "devserver"];
const list = (x: Json | undefined): Json[] => (Array.isArray(x) ? x : []);
const str = (x: Json | undefined): string => (typeof x === "string" ? x : "");

/** Hold windows as lines: `09:00-12:00` (quiet: every heavy kind) or `00:00-19:07 browser, suite`. */
function windowsText(draft: JsonObject): string {
  return list(getAt(draft, "control.windows"))
    .filter(isObject)
    .map((w) => [`${str(w.from)}-${str(w.to)}`, list(w.kinds).map(str).join(", ")].filter(Boolean).join(" "))
    .join("\n");
}

/** Lines back to hold windows; a line that doesn't read is dropped (the daemon validates what's saved). */
function parseWindows(text: string): JsonObject[] {
  return text.split("\n").flatMap((l) => {
    const m = l.trim().match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*(.*)$/);
    if (!m) return [];
    const kinds = (m[3] ?? "").split(/[\s,]+/).filter((k) => KINDS.includes(k));
    return [{ from: (m[1] ?? "").padStart(5, "0"), to: (m[2] ?? "").padStart(5, "0"), kinds }];
  });
}

/** Whether a project's own sandbox setting shows unfolded: it holds a tool that can't run inside, or it's already set. */
const flagged = (c: Json, tools: Record<string, string>): boolean =>
  isObject(c) && (Boolean(tools[str(c.name)]) || c.sandbox === "off" || c.sandbox === "keep");

/**
 * A project's own OS sandbox setting, shown while the machine's sandbox is on (or the project is already set): where it
 * holds a tool that can't run inside it, that Overhand runs it on the guard only, and the guard-only line once it's off.
 */
function ProjectSandboxField({ i, tools }: { i: number; tools: Record<string, string> }) {
  const f = useForm();
  const w = useWords();
  const name = str(getAt(f.draft, `clients.${i}.name`));
  const set = getAt(f.draft, `clients.${i}.sandbox`);
  const own = set === "off" || set === "keep" ? set : "inherit";
  const mode = getAt(f.draft, "sandbox.mode");
  const machine = {
    mode: mode === "log" || mode === "enforce" ? mode : "off",
    required: getAt(f.draft, "sandbox.required") === true,
  } as const;
  const tool = tools[name] ?? "";
  if (machine.mode === "off" && own === "inherit") return null;
  const line = !guardOnly(machine, own, tool) ? "" : own === "off" ? w.sandboxGuardOnly : fmt(w.sandboxAutoLine, { tool });
  return (
    <div id={`set-sandbox-${name}`} className="grid scroll-mt-4 gap-1">
      <Field
        label={`${name}: ${w.sandboxProjectLabel}`}
        path={`clients.${i}.sandbox`}
        kind={{
          options: ["inherit", "off", "keep"],
          fallback: "inherit",
          labels: { inherit: w.sandboxProjectInherit, off: w.sandboxProjectOff, keep: w.sandboxKeep },
        }}
      />
      {line ? <p className="text-xs text-muted-foreground">{line}</p> : null}
    </div>
  );
}

/**
 * Settings → Safety: the OS sandbox's one switch and what it does (with what it can't stop), each project's own setting (the ones it can't hold shown, the rest under More),
 * then the house rules every connected session follows (enforced by the guard rather than messaged), Slack drafts only,
 * the words never sent anywhere, quiet hours and the daily budget. Agents can't change any of this: it lives in
 * Overhand's own config.
 */
export function SafetySection({ sandbox, focus }: { sandbox: SandboxStatus; focus?: string }) {
  const w = useWords();
  const f = useForm();
  const m = useModel();
  const id = useId();
  const clients = list(f.draft.clients);
  // opened for one project (Needs you's "runs on the guard only"): bring its sandbox setting into view
  useEffect(() => {
    if (focus) document.getElementById(`set-sandbox-${focus}`)?.scrollIntoView({ block: "center" });
  }, [focus]);
  return (
    <>
      <FieldCard title={w.sandboxSwitch}>
        <FeatureTip at="settings-sandbox" className="col-span-full" />
        {/* one switch: on is enforce; log only stays a config value, and shows as on */}
        <Field label={w.sandboxSwitch} path="sandbox.mode" kind={{ off: "off", on: "enforce" }} />
        <p className="col-span-full text-xs text-muted-foreground">
          {SANDBOX_SWITCH}{" "}
          <a className="text-primary underline" href={`${SITE}/docs/guard.html#limit`} target="_blank" rel="noopener noreferrer">
            {w.sandboxCantStop}
          </a>
        </p>
        <p className="col-span-full text-xs text-muted-foreground">{sandboxLine(sandbox)}</p>
        {/* a project it can't hold shows; the rest are one More away, while the sandbox is on */}
        {clients.map((c, i) =>
          flagged(c, sandbox.tools) ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: config items have no id; version re-keys them when items shift
            <ProjectSandboxField key={`${f.version}-${i}`} i={i} tools={sandbox.tools} />
          ) : null,
        )}
        {["log", "enforce"].includes(str(getAt(f.draft, "sandbox.mode"))) && clients.some((c) => !flagged(c, sandbox.tools)) ? (
          <More>
            {clients.map((c, i) =>
              flagged(c, sandbox.tools) ? null : (
                // biome-ignore lint/suspicious/noArrayIndexKey: config items have no id; version re-keys them when items shift
                <ProjectSandboxField key={`${f.version}-${i}`} i={i} tools={sandbox.tools} />
              ),
            )}
          </More>
        ) : null}
      </FieldCard>
      <FieldCard title={w.safetyRules}>
        <div className="grid gap-1 sm:col-span-2">
          <Label htmlFor={`${id}-n`} className="text-xs text-muted-foreground">
            {w.setHouseRules}
          </Label>
          <Textarea
            id={`${id}-n`}
            key={f.version}
            defaultValue={list(getAt(f.draft, "control.notes")).map(str).join("\n")}
            className="min-h-20 text-sm"
            onBlur={(e) =>
              f.set(
                "control.notes",
                e.target.value
                  .split("\n")
                  .map((l) => l.trim())
                  .filter(Boolean),
              )
            }
          />
        </div>
        <div className="flex items-center justify-between gap-3 py-1 sm:col-span-2">
          <Label htmlFor={`${id}-s`} className="text-xs text-muted-foreground">
            {w.setSlackDrafts}
          </Label>
          <Switch
            id={`${id}-s`}
            checked={getAt(f.draft, "control.slackDraftsOnly") !== false}
            onCheckedChange={(on) => f.set("control.slackDraftsOnly", on)}
          />
        </div>
        <Field label={w.setPrivate} path="outward.deny" kind="csv" />
        <div className="grid gap-1 sm:col-span-2">
          <Label htmlFor={`${id}-w`} className="block max-w-prose text-xs text-muted-foreground">
            {fmt(w.setQuietHours, { kinds: KINDS.join(", ") })}
          </Label>
          <Textarea
            id={`${id}-w`}
            key={f.version}
            defaultValue={windowsText(f.draft)}
            className="min-h-20 font-mono text-xs"
            onBlur={(e) => f.set("control.windows", parseWindows(e.target.value))}
          />
        </div>
      </FieldCard>
      <FieldCard title={w.quickBudget}>
        <Field label={w.setBudget} path="limits.dailyBudgetUsd" kind="num" />
        {/* the budget caps billed money only: with every account on a plan or this computer, it says it doesn't apply */}
        <p className="text-xs text-muted-foreground sm:col-span-2">
          {[m && !budgetApplies(m.s) ? w.quickBudgetNA : w.quickBudgetHint, w.budgetUnknown, w.plansLimit].join(" ")}
        </p>
      </FieldCard>
    </>
  );
}

/** Advanced → Standing approvals: with one, Overhand does what the action card would ask, then tells you. */
export function ApprovalsCard() {
  const f = useForm();
  const [action, setAction] = useState("stop-heavy-in-quiet");
  const [project, setProject] = useState("*");
  const approvals = list(getAt(f.draft, "control.approvals")).filter(isObject);
  const projects = list(getAt(f.draft, "clients"))
    .filter(isObject)
    .map((c) => str(c.name))
    .filter(Boolean);
  return (
    <FieldCard title="Standing approvals">
      <p className="text-xs text-muted-foreground sm:col-span-2">
        With one, Overhand does what the action card would ask, then tells you. Revoke any time.
      </p>
      {approvals.length ? (
        <ul className="grid gap-1 sm:col-span-2">
          {approvals.map((a, i) => (
            <li key={`${str(a.action)}-${str(a.project)}`} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1">
                {APPROVALS[str(a.action)] ?? str(a.action)}
                <span className="text-muted-foreground"> · {str(a.project) === "*" ? "every project" : str(a.project)}</span>
              </span>
              <Button
                variant="ghost"
                size="xs"
                onClick={() =>
                  f.set(
                    "control.approvals",
                    approvals.filter((_, j) => j !== i),
                  )
                }
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5 sm:col-span-2">
        <select
          aria-label="Approval"
          className="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-1.5 text-xs"
          value={action}
          onChange={(e) => setAction(e.target.value)}
        >
          {Object.entries(APPROVALS).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
        <select
          aria-label="Project"
          className="h-8 rounded-md border border-input bg-transparent px-1.5 text-xs"
          value={project}
          onChange={(e) => setProject(e.target.value)}
        >
          <option value="*">Every project</option>
          {projects.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
        <Button variant="outline" size="xs" onClick={() => f.set("control.approvals", [...approvals, { action, project, at: Date.now() }])}>
          Add
        </Button>
      </div>
    </FieldCard>
  );
}

/** Advanced → Protected processes: never stopped or restarted, by port, name or container. */
export function ProtectCard() {
  const f = useForm();
  const id = useId();
  return (
    <FieldCard title="Protected processes (never stopped or restarted)">
      <div className="grid gap-1">
        <Label htmlFor={`${id}-p`} className="text-xs text-muted-foreground">
          Ports
        </Label>
        <Input
          id={`${id}-p`}
          key={f.version}
          className="h-8"
          defaultValue={list(getAt(f.draft, "governor.protect.ports")).join(", ")}
          onBlur={(e) =>
            f.set(
              "governor.protect.ports",
              e.target.value
                .split(/[\s,]+/)
                .map(Number)
                .filter((n) => Number.isInteger(n) && n > 0 && n < 65536),
            )
          }
        />
      </div>
      <Field label="Process names" path="governor.protect.names" kind="csv" />
      <Field label="Docker container name prefixes" path="governor.protect.containerPrefixes" kind="csv" />
    </FieldCard>
  );
}
