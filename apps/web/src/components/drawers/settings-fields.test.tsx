import { expect, test } from "bun:test";
import { plainWords as w } from "@overhand/themes";
import { render, withDom } from "../render.test-util";
import { Field, FormCtx, type SettingsForm } from "./SettingsFields";

/** On a paired device, a field only the computer changes is read-only and says where to change it; on the computer, it's a field. */
withDom();

const form = (local: boolean, set: SettingsForm["set"] = () => {}): SettingsForm => ({
  draft: { clients: [{ name: "app", preview: { command: "bun run dev", url: "" } }], sandbox: { mode: "off" } },
  version: 0,
  folders: [],
  store: "",
  slackMcp: "",
  local,
  set,
  conflicts: new Set(),
});

const fields = (f: SettingsForm) => () => (
  <FormCtx value={f}>
    <Field label="Preview" path="clients.0.preview.command" />
    <Field label="Preview URL" path="clients.0.preview.url" />
  </FormCtx>
);

test("a device sees the preview command read-only with where to change it; the URL beside it stays editable", async () => {
  const el = await render(fields(form(false)), true);
  const [command, url] = [...el.querySelectorAll("input")];
  expect(command?.readOnly).toBe(true);
  expect(url?.readOnly).toBe(false);
  expect(el.textContent).toContain(w.changeOnComputer);
  const why = command?.getAttribute("aria-describedby") ?? "";
  expect(why && el.querySelector(`[id="${why}"]`)?.textContent).toBe(w.changeOnComputer);
});

test("on the computer itself the same field is editable, with no note", async () => {
  const el = await render(fields(form(true)), true);
  expect([...el.querySelectorAll("input")].every((i) => !i.readOnly)).toBe(true);
  expect(el.textContent).not.toContain(w.changeOnComputer);
});
