import { plainWords, type WordKey } from "@overhand/themes";
import { lazy, type ReactNode, Suspense } from "react";
import type { Model } from "@/app/data";
import { useWords } from "@/app/theme";
import { returnFocus, useDock, usePhone, useUi } from "@/app/ui";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { useTeamViewing } from "../team/viewing";
import { LeadDrawer } from "./LeadDrawer";
import { MenuDrawer } from "./MenuDrawer";
import { OverdriveDrawer } from "./OverdriveDrawer";
import { AlertsDrawer, BriefDrawer, NewsDrawer, NotesDrawer, ShutdownDrawer } from "./Simple";
import { TicketDrawer } from "./TicketDrawer";

// the big drawers load when first opened, keeping them out of the first page load
const SettingsDrawer = lazy(() => import("./SettingsDrawer").then((x) => ({ default: x.SettingsDrawer })));
const SweepDrawer = lazy(() => import("./SweepDrawer").then((x) => ({ default: x.SweepDrawer })));
const ViewDrawer = lazy(() => import("./ViewDrawer").then((x) => ({ default: x.ViewDrawer })));
const InstructionsDrawer = lazy(() => import("./InstructionsDrawer").then((x) => ({ default: x.InstructionsDrawer })));
const GuideDrawer = lazy(() => import("./GuideDrawer").then((x) => ({ default: x.GuideDrawer })));
// the card renderer loads only when Share opens
const ShareDrawer = lazy(() => import("../share/ShareDrawer").then((x) => ({ default: x.ShareDrawer })));
const ReviewDrawer = lazy(() => import("./ReviewDrawer").then((x) => ({ default: x.ReviewDrawer })));
const FeedbackDrawer = lazy(() => import("./FeedbackDrawer").then((x) => ({ default: x.FeedbackDrawer })));

/**
 * A drawer's heading: a small kicker line above the title. A themed title (`named`) carries its plain meaning on a
 * line of its own, so a drawer always says what it is.
 */
export function DrawerHead({ kicker, title, named, color }: { kicker: ReactNode; title?: ReactNode; named?: WordKey; color?: string }) {
  const w = useWords();
  const plain = named && w[named] !== plainWords[named] ? plainWords[named] : "";
  const heading = named ? w[named] : title;
  return (
    <SheetHeader className="px-0 pt-0">
      <p className="drawer-kicker text-xs tracking-widest text-primary uppercase" style={color ? { color } : undefined}>
        {kicker}
      </p>
      <SheetTitle className="font-display text-xl leading-snug">{heading}</SheetTitle>
      {plain ? <p className="drawer-plain -mt-1 text-sm text-muted-foreground">{plain}</p> : null}
      <SheetDescription className="sr-only">{kicker}</SheetDescription>
    </SheetHeader>
  );
}

/**
 * Renders whichever drawer is open: from the right on desktop, as a bottom sheet on phones. From `3xl` a view (Work,
 * Agents, Health, Settings) docks beside Now instead: no dimming, Now stays live and clickable beside it.
 */
export function DrawerHost({ m }: { m: Model | undefined }) {
  const ui = useUi();
  const phone = usePhone();
  const dock = useDock();
  const d = ui.drawer;
  const k = d?.kind;
  // with a team, a ticket, review or lead open here shows teammates a quiet dot on it ("Ana has this open")
  useTeamViewing(
    d && (d.kind === "ticket" || d.kind === "review" || d.kind === "lead")
      ? { item: `${d.kind === "review" ? "pr" : d.kind}:${d.key}`, label: d.kind === "review" ? `Review of ${d.key}` : d.key }
      : null,
    Boolean(m?.s.team),
  );
  const wide = k === "settings" || k === "crew" || k === "health" || k === "review" || k === "instructions" || k === "guide";
  let body: ReactNode = null;
  if (d && m) {
    if (d.kind === "ticket") body = <TicketDrawer m={m} ticketKey={d.key} />;
    else if (d.kind === "review") body = <ReviewDrawer m={m} ticketKey={d.key} onPreview={d.preview === true} />;
    else if (d.kind === "lead") body = <LeadDrawer m={m} leadKey={d.key} />;
    else if (d.kind === "brief") body = <BriefDrawer text={d.text} />;
    else if (d.kind === "share") body = <ShareDrawer span={d.span} />;
    else if (d.kind === "shutdown") body = <ShutdownDrawer busy={d.busy} startAgain={d.startAgain} />;
    else if (d.kind === "alerts") body = <AlertsDrawer m={m} />;
    else if (d.kind === "notes") body = <NotesDrawer m={m} />;
    else if (d.kind === "overdrive") body = <OverdriveDrawer m={m} />;
    else if (d.kind === "sweep") body = <SweepDrawer />;
    else if (d.kind === "settings") body = <SettingsDrawer tab={d.tab} project={d.project} />;
    else if (d.kind === "instructions") body = <InstructionsDrawer m={m} project={d.project} />;
    else if (d.kind === "guide") body = <GuideDrawer m={m} project={d.project} />;
    else if (d.kind === "menu") body = <MenuDrawer m={m} />;
    else if (d.kind === "feedback") body = <FeedbackDrawer />;
    else if (d.kind === "news") body = <NewsDrawer />;
    else body = <ViewDrawer m={m} view={d.kind} project={"project" in d ? d.project : undefined} />;
  }
  return (
    <Sheet open={d !== null && m !== undefined} onOpenChange={(open) => !open && ui.closeDrawer()} modal={!dock}>
      <SheetContent
        side={phone ? "bottom" : "right"}
        // docked, a click on Now is work on Now, not a request to close the view
        onInteractOutside={dock ? (e) => e.preventDefault() : undefined}
        // docked, it's part of the room: it's there, without sliding in over Now
        style={dock ? { width: dock, maxWidth: dock, animation: "none" } : undefined}
        // no trigger to return to: closing hands focus back to the control it opened from, not to the page
        onCloseAutoFocus={(e) => {
          if (returnFocus()) e.preventDefault();
        }}
        // a full view opens to read, not to act: focus the drawer itself, not its first button (and that button's tooltip)
        onOpenAutoFocus={(e) => {
          if (
            k !== "alerts" &&
            k !== "work" &&
            k !== "crew" &&
            k !== "health" &&
            k !== "sweep" &&
            k !== "review" &&
            k !== "instructions" &&
            k !== "guide" &&
            k !== "lead"
          )
            return;
          e.preventDefault();
          if (e.currentTarget instanceof HTMLElement) e.currentTarget.focus();
        }}
        className={cn(
          "@container gap-0 overflow-x-hidden overflow-y-auto border-border bg-popover p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))]",
          phone
            ? "max-h-[88dvh] rounded-t-2xl"
            : k === "work"
              ? "w-full sm:max-w-[min(76rem,calc(100vw-4rem))]"
              : wide
                ? "w-full sm:max-w-3xl"
                : "w-full sm:max-w-md",
        )}
      >
        {/* from localhost a lazy drawer arrives in a few milliseconds: nothing to show meanwhile */}
        <Suspense fallback={null}>{body}</Suspense>
      </SheetContent>
    </Sheet>
  );
}
