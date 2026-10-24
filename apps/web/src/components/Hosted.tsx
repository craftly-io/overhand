import { INSTALL_COMMAND, LOCAL_PORT, PLAN_COPY, PLAN_TAX, PLANS, planPrices, SITE } from "@overhand/contract";
import type { Words } from "@overhand/themes";
import { type ReactNode, useEffect, useState } from "react";
import { z } from "zod";
import { useWords } from "@/app/theme";
import { Button } from "@/components/ui/button";
import { fmt } from "@/lib/format";
import { connectRelay, type RtcState, trustKey } from "@/lib/rtc";
import { Boot } from "./Boot";
import { BrandMark } from "./Logo";

const MeSchema = z.object({ signedIn: z.boolean(), email: z.string().optional(), active: z.boolean().optional() });

/** One calm card, like Pair: the hosted page's states before the dashboard itself can show. */
function Card({ title, body, children }: { title: string; body?: string; children?: ReactNode }) {
  const w = useWords();
  return (
    <main id="main" className="relative grid min-h-dvh place-items-center px-4 py-10">
      <section className="hud-pane m-enter w-full max-w-sm gap-4" aria-labelledby="hosted-title">
        <header className="grid gap-2">
          <p className="text-xs text-muted-foreground">{w.brand}</p>
          <h1 id="hosted-title" className="flex items-center gap-2 font-display text-xl font-semibold">
            {title}
          </h1>
          {body ? <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{body}</p> : null}
        </header>
        {children ? <div className="flex flex-wrap gap-2">{children}</div> : null}
      </section>
    </main>
  );
}

const PriceSchema = z.object({ amount: z.number(), currency: z.string() });
const CyclesSchema = z.object({ month: PriceSchema.optional(), year: PriceSchema.optional() });
/** /relay/prices: the relay's own catalog, matched by each price's plan and cycle tags. */
const PricesSchema = z.object({ prices: z.object({ pro: CyclesSchema, team: CyclesSchema }) });
/** The plans and their prices, or null when they couldn't be read. */
export type HostedPrices = z.infer<typeof PricesSchema>["prices"] | null;

/**
 * The hosted page signed out: what Overhand is, its plans and live prices, the policies, and Sign in. Public, so
 * anyone, a payment provider's review too, sees what's sold here; `prices` undefined is still loading.
 */
