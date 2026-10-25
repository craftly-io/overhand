import { askGate } from "@overhand/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { encode } from "uqr";
import { z } from "zod";
import { useOnReturn } from "@/app/fresh";
import { useWords } from "@/app/theme";
import { Mark } from "@/components/Connections";
import { Button } from "@/components/ui/button";
import { SkeletonRows } from "@/components/ui/skeleton";
import { get, post } from "@/lib/api";
import { ago, fmt } from "@/lib/format";
import { HOSTED } from "@/lib/hosted";
import { nth } from "@/lib/motion";

const PhoneSchema = z.object({
  local: z.boolean(),
  port: z.number(),
  tailscale: z.object({
    installed: z.boolean(),
    running: z.boolean(),
    host: z.string(),
    served: z.string(),
    funnel: z.boolean(),
    command: z.string(),
  }),
  origins: z.array(z.string()),
  ntfy: z.boolean(),
});
const DevicesSchema = z.object({
  local: z.boolean(),
  devices: z.array(z.object({ id: z.string(), name: z.string(), at: z.number(), seen: z.number(), current: z.boolean() })),
});
const PairingSchema = z.object({ code: z.string(), until: z.number(), url: z.string() });
const Ok = z.object({ ok: z.boolean() });

const errorOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

const RelaySchema = z.object({
  available: z.boolean(),
  enabled: z.boolean(),
  linked: z.boolean(),
  email: z.string(),
  fingerprint: z.string(),
  plan: z.string().nullable(),
  entitlement: z.enum(["active", "grace", "none"]),
  online: z.boolean(),
  app: z.string(),
  error: z.string(),
});
const PushKeySchema = z.object({ key: z.string(), active: z.boolean(), subscribed: z.number() });

/**
 * Access from anywhere: on the computer, link it to your account and switch it on (plans open on the relay's billing
 * page, in a new tab); on the hosted page, turn on push for this device. Nothing here gates anything local.
 */
/** This tab's throttle on reading the plan again when you come back. */
const relayCheck = askGate(1);

