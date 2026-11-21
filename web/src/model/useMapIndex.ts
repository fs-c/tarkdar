// React glue for the map index.

import { useEffect, useState } from "react";
import { type MapEntry, fetchMapIndex } from "./maps";

export function useMapIndex(): MapEntry[] {
  const [index, setIndex] = useState<MapEntry[]>([]);
  useEffect(() => {
    let live = true;
    fetchMapIndex().then(
      (i) => live && setIndex(i),
      (e: unknown) => console.warn("couldn't load the map index", e),
    );
    return () => void (live = false);
  }, []);
  return index;
}
