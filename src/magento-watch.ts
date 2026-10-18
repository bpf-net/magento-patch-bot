/**
 * Klient API magento.watch (niezależny, społecznościowy tracker — nie Adobe).
 * Docs: https://magento.watch/api
 *
 * Schemat /security-bulletins nie jest formalnie udokumentowany, dlatego parsowanie
 * jest defensywne (np. `cves` bywa tablicą stringów albo obiektów, `appliesTo`
 * stringiem albo listą).
 */

export interface WatchCve {
  id: string;
  cvss?: number;
  type?: string;
  impact?: string;
  authenticationRequired?: boolean;
}

export interface WatchBulletin {
  id: string; // "APSB26-153"
  title?: string;
  summary?: string;
  publishedDate?: string; // "2026-10-13"
  severity?: string; // "critical"
  cves: WatchCve[];
  fixedIn: Record<string, string[]>; // dystrybucja → wersje z poprawką, np. {"magento-community": ["2.4.8-p4"]}
  isolatedPatches: { id: string; appliesTo: string[]; url?: string }[];
  references: string[];
}

export const MAGENTO_WATCH_API = "https://magento.watch/api/v1";
export const MAGENTO_WATCH_BULLETIN_PAGE = "https://magento.watch/security";

export async function fetchWatchBulletins(
  apiBase: string = MAGENTO_WATCH_API,
  fetchImpl: typeof fetch = fetch,
): Promise<WatchBulletin[]> {
  const res = await fetchImpl(`${apiBase.replace(/\/$/, "")}/security-bulletins`, {
    headers: {
      Accept: "application/json",
      "User-Agent": "magento-patch-bot/1.0 (+Cloudflare Worker)",
    },
  });
  if (!res.ok) throw new Error(`magento.watch HTTP ${res.status}`);
  const json: unknown = await res.json();
  return normalizeWatchResponse(json);
}

export function normalizeWatchResponse(json: unknown): WatchBulletin[] {
  const root = json as { data?: unknown };
  const data = root?.data ?? json;
  const entries: unknown[] = Array.isArray(data)
    ? data
    : data && typeof data === "object"
      ? Object.entries(data as Record<string, unknown>).map(([k, v]) =>
          v && typeof v === "object" ? { id: k, ...(v as object) } : null,
        )
      : [];

  const out: WatchBulletin[] = [];
  for (const raw of entries) {
    if (!raw || typeof raw !== "object") continue;
    const b = raw as Record<string, unknown>;
    const id = typeof b.id === "string" ? b.id.toUpperCase() : null;
    if (!id || !/^APSB\d{2}-\d+$/.test(id)) continue;
    out.push({
      id,
      title: str(b.title),
      summary: str(b.summary),
      publishedDate: str(b.publishedDate),
      severity: str(b.severity),
      cves: normalizeCves(b.cves),
      fixedIn: normalizeFixedIn(b.fixedIn),
      isolatedPatches: normalizePatches(b.isolatedPatches),
      references: normalizeRefs(b.references),
    });
  }
  return out;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function normalizeCves(v: unknown): WatchCve[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((c): WatchCve | null => {
      if (typeof c === "string") return { id: c };
      if (c && typeof c === "object") {
        const o = c as Record<string, unknown>;
        const id = str(o.id);
        if (!id) return null;
        const cvss = typeof o.cvss === "number" ? o.cvss : Number(o.cvss);
        return {
          id,
          cvss: Number.isFinite(cvss) ? cvss : undefined,
          type: str(o.type),
          impact: str(o.impact),
          authenticationRequired:
            typeof o.authenticationRequired === "boolean" ? o.authenticationRequired : undefined,
        };
      }
      return null;
    })
    .filter((c): c is WatchCve => c !== null);
}

function normalizeFixedIn(v: unknown): Record<string, string[]> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string[]> = {};
  for (const [dist, list] of Object.entries(v as Record<string, unknown>)) {
    const versions = Array.isArray(list)
      ? list.filter((x): x is string => typeof x === "string")
      : typeof list === "string"
        ? [list]
        : [];
    if (versions.length) out[dist] = versions;
  }
  return out;
}

function normalizePatches(v: unknown): WatchBulletin["isolatedPatches"] {
  if (!Array.isArray(v)) return [];
  return v
    .map((p) => {
      if (typeof p === "string") return { id: p, appliesTo: [] };
      if (p && typeof p === "object") {
        const o = p as Record<string, unknown>;
        const id = str(o.id);
        if (!id) return null;
        const appliesTo = Array.isArray(o.appliesTo)
          ? o.appliesTo.filter((x): x is string => typeof x === "string")
          : typeof o.appliesTo === "string"
            ? [o.appliesTo]
            : [];
        return { id, appliesTo, url: str(o.url) };
      }
      return null;
    })
    .filter((p): p is NonNullable<typeof p> => p !== null);
}

function normalizeRefs(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((r) => (typeof r === "string" ? r : r && typeof r === "object" ? str((r as { url?: unknown }).url) : undefined))
    .filter((r): r is string => !!r && /^https?:\/\//.test(r));
}
