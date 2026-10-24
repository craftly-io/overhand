import { type Check, UPDATE_KINDS, UPDATE_WHENS, UpdatePreviewSchema, updateSecret } from "@overhand/contract";
import { toast } from "sonner";
import { useActions } from "@/app/actions";
import { useTheme } from "@/app/theme";
import { Button } from "@/components/ui/button";
import { get } from "@/lib/api";
import { isObject, type Json, type JsonObject } from "@/lib/json";
import { CheckRows, Field, FieldCard, useForm } from "./SettingsFields";

const str = (x: Json | undefined) => (typeof x === "string" ? x : "");
const objects = (x: Json | undefined): JsonObject[] => (Array.isArray(x) ? x.filter(isObject) : []);

/**
 * Settings → Integrations → Status updates: channels that each get a summary of their projects. The webhook URL goes
 * straight to the secret store from the check row and is never shown again.
 */
export function StatusUpdates({ checks, store }: { checks: Check[]; store: (service: string, value: string) => void }) {
  const f = useForm();
  const { theme, words: w } = useTheme();
  const list = objects(f.draft.updates);
  const projects = objects(f.draft.clients).map((c) => str(c.name));
  const add = () =>
    f.set("updates", [
      ...list,
      {
        id: `channel-${Date.now().toString(36)}`,
        name: "Team channel",
        kind: "slack",
        projects: projects.slice(0, 1),
        voice: "plain",
        include: { shipped: true, review: true, blocked: true, next: true, spend: false },
        schedule: { when: "daily", hour: 9, weekday: 5 },
      },
    ]);
  const { updateTest: test } = useActions();
  const markdown = async (id: string) => {
    try {
      const r = await get(`/api/updates/preview?id=${encodeURIComponent(id)}`, UpdatePreviewSchema);
      await navigator.clipboard.writeText(r.markdown);
      toast(w.shareMdCopied);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <>
      <FieldCard title="Status updates">
        <p className="text-xs text-muted-foreground sm:col-span-2">
          Each channel gets what shipped, what needs review, what's blocked and what's next for its projects only, with PR links, through an
          incoming webhook: no app to register. Slack: an incoming webhook URL. Teams: a Workflows webhook ("Send webhook alerts to a
          channel"). Discord: a channel webhook. Spend stays out unless you turn it on, and a quiet day posts nothing. Email isn't offered:
          Overhand has no mail setup of its own.
        </p>
        <Button size="xs" variant="outline" className="justify-self-start" onClick={add}>
          Add a channel
        </Button>
      </FieldCard>
      {list.map((u, i) => {
        const id = str(u.id);
        const name = str(u.name) || "Channel";
        const secret = checks.filter((c) => c.secret === updateSecret(id));
        return (
          <FieldCard
            key={id || i}
            title={name}
            onRemove={() =>
              f.set(
                "updates",
                list.filter((_, j) => j !== i),
              )
            }
          >
            <Field label="Name" path={`updates.${i}.name`} />
            <Field label="Where" path={`updates.${i}.kind`} kind={{ options: [...UPDATE_KINDS], fallback: "slack" }} />
            <Field label={`Projects (comma-separated: ${projects.join(", ")})`} path={`updates.${i}.projects`} kind="csv" />
            <Field label="Voice" path={`updates.${i}.voice`} kind={{ options: [...new Set(["plain", theme.id])], fallback: "plain" }} />
            <Field
              label="When (eod = 18:00)"
              path={`updates.${i}.schedule.when`}
              kind={{ options: [...UPDATE_WHENS], fallback: "daily" }}
            />
            <Field label="Hour, for daily and weekly (0–23)" path={`updates.${i}.schedule.hour`} kind="num" />
            <Field label="Day, for weekly (0 Sunday … 6 Saturday)" path={`updates.${i}.schedule.weekday`} kind="num" />
            <div className="hidden sm:block" />
            <Field label="What shipped" path={`updates.${i}.include.shipped`} kind="bool" />
            <Field label="What needs review" path={`updates.${i}.include.review`} kind="bool" />
            <Field label="What's blocked" path={`updates.${i}.include.blocked`} kind="bool" />
            <Field label="What's next" path={`updates.${i}.include.next`} kind="bool" />
            <Field label="Spend (off by default)" path={`updates.${i}.include.spend`} kind="bool" />
            <div className="sm:col-span-2">
              {secret.length ? (
                <CheckRows checks={secret} store={store} />
              ) : (
                <p className="text-xs text-muted-foreground">
                  Save, then paste the webhook URL here. It goes to {f.store} and isn't shown again.
                </p>
              )}
            </div>
            <div className="flex flex-wrap gap-2 sm:col-span-2">
              <Button size="xs" variant="outline" onClick={() => void test(id, name)}>
                {w.updatesTest}
              </Button>
              <Button size="xs" variant="ghost" onClick={() => void markdown(id)}>
                {w.shareMarkdown}
              </Button>
            </div>
          </FieldCard>
        );
      })}
    </>
  );
}
