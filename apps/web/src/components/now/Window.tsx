import type { Model } from "@/app/data";
import { useMapMode } from "@/app/mapMode";
import { AttentionMap } from "@/map/AttentionMap";
import type { WorldId } from "@/map/worlds";

/**
 * The attention map in a window: each project in its sector, lit where something needs you, and its own keyboard
 * surface. Now on a computer draws the field instead (FieldHome); this one is the design catalog's, drawn whatever
 * the setting says when `always` is set.
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
