import { useEffect, useMemo, useRef, useState } from "react";
import { type Cache, type CacheDef, type Cached, feedCache, readCache, writeCache } from "../model/cache";
import { type Owned, ownedItems, ownedKey } from "../model/owned";
import type { OwnedItem, StashData } from "../model/protocol";
import { isObject } from "../persist/store";
import type { RadarState } from "../stream/connection";

/** The last stash the backend sent (live, not from a recording): what's owned between raids. */
export const STASH_CACHE: CacheDef = { key: "stash", version: 1 };

const isOwnedList = (v: unknown): v is OwnedItem[] =>
  Array.isArray(v) && v.every((o) => isObject(o) && typeof o.tpl === "string" && typeof o.count === "number");

export const isStashData = (v: unknown): v is StashData =>
  isObject(v) && typeof v.profile === "string" && isOwnedList(v.stash) && isOwnedList(v.equipment);

export interface OwnedState {
  /** Null: nothing known (no stash yet, no gear), or the Quests view says not to count it. */
  owned: Owned | null;
  /** The stash in use: the shown raid's, else the last one kept. */
  stash: StashData | null;
  /** When the kept stash was read (ms); null when the shown raid's is used. */
  keptAt: number | null;
}

/**
 * What's owned for the quest needs: the shown state's stash (else the last live one, kept in
 * IndexedDB) and the local player's gear right now. `liveStash`: the live stream's, the only one kept
 * (a recording's is old). `ignore`: owned items don't count (the Quests view's switch).
 */
export function useOwned(state: RadarState, liveStash: StashData | null, ignore: boolean, cache: Cache = feedCache): OwnedState {
  const [kept, setKept] = useState<Cached<StashData> | null>(null);
  useEffect(() => {
    let alive = true;
    void readCache(cache, STASH_CACHE, isStashData).then((c) => alive && c && setKept((k) => k ?? c));
    return () => void (alive = false);
  }, [cache]);
  useEffect(() => {
    if (!liveStash) return;
    const now = Date.now();
    setKept({ fetchedAt: now, data: liveStash });
    void writeCache(cache, STASH_CACHE, liveStash, now);
  }, [liveStash, cache]);

  const stash = state.stash ?? kept?.data ?? null;
  const local = state.players.find((p) => p.local);
  const gear = local ? state.equipment.get(local.id)?.slots : undefined;
  const computed = useMemo(() => (ignore ? null : ownedItems(stash, gear)), [ignore, stash, gear]);
  // The equipment is re-sent whenever anyone's changes: keep the same Owned while ours is the same,
  // so the quest needs (and every row) aren't rebuilt for nothing.
  const last = useRef<{ key: string; owned: Owned | null }>({ key: "", owned: null });
  const key = ownedKey(computed);
  if (key !== last.current.key) last.current = { key, owned: computed };
  return { owned: last.current.owned, stash, keptAt: state.stash ? null : (kept?.fetchedAt ?? null) };
}
