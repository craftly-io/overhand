/**
 * ponytail: the legacy switch for Claude subscription tokens (`claude-token-<account>`, sent as CLAUDE_CODE_OAUTH_TOKEN),
 * for the one install that predates the two supported setups. Off unless local code in `<config folder>/local-code`
 * exports `subscriptionTokens = true` (`loadLocalCode`); Overhand never offers, stores or documents it. With it off, no
 * code path reads a token: runs (`subscriptionToken`) and doctor (`secretsOf`, `checks`) only look while it's on.
 * Removal plan: once that install's accounts have signed in (Settings → Agents → Sign in to Claude Code) and the
 * plugin is deleted, remove this file and every `subscriptionToken*` import (claude-code.ts, agent-home.ts, setup.ts,
 * claude.ts).
 */

let allowed = false;

/** Turns the local opt-in on or off; only `loadLocalCode` calls it. */
export function allowSubscriptionTokens(on: boolean): void {
  allowed = on;
}

/** Whether the local opt-in is on: runs then keep the config folders they used before accounts had their own. */
export const subscriptionTokensAllowed = (): boolean => allowed;

/** The account's stored subscription token when the local opt-in is on; null otherwise, without reading anything. */
export function subscriptionToken(account: string, read: (service: string) => string | null): string | null {
  return allowed ? read(`claude-token-${account}`) : null;
}
