# Instrument: Overhand's design system

The house world (`packages/themes/src/overhand`, id `overhand`, shown as Instrument) and every look built on it (Observatory, Transit, Koi Pond, Catnap) share one chrome: palette A, drawn by the `:root[data-chrome="house"]` blocks in `apps/web/src/index.css`, which apply to any theme with an ink scale. A look brings its own ink, its one colour, its map and its greeting face; its panes, glass and controls are the house's, drawn from its ink. Every look has a light and a dark set and follows the computer (or Settings → Look & sound → Appearance). The approved spec is `docs/design/world.html` (licences `docs/design/CREDITS.md`).

## Principles

1. **Ink and paper first.** Every surface, border and quiet text is one step of a 12-step ink scale. Nothing is "a grey". In Instrument the paper is harbour fog, a cool green-grey (`#e3e8e6`), and the night a green-grey near-black (`#0c1110`); the site uses the same scale, so the dashboard and the site read as one system.
2. **One colour, and it means you.** Signal orange (`you`) only ever means "needs you", plus the brand mark. Done is a quiet green, broken a deep crimson. Live is light (brightness, a pulse), not a colour. Projects are named, not coloured.
3. **Instruments, not posters.** Readouts are mono; headings are a display face; the brief and the story read like a page.
4. **Frosted glass in Instrument, hairlines elsewhere.** In Instrument only what floats over content is frosted (the bar, the phone's jump bar, popovers, drawers, toasts); resting panes are solid paper (`#f4f7f6`, at night `#141a19`) with a white edge, an inset highlight and a soft lift, on plain paper (no pattern or glow behind it). Solid panes keep text legible over the moving map and spare an all-day dashboard the cost of blur behind constant animation. Every control is a pill (`house()` in `packages/themes/src/overhand`, the `data-theme="overhand"` block at the end of `apps/web/src/index.css`). The other house worlds keep square panes, a 1px line and the 6px control radius.
5. **Calm by default.** One hot action at a time; what waits on you is the brightest pixel on the screen.

## The mark

Hand over: the work, an outline square in ink 12 (the light ink on dark), and you, the `you-fill` square lifted over it,
up and right by 5/11 of a square. Drawn on a 16-unit grid (squares 11, lift 5, outline 2), in whole pixels up to 64px,
the outline 1/14 of the mark (2px at 28px) and never under 2px, so it thickens at 16px. In the lockup the work square
is one cap height of Atkinson Hyperlegible Next Bold (-0.02em) and stands on the baseline; the gap and the clear space
are one lift. One source: `packages/themes/src/brand.ts`; `bun run brand` writes the favicons, app icons, manifest and
brand kit (`packages/themes/brand`) from it, and `test/brand.test.ts` fails when a file drifts. The catalog's
Foundations page shows all of it, with the do's and don'ts.

## Ink scale

Defined once per world (`ink`, `lightInk`), set on `<html>` as `--ink-1` … `--ink-12` by `ThemeProvider`; `fromInk` (`packages/themes/src/define.ts`) maps the shadcn tokens onto it. Steps 10–12 reach WCAG AA on steps 1–5, and every state colour reaches AA on step 5 (`packages/themes/test/themes.test.ts`). The light scale is harbour fog (paper `#e3e8e6`, ink `#131a18`), shared with the site (`site/public/site.css`); the dark scale is the same family at night. The site follows the computer's light or dark with no toggle: `site/build.ts` writes its `system.css` from `systemSchemeCss()` (day, then `SYSTEM.ink.night`, the night states and `surface.siteNight` under `prefers-color-scheme: dark`), the same values the relay's pages use, and the embedded demo follows along.

| Step | Role | Dark | Light | shadcn token |
| --- | --- | --- | --- | --- |
| 1 | App background | `#0c1110` | `#e3e8e6` | `background`, `primary-foreground` |
| 2 | Subtle background (inset panels, inputs, drawers) | `#101615` | `#ebefed` | |
| 3 | Card (panes) | `#151b1a` | `#f6f8f7` | `card` |
| 4 | Hover, popover, toast | `#1a2120` | `#e7ecea` | `popover`, `muted` |
| 5 | Selected, pressed | `#202826` | `#dbe2df` | `secondary`, `accent` |
| 6 | Subtle border (row dividers) | `#28312f` | `#d0d9d5` | |
| 7 | Border (pane edges, controls) | `#323c39` | `#bfcac5` | `border` |
| 8 | Strong border (hover, inputs) | `#45514e` | `#9eaba6` | `input` |
| 9 | Solid, muted (inactive marks) | `#66736f` | `#84928d` | |
| 10 | Muted text (meta, timestamps) | `#96a29e` | `#4b5854` | `muted-foreground` |
| 11 | Low-contrast text (secondary copy) | `#c2cbc8` | `#303a37` | |
| 12 | High-contrast text, primary fill, focus | `#ecf1ef` | `#131a18` | `foreground`, `primary`, `ring` |

## Colour

| Token | Meaning | Dark | Light |
| --- | --- | --- | --- |
| `you` (also `warn`) | Needs you, as text | `#ff5b1f` | `#a8390a` |
| `you-fill` | Needs you, as a fill: counts, the answer button, the brand mark | `#ff5b1f` | `#ff5b1f` |
| `you-ink` | Text on `you-fill` | `#0c1110` | `#131a18` |
| `ok` | Done, merged, passing | `#6cc490` | `#24653f` |
| `bad` | Broken, failing | `#f2557a` | `#a0153e` |
| `destructive` | Fill behind white text (stop, remove) | `#a0153e` | `#a0153e` |

The colour test (`themes.test.ts`, "you is the only colour that isn't ink or a state") fails a world that brings any other colour: primary and focus are ink, client hues are ink. Each world may pick its own ink and its own one colour (Observatory's comet gold, Koi's lantern gold, Transit's platform orange), never a second.

An alert's colour follows what it is: `broken` alerts are crimson, everything else that waits on you is `you`, information is ink (`apps/web/src/lib/alerts.ts`).

## Type

| Use | Face | Token | Size / weight |
| --- | --- | --- | --- |
| Greeting (a world may set its own face here only), pane titles | Atkinson Hyperlegible Next | `--font-display`, `--font-greeting` | 34px greeting, 19px pane title / 600, tracking -0.02em |
| UI, body, controls, the brief and the story | Atkinson Hyperlegible Next | `--font-body` | 14–15px / 400–500; the story 17px / 400, line height 1.6, ink 11 |
| Readouts, counts, times, ticket keys, the clock | Atkinson Hyperlegible Mono | `--font-mono` | 11–30px / 500, tabular |

- Big numbers take the `readout` class (mono, tracking -0.03em); `h1.readout` is the greeting in the display face. Story paragraphs take `story-text`.
- No all-caps eyebrows, no letter-spaced labels: the house CSS resets `tracking-*` and `uppercase` utilities.
- All fonts are self-hosted under SIL OFL 1.1 (`apps/web/public/fonts/instrument.css`, licences in `apps/web/public/fonts/licenses/`); the dashboard works offline. A world may swap only the display face (Cormorant Garamond for Observatory, Overpass for Transit, Zen Old Mincho for Koi Pond).

## Spacing and radius

- 4px grid: 4, 8, 12, 16, 24, 32. Pane padding 22px on a computer, 18px on a phone (`--space-pane`, `--space-pane-phone`); one 24px gap between panes (`--space-gap`, checked by `bun run shots`); rows 14px tall padding.
- Radius: panes and surfaces 0 (`--radius`). **One corner rule for controls:** every action button (each shadcn `Button` variant and any hand-rolled button) and every input takes `--radius-control`, 6px, in every world and on the site (`site/public`). Full radius (a pill) is only for chips and toggles, plus a person's avatar. No hard-square action buttons. Counts are square.

## Surfaces

A pane is a surface step and a 1px hairline, never a shadow. Inset panels (inputs, the Needs you column, drawers) sit one step below their pane.

| Layer | Surface | Line |
| --- | --- | --- |
| Page | ink 1 | |
| Pane | ink 1 or 3 | ink 7 hairline; a pane header is ruled in ink 12 |
| Inset panel, input, drawer | ink 2 | ink 7 |
| Popover, select menu, toast, dialog | ink 3 | ink 12 hairline |
| Tooltip | ink 12 with ink 1 text | |
| Row divider | | ink 6 |

## Controls

- Buttons: 30px tall, the 6px control radius, 1px ink 12 outline, transparent; primary is an ink 12 fill with ink 1 text; answer (the reply to something that waits on you) is the `you-fill`.
- Toggles are slide switches: a 30×16 slot on the control radius, inset, with a squared thumb that slides; on is an ink 12 thumb.
- Segmented controls: a row of cells in one ink 12 outline, the pressed cell filled ink 12; the outer corners take the control radius, the inner joins are square.
- Counts: square, mono 12px, 22px tall, ink 12 outline; a count of what waits on you is a `you-fill` square.
- Focus: the viewfinder, a 1px ink 12 outline 4px out from the control (no glow, no colour).

## The attention map

Now has one picture: the attention map (`apps/web/src/map`), in the clear centre column under the greeting and the story. You are at the centre, the logo's square: paper while nothing waits, the one orange with your count (the same count as Needs you) and a soft halo when something does. The inner ring is what needs you, the middle ring what's working, the outer ring what's idle or done. Each project owns a sector, named at the rim; a failing project's name is crimson with a short scar mark; merges today are green text under the name, never marks on the dial.

- **Placement** (`map/model.ts`, pure and tested): agents spread evenly across their sector's arc on their ring, stepping in and out when they don't fit. Past 7 agents in a sector the quiet ones gather into a crew (a square count with a dot per state, its words on hover); what waits on you is never gathered. Subagents orbit their parent on hairlines.
- **Motion**: an agent that starts waiting drifts inward over 2.8s, a tether draws to you and an orange arc appears on your rim pointing at it; a merge closes a green ring on the agent, which drifts out. Waiting objects breathe; links to working agents carry a slow pulse. Transform and opacity only.
- **Labels**: what waits on you is always named (in `you`, away from you); everything else, and every note, shows on hover or focus. Labels are sized in CSS px whatever the map's size.
- **Keyboard and screen readers**: every agent and crew is a button (Enter or Space opens it: a lead, a ticket, a review, or the project in Crew); the map is a labelled group whose label is its summary.
- **Budget**: it redraws only when what it shows changes (the model's signature), about 300 SVG nodes for a busy day; a hidden tab pauses it; under reduced motion, or Settings › Look & sound › Still or Off, it is a still frame that shows every state. On a phone (under 480px) it drops the dial ticks, subagent dots and merge captions.
- **Worlds** (`map/world.ts`): a world draws only its ground, your centre, a character per agent and a companion per subagent, and says how its rings look. Palette A holds in every world.

### Worlds

| World | Ink | Its one colour | Headings | Ground | Characters |
| --- | --- | --- | --- | --- | --- |
| Instrument (default, `overhand`) | harbour fog / paper, light or dark | signal orange | Atkinson Hyperlegible Next | a field of light, the square mark | objects: a circle, a rounded square for a lead, a signal light, a progress arc |
| Observatory | night navy, dark only | comet gold | Cormorant Garamond | night sky (GPU: drifting milky way, twinkling stars) | satellites; what needs you is a comet falling toward you |
| Transit | map paper, light only | platform orange | Overpass | a metro map: a line per project from the interchange (you) | trains working, stations idle, ticked when done, lit when waiting |
| Koi Pond | dusk teal, dark only | lantern gold | Zen Old Mincho | water (GPU: slow caustics), lily pads | koi; what needs you rises to the lantern by your stone |
| Catnap | cream / walnut, light or dark (light first) | cats' eyes, amber | Fraunces | a room: planks, sofa, bookshelf, the window's light by day, a lamp at night; the rug is the map, you the armchair | cats: curled asleep when idle, sitting up working, close with lit eyes and a question-mark tail when they need you, a loaf with a green tag when done; kittens are helpers |

The GPU layer (`map/atmosphere.ts`) is one fragment shader on a WebGL2 canvas under the map, at half resolution, at most 8 frames a second while moving, one frame when still, none in a hidden tab; without WebGL2 the world's 2D ground draws instead. Measured on the demo at 1440×900 (headless, motion on, 10 s): main thread 1.7% Instrument, 3.0% Observatory, 2.6% Transit, 3.7% Koi Pond.

Retired: Nexus, Legion, Syndicate and Tokenmaxx. Anyone on one loads Instrument (`themeById` falls back, and the saved choice is rewritten); their words, sounds' trims and data are untouched. The painted scenes are gone: every world is drawn on the attention map.

Type is two voices in every world: Atkinson Hyperlegible Next for every word and heading (weight makes the hierarchy, display sizes track tighter) and Atkinson Hyperlegible Mono for data only (numbers, times, counts, ticket keys, the clock). A world may set one face of its own (`fonts.greeting`) for the big greeting on Now and nothing else; the world column above names it. `bun run shots` fails any element whose computed face is outside that set, mono on words, or the greeting face anywhere but the greeting.

## Layout

Breakpoints: `md` 768, `lg` 1024, `xl` 1280, `2xl` 1536, `3xl` 2200, `4xl` 3200, and `short` (a landscape screen
under 500px tall). The content caps at 3200px, centred; the scene fills the edges. Reading text stops near 72ch. Now
(`apps/web/src/lib/layout.ts`): one column on a phone (two held sideways; on a tablet held upright, today and the day so far two-up), two columns at `lg` (Needs you | window),
three from `xl`, four from `3xl` (Needs you | window | Crew | Work and Health), five from `4xl` (Needs you | today and
the day so far | window | Crew | Work and Health). From `3xl` Work, Crew, Health and Settings dock beside the bridge
as side panels, with no dimming; the bridge reflows into the room left.

## Button hierarchy

Five levels, as `Button` variants (`apps/web/src/components/ui/button.tsx`), drawn per theme in `index.css`:

| Level | Variant | House look | Use | Rule |
| --- | --- | --- | --- | --- |
| Primary | `primary` (the default) | Ink 12 fill, ink 1 text | The single next step on a surface: Start 4 now, Approve and mark ready, Launch, Save | At most one per surface. Starting real agents is primary with a count or object in the label |
| Secondary | `outline` | Transparent, ink 12 hairline and text; hover ink 4 | Anything else that acts: Plan the day, Request changes, Overdrive… | The default for an action that isn't the next step |
| State | `state` | `you` outline and text | Pause and Resume only | `you` means it needs you or changes the agents' state; never Turn off, a cost, or a lead that's asleep |
| Quiet | `ghost`, `link` | No surface, ink 11 text | Navigation and reveal: Log, Open Crew, All 9, Manage accounts | Never for something that changes data |
| Danger | `danger` | Crimson fill, white text | Turn off, Close PR, Stop a running lead, Clean up {size} | Only for stopping or removing, always behind a confirm (or a review like the cleanup list, or Save) |

The confirm dialog's button follows the same rule: danger for stopping or removing, primary for an interruption that loses nothing (Restart, Update).

- The header's one smart action (Plan, Brief, Pause, Resume) is a ghost button; only Pause and Resume take the state colour.
- Selects, inputs, textareas: ink 2 surface, ink 7 border. World, appearance, the map's motion and sound sit together in Settings › Look & sound.
- Focus: the viewfinder (see Controls).
- Counts beside pane titles are square, in the colour of the state they count.

## Places

Five places, one job each. On a computer they're the switcher in the header (theme word, plain word under it); on a phone, below 1024px, they're the five tabs of the bottom bar.

| Place | Job | Holds |
| --- | --- | --- |
| Now | What needs me, and what's the story? | The bridge: Needs you (alerts, lead questions, reviews and Slack in one list; All N opens every item), the story and the world, What matters today, the ribbon and the day so far. On a computer its right wing glances at Crew, Work and Health |
| Work | Where is every ticket? | One pipeline, Planned → Queued → Running → In review → Merged, one card per ticket key, plus Yours. A card opens its ticket, or Review when it has a PR. Start N now is the primary; Overdrive… is secondary |
| Crew | Who is working, on what, under which instructions? | The agent run, leads, ready-made leads, your sessions, places, agent instructions, onboarding guides |
| Health | Is anything broken, and is it worth it? | Systems per client, This week, Spend (every dollar and the daily budget in one block), Agent accounts (usage windows and cooldowns, Manage agent accounts), Guardrails, Status updates, Scorecard |
| Settings | How it's set up and how it looks (everyday switches are in Quick settings) | Projects, Agent accounts, Leads (the one place lead config lives), Schedule & limits, Integrations, Phone, Look & sound, Machine checks, System (update, clean up, restart, turn off), Advanced |

Quick settings (the sliders button beside ⋯) holds the everyday switches, live with no Save, each the same setting Settings shows: Pause new work, I need my laptop (once the daemon has quiet mode), the daily budget, Pace to usage limits (Claude accounts), the scene, sound, and what agents do on each project. Everything else is one link away in Settings.

The actions menu (⋯) holds actions only, never places or switches, in sections: Next (the one primary, or Resume while paused), Today, Run (Overdrive, Clean up disk), then System behind a divider. Its length doesn't grow with leads or themes. The command bar groups the same actions by place.

## Glossary

Overhand is agent-, model- and platform-agnostic, so the plain words are too. One word per meaning, in every surface
(site, installer, setup, dashboard, notifications, CLI, billing, README), and in every world: a world never renames
them.

| Word | Means | Not |
| --- | --- | --- |
| agent | A coding agent (Claude Code, Codex, Gemini CLI, Cursor Agent, OpenCode, Aider), and each copy of it working a ticket | "Claude", "the AI", "agent CLI" (README and Settings field labels only) |
| agent account (account) | One sign-in or API key an agent runs on, with its own limits and spend. Settings → Agent accounts | "AI account", "Claude account" |
| model | What the agent thinks with: Claude, GPT, Gemini, a local model | "backend", "LLM" |
| provider | Where the model comes from: a subscription, an API key, Bedrock, Vertex, a gateway, Ollama | "backend" |
| project | One client or product: its repos, tracker and autonomy | "client" in copy (fine in config) |
| ticket | One piece of work: an issue in GitHub, Linear or Jira | "task", "job" |
| assign an agent | Hand one ticket to an agent now | "hand to agent", "queue", "deploy" |
| lead | A standing agent that owns one job on a project (errors, upgrades) and keeps watching | "godmode", "daemon" |
| plan | Today's plan: what the planner proposes and you arm (Plan the day) | a billing tier ("Pro", "Team") or an AI subscription ("subscription") |
| needs you | Anything waiting on a person: a question, a review, a broken thing | "alerts", "inbox" |
| autonomy | How far a project's agents may go: Plan and warn only, Draft pull requests, Open pull requests | "mode" |
| Overhand | The app on your machine, including its background service, and the window you open ("Open Overhand", "Answer in Overhand", "Overhand › Now"). The site may describe it as "the control room for your coding agents"; docs may say "dashboard" once, as a search word | "orchestrator", "daemon", "ops"; in the interface, "dashboard", "console", "command center" |
| deploy | A production deploy, only | starting agents ("launch", "start") |

A tool's own name appears only where the thing is genuinely that tool's: its sign-in button, a setting only it has
(Claude Code's sign-in folder, Codex's sandbox), the verified-runtimes table, or a sample client in the demo.

## Worlds change the art, not the words

A world changes the art on the map, the ground, motion, one accent material and the greeting's face plus a few flavour
lines. Every UI word is identical in every world: navigation, view names, buttons and actions, labels, statuses,
counts, kickers, toasts, settings, errors, the command bar and Brief me.

1. A world may reword only the keys in `FLAVOUR_KEYS` (`packages/themes/src/words.ts`): the greeting on Now
   (`brHello*`), the story lines it tells when nothing is happening (`brCalm`, `brIdle`), three empty-state lines
   (`calm`, `emptyMine`, `emptyActivity`) and the lead name pool (`castNames`). `packages/themes/src/index.test.ts`
   fails, naming the key, when a world overrides anything else.
2. Flavour lines are short, keep the plain meaning and the same placeholders, and are never needed to understand the
   screen. The house (`overhand`) words are the plain reference.
3. One word, one meaning (`packages/themes/test/words.test.ts`), and "deploy" only ever means a production deploy.
4. A clickable fact in the story underlines on hover; on a touch screen, with no hover, it keeps a faint dotted
   underline. An underline otherwise means a link.
5. A link to more names its destination and count ("Open Work", "All 9"), never a flourish.

## Motion

One vocabulary for every theme. Tokens live on `:root` in `apps/web/src/index.css` (`--m-*`) and, for the few timings JavaScript needs, in `apps/web/src/lib/motion.ts` (`MOTION`). The themed worlds may retint effects (`--m-tint`, default the primary colour; `--m-lock`, default green) but never retime them.

| Token | Value | Use |
| --- | --- | --- |
| `--m-instant` | 120ms | Feedback: hover, press, leave |
| `--m-base` | 240ms | Panels, drawers, list items, indicators |
| `--m-slow` | 480ms | Big moments: lock-on ring, a slot filling, launch |
| `--m-stagger` | 50ms | Between items of a list build (`--i` × stagger) |
| `--m-loop` | 1.6s | Live indicators only (pulse) |
| `--m-handover` | 1.8s | The loader's one cycle, only while the app starts or connects |
| `--m-arrive` | `cubic-bezier(.2,.8,.2,1)` | Anything entering or settling |
| `--m-leave` | `cubic-bezier(.4,0,1,1)` | Anything leaving |
| `--m-spring` | `cubic-bezier(.34,1.56,.64,1)` | The tick of a lock-on only |
| `--m-rise` | 6px | How far an entering item rises |
| `--m-hold` | 2.4s | How long a live piece's focus holds before it settles (the site's pages) |
| `--m-dim` | 0.5 | The opacity the rest of a live piece dims to while its focus holds |
| `--m-lift` | 1.015 | How much the focused card grows (with the tight `--lift-ring` shadow, inside its pane's padding) |
| `--m-zoom` | 1.12 | How far the home page's live window zooms toward Needs you as it scrolls away |

| Pattern | Class / helper | What it does | Reduced motion |
| --- | --- | --- | --- |
| Enter | `.m-enter`; panes in the house theme | Fade in and rise 6px over base, arrive easing | Appears |
| Leave | `.m-leave` | Fade out over instant, leave easing | Disappears |
| List build | `.m-stagger > *` with `--i` (`nth(i)`) | Each child enters `--i` × 50ms after the first | All appear |
| Lock-on | `.m-lockon` with a `.m-tick` inside | A ring contracts onto the mark (slow), then the tick springs in in its state colour | The tick, no ring |
| Count-up | `useCountUp(n)`, tabular numbers | Climbs to the value over 960ms, glides on change | The value |
| Loader | `<Boot>`; `<BrandMark moving>` (`components/Logo.tsx`), `.m-handover` | Your square slides over the work and back on the arrive curve, holding at each end: only while the whole app starts or connects (first load, reaching your computer from the phone, Setup's scan) | The still mark, with its words ("Starting…") written out |
| Skeleton | `Skeleton`, `SkeletonRows` (`components/ui/skeleton.tsx`) | A pane that loads shows grey blocks (ink 6 on paper, ink 5 on dark) in the shape of its content, still, never a spinner (`components/panes.loading.test.tsx` renders every fetching pane; `loading.test.tsx` reads the source) | The same: they never move |
| Focus | `focusOnce(el, root)` (`lib/motion.ts`), its card wearing `.m-ring` | A live piece's one moment, as Web Animations (never the CSS `animation` a card already has, so no entrance replays): the rest dims, the card lifts with a tight `--lift-ring` shadow, its mark locks on and its recommended answer pulses once, over `--m-hold`; then they're cancelled and it stays still | Nothing moves or is marked |
| Pulse | `.m-pulse` | Opacity breathes on the loop clock in steps: live and working only | Still |

Rules:

- Transform and opacity only. Never animate layout (width, height, top, margins); a fill is `scaleX`, a slide is `translateX`.
- Nothing loops except live indicators (pulse) and the loader. An idle status dot is still.
- A live indicator that loops steps (`steps()`, about five changes a second) rather than easing: a smooth infinite animation redraws the screen every frame, scene and glass included, and a step that hasn't changed draws nothing. The house theme, with no glass or glow behind its dots, keeps them eased: there stepping measured dearer.
- Enter uses `backwards` fill so nothing keeps a transform (and a stacking context) after it lands.
- Under `prefers-reduced-motion` every pattern becomes an instant state change carrying the same information; JS checks `reduced()`.
- Copy stays plain; the game feel comes from motion, optional sound (off by default, Settings › Look & sound) and feedback.

The attention map is the one thing that moves without being asked, so it lives on its own, slower clock: drifts take 2.8s, breathing 3.4s, a link's pulse 4.8s, and nothing flashes. Settings › Look & sound sets it to Moving or Still (one frame per change, as under reduced motion).

The onboarding launch sequence uses all of it: a boot line with the loader beside it, a scan that reveals one line every 340ms (≤2.5s, any key or click skips) with a lock-on per confirmed line and a climbing repo count, a loadout of four slots that fill (scaleX) as they lock on or turn amber with one action, and on launch a charge fills the Start button; the page holds until the dashboard's state arrives (never an empty frame), then its panes enter in their `--i` order.

## Do and don't

| Do | Don't |
| --- | --- |
| Pick a surface or text colour from the ink scale | Use a stray hex, `#111` or a tinted near-black |
| Use `you` only for things that wait on you (and the mark) | Use `you` or crimson for decoration or a project |
| Separate layers with an ink step and a hairline | Add a grey drop shadow or round a pane |
| Set numbers in mono | Set running text in mono, or numbers in the story serif |
| Write labels in sentence case | Use all caps or letter-spacing |
| Let the attention map carry the mood | Add glows, gradient text or a second flourish |
| Animate transform and opacity on the motion tokens | Animate layout, or invent a duration |
| Pulse only what is live or working | Loop anything for decoration |
