import {
  AUTONOMY_LEVELS,
  BILLINGS,
  type Billing,
  type Check,
  comboLabel,
  detectBilling,
  guardLine,
  guardOnly,
  REPO_URL,
  ROUTING_MODES,
  SANDBOX_LIMIT,
  SANDBOX_MODE_LABELS,
  SANDBOX_STOPS,
  SettingsSavedSchema,
  SettingsSchema,
  sandboxLine,
} from "@overhand/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { STATE_KEY, useModel } from "@/app/data";
import { useWords } from "@/app/theme";
import { AddAccount } from "@/components/AddAccount";
import { AddProjects, type Proposed } from "@/components/AddProjects";
import { Connections } from "@/components/Connections";
import { FeatureTip } from "@/components/FeatureTip";
import { SeededWords } from "@/components/Outward";
import { GroupsBoard } from "@/components/organise/GroupsBoard";
import { SuggestionCards } from "@/components/organise/SuggestionCards";
import { Phone } from "@/components/Phone";
import { AccountSignIn } from "@/components/SignIn";
import { Button } from "@/components/ui/button";
import { Skeleton, SkeletonRows } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { get, post } from "@/lib/api";
import { fmt, until } from "@/lib/format";
import { getAt, isObject, type Json, type JsonObject, setAt } from "@/lib/json";
import { LEVEL_WORDS, MEANS_WORDS } from "@/lib/leads";
import { onOrganised } from "@/lib/organise";
import { patchOrganised } from "@/lib/organise-patch";
import { pushBranchesOf, pushOptions, togglePush } from "@/lib/push";
import { TeamSettings } from "../team/TeamSettings";
import { DrawerHead } from "./DrawerHost";
import { AgentTuning } from "./SettingsAgent";
import { CheckRows, Field, FieldCard, FormCtx, type SettingsForm, useForm } from "./SettingsFields";
import { LookTab, SystemTab } from "./SettingsLook";
import { SettingsReports } from "./SettingsReports";
import { HouseRulesTab } from "./SettingsRules";
import { StatusUpdates } from "./SettingsUpdates";

const TABS = [
  ["projects", "Projects"],
  ["accounts", "Agent accounts"],
  ["leads", "Leads"],
  ["schedule", "Schedule & limits"],
  ["rules", "House rules"],
  ["integrations", "Integrations"],
  ["phone", "Phone"],
  ["team", "Team"],
  ["look", "Look & sound"],
  ["health", "Machine checks"],
  ["system", "System"],
  ["json", "Advanced"],
] as const;

const str = (x: Json | undefined) => (typeof x === "string" ? x : "");
const objects = (x: Json | undefined): JsonObject[] => (Array.isArray(x) ? x.filter(isObject) : []);

const blankLead = (key: string, label: string, project: string, dir: string): JsonObject => ({
  key,
  label,
  name: "",
  project,
  dir,
  goal: "",
  prompt: "",
  supervised: false,
  onDemand: false,
  account: "",
  lockFile: "",
  lockStaleMin: 45,
  inboxFile: "",
  restartAfterMin: 5,
  maxCrashesPerHour: 3,
  answerWaitHours: 4,
});

/** A project's CI, deploy and error sources, edited inside its card. GitHub Actions is read through `gh` and needs nothing. */
function StatusBlock({ i }: { i: number }) {
  const f = useForm();
  const at = `clients.${i}.status`;
  const jenkins = getAt(f.draft, `${at}.jenkins`);
  return (
    <>
      <div className="flex items-center justify-between sm:col-span-2">
        <b className="text-sm">Status sources</b>
        {jenkins ? (
          <Button size="xs" variant="ghost" onClick={() => f.set(`${at}.jenkins`, undefined)}>
            Remove Jenkins
          </Button>
        ) : (
          <Button
            size="xs"
            variant="outline"
            onClick={() => f.set(`${at}.jenkins`, { url: "", user: "", secret: "overhand-jenkins", orgFolder: "", jobFolders: [] })}
          >
            + Jenkins
          </Button>
        )}
      </div>
      <Field label={`Vercel tokens (names in ${f.store})`} path={`${at}.vercelSecrets`} kind="csv" />
      <Field label={`Sentry tokens (names in ${f.store})`} path={`${at}.sentrySecrets`} kind="csv" />
      {jenkins ? (
        <>
          <Field label="Jenkins URL" path={`${at}.jenkins.url`} />
          <Field label="Jenkins user" path={`${at}.jenkins.user`} />
          <Field label={`Jenkins token (name in ${f.store})`} path={`${at}.jenkins.secret`} />
          <Field label="Org folder (one job per Bitbucket repo)" path={`${at}.jenkins.orgFolder`} />
          <Field label="Plain job folders" path={`${at}.jenkins.jobFolders`} kind="csv" />
        </>
      ) : null}
    </>
  );
}

/**
 * A project's leads, run from here: on or off, always on or waking when Overhand finds work, and the account each
 * tries first. Everything else about a lead (its folder, goal, files) is in the Leads tab.
 */
function LeadBlock({ client, onLeads }: { client: JsonObject; onLeads: () => void }) {
  const f = useForm();
  const w = useWords();
  const name = str(client.name);
  const all = objects(f.draft.godmode);
  const mine = all.flatMap((g, at) => (g.project === name ? [{ g, at }] : []));
  const accounts = Array.isArray(f.draft.accounts) ? f.draft.accounts.filter((a): a is string => typeof a === "string") : [];
  const add = () => {
    f.set(`godmode.${all.length}`, blankLead(name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), `${name} lead`, name, str(client.dir)));
    onLeads();
  };
  return (
    <div className="grid gap-2 sm:col-span-2">
      <div className="flex items-center justify-between gap-2">
        <b className="text-sm">{w.leadsLabel}</b>
        <Button size="xs" variant="outline" onClick={mine.length ? onLeads : add}>
          {mine.length ? "More in Leads" : "+ Add a lead"}
        </Button>
      </div>
      {mine.length ? null : <p className="text-xs text-muted-foreground">{w.leadsNone}</p>}
      {mine.map(({ g, at }) => (
        <div key={at} className="grid gap-2 rounded-md border border-border p-2 sm:grid-cols-3 sm:items-end">
          <Field label={`${str(g.label) || str(g.key)}: ${w.leadOn}`} path={`godmode.${at}.supervised`} kind="bool" />
          <LeadMode at={at} />
          <Field
            label={w.leadAccount}
            path={`godmode.${at}.account`}
            kind={{ options: ["", ...accounts], labels: { "": w.leadAnyAccount } }}
          />
          <LeadPush at={at} />
        </div>
      ))}
    </div>
  );
}

