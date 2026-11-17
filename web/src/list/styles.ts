// The rows' styles (the display rules, rules/), for cells that colour themselves like the map does.

import { createContext } from "react";
import type { Style } from "../rules/rules";

export const RowStyles = createContext<ReadonlyMap<string, Style>>(new Map());
