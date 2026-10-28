/** @overhand/core: the ops daemon, its dashboard server and the pieces they're built from. */
export { work } from "./agent";
export { type AccountOrder, accountsFor, claude, loadLocalCode, needsSignIn, noteMcpSignIn } from "./claude";
export { daemon, main } from "./daemon";
export { dashboardState, weekStats } from "./dashboard";
export { applyConfig, CFG, OPS, SRC } from "./env";
export { inbox, parseNewTickets } from "./inbox";
export {
  demandBrief,
  leadAccount,
  leadDir,
  leadInbox,
  leadPrompt,
  lockHolder,
  recordLeadExit,
  restartDelayMin,
  superviseLeads,
} from "./leads";
export { armAll, editPlan, parsePlan, plan, planFile, upsertPlanItem } from "./plan";
export { serveDashboard } from "./server";
export { liveSessions, readableLog } from "./sessions";
export { eventsToday } from "./status/calendar";
export { prChanges } from "./status/index";
export { comment, createTicket, type Query, setLabels, type Ticket, tickets } from "./trackers/index";
export { adfToText } from "./trackers/jira";
