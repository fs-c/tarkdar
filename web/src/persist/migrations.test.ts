// Every store's stored data of every version it can migrate from, migrated to the current one
// (snapshots). Adding a version: add the version's data to fixtures/<key>.json.

import "../prefs";
import "../list/useListRows";
import "../rules/store";
import { allStores, decode, oldestVersion } from "./store";

const fixtures = import.meta.glob<Record<string, unknown>>("./fixtures/*.json", { eager: true, import: "default" });
const byKey = new Map(Object.entries(fixtures).map(([path, f]) => [path.replace(/^.*\/(.*)\.json$/, "$1"), f]));

describe.each(allStores().map((s) => [s.key, s] as const))("%s", (key, def) => {
  const first = oldestVersion(def);
  const versions = Array.from({ length: def.version - first + 1 }, (_, i) => first + i);

  it.each(versions)("from version %i", (v) => {
    const stored = byKey.get(key)?.[v];
    expect(stored, `fixtures/${key}.json has no version ${v}`).toBeDefined();
    const d = decode(def, JSON.stringify(stored));
    expect(d.error).toBeUndefined();
    expect(d.status).toBe(v === def.version ? "current" : "migrated");
    expect(def.normalize(d.value)).toEqual(d.value); // normalized data stays as it is
    expect(d.value).toMatchSnapshot();
  });
});
