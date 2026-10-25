import { isObject, type Json } from "@/lib/json";
import { Field, FieldCard, useForm } from "./SettingsFields";

const str = (x: Json | undefined) => (typeof x === "string" ? x : "");

/**
 * Settings → Advanced → Status updates and work reports: the weekly schedule, and which status update channels the weekly report also
 * goes to (each gets only its own projects, through the outward firewall). Any range is on demand from Health.
 */
export function SettingsReports() {
  const f = useForm();
  const ids = (Array.isArray(f.draft.updates) ? f.draft.updates.filter(isObject) : []).map((u) => `${str(u.id)} (${str(u.name)})`);
  return (
    <FieldCard title="Work reports">
      <p className="text-xs text-muted-foreground sm:col-span-2">
        Per project: tickets done, PRs opened and merged, agent time, an estimate of human time saved (merged PRs only, from their size),
        cost, failures and open items. Health → Work reports builds one for any range, to print or export as Markdown or CSV. Weekly, each
        project's report on the past 7 days is also kept under reports/work in Overhand's folder.
      </p>
      <Field label="Weekly report" path="reports.weekly" kind="bool" />
      <div className="hidden sm:block" />
      <Field label="Day (0 Sunday … 6 Saturday)" path="reports.weekday" kind="num" />
      <Field label="Hour (0–23)" path="reports.hour" kind="num" />
      <Field
        label={`Also post to status channels (ids, comma-separated${ids.length ? `: ${ids.join(", ")}` : ""})`}
        path="reports.channels"
        kind="csv"
      />
      <Field label="Include cost in posted reports (exports always have it)" path="reports.cost" kind="bool" />
    </FieldCard>
  );
}
