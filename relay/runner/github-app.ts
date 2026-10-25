/**
 * Creates Overhand's GitHub App for hosted runs from its manifest (github-app.json), once per relay:
 * `bun relay/runner/github-app.ts [org]` opens a page in your browser with one button, "Create the GitHub App", which
 * posts the manifest to GitHub (under the org, craftly-io by default). GitHub then sends you to the manifest's
 * redirect_url with `?code=…` in the address: within an hour, run
 * `gh api -X POST /app-manifests/<code>/conversions` for the App's id and private key (relay/README.md, Hosted runs).
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const org = process.argv[2] ?? "craftly-io";
if (!/^[A-Za-z0-9-]+$/.test(org)) throw new Error(`not an org login: ${org}`);
const manifest = readFileSync(join(import.meta.dir, "github-app.json"), "utf8");
const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const page = `<!doctype html><meta charset="utf-8"><title>Create Overhand's GitHub App</title>
<form action="https://github.com/organizations/${org}/settings/apps/new" method="post">
<input type="hidden" name="manifest" value="${attr(manifest)}"><button>Create the GitHub App</button></form>`;
const file = join(mkdtempSync(join(tmpdir(), "overhand-app-")), "github-app.html");
writeFileSync(file, page);
Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", file]);
console.log(`Opened ${file}`);
