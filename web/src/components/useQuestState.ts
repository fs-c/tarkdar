import { useMemo } from "react";
import type { RadarState } from "../stream/connection";
import { withoutDuplicateLoot } from "../model/dedupe";
import type { QuestPrefs } from "../persist/prefs";
import type { Owned } from "../model/owned";
import { type QuestNeed, isOpen, questItemLabels, questNeeds as readQuestNeeds, withoutUnneededQuestItems } from "../model/quests";

// No quest needs (quests not read): a stable empty map.
const NO_NEEDS: ReadonlyMap<string, readonly QuestNeed[]> = new Map();

const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;

/**
 * Loot cleaned up for display (merged copies, quest items nobody needs left out) and what the started
 * quests need. `filterQuest`: quest items nobody needs are left out of `state`. `questPrefs`: which
 * quests count, and the imported ones (the Quests view). `owned`: what the player has (useOwned): it
 * covers needs, which then aren't needed any more.
 */
export function useQuestState(unfiltered: RadarState, filterQuest: boolean, questPrefs: QuestPrefs, owned: Owned | null = null) {
  // Copies of the same loot at the same spot are merged, and quest items nobody needs are left out
  // everywhere (map, list, search), unless all are wanted.
  const deduped = useMemo(() => withoutDuplicateLoot(unfiltered.loot), [unfiltered.loot]);
  // What started quests still need (quest items and ordinary ones): the filter, the "Needed for quests"
  // rule, labels on the map, in the list and details.
  // Quests that don't count need nothing; imported ones count as if started.
  const { ignored, ignoredKinds, imported } = questPrefs;
  const counting = useMemo(() => ({ ignored: new Set(ignored), ignoredKinds: new Set(ignoredKinds), imported }), [ignored, ignoredKinds, imported]);
  const needs = useMemo(() => readQuestNeeds(unfiltered.quests, counting, owned), [unfiltered.quests, counting, owned]);
  const questLabels = useMemo(() => questItemLabels(needs), [needs]);
  const questNeeds = needs?.items ?? NO_NEEDS;
  // Its own memo: `unfiltered` is new on every players update, and a new loot array there would rebuild
  // every loot row and its rule matches (~30×/s; on Lighthouse renders went from ~25 to ~130 ms).
  const loot = useMemo(() => withoutUnneededQuestItems(deduped, filterQuest ? needs : null), [deduped, filterQuest, needs]);
  const state: RadarState = useMemo(
    () => (loot === unfiltered.loot ? unfiltered : { ...unfiltered, loot }),
    [unfiltered, loot],
  );
  const neededItems = needs ? [...needs.items.values()].filter((l) => l.some(isOpen)).length : 0;
  const coveredItems = needs ? needs.items.size - neededItems : 0;
  const questInfo = !needs
    ? "quests unknown: all shown"
    : !needs.complete
      ? `${plural(needs.started, "quest")} started, objectives unknown: all shown`
      : `${plural(needs.started, "quest")} started, ${plural(neededItems, "item")} needed${coveredItems ? ` (${coveredItems} more owned already)` : ""}`;

  return { state, deduped, needs, questLabels, questNeeds, questInfo };
}
