/**
 * Settings → Team: create a team or see yours; members and roles, invites, each project's owner and backup, seats, and
 * whether your results share PR links. The relay checks every role on its side; this only hides what you can't do.
 */
import { memberName, type TeamRoster } from "@overhand/contract";
import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { useModel } from "@/app/data";
import { useUi } from "@/app/ui";
import { Button } from "@/components/ui/button";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { get } from "@/lib/api";
import { FieldCard } from "../drawers/SettingsFields";
import { teamPost } from "./store";

const RelaySchema = z.object({ linked: z.boolean(), app: z.string() });
const input = "h-8 min-w-0 rounded-md border border-border bg-transparent px-2 text-sm";

async function run(action: string, body: object = {}, done = ""): Promise<Record<string, unknown> | null> {
  try {
    const r = await teamPost(action, body);
    if (done) toast(done);
    return r;
  } catch (e) {
    toast(e instanceof Error ? e.message : String(e));
    return null;
  }
}

function Create({ app }: { app: string }) {
  const [name, setName] = useState("");
  const create = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) void run("create", { name: name.trim() }, "Team created.");
  };
  return (
    <FieldCard title="Start a team">
      <p className="text-sm text-muted-foreground sm:col-span-2">
        Teammates see each other's crews: projects and their status, questions your agents ask on projects they own, results, hand-offs and
        who's here. Never code, diffs, keys, tokens or agent transcripts. A team needs the Team plan (per seat).
      </p>
      <form onSubmit={create} className="flex gap-2 sm:col-span-2">
        <input
          className={`${input} flex-1`}
          value={name}
          maxLength={60}
          placeholder="Team name"
          aria-label="Team name"
          onChange={(e) => setName(e.target.value)}
        />
        <Button type="submit">Create the team</Button>
      </form>
      <p className="text-xs text-muted-foreground sm:col-span-2">
        No Team plan yet?{" "}
        <a className="underline" href={`${app}/relay/billing?plan=team`} target="_blank" rel="noreferrer">
          Open Billing
        </a>
        . Invited to a team? Open the invite link in your browser and sign in with the invited address.
      </p>
    </FieldCard>
  );
}