/**
 * The protected branches this lead may push to straight away (config `pushBranches`), off unless you pick one. A config
 * from a daemon without the setting has no field: it reads as none, and is written only once you pick a branch.
 */
function LeadPush({ at }: { at: number }) {
  const f = useForm();
  const w = useWords();
  const path = `godmode.${at}.pushBranches`;
  const on = pushBranchesOf(getAt(f.draft, path));
  return (
    <fieldset className="grid gap-1.5 sm:col-span-3">
      <legend className="mb-1 text-xs text-muted-foreground">{w.leadPushLabel}</legend>
      <div className="flex flex-wrap gap-1.5">
        {pushOptions(on).map((b) => (
          <Button
            key={b}
            size="xs"
            variant={on.includes(b) ? "danger" : "outline"}
            aria-pressed={on.includes(b)}
            className="font-mono"
            onClick={() => f.set(path, togglePush(on, b))}
          >
            {b}
          </Button>
        ))}
      </div>
      <p className={on.length ? "text-xs text-warn" : "text-xs text-muted-foreground"} role={on.length ? "note" : undefined}>
        {on.length ? fmt(w.leadPushWarn, { branches: on.join(", ") }) : w.leadPushOff}
      </p>
    </fieldset>
  );
}

/** Always on, or asleep until Overhand finds work for the project (config `onDemand`). */
function LeadMode({ at }: { at: number }) {
  const f = useForm();
  const w = useWords();
  const path = `godmode.${at}.onDemand`;
  const wakes = getAt(f.draft, path) === true;
  return (
    <label className="grid gap-1 text-xs text-muted-foreground">
      {w.leadMode}
      <select
        className="h-8 border border-input bg-transparent px-2 text-sm text-foreground"
        value={wakes ? "wakes" : "always"}
        onChange={(e) => f.set(path, e.target.value === "wakes")}
      >
        <option value="always">{w.leadAlways}</option>
        <option value="wakes">{w.leadWakes}</option>
      </select>
    </label>
  );
}

/**
 * How far agents go on this project, by name, with what it means in one line; on watch and propose also how far a
 * ticket you assign an agent to goes. A config without either acts, and assigning opens a PR.
 */
function AutonomyField({ i }: { i: number }) {
  const f = useForm();
  const w = useWords();
  const m = useModel();
  const v = getAt(f.draft, `clients.${i}.autonomy`);
  const level = v === "watch" || v === "propose" || v === "ship" ? v : "act";
  const names = Object.fromEntries(AUTONOMY_LEVELS.map((l) => [l, w[LEVEL_WORDS[l]]]));
  // why Ship can't be on here, as the daemon last read it (saving refuses it too)
  const name = str(getAt(f.draft, `clients.${i}.name`));
  const project = m?.s.clients.find((c) => c.name === name);
  const block = project?.shipBlock ?? "";
  return (
    <div className="grid gap-2 sm:col-span-2 sm:grid-cols-2">
      <div className="grid gap-1">
        <Field
          label={w.autonomyLabel}
          path={`clients.${i}.autonomy`}
          kind={{ options: [...AUTONOMY_LEVELS].reverse(), fallback: "act", labels: names }}
        />
        <p className="text-xs text-muted-foreground">{w[MEANS_WORDS[level]]}</p>
        {block && (level === "ship" || project?.host === "github") ? (
          <p className="text-xs text-warn">{`${block} ${level === "ship" ? w.shipStays : ""}`.trim()}</p>
        ) : null}
      </div>
      {level === "ship" ? (
        <>
          <Field label={w.shipProtect} path={`clients.${i}.ship.protect`} kind="csv" />
          <Field label={w.shipPerDay} path={`clients.${i}.ship.perDay`} kind="num" />
        </>
      ) : null}
      {level === "act" || level === "ship" ? null : (
        <div className="grid gap-1">
          <Field
            label={w.assignedLabel}
            path={`clients.${i}.assignedAutonomy`}
            kind={{ options: ["act", "propose"], fallback: "act", labels: { act: w.assignedAct, propose: w.assignedPropose } }}
          />
          <p className="text-xs text-muted-foreground">{w.assignedHint}</p>
        </div>
      )}
    </div>
  );
}

/**
 * A project's own OS sandbox setting, shown while the machine's sandbox is on (or the project is already off): the
 * suggestion where it holds a tool that can't run inside it, and the guard-only line once it's off. `named` puts the
 * project's name first, for the machine's sandbox card. Nothing here switches it: you do.
 */
function ProjectSandboxField({ i, suggest, named = false }: { i: number; suggest: Record<string, string>; named?: boolean }) {
  const f = useForm();
  const w = useWords();
  const name = str(getAt(f.draft, `clients.${i}.name`));
  const own = getAt(f.draft, `clients.${i}.sandbox`) === "off" ? "off" : "inherit";
  const mode = getAt(f.draft, "sandbox.mode");
  const machine = {
    mode: mode === "log" || mode === "enforce" ? mode : "off",
    required: getAt(f.draft, "sandbox.required") === true,
  } as const;
  const tool = own === "inherit" && machine.mode === "enforce" ? (suggest[name] ?? "") : "";
  if (machine.mode === "off" && own === "inherit") return null;
  if (named && !tool && own === "inherit") return null;
  const line = tool ? w.sandboxSuggest.replace("{tool}", tool) : guardOnly(machine, own) ? w.sandboxGuardOnly : "";
  return (
    <div className="grid gap-1">
      <Field
        label={named ? `${name}: ${w.sandboxProjectLabel}` : w.sandboxProjectLabel}
        path={`clients.${i}.sandbox`}
        kind={{ options: ["inherit", "off"], fallback: "inherit", labels: { inherit: w.sandboxProjectInherit, off: w.sandboxProjectOff } }}
      />
      {line ? <p className="text-xs text-muted-foreground">{line}</p> : null}
    </div>
  );
}

