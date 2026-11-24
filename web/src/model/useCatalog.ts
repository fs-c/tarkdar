// React glue for the item catalogue.

import { useCallback, useEffect, useState } from "react";
import { type CatalogStatus, loadCatalog } from "./catalog";
import { type ItemCatalog, emptyCatalog } from "./items";

// Item data (names, prices): loaded once per page load from tarkov.dev, cached for a day. Shared
// promise, so StrictMode's double mount doesn't download the feeds twice.
let catalogLoad: ReturnType<typeof loadCatalog> | null = null;

export interface CatalogState {
  catalog: ItemCatalog;
  status: CatalogStatus;
  /** Loads it again (after it failed, or to refresh stale data). */
  reload: () => void;
}

export function useCatalog(): CatalogState {
  const [state, setState] = useState<Omit<CatalogState, "reload">>({
    catalog: emptyCatalog,
    status: { state: "loading", count: 0, fetchedAt: null },
  });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    void (catalogLoad ??= loadCatalog()).then(({ catalog, status }) => {
      if (!live) return;
      if (status.error) console.warn("item data:", status.error);
      setState({ catalog: catalog ?? emptyCatalog, status });
    });
    return () => void (live = false);
  }, [attempt]);
  const reload = useCallback(() => {
    catalogLoad = null;
    setState((s) => ({ ...s, status: { ...s.status, state: "loading" } }));
    setAttempt((a) => a + 1);
  }, []);
  return { ...state, reload };
}
