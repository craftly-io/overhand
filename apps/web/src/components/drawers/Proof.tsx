import type { Proof as ProofData } from "@overhand/contract";
import { useEffect, useState } from "react";
import { useWords } from "@/app/theme";
import { apiFetch } from "@/lib/api";
import { changedText, proofLine } from "@/lib/firstwin";
import { fmt } from "@/lib/format";
import { Dot } from "../Pane";

const SECTION = "font-display text-xs tracking-widest text-primary uppercase";

/** A screenshot from the daemon as an object URL (fetched through the API transport, so the hosted page sees it too). */
function useShot(key: string, which: "before" | "after", on: boolean): string {
  return useApiImage(on ? `/api/proof/shot?key=${encodeURIComponent(key)}&which=${which}` : "");
}

/** An image the daemon serves, as an object URL fetched through the API transport; a data: URL (the demo's) as is. */
export function useApiImage(src: string): string {
  const [url, setUrl] = useState("");
  useEffect(() => {
    setUrl(src.startsWith("data:") ? src : "");
    if (!src || src.startsWith("data:")) return;
    let made = "";
    let live = true;
    apiFetch(src)
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => {
        if (b && live) {
          made = URL.createObjectURL(b);
          setUrl(made);
        }
      })
      .catch(() => {});
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [src]);
  return url;
}

/** CI's state counted the way the proof reads it: passing, failing, still running. */
function ciCounts(checks: { state: string }[]): { ok: number; bad: number; wait: number } {
  const bad = checks.filter((c) => /FAIL|ERROR|TIMED_OUT|CANCEL|ACTION_REQUIRED/i.test(c.state)).length;
  const wait = checks.filter((c) => /PENDING|QUEUED|IN_PROGRESS|EXPECTED|WAITING/i.test(c.state)).length;
  return { ok: checks.length - bad - wait, bad, wait };
}

/**
 * "Proof": what the agent ran and how each check ended, CI as it stands, what changed, what the agent says it verified,
 * before/after screenshots when the project renders, and the gaps (amber: they're yours to check). Nothing for a PR
 * opened before proofs existed.
 */
export function Proof({ prKey, proof, ci }: { prKey: string; proof: ProofData | null; ci: { state: string }[] }) {
  const w = useWords();
  const before = useShot(prKey, "before", Boolean(proof?.shots.before));
  const after = useShot(prKey, "after", Boolean(proof?.shots.after));
  if (!proof) return null;
  const counts = ciCounts(ci);
  return (
    <section className="mt-4 rounded-lg border border-border bg-background/40 p-3" aria-label={w.proofTitle}>
      <h3 className="text-sm font-semibold">{w.proofTitle}</h3>
      <p className="mt-1 text-xs text-muted-foreground">{w.proofIntro}</p>
      {/* the proof in one sentence a newcomer reads, before the commands that back it */}
      {proofLine(proof, w) ? <p className="mt-2 text-sm font-medium">{proofLine(proof, w)}</p> : null}
      <dl className="mt-3 grid gap-3 text-sm">
        <div>
          <dt className={SECTION}>{w.proofChecks}</dt>
          <dd className="mt-1">
            {!proof.transcript ? (
              <span className="text-muted-foreground">{w.proofNoLog}</span>
            ) : proof.checks.length ? (
              <ul className="grid gap-1">
                {proof.checks.map((c) => (
                  <li key={c.command} className="flex min-w-0 items-baseline gap-2">
                    <Dot color={c.ok ? "var(--ok)" : "var(--bad)"} label={c.ok ? "passed" : "failed"} />
                    <code className="min-w-0 font-mono text-xs [overflow-wrap:anywhere]">{c.command}</code>
                    {c.summary ? <span className="ml-auto shrink-0 text-xs text-muted-foreground">{c.summary}</span> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-muted-foreground">{w.proofNoChecks}</span>
            )}
          </dd>
        </div>
        <div>
          <dt className={SECTION}>{w.proofCi}</dt>
          <dd className="mt-1 text-muted-foreground">{ci.length ? fmt(w.proofCiSummary, counts) : w.proofCiNone}</dd>
        </div>
        <div>
          <dt className={SECTION}>{w.proofChanged}</dt>
          <dd className="mt-1">
            {changedText(proof, w)}
            {proof.areas.length ? (
              <span data-data className="ml-2 font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">
                {proof.areas.join(" · ")}
              </span>
            ) : null}
          </dd>
        </div>
        {proof.verified ? (
          <div>
            <dt className={SECTION}>{w.proofVerified}</dt>
            <dd className="mt-1 max-w-[33em] leading-relaxed">{proof.verified}</dd>
          </div>
        ) : null}
        {before || after ? (
          <div>
            <dt className={SECTION}>{w.proofShots}</dt>
            <dd className="mt-2 grid gap-2 sm:grid-cols-2">
              {[
                [w.proofBefore, before],
                [w.proofAfter, after],
              ].map(([label, src]) =>
                src ? (
                  <figure key={label} className="min-w-0">
                    <a href={src} target="_blank" rel="noopener noreferrer">
                      <img src={src} alt={`${label}: ${prKey}`} className="w-full rounded border border-border" />
                    </a>
                    <figcaption className="mt-1 text-xs text-muted-foreground">{label}</figcaption>
                  </figure>
                ) : null,
              )}
            </dd>
          </div>
        ) : null}
        <div>
          <dt className={SECTION}>{w.proofGaps}</dt>
          <dd className="mt-1">
            {proof.gaps.length ? (
              <ul className="grid gap-1">
                {proof.gaps.map((g) => (
                  <li key={g} className="flex items-baseline gap-2 text-warn">
                    <Dot color="var(--warn)" />
                    <span className="[overflow-wrap:anywhere]">{g}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-muted-foreground">{w.proofNoGaps}</span>
            )}
          </dd>
        </div>
      </dl>
    </section>
  );
}
