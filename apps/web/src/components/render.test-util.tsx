import { afterAll, beforeAll, mock, spyOn } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";

/** The live stream, never connecting: the state stays on its way. Nothing listens, so its listeners are no-ops. */
class StillConnecting implements EventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readonly readyState = 0;
  readonly withCredentials = false;
  readonly url: string;
  onopen: EventSource["onopen"] = null;
  onmessage: EventSource["onmessage"] = null;
  onerror: EventSource["onerror"] = null;
  addEventListener: EventSource["addEventListener"] = () => {};
  removeEventListener: EventSource["removeEventListener"] = () => {};
  dispatchEvent = (): boolean => false;
  constructor(url: string | URL) {
    this.url = String(url);
  }
  close(): void {}
}

/** A browser for this test file: happy-dom, every request in flight for good, the live stream never connecting. */
export function withDom(): void {
  beforeAll(() => {
    GlobalRegistrator.register({ url: "http://localhost:5173/", settings: { handleDisabledFileLoadingAsSuccess: true } });
    // every request stays in flight: the panes are loading for as long as the test looks
    spyOn(globalThis, "fetch").mockImplementation(Object.assign(() => new Promise<Response>(() => {}), { preconnect: fetch.preconnect }));
    globalThis.EventSource = StillConnecting;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(async () => {
    mock.restore(); // the stubbed fetch, and any spy a test left, never reach the next file
    await GlobalRegistrator.unregister();
  });
}

/**
 * Renders `ui` inside the dashboard's providers, the state at 08:00 of the demo night already in (or not yet, with
 * `bare`); a drawer goes inside an open Sheet, as DrawerHost puts it. `answered` are requests already answered (key, data).
 */
export async function render(
  ui: (m: import("@/app/data").Model) => ReactNode,
  bare = false,
  drawer = false,
  answered: [readonly unknown[], unknown][] = [],
): Promise<HTMLElement> {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { STATE_KEY, useModel } = await import("@/app/data");
  const { ThemeProvider } = await import("@/app/theme");
  const { UiProvider } = await import("@/app/ui");
  const { TooltipProvider } = await import("@/components/ui/tooltip");
  const { Sheet } = await import("@/components/ui/sheet");
  const { nightAt } = await import("@/demo/night");
  const { MOMENTS, minutesOf } = await import("@/demo/moments");
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (!bare) qc.setQueryData(STATE_KEY, nightAt(minutesOf(MOMENTS.morning)));
  for (const [key, data] of answered) qc.setQueryData(key, data);
  function WithModel() {
    const m = useModel();
    const body = bare ? ui(undefined as never) : m ? ui(m) : null;
    // a drawer's title needs its Sheet; no SheetContent, so nothing portals away (Radix's portal can't mount when its
    // module loaded before this file's DOM, as it does in the full run)
    return drawer ? <Sheet open>{body}</Sheet> : body;
  }
  document.body.replaceChildren();
  const el = document.createElement("div");
  document.body.append(el);
  const root = createRoot(el);
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <ThemeProvider>
          <TooltipProvider>
            <UiProvider>
              <WithModel />
            </UiProvider>
          </TooltipProvider>
        </ThemeProvider>
      </QueryClientProvider>,
    );
  });
  return document.body;
}
