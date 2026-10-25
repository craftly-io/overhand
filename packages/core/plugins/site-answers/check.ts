/**
 * An example Overhand plugin: does each host in its manifest answer? One finding per host, printed as one JSON line.
 * It reaches its hosts through Overhand's bridge (plain fetch works: Overhand routes it), and only the hosts it declares.
 * Copy this folder, change the host in overhand-plugin.json, and install it from your own repository.
 */
import manifest from "./overhand-plugin.json";

/** One finding, the only thing a plugin may print. */
const say = (f: {
  title: string;
  line: string;
  severity: "info" | "warn" | "bad";
  fix: { kind: "link"; url: string } | { kind: "rerun" };
}) => console.log(JSON.stringify(f));

for (const host of manifest.hosts) {
  const url = `https://${host}/`;
  const t = performance.now();
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    const ms = Math.round(performance.now() - t);
    if (r.status < 400)
      say({ title: `${host} answers`, line: `It answered ${r.status} in ${ms} ms.`, severity: "info", fix: { kind: "link", url } });
    else
      say({
        title: `${host} answers ${r.status}`,
        line: `It answered with an error, in ${ms} ms.`,
        severity: "bad",
        fix: { kind: "link", url },
      });
  } catch (e) {
    say({
      title: `${host} doesn't answer`,
      line: e instanceof Error ? e.message.slice(0, 200) : String(e),
      severity: "bad",
      fix: { kind: "rerun" },
    });
  }
}
