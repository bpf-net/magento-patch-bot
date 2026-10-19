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

/* ---------- Google Chat (Incoming Webhook, cardsV2) ---------- */

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const paragraph = (text: string) => ({ textParagraph: { text } });
const subtle = (text: string) => paragraph(`<font color="#5f6368">${esc(text)}</font>`);

// Google Chat nie koloruje nagłówka karty, więc pilność idzie w osobnej, kolorowej linii.
const LEVEL_NOTE: Record<View["level"], { color: string; text: string } | undefined> = {
  urgent: { color: "#d93025", text: "Aktywnie wykorzystywany w sieci" },
  high: { color: "#e37400", text: "Krytyczny" },
  normal: undefined,
};

export function renderGoogleChat(v: View, cardId: string) {
  const note = LEVEL_NOTE[v.level];
  const sections: unknown[] = [];
  if (note) sections.push({ widgets: [paragraph(`<font color="${note.color}"><b>${note.text}</b></font>`)] });
  if (v.yourVersions.length) sections.push({ header: "Twoje wersje", widgets: [paragraph(v.yourVersions.map(esc).join("<br>"))] });

  const details: unknown[] = v.facts.map((f) => ({ decoratedText: { topLabel: f.title, text: esc(f.value), wrapText: true } }));
  if (v.fixedLine) details.push(subtle(v.fixedLine));
  sections.push({ widgets: details });

  if (v.patches.length) {
    const lines = v.patches.map((p) => (p.url ? `<a href="${esc(p.url)}">${esc(p.text)}</a>` : esc(p.text)));
    sections.push({ header: "Izolowane patche", widgets: [paragraph(lines.join("<br>"))] });
  }
  const footer: unknown[] = [];
  if (v.cveLine) footer.push(subtle(v.cveLine));
  footer.push(subtle(v.footer));
  footer.push(linkButtons(v.links));
  sections.push({ widgets: footer });

  return googleChatMessage(v.headline, v.title, sections, cardId);
}

const linkButtons = (links: View["links"]) => ({
  buttonList: { buttons: links.map((l) => ({ text: l.title, onClick: { openLink: { url: l.url } } })) },
});

function googleChatMessage(title: string, subtitle: string, sections: unknown[], cardId: string) {
  return { cardsV2: [{ cardId, card: { header: { title, subtitle }, sections } }] };
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
  const view = buildView(delivery.card, delivery.sub, delivery.matches);
  const { channel } = delivery.sub;
  const payload = channel.type === "google-chat" ? renderGoogleChat(view, delivery.card.id) : renderTeams(view);
  await post(channel, resolveSecret(channel.url, env)!, payload, fetchImpl);
}

/** Alert o niedostępnym magento.watch — wysyłany po wyczerpaniu ponownych prób pobrania. */
export async function deliverWatchAlert(
  channel: ChannelConfig,
  error: string,
  env: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const title = "⚠️ magento.watch nie odpowiada";
  const text = "Nie udało się pobrać listy biuletynów mimo ponownych prób.";
  const next = "Kolejna próba przy następnym uruchomieniu crona.";
  const links = [{ title: "magento.watch", url: MAGENTO_WATCH_BULLETIN_PAGE }];
  const payload =
    channel.type === "google-chat"
      ? googleChatMessage(title, text, [{ widgets: [subtle(error), subtle(next), linkButtons(links)] }], "magento-watch-alert")
      : teamsMessage(
          [
            {
              type: "Container",
              style: "warning",
              bleed: true,
              items: [{ type: "TextBlock", text: title, weight: "Bolder", size: "Large", wrap: true }],
            },
            { type: "TextBlock", text, wrap: true },
            { type: "TextBlock", text: error, wrap: true, isSubtle: true, size: "Small" },
            { type: "TextBlock", text: next, wrap: true, isSubtle: true, size: "Small" },
          ],
          links,
        );
  await post(channel, resolveSecret(channel.url, env)!, payload, fetchImpl);
}

async function post(channel: ChannelConfig, url: string, payload: unknown, fetchImpl: typeof fetch): Promise<void> {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${channel.type} HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  await res.body?.cancel().catch(() => {});
}
