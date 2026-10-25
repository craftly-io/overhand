import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { getAt, isObject, type Json, type JsonObject } from "@/lib/json";
import { Field, FieldCard, useForm } from "./SettingsFields";

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

/**
 * The house rules every connected session follows (Overhand's agents and leads, and your own sessions in projects you
 * connected), enforced by the guard rather than messaged, and the standing approvals that let Overhand act on an action
 * card without asking. Agents can't change any of this: it lives in Overhand's own config.
 */
export function HouseRulesTab() {
  const f = useForm();
  const id = useId();
  const [action, setAction] = useState("stop-heavy-in-quiet");
  const [project, setProject] = useState("*");
  const approvals = list(getAt(f.draft, "control.approvals")).filter(isObject);
  const projects = list(getAt(f.draft, "clients"))
    .filter(isObject)
    .map((c) => str(c.name))
    .filter(Boolean);
  return (
    <>
      <p className="text-sm text-muted-foreground">
        House rules apply to every connected session on this machine: Overhand's agents and leads, and Claude Code sessions you opened
        yourself in a project you connected (Crew › Sessions, or overhand connect). The guard enforces them on every tool call; each session
        is handed them once, and again after a change.
      </p>
      <FieldCard title="Hold windows">
        <div className="grid gap-1 sm:col-span-2">
          <Label htmlFor={`${id}-w`} className="block max-w-prose text-xs text-muted-foreground">
            One per line, every day: 22:00-07:00 holds every heavy job (a quiet window); 00:00-19:07 browser holds only headless browsers.
            Kinds: {KINDS.join(", ")}.
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
      <FieldCard title="Rules">
        <div className="flex items-center justify-between gap-3 py-1 sm:col-span-2">
          <Label htmlFor={`${id}-s`} className="text-xs text-muted-foreground">
            Slack: drafts only (sessions may search and read; you send)
          </Label>
          <Switch
            id={`${id}-s`}
            checked={getAt(f.draft, "control.slackDraftsOnly") !== false}
            onCheckedChange={(on) => f.set("control.slackDraftsOnly", on)}
          />
        </div>
        <div className="grid gap-1 sm:col-span-2">
          <Label htmlFor={`${id}-n`} className="text-xs text-muted-foreground">
            In your words, one per line (handed to every session, e.g. "No pull requests to another project's repo")
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
      </FieldCard>
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
          <Button
            variant="outline"
            size="xs"
            onClick={() => f.set("control.approvals", [...approvals, { action, project, at: Date.now() }])}
          >
            Add
          </Button>
        </div>
      </FieldCard>
    </>
  );
}