function ProjectsTab({
  codeRoot,
  focus,
  onLeads,
  suggest,
}: {
  codeRoot: string;
  focus?: string;
  onLeads: () => void;
  suggest: Record<string, string>;
}) {
  const w = useWords();
  const f = useForm();
  const clients = objects(f.draft.clients);
  const [fromGithub, setFromGithub] = useState(0);
  // a repo picked or pasted above lands in its owner's folder: a project for that folder joins the list (one you
  // already have for it gets the repo by itself), tracked with that repo's issues, careful to start
  const addFromGithub = (projects: Proposed[]) => {
    const have = new Set(clients.map((c) => str(c.dir)));
    const fresh = projects.filter((p) => !have.has(p.dir));
    if (!fresh.length) return;
    // one set: each set starts from this render's draft
    f.set("clients", [
      ...clients,
      ...fresh.map((p) => ({
        name: p.name,
        dir: p.dir,
        prefix: p.prefix,
        host: "github",
        tracker: { kind: "github", repo: p.trackerRepo },
        aliases: [],
        accounts: [],
        fallbackToAll: true,
        autonomy: "propose",
      })),
    ]);
    setFromGithub((n) => n + fresh.length);
  };
  // opened for one project (the scorecard's suggestion): bring its card, and its accounts, into view
  useEffect(() => {
    if (focus) document.getElementById(`set-project-${focus}`)?.scrollIntoView({ block: "start" });
  }, [focus]);
  return (
    <>
      <p className="text-sm text-muted-foreground">
        One project per client. Its folder sits under {codeRoot}; ticket keys like {str(clients[0]?.prefix) || "HONEY"}-123 route to it.
      </p>
      <section className="field-card grid gap-3 border border-border p-4" aria-labelledby="set-groups">
        <b id="set-groups" data-heading="" className="font-display text-sm">
          {w.orgGroups}
        </b>
        <p className="text-sm text-muted-foreground">{w.orgGroupsHint}</p>
        <GroupsBoard />
        <SuggestionCards />
      </section>
      <AddProjects onReady={addFromGithub} />
      {fromGithub ? <p className="text-sm text-muted-foreground">Added {fromGithub} from GitHub below. Save to keep them.</p> : null}
      {clients.map((c, i) => {
        const kind = str(isObject(c.tracker) ? c.tracker.kind : undefined);
        return (
          <FieldCard
            // biome-ignore lint/suspicious/noArrayIndexKey: config items have no id; version re-keys them when items shift
            key={`${f.version}-${i}`}
            id={`set-project-${str(c.name)}`}
            note={f.conflicts.has(`project:${str(c.name)}`) ? w.orgConflictProject : undefined}
            title={str(c.name) || "New project"}
            onRemove={() => f.set(`clients.${i}`, undefined)}
          >
            <Field label="Name" path={`clients.${i}.name`} />
            <Field label="Folder" path={`clients.${i}.dir`} kind="list" />
            <Field label="Ticket prefix" path={`clients.${i}.prefix`} />
            <AutonomyField i={i} />
            <ProjectSandboxField i={i} suggest={suggest} />
            <Field label="Git host" path={`clients.${i}.host`} kind={{ options: ["github", "bitbucket"] }} />
            <Field
              label="Tracker"
              path={`clients.${i}.tracker.kind`}
              kind={{ options: ["", "linear", "jira", "github"], labels: { "": "No tracker" } }}
            />
            {!kind ? null : kind === "github" ? (
              <Field label="GitHub repo (owner/name)" path={`clients.${i}.tracker.repo`} />
            ) : (
              <Field
                label={`Tracker token (name in ${f.store}; empty when connected under Integrations)`}
                path={`clients.${i}.tracker.secret`}
              />
            )}
            {kind === "jira" ? (
              <>
                <Field label="Jira site" path={`clients.${i}.tracker.site`} />
                <Field label="Jira email (with a token)" path={`clients.${i}.tracker.email`} />
                <Field label="Jira project" path={`clients.${i}.tracker.project`} />
              </>
            ) : null}
            <LeadBlock client={c} onLeads={onLeads} />
            <Field label="Aliases (orgs, words)" path={`clients.${i}.aliases`} kind="csv" />
            <Field
              label="Private words (people, products, hosts): never sent to another project"
              path={`clients.${i}.private`}
              kind="csv"
            />
            <SeededWords name={str(c.name)} prefix={str(c.prefix)} aliases={Array.isArray(c.aliases) ? c.aliases.map((a) => str(a)) : []} />
            <Field label="Agent accounts (runs use the first; empty = the first account)" path={`clients.${i}.accounts`} kind="csv" />
            <Field
              label="Preview command for PR screenshots (e.g. bun run storybook --ci -p 6106; empty = none)"
              path={`clients.${i}.preview.command`}
            />
            <Field label="Preview URL to screenshot once it answers" path={`clients.${i}.preview.url`} />
            <StatusBlock i={i} />
          </FieldCard>
        );
      })}
      <Button
        variant="outline"
        onClick={() =>
          f.set(`clients.${clients.length}`, {
            name: "",
            dir: "",
            prefix: "",
            host: "github",
            tracker: { kind: "linear", secret: "" },
            aliases: [],
            accounts: [],
            fallbackToAll: true,
            // a new project starts careful: draft PRs you mark ready
            autonomy: "propose",
          })
        }
      >
        + Add project
      </Button>
    </>
  );
}

