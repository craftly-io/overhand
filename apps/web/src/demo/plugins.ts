/**
 * The demo's plugins: the shop's site check and a status-page tracker, both approved and on, with nothing to report on
 * the sample morning (Health lists their last runs). Made up, like the night.
 */
import type { PluginState } from "@overhand/contract";

const PIN = "3f9c1a7e5b2d4c6e8a0b1d3f5a7c9e1b3d5f7a9c";

/** The plugins at `now`: the site check last ran 20 minutes ago. */
export const demoPlugins = (now: number): PluginState[] => [
  {
    name: "site-answers",
    version: "1.0.0",
    line: "Checks that shop.example.com answers, and says so when it doesn't.",
    kind: "check",
    hosts: ["shop.example.com"],
    secrets: [],
    granted: [],
    source: "https://example.com/example/overhand-plugins.git",
    pin: PIN,
    everyMin: 30,
    timeoutSec: 20,
    memoryMb: 128,
    state: "on",
    why: "",
    last: { at: now - 20 * 60_000, ok: true, why: "" },
    findings: [{ title: "shop.example.com answers", line: "It answered 200 in 180 ms.", severity: "info", fix: { kind: "rerun" } }],
  },
  {
    name: "status-page",
    version: "0.3.0",
    line: "Tracks the payment provider's status page and reports an outage.",
    kind: "tracker",
    hosts: ["status.example.com"],
    secrets: ["STATUS_TOKEN"],
    granted: ["STATUS_TOKEN"],
    source: "https://example.com/example/status-page.tar.gz",
    pin: "9a1c3e5f7b2d4f6a8c0e2b4d6f8a1c3e5b7d9f2a4c6e8b1d3f5a7c9e2b4d6f8a",
    everyMin: 60,
    timeoutSec: 30,
    memoryMb: 256,
    state: "on",
    why: "",
    last: { at: now - 35 * 60_000, ok: true, why: "" },
    findings: [],
  },
];
