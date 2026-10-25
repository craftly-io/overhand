import { AUTONOMY_LEVELS, type Check, SettingsSavedSchema, SettingsSchema } from "@overhand/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { STATE_KEY, useModel } from "@/app/data";
import { useWords } from "@/app/theme";
import { AddProjects, type Proposed } from "@/components/AddProjects";
import { Connections } from "@/components/Connections";
import { SeededWords } from "@/components/Outward";
import { Phone } from "@/components/Phone";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton, SkeletonRows } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { get, post } from "@/lib/api";
import { fmt } from "@/lib/format";
import { getAt, isObject, type Json, type JsonObject, setAt } from "@/lib/json";
import { LEVEL_WORDS, MEANS_WORDS } from "@/lib/leads";
import { onOrganised } from "@/lib/organise";
import { patchOrganised } from "@/lib/organise-patch";
import { pushBranchesOf, pushOptions, togglePush } from "@/lib/push";
import { placeOf, SECTIONS } from "@/lib/settings-places";
import { DrawerHead } from "./DrawerHost";
import { AgentsSection } from "./SettingsAccounts";
import { AdvancedSection, blankLead } from "./SettingsAdvanced";
import { Field, FieldCard, FOLD, FoldMark, FormCtx, More, type SettingsForm, useForm } from "./SettingsFields";
import { YouSection } from "./SettingsLook";
import { SafetySection } from "./SettingsRules";

const str = (x: Json | undefined) => (typeof x === "string" ? x : "");
const objects = (x: Json | undefined): JsonObject[] => (Array.isArray(x) ? x.filter(isObject) : []);

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
 * "Keep an agent on this project", one switch: on switches on every project agent the project has, or adds one for it
 * (its folder and name from the project) when it has none; off switches them all off. Each one's details are under More
 * and Advanced → Project agent details.
 */
function KeepAgent({ client }: { client: JsonObject }) {
  const f = useForm();
  const w = useWords();
  const id = useId();
  const name = str(client.name);
  const all = objects(f.draft.godmode);
  const mine = all.filter((g) => g.project === name);
  const on = mine.some((g) => g.supervised === true);
  const keep = (yes: boolean) => {
    if (mine.length)
      f.set(
        "godmode",
        all.map((g) => (g.project === name ? { ...g, supervised: yes } : g)),
      );
    else if (yes)
      f.set(`godmode.${all.length}`, {
        ...blankLead(name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name, name, str(client.dir)),
        supervised: true,
      });
  };
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {w.setKeepAgent}
      </Label>
      <Switch id={id} checked={on} onCheckedChange={keep} />
    </div>
  );
}

