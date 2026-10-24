import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";
import { useWords } from "@/app/theme";
import { FeatureTip } from "@/components/FeatureTip";
import { openTab, SignIn, Tested } from "@/components/SignIn";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { get, post } from "@/lib/api";
import { fmt } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Each agent CLI as the Add an agent account flow sees it: `GET /api/accounts/options`. */
const OptionsSchema = z.object({
  agents: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      installed: z.boolean(),
      /** Signed in on this computer as you (Claude Code: the one in your terminal). */
      signedIn: z.boolean(),
      suggested: z.string(),
      /** It has a sign-in of its own Overhand can open. */
      login: z.boolean(),
      /** Its login can live in a folder of the account's own, so two accounts of it keep separate logins. */
      ownFolder: z.boolean(),
      /** It takes an API key. */
      key: z.boolean(),
      /** The account already on this computer's login of it, or "". */
      shared: z.string(),
    }),
  ),
});
type Agent = z.infer<typeof OptionsSchema>["agents"][number];

const Added = z.object({ ok: z.boolean(), label: z.string() });

/** A sign-in on this computer that a new account can use as is (Gemini CLI's "signed in" is a key, not a login). */
const reusable = (a: Agent): boolean => a.installed && a.signedIn && a.login && !a.shared;

/**
 * Add an agent account, one step at a time: pick the agent, sign in in your browser through its own login (in a folder
 * of the account's own where the CLI allows it) or use an API key instead, then a quick test call. A sign-in already
 * on this computer is one quiet tap above the steps. The label is picked for you (Advanced changes it).
 */
