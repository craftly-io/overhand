/** Reaching the dashboard from a phone: what Tailscale says about this machine, and serving the dashboard over it. */
import { existsSync } from "node:fs";
import { z } from "zod";
import { shAsync } from "./env";

const MAC_APP = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
/** HTTPS ports tried for the dashboard, in order; one already serving something else is never taken over. */
const PORTS = [8443, 443, 10443];

/** What the Settings → Advanced section shows about Tailscale. */
export type Tailscale = {
  installed: boolean;
  running: boolean;
  /** This machine's tailnet name, e.g. mac.tail1234.ts.net. */
  host: string;
  /** The https address already serving the dashboard, or "". */
  served: string;
  /** That address is on Funnel: open to the whole internet, not just your tailnet. */
  funnel: boolean;
  /** The one command that serves the dashboard on the tailnet, or "" when every candidate port is taken. */
  command: string;
};

const StatusSchema = z.object({ BackendState: z.string(), Self: z.object({ DNSName: z.string() }).optional() });
const ServeSchema = z.object({
  TCP: z.record(z.string(), z.unknown()).optional(),
  Web: z.record(z.string(), z.object({ Handlers: z.record(z.string(), z.object({ Proxy: z.string().optional() })).optional() })).optional(),
  AllowFunnel: z.record(z.string(), z.boolean()).optional(),
});

/** The tailscale CLI: on PATH, else the Mac app's own. */
const tailscaleBin = (): string | null => Bun.which("tailscale") ?? (existsSync(MAC_APP) ? MAC_APP : null);

const json = (out: string): unknown => {
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
};

/** The https origin for a `host:port` serve key. */
const originOf = (hostPort: string): string => `https://${hostPort.replace(/:443$/, "")}`;

/** Reads Tailscale's state and its serve config (both read-only), and works out the serve command for `port`. */
export async function tailscale(port: number, bin = tailscaleBin()): Promise<Tailscale> {
  const none: Tailscale = { installed: false, running: false, host: "", served: "", funnel: false, command: "" };
  if (!bin) return none;
  const status = StatusSchema.safeParse(json((await shAsync([bin, "status", "--json"], undefined, 10_000)).out));
  const running = status.success && status.data.BackendState === "Running";
  const host = status.success ? (status.data.Self?.DNSName ?? "").replace(/\.$/, "") : "";
  if (!running || !host) return { ...none, installed: true, running };
  const serve = ServeSchema.safeParse(json((await shAsync([bin, "serve", "status", "--json"], undefined, 10_000)).out) ?? {});
  const cfg = serve.success ? serve.data : {};
  const target = new RegExp(`^(https?://)?(127\\.0\\.0\\.1|localhost):${port}/?$`);
  const mine = Object.entries(cfg.Web ?? {}).find(([, w]) => target.test(w.Handlers?.["/"]?.Proxy ?? ""))?.[0] ?? "";
  const taken = new Set(Object.keys(cfg.TCP ?? {}).map(Number));
  const free = PORTS.find((p) => !taken.has(p));
  return {
    installed: true,
    running,
    host,
    served: mine ? originOf(mine) : "",
    funnel: mine ? (cfg.AllowFunnel?.[mine] ?? false) : false,
    command: free ? `tailscale serve --bg --https=${free} http://127.0.0.1:${port}` : "",
  };
}

/**
 * Serves the dashboard on the tailnet with HTTPS on a free port (never one serving something else, never Funnel), and
 * returns the new state. Doesn't run when it's already served.
 */
export async function serveOnTailnet(
  port: number,
  bin = tailscaleBin(),
): Promise<{ ok: true; ts: Tailscale } | { ok: false; error: string }> {
  const ts = await tailscale(port, bin);
  if (!bin || !ts.running) return { ok: false, error: "Tailscale isn't running on this Mac." };
  if (ts.served) return { ok: true, ts };
  if (!ts.command)
    return { ok: false, error: "Every port Overhand would use already serves something else; run tailscale serve yourself." };
  const r = await shAsync([bin, ...ts.command.split(" ").slice(1)], undefined, 30_000);
  // a tailnet without HTTPS certificates says so here, with the admin link that switches them on
  if (!r.ok) return { ok: false, error: (r.err || r.out || "tailscale serve failed").slice(0, 400) };
  const after = await tailscale(port, bin);
  return after.served ? { ok: true, ts: after } : { ok: false, error: "tailscale serve ran, but Overhand isn't served yet." };
}
