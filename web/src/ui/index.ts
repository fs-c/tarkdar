// UI primitives. Each styles itself in the "ui" cascade layer, so components can override them
// with a plain class (see styles/global.css).

import selectable from "./selectable.module.css";

export { Button } from "./Button";
export { Chip } from "./Chip";
export { cx } from "./cx";
export { Actions, Note, PanelBody, Section } from "./Panel";
export { Price } from "./Price";
export { Segmented, type SegmentedOption } from "./Segmented";
export { ToggleRow } from "./ToggleRow";

/** Class for a clickable list row; mark the selected one with data-selected. */
export const selectableRow = selectable.selectable!;
