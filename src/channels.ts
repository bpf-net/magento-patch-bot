import type { CardData } from "./card";
import { type ChannelConfig, type Subscription, resolveSecret } from "./config";
import { MAGENTO_WATCH_BULLETIN_PAGE } from "./magento-watch";
import { PRODUCT_DIST, PRODUCT_LABEL, type VersionMatch } from "./versions";

/** Wspólny, niezależny od kanału widok wiadomości. */
interface View {
  level: "urgent" | "high" | "normal";
  headline: string;
  title: string;
  facts: { title: string; value: string }[];
  yourVersions: string[];
  fixedLine?: string;
  patches: { text: string; url?: string }[];
  cveLine?: string;
  footer: string;
  links: { title: string; url: string }[];
}

const REASON_TEXT: Record<VersionMatch["reason"], string> = {
  affected: "dotyczy",
  "unsupported-line": "⚠️ linia bez wsparcia",
  unknown: "❔ nie ustalono",
};

export function buildView(d: CardData, sub: Subscription, matches: VersionMatch[]): View {
  const urgent = d.exploited === true;
  const maxCvss = d.cves.reduce((m, c) => (c.cvss !== undefined && c.cvss > m ? c.cvss : m), -1);
  const unauth = d.cves.filter((c) => c.authenticationRequired === false).length;

  const facts: View["facts"] = [];
  if (d.published) facts.push({ title: "Opublikowano", value: d.published });
  if (d.severity) facts.push({ title: "Severity", value: d.severity });
  facts.push({
    title: "Exploit w sieci",
    value: d.exploited === true ? "⚠️ TAK — aktywnie wykorzystywany" : d.exploited === false ? "Nie" : "brak danych",
  });
  if (d.cves.length) {
    let v = `${d.cves.length}`;
    if (maxCvss >= 0) v += ` · max CVSS ${maxCvss.toFixed(1)}`;
    if (unauth) v += ` · ${unauth} bez uwierzytelnienia`;
    facts.push({ title: "CVE", value: v });
  }
  if (d.impacts) facts.push({ title: "Skutki", value: d.impacts });

  const productLabel = PRODUCT_LABEL[sub.product];
  const fixed = d.fixedIn[PRODUCT_DIST[sub.product]];
  const topCves = [...d.cves].sort((a, b) => (b.cvss ?? 0) - (a.cvss ?? 0)).slice(0, 5);

  return {
    level: urgent ? "urgent" : d.severity?.toLowerCase() === "critical" ? "high" : "normal",
    headline: `${urgent ? "🚨" : "🛡️"} ${d.id}${d.severity ? ` · ${d.severity}` : ""}`,
    title: d.title,
    facts,
    yourVersions: matches.map((m) => `${m.version}: ${REASON_TEXT[m.reason]} (${m.detail})`),
    fixedLine: fixed?.length ? `Poprawka (${productLabel}): ${fixed.join(", ")}` : undefined,
    patches: d.isolatedPatches.slice(0, 5).map((p) => ({
      text: `${p.id}${p.appliesTo.length ? ` (${p.appliesTo.join(", ")})` : ""}`,
      url: p.url,
    })),
    cveLine: topCves.length
      ? topCves.map((c) => `${c.id}${c.cvss !== undefined ? ` (${c.cvss})` : ""}`).join(" · ") +
        (d.cves.length > topCves.length ? ` · +${d.cves.length - topCves.length}` : "")
      : undefined,
    footer: `Subskrypcja: ${sub.name} · źródło: magento.watch`,
    links: [
      { title: "Biuletyn", url: d.url },
      ...(d.url !== MAGENTO_WATCH_BULLETIN_PAGE ? [{ title: "magento.watch", url: MAGENTO_WATCH_BULLETIN_PAGE }] : []),
    ],
  };
}

/* ---------- Teams (Workflows webhook, Adaptive Card 1.4) ---------- */

export function renderTeams(v: View) {
  const body: unknown[] = [
    {
      type: "Container",
      style: v.level === "urgent" ? "attention" : v.level === "high" ? "warning" : "emphasis",
      bleed: true,
      items: [
        { type: "TextBlock", text: v.headline, weight: "Bolder", size: "Large", wrap: true },
        { type: "TextBlock", text: v.title, wrap: true, spacing: "Small" },
      ],
    },
  ];
  if (v.yourVersions.length) {
    body.push({ type: "TextBlock", text: "Twoje wersje", weight: "Bolder", spacing: "Medium" });
    body.push({ type: "TextBlock", wrap: true, text: v.yourVersions.map((l) => `- ${l}`).join("\n") });
  }
  body.push({ type: "FactSet", facts: v.facts });
  if (v.fixedLine) body.push({ type: "TextBlock", text: v.fixedLine, wrap: true, isSubtle: true, size: "Small" });
  if (v.patches.length) {
    body.push({ type: "TextBlock", text: "Izolowane patche", weight: "Bolder", spacing: "Medium" });
    body.push({
      type: "TextBlock",
      wrap: true,
      text: v.patches.map((p) => `- ${p.url ? `[${p.text}](${p.url})` : p.text}`).join("\n"),
    });
  }
  if (v.cveLine) body.push({ type: "TextBlock", text: v.cveLine, wrap: true, isSubtle: true, size: "Small", spacing: "Medium" });
  body.push({ type: "TextBlock", text: v.footer, isSubtle: true, size: "Small" });

  return teamsMessage(body, v.links);
}

function teamsMessage(body: unknown[], links: View["links"]) {
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          msteams: { width: "Full" },
          body,
          actions: links.map((l) => ({ type: "Action.OpenUrl", title: l.title, url: l.url })),
        },
      },
    ],
  };
}

/* ---------- Wysyłka ---------- */

export interface Delivery {
  card: CardData;
  sub: Subscription;
  matches: VersionMatch[];
}


export async function deliver(
  delivery: Delivery,
  env: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const payload = renderTeams(buildView(delivery.card, delivery.sub, delivery.matches));
  await postTeams(resolveSecret(delivery.sub.channel.url, env)!, payload, fetchImpl);
}

/** Alert o niedostępnym magento.watch — wysyłany po wyczerpaniu ponownych prób pobrania. */
export async function deliverWatchAlert(
  channel: ChannelConfig,
  error: string,
  env: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const payload = teamsMessage(
    [
      {
        type: "Container",
        style: "warning",
        bleed: true,
        items: [{ type: "TextBlock", text: "⚠️ magento.watch nie odpowiada", weight: "Bolder", size: "Large", wrap: true }],
      },
      { type: "TextBlock", text: "Nie udało się pobrać listy biuletynów mimo ponownych prób.", wrap: true },
      { type: "TextBlock", text: error, wrap: true, isSubtle: true, size: "Small" },
      { type: "TextBlock", text: "Kolejna próba przy następnym uruchomieniu crona.", wrap: true, isSubtle: true, size: "Small" },
    ],
    [{ title: "magento.watch", url: MAGENTO_WATCH_BULLETIN_PAGE }],
  );
  await postTeams(resolveSecret(channel.url, env)!, payload, fetchImpl);
}

async function postTeams(url: string, payload: unknown, fetchImpl: typeof fetch): Promise<void> {
  const res = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`teams HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  await res.body?.cancel().catch(() => {});
}
