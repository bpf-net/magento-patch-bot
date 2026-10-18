import { type Product, PRODUCT_LABEL, isValidVersionSpec } from "./versions";

/**
 * Konfiguracja trzymana w KV pod kluczem "config". Jedyny sposób zmiany: edycja wartości klucza
 * w panelu Cloudflare (Workers & Pages → KV → namespace → config) — bez deployu.
 * Worker tylko ją czyta; błędy walidacji widać w GET /status.
 *
 * {
 *   "subscriptions": [
 *     {
 *       "name": "klient-a",
 *       "product": "open-source",            // open-source | commerce | b2b
 *       "versions": ["2.4.8-p5"],            // "2.4.8-p5", "2.4.8-*" (cała linia), "*" (wszystko)
 *       "unsupportedLines": true,             // opcjonalnie: powiadamiaj też o liniach bez wsparcia
 *       "enabled": true,                      // opcjonalnie
 *       "channel": { "type": "teams", "url": "https://…" }
 *     }
 *   ]
 * }
 *
 * Kanały:
 *   { "type": "teams", "url": "…" }  — webhook z Teams Workflows (Adaptive Card)
 *
 * Zamiast jawnego URL-a można podać "secret:NAZWA" — wartość zostanie wzięta
 * z sekretu Workera o tej nazwie (wrangler secret put NAZWA).
 */

export type ChannelType = "teams";

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

export const CONFIG_KEY = "config";
const CHANNEL_TYPES: ChannelType[] = ["teams"];
const PRODUCTS = Object.keys(PRODUCT_LABEL) as Product[];

export type ParseResult = { ok: true; config: BotConfig } | { ok: false; errors: string[] };

/** Waliduje i uzupełnia domyślne wartości. Zwraca wszystkie błędy naraz. */
export function parseConfig(input: unknown): ParseResult {
  const errors: string[] = [];
  const root = input as { subscriptions?: unknown };
  if (!root || typeof root !== "object" || !Array.isArray(root.subscriptions)) {
    return { ok: false, errors: ['oczekiwano obiektu {"subscriptions": [ … ]}'] };
  }

  const names = new Set<string>();
  const subscriptions: Subscription[] = [];
  root.subscriptions.forEach((raw, i) => {
    const at = `subscriptions[${i}]`;
    if (!raw || typeof raw !== "object") return void errors.push(`${at}: oczekiwano obiektu`);
    const s = raw as Record<string, unknown>;

    const name = typeof s.name === "string" && s.name.trim() ? s.name.trim() : null;
    if (!name) errors.push(`${at}.name: wymagana niepusta nazwa`);
    else if (names.has(name)) errors.push(`${at}.name: duplikat "${name}"`);
    else names.add(name);
    const label = name ? `${at} ("${name}")` : at;

    const product = (s.product ?? "open-source") as Product;
    if (!PRODUCTS.includes(product)) errors.push(`${label}.product: jedno z ${PRODUCTS.join(", ")}`);

    const versions = s.versions;
    if (!Array.isArray(versions) || versions.length === 0 || !versions.every((v) => typeof v === "string")) {
      errors.push(`${label}.versions: niepusta lista, np. ["2.4.8-p5"], ["2.4.8-*"] lub ["*"]`);
    } else {
      for (const v of versions) if (!isValidVersionSpec(v)) errors.push(`${label}.versions: nieznany format "${v}"`);
    }

    const ch = s.channel as Record<string, unknown> | undefined;
    if (!ch || typeof ch !== "object") {
      errors.push(`${label}.channel: wymagany obiekt {"type", "url"}`);
    } else {
      if (!CHANNEL_TYPES.includes(ch.type as ChannelType))
        errors.push(`${label}.channel.type: jedno z ${CHANNEL_TYPES.join(", ")}`);
      if (typeof ch.url !== "string" || !(/^https:\/\//.test(ch.url) || /^secret:[A-Z0-9_]+$/i.test(ch.url)))
        errors.push(`${label}.channel.url: adres https://… albo secret:NAZWA_SEKRETU`);
    }

    if (name && ch) {
      subscriptions.push({
        name,
        product,
        versions: (versions as string[]) ?? [],
        unsupportedLines: s.unsupportedLines !== false,
        enabled: s.enabled !== false,
        channel: {
          type: ch.type as ChannelType,
          url: ch.url as string,
        },
      });
    }
  });

  return errors.length ? { ok: false, errors } : { ok: true, config: { subscriptions } };
}

/**
 * Wczytuje konfigurację z KV. Bez klucza "config" działa jak poprzednia wersja bota:
 * jedna subskrypcja "default" na TEAMS_WEBHOOK_URL, wszystkie wersje Open Source.
 */
export async function loadConfig(
  kv: KVNamespace,
  fallbackTeamsUrl?: string,
): Promise<ParseResult & { source: "kv" | "fallback" | "none" }> {
  const raw = await kv.get(CONFIG_KEY);
  if (raw === null) {
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
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return { ok: false, errors: [`config nie jest poprawnym JSON-em: ${(e as Error).message}`], source: "kv" };
  }
  return { ...parseConfig(json), source: "kv" };
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
