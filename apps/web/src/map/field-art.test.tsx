import { expect, test } from "bun:test";
import { render, withDom } from "@/components/render.test-util";
import { Field } from "./Field";

/**
 * Nothing used to say the field draws each look's world: when Now on a computer became the field (pull request 167) the cats,
 * trains, koi and sky stopped showing there, and no test noticed. Every look but Instrument must bring its ground, a
 * character for each agent and a place for each project; Instrument stays the plain canvas.
 */
withDom();

const WORLDS = ["catnap", "transit", "koi", "observatory"];

async function field(theme: string) {
  localStorage.setItem("overhand-theme", theme);
  const root = document.createElement("div");
  document.body.append(root);
  return render((m) => <Field m={m} still root={root} />);
}

test("every look but Instrument draws its world in the field: ground, a character per agent, a place per project", async () => {
  for (const theme of WORLDS) {
    const el = await field(theme);
    expect(el.querySelectorAll("svg.map-ground").length, `${theme} ground`).toBe(1);
    expect(el.querySelector("svg.map-ground")?.getAttribute("data-world"), theme).toBe(theme);
    expect(el.querySelectorAll("svg.glyph").length, `${theme} characters`).toBeGreaterThan(0);
    expect(el.querySelectorAll("svg.map-hub").length, `${theme} places`).toBeGreaterThan(0);
  }
});

test("Instrument's field is the plain canvas: no ground, no characters, no places", async () => {
  const el = await field("overhand");
  expect(el.querySelector("canvas")).not.toBeNull();
  expect(el.querySelectorAll("svg.map-ground, svg.glyph, svg.map-hub").length).toBe(0);
});
