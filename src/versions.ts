/**
 * Porównywanie wersji Magento i dopasowanie subskrypcji do wersji z poprawką podanych przez magento.watch.
 *
 * Obsługiwane formaty:
 *   2.4.8, 2.4.8-p5, 2.4.8-2026-sep (miesięczne poziomy patchy od 2026), 2.4.9-beta1, 2.4.10-alpha1, 2.4.9-rc2
 * Kolejność w obrębie linii: alpha < beta < rc < wydanie < -p1 < … < -pN < -2026-jul < -2026-aug < …
 */

export type Product = "open-source" | "commerce" | "b2b";

export const PRODUCT_LABEL: Record<Product, string> = {
  "open-source": "Magento Open Source",
  commerce: "Adobe Commerce",
  b2b: "Adobe Commerce B2B",
};

/** Klucz dystrybucji w `fixedIn` magento.watch. B2B to rozszerzenie Adobe Commerce. */
export const PRODUCT_DIST: Record<Product, string> = {
  "open-source": "magento-community",
  commerce: "magento-commerce",
  b2b: "magento-commerce",
};

export interface Version {
  raw: string;
  base: [number, number, number];
  rank: number;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

export function parseVersion(input: string): Version | null {
  const raw = input.trim().toLowerCase();
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(raw);
  if (!m) return null;
  const base: [number, number, number] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const suffix = m[4];
  let rank: number;
  if (suffix === undefined) rank = 0;
  else if (/^p(\d+)$/.test(suffix)) rank = Number(suffix.slice(1));
  else if (/^(\d{4})-([a-z]{3})/.test(suffix)) {
    const [, y, mon] = /^(\d{4})-([a-z]{3})/.exec(suffix)!;
    if (!MONTHS[mon]) return null;
    rank = 10_000 + (Number(y) - 2000) * 12 + MONTHS[mon];
  } else if (/^alpha(\d*)$/.test(suffix)) rank = -300 + Number(suffix.slice(5) || 0);
  else if (/^beta(\d*)$/.test(suffix)) rank = -200 + Number(suffix.slice(4) || 0);
  else if (/^rc(\d*)$/.test(suffix)) rank = -100 + Number(suffix.slice(2) || 0);
  else return null;
  return { raw, base, rank };
}

export function compareBase(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) if (a.base[i] !== b.base[i]) return a.base[i] - b.base[i];
  return 0;
}

export function compareVersions(a: Version, b: Version): number {
  return compareBase(a, b) || a.rank - b.rank;
}

const lineOf = (v: Version) => v.base.join(".");

/** Poprawka w jednej linii: wydanie, które ją zawiera, albo patch izolowany nakładany na wersję bazową. */
interface LineFix {
  line: string;
  fixed?: Version;
  patch?: { id: string; base: Version; levelRank?: number };
  text: string;
}

export type MatchReason = "affected" | "unsupported-line" | "unknown";

export interface VersionMatch {
  version: string; // wersja z subskrypcji
  reason: MatchReason;
  detail: string; // np. "< 2.4.8-p4"
}

export interface MatchResult {
  matches: boolean;
  details: VersionMatch[];
}

/** "2026-oct" → ranga miesięcznego poziomu patchy, jak w parseVersion. */
function patchLevelRank(id: string): number | undefined {
  const m = /^(\d{4})-([a-z]{3})$/i.exec(id.trim());
  const mon = m && MONTHS[m[2].toLowerCase()];
  return mon ? 10_000 + (Number(m![1]) - 2000) * 12 + mon : undefined;
}

function collectFixes(
  product: Product,
  fixedIn: Record<string, string[]>,
  patches: { id: string; appliesTo: string[] }[],
): Map<string, LineFix> {
  const fixes = new Map<string, LineFix>();
  for (const raw of fixedIn[PRODUCT_DIST[product]] ?? []) {
    const fixed = parseVersion(raw);
    if (fixed) fixes.set(lineOf(fixed), { line: lineOf(fixed), fixed, text: `poprawka w ${fixed.raw}` });
  }
  // Od 2026 Adobe wydaje poprawki jako patche izolowane (fixedIn puste), bez podziału na dystrybucje.
  for (const p of patches) {
    for (const raw of p.appliesTo) {
      const base = parseVersion(raw);
      if (!base || fixes.has(lineOf(base))) continue;
      fixes.set(lineOf(base), {
        line: lineOf(base),
        patch: { id: p.id, base, levelRank: patchLevelRank(p.id) },
        text: `patch ${p.id} na ${base.raw}`,
      });
    }
  }
  return fixes;
}

