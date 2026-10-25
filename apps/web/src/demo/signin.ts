/**
 * Add an agent account in the demo: the account is added, and its sign-in shows the command to run in your own
 * terminal (Claude Code's, through Anthropic's own flow; nothing runs here), then counts as signed in a few looks later;
 * its test call answers. GitHub's sign-in shows a sample one-time code and waits. Nothing leaves the page.
 */
let looks = 0;
/** Whether the sign-in being looked at is an account's (GitHub's waits). */
let watching = false;
/** How many looks the demo's sign-in waits before it says signed in (the app looks every 2 seconds). */
const LOOKS = 3;

/** The demo's answer to an account sign-in POST, undefined for any other. */
export function demoSignInPost(url: string, body: Record<string, unknown>): unknown {
  if (url === "/api/accounts/add") return { ok: true, label: typeof body.label === "string" && body.label ? body.label : "claude" };
  if (url === "/api/accounts/login") {
    looks = 0;
    watching = true;
    const account = typeof body.account === "string" && body.account ? body.account : "claude";
    return { ok: true, id: "demo", command: `CLAUDE_CONFIG_DIR=~/.overhand/agent-home/accounts/${account} claude auth login`, local: true };
  }
  // GitHub's sign-in shows its one-time code and the page GitHub asks for it on
  if (url === "/api/github/signin") {
    watching = false;
    return { ok: true, id: "demo", url: "https://github.com/login/device", code: "DEMO-2026" };
  }
  if (url === "/api/accounts/test") return { ok: true, message: "" };
  return undefined;
}

/** Where the demo's sign-in is: an account's waits a few looks, then is signed in; GitHub's waits. */
export const demoSignInState = () => ({ state: watching && ++looks > LOOKS ? "done" : "waiting", why: "" });
