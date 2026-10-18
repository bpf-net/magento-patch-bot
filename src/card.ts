import { MAGENTO_WATCH_BULLETIN_PAGE, type WatchBulletin, type WatchCve } from "./magento-watch";

/** Dane biuletynu z magento.watch w postaci używanej przez kanały. */
export interface CardData {
  id: string;
  title: string;
  url: string;
  published?: string;
  exploited?: boolean;
  severity?: string;
  impacts?: string;
  cves: WatchCve[];
  fixedIn: Record<string, string[]>;
  isolatedPatches: { id: string; appliesTo: string[]; url?: string }[];
}

export function toCardData(watch: WatchBulletin): CardData {
  let exploited: boolean | undefined;
  if (watch.summary) {
    if (/not aware of any exploit|no exploitation in the wild/i.test(watch.summary)) exploited = false;
    else if (/exploited in the wild|exploitation in the wild|limited attacks/i.test(watch.summary)) exploited = true;
  }

  const impacts = [...new Set(watch.cves.map((c) => c.impact).filter((i): i is string => !!i))].map((i) => i.replace(/-/g, " "));

  return {
    id: watch.id,
    title: watch.title ?? "Security update for Adobe Commerce",
    url: watch.references.find((r) => /\/apsb\d{2}-\d+/i.test(r)) ?? MAGENTO_WATCH_BULLETIN_PAGE,
    published: watch.publishedDate ? formatIsoDate(watch.publishedDate) : undefined,
    exploited,
    severity: watch.severity ? watch.severity[0].toUpperCase() + watch.severity.slice(1) : undefined,
    impacts: impacts.length ? impacts.join(", ") : undefined,
    cves: watch.cves,
    fixedIn: watch.fixedIn,
    isolatedPatches: watch.isolatedPatches,
  };
}

function formatIsoDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}
