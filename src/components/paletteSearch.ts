export type Searchable = { label: string; group: string; keywords?: readonly string[] };

/** Lower is better; null means no match. Exact label, then label prefix, then word prefix, then anywhere. */
export function paletteScore(item: Searchable, query: string): number | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;
  const label = item.label.toLowerCase();
  if (label === needle) return 0;
  if (label.startsWith(needle)) return 1;
  if (label.split(/[\s&/·,-]+/).some((word) => word.startsWith(needle))) return 2;
  if (label.includes(needle)) return 3;
  if (item.keywords?.some((keyword) => keyword.toLowerCase().startsWith(needle))) return 4;
  if (item.keywords?.some((keyword) => keyword.toLowerCase().includes(needle))) return 5;
  if (item.group.toLowerCase().includes(needle)) return 6;
  return null;
}

/** Matching items, best first; ties keep their original order so pages stay in menu order. */
export function rankPalette<T extends Searchable>(items: readonly T[], query: string): T[] {
  return items
    .map((item, position) => ({ item, position, score: paletteScore(item, query) }))
    .filter((entry): entry is { item: T; position: number; score: number } => entry.score !== null)
    .sort((a, b) => a.score - b.score || a.position - b.position)
    .map((entry) => entry.item);
}