function Anywhere({ local }: { local: boolean }) {
  const w = useWords();
  const qc = useQueryClient();
  const [busy, setBusy] = useState("");
  const relay = useQuery({ queryKey: ["relay"], queryFn: () => get("/api/relay", RelaySchema), refetchInterval: 15_000 });
  const pushKey = useQuery({ queryKey: ["push-key"], queryFn: () => get("/api/push/key", PushKeySchema), enabled: HOSTED });
  const r = relay.data;
  const act = async (key: string, run: () => Promise<void>) => {
    setBusy(key);
    try {
      await run();
    } catch (e) {
      toast.error(errorOf(e));
    } finally {
      setBusy("");
    }
  };
  const call = (path: string, body: object = {}) =>
    act(path, async () => {
      qc.setQueryData(["relay"], await post(path, body, RelaySchema));
    });
  // back from the plans page (or any other tab): the plan is read again, at most once a minute
  useOnReturn(() => {
    if (local && relayCheck(0, Date.now()))
      void post("/api/relay/refresh", { auto: true }, RelaySchema).then(
        (x) => qc.setQueryData(["relay"], x),
        () => {},
      );
  });
  const link = () =>
    act("link", async () => {
      const { url } = await post("/api/relay/link", {}, z.object({ url: z.string() }));
      window.open(url, "_blank", "noopener");
      toast(w.anywhereSetUpHint);
    });
  const subscribe = () =>
    act("push", async () => {
      const key = pushKey.data?.key;
      if (!key) return;
      const { subscribePush } = await import("@/lib/rtc");
      const result = await subscribePush(key, async (subscription) => {
        await post("/api/push/subscribe", { subscription }, Ok);
      });
      if (result === "done") toast(w.pushDone);
      else toast.error(result === "denied" ? w.pushDenied : w.pushUnsupported);
    });
  if (!r) return null;
  const plans = `${r.app}/relay/billing`;

  return (
    <div className="grid gap-2 border-t border-border pt-3">
      <h3 className="text-sm font-semibold">{w.anywhereTitle}</h3>
      <p className="text-xs text-muted-foreground">{fmt(w.anywhereHint, { app: new URL(r.app).host })}</p>
      {!r.available ? (
        <p className="text-sm text-muted-foreground">{w.anywhereUnavailable}</p>
      ) : !r.linked ? (
        local ? (
          <div>
            <Button size="sm" variant="outline" disabled={busy === "link"} onClick={() => void link()}>
              {w.anywhereSetUp}
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">{w.phoneFromMac}</p>
        )
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Mark tone={r.enabled && r.online ? "ok" : r.enabled && r.entitlement === "none" ? "warn" : "idle"} />
            <span className="min-w-40 flex-1 text-sm break-words">
              {fmt(r.enabled ? w.anywhereOn : w.anywhereOff, { email: r.email })}
              <span className="block text-xs text-muted-foreground">
                {r.entitlement === "none"
                  ? w.anywhereNeedsPlan
                  : r.entitlement === "grace"
                    ? w.anywhereGrace
                    : r.enabled
                      ? r.online
                        ? w.anywhereOnline
                        : w.anywhereConnecting
                      : ""}
              </span>
            </span>
          </div>
          {local ? (
            <div className="flex flex-wrap gap-2 sm:pl-8">
              <Button size="sm" variant="outline" disabled={busy !== ""} onClick={() => void call("/api/relay/enable", { on: !r.enabled })}>
                {r.enabled ? w.anywhereTurnOff : w.anywhereTurnOn}
              </Button>
              {r.entitlement === "none" ? (
                <Button size="sm" variant="outline" onClick={() => window.open(plans, "_blank", "noopener")}>
                  {w.anywherePlans}
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" disabled={busy !== ""} onClick={() => void call("/api/relay/unlink")}>
                {w.anywhereUnlink}
              </Button>
            </div>
          ) : null}
          {r.error ? <p className="text-xs text-warn sm:pl-8">{r.error}</p> : null}
          {r.fingerprint ? (
            <p className="font-mono text-xs text-muted-foreground sm:pl-8">{fmt(w.anywhereKey, { fingerprint: r.fingerprint })}</p>
          ) : null}
        </>
      )}
      {HOSTED && pushKey.data?.active ? (
        <div className="grid gap-1.5 pt-2">
          <h4 className="text-sm font-semibold">{w.pushTitle}</h4>
          <p className="text-xs text-muted-foreground">{w.pushHint}</p>
          <div>
            <Button size="sm" variant="outline" disabled={busy === "push"} onClick={() => void subscribe()}>
              {w.pushOn}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** A QR code as crisp SVG squares, dark on light whatever the theme, so any phone camera reads it. */
function Qr({ text, label }: { text: string; label: string }) {
  const { data } = encode(text, { ecc: "M", border: 2 });
  const d = data.flatMap((row, y) => row.flatMap((on, x) => (on ? [`M${x} ${y}h1v1h-1z`] : []))).join("");
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${data.length} ${data.length}`}
      className="m-enter size-48 shrink-0 rounded-md bg-white"
      shapeRendering="crispEdges"
    >
      <path d={d} fill="black" />
    </svg>
  );
}

/**
 * The phone, in two parts. Settings → Connections (the one shown answer): Access from anywhere first, then pairing a
 * phone with a one-time code and QR, and the paired devices. Advanced → Extra origins, tailnet and notifications
 * (`part="tailnet"`): the dashboard on your own tailnet (one click, or the exact command) and a test notification.
 */
export function Phone({ part = "anywhere" }: { part?: "anywhere" | "tailnet" }) {
  const w = useWords();
  const qc = useQueryClient();
  const [pairing, setPairing] = useState<z.infer<typeof PairingSchema> | null>(null);
  const [busy, setBusy] = useState("");
  const phone = useQuery({ queryKey: ["phone"], queryFn: () => get("/api/phone", PhoneSchema) });
  // while a code is up, look every two seconds so the new device appears the moment it pairs
  const list = useQuery({
    queryKey: ["devices"],
    queryFn: () => get("/api/devices", DevicesSchema),
    refetchInterval: pairing ? 2000 : false,
  });
  const devices = list.data?.devices ?? [];
  const count = useRef(-1);

  useEffect(() => {
    if (!pairing) return;
    const t = setTimeout(() => setPairing(null), Math.max(0, pairing.until - Date.now()));
    return () => clearTimeout(t);
  }, [pairing]);
  useEffect(() => {
    const newest = devices[0];
    if (pairing && newest && count.current >= 0 && devices.length > count.current) {
      setPairing(null);
      toast(fmt(w.devicesPaired, { name: newest.name }));
    }
    count.current = list.data ? devices.length : -1;
  }, [devices, list.data, pairing, w.devicesPaired]);

  const act = async (key: string, run: () => Promise<void>) => {
    setBusy(key);
    try {
      await run();
    } catch (e) {
      toast.error(errorOf(e));
    } finally {
      setBusy("");
    }
  };
  const serve = () =>
    act("serve", async () => {
      qc.setQueryData(["phone"], await post("/api/phone/serve", {}, PhoneSchema));
      void qc.invalidateQueries({ queryKey: ["settings"] });
    });
  const addDevice = () => act("pair", async () => setPairing(await post("/api/devices/pair", {}, PairingSchema)));
  const remove = (id: string, name: string) =>
    act(id, async () => {
      await post("/api/devices/revoke", { id }, Ok);
      toast(fmt(w.devicesRemoved, { name }));
      await list.refetch();
    });
  const test = () =>
    act("ntfy", async () => {
      await post("/api/phone/test", {}, Ok);
      toast(w.ntfySent);
    });

  const p = phone.data;
  const ts = p?.tailscale;
  const usable = Boolean(ts?.served && p?.origins.includes(ts.served));
  const origin = pairing?.url ? new URL(pairing.url).origin : "";

  return (
    <section className="hud-pane gap-4" aria-labelledby="phone-title" aria-busy={phone.isPending}>
      <header className="grid gap-1">
        <h2 id="phone-title" className="font-display text-base">
          {part === "tailnet" ? w.phoneTailnetTitle : w.phoneTitle}
        </h2>
        <p className="text-sm text-muted-foreground">{part === "tailnet" ? w.phoneHint : w.phoneAnywhere}</p>
      </header>
      {phone.isError ? (
        <p role="alert" className="text-sm text-bad">
          {phone.error.message}
        </p>
      ) : null}

      {part === "tailnet" ? (
        <>
          {phone.isPending ? <SkeletonRows rows={3} /> : null}
          {p && ts ? (
            <div className="m-stagger grid gap-2">
              {!ts.installed ? (
                <p className="text-sm">{w.phoneNoTailscale}</p>
              ) : !ts.running ? (
                <p className="text-sm">{w.phoneTailscaleOff}</p>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2" style={nth(0)}>
                    <Mark key={String(usable)} tone={usable ? "ok" : "warn"} />
                    <span className="min-w-0 flex-1 text-sm break-words">
                      {ts.served ? fmt(w.phoneServed, { origin: ts.served }) : w.phoneNotServed}
                    </span>
                    {p.local && !usable && (ts.served || ts.command) ? (
                      <Button size="sm" variant="outline" disabled={busy === "serve"} onClick={() => void serve()}>
                        {ts.served ? w.phoneUseButton : w.phoneServeButton}
                      </Button>
                    ) : null}
                  </div>
                  {!ts.served && ts.command && p.local ? (
                    <div className="grid gap-1.5 sm:pl-8" style={nth(1)}>
                      <p className="text-xs text-muted-foreground">{w.phoneServeHint}</p>
                      <code className="block rounded-md border border-border bg-background px-3 py-2 font-mono text-xs break-all select-all">
                        {ts.command}
                      </code>
                    </div>
                  ) : null}
                  {!ts.served && !ts.command ? <p className="text-xs text-muted-foreground sm:pl-8">{w.phonePortsTaken}</p> : null}
                  {ts.funnel ? (
                    <p role="alert" className="text-xs text-warn sm:pl-8">
                      {w.phoneFunnel}
                    </p>
                  ) : null}
                </>
              )}
              {!p.local ? <p className="text-xs text-muted-foreground">{w.phoneFromMac}</p> : null}
            </div>
          ) : null}

          {p ? (
            <div className="grid gap-2 border-t border-border pt-3">
              <h3 className="text-sm font-semibold">{w.ntfyTitle}</h3>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <Mark tone={p.ntfy ? "ok" : "idle"} />
                <span className="min-w-40 flex-1 text-sm text-muted-foreground">{p.ntfy ? w.ntfyOn : w.ntfyOff}</span>
                {p.ntfy ? (
                  <Button size="sm" variant="outline" disabled={busy === "ntfy"} onClick={() => void test()}>
                    {w.ntfyTest}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
        </>
      ) : (
        <>
          {phone.isPending ? <SkeletonRows rows={3} /> : null}
          {p ? <Anywhere local={p.local} /> : null}

          <div className="grid gap-2 border-t border-border pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">{w.devicesTitle}</h3>
              {p?.local ? (
                <Button size="sm" variant="outline" disabled={busy === "pair"} onClick={() => void addDevice()}>
                  {w.devicesAdd}
                </Button>
              ) : null}
            </div>
            {pairing ? (
              pairing.url ? (
                <div className="m-enter flex flex-wrap items-center gap-4 rounded-md border border-border bg-background p-3">
                  <Qr text={pairing.url} label={w.devicesAdd} />
                  <div className="grid min-w-48 flex-1 gap-2">
                    <p className="font-mono text-2xl font-semibold tabular-nums">
                      <span aria-hidden="true">
                        {pairing.code.slice(0, 5)}-{pairing.code.slice(5)}
                      </span>
                      <span className="sr-only">{pairing.code.split("").join(" ")}</span>
                    </p>
                    <p className="text-xs text-muted-foreground">{fmt(w.devicesScan, { origin })}</p>
                    <p className="flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
                      <span aria-hidden="true" className="m-pulse size-1.5 rounded-full bg-primary" />
                      {w.devicesWaiting}
                    </p>
                  </div>
                </div>
              ) : (
                <p className="m-enter text-sm text-warn">{w.devicesNoOrigin}</p>
              )
            ) : null}
            {devices.length ? (
              <ul className="m-stagger grid divide-y divide-border">
                {devices.map((d, i) => (
                  <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2" style={nth(i)}>
                    <span className="min-w-40 flex-1 text-sm">
                      {d.name}
                      {d.current ? <span className="text-muted-foreground"> · {w.devicesThis}</span> : null}
                      <span className="block text-xs text-muted-foreground">
                        {fmt(w.devicesSeen, { at: new Date(d.at).toLocaleDateString(), seen: ago(d.seen) })}
                      </span>
                    </span>
                    <Button size="sm" variant="ghost" disabled={busy === d.id} onClick={() => void remove(d.id, d.name)}>
                      {w.devicesRemove}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : list.data ? (
              <p className="text-sm text-muted-foreground">{w.devicesNone}</p>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}