function LeadsTab() {
  const w = useWords();
  const f = useForm();
  const leads = objects(f.draft.godmode);
  const projects = ["", ...objects(f.draft.clients).map((c) => str(c.name))];
  return (
    <>
      <p className="text-sm text-muted-foreground">
        Leads run a whole project on their own. When on, Overhand keeps one running, restarts it after it exits, waits out its account's
        usage limit, keeps the machine awake while it works, and shows its output and questions on the dashboard. Paths are relative to the
        Code folder.{" "}
        <a className="text-primary underline" href={`${REPO_URL}/blob/main/docs/leads.md`} target="_blank" rel="noopener noreferrer">
          How a project's own lead skill works with Overhand
        </a>
        .
      </p>
      {leads.map((g, i) => (
        <FieldCard
          // biome-ignore lint/suspicious/noArrayIndexKey: config items have no id; version re-keys them when items shift
          key={`${f.version}-${i}`}
          title={str(g.label) || "New lead"}
          note={f.conflicts.has(`lead:${str(g.key)}`) ? w.orgConflictLead : undefined}
          onRemove={() => f.set(`godmode.${i}`, undefined)}
        >
          <Field label="Key" path={`godmode.${i}.key`} />
          <Field label="Label" path={`godmode.${i}.label`} />
          <Field label="Project" path={`godmode.${i}.project`} kind={{ options: projects }} />
          <Field label="Folder" path={`godmode.${i}.dir`} kind="list" />
          <Field label="Goal" path={`godmode.${i}.goal`} />
          <Field label="Own instruction (empty = generic)" path={`godmode.${i}.prompt`} />
          {str(g.project) ? (
            // one place for these: the project's card, beside its autonomy
            <p className="text-xs text-muted-foreground sm:col-span-2">
              On, when it runs and its account: under {str(g.project)} in Projects.
            </p>
          ) : (
            <>
              <Field label="On" path={`godmode.${i}.supervised`} kind="bool" />
              <Field label="Only when Overhand finds work" path={`godmode.${i}.onDemand`} kind="bool" />
              <Field label="Account (empty = the first)" path={`godmode.${i}.account`} />
              <Field label={w.leadAccountsLabel} path={`godmode.${i}.accounts`} kind="csv" />
              <Field label={w.leadFallbackLabel} path={`godmode.${i}.fallbackToAll`} kind="bool" />
            </>
          )}
          <Field label="Lock file" path={`godmode.${i}.lockFile`} kind="list" />
          <Field label="Lock stale after (min)" path={`godmode.${i}.lockStaleMin`} kind="num" />
          <Field label="Questions file" path={`godmode.${i}.inboxFile`} kind="list" />
          <Field label={w.leadRestartLabel} path={`godmode.${i}.restartAfterMin`} kind="num" />
          <Field label="Give up after crashes/hour" path={`godmode.${i}.maxCrashesPerHour`} kind="num" />
          <Field label="Go with its default after (h, 0 = wait for you)" path={`godmode.${i}.answerWaitHours`} kind="num" />
        </FieldCard>
      ))}
      <Button variant="outline" onClick={() => f.set(`godmode.${leads.length}`, blankLead("", "", "", ""))}>
        + Add lead
      </Button>
    </>
  );
}

function ScheduleTab() {
  const w = useWords();
  const num = (label: string, path: string) => <Field key={path} label={label} path={path} kind="num" />;
  return (
    <>
      <FieldCard title="Schedule">
        {num("Plan from hour", "schedule.planFromHour")}
        {num("Night report at hour (-1 = off)", "schedule.briefAtHour")}
        <Field
          label="Seasons follow (hemisphere; auto = from the time zone)"
          path="schedule.hemisphere"
          kind={{ options: ["auto", "north", "south"], fallback: "auto" }}
        />
        {num("Slack from hour", "schedule.inboxFromHour")}
        {num("Slack until hour", "schedule.inboxToHour")}
        {num("Slack every (min)", "schedule.inboxEveryMin")}
        {num("Next pass after work (min)", "schedule.busyPollMin")}
        {num("Next pass when idle (min)", "schedule.idlePollMin")}
      </FieldCard>
      <FieldCard title="Limits">
        {num("Tickets per pass", "limits.maxTasksPerRun")}
        {num("Ticket timeout (min)", "limits.taskTimeoutMin")}
        {num("Attempts per ticket", "limits.maxAttempts")}
        {num("Fix rounds per PR", "limits.maxFixes")}
        {num("Account cooldown (min)", "limits.cooldownMin")}
        {num("Slack veto window (min)", "limits.slackVetoMin")}
        {num("Ignore repos idle (days)", "limits.dormantDays")}
        {num(w.setBudget, "limits.dailyBudgetUsd")}
      </FieldCard>
      <FieldCard title="Labels">
        <Field label="Queue" path="labels.queue" />
        <Field label="Working" path="labels.working" />
        <Field label="Review" path="labels.review" />
        <Field label="Blocked (needs you)" path="labels.blocked" />
        <Field label="From Slack" path="labels.fromSlack" />
      </FieldCard>
    </>
  );
}

