import { type CheckupFinding, CheckupReportSchema } from "@overhand/contract";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";
import { useWords } from "@/app/theme";
import { Button } from "@/components/ui/button";
import { SkeletonRows } from "@/components/ui/skeleton";
import { get, post } from "@/lib/api";
import { fmt } from "@/lib/format";
import { nth } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { Dot, Muted } from "./Pane";

const ReportsSchema = z.object({ reports: z.array(CheckupReportSchema) });
const PickSchema = z.object({ state: z.enum(["picked", "queued", "ticket", "assigned"]), key: z.string() });

const DOT: Record<CheckupFinding["tone"], string> = {
  bad: "var(--bad)",
  warn: "var(--muted-foreground)",
  info: "var(--muted-foreground)",
  ok: "var(--ok)",
};

/** The check-up's reports: one repo (`repo`, relative to `codeRoot`), else the projects' repos. */
export function useCheckup(repo?: string, codeRoot = "") {
  const q = new URLSearchParams(repo === undefined ? {} : { repo, codeRoot });
  return useQuery({
    queryKey: ["checkup", repo ?? "", codeRoot],
    queryFn: () => get(`/api/checkup${repo === undefined ? "" : `?${q}`}`, ReportsSchema),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** Hands a check-up finding to an agent: the first win, a ticket, or (watch) a task with no ticket. */
export const pickFinding = (path: string, id: string, codeRoot = "") => post("/api/checkup/pick", { path, id, codeRoot }, PickSchema);

/** One finding: what Overhand saw, and, when an agent can fix it, the one click that hands it over. */
function Finding({ f, path, codeRoot, i }: { f: CheckupFinding; path: string; codeRoot: string; i: number }) {
  const w = useWords();
  const [done, setDone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const hand = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await pickFinding(path, f.id, codeRoot);
      setDone(
        r.state === "picked"
          ? w.checkupPicked
          : r.state === "queued"
            ? w.checkupQueued
            : fmt(r.state === "assigned" ? w.saidAssigned : w.checkupTicket, { key: r.key }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="m-enter grid gap-1" style={nth(i)}>
      <div className="flex items-baseline gap-2.5">
        <Dot color={DOT[f.tone]} />
        {/* the action sits beside the words while both fit on one line; narrower than that, it moves under them (the
            words' basis is their own width), keeping the right edge the other actions share */}
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2.5 gap-y-1.5">
          <span className={cn("min-w-0 flex-1 basis-auto text-sm [overflow-wrap:anywhere]", f.tone === "ok" && "text-muted-foreground")}>
            {f.title}
          </span>
          {f.task && !done ? (
            <Button variant="outline" size="sm" className="ml-auto shrink-0" disabled={busy} onClick={() => void hand()}>
              {w.assignAgent}
            </Button>
          ) : null}
        </div>
      </div>
      {done ? (
        <p className="pl-4.5 text-xs text-ok" aria-live="polite">
          {done}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="pl-4.5 text-xs text-bad">
          {error}
        </p>
      ) : null}
    </li>
  );
}

/**
 * The project check-up: what Overhand found in a repo, read-only, before any agent runs, each finding an agent can fix
 * one click from being handed over. `repo` (relative to `codeRoot`) checks that one; without it, the projects' repos.
 * `only` keeps one repo by name; `tasksOnly` keeps what an agent can take.
 */
export function Checkup({
  repo,
  codeRoot = "",
  only,
  tasksOnly = false,
  limit = 8,
}: {
  repo?: string;
  codeRoot?: string;
  only?: string;
  tasksOnly?: boolean;
  limit?: number;
}) {
  const w = useWords();
  const checked = useCheckup(repo, codeRoot);
  const name = repo?.split("/").at(-1) ?? only ?? "";
  if (checked.isPending)
    return (
      // what it's reading, in words, over the findings' shape
      <div className="grid gap-3" aria-busy="true">
        <Muted>{name ? fmt(w.checkupLooking, { repo: name }) : w.winLooking}</Muted>
        <SkeletonRows rows={3} />
      </div>
    );
  if (checked.isError) return <p className="text-sm text-warn">{checked.error.message}</p>;
  const reports = checked.data.reports.filter((r) => !only || r.repo === only);
  return (
    <div className="grid gap-3">
      {reports.map((r) => {
        const findings = r.findings.filter((f) => !tasksOnly || f.task).slice(0, limit);
        return (
          <div key={r.path} className="grid gap-2">
            {repo === undefined && reports.length < 2 ? null : (
              <p className="text-xs text-muted-foreground">{[r.repo, r.stack].filter(Boolean).join(" · ")}</p>
            )}
            {findings.some((f) => f.task) || !tasksOnly ? (
              <ul className="grid gap-2">
                {findings.map((f, i) => (
                  <Finding key={f.id} f={f} path={r.path} codeRoot={codeRoot} i={i} />
                ))}
              </ul>
            ) : null}
            {r.findings.every((f) => !f.task) ? <Muted>{fmt(w.checkupClean, { repo: r.repo })}</Muted> : null}
          </div>
        );
      })}
    </div>
  );
}
