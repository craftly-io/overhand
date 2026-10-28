import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";
import { useModel } from "@/app/data";
import { useWords } from "@/app/theme";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { get, post } from "@/lib/api";
import { fmt } from "@/lib/format";

/** A row of ticks, native checkboxes: one per name. */
function Ticks({ title, names, picked, onToggle }: { title: string; names: string[]; picked: string[]; onToggle: (n: string) => void }) {
  if (!names.length) return null;
  return (
    <fieldset className="grid gap-1">
      <legend className="text-xs text-muted-foreground">{title}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {names.map((n) => (
          <label key={n} className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-(--primary)" checked={picked.includes(n)} onChange={() => onToggle(n)} />
            {n}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * One account per client, as the last step of adding an account: which projects run only on it, and which of your MCP
 * servers it may use (`POST /api/accounts/scope`). Both are optional; a skipped step leaves the account as any other.
 */
export function AccountScope({ account }: { account: string }) {
  const w = useWords();
  const projects = (useModel()?.s.clients ?? []).map((c) => c.name);
  const servers = useQuery({
    queryKey: ["account-servers", account],
    queryFn: () => get(`/api/accounts/servers?account=${encodeURIComponent(account)}`, z.object({ servers: z.array(z.string()) })),
    staleTime: 60_000,
  });
  const [onlyHere, setOnlyHere] = useState<string[]>([]);
  const [allowed, setAllowed] = useState<string[]>([]);
  const [state, setState] = useState<"idle" | "saving" | "saved" | string>("idle");
  const flip = (list: string[], set: (l: string[]) => void) => (n: string) =>
    set(list.includes(n) ? list.filter((x) => x !== n) : [...list, n]);
  const save = async () => {
    setState("saving");
    try {
      await post("/api/accounts/scope", { account, projects: onlyHere, servers: allowed }, z.object({ ok: z.boolean() }));
      setState("saved");
    } catch (e) {
      setState(e instanceof Error ? e.message : String(e));
    }
  };
  const serverNames = servers.data?.servers ?? [];
  if (!servers.isPending && !projects.length && !serverNames.length) return null;
  return (
    <section className="grid gap-3 border-t pt-3" aria-label={w.scopeTitle}>
      <h4 className="text-sm font-medium">{w.scopeTitle}</h4>
      <p className="text-sm text-muted-foreground">{fmt(w.scopeHint, { account })}</p>
      <Ticks title={w.scopeProjects} names={projects} picked={onlyHere} onToggle={flip(onlyHere, setOnlyHere)} />
      {servers.isPending ? <Skeleton className="h-5 w-48" /> : null}
      <Ticks title={w.scopeServers} names={serverNames} picked={allowed} onToggle={flip(allowed, setAllowed)} />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" size="sm" disabled={state === "saving" || state === "saved"} onClick={() => void save()}>
          {w.scopeSave}
        </Button>
        {state === "saved" ? <span className="text-sm text-ok">{fmt(w.scopeSaved, { account })}</span> : null}
        {state !== "idle" && state !== "saving" && state !== "saved" ? (
          <span role="alert" className="text-sm text-bad">
            {state}
          </span>
        ) : null}
      </div>
    </section>
  );
}
