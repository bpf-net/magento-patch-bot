import { type Product, PRODUCT_LABEL, isValidVersionSpec } from "./versions";

/**
 * Subskrypcje trzymane w tabeli D1 "subscriptions" (migrations/0001_subscriptions.sql).
 * Zmiana: INSERT/UPDATE/DELETE w konsoli D1 albo `wrangler d1 execute` — bez deployu.
 * Worker tylko je czyta; błędy walidacji widać w GET /status.
 *
 * Zamiast jawnego URL-a w webhook_url można podać "secret:NAZWA" — wartość zostanie wzięta
 * z sekretu Workera o tej nazwie (wrangler secret put NAZWA).
 */

export type ChannelType = "teams" | "google-chat";

export interface ChannelConfig {
  type: ChannelType;
  url: string;
}

export interface Subscription {
  name: string;
  product: Product;
  versions: string[];
  unsupportedLines: boolean;
  enabled: boolean;
  channel: ChannelConfig;
}

export interface BotConfig {
  subscriptions: Subscription[];
}

const PRODUCTS = Object.keys(PRODUCT_LABEL) as Product[];
const CHANNEL_TYPES: ChannelType[] = ["teams", "google-chat"];

/** Wiersz tabeli subscriptions. */
export interface SubscriptionRow {
  name: string;
  product: string;
  versions: string;
  channel: string;
  webhook_url: string;
  unsupported_lines: number;
  enabled: number;
}

export type ParseResult = { ok: true; config: BotConfig } | { ok: false; errors: string[] };

/** Waliduje wiersze tabeli. Zwraca wszystkie błędy naraz. */
export function parseRows(rows: SubscriptionRow[]): ParseResult {
  const errors: string[] = [];
  const subscriptions: Subscription[] = [];
  for (const row of rows) {
    const label = `subscriptions "${row.name}"`;

    const product = row.product as Product;
    if (!PRODUCTS.includes(product)) errors.push(`${label}.product: jedno z ${PRODUCTS.join(", ")}`);

    const versions = String(row.versions ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    if (!versions.length) errors.push(`${label}.versions: niepusta lista po przecinku, np. "2.4.8-p5", "2.4.8-*" lub "*"`);
    for (const v of versions) if (!isValidVersionSpec(v)) errors.push(`${label}.versions: nieznany format "${v}"`);

    const type = (row.channel ?? "teams") as ChannelType;
    if (!CHANNEL_TYPES.includes(type)) errors.push(`${label}.channel: jedno z ${CHANNEL_TYPES.join(", ")}`);

    const url = String(row.webhook_url ?? "").trim();
    if (!(/^https:\/\//.test(url) || /^secret:[A-Z0-9_]+$/i.test(url)))
      errors.push(`${label}.webhook_url: adres https://… albo secret:NAZWA_SEKRETU`);
    else if (type === "google-chat" && url.startsWith("https://") && !url.startsWith("https://chat.googleapis.com/"))
      errors.push(`${label}.webhook_url: webhook Google Chat zaczyna się od https://chat.googleapis.com/`);

    subscriptions.push({
      name: row.name,
      product,
      versions,
      unsupportedLines: row.unsupported_lines !== 0,
      enabled: row.enabled !== 0,
      channel: { type, url },
    });
  }
  return errors.length ? { ok: false, errors } : { ok: true, config: { subscriptions } };
}

/**
 * Wczytuje subskrypcje z D1. Przy pustej tabeli działa jak poprzednia wersja bota:
 * jedna subskrypcja "default" na TEAMS_WEBHOOK_URL, wszystkie wersje Open Source.
 */
export async function loadConfig(
  db: D1Database,
  fallbackTeamsUrl?: string,
): Promise<ParseResult & { source: "d1" | "fallback" | "none" }> {
  const { results } = await db.prepare("SELECT * FROM subscriptions ORDER BY name").all<SubscriptionRow>();
  if (results.length) return { ...parseRows(results), source: "d1" };
  if (!fallbackTeamsUrl) return { ok: true, config: { subscriptions: [] }, source: "none" };
  return {
    ok: true,
    source: "fallback",
    config: {
      subscriptions: [
        {
          name: "default",
          product: "open-source",
          versions: ["*"],
          unsupportedLines: true,
          enabled: true,
          channel: { type: "teams", url: "secret:TEAMS_WEBHOOK_URL" },
        },
      ],
    },
  };
}

/** Podmienia "secret:NAZWA" na wartość sekretu Workera. */
export function resolveSecret(value: string | undefined, env: Record<string, unknown>): string | undefined {
  if (value === undefined) return undefined;
  const m = /^secret:([A-Z0-9_]+)$/i.exec(value);
  if (!m) return value;
  const v = env[m[1]];
  if (typeof v !== "string" || !v) throw new Error(`brak sekretu ${m[1]} (wrangler secret put ${m[1]})`);
  return v;
}

/** Konfiguracja do pokazania przez API — bez jawnych URL-i. */
export function redactConfig(config: BotConfig): unknown {
  const mask = (s?: string) => (s === undefined ? undefined : s.startsWith("secret:") ? s : s.replace(/^(https:\/\/[^/]+).*$/, "$1/…"));
  return {
    subscriptions: config.subscriptions.map((s) => ({
      ...s,
      channel: {
        ...s.channel,
        url: mask(s.channel.url),
      },
    })),
  };
}
