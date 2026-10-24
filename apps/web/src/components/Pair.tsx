import { type FormEvent, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { useWords } from "@/app/theme";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { get, post } from "@/lib/api";
import { fmt } from "@/lib/format";

/** This machine's own addresses: a browser here without the local key is told how to open it signed in. */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * What another device sees before it's paired: one calm card asking for the code the Mac shows. A scanned link carries
 * the code (`?pair=`), so scanning pairs straight away; the code leaves the address bar at once either way.
 */
export function Pair() {
  const w = useWords();
  const [code, setCode] = useState(() => new URLSearchParams(window.location.search).get("pair") ?? "");
  // the command that works for this install (a source checkout has no `overhand`), asked on this computer only
  const [openCmd, setOpenCmd] = useState("overhand open");
  useEffect(() => {
    if (!LOOPBACK.has(window.location.hostname)) return;
    get("/api/open-command", z.object({ command: z.string() }))
      .then((r) => setOpenCmd(r.command))
      .catch(() => {});
  }, []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const tried = useRef(false);

  const pair = async (c: string) => {
    setBusy(true);
    setError("");
    try {
      await post("/api/pair", { code: c }, z.object({ ok: z.boolean() }));
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: once, for the code a scanned link brought
  useEffect(() => {
    if (window.location.search) window.history.replaceState(null, "", "/");
    if (code && !tried.current) {
      tried.current = true;
      void pair(code);
    }
  }, []);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (code.trim()) void pair(code);
  };

  return (
    <main id="main" className="relative grid min-h-dvh place-items-center px-4 py-10">
      <section className="hud-pane m-enter w-full max-w-sm gap-4" aria-labelledby="pair-title">
        <header className="grid gap-2">
          <p className="text-xs text-muted-foreground">{w.brand}</p>
          <h1 id="pair-title" className="font-display text-xl font-semibold">
            {w.pairTitle}
          </h1>
          <p className="text-sm text-muted-foreground">{w.pairBody}</p>
          {LOOPBACK.has(window.location.hostname) ? (
            <p className="text-sm text-muted-foreground">{fmt(w.pairHere, { command: openCmd })}</p>
          ) : null}
        </header>
        <form className="grid gap-3" onSubmit={submit}>
          <label className="grid gap-1.5 text-sm" htmlFor="pair-code">
            {w.pairCode}
          </label>
          <Input
            id="pair-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoComplete="one-time-code"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            inputMode="text"
            placeholder="ABCDE-FGH23"
            className="h-11 font-mono text-base"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "pair-error" : undefined}
          />
          <Button type="submit" size="lg" disabled={busy || !code.trim()}>
            {busy ? w.pairWorking : w.pairButton}
          </Button>
          {error ? (
            <p id="pair-error" role="alert" className="m-enter text-sm text-bad">
              {error}
            </p>
          ) : null}
        </form>
      </section>
    </main>
  );
}
