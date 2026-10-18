import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from "cloudflare:workers";
import { type CardData, toCardData } from "./card";
import { deliver, deliverWatchAlert } from "./channels";
import { type Subscription, loadConfig } from "./config";
import { type WatchBulletin, fetchWatchBulletins } from "./magento-watch";
import { type BulletinRecord, type DeliveryStatus, type Env, bulletinKey, loadState, saveState } from "./state";
import { type VersionMatch, matchBulletin } from "./versions";

// Pierwsza próba + 3 ponowne.
const WATCH_RETRY: WorkflowStepConfig = { retries: { limit: 3, delay: "30 minutes", backoff: "constant" }, timeout: "1 minute" };
const TEAMS_RETRY: WorkflowStepConfig = { retries: { limit: 3, delay: "15 minutes", backoff: "constant" }, timeout: "1 minute" };

const PENDING_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_AGE_MS = 120 * 24 * 3600 * 1000;

export type Decision = { send: true; matches: VersionMatch[] } | { send: false; reason: string };

export function decide(card: CardData, sub: Subscription): Decision {
  if (!sub.enabled) return { send: false, reason: "subskrypcja wyłączona" };
  const m = matchBulletin(sub.versions, sub.product, card.fixedIn, card.isolatedPatches, sub.unsupportedLines);
  if (!m.matches) return { send: false, reason: "biuletyn nie dotyczy wersji z subskrypcji" };
  return { send: true, matches: m.details };
}

/** "APSB26-146" → 260146: kolejność wydania (magento.watch zwraca listę od najnowszego). */
const bulletinOrder = (id: string) => {
  const m = /^APSB(\d{2})-(\d+)$/.exec(id);
  return m ? Number(m[1]) * 10_000 + Number(m[2]) : 0;
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Jedno uruchomienie z crona: pobranie z magento.watch → wykrycie nowych biuletynów → wysyłka na Teams.
 * Ponowienia robi Workflows: wyniki udanych kroków są zapamiętane, więc ponawiany jest tylko krok, który zawiódł.
 */
export class CheckWorkflow extends WorkflowEntrypoint<Env> {
  async run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
    const env = this.env;
    const cfg = await step.do("wczytaj konfigurację", () => loadConfig(env.STATE, env.TEAMS_WEBHOOK_URL));
    const subs = cfg.ok ? cfg.config.subscriptions : [];
    const errors: string[] = cfg.ok ? [] : cfg.errors.map((e) => `config: ${e}`);

    let watch: WatchBulletin[];
    try {
      watch = await step.do("pobierz magento.watch", WATCH_RETRY, () => fetchWatchBulletins(env.MAGENTO_WATCH_API || undefined));
    } catch (e) {
      errors.push(`magento.watch: ${message(e)}`);
      const channels = [...new Map(subs.filter((s) => s.enabled).map((s) => [s.channel.url, s.channel])).values()];
      for (const [i, channel] of channels.entries()) {
        try {
          await step.do(`alert magento.watch #${i + 1}`, TEAMS_RETRY, () => deliverWatchAlert(channel, message(e), env));
        } catch (alertError) {
          errors.push(`alert magento.watch #${i + 1}: ${message(alertError)}`);
        }
      }
      await step.do("zapisz wynik", () => finish(env, errors));
      return;
    }

    const records = await step.do("wykryj nowe biuletyny", async () => {
      const state = await loadState(env);
      const now = new Date();
      // Pierwsze udane pobranie wycisza wszystko, co już jest na liście.
      if (!state.initialized) {
        state.seen.push(...watch.map((w) => w.id));
        state.initialized = true;
      }
      const seen = new Set(state.seen);
      for (const w of watch) {
        if (seen.has(w.id)) continue;
        const ts = w.publishedDate ? Date.parse(w.publishedDate) : NaN;
        if (Number.isFinite(ts) && now.getTime() - ts > MAX_AGE_MS) continue;
        const record: BulletinRecord = { card: toCardData(w), detectedAt: now.toISOString(), deliveries: {} };
        await env.STATE.put(bulletinKey(w.id), JSON.stringify(record));
        state.seen.push(w.id);
        if (!state.pending.includes(w.id)) state.pending.push(w.id);
      }
      await saveState(env, state);

      const out: Record<string, BulletinRecord> = {};
      for (const id of state.pending) {
        const record = await env.STATE.get<BulletinRecord>(bulletinKey(id), "json");
        if (record) out[id] = record;
      }
      return out;
    });

    // Brak konfiguracji (albo błędna): biuletyny czekają w kolejce na następne uruchomienie.
    if (!cfg.ok || cfg.source === "none") {
      await step.do("zapisz wynik", () => finish(env, errors));
      return;
    }

    // Wysyłki grupowane po webhooku: różne webhooki równolegle, w obrębie jednego po kolei (zachowana kolejność,
    // brak serii żądań na ten sam adres). Gdy webhook zawiedzie mimo ponowień, reszta czeka na następny cron.
    const byChannel = new Map<string, { id: string; sub: Subscription; matches: VersionMatch[] }[]>();
    for (const [id, record] of Object.entries(records).sort(([a], [b]) => bulletinOrder(a) - bulletinOrder(b))) {
      for (const sub of subs) {
        if (record.deliveries[sub.name]?.status === "sent") continue;
        const d = decide(record.card, sub);
        if (!d.send) {
          record.deliveries[sub.name] = { status: "skipped", at: new Date().toISOString(), attempts: 0, reason: d.reason };
          continue;
        }
        const jobs = byChannel.get(sub.channel.url) ?? [];
        jobs.push({ id, sub, matches: d.matches });
        byChannel.set(sub.channel.url, jobs);
      }
    }

    const failed = new Set<string>();
    await Promise.all(
      [...byChannel.values()].map(async (jobs) => {
        let down: string | undefined;
        for (const { id, sub, matches } of jobs) {
          const record = records[id];
          const prev = record.deliveries[sub.name];
          if (down) {
            record.deliveries[sub.name] = { status: "failed", at: new Date().toISOString(), attempts: prev?.attempts ?? 0, reason: `pominięto — webhook niedostępny: ${down}` };
            failed.add(id);
            continue;
          }
          const attempts = (prev?.attempts ?? 0) + 1;
          try {
            const at = await step.do(`teams ${id} → ${sub.name}`, TEAMS_RETRY, async () => {
              await deliver({ card: record.card, sub, matches }, env);
              return new Date().toISOString();
            });
            record.deliveries[sub.name] = { status: "sent", at, attempts, matches };
          } catch (e) {
            down = message(e);
            const status: DeliveryStatus = { status: "failed", at: new Date().toISOString(), attempts, reason: down };
            record.deliveries[sub.name] = status;
            errors.push(`${id} → ${sub.name}: ${down}`);
            failed.add(id);
          }
        }
      }),
    );

    const stillPending = [...failed].filter((id) => Date.now() - Date.parse(records[id].detectedAt) <= PENDING_TTL_MS);

    await step.do("zapisz wynik", () => finish(env, errors, records, stillPending));
  }
}

async function finish(env: Env, errors: string[], records?: Record<string, BulletinRecord>, pending?: string[]) {
  for (const [id, record] of Object.entries(records ?? {})) await env.STATE.put(bulletinKey(id), JSON.stringify(record));
  const state = await loadState(env);
  if (pending) state.pending = state.pending.filter((id) => pending.includes(id) || !records?.[id]);
  state.lastRun = new Date().toISOString();
  state.lastErrors = errors.slice(0, 30);
  await saveState(env, state);
  if (errors.length) console.log(JSON.stringify({ errors }));
}