function IntegrationsTab({ checks, store }: { checks: Check[]; store: (service: string, value: string) => void }) {
  const f = useForm();
  const slack = objects(f.draft.slack)
    .map((x) => `${str(x.server)} = ${str(x.client)}`)
    .join("\n");
  return (
    <>
      <Connections />
      <FieldCard title="Slack workspaces">
        <div className="grid gap-1 sm:col-span-2">
          <p className="text-xs text-muted-foreground">One per line: MCP server = project (servers live in {f.slackMcp}).</p>
          <Textarea
            key={f.version}
            aria-label="Slack workspaces"
            data-data=""
            defaultValue={slack}
            className="min-h-24 font-mono text-xs"
            onBlur={(e) =>
              f.set(
                "slack",
                e.target.value
                  .split("\n")
                  .map((l) => l.split("=").map((x) => x.trim()))
                  .flatMap(([server, client]) => (server && client ? [{ server, client }] : [])),
              )
            }
          />
        </div>
      </FieldCard>
      <FieldCard title="Bitbucket" onRemove={f.draft.bitbucket ? () => f.set("bitbucket", undefined) : undefined}>
        {f.draft.bitbucket ? (
          <>
            <Field label="Email" path="bitbucket.email" />
            <Field label="Workspace" path="bitbucket.workspace" />
            <Field label={`Token (name in ${f.store})`} path="bitbucket.secret" />
          </>
        ) : (
          <Button
            size="xs"
            variant="outline"
            onClick={() => f.set("bitbucket", { email: "", workspace: "", secret: "overhand-bitbucket" })}
          >
            Connect Bitbucket
          </Button>
        )}
      </FieldCard>
      <FieldCard title={`Shared status sources (names in ${f.store})`}>
        <p className="text-xs text-muted-foreground sm:col-span-2">
          Tokens that see several projects; what they find is matched to a project by its name and aliases. Per-project sources live on each
          project.
        </p>
        <Field label="Vercel tokens" path="status.vercelSecrets" kind="csv" />
        <Field label="Sentry tokens" path="status.sentrySecrets" kind="csv" />
        <Field label="Calendar iCal URLs" path="status.icalSecret" />
      </FieldCard>
      <StatusUpdates checks={checks} store={store} />
      <SettingsReports />
      <FieldCard title="What clients see">
        <Field label="Agent branch prefix (empty = ticket key only)" path="outward.branchPrefix" />
        <Field label="Show AI attribution in commits and PRs" path="outward.aiAttribution" kind="bool" />
        <Field label="Comment on agent PRs that may have cut a corner (once per new finding)" path="outward.cornerComment" kind="bool" />
        <Field label="Never send anywhere (private emails, hosts, names)" path="outward.deny" kind="csv" />
      </FieldCard>
      <FieldCard title="Other addresses">
        <Field label="Extra origins (Settings → Phone adds your tailscale serve URL)" path="dashboardOrigins" kind="csv" />
        <Field label={`Phone notifications: ntfy topic URL (name in ${f.store})`} path="ntfySecret" />
      </FieldCard>
    </>
  );
}

/** Anthropic-compatible endpoints a gateway account can start from; any other URL works too. */
const GATEWAYS = [
  ["Ollama", "http://localhost:11434"],
  ["LiteLLM", "http://localhost:4000"],
  ["OpenRouter", "https://openrouter.ai/api"],
  ["Custom", ""],
] as const;

/** Agent CLIs an account can run (packages/core/src/runtimes); Claude Code is the default. */
const RUNTIMES = ["claude-code", "codex", "gemini", "cursor", "opencode", "aider"];
/** Option labels: agents, providers and sign-ins by name, not config id. */
const RUNTIME_LABELS = Object.fromEntries(RUNTIMES.map((r) => [r, comboLabel(r)]));
const PROVIDER_LABELS = {
  claude: "Anthropic",
  bedrock: "Amazon Bedrock",
  vertex: "Google Vertex AI",
  gateway: "Gateway (Ollama, LiteLLM, OpenRouter...)",
};
const AUTH_LABELS = { login: "Claude Code sign-in", key: "Anthropic API key" };

/** Agent CLIs other than Claude Code with a sign-in of their own Overhand can open, by id. */
const LOGIN_CLIS: Partial<Record<string, string>> = { codex: "Codex", cursor: "Cursor Agent", opencode: "OpenCode" };

/**
 * How an account is paid for, which decides whether its runs' dollars are billed and count toward the daily budget. Its
 * setup suggests one (`detectBilling`); where the setup can't tell, it asks once, until the person picks.
 */
function BillingField({ account, runtime }: { account: string; runtime: string }) {
  const w = useWords();
  const f = useForm();
  const p = getAt(f.draft, `providers.${account}`);
  const guess = detectBilling({
    runtime,
    provider: isObject(p) ? { kind: str(p.kind), auth: str(p.auth), baseUrl: str(p.baseUrl) } : undefined,
    model: str(getAt(f.draft, `runtimes.${account}.model`)),
  });
  const labels: Record<Billing, string> = {
    plan: w.setBillingPlan,
    "pay-per-use": w.setBillingPayPerUse,
    cloud: w.setBillingCloud,
    local: w.setBillingLocal,
  };
  // the daemon reads the sign-in itself (a stored key, a named subscription): what it knows outranks the config's guess
  const live = useModel()?.s.accounts.find((x) => x.name === account);
  const sure = live ? live.billingSure : guess.sure;
  const ask = !sure && !str(getAt(f.draft, `billing.${account}`));
  return (
    <>
      {/* a sure guess shows as the value; an unsure one is only suggested, so picking it (the same value) still saves */}
      <Field
        label={w.setBilling}
        path={`billing.${account}`}
        kind={{ options: [...BILLINGS], fallback: sure ? (live?.billing ?? guess.billing) : undefined, labels }}
      />
      {ask ? (
        <p className="text-xs text-warn sm:col-span-2">
          {fmt(w.setBillingAsk, {
            name: account,
            guess: labels[guess.billing].toLowerCase(),
            from: guess.from === "gateway" ? w.setBillingFromGateway : w.setBillingFromCli,
          })}
        </p>
      ) : null}
    </>
  );
}