function Members({ r }: { r: TeamRoster }) {
  const ui = useUi();
  const admin = r.role !== "member";
  const remove = async (user: string, email: string) => {
    const self = user === r.me;
    const ok = await ui.confirm({
      title: self ? `Leave ${r.team.name}?` : `Remove ${email}?`,
      body: self
        ? "You stop seeing the team, and your projects and status stop reaching it. Your own Overhand keeps working as before."
        : "They lose the team at once: their socket closes, their project ownership is cleared, and access that came with the seat ends.",
      go: self ? "Leave" : "Remove",
    });
    if (ok) void run(self ? "leave" : "remove", { user }, self ? "You left the team." : "Removed.");
  };
  return (
    <FieldCard title={`Members · ${r.members.length} of ${r.seats} seats`}>
      {r.over ? (
        <p role="alert" className="text-sm text-bad sm:col-span-2">
          More members than seats. Everyone keeps working until {new Date(r.over.until).toLocaleDateString()}; then the newest members stop
          until seats are added in Billing or someone is removed.
        </p>
      ) : null}
      <ul className="grid gap-1.5 sm:col-span-2">
        {r.members.map((m) => (
          <li key={m.user} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="min-w-0 flex-1 truncate">
              {memberName(m.email)} <span className="text-muted-foreground">{m.email}</span>
              {m.seated ? null : <span className="text-bad"> · no seat</span>}
            </span>
            {admin && m.role !== "owner" && (m.role === "member" || r.role === "owner") ? (
              <select
                aria-label={`Role of ${m.email}`}
                className={input}
                value={m.role}
                onChange={(e) => void run("role", { user: m.user, role: e.target.value }, "Role changed.")}
              >
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
            ) : (
              <span className="text-xs text-muted-foreground capitalize">{m.role}</span>
            )}
            {m.role !== "owner" && (m.user === r.me || (admin && (m.role === "member" || r.role === "owner"))) ? (
              <Button size="xs" variant="ghost" onClick={() => void remove(m.user, m.email)}>
                {m.user === r.me ? "Leave" : "Remove"}
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </FieldCard>
  );
}

function Invites({ r }: { r: TeamRoster }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [link, setLink] = useState("");
  const invite = async (e: FormEvent) => {
    e.preventDefault();
    const got = await run("invite", { email: email.trim(), role });
    if (got && typeof got.link === "string") {
      setLink(got.link);
      setEmail("");
    }
  };
  return (
    <FieldCard title="Invite">
      <form onSubmit={(e) => void invite(e)} className="flex flex-wrap gap-2 sm:col-span-2">
        <input
          className={`${input} flex-1`}
          type="email"
          required
          value={email}
          placeholder="name@company.com"
          aria-label="Email to invite"
          onChange={(e) => setEmail(e.target.value)}
        />
        <select aria-label="Role" className={input} value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
        <Button type="submit">Make an invite link</Button>
      </form>
      {link ? (
        <div className="flex gap-2 sm:col-span-2">
          <input
            className={`${input} flex-1 font-mono text-xs`}
            readOnly
            value={link}
            aria-label="Invite link"
            onFocus={(e) => e.target.select()}
          />
          <Button variant="outline" onClick={() => void navigator.clipboard.writeText(link).then(() => toast("Link copied."))}>
            Copy
          </Button>
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground sm:col-span-2">
        Send the link yourself (it isn't emailed). It works once, for that address, for 7 days, and holds a seat until then.
      </p>
      {r.invites.length ? (
        <ul className="grid gap-1 sm:col-span-2">
          {r.invites.map((i) => (
            <li key={i.id} className="flex items-center gap-2 text-sm">
              <span className="flex-1 truncate">
                {i.email}{" "}
                <span className="text-muted-foreground">
                  · {i.role}, until {new Date(i.expiresAt).toLocaleDateString()}
                </span>
              </span>
              <Button size="xs" variant="ghost" onClick={() => void run("revoke", { id: i.id }, "Invite withdrawn.")}>
                Withdraw
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </FieldCard>
  );
}

function Ownership({ r, projects }: { r: TeamRoster; projects: string[] }) {
  const admin = r.role !== "member";
  const names = [...new Set([...projects, ...r.projects.map((p) => p.project)])].sort();
  const pick = (value: string | null, label: string, onChange: (v: string) => void) => (
    <select aria-label={label} disabled={!admin} className={input} value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
      <option value="">Nobody</option>
      {r.members.map((m) => (
        <option key={m.user} value={m.user}>
          {memberName(m.email)}
        </option>
      ))}
    </select>
  );
  return (
    <FieldCard title="Project owners">
      <p className="text-xs text-muted-foreground sm:col-span-2">
        A question an agent asks on a project goes to its owner, and to the backup as well after 30 minutes. Projects match by their name in
        each person's Overhand.
      </p>
      <ul className="grid gap-1.5 sm:col-span-2">
        {names.map((p) => {
          const row = r.projects.find((x) => x.project === p);
          const set = (owner: string | null, backup: string | null) => void run("project", { project: p, owner, backup });
          return (
            <li key={p} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate">{p}</span>
              {pick(row?.owner ?? null, `Owner of ${p}`, (v) => set(v || null, row?.backup ?? null))}
              {pick(row?.backup ?? null, `Backup for ${p}`, (v) => set(row?.owner ?? null, v || null))}
            </li>
          );
        })}
      </ul>
    </FieldCard>
  );
}

/** The Team tab in Settings. */
export function TeamSettings() {
  const m = useModel();
  const relay = useQuery({ queryKey: ["relay"], queryFn: () => get("/api/relay", RelaySchema) });
  // read the roster afresh whenever the tab opens: a join or a change elsewhere shows at once
  useEffect(() => {
    void teamPost("refresh").catch(() => {});
  }, []);
  const t = m?.s.team ?? null;
  const app = relay.data?.app ?? "";
  if (relay.isPending) return <SkeletonRows rows={3} />;
  if (relay.data && !relay.data.linked)
    return (
      <p className="text-sm text-muted-foreground">
        A team works through your Overhand account. Link this computer first: Settings → Phone → Access from anywhere → Set it up.
      </p>
    );
  if (!t) return <Create app={app} />;
  const r = t.roster;
  return (
    <>
      <p className="text-sm">
        <b className="font-medium">{r.team.name}</b>{" "}
        <span className="text-muted-foreground">· you're {r.role === "member" ? "a member" : `the ${r.role}`}</span>
        {t.problem ? <span className="text-bad"> · {t.problem}</span> : null}
      </p>
      <Members r={r} />
      {r.role !== "member" ? <Invites r={r} /> : null}
      <Ownership r={r} projects={m?.s.clients.map((c) => c.name) ?? []} />
      <FieldCard title="What you share">
        <div className="flex items-center gap-2 text-sm sm:col-span-2">
          <Switch id="team-share-prs" checked={t.sharePrs} onCheckedChange={(on) => void run("share", { on })} />
          <label htmlFor="team-share-prs">Share pull request links in your results (off: teammates see the title and outcome only)</label>
        </div>
        <p className="text-xs text-muted-foreground sm:col-span-2">
          Never shared: code, diffs, keys, tokens, agent transcripts. Seats and the plan:{" "}
          <a className="underline" href={`${app}/relay/billing`} target="_blank" rel="noreferrer">
            Billing
          </a>
          .
        </p>
      </FieldCard>
    </>
  );
}
