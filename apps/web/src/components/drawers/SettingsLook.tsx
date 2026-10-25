import { isNewerVersion } from "@overhand/contract";
import { plainWords as w, worlds } from "@overhand/themes";
import type { ReactNode } from "react";
import { useActions } from "@/app/actions";
import { useModel } from "@/app/data";
import { setFocus, useFocus } from "@/app/focus";
import { useMapMode } from "@/app/mapMode";
import { useSound } from "@/app/sound";
import { useTheme } from "@/app/theme";
import { setTipsOn, useTipsOn } from "@/app/tips";
import { FeatureTip } from "@/components/FeatureTip";
import { TeamSettings } from "@/components/team/TeamSettings";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { fmt } from "@/lib/format";
import { Field, FieldCard } from "./SettingsFields";

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

/** A live switch row in a card: what it is, a line under it, the switch (kept in this browser at once, no Save). */
function Toggle({ label, hint, on, onChange }: { label: string; hint: string; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm sm:col-span-2">
      <span>
        {label}
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
      <Switch checked={on} onCheckedChange={onChange} aria-label={label} />
    </div>
  );
}

/** A card's one action: what it does in a line, then its button. */
function Act({ line, children }: { line: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-2 sm:col-span-2">
      {line}
      {children}
    </div>
  );
}

/**
 * Settings → You: your name and the Night report's hour (saved with Settings); how the dashboard looks and sounds (one
 * world picker, appearance, the map on Now, Focus, sounds, tips; kept in this browser at once); the menu bar item;
 * Overhand itself (update, restart, turn off, each asking first) and Send feedback; and the team, folded (it works
 * through your Overhand account, and says so until this computer is signed in).
 */
export function YouSection() {
  const { theme, setTheme, appearance, setAppearance, light } = useTheme();
  const m = useModel();
  const { run, selfUpdate } = useActions();
  const sound = useSound();
  const [motion, setMotion] = useMapMode();
  const focus = useFocus();
  const tips = useTipsOn();
  const behind = m?.s.opsBehind ?? 0;
  const u = m?.s.update;
  const release = u && isNewerVersion(u.latest, u.current) ? u : null;
  const menubar = m?.s.menubar;
  return (
    <>
      <FieldCard title={w.setYou}>
        <Field label={w.setName} path="owner.name" />
        <Field label={w.setBriefHour} path="schedule.briefAtHour" kind="num" />
        {/* only where this computer has one: a Mac with the helper installed */}
        {typeof menubar === "boolean" ? <Field label={w.menubar} path="menubar" kind="bool" /> : null}
      </FieldCard>
      <FieldCard title={w.theme}>
        <p className="text-xs text-muted-foreground sm:col-span-2">{w.setLookHere}</p>
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
            ["off", w.sceneOff],
            ["on", w.sceneOn],
            ["still", w.sceneStill],
          ]}
          onPick={setMotion}
        />
        <p className="-mt-1 text-xs text-muted-foreground sm:col-span-2">{w.sceneSettingHint}</p>
        <Toggle label={w.focus} hint={w.focusHint} on={focus} onChange={setFocus} />
        <FeatureTip at="settings-focus" className="sm:col-span-2" />
        <Toggle label={w.soundChimes} hint={w.soundChimesHint} on={sound.on} onChange={sound.toggle} />
        <Toggle label={w.tipsSetting} hint={w.tipsSettingHint} on={tips} onChange={setTipsOn} />
      </FieldCard>
      <FieldCard title="Overhand">
        <Act
          line={
            behind ? (
              <p className="text-sm">{fmt(w.alOpsUpdate, { n: behind })}</p>
            ) : release ? (
              <p className="text-sm">{fmt(w.alReleaseSub, { current: release.current, command: release.command })}</p>
            ) : (
              <p className="text-sm text-muted-foreground">Up to date{u?.current ? ` (${u.current})` : ""}.</p>
            )
          }
        >
          {behind ? (
            <Button className="justify-self-start" onClick={() => void selfUpdate()}>
              {w.confirmUpdateGo}
            </Button>
          ) : null}
        </Act>
        <Act line={<p className="text-xs text-muted-foreground">{w.confirmRestart}</p>}>
          <Button variant="outline" className="justify-self-start" onClick={() => void run({ name: "restart" })}>
            {w.restartOps}…
          </Button>
        </Act>
        <Act line={<p className="text-xs text-muted-foreground">{w.confirmShutdown}</p>}>
          <Button variant="danger" className="justify-self-start" onClick={() => void run({ name: "shutdown" })}>
            {w.shutdown}
          </Button>
        </Act>
        <Act line={<p className="text-xs text-muted-foreground">{w.feedbackHint}</p>}>
          <Button variant="outline" className="justify-self-start" onClick={() => void run({ name: "feedback" })}>
            {w.feedback}…
          </Button>
        </Act>
      </FieldCard>
      {/* folded: a team works through your Overhand account, and says so until this computer is signed in */}
      <details className="field-card border border-border p-4">
        <summary className="flex min-h-11 cursor-pointer items-center font-display text-sm select-none">{w.setTeam}</summary>
        <div className="mt-2 grid gap-3">
          <TeamSettings />
        </div>
      </details>
    </>
  );
}

/** Advanced → Disk cleanup: what it frees, and the sweep (it asks before deleting anything). */
export function CleanupCard() {
  const { run } = useActions();
  return (
    <FieldCard title={w.setAdvCleanup}>
      <FeatureTip at="settings-cleanup" className="sm:col-span-2" />
      <Act line={<p className="text-xs text-muted-foreground">{w.sweepHint}</p>}>
        <Button variant="outline" className="justify-self-start" onClick={() => void run({ name: "sweep" })}>
          {w.sweep}…
        </Button>
      </Act>
    </FieldCard>
  );
}
