import { PLUGIN_LIMIT, PLUGIN_REVIEW, PLUGIN_STOPS, type PluginState } from "@overhand/contract";
import { SITE } from "@overhand/contract/links";
import { useState } from "react";
import { useActions } from "@/app/actions";
import { useModel } from "@/app/data";
import { useWords } from "@/app/theme";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { fmt } from "@/lib/format";
import { PLUGIN_KIND, pluginLine } from "@/lib/plugins";
import { FieldCard } from "./SettingsFields";

/** One plugin: what it does, reaches and asks for, its pin and limits, and what you can do with it now. */
function PluginCard({ p }: { p: PluginState }) {
  const w = useWords();
  const { plugin } = useActions();
  // what you grant is chosen here, before approving: nothing is granted until you approve with it
  const [grant, setGrant] = useState<string[]>(p.granted);
  const approving = p.state === "waiting" || p.state === "changed";
  return (
    <FieldCard title={`${p.name} ${p.version}`} onRemove={() => void plugin({ do: "remove", name: p.name })} removeLabel={w.plRemove}>
      <div className="col-span-full grid gap-1 text-sm">
        <p>
          {p.line} <span className="text-xs text-muted-foreground">{w[PLUGIN_KIND[p.kind]]}</span>
        </p>
        <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{pluginLine(p, w)}</p>
        <p className="text-xs [overflow-wrap:anywhere]">{p.hosts.length ? fmt(w.plHosts, { hosts: p.hosts.join(", ") }) : w.plNoHosts}</p>
        {p.secrets.length ? <p className="text-xs">{fmt(w.plAsks, { names: p.secrets.join(", ") })}</p> : null}
        <p className="text-xs text-muted-foreground">{fmt(w.plLimits, { sec: p.timeoutSec, mb: p.memoryMb })}</p>
        <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{fmt(w.plPinned, { pin: p.pin, source: p.source })}</p>
      </div>
      {approving
        ? p.secrets.map((s) => (
            <Label key={s} className="flex items-center gap-2 text-sm font-normal">
              <Switch checked={grant.includes(s)} onCheckedChange={(on) => setGrant(on ? [...grant, s] : grant.filter((g) => g !== s))} />
              {fmt(w.plGrant, { name: s })}
            </Label>
          ))
        : null}
      <div className="col-span-full flex flex-wrap gap-2">
        {approving ? (
          <Button size="sm" onClick={() => void plugin({ do: "approve", name: p.name, grant })}>
            {p.state === "changed" ? w.plApproveAgain : w.plApprove}
          </Button>
        ) : null}
        {p.state === "on" ? (
          <>
            <Button size="sm" variant="outline" onClick={() => void plugin({ do: "run", name: p.name })}>
              {w.plRunAgain}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void plugin({ do: "pause", name: p.name, paused: true })}>
              {w.plPause}
            </Button>
          </>
        ) : null}
        {p.state === "paused" ? (
          <Button size="sm" variant="outline" onClick={() => void plugin({ do: "pause", name: p.name, paused: false })}>
            {w.plResume}
          </Button>
        ) : null}
      </div>
    </FieldCard>
  );
}

/**
 * Settings → Plugins: install one from a pinned version, see what it reaches and asks for, approve it, pause, remove.
 * Every action here is done at once (none waits for Save), and approval is only ever this button.
 */
export function PluginsTab() {
  const w = useWords();
  const m = useModel();
  const { plugin } = useActions();
  const [source, setSource] = useState("");
  const [pin, setPin] = useState("");
  const [dir, setDir] = useState("");
  const install = async () => {
    if (await plugin({ do: "add", source, pin, dir })) {
      setSource("");
      setPin("");
      setDir("");
    }
  };
  return (
    <>
      <p className="text-sm text-muted-foreground">
        {PLUGIN_REVIEW}{" "}
        <a className="underline" href={`${SITE}/docs/plugins.html`} target="_blank" rel="noopener noreferrer">
          {w.plHowTo}
        </a>
      </p>
      {(m?.s.plugins ?? []).map((p) => (
        <PluginCard key={`${p.name}-${p.state}`} p={p} />
      ))}
      <FieldCard title={w.plInstall}>
        {(
          [
            [w.plSource, source, setSource],
            [w.plPin, pin, setPin],
            [w.plDir, dir, setDir],
          ] as const
        ).map(([label, value, set]) => (
          <Label key={label} className="col-span-full grid gap-1 text-xs font-normal">
            {label}
            <Input value={value} spellCheck={false} onChange={(e) => set(e.target.value)} />
          </Label>
        ))}
        <Button className="justify-self-start" size="sm" disabled={!source.trim() || !pin.trim()} onClick={() => void install()}>
          {w.plInstall}
        </Button>
      </FieldCard>
      <p className="text-xs text-muted-foreground">{PLUGIN_STOPS}</p>
      <p className="text-xs text-muted-foreground">{PLUGIN_LIMIT}</p>
    </>
  );
}
