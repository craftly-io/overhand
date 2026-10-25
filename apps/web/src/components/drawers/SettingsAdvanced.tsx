import { type Check, REPO_URL, ROUTING_MODES } from "@overhand/contract";
import { type ReactNode, useEffect } from "react";
import { useWords } from "@/app/theme";
import { GroupsBoard } from "@/components/organise/GroupsBoard";
import { SuggestionCards } from "@/components/organise/SuggestionCards";
import { Phone } from "@/components/Phone";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { isObject, type Json, type JsonObject } from "@/lib/json";
import { ADVANCED, type AdvancedGroup } from "@/lib/settings-places";
import { CheckRows, Field, FieldCard, FOLD, FoldMark, useForm } from "./SettingsFields";
import { CleanupCard } from "./SettingsLook";
import { PluginsTab } from "./SettingsPlugins";
import { SettingsReports } from "./SettingsReports";
import { ApprovalsCard, ProtectCard } from "./SettingsRules";
import { StatusUpdates } from "./SettingsUpdates";

const str = (x: Json | undefined) => (typeof x === "string" ? x : "");
const objects = (x: Json | undefined): JsonObject[] => (Array.isArray(x) ? x.filter(isObject) : []);

/** A project agent with nothing set but its project and folder: the config's defaults for the rest. */
export const blankLead = (key: string, label: string, project: string, dir: string): JsonObject => ({
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

/** Every project agent in full: its key, folder, goal and instruction, and its files and limits. */
function ProjectAgents() {
  const w = useWords();
  const f = useForm();
  const leads = objects(f.draft.godmode);
  const projects = ["", ...objects(f.draft.clients).map((c) => str(c.name))];
  return (
    <>
      <p className="text-sm text-muted-foreground">
        A project agent runs a whole project on its own. When on, Overhand keeps one running, restarts it after it exits, waits out its
        account's usage limit, keeps the machine awake while it works, and shows its output and questions on the dashboard. Paths are
        relative to the Code folder.{" "}
        <a className="text-primary underline" href={`${REPO_URL}/blob/main/docs/leads.md`} target="_blank" rel="noopener noreferrer">
          How a project's own agent skill works with Overhand
        </a>
        .
      </p>
      {leads.map((g, i) => (
        <FieldCard
          // biome-ignore lint/suspicious/noArrayIndexKey: config items have no id; version re-keys them when items shift
          key={`${f.version}-${i}`}
          title={str(g.label) || str(g.key) || w.setAdvAgents}
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
            // one place for these: the project's card
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
      <Button variant="outline" className="justify-self-start" onClick={() => f.set(`godmode.${leads.length}`, blankLead("", "", "", ""))}>
        + {w.setAdvAgents}
      </Button>
    </>
  );
}

function Schedule() {
  const w = useWords();
  const num = (label: string, path: string) => <Field key={path} label={label} path={path} kind="num" />;
  return (
    <>
      <FieldCard title="Schedule">
        <Field label={w.setPlanOn} path="schedule.plan" kind="bool" />
        {num(w.setPlanFrom, "schedule.planFromHour")}
        <Field
          label="Seasons follow (hemisphere; auto = from the time zone)"
          path="schedule.hemisphere"
          kind={{ options: ["auto", "north", "south"], fallback: "auto" }}
        />
        {num("Slack from hour", "schedule.inboxFromHour")}
        {num("Slack until hour", "schedule.inboxToHour")}
        {num("Slack every (min)", "schedule.inboxEveryMin")}
        {num("Look for work again after work (min)", "schedule.busyPollMin")}
        {num("Look for work again when idle (min)", "schedule.idlePollMin")}
      </FieldCard>
      <FieldCard title="Limits">
        {num("Tasks each time it looks", "limits.maxTasksPerRun")}
        {num("Task timeout (min)", "limits.taskTimeoutMin")}
        {num("Attempts per task", "limits.maxAttempts")}
        {num("Rounds of fixes per pull request", "limits.maxFixes")}
        {num("Account cooldown (min)", "limits.cooldownMin")}
        {num("Slack veto window (min)", "limits.slackVetoMin")}
        {num("Ignore repos idle (days)", "limits.dormantDays")}
        <Field label={w.quickPace} path="limits.paceWeekly" kind="bool" />
        <p className="text-xs text-muted-foreground sm:col-span-2">{w.quickPaceHint}</p>
      </FieldCard>
    </>
  );
}

/** The Slack inbox's workspaces: which MCP server reads which project's Slack. */
function SlackMapping() {
  const f = useForm();
  const slack = objects(f.draft.slack)
    .map((x) => `${str(x.server)} = ${str(x.client)}`)
    .join("\n");
  return (
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
  );
}

/**
 * Settings → Advanced: everything the five sections don't show, each group folded under its name, in ADVANCED's order.
 * A deep link (`group`) opens its group and brings it into view.
 */
export function AdvancedSection({
  group,
  checks,
  store,
  json,
  onJson,
  onApplyJson,
}: {
  group: AdvancedGroup | "";
  checks: Check[];
  store: (service: string, value: string) => void;
  json: string;
  onJson: (text: string) => void;
  onApplyJson: () => void;
}) {
  const w = useWords();
  const f = useForm();
  useEffect(() => {
    if (group) document.getElementById(`set-adv-${group}`)?.scrollIntoView({ block: "start" });
  }, [group]);
  const body: Record<AdvancedGroup, ReactNode> = {
    schedule: <Schedule />,
    labels: (
      <FieldCard title={w.setAdvLabels}>
        <Field label="Queue" path="labels.queue" />
        <Field label="Working" path="labels.working" />
        <Field label="Review" path="labels.review" />
        <Field label="Blocked (needs you)" path="labels.blocked" />
        <Field label="From Slack" path="labels.fromSlack" />
      </FieldCard>
    ),
    groups: (
      <>
        <p className="text-sm text-muted-foreground">{w.orgGroupsHint}</p>
        <GroupsBoard />
        <SuggestionCards />
      </>
    ),
    "project-agents": <ProjectAgents />,
    routing: (
      <FieldCard title={w.setAdvRouting}>
        <Field label="Account order (runs use the first that's free)" path="accounts" kind="csv" />
        <p className="col-span-full text-xs text-muted-foreground">
          Each run waits for its own account when it's at its limit: Overhand never moves one person's work across several subscriptions.
        </p>
        <Field label="Routing by the scorecard" path="routing.mode" kind={{ options: [...ROUTING_MODES], fallback: "suggest" }} />
        <p className="col-span-full text-xs text-muted-foreground">
          Off: each project keeps its account order. Suggest: Needs you says when another agent and model you've set up merges clearly more
          often on a project. Auto: each new task goes to the project's best-scoring allowed account, and on to the next when one is cooling
          down or unreachable.
        </p>
      </FieldCard>
    ),
    approvals: <ApprovalsCard />,
    protect: <ProtectCard />,
    updates: (
      <>
        <StatusUpdates checks={checks} store={store} />
        <SettingsReports />
      </>
    ),
    plugins: <PluginsTab />,
    sandbox: (
      <FieldCard title={w.sandboxSwitch}>
        <Field label={w.sandboxRefuseLabel} path="sandbox.required" kind="bool" />
      </FieldCard>
    ),
    outward: (
      <FieldCard title="What clients see">
        <Field label="Agent branch prefix (empty = issue key only)" path="outward.branchPrefix" />
        <Field label="Show AI attribution in commits and pull requests" path="outward.aiAttribution" kind="bool" />
        <Field
          label="Comment on agent pull requests that may have cut a corner (once per new finding)"
          path="outward.cornerComment"
          kind="bool"
        />
      </FieldCard>
    ),
    addresses: (
      <>
        <FieldCard title="Other addresses">
          <Field label="Extra origins (Use this address below adds your tailscale serve URL)" path="dashboardOrigins" kind="csv" />
          <Field label={`Phone notifications: ntfy topic URL (name in ${f.store})`} path="ntfySecret" />
        </FieldCard>
        <Phone part="tailnet" />
      </>
    ),
    mcp: <SlackMapping />,
    checks: (
      <>
        <p className="text-sm text-muted-foreground">
          What Overhand needs on this machine. Missing tokens can be stored straight into {f.store} from here; they're never shown again.
        </p>
        <FieldCard title={w.setAdvChecks}>
          <CheckRows checks={checks} store={store} />
        </FieldCard>
      </>
    ),
    cleanup: <CleanupCard />,
    config: (
      <>
        <Field label={`Account in ${f.store}`} path="owner.keychainAccount" />
        <p className="text-sm text-muted-foreground">
          The whole config. Apply loads it into the form; nothing is saved until you press Save.
        </p>
        <Textarea
          aria-label="Config JSON"
          spellCheck={false}
          value={json}
          onChange={(e) => onJson(e.target.value)}
          className="min-h-96 font-mono text-xs"
        />
        <Button variant="outline" className="justify-self-start" onClick={onApplyJson}>
          Apply JSON
        </Button>
      </>
    ),
  };
  return (
    <>
      <p className="text-sm text-muted-foreground">{w.setAdvancedHint}</p>
      {ADVANCED.map(([id, title]) => (
        <details key={id} id={`set-adv-${id}`} className="scroll-mt-4 border-b border-border" open={group === id || undefined}>
          <summary className={`${FOLD} font-display text-sm`}>
            <FoldMark />
            {w[title]}
          </summary>
          <div className="mt-2 grid gap-3">{body[id]}</div>
        </details>
      ))}
    </>
  );
}