export function HostedPublic({ w, prices, onSignIn }: { w: Words; prices: HostedPrices | undefined; onSignIn: () => void }) {
  const plans = PLANS.map((k) => ({ ...PLAN_COPY[k], prices: planPrices(k, prices) }));
  const links = [
    [w.hostedTerms, `${SITE}/terms`],
    [w.hostedPrivacy, `${SITE}/privacy`],
    [w.hostedRefund, `${SITE}/refund`],
    [w.hostedContact, `${SITE}/contact`],
    [w.hostedGetApp, SITE],
  ];
  return (
    <main id="main" className="relative grid min-h-dvh place-items-center px-4 py-10">
      <section className="hud-pane m-enter grid w-full max-w-lg gap-5" aria-labelledby="hosted-title">
        <header className="grid gap-2">
          <h1 id="hosted-title" className="flex items-center gap-2 font-display text-xl font-semibold">
            <BrandMark size={20} />
            {w.brand}
          </h1>
          <p className="text-sm">{w.hostedPublicLine}</p>
          <p className="text-sm text-muted-foreground">{w.hostedPublicAbout}</p>
        </header>
        <section className="grid gap-3" aria-labelledby="hosted-plans">
          <h2 id="hosted-plans" className="font-display text-base font-semibold">
            {w.hostedPlans}
          </h2>
          {prices === null ? (
            <a className="w-fit text-sm text-primary underline" href={`${SITE}/pricing`}>
              {w.hostedPricesElsewhere}
            </a>
          ) : (
            <ul className="grid gap-3">
              {plans.map((p) => (
                <li key={p.name} className="grid gap-1">
                  <p className="text-sm font-semibold">
                    {p.name} <span className="font-normal text-muted-foreground tabular-nums">{p.prices.join(" · ")}</span>
                  </p>
                  <p className="text-sm text-muted-foreground">{p.includes.join(". ")}.</p>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">{PLAN_TAX}</p>
        </section>
        <div className="flex flex-wrap gap-2">
          <Button onClick={onSignIn}>{w.hostedSignIn}</Button>
        </div>
        <nav aria-label={w.brand} className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {links.map(([label, href]) => (
            <a key={href} className="text-primary underline" href={href}>
              {label}
            </a>
          ))}
        </nav>
      </section>
    </main>
  );
}

/**
 * No computer answers yet: one click opens Overhand on this computer at Settings → Phone, where Set it up links it; or
 * the install line for a computer without Overhand. The link itself stays a click on that computer, never this page's.
 */
function HostedLink({ w }: { w: Words }) {
  const [copied, setCopied] = useState(false);
  const install = INSTALL_COMMAND;
  return (
    <Card title={w.hostedLinkTitle} body={w.hostedLinkBody}>
      <Button asChild>
        <a href={`http://localhost:${LOCAL_PORT}/?settings=phone`} target="_blank" rel="noopener noreferrer">
          {w.hostedOpenLocal}
        </a>
      </Button>
      <div className="w-full min-w-0 space-y-1.5 pt-2">
        <p className="text-xs text-muted-foreground">{w.hostedInstall}</p>
        <div className="flex items-center gap-2">
          <code className="block min-w-0 flex-1 truncate rounded-md bg-muted px-2 py-1.5 font-mono text-xs">{install}</code>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void navigator.clipboard
                .writeText(install)
                .then(() => setCopied(true))
                .catch(() => undefined)
            }
          >
            {copied ? w.hostedCopied : w.hostedCopy}
          </Button>
        </div>
      </div>
      <Button variant="ghost" onClick={signOut}>
        {w.hostedSignOut}
      </Button>
    </Card>
  );
}

const signOut = () => void fetch("/relay/logout", { method: "POST" }).then(() => window.location.reload());

/**
 * The hosted dashboard's gate (lazy-loaded only on the relay's origin): sign in, a paid plan, then a WebRTC connection
 * to your own computer. Once the data channel is open the real dashboard renders, its API flowing over that channel;
 * a dropped connection shows a banner while it reconnects.
 */
export function Hosted({ children }: { children: ReactNode }) {
  const w = useWords();
  const [me, setMe] = useState<z.infer<typeof MeSchema> | null | "error">(null);
  const [rtc, setRtc] = useState<RtcState>({ kind: "connecting" });
  const [shown, setShown] = useState(false);
  const [prices, setPrices] = useState<HostedPrices | undefined>(undefined);

  useEffect(() => {
    fetch("/relay/me")
      .then((r) => r.json())
      .then((j) => setMe(MeSchema.parse(j)))
      .catch(() => setMe("error"));
  }, []);
  // signed out, the page shows prices
  const pricing = me !== null && me !== "error" && !me.signedIn;
  useEffect(() => {
    if (!pricing) return;
    fetch("/relay/prices")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.statusText))))
      .then((j) => setPrices(PricesSchema.parse(j).prices))
      .catch(() => setPrices(null));
  }, [pricing]);
  const ready = me !== null && me !== "error" && me.signedIn && me.active === true;
  useEffect(() => {
    if (!ready) return;
    return connectRelay((s) => {
      setRtc(s);
      if (s.kind === "online") setShown(true);
    });
  }, [ready]);

  // reaching your computer from the phone (or any browser): the one loader, as while the app starts
  const reaching = (
    <main id="main">
      <Boot ready={false} label={w.hostedConnecting} className="min-h-dvh" />
    </main>
  );
  if (me === null) return reaching;
  // the sign-in check itself failed: this device can't reach the service, which says nothing about the computer
  if (me === "error")
    return (
      <Card title={w.hostedUnreachable} body={w.hostedUnreachableBody}>
        <Button onClick={() => window.location.reload()}>{w.hostedRetry}</Button>
      </Card>
    );
  if (!me.signedIn)
    return (
      <HostedPublic
        w={w}
        prices={prices}
        onSignIn={() =>
          window.location.assign(`/relay/login?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`)
        }
      />
    );
  // without a plan, the relay's own home: install, link, then plans (relay/src/home.ts)
  if (!me.active) {
    window.location.replace("/relay/home");
    return reaching;
  }
  if (rtc.kind === "untrusted")
    return (
      <Card title={w.hostedUntrusted} body={fmt(w.hostedUntrustedBody, { pinned: rtc.pinned, got: rtc.got })}>
        <Button
          variant="outline"
          onClick={() => {
            trustKey(rtc.pub);
            window.location.reload();
          }}
        >
          {w.hostedTrust}
        </Button>
      </Card>
    );
  if (rtc.kind === "error")
    return (
      <Card title={w.hostedOffline} body={rtc.message}>
        <Button onClick={() => window.location.reload()}>{w.hostedRetry}</Button>
      </Card>
    );
  if (!shown) return rtc.kind === "offline" ? <HostedLink w={w} /> : reaching;
  return (
    <>
      {rtc.kind !== "online" ? (
        <p role="status" className="fixed inset-x-0 top-0 z-50 bg-warn/90 px-4 py-1.5 text-center text-sm text-background">
          {rtc.kind === "offline" ? w.hostedOffline : w.hostedReconnecting}
        </p>
      ) : null}
      {children}
    </>
  );
}
