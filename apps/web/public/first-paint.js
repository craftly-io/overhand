// Before React mounts: paint light when that's the choice (the house theme or Catnap in light, or Transit, which is
// paper), so light users don't see a dark frame first. A file, not an inline script: app.overhand.dev's
// Content-Security-Policy runs only this origin's script files (relay/src/worker.ts, APP_CSP).
try {
  var t = localStorage.getItem("overhand-theme");
  var a = localStorage.getItem("overhand-appearance") || "system";
  // "plain" is the house theme's id from before, still in saved settings
  // retired worlds (nexus, legion, syndicate, tokenmaxx) load the house theme too
  var house = !t || ["overhand", "plain", "nexus", "legion", "syndicate", "tokenmaxx"].indexOf(t) >= 0;
  var lit = a === "light" || (a === "system" && matchMedia("(prefers-color-scheme: light)").matches);
  var light = t === "transit" || ((house || t === "catnap") && lit);
  if (light) {
    document.documentElement.classList.remove("dark");
    document.documentElement.dataset.appearance = "light";
    document.documentElement.style.background = t === "catnap" ? "#fbf5ea" : t === "transit" ? "#f7f6f1" : "#f3f3f1";
  }
} catch (e) {}
