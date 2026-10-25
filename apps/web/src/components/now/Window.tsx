import type { Model } from "@/app/data";
import { useMapMode } from "@/app/mapMode";
import { AttentionMap } from "@/map/AttentionMap";
import type { WorldId } from "@/map/worlds";

/**
 * The attention map: each project in its place, lit where something needs you, and its own keyboard surface. An
 * optional look, off by default (Settings › You); on Now it sits between the sentence and the two lists.
 * `always` draws it whatever the setting says (the design catalog).
 */
export function MapWindow({ m, world, always = false }: { m: Model; world: WorldId; always?: boolean }) {
  const [mode] = useMapMode();
  if (mode === "off" && !always) return null;
  return (
    <div data-scene-window="" className="relative aspect-square w-full self-center sm:aspect-[16/7]">
      <AttentionMap m={m} world={world} still={mode !== "on"} />
    </div>
  );
}
