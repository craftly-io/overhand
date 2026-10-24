import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The daemon serves the API; in dev, Vite forwards /api to it. OVERHAND_DAEMON points elsewhere (e.g. a side-by-side daemon).
const daemon = process.env.OVERHAND_DAEMON ?? "http://127.0.0.1:4317";

export default defineConfig({
  // relative asset paths, so the same build also runs as the landing page's demo under /demo/
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // The big drawers (Settings, Sweep, Work/Inbox/Health) and the scene painters load lazily, keeping the first page
  // under the limit.
  // piece.html: one live piece of the dashboard, framed into the public site's pages (src/piece.tsx);
  // glance.html: the menu bar item's popover on a Mac (src/glance.tsx)
  build: {
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        piece: fileURLToPath(new URL("./piece.html", import.meta.url)),
        glance: fileURLToPath(new URL("./glance.html", import.meta.url)),
      },
    },
  },
  server: {
    port: 5173,
    // The daemon only accepts POSTs from its own origin, so the proxy presents requests as coming from it.
    proxy: { "/api": { target: daemon, changeOrigin: true, headers: { origin: daemon } } },
  },
});
