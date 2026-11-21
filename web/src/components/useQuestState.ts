import { useMemo } from "react";
import type { RadarState } from "../stream/connection";
import { withoutDuplicateLoot } from "../model/dedupe";
import { type QuestNeed, questItemLabels, questNeeds as readQuestNeeds, withoutUnneededQuestItems } from "../model/quests";

// No quest needs (quests not read): a stable empty map.
const NO_NEEDS: ReadonlyMap<string, readonly QuestNeed[]> = new Map();

const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;

/**
 * Loot cleaned up for display (merged copies, quest items nobody needs left out) and what the started
 * quests need. `filterQuest`: quest items nobody needs are left out of `state`.
 */
export function useQuestState(unfiltered: RadarState, filterQuest: boolean) {
  // Copies of the same loot at the same spot are merged, and quest items nobody needs are left out
  // everywhere (map, list, search), unless all are wanted.
  const deduped = useMemo(() => withoutDuplicateLoot(unfiltered.loot), [unfiltered.loot]);
  // What started quests still need (quest items and ordinary ones): the filter, the "Needed for quests"
  // rule, labels on the map, in the list and details.
  const needs = useMemo(() => readQuestNeeds(unfiltered.quests), [unfiltered.quests]);
  const questLabels = useMemo(() => questItemLabels(needs), [needs]);
  const questNeeds = needs?.items ?? NO_NEEDS;
  // Its own memo: `unfiltered` is new on every players update, and a new loot array there would rebuild
  // every loot row and its rule matches (~30×/s; on Lighthouse renders went from ~25 to ~130 ms).
  const loot = useMemo(() => withoutUnneededQuestItems(deduped, filterQuest ? needs : null), [deduped, filterQuest, needs]);
  const state: RadarState = useMemo(
    () => (loot === unfiltered.loot ? unfiltered : { ...unfiltered, loot }),
    [unfiltered, loot],
  );
  const questInfo = !needs
    ? "quests unknown: all shown"
    : !needs.complete
      ? `${plural(needs.started, "quest")} started, objectives unknown: all shown`
      : `${plural(needs.started, "quest")} started, ${plural(needs.items.size, "item")} needed`;

  return { state, deduped, questLabels, questNeeds, questInfo };
}
