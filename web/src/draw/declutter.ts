// What the map shows when, so it stays readable: the levels of detail labels show from, and in which
// order labels claim their space. Which markers drop out as you zoom out, and whether things show at
// all, is the display rules' (rules/: loose items by value, groups switched off); the list's filters
// hide too; highlights always show.
//
// "Detail" is the projector's level of detail (see Map3D's DETAIL_PX_PER_METRE: 1 ≈ 4 screen px per
// metre).

/** Labels show from these levels of detail on (and then only where there's room). */
export const LABEL_DETAIL = {
  /** Loose items (those whose rules give them a label). */
  items: 2.5,
  containers: 1.5,
};

/** Exfil labels say their status from this level of detail on; below, just the name (the marker's
 *  colour still tells the status). */
export const EXFIL_STATUS_DETAIL = 0.5;

/**
 * Who gets label space first (lower first; within a rank, higher `priority` first). Players and exfils
 * always get a label, at a fixed spot next to their marker (so it doesn't jump about as they move),
 * claiming it before anything else; airdrops always get one too, wherever it fits. The rest only where
 * there's room (quest items too: on some maps there are dozens, piled up when zoomed out).
 */
export const LABEL_RANK = {
  player: 0,
  exfil: 1,
  highlighted: 2,
  questOrAirdrop: 3,
  item: 4,
  container: 5,
} as const;