/** A project's agents, run from its More: always on or waking when Overhand finds work, the account each tries first, and where it may push. */
function LeadBlock({ client }: { client: JsonObject }) {
  const f = useForm();
  const w = useWords();
  const name = str(client.name);
  const mine = objects(f.draft.godmode).flatMap((g, at) => (g.project === name ? [{ g, at }] : []));
  const accounts = Array.isArray(f.draft.accounts) ? f.draft.accounts.filter((a): a is string => typeof a === "string") : [];
  if (!mine.length) return <p className="text-xs text-muted-foreground sm:col-span-2">{w.leadsNone}</p>;
  return (
    <div className="grid gap-2 sm:col-span-2">
      <b className="text-sm">{w.leadsLabel}</b>
      {mine.map(({ g, at }) => (
        <div key={at} className="grid gap-2 rounded-md border border-border p-2 sm:grid-cols-2 sm:items-end">
          <span className="text-xs sm:col-span-2">{str(g.label) || str(g.key)}</span>
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

/** How far agents go on this project, by name, with what it means in one line. A config without one acts. */
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
  );
}

/**
 * The level's extras, under More: on Merge when green its protected paths and daily cap; on Look only and Draft pull
 * requests how far a task you assign an agent to goes (a config without one opens a pull request).
 */
function AutonomyExtras({ i }: { i: number }) {
  const f = useForm();
  const w = useWords();
  const v = getAt(f.draft, `clients.${i}.autonomy`);
  if (v === "ship")
    return (
      <>
        <Field label={w.shipProtect} path={`clients.${i}.ship.protect`} kind="csv" />
        <Field label={w.shipPerDay} path={`clients.${i}.ship.perDay`} kind="num" />
      </>
    );
  if (v !== "watch" && v !== "propose") return null;
  return (
    <div className="grid gap-1">
      <Field
        label={w.assignedLabel}
        path={`clients.${i}.assignedAutonomy`}
        kind={{ options: ["act", "propose"], fallback: "act", labels: { act: w.assignedAct, propose: w.assignedPropose } }}
      />
      <p className="text-xs text-muted-foreground">{w.assignedHint}</p>
    </div>
  );
}

/**
 * Settings → Projects: per project its name, what agents may do, its tracker and whether an agent stays on it; More
 * holds the rest (folder, issue keys, host, the tracker's fields, its agents' details, private words, accounts,
 * previews, status sources). Adding from GitHub and by hand are one button each.
 */
function ProjectsSection({ codeRoot, focus }: { codeRoot: string; focus?: string }) {
  const w = useWords();
  const f = useForm();
  const clients = objects(f.draft.clients);
  const [fromGithub, setFromGithub] = useState(0);
  const [picking, setPicking] = useState(false);
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
  // opened for one project (a card's fix, the scorecard's suggestion): bring its card into view, its More open
  useEffect(() => {
    if (focus) document.getElementById(`set-project-${focus}`)?.scrollIntoView({ block: "start" });
  }, [focus]);
  return (
    <>
      <p className="text-sm text-muted-foreground">{w.setProjectsHint}</p>
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
            <AutonomyField i={i} />
            <Field
              label="Tracker"
              path={`clients.${i}.tracker.kind`}
              kind={{
                options: ["", "linear", "jira", "github"],
                labels: { "": "No tracker", linear: "Linear", jira: "Jira", github: "GitHub Issues" },
              }}
            />
            <KeepAgent client={c} />
            <More open={focus !== undefined && focus === str(c.name)}>
              <Field label="Folder" path={`clients.${i}.dir`} kind="list" />
              <Field label="Issue key prefix" path={`clients.${i}.prefix`} />
              <Field label="Git host" path={`clients.${i}.host`} kind={{ options: ["github", "bitbucket"] }} />
              {!kind ? null : kind === "github" ? (
                <Field label="GitHub repo (owner/name)" path={`clients.${i}.tracker.repo`} />
              ) : (
                <Field
                  label={`Tracker token (name in ${f.store}; empty when connected under Connections)`}
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
              <AutonomyExtras i={i} />
              <LeadBlock client={c} />
              <Field label="Aliases (orgs, words)" path={`clients.${i}.aliases`} kind="csv" />
              <Field
                label="Private words (people, products, hosts): never sent to another project"
                path={`clients.${i}.private`}
                kind="csv"
              />
              <SeededWords
                name={str(c.name)}
                prefix={str(c.prefix)}
                aliases={Array.isArray(c.aliases) ? c.aliases.map((a) => str(a)) : []}
              />
              <Field label="Agent accounts (runs use the first; empty = the first account)" path={`clients.${i}.accounts`} kind="csv" />
              <Field
                label="Preview command for pull request screenshots (e.g. bun run storybook --ci -p 6106; empty = none)"
                path={`clients.${i}.preview.command`}
              />
              <Field label="Preview URL to screenshot once it answers" path={`clients.${i}.preview.url`} />
              <StatusBlock i={i} />
            </More>
          </FieldCard>
        );
      })}
      {fromGithub ? <p className="text-sm text-muted-foreground">Added {fromGithub} from GitHub above. Save to keep them.</p> : null}
      {picking ? <AddProjects codeRoot={codeRoot} onReady={addFromGithub} /> : null}
      <div className="flex flex-wrap gap-2">
        {picking ? null : (
          <Button variant="outline" onClick={() => setPicking(true)}>
            {w.setAddProjects}
          </Button>
        )}
        <Button
          variant="ghost"
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
          {w.setAddProject}
        </Button>
      </div>
    </>
  );
}

/**
 * Settings → Connections: a Connect for each service (GitHub, the tracker, Slack, Sentry, Vercel); the phone, with
 * Access from anywhere first; running while the computer is off, per GitHub project; and, folded, Bitbucket and the
 * status tokens that see several projects.
 */
function ConnectionsSection() {
  const w = useWords();
  const f = useForm();
  const m = useModel();
  const clients = objects(f.draft.clients);
  return (
    <>
      {/* two panes stack with the panes' own gap, not the cards' */}
      <div className="grid gap-6">
        <Connections />
        <Phone />
      </div>
      <FieldCard title={w.hostedHere}>
        <p className="text-xs text-muted-foreground sm:col-span-2">{m?.s.hosted ? w.hostedHereHint : w.setRunOffNone}</p>
        {m?.s.hosted
          ? clients.map((c, i) =>
              str(c.host) === "github" ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: config items have no id; version re-keys them when items shift
                <Field key={`${f.version}-${i}`} label={str(c.name)} path={`clients.${i}.hosted`} kind="bool" />
              ) : null,
            )
          : null}
      </FieldCard>
      <details className="field-card border border-border p-4">
        <summary className={`${FOLD} font-display text-sm`}>
          <FoldMark />
          {w.setConnectionsMore}
        </summary>
        <div className="mt-2 grid grid-cols-1 gap-x-3 gap-y-2 sm:grid-cols-2">
          {f.draft.bitbucket ? (
            <>
              <Field label="Bitbucket email" path="bitbucket.email" />
              <Field label="Bitbucket workspace" path="bitbucket.workspace" />
              <Field label={`Bitbucket token (name in ${f.store})`} path="bitbucket.secret" />
              <Button size="xs" variant="ghost" className="justify-self-start" onClick={() => f.set("bitbucket", undefined)}>
                Remove Bitbucket
              </Button>
            </>
          ) : (
            <Button
              size="xs"
              variant="outline"
              className="justify-self-start sm:col-span-2"
              onClick={() => f.set("bitbucket", { email: "", workspace: "", secret: "overhand-bitbucket" })}
            >
              Connect Bitbucket
            </Button>
          )}
          <p className="text-xs text-muted-foreground sm:col-span-2">
            Tokens that see several projects (names in {f.store}); what they find is matched to a project by its name and aliases.
            Per-project sources live on each project, under More.
          </p>
          <Field label="Vercel tokens" path="status.vercelSecrets" kind="csv" />
          <Field label="Sentry tokens" path="status.sentrySecrets" kind="csv" />
          <Field label="Calendar iCal URLs" path="status.icalSecret" />
        </div>
      </details>
    </>
  );
}

