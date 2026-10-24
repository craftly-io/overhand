import type { Model } from "@/app/data";
import { useWords } from "@/app/theme";
import { useUi } from "@/app/ui";
import { Button } from "@/components/ui/button";
import { ago, fmt } from "@/lib/format";
import { GithubFix } from "../Connections";
import { Dot, Muted, Pane } from "../Pane";

const link = "hit-area relative inline-flex items-center gap-1.5 hover:underline";

/** One client's CI, deploys and errors on a line. */
function ClientRow({ name, m }: { name: string; m: Model }) {
  const w = useWords();
  const st = m.s.status;
  const ci = st.ci.filter((c) => c.client === name);
  const deps = Array.isArray(st.deploys) ? st.deploys.filter((d) => d.client === name) : [];
  const errs = Array.isArray(st.sentry) ? st.sentry.filter((i) => i.client === name) : [];
  const green = ci.filter((c) => c.state === "pass").length;
  return (
    <li className="grid grid-cols-[6rem_1fr] items-start gap-2 border-t border-border py-2 text-xs first:border-0">
      <b className="truncate text-sm font-medium" style={{ color: m.hue(name) }}>
        {name}
      </b>
      <div className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
        {!ci.length ? (
          <span className={link}>
            <Dot color="var(--muted-foreground)" />
            {w.noRepos}
          </span>
        ) : ci.every((c) => c.state === "none") ? (
          <span className={link}>
            <Dot color="var(--muted-foreground)" />
            {w.noCiRuns}
          </span>
        ) : (
          <>
            {ci
              .filter((c) => c.state === "fail" || c.state === "running")
              .map((c) => (
                <a
                  key={`${c.repo}-${c.branch}`}
                  className={link}
                  href={c.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={`${c.repo} on ${c.branch}: ${c.state}`}
                >
                  <Dot color={c.state === "fail" ? "var(--bad)" : "var(--primary)"} on label={c.state} />
                  {c.repo}
                </a>
              ))}
            {green ? (
              <span className={link}>
                <Dot color="var(--ok)" />
                {fmt(w.greenCount, { n: green })}
              </span>
            ) : null}
          </>
        )}
        {deps.map((d) => {
          const color = /ERROR|CANCELED/.test(d.state) ? "var(--bad)" : d.state === "READY" ? "var(--ok)" : "var(--primary)";
          return (
            <a
              key={`${d.project}-${d.created}`}
              className={link}
              href={d.url}
              target="_blank"
              rel="noopener noreferrer"
              title={`${d.project} ${d.state}, ${ago(d.created)}`}
            >
              ▲ <span style={{ color }}>{d.project}</span>
            </a>
          );
        })}
        {errs.length ? (
          <span style={{ color: errs.some((e) => e.isNew) ? "var(--bad)" : "var(--warn)" }}>{fmt(w.errorsToday, { n: errs.length })}</span>
        ) : null}
      </div>
    </li>
  );
}

/** Health's first section, the bridge's Systems glance in full: what's red per client, and why a source couldn't be read. */
export function HealthPane({ m }: { m: Model }) {
  const w = useWords();
  const ui = useUi();
  const st = m.s.status;
  const hints = [st.sentry, st.calendar, st.deploys].filter((x): x is string => typeof x === "string").concat(st.errors);
  return (
    <Pane title="paneSystems">
      <ul>
        {m.s.clients.map((c) => (
          <ClientRow key={c.name} name={c.name} m={m} />
        ))}
      </ul>
      {/* a source that couldn't be read says why, with its fix: GitHub's sign-in, else the place its connection is set */}
      {hints.map((h) => (
        <div key={h} className="mt-2 flex flex-wrap items-center gap-2">
          <Muted className="text-xs">{h}</Muted>
          {/^GitHub/.test(h) ? (
            <GithubFix />
          ) : (
            <Button size="xs" variant="outline" onClick={() => ui.openDrawer({ kind: "settings", tab: "integrations" })}>
              {w.connectButton}
            </Button>
          )}
        </div>
      ))}
      <Muted className="mt-2 text-xs">{st.at ? fmt(w.checkedAgo, { ago: ago(st.at) }) : w.checking}</Muted>
    </Pane>
  );
}