/** Each account's agent CLI and model backend, with their fields. */
function ProviderCards({ homes }: { homes: Record<string, string> }) {
  const w = useWords();
  const f = useForm();
  const names = Array.isArray(f.draft.accounts) ? f.draft.accounts.filter((x) => typeof x === "string") : [];
  const s = useModel()?.s;
  return names.map((a) => {
    // out of usage until its reset (the daemon's bench, its windows, its budget); the line goes once the time passes
    const back = s?.accounts.find((x) => x.name === a)?.coolUntil ?? 0;
    const note = s && back > s.now ? fmt(w.accOutOfUsage, { t: until(back, s.now) }) : undefined;
    const at = `providers.${a}`;
    const runtime = str(getAt(f.draft, `runtimes.${a}.kind`)) || "claude-code";
    // the provider drives Claude Code; Codex, OpenCode and Aider can use a gateway account's endpoint and model
    const backend = ["claude-code", "codex", "opencode", "aider"].includes(runtime);
    const kind = backend ? str(getAt(f.draft, `${at}.kind`)) || "claude" : "";
    return (
      <FieldCard key={a} title={`${a}: agent and model`} note={note}>
        <Field label="Agent" path={`runtimes.${a}.kind`} kind={{ options: RUNTIMES, fallback: "claude-code", labels: RUNTIME_LABELS }} />
        <p className="text-xs text-muted-foreground sm:col-span-2">{guardLine(runtime)}</p>
        {runtime !== "claude-code" ? (
          <Field label="CLI model (its own -m / --model; empty = default)" path={`runtimes.${a}.model`} />
        ) : null}
        {!backend ? (
          <p className="text-xs text-muted-foreground sm:col-span-2">
            Uses the CLI's own login, or an API key stored as {runtime}-key-{a}. Structured answers are asked for in the prompt and checked.
          </p>
        ) : null}
        {LOGIN_CLIS[runtime] && kind !== "gateway" ? (
          // the CLI's own sign-in: in this account's own folder (Codex), else the one login this computer has for it
          <div className="grid gap-1 sm:col-span-2">
            <AccountSignIn account={a} tool={LOGIN_CLIS[runtime]} label={fmt(w.addAccountSignIn, { tool: LOGIN_CLIS[runtime] })} />
            <p className="text-xs text-muted-foreground">
              {getAt(f.draft, `runtimes.${a}.ownLogin`) === true
                ? w.addAccountOwnFolder
                : fmt(w.addAccountSharedLogin, { tool: LOGIN_CLIS[runtime] })}
            </p>
          </div>
        ) : null}
        {/* switching starts the backend's fields fresh, so another backend's leftovers can't fail validation */}
        {backend ? (
          <Field
            label="Provider"
            path={`${at}.kind`}
            kind={{ options: ["claude", "bedrock", "vertex", "gateway"], fallback: "claude", labels: PROVIDER_LABELS }}
          />
        ) : null}
        {backend && kind === "claude" && runtime === "claude-code" ? (
          <>
            <Field label="Signs in with" path={`${at}.auth`} kind={{ options: ["login", "key"], fallback: "login", labels: AUTH_LABELS }} />
            {typeof getAt(f.draft, `${at}.existing`) === "string" && (str(getAt(f.draft, `${at}.auth`)) || "login") === "login" ? (
              // the Claude Code sign-in you already had: it moves to a folder of its own once signed in there, Slack too
              <div className="grid gap-1 sm:col-span-2">
                <p className="text-xs text-muted-foreground">
                  {getAt(f.draft, `${at}.movedAt`) === undefined
                    ? w.movedOffOwnBody
                    : fmt(w.addAccountUsesExisting, { tool: "Claude Code" })}
                </p>
                {getAt(f.draft, `${at}.movedAt`) === undefined ? (
                  <AccountSignIn account={a} tool="Claude Code" label={fmt(w.setupAgentSignInTo, { tool: "Claude Code" })} />
                ) : null}
                <Field label={w.slackMovedLabel} path={`${at}.slackMoved`} kind="bool" />
              </div>
            ) : (str(getAt(f.draft, `${at}.auth`)) || "login") === "login" ? (
              <div className="grid gap-1 sm:col-span-2">
                <AccountSignIn account={a} tool="Claude Code" label={fmt(w.setupAgentSignInTo, { tool: "Claude Code" })} />
                <p className="text-xs text-muted-foreground">
                  Claude Code's own sign-in, in a config folder just for this account. The login stays with Claude Code; agents never see
                  it. Save a new account first.
                </p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground sm:col-span-2">
                An Anthropic API key (billed to your Anthropic account), stored as anthropic-key-{a} below.
              </p>
            )}
          </>
        ) : null}
        {kind === "bedrock" ? (
          <>
            <Field label="AWS region" path={`${at}.region`} />
            <Field label="AWS profile (empty = default chain)" path={`${at}.profile`} />
          </>
        ) : null}
        {kind === "vertex" ? (
          <>
            <Field label="Region (CLOUD_ML_REGION, e.g. global)" path={`${at}.region`} />
            <Field label="GCP project ID" path={`${at}.project`} />
          </>
        ) : null}
        {kind === "gateway" ? (
          <>
            <div className="flex flex-wrap gap-1 sm:col-span-2">
              {GATEWAYS.map(([label, url]) => (
                <Button key={label} size="xs" variant="outline" onClick={() => f.set(`${at}.baseUrl`, url)}>
                  {label}
                </Button>
              ))}
            </div>
            <Field label="Base URL" path={`${at}.baseUrl`} />
            <Field label={`Token (name in ${f.store}; empty for Ollama)`} path={`${at}.secret`} />
          </>
        ) : null}
        {kind && kind !== "claude" ? (
          <>
            <Field label="Model (empty = default)" path={`${at}.model`} />
            <Field label="Small model (empty = Model)" path={`${at}.smallModel`} />
          </>
        ) : null}
        <BillingField account={a} runtime={runtime} />
        <AgentTuning account={a} runtime={runtime} home={homes[a] ?? ""} />
      </FieldCard>
    );
  });
}