/** Edits a draft of overhand.config.json in five sections plus Advanced; Save validates it on the daemon and applies it live. */
export function SettingsDrawer({ tab: opening, project }: { tab?: string; project?: string }) {
  const w = useWords();
  const qc = useQueryClient();
  const { data, refetch } = useQuery({ queryKey: ["settings"], queryFn: () => get("/api/settings", SettingsSchema), staleTime: 0 });
  const [draft, setDraft] = useState<JsonObject | null>(null);
  const [checks, setChecks] = useState<Check[]>([]);
  const [version, setVersion] = useState(0);
  const [error, setError] = useState("");
  const [json, setJson] = useState("");
  const at = placeOf(opening);
  const [tab, setTab] = useState<string>(at.section);
  // opened again at another place while open (a card's fix, the command bar): go there
  useEffect(() => setTab(placeOf(opening).section), [opening]);
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
    // the sections, then a section's fields: the form's shape until the config arrives
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
    local: data.local,
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

  const store = (s: string, v: string) => void storeSecret(s, v);
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
          {SECTIONS.map(([k, label]) => (
            <TabsTrigger key={k} value={k} className="h-8 flex-none">
              {w[label]}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="projects" className="grid gap-3">
          <ProjectsSection codeRoot={data.codeRoot} focus={project} />
        </TabsContent>
        <TabsContent value="agents" className="grid gap-3">
          <AgentsSection homes={data.homes} checks={checks} store={store} onAdded={() => void refetch()} />
        </TabsContent>
        <TabsContent value="connections" className="grid gap-3">
          <ConnectionsSection />
        </TabsContent>
        <TabsContent value="safety" className="grid gap-3">
          <SafetySection sandbox={data.sandbox} focus={project} />
        </TabsContent>
        <TabsContent value="you" className="grid gap-3">
          <YouSection />
        </TabsContent>
        <TabsContent value="advanced" className="grid gap-3">
          <AdvancedSection
            group={tab === at.section ? at.group : ""}
            checks={checks}
            store={store}
            json={json}
            onJson={setJson}
            onApplyJson={applyJson}
          />
        </TabsContent>
      </Tabs>
      {tab === "advanced" ? null : (
        <Button variant="link" className="mt-3 self-start justify-self-start px-0" onClick={() => setTab("advanced")}>
          {w.setAdvancedOpen}
        </Button>
      )}
      {error ? (
        <p role="alert" className="mt-3 text-sm whitespace-pre-wrap text-bad">
          {error}
        </p>
      ) : null}
      {/* the look, sound, plugins and the team act at once; everything else is a draft until Save */}
      <div className="sticky -bottom-5 -mx-5 mt-4 flex gap-2 border-t border-border bg-popover px-5 pt-3 pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
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
