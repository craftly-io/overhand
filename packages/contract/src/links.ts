/**
 * Overhand's addresses, one constant each. Dependency-free, so the installer's worker and the release scripts import
 * this file directly. install.sh, the npm launcher, the site's HTML and the wrangler configs can't import, and spell
 * the same addresses out.
 */

/** The GitHub repository, owner/name. */
export const REPO = "craftly-io/overhand";
/** The repository's web address. */
export const REPO_URL = `https://github.com/${REPO}`;
/** The public site and demo. */
export const SITE = "https://overhand.dev";
/**
 * Browser features no Overhand page uses, turned off on the site and the relay (payment stays: Paddle's checkout may
 * use it). The relay's static files carry the same line in relay/wrangler.jsonc's _headers (a test keeps them equal).
 */
export const PERMISSIONS = "camera=(), microphone=(), geolocation=(), usb=(), serial=(), browsing-topics=()";
/** Who makes Overhand, named once in the site's footer, the legal pages and app.overhand.dev's footer. */
export const COMPANY = "Craftly Oy";
/** Where people write to. */
export const EMAIL = "hello@overhand.dev";
/** The installer: `curl -fsSL INSTALLER | sh`. */
export const INSTALLER = "https://get.overhand.dev";
/** The one line that installs Overhand, as the site, its docs and app.overhand.dev show it. */
export const INSTALL_COMMAND = `curl -fsSL ${INSTALLER} | sh`;
/** The site's step-by-step setup for an agent to follow, as people type it. */
export const SETUP_GUIDE = `${new URL(SITE).host}/setup.md`;
/** The prompt that has your agent install Overhand: the site's "Copy for your agent" and app.overhand.dev's. */
export const SETUP_PROMPT = `Set up Overhand from ${SETUP_GUIDE}. Ask me before each step.`;
/**
 * Release files: `${DOWNLOAD}/latest/<file>` or `${DOWNLOAD}/v1.2.3/<file>`. The installer worker redirects them to
 * REPO's GitHub releases; clients never link those directly, so the files can move without a client update.
 */
export const DOWNLOAD = `${INSTALLER}/download`;
/** The hosted dashboard and its relay (one Worker, one origin: relay/). A daemon or test can point elsewhere with OVERHAND_RELAY_URL. */
export const APP = "https://app.overhand.dev";
/** Overhand's own page on each computer: `http://localhost:LOCAL_PORT` (OVERHAND_PORT moves it). */
export const LOCAL_PORT = 4317;
/** Every origin that serves the hosted dashboard; a page on one of them talks to its daemon over WebRTC. */
export const APP_ORIGINS = [APP, "https://staging-app.overhand.dev", "http://localhost:8790"];
/**
 * The relay's Ed25519 public key (raw, base64url): daemons verify link certificates and entitlement tokens with it.
 * Empty until the owner runs `bun relay/keygen.ts` and pastes the public half here; OVERHAND_RELAY_KEY overrides it.
 */
export const RELAY_PUBLIC_KEY = "OEG2yv-TcaXgNllkRQ3CbSladhA5mBdaFifhcbNjsZE";
