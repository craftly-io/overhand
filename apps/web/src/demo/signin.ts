/**
 * Add an agent account in the demo: the account is added, its sign-in shows its link (Overhand's agents docs, not a
 * real sign-in) and asks for the code back, and any code signs it in; its test call answers. GitHub's sign-in shows a
 * sample one-time code and waits. Nothing leaves the page but the link you open.
 */
let codeSent = false;

/** The demo's answer to an account sign-in POST, undefined for any other. */
export function demoSignInPost(url: string, body: Record<string, unknown>): unknown {
  if (url === "/api/accounts/add") {
    codeSent = false;
    return { ok: true, label: typeof body.label === "string" && body.label ? body.label : "claude" };
  }
  if (url === "/api/accounts/login") {
    codeSent = false;
    return { ok: true, id: "demo", url: "https://overhand.dev/docs/agents", code: "", asks: true };
  }
  // GitHub's sign-in shows its one-time code and the page GitHub asks for it on
  if (url === "/api/github/signin") return { ok: true, id: "demo", url: "https://github.com/login/device", code: "DEMO-2026", asks: false };
  if (url === "/api/accounts/login/code") {
    codeSent = true;
    return { ok: true };
  }
  if (url === "/api/accounts/test") return { ok: true, message: "" };
  return undefined;
}

/** Where the demo's sign-in is: waiting until a code is sent, then signed in. */
export const demoSignInState = () => ({ state: codeSent ? "done" : "waiting", why: "" });
