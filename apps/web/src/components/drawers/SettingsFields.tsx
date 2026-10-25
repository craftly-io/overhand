import { type Check, localOnly } from "@overhand/contract";
import { ChevronRight } from "lucide-react";
import { createContext, type ReactNode, use, useId, useState } from "react";
import { useWords } from "@/app/theme";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { getAt, type Json, type JsonObject, stringAt } from "@/lib/json";

/** The settings form's shared state: the config draft and how to change it. */
export interface SettingsForm {
  draft: JsonObject;
  /** Bumps when the draft is replaced wholesale, so inputs pick up new values. */
  version: number;
  folders: string[];
  /** Where secrets go on this machine (Keychain, the keyring, a file), for labels. */
  store: string;
  /** The Slack inbox's MCP server file, by full path. */
  slackMcp: string;
  /** This browser is on the computer itself; on a device the LOCAL_ONLY fields are read-only. */
  local: boolean;
  set: (path: string, v: Json | undefined) => void;
  /** Rows an organise change touched while they had unsaved edits (`lead:<key>`, `project:<name>`); the edit is kept. */
  conflicts: ReadonlySet<string>;
}
export const FormCtx = createContext<SettingsForm | null>(null);
/** The settings form, inside SettingsDrawer. */
export function useForm(): SettingsForm {
  const f = use(FormCtx);
  if (!f) throw new Error("useForm needs the settings drawer");
  return f;
}

/** `fallback`: what a select shows when the config leaves the field out (the daemon's default for it); `labels`: plain words for its values. */
/** A switch over two strings: on writes `on`, off writes `off`; any value but `off` shows on. */
type Toggle = { off: string; on: string };
type Kind =
  | "text"
  | "num"
  | "csv"
  | "list"
  | "bool"
  | Toggle
  | { options: string[]; fallback?: string; labels?: Readonly<Record<string, string>> };
const NONE = "__none";

/** On a device, under a field only the computer changes: where to change it instead. */
function OnComputer({ id }: { id: string }) {
  const w = useWords();
  return (
    <p id={id} className="text-xs text-muted-foreground">
      {w.changeOnComputer}
    </p>
  );
}

/**
 * One config field, bound to a dotted path in the draft. Text fields commit on blur, like a form's change event. On a
 * device, a field only the computer changes (contract localOnly) is read-only, with where to change it.
 */
