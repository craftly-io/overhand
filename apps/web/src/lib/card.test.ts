import { expect, test } from "bun:test";
import type { Summary } from "@overhand/contract";
import { plainWords, worldById } from "@overhand/themes";
import { cardContent, cardMarkdown, PRIVATE, privacyFilter, repoOf } from "./card";

const item = (project: string, key: string, title: string, repo: string, n: number) => ({
  project,
  key,
  title,
  url: `https://github.com/${repo}/pull/${n}`,
});

const night: Summary = {
  span: "night",
  from: 0,
  to: 1,
  shipped: [
    item("Honeycrust", "HONEY-12", "Fix the checkout total", "honeycrust/shop", 4),
    item("Honeycrust", "HONEY-13", "Retry webhooks", "honeycrust/shop", 5),
    item("Fernway", "FERN-88", "Export bookings as CSV", "fernway/booking", 9),
    item("Fernway", "FERN-90", "Cache slots", "fernway/booking", 10),
  ],
  opened: [item("Fernway", "FERN-91", "Dark mode", "fernway/booking", 11)],
  review: [item("Fernway", "FERN-91", "Dark mode", "fernway/booking", 11)],
  blocked: [],
  next: [{ project: "Honeycrust", key: "HONEY-14", title: "Gift cards", url: "" }],
  spend: { Honeycrust: 4.1, Fernway: 2.1 },
  guides: [],
};

const PRIVATE_BITS = ["Honeycrust", "Fernway", "HONEY", "FERN", "checkout", "Export", "honeycrust/shop", "fernway/booking", "$", "6.20"];

test("by default the card holds counts only: no project, key, title, repo or money", () => {
  const c = cardContent(night, plainWords, PRIVATE);
  expect(c.headline).toBe("4 pull requests shipped overnight");
  expect(c.sub).toBe("0 needed me");
  expect(c.stats).toEqual(["1 opened", "1 in review", "1 queued"]);
  expect(c.details).toEqual([]);
  const all = JSON.stringify(c) + cardMarkdown(c);
  for (const bit of PRIVATE_BITS) expect(all.includes(bit), bit).toBe(false);
});

test("the privacy filter strips every private field, whatever the theme draws later", () => {
  const f = privacyFilter(night, PRIVATE);
  for (const list of [f.shipped, f.opened, f.review, f.blocked, f.next])
    for (const x of list) expect(x).toEqual({ project: "", key: "", title: "", url: "" });
  expect(f.spend).toEqual({});
  for (const bit of PRIVATE_BITS.filter((b) => b !== "$")) expect(JSON.stringify(f).includes(bit), bit).toBe(false);
});

test("each switch lets through only its own thing", () => {
  const money = cardContent(night, plainWords, { ...PRIVATE, money: true });
  expect(money.sub).toBe("0 needed me · $6.20 billed");
  expect(money.details).toEqual([]);
  const projects = cardContent(night, plainWords, { ...PRIVATE, projects: true });
  expect(projects.details).toEqual(["Honeycrust, Fernway", "HONEY-12", "HONEY-13", "FERN-88"]);
  const titles = cardContent(night, plainWords, { ...PRIVATE, titles: true });
  expect(titles.details).toEqual(["Fix the checkout total", "Retry webhooks", "Export bookings as CSV"]);
  expect(JSON.stringify(titles).includes("HONEY")).toBe(false);
  const repos = cardContent(night, plainWords, { ...PRIVATE, repos: true });
  expect(repos.details).toEqual(["honeycrust/shop, fernway/booking"]);
});

test("the card says the same words in every world", () => {
  expect(cardContent(night, worldById("catnap").words, PRIVATE).headline).toBe("4 pull requests shipped overnight");
  expect(cardContent({ ...night, span: "week", shipped: night.shipped.slice(0, 1) }, plainWords, PRIVATE).headline).toBe(
    "1 PR shipped this week",
  );
  expect(cardContent({ ...night, shipped: [] }, plainWords, PRIVATE).headline).toBe("Nothing shipped overnight");
});

test("repos come from GitHub and Bitbucket PR links", () => {
  expect(repoOf("https://github.com/acme/web/pull/3")).toBe("acme/web");
  expect(repoOf("https://bitbucket.org/acme/api/pull-requests/7")).toBe("acme/api");
  expect(repoOf("")).toBe("");
});
