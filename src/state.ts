import type { CardData } from "./card";
import type { VersionMatch } from "./versions";

export interface Env {
  STATE: KVNamespace;
  DB: D1Database; // tabela subscriptions
  CHECK: Workflow;
  TEAMS_WEBHOOK_URL?: string; // secret — używany tylko, gdy tabela subscriptions jest pusta
  ADMIN_TOKEN?: string; // secret — chroni endpointy administracyjne
  MAGENTO_WATCH_API?: string;
  [secret: string]: unknown; // sekrety wskazywane w konfiguracji jako "secret:NAZWA"
}

export interface State {
  initialized: boolean;
  seen: string[]; // biuletyny już wykryte (lub wyciszone przy inicjalizacji)
  pending: string[]; // biuletyny, które czekają na doręczenie do subskrypcji
  lastRun?: string;
  lastErrors?: string[];
}

export type DeliveryStatus = {
  status: "sent" | "failed" | "skipped";
  at: string;
  attempts: number; // liczba uruchomień crona, w których próbowano wysłać
  reason?: string;
  matches?: VersionMatch[];
};

export interface BulletinRecord {
  card: CardData;
  detectedAt: string;
  deliveries: Record<string, DeliveryStatus>;
}

const STATE_KEY = "state:v1";
export const bulletinKey = (id: string) => `bulletin:${id}`;
const MAX_SEEN = 1000;

export async function loadState(env: Env): Promise<State> {
  const s = await env.STATE.get<State>(STATE_KEY, "json");
  return { initialized: s?.initialized ?? false, seen: s?.seen ?? [], pending: s?.pending ?? [], lastRun: s?.lastRun, lastErrors: s?.lastErrors };
}

export async function saveState(env: Env, s: State) {
  s.seen = s.seen.slice(-MAX_SEEN);
  await env.STATE.put(STATE_KEY, JSON.stringify(s));
}