/** Edits a draft of overhand.config.json; Save validates it on the daemon and applies it live. */
export function SettingsDrawer({ tab: opening = "projects", project }: { tab?: string; project?: string }) {
  const w = useWords();
  const qc = useQueryClient();
  const { data, refetch } = useQuery({ queryKey: ["settings"], queryFn: () => get("/api/settings", SettingsSchema), staleTime: 0 });
  const [draft, setDraft] = useState<JsonObject | null>(null);
  const [checks, setChecks] = useState<Check[]>([]);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState("");
  const [json, setJson] = useState("");
  const [tab, setTab] = useState<string>(opening);
  const [conflicts, setConflicts] = useState<ReadonlySet<string>>(new Set());
  // the config the form last loaded (or took an organise change from), to tell your unsaved edits from the daemon's changes
  const base = useRef<JsonObject>({});
  const latest = useRef<JsonObject | null>(null);
  latest.current = draft;

  const load = (config: JsonObject, c: Check[]) => {
    base.current = config;
    setConflicts(new Set());
    setDraft(config);
    setChecks(c);
    setJson(JSON.stringify(config, null, 2));
    setVersion((v) => v + 1);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: load only sets state; reload when the fetched settings change
  useEffect(() => {
    if (data) load(data.config, data.checks);
  }, [data]);
  // an organise change saved the config: take its groups, leads and project rules into the form, keep every other edit
  useEffect(
    () =>
      onOrganised(() => {
        void get("/api/settings", SettingsSchema)
          .then((r) => {
            const d = latest.current;
            if (!d) return;
            const p = patchOrganised(d, base.current, r.config);
            base.current = r.config;
            setDraft(p.draft);
            setJson(JSON.stringify(p.draft, null, 2));
            setVersion((v) => v + 1);
            setConflicts(new Set(p.conflicts));
          })
          .catch(() => {}); // the daemon went away: the form keeps what it has
      }),
    [],
  );
  if (!data || !draft)
    // the tabs, then a tab's fields: the form's shape until the config arrives
    return (
      <>
        <DrawerHead kicker={w.settingsKicker} title={w.settingsTitle} />
        <div className="mt-4 grid gap-4" aria-busy="true">
          <div className="flex flex-wrap gap-1">
            {["w-20", "w-24", "w-16", "w-28", "w-14"].map((size) => (
              <Skeleton key={size} className={`h-8 rounded-(--radius-control) ${size}`} />
            ))}
          </div>
          <SkeletonRows label={w.loading} rows={5} row="h-10 rounded-[var(--radius-inset)]" />
        </div>
      </>
    );

  const form: SettingsForm = {
    draft,
    version,
    conflicts,
    folders: data.folders,
    store: data.secretStore,
    slackMcp: data.slackMcp,
    set: (path, v) => {
      let next = setAt(draft, path, v);
      // the tracker kind decides which fields exist: Jira needs a site, GitHub a repo and no token
      if (/tracker\.kind$/.test(path) && typeof v === "string") {
        const base = path.replace(/\.kind$/, "");
        const pre = (str(getAt(next, base.replace(/\.tracker$/, ".prefix"))) || "x").toLowerCase();
        const t = getAt(next, base);
        const old = isObject(t) ? t : {};
        // no tracker: the project takes work from the dashboard and Slack only, so its tracker leaves the config
        const tracker: JsonObject | undefined = !v
          ? undefined
          : v === "github"
            ? { kind: v, repo: str(old.repo) }
            : v === "jira"
              ? {
                  kind: v,
                  secret: str(old.secret) || `overhand-${v}-${pre}`,
                  site: str(old.site),
                  email: str(old.email),
                  project: str(old.project) || pre.toUpperCase(),
                }
              : { kind: v, secret: str(old.secret) || `overhand-${v}-${pre}` };
        next = setAt(next, base, tracker);
        setVersion((x) => x + 1);
      } else if (/^providers\.[^.]+\.kind$/.test(path)) {
        next = setAt(draft, path.replace(/\.kind$/, ""), { kind: v ?? "claude" });
        setVersion((x) => x + 1);
      } else if (/^providers\.[^.]+\.auth$/.test(path)) {
        // an account with no provider yet runs on Claude: picking how it signs in makes that explicit
        next = setAt(draft, path.replace(/\.auth$/, ""), { kind: "claude", auth: v ?? "login" });
      } else if (/^runtimes\.[^.]+\.\w+$/.test(path) && !getAt(draft, path.replace(/\.\w+$/, ".kind"))) {
        // an account with no runtime entry runs Claude Code: tuning it makes that explicit, so the entry validates
        next = setAt(next, path.replace(/\.\w+$/, ".kind"), "claude-code");
      } else if (v === undefined || isObject(v)) setVersion((x) => x + 1); // added or removed a whole item: indices shift
      setDraft(next);
      setJson(JSON.stringify(next, null, 2));
    },
  };

  const providers = getAt(draft, "providers");
  const gatewaySecrets = new Set(isObject(providers) ? Object.values(providers).map((p) => str(isObject(p) ? p.secret : "")) : []);
  gatewaySecrets.delete("");

  const save = async () => {
    try {
      const r = await post("/api/settings", { config: draft }, SettingsSavedSchema);
      load(r.config ?? draft, r.checks);
      setError("");
      toast(w.saidSettingsSaved);
      void qc.invalidateQueries({ queryKey: STATE_KEY });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const storeSecret = async (service: string, value: string) => {
    try {
      const r = await post("/api/secret", { service, value }, SettingsSavedSchema);
      setChecks(r.checks);
      toast(w.saidSecretStored);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };
  const applyJson = () => {
    try {
      const parsed = z.record(z.string(), z.json()).parse(JSON.parse(json));
      setDraft(parsed);
      setVersion((v) => v + 1);
      setError("");
    } catch (e) {
      setError(`JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <FormCtx value={form}>
      <DrawerHead kicker={w.settingsKicker} title={w.settingsTitle} />
      <datalist id="set-folders">
        {data.folders.map((x) => (
          <option key={x} value={x} />
        ))}
      </datalist>
      <Tabs value={tab} onValueChange={setTab} className="mt-4">
        {/* wraps on a phone: the list's own fixed height would hide every row after the first */}
        <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1 group-data-[orientation=horizontal]/tabs:h-auto">
          {TABS.map(([k, label]) => (
            <TabsTrigger key={k} value={k} className="h-8 flex-none">
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="projects" className="grid gap-3">
          <ProjectsTab codeRoot={data.codeRoot} focus={project} onLeads={() => setTab("leads")} suggest={data.sandbox.suggest} />
        </TabsContent>
        <TabsContent value="accounts" className="grid gap-3">
          <p className="text-sm text-muted-foreground">
            The sign-ins and keys your agents run on, by label. Each account picks its agent and the model provider behind it. An agent
            signs in with its own login, kept by the agent, or uses an API key in {form.store}. Bedrock and Vertex use this machine's AWS or
            gcloud login; a gateway is any compatible endpoint, such as OpenRouter, LiteLLM or Ollama.
          </p>
          {/* first: adding one is what most visits here are for; it reloads the form, the new account arrives saved */}
          <AddAccount onAdded={() => void refetch()} />
          <FieldCard title="Accounts">
            <Field label="Labels" path="accounts" kind="csv" />
            <p className="col-span-full text-xs text-muted-foreground">
              Each run waits for its own account when it's at its limit: Overhand never moves one person's work across several
              subscriptions.
            </p>
            <Field label="Routing by the scorecard" path="routing.mode" kind={{ options: [...ROUTING_MODES], fallback: "suggest" }} />
            <p className="col-span-full text-xs text-muted-foreground">
              Off: each project keeps its account order. Suggest: Needs you says when another agent and model you've set up merges clearly
              more often on a project. Auto: each new ticket goes to the project's best-scoring allowed account, and on to the next when one
              is cooling down or unreachable. Auto never spreads work over accounts of the same agent and provider unless the switch above
              is on.
            </p>
            <Field label="Owner name" path="owner.name" />
            <Field label={`Account in ${form.store}`} path="owner.keychainAccount" />
          </FieldCard>
          <FieldCard title="Sign-ins and keys">
            <CheckRows
              checks={checks.filter((c) => c.what.startsWith("Account ") || gatewaySecrets.has(c.secret ?? ""))}
              store={(s, v) => void storeSecret(s, v)}
            />
          </FieldCard>
          <FieldCard title="OS sandbox">
            <FeatureTip at="settings-sandbox" className="col-span-full" />
            <Field
              label="Sandbox"
              path="sandbox.mode"
              kind={{ options: ["off", "log", "enforce"], fallback: "off", labels: SANDBOX_MODE_LABELS }}
            />
            <Field label="Refuse runs without it" path="sandbox.required" kind="bool" />
            <p className="col-span-full text-xs text-muted-foreground">{sandboxLine(data.sandbox)}</p>
            {objects(form.draft.clients).map((_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: config items have no id; version re-keys them when items shift
              <ProjectSandboxField key={`${form.version}-${i}`} i={i} suggest={data.sandbox.suggest} named />
            ))}
            <p className="col-span-full text-xs text-muted-foreground">{SANDBOX_STOPS}</p>
            <p className="col-span-full text-xs text-muted-foreground">{SANDBOX_LIMIT}</p>
          </FieldCard>
          <ProviderCards homes={data.homes} />
        </TabsContent>
        <TabsContent value="leads" className="grid gap-3">
          <LeadsTab />
        </TabsContent>
        <TabsContent value="rules" className="grid gap-3">
          <HouseRulesTab />
        </TabsContent>
        <TabsContent value="schedule" className="grid gap-3">
          <ScheduleTab />
        </TabsContent>
        <TabsContent value="integrations" className="grid gap-3">
          <IntegrationsTab checks={checks} store={(s, v) => void storeSecret(s, v)} />
        </TabsContent>
        <TabsContent value="phone" className="grid gap-3">
          <Phone />
        </TabsContent>
        <TabsContent value="team" className="grid gap-3">
          <TeamSettings />
        </TabsContent>
        <TabsContent value="look" className="grid gap-3">
          <LookTab />
        </TabsContent>
        <TabsContent value="system" className="grid gap-3">
          <SystemTab />
        </TabsContent>
        <TabsContent value="health" className="grid gap-3">
          <p className="text-sm text-muted-foreground">
            What Overhand needs on this machine. Missing tokens can be stored straight into {data.secretStore} from here; they're never
            shown again.
          </p>
          <FieldCard title="Checks">
            <CheckRows checks={checks} store={(s, v) => void storeSecret(s, v)} />
          </FieldCard>
        </TabsContent>
        <TabsContent value="json" className="grid gap-3">
          <p className="text-sm text-muted-foreground">
            The whole config. Apply loads it into the form; nothing is saved until you press Save.
          </p>
          <Textarea
            aria-label="Config JSON"
            spellCheck={false}
            value={json}
            onChange={(e) => setJson(e.target.value)}
            className="min-h-96 font-mono text-xs"
          />
          <Button variant="outline" className="justify-self-start" onClick={applyJson}>
            Apply JSON
          </Button>
        </TabsContent>
      </Tabs>
      {error ? (
        <p role="alert" className="mt-3 text-sm whitespace-pre-wrap text-bad">
          {error}
        </p>
      ) : null}
      {/* look, system and team act at once; everything else is a draft until Save */}
      <div
        hidden={tab === "look" || tab === "system" || tab === "team"}
        className="sticky -bottom-5 -mx-5 mt-4 flex gap-2 border-t border-border bg-popover px-5 pt-3 pb-5 max-lg:bottom-[calc(4.5rem+env(safe-area-inset-bottom))]"
      >
        <Button onClick={() => void save()}>{w.save}</Button>
        <Button
          variant="outline"
          onClick={() => {
            setError("");
            void refetch().then((r) => r.data && load(r.data.config, r.data.checks));
          }}
        >
          {w.discard}
        </Button>
      </div>
    </FormCtx>
  );
}
