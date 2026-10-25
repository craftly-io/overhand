import { expect, test } from "bun:test";
import { projectScope } from "../src/status/github";

// a newcomer who picked one repo saw Needs you fill with pull requests from the rest of their GitHub account
test("only your projects' PRs count, each under its project: an alias or otherOrgs owner, a tracker repo, a cloned repo", () => {
  const clients = [
    { name: "Honeycrust", aliases: ["honeycrust"], tracker: { kind: "linear" as const, secret: "" }, dir: "honeycrust" },
    { name: "blog", aliases: [], tracker: { kind: "github" as const, repo: "sam/blog" }, dir: "sam" },
    { name: "Fern", aliases: [], dir: "fern" },
  ];
  const repos = (c: { dir: string }) => (c.dir === "fern" ? [{ dir: "/code/fern/app", slug: "Fernway/App" }] : []);
  const project = projectScope(clients, { "craftly-io": "Craftly" }, repos);
  expect(project("Honeycrust/web")).toBe("Honeycrust"); // an alias: every repo of that owner
  expect(project("craftly-io/site")).toBe("Craftly"); // an owner named in otherOrgs
  expect(project("sam/blog")).toBe("blog"); // a project's tracker repo, under the project's name, not "sam"
  expect(project("fernway/app")).toBe("Fern"); // a repo cloned into a project's folder
  expect(project("sam/other-client")).toBeNull(); // the same account's other repos stay off
  expect(project("someone/else")).toBeNull();
});
