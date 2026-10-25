import { AUTONOMY_LEVELS, type GroupRules, GroupRulesSchema } from "@overhand/contract";
import { type ReactNode, useState } from "react";
import { z } from "zod";
import { useWords } from "@/app/theme";
import { useForm } from "@/components/drawers/SettingsFields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fmt } from "@/lib/format";
import { isObject, type Json, type JsonObject } from "@/lib/json";
import { LEVEL_WORDS } from "@/lib/leads";
import { useOrganise } from "@/lib/organise";
import { cn } from "@/lib/utils";
import { GroupRulesForm, LeadScopePicker } from "./GroupControls";

/** The drag payload's type, so only project chips drop on a group. */
const DRAG = "application/x-overhand-project";
/** What "apply to every project" clears from each member, so it follows the group: the rules the group's form sets. */
const OWN_RULES = ["autonomy", "assignedAutonomy", "accounts"];

const str = (x: Json | undefined) => (typeof x === "string" ? x : "");
const objects = (x: Json | undefined): JsonObject[] => (Array.isArray(x) ? x.filter(isObject) : []);
const names = (x: Json | undefined): string[] => (Array.isArray(x) ? x.filter((m) => typeof m === "string") : []);
/** A group's rules as the config holds them: left-out rules are dropped, not written as nothing. */
const asJson = (rules: GroupRules): JsonObject => z.record(z.string(), z.json()).parse(JSON.parse(JSON.stringify(rules)));
const levelOf = (x: Json | undefined) => AUTONOMY_LEVELS.find((l) => l === x);

/** One project chip on the board: its name and how far agents go on it (its own level, or its group's). */
type Member = { name: string; own: boolean; level: (typeof AUTONOMY_LEVELS)[number] };

/**
 * Advanced → Groups: every group as a column of its projects, dragged between groups (or into "Not in a group"), with
 * the group's rules and project agent scope under it. Moves, new groups and rules go into Settings' draft and save with
 * the rest of Settings; the scope applies at once, since it can stop a running project agent and asks first. Each chip
 * also has a Move to menu, so nothing needs a mouse.
 */
export function GroupsBoard() {
  const w = useWords();
  const f = useForm();
  // the scope's advice and the scope last applied, as the daemon read the saved config
  const saved = useOrganise().data?.groups ?? [];
  const [fresh, setFresh] = useState("");
  const groups = objects(f.draft.groups);
  const clients = objects(f.draft.clients);
  const grouped = new Set(groups.flatMap((g) => names(g.members)));
  const member = (name: string, rules: Json | undefined): Member => {
    const own = levelOf(clients.find((c) => str(c.name) === name)?.autonomy);
    return { name, own: Boolean(own), level: own ?? levelOf(isObject(rules) ? rules.autonomy : undefined) ?? "act" };
  };
  const loose = clients.map((c) => str(c.name)).filter((n) => n && !grouped.has(n));
  const titles = groups.map((g) => str(g.name));
  const move = (project: string, to: string) => {
    const next = groups.map((g): JsonObject => ({ ...g, members: names(g.members).filter((m) => m !== project) }));
    const at = next.findIndex((g) => str(g.name) === to);
    const target = next[at];
    if (target) next[at] = { ...target, members: [...names(target.members), project] };
    else if (to) next.push({ name: to, members: [project], rules: {} });
    // a group left empty keeps its rules only if a project agent still names it
    const kept = new Set(objects(f.draft.godmode).map((l) => str(l.project)));
    f.set(
      "groups",
      next.filter((g) => names(g.members).length || kept.has(str(g.name))),
    );
  };
  const stage = (name: string) => (rules: GroupRules) =>
    f.set(
      "groups",
      groups.map((g) => (str(g.name) === name ? { ...g, rules: asJson(rules) } : g)),
    );
  const reset = (members: readonly string[]) => () =>
    f.set(
      "clients",
      clients.map((c) =>
        members.includes(str(c.name)) ? Object.fromEntries(Object.entries(c).filter(([k]) => !OWN_RULES.includes(k))) : c,
      ),
    );
  return (
    <section className="grid gap-4">
      <div className="grid gap-3 md:grid-cols-2">
        {groups.map((g) => {
          const name = str(g.name);
          const view = saved.find((x) => x.name === name);
          const rules = GroupRulesSchema.safeParse(g.rules ?? {}).data ?? {};
          return (
            <Column
              key={`${f.version}-${name}`}
              title={name}
              target={name}
              members={names(g.members).map((m) => member(m, g.rules))}
              names={titles}
              onMove={move}
            >
              <GroupRulesForm group={{ name, rules }} stage={stage(name)} onReset={reset(names(g.members))} />
              {view ? <LeadScopePicker group={view} /> : null}
            </Column>
          );
        })}
        <Column title={w.orgLoose} target="" members={loose.map((m) => member(m, undefined))} names={titles} onMove={move} />
      </div>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const first = loose[0];
          // a group exists through its members: the new one starts with the first loose project
          if (fresh.trim() && first) move(first, fresh.trim());
          setFresh("");
        }}
      >
        <Input
          aria-label={w.orgNewGroupName}
          placeholder={w.orgNewGroupName}
          value={fresh}
          onChange={(e) => setFresh(e.target.value)}
          className="max-w-60"
        />
        <Button type="submit" size="sm" variant="outline" disabled={!loose.length}>
          {w.orgNewGroup}
        </Button>
      </form>
    </section>
  );
}

function Column({
  title,
  target,
  members,
  names,
  onMove,
  children,
}: {
  title: string;
  target: string;
  members: readonly Member[];
  names: readonly string[];
  onMove: (project: string, to: string) => unknown;
  children?: ReactNode;
}) {
  const w = useWords();
  const [over, setOver] = useState(false);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drop target for the mouse; each chip's Move to menu is the keyboard way
    <div
      className={cn("grid content-start gap-3 rounded-lg border border-border p-3", over && "border-primary")}
      data-group={target}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DRAG)) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        const project = e.dataTransfer.getData(DRAG);
        if (project && !members.some((m) => m.name === project)) void onMove(project, target);
      }}
    >
      <h3 className="text-sm font-medium">{title}</h3>
      <ul className="flex min-h-8 flex-wrap gap-1.5" aria-label={title}>
        {members.length ? null : <li className="text-xs text-muted-foreground">{w.orgDropHere}</li>}
        {members.map((m) => (
          <li
            key={m.name}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(DRAG, m.name);
              e.dataTransfer.effectAllowed = "move";
            }}
            className="flex cursor-grab items-center gap-1.5 rounded-sm border border-border px-2 py-1 text-xs active:cursor-grabbing"
          >
            <span className="font-medium">{m.name}</span>
            <span className="text-muted-foreground">
              {m.own ? fmt(w.orgOwn, { value: w[LEVEL_WORDS[m.level]] }) : w[LEVEL_WORDS[m.level]]}
            </span>
            <select
              aria-label={fmt(w.orgMoveTo, { project: m.name })}
              className="h-6 border border-input bg-transparent text-xs pointer-coarse:h-11"
              value={target}
              onChange={(e) => void onMove(m.name, e.target.value)}
            >
              {names.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
              <option value="">{w.orgNoGroup}</option>
            </select>
          </li>
        ))}
      </ul>
      {children}
    </div>
  );
}