export function AddAccount({ onAdded }: { onAdded?: () => void }) {
  const w = useWords();
  const qc = useQueryClient();
  // finding the agent CLIs takes the daemon a few seconds the first time (it keeps the answer a minute): say so meanwhile
  const options = useQuery({
    queryKey: ["account-options"],
    queryFn: () => get("/api/accounts/options", OptionsSchema),
    staleTime: 60_000,
  });
  const [agentId, setAgentId] = useState("");
  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // a sign-in (`tool`) follows when the account signs in with its CLI's own login
  const [added, setAdded] = useState<{ label: string; tool: string; tab: Window | null } | null>(null);
  const [useKey, setUseKey] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; message: string } | "running" | null>(null);
  const agents = options.data?.agents ?? [];
  const agent = agents.find((a) => a.id === agentId);

  const runTest = async (account: string) => {
    setTest("running");
    try {
      setTest(await post("/api/accounts/test", { account }, Tested));
    } catch (e) {
      setTest({ ok: false, message: e instanceof Error ? e.message : String(e) });
    }
  };
  const add = async (a: Agent, how: "login" | "key" | "existing", name = label, tab: Window | null = null) => {
    setBusy(true);
    setError("");
    setTest(null);
    try {
      const r = await post("/api/accounts/add", { agent: a.id, label: name.trim(), how, key: key.trim() }, Added);
      setAdded({ label: r.label, tool: how === "login" ? a.label : "", tab });
      setKey("");
      onAdded?.();
      void qc.invalidateQueries({ queryKey: ["account-options"] });
      // nothing to wait for with a key or a login already here: test straight away (a sign-in tests once it's done)
      if (how !== "login") await runTest(r.label);
    } catch (e) {
      tab?.close();
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const pick = (a: Agent) => {
    setAgentId(a.id);
    setLabel(a.suggested);
    setUseKey(false);
    setAdded(null);
    setTest(null);
    setError("");
  };

  // the way this agent signs in, said once where it matters: its own login, one per computer, or a key only
  const how = !agent
    ? ""
    : agent.login
      ? agent.ownFolder
        ? w.addAccountOwnFolder
        : agent.shared
          ? fmt(w.addAccountSharedTaken, { tool: agent.label, account: agent.shared })
          : fmt(w.addAccountSharedLogin, { tool: agent.label })
      : agent.key
        ? fmt(w.addAccountKeyOnly, { tool: agent.label })
        : fmt(w.addAccountNoKey, { tool: agent.label });
  const canLogin = Boolean(agent?.login && (agent.ownFolder || !agent.shared));
  const keyStep = Boolean(agent?.key && (useKey || !canLogin));
  // a quiet link still gets a 24px target (WCAG 2.5.8): it sits close to other controls
  const quiet = "h-auto min-h-6 p-0 text-sm font-normal underline";

  return (
    <section aria-labelledby="add-account" className="grid gap-3 rounded-lg border border-border bg-card p-4">
      <h3 id="add-account" className="font-display text-base tracking-wide">
        {w.addAccountTitle}
      </h3>
      <p className="text-sm text-muted-foreground">{w.addAccountHint}</p>
      <FeatureTip at="add-account" />
      {agents.some(reusable) && !added ? (
        // a quiet way round the steps: the sign-in already on this computer
        <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm text-muted-foreground">
          {w.setupReuseTitle}:
          {agents.filter(reusable).map((a) => (
            <Button
              key={a.id}
              type="button"
              variant="link"
              disabled={busy}
              className={quiet}
              onClick={() => {
                pick(a);
                void add(a, "existing", a.suggested);
              }}
            >
              {fmt(w.setupReuse, { tool: a.label })}
            </Button>
          ))}
        </p>
      ) : null}
      {options.isPending ? (
        // the agent CLIs this computer has, as the row of choices they'll be
        <div role="status" className="flex flex-wrap gap-2">
          <span className="sr-only">{w.addAccountLooking}</span>
          {["w-24", "w-28", "w-20"].map((size) => (
            <Skeleton key={size} className={cn("h-9 rounded-(--radius-control)", size)} />
          ))}
        </div>
      ) : null}
      <fieldset className="flex flex-wrap gap-2" aria-busy={options.isPending}>
        <legend className="sr-only">{w.setupAgent}</legend>
        {agents.map((a) => (
          <Button
            key={a.id}
            type="button"
            variant="outline"
            aria-pressed={a.id === agentId}
            className={cn("aria-pressed:bg-primary/20", !a.installed && "opacity-60")}
            onClick={() => pick(a)}
          >
            {a.installed ? a.label : `${a.label} · ${w.setupAgentMissing}`}
          </Button>
        ))}
      </fieldset>
      {agent && !added ? (
        <div className="grid gap-2">
          {how ? <p className="text-sm text-muted-foreground">{how}</p> : null}
          {keyStep ? (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void add(agent, "key");
              }}
            >
              <Input
                type="password"
                autoComplete="off"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                aria-label={fmt(w.addAccountKeyField, { tool: agent.label })}
                placeholder={fmt(w.addAccountKeyField, { tool: agent.label })}
                className="max-w-sm font-mono text-sm"
              />
              <Button type="submit" disabled={busy || !key.trim()}>
                {w.addAccountSave}
              </Button>
            </form>
          ) : canLogin ? (
            <Button type="button" className="w-fit" disabled={busy} onClick={() => void add(agent, "login", label, openTab())}>
              {w.signInBrowser}
            </Button>
          ) : null}
          {canLogin && agent.key ? (
            <Button type="button" variant="link" className={cn(quiet, "w-fit text-muted-foreground")} onClick={() => setUseKey(!useKey)}>
              {useKey ? w.addAccountSignInInstead : w.addAccountKeyInstead}
            </Button>
          ) : null}
          <details className="text-sm">
            <summary className="w-fit cursor-pointer text-muted-foreground select-none">{w.addAccountAdvanced}</summary>
            <label htmlFor="add-account-label" className="mt-2 grid max-w-xs gap-1">
              {w.addAccountLabel}
              <Input
                id="add-account-label"
                value={label}
                onChange={(e) => setLabel(e.target.value.toLowerCase())}
                className="font-mono text-sm"
              />
            </label>
          </details>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-bad">
          {error}
        </p>
      ) : null}
      {added ? (
        <div className="grid gap-2" aria-live="polite">
          {added.tool ? (
            <SignIn account={added.label} tool={added.tool} tab={added.tab} onSignedIn={() => void runTest(added.label)} />
          ) : null}
          {test === "running" ? <p className="text-sm text-muted-foreground">{w.addAccountTesting}</p> : null}
          {test && test !== "running" ? (
            <div className="flex flex-wrap items-center gap-3">
              <span className={cn("text-sm", test.ok ? "text-ok" : "text-warn")}>
                {test.ok
                  ? fmt(w.addAccountReady, { account: added.label })
                  : fmt(w.addAccountFailed, { account: added.label, why: test.message })}
              </span>
              {test.ok ? null : (
                <Button type="button" variant="outline" size="sm" onClick={() => void runTest(added.label)}>
                  {w.addAccountTest}
                </Button>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
