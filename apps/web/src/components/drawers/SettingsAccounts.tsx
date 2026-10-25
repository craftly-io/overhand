import { BILLINGS, type Billing, type Check, comboLabel, detectBilling, guardLine } from "@overhand/contract";
import { type ReactNode, useState } from "react";
import { useModel } from "@/app/data";
import { useWords } from "@/app/theme";
import { AddAccount } from "@/components/AddAccount";
import { AccountRow } from "@/components/health/Accounts";
import { AccountSignIn } from "@/components/SignIn";
import { Button } from "@/components/ui/button";
import { fmt, until } from "@/lib/format";
import { getAt, isObject, type Json } from "@/lib/json";
import { AgentTuning } from "./SettingsAgent";
import { CheckRows, Field, FieldCard, More, useForm } from "./SettingsFields";

const str = (x: Json | undefined) => (typeof x === "string" ? x : "");

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
 * setup suggests one (`detectBilling`); where the setup can't tell, it asks once, until the person picks: then it shows
 * on the account's card, and otherwise under More (the card's usage line already says how it's paid for).
 */
function BillingField({ account, runtime, asking }: { account: string; runtime: string; asking: boolean }) {
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
  if (ask !== asking) return null;
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

/**
 * One account: its usage, its sign-in and (only while Overhand has to ask) how it's paid for; under More, its agent
 * CLI, the model provider behind it with that provider's fields, and the agent's tuning.
 */
function AccountCard({ a, home }: { a: string; home: string }) {
  const w = useWords();
  const f = useForm();
  const m = useModel();
  const s = m?.s;
  const live = s?.accounts.find((x) => x.name === a);
  // out of usage until its reset (the daemon's bench, its windows, its budget); the line goes once the time passes
  const back = live?.coolUntil ?? 0;
  const note = s && back > s.now ? fmt(w.accOutOfUsage, { t: until(back, s.now) }) : undefined;
  const at = `providers.${a}`;
  const runtime = str(getAt(f.draft, `runtimes.${a}.kind`)) || "claude-code";
  // the provider drives Claude Code; Codex, OpenCode and Aider can use a gateway account's endpoint and model
  const backend = ["claude-code", "codex", "opencode", "aider"].includes(runtime);
  const kind = backend ? str(getAt(f.draft, `${at}.kind`)) || "claude" : "";
  const login = (str(getAt(f.draft, `${at}.auth`)) || "login") === "login";
  const claude = backend && kind === "claude" && runtime === "claude-code";
  const loginCli = LOGIN_CLIS[runtime];
  let signIn: ReactNode = null;
  if (loginCli && kind !== "gateway")
    // the CLI's own sign-in: in this account's own folder (Codex), else the one login this computer has for it
    signIn = (
      <div className="grid gap-1 sm:col-span-2">
        <AccountSignIn account={a} tool={loginCli} label={fmt(w.addAccountSignIn, { tool: loginCli })} />
        <p className="text-xs text-muted-foreground">
          {getAt(f.draft, `runtimes.${a}.ownLogin`) === true ? w.addAccountOwnFolder : fmt(w.addAccountSharedLogin, { tool: loginCli })}
        </p>
      </div>
    );
  else if (claude && login && typeof getAt(f.draft, `${at}.existing`) === "string")
    // the Claude Code sign-in you already had: it moves to a folder of its own once signed in there, Slack too
    signIn = (
      <div className="grid gap-1 sm:col-span-2">
        <p className="text-xs text-muted-foreground">
          {getAt(f.draft, `${at}.movedAt`) === undefined ? w.movedOffOwnBody : fmt(w.addAccountUsesExisting, { tool: "Claude Code" })}
        </p>
        {getAt(f.draft, `${at}.movedAt`) === undefined ? (
          <AccountSignIn account={a} tool="Claude Code" label={fmt(w.setupAgentSignInTo, { tool: "Claude Code" })} />
        ) : null}
        <Field label={w.slackMovedLabel} path={`${at}.slackMoved`} kind="bool" />
      </div>
    );
  else if (claude && login)
    signIn = (
      <div className="grid gap-1 sm:col-span-2">
        <AccountSignIn account={a} tool="Claude Code" label={fmt(w.setupAgentSignInTo, { tool: "Claude Code" })} />
        <p className="text-xs text-muted-foreground">
          Claude Code's own sign-in, in a config folder just for this account. The login stays with Claude Code; agents never see it. Save a
          new account first.
        </p>
      </div>
    );
  else if (claude)
    signIn = (
      <p className="text-xs text-muted-foreground sm:col-span-2">
        An Anthropic API key (billed to your Anthropic account), stored as anthropic-key-{a} below.
      </p>
    );
  else if (!backend)
    signIn = (
      <p className="text-xs text-muted-foreground sm:col-span-2">
        Uses the CLI's own login, or an API key stored as {runtime}-key-{a}. Structured answers are asked for in the prompt and checked.
      </p>
    );
  return (
    <FieldCard title={a} note={note}>
      {live && m ? (
        <ul className="sm:col-span-2">
          <AccountRow a={live} m={m} named={false} />
        </ul>
      ) : null}
      {signIn}
      <BillingField account={a} runtime={runtime} asking />
      <More>
        <Field label="Agent" path={`runtimes.${a}.kind`} kind={{ options: RUNTIMES, fallback: "claude-code", labels: RUNTIME_LABELS }} />
        <p className="text-xs text-muted-foreground sm:col-span-2">{guardLine(runtime)}</p>
        {runtime !== "claude-code" ? (
          <Field label="CLI model (its own -m / --model; empty = default)" path={`runtimes.${a}.model`} />
        ) : null}
        {/* switching starts the backend's fields fresh, so another backend's leftovers can't fail validation */}
        {backend ? (
          <Field
            label="Provider"
            path={`${at}.kind`}
            kind={{ options: ["claude", "bedrock", "vertex", "gateway"], fallback: "claude", labels: PROVIDER_LABELS }}
          />
        ) : null}
        {claude ? (
          <Field label="Signs in with" path={`${at}.auth`} kind={{ options: ["login", "key"], fallback: "login", labels: AUTH_LABELS }} />
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
        <BillingField account={a} runtime={runtime} asking={false} />
        <AgentTuning account={a} runtime={runtime} home={home} />
      </More>
    </FieldCard>
  );
}

/**
 * Settings → Agents: Add an agent (one button away, its steps open below it), then each account's card, then the
 * sign-ins and keys that are missing. Every check, the ones that pass too, is under Advanced → Machine checks.
 */
export function AgentsSection({
  homes,
  checks,
  store,
  onAdded,
}: {
  homes: Record<string, string>;
  checks: Check[];
  store: (service: string, value: string) => void;
  onAdded: () => void;
}) {
  const w = useWords();
  const f = useForm();
  const [adding, setAdding] = useState(false);
  const names = Array.isArray(f.draft.accounts) ? f.draft.accounts.filter((x) => typeof x === "string") : [];
  const providers = getAt(f.draft, "providers");
  const gatewaySecrets = new Set(isObject(providers) ? Object.values(providers).map((p) => str(isObject(p) ? p.secret : "")) : []);
  gatewaySecrets.delete("");
  const missing = checks.filter((c) => !c.ok && !c.optional && (c.what.startsWith("Account ") || gatewaySecrets.has(c.secret ?? "")));
  return (
    <>
      <p className="text-sm text-muted-foreground">{w.setAgentsHint}</p>
      {/* it reloads the form: the new account arrives saved */}
      {adding ? (
        <AddAccount onAdded={onAdded} />
      ) : (
        <Button variant="outline" className="justify-self-start" onClick={() => setAdding(true)}>
          {w.setAddAgent}
        </Button>
      )}
      {names.map((a) => (
        <AccountCard key={a} a={a} home={homes[a] ?? ""} />
      ))}
      {missing.length ? (
        <FieldCard title={w.setSignInChecks}>
          <CheckRows checks={missing} store={store} />
        </FieldCard>
      ) : null}
    </>
  );
}