function isAffected(v: Version, fix: LineFix): boolean {
  if (fix.fixed) return compareVersions(v, fix.fixed) < 0;
  const { base, levelRank } = fix.patch!;
  if (levelRank !== undefined && v.rank >= 10_000) return v.rank < levelRank;
  return compareVersions(v, base) <= 0;
}

/**
 * Czy biuletyn dotyczy którejś z wersji subskrypcji.
 *
 * @param subVersions wersje z konfiguracji: "2.4.8-p5" (dokładna), "2.4.8-*" (cała linia), "*" (wszystko)
 * @param fixedIn     wersje z poprawką wg magento.watch, per dystrybucja
 * @param patches     patche izolowane i wersje, na które się je nakłada
 * @param unsupportedLines czy powiadamiać o liniach starszych niż wszystkie wymienione w biuletynie
 *        (poprawki dostają tylko wspierane linie; starsze zwykle też są podatne)
 */
export function matchBulletin(
  subVersions: string[],
  product: Product,
  fixedIn: Record<string, string[]>,
  patches: { id: string; appliesTo: string[] }[],
  unsupportedLines = true,
): MatchResult {
  const fixes = collectFixes(product, fixedIn, patches);
  if (fixes.size === 0) {
    // Inna dystrybucja ma poprawki, ta nie — biuletyn jej nie dotyczy.
    if (Object.values(fixedIn).some((l) => l.length)) return { matches: false, details: [] };
    // Brak danych o wersjach: lepiej powiadomić niż przegapić.
    return {
      matches: true,
      details: subVersions.map((v) => ({ version: v, reason: "unknown", detail: "magento.watch nie podaje wersji z poprawką" })),
    };
  }

  const all = [...fixes.values()];
  const minListed = all.reduce((min, f) => {
    const b = f.fixed ?? f.patch!.base;
    return compareBase(b, min) < 0 ? b : min;
  }, all[0].fixed ?? all[0].patch!.base);
  const unsupported = (v: Version) => unsupportedLines && compareBase(v, minListed) < 0;
  const UNSUPPORTED = "linia bez wsparcia — prawdopodobnie podatna, brak poprawki";

  const details: VersionMatch[] = [];
  for (const spec of subVersions) {
    const s = spec.trim();
    if (s === "*") {
      details.push({ version: s, reason: "affected", detail: all.map((f) => f.text).join(", ") });
      continue;
    }
    const lineWildcard = /^(\d+\.\d+\.\d+)-\*$/.exec(s);
    if (lineWildcard) {
      const fix = fixes.get(lineWildcard[1]);
      if (fix) details.push({ version: s, reason: "affected", detail: fix.text });
      else if (unsupported(parseVersion(lineWildcard[1])!)) details.push({ version: s, reason: "unsupported-line", detail: UNSUPPORTED });
      continue;
    }
    const v = parseVersion(s);
    if (!v) continue; // walidacja konfiguracji odrzuca takie wpisy wcześniej
    const fix = fixes.get(lineOf(v));
    if (fix) {
      if (isAffected(v, fix)) details.push({ version: s, reason: "affected", detail: fix.fixed ? `< ${fix.fixed.raw}` : fix.text });
    } else if (unsupported(v)) {
      details.push({ version: s, reason: "unsupported-line", detail: UNSUPPORTED });
    }
  }
  return { matches: details.length > 0, details };
}

/** Walidacja pojedynczego wpisu wersji w konfiguracji. */
export function isValidVersionSpec(spec: string): boolean {
  const s = spec.trim();
  return s === "*" || /^\d+\.\d+\.\d+-\*$/.test(s) || parseVersion(s) !== null;
}
