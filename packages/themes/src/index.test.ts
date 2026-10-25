import { expect, test } from "bun:test";
import { allWorlds, FLAVOUR_KEYS, plainWords, SYSTEM, themeById, themes, type WordKey } from ".";

test("the house world is Instrument (id overhand), and its earlier ids from saved settings still load it", () => {
  for (const id of ["overhand", "plain", null, undefined, "gone"]) expect(themeById(id).id).toBe("overhand");
  expect(themeById("overhand").name).toBe("Instrument");
});

test("every look can be picked, Instrument first; the retired worlds load Instrument", () => {
  for (const id of ["nexus", "legion", "syndicate", "tokenmaxx"]) expect(themeById(id).id).toBe("overhand");
  expect(themes.map((t) => t.id)).toEqual(["overhand", "observatory", "transit", "koi", "catnap"]);
  for (const t of themes) expect(themeById(t.id)).toBe(t);
});

test("every look has a light and a dark set, each with its 12-step ink, so each follows the computer", () => {
  for (const t of allWorlds) {
    expect(t.ink?.length, t.id).toBe(12);
    expect(t.lightInk?.length, t.id).toBe(12);
    expect(t.light.background, t.id).not.toBe(t.tokens.background);
    expect(t.lightHues?.length, t.id).toBe(t.hues.length);
  }
});

test("every world keeps the house's two voices: Atkinson Hyperlegible Next for words and headings, Mono for data", () => {
  expect(SYSTEM.font.name).toEqual({ body: "Atkinson Hyperlegible Next", mono: "Atkinson Hyperlegible Mono" });
  for (const t of allWorlds) {
    expect(t.fonts.display).toStartWith(`"${SYSTEM.font.name.body}"`);
    expect(t.fonts.body).toStartWith(`"${SYSTEM.font.name.body}"`);
    expect(t.fonts.mono).toStartWith(`"${SYSTEM.font.name.mono}"`);
    expect(Object.keys(t.fonts).sort()).toEqual(
      t.fonts.greeting ? ["body", "display", "greeting", "href", "mono"] : ["body", "display", "href", "mono"],
    );
  }
});

test("a world rewords only the flavour lines: every other word is the house's", () => {
  const flavour = new Set<string>(FLAVOUR_KEYS);
  for (const t of allWorlds)
    for (const [k, v] of Object.entries(t.words))
      if (!flavour.has(k)) expect(v, `${t.id} overrides "${k}", which isn't a flavour key`).toBe(plainWords[k as WordKey]);
});
