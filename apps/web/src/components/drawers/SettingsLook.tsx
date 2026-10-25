import { isNewerVersion } from "@overhand/contract";
import { plainWords as w, worlds } from "@overhand/themes";
import { useActions } from "@/app/actions";
import { useModel } from "@/app/data";
import { useMapMode } from "@/app/mapMode";
import { useSound } from "@/app/sound";
import { useTheme } from "@/app/theme";
import { setTipsOn, useTipsOn } from "@/app/tips";
import { FeatureTip } from "@/components/FeatureTip";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { fmt } from "@/lib/format";
import { FieldCard } from "./SettingsFields";

/** A choice among a few, as pressed buttons. */
function Choices<T extends string>({
  label,
  value,
  options,
  onPick,
}: {
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onPick: (v: T) => void;
}) {
  return (
    <fieldset className="grid gap-1.5 sm:col-span-2">
      <legend className="mb-1.5 text-xs text-muted-foreground">{label}</legend>
      <div className="seg flex flex-wrap gap-1.5">
        {options.map(([v, name]) => (
          <Button key={v} variant="outline" size="sm" aria-pressed={value === v} onClick={() => onPick(v)}>
            {name}
          </Button>
        ))}
      </div>
    </fieldset>
  );
}

/** How the dashboard looks and sounds: one world picker, appearance, the map's motion, sounds. Kept in this browser. */
export function LookTab() {
  const { theme, setTheme, appearance, setAppearance, light } = useTheme();
  const sound = useSound();
  const [motion, setMotion] = useMapMode();
  const tips = useTipsOn();
  return (
    <>
      <p className="text-sm text-muted-foreground">Kept in this browser; other devices pick their own.</p>
      <FieldCard title={w.theme}>
        <FeatureTip at="settings-look" className="sm:col-span-2" />
        <div className="grid gap-2 sm:col-span-2 sm:grid-cols-2 sm:[&>:last-child:nth-child(odd)]:col-span-2">
          {worlds.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={t.id === theme.id}
              onClick={() => setTheme(t.id)}
              className="grid grid-cols-[2.5rem_1fr] items-center gap-3 rounded-md border border-border p-2.5 text-left transition-colors duration-(--m-instant) hover:bg-muted aria-pressed:border-primary aria-pressed:bg-primary/10"
            >
              <span
                aria-hidden="true"
                className="grid size-10 place-items-center rounded-md border border-border"
                style={{ background: (light ? t.light : t.tokens).background }}
              >
                <span className="size-2.5" style={{ background: (light ? t.light : t.tokens)["you-fill"] }} />
              </span>
              <span className="min-w-0">
                <b className="block text-sm font-medium">{t.name}</b>
                <span className="block truncate text-xs text-muted-foreground">{t.tagline}</span>
              </span>
            </button>
          ))}
        </div>
        <Choices
          label={w.appearance}
          value={appearance}
          options={[
            ["system", w.appearanceSystem],
            ["light", w.appearanceLight],
            ["dark", w.appearanceDark],
          ]}
          onPick={setAppearance}
        />
        <Choices
          label={w.sceneSetting}
          value={motion}
          options={[
            ["on", w.sceneOn],
            ["still", w.sceneStill],
          ]}
          onPick={setMotion}
        />
        <p className="-mt-1 text-xs text-muted-foreground sm:col-span-2">{w.sceneSettingHint}</p>
      </FieldCard>
      <FieldCard title={w.soundSetting}>
        <div className="flex items-center justify-between gap-3 text-sm sm:col-span-2">
          <span>
            {w.soundChimes}
            <span className="block text-xs text-muted-foreground">{w.soundChimesHint}</span>
          </span>
          <Switch checked={sound.on} onCheckedChange={sound.toggle} aria-label={sound.on ? w.soundOff : w.soundOn} />
        </div>
      </FieldCard>
      <FieldCard title={w.whatsNew}>
        <div className="flex items-center justify-between gap-3 text-sm sm:col-span-2">
          <span>
            {w.tipsSetting}
            <span className="block text-xs text-muted-foreground">{w.tipsSettingHint}</span>
          </span>
          <Switch checked={tips} onCheckedChange={setTipsOn} aria-label={w.tipsSetting} />
        </div>
      </FieldCard>
    </>
  );
}

/** Overhand itself: restart, update, clean up and turn off, each asking first. */
export function SystemTab() {
  const m = useModel();
  const { run, selfUpdate } = useActions();
  const behind = m?.s.opsBehind ?? 0;
  const u = m?.s.update;
  const release = u && isNewerVersion(u.latest, u.current) ? u : null;
  return (
    <>
      <FieldCard title="Update">
        <div className="grid gap-2 sm:col-span-2">
          {behind ? (
            <>
              <p className="text-sm">{fmt(w.alOpsUpdate, { n: behind })}</p>
              <Button className="justify-self-start" onClick={() => void selfUpdate()}>
                {w.confirmUpdateGo}
              </Button>
            </>
          ) : release ? (
            <p className="text-sm">{fmt(w.alReleaseSub, { current: release.current, command: release.command })}</p>
          ) : (
            <p className="text-sm text-muted-foreground">Up to date{u?.current ? ` (${u.current})` : ""}.</p>
          )}
        </div>
      </FieldCard>
      <FieldCard title="Disk">
        <div className="grid gap-2 sm:col-span-2">
          <p className="text-xs text-muted-foreground">{w.sweepHint}</p>
          <Button variant="outline" className="justify-self-start" onClick={() => void run({ name: "sweep" })}>
            {w.sweep}…
          </Button>
        </div>
      </FieldCard>
      <FieldCard title="Overhand">
        <div className="grid gap-2 sm:col-span-2">
          <p className="text-xs text-muted-foreground">{w.confirmRestart}</p>
          <Button variant="outline" className="justify-self-start" onClick={() => void run({ name: "restart" })}>
            {w.restartOps}…
          </Button>
          <p className="mt-2 text-xs text-muted-foreground">{w.confirmShutdown}</p>
          <Button variant="danger" className="justify-self-start" onClick={() => void run({ name: "shutdown" })}>
            {w.shutdown}
          </Button>
        </div>
      </FieldCard>
    </>
  );
}