export function Field({ label, path, kind = "text" }: { label: string; path: string; kind?: Kind }) {
  const f = useForm();
  const id = useId();
  const v = getAt(f.draft, path);
  const locked = !f.local && localOnly(path);
  const why = locked ? `${id}-why` : undefined;
  const note = why ? <OnComputer id={why} /> : null;
  if (kind === "bool" || (typeof kind === "object" && "on" in kind)) {
    const toggle = typeof kind === "object" ? kind : null;
    return (
      <div className="grid gap-1">
        <div className="flex items-center justify-between gap-3 py-1">
          <Label htmlFor={id} className="text-xs text-muted-foreground">
            {label}
          </Label>
          <Switch
            id={id}
            checked={toggle ? v !== undefined && v !== toggle.off : v === true}
            disabled={locked}
            aria-describedby={why}
            onCheckedChange={(on) => f.set(path, toggle ? (on ? toggle.on : toggle.off) : on)}
          />
        </div>
        {note}
      </div>
    );
  }
  if (typeof kind === "object")
    return (
      <div className="grid min-w-0 gap-1">
        <Label htmlFor={id} className="text-xs text-muted-foreground">
          {label}
        </Label>
        <Select
          value={stringAt(f.draft, path, kind.fallback) || NONE}
          disabled={locked}
          onValueChange={(x) => f.set(path, x === NONE ? "" : x)}
        >
          <SelectTrigger id={id} size="sm" className="w-full min-w-0" aria-describedby={why}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {kind.options.map((o) => (
              <SelectItem key={o || NONE} value={o || NONE}>
                {kind.labels?.[o] ?? (o || "—")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {note}
      </div>
    );
  const shown = kind === "csv" && Array.isArray(v) ? v.join(", ") : typeof v === "string" || typeof v === "number" ? String(v) : "";
  const commit = (raw: string) => {
    if (kind === "num") f.set(path, raw.trim() === "" ? undefined : Number(raw));
    else if (kind === "csv")
      f.set(
        path,
        raw
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
      );
    else f.set(path, raw);
  };
  return (
    <div className="grid min-w-0 gap-1">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <Input
        key={`${f.version}-${path}`}
        id={id}
        type={kind === "num" ? "number" : "text"}
        defaultValue={shown}
        list={kind === "list" ? "set-folders" : undefined}
        spellCheck={false}
        readOnly={locked}
        aria-describedby={why}
        onBlur={(e) => {
          if (!locked) commit(e.target.value);
        }}
        className="h-8"
      />
      {note}
    </div>
  );
}

/** A group of fields with a title and an optional Remove button. */
export function FieldCard({
  title,
  onRemove,
  removeLabel = "Remove",
  id,
  note,
  children,
}: {
  title: string;
  onRemove?: () => void;
  removeLabel?: string;
  /** For scrolling to this card. */
  id?: string;
  /** One line under the title, e.g. that an organise change touched this row while it had unsaved edits. */
  note?: string;
  children: ReactNode;
}) {
  return (
    <div id={id} className="field-card scroll-mt-4 grid grid-cols-1 gap-x-3 gap-y-2 border border-border p-4 sm:grid-cols-2">
      <div className="flex items-center justify-between sm:col-span-2">
        <b data-heading="" className="font-display text-sm">
          {title}
        </b>
        {onRemove ? (
          <Button variant="ghost" size="xs" onClick={onRemove}>
            {removeLabel}
          </Button>
        ) : null}
      </div>
      {note ? (
        <p role="status" className="text-xs text-warn sm:col-span-2">
          {note}
        </p>
      ) : null}
      {children}
    </div>
  );
}

/** A fold's summary row: one line, its own marker, a full-size target. */
export const FOLD = "flex min-h-11 cursor-pointer list-none items-center gap-1.5 select-none [&::-webkit-details-marker]:hidden";

/** The fold's marker: points right while closed, down while open (its own details only, not an outer one). */
export function FoldMark() {
  return (
    <ChevronRight
      aria-hidden="true"
      className="size-4 shrink-0 text-muted-foreground transition-transform duration-(--m-instant) [details[open]>summary>&]:rotate-90"
    />
  );
}

/**
 * Inside a card, the fields most visits never need, folded under "More" (closed until opened, or opened for a deep link
 * with `open`). Its fields lay out like the card's own.
 */
export function More({ open = false, children }: { open?: boolean; children: ReactNode }) {
  const w = useWords();
  return (
    <details className="sm:col-span-2" open={open || undefined}>
      <summary className={`${FOLD} text-xs text-muted-foreground`}>
        <FoldMark />
        {w.setMore}
      </summary>
      <div className="mt-2 grid grid-cols-1 gap-x-3 gap-y-2 sm:grid-cols-2">{children}</div>
    </details>
  );
}

/** What ops checks on this machine; a missing token can be stored straight into the secret store from here. */
export function CheckRows({ checks, store }: { checks: Check[]; store: (service: string, value: string) => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const where = useForm().store;
  if (!checks.length) return <p className="text-sm text-muted-foreground">Nothing to check.</p>;
  return (
    <ul className="grid gap-2 sm:col-span-2">
      {checks.map((c) => {
        const secret = c.secret;
        return (
          <li key={c.what} className="flex flex-wrap items-center gap-2 text-sm">
            <span aria-hidden="true" style={{ color: c.ok ? "var(--ok)" : c.optional ? "var(--muted-foreground)" : "var(--bad)" }}>
              {c.ok ? "✓" : c.optional ? "–" : "✗"}
            </span>
            <span className="sr-only">{c.ok ? "OK:" : c.optional ? "Optional, skipped:" : "Missing:"}</span>
            {c.what}
            {!c.ok && secret ? (
              <>
                <Input
                  type="password"
                  autoComplete="off"
                  aria-label={`Token for ${secret}`}
                  placeholder="paste token"
                  className="h-8 w-56"
                  value={values[secret] ?? ""}
                  onChange={(e) => setValues({ ...values, [secret]: e.target.value })}
                />
                <Button size="xs" variant="outline" disabled={!values[secret]} onClick={() => store(secret, values[secret] ?? "")}>
                  Store in {where}
                </Button>
              </>
            ) : null}
            {!c.ok && !secret && c.fix ? <span className="text-xs text-muted-foreground">{c.fix}</span> : null}
          </li>
        );
      })}
    </ul>
  );
}
