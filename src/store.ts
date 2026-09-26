import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TopicStatus } from './process.js';

export interface CardLink {
  threadId: string;
  cardId: string;
  channelId: string;
  createdBy: string;
  phaseId: string | null;
  phaseName: string | null;
  closed: boolean;
}

export interface Topic {
  threadId: string;
  ownerId: string;
  title: string;
  status: TopicStatus;
  openedAt: string;
  destinationAt: string | null;
  front: string | null;
  type: string | null;
  origin: string | null;
  severity: string | null;
}

export interface Report {
  opened: number;
  resolvedInTriage: number;
  rejected: number;
  cards: number;
  pending: number;
  avgHoursToDestination: number | null;
  /** Contagem por campo de classificação (nome do campo na Goalfy → valor → quantidade). */
  byField: Record<string, Record<string, number>>;
}

type Row = Record<string, string | number | null>;
const s = (v: unknown) => (v === null || v === undefined ? null : String(v));

const toLink = (r: Row): CardLink => ({
  threadId: String(r.thread_id),
  cardId: String(r.card_id),
  channelId: String(r.channel_id),
  createdBy: String(r.created_by),
  phaseId: s(r.phase_id),
  phaseName: s(r.phase_name),
  closed: r.closed === 1,
});

const toTopic = (r: Row): Topic => ({
  threadId: String(r.thread_id),
  ownerId: String(r.owner_id),
  title: String(r.title),
  status: r.status as TopicStatus,
  openedAt: String(r.opened_at),
  destinationAt: s(r.destination_at),
  front: s(r.front),
  type: s(r.type),
  origin: s(r.origin),
  severity: s(r.severity),
});

/** Persistência em SQLite (node:sqlite, sem dependências nativas). */
export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;

      -- Vínculo tópico do Discord ↔ card da Goalfy
      CREATE TABLE IF NOT EXISTS card_links (
        thread_id  TEXT PRIMARY KEY,
        card_id    TEXT NOT NULL UNIQUE,
        channel_id TEXT NOT NULL,
        created_by TEXT NOT NULL,
        phase_id   TEXT,
        phase_name TEXT,
        closed     INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );

      -- Comentários da Goalfy já espelhados no Discord
      CREATE TABLE IF NOT EXISTS seen_comments (
        card_id    TEXT NOT NULL,
        comment_id TEXT NOT NULL,
        PRIMARY KEY (card_id, comment_id)
      );

      -- Ciclo de vida dos tópicos de N2/N3 (status + classificação, para indicadores)
      CREATE TABLE IF NOT EXISTS topics (
        thread_id      TEXT PRIMARY KEY,
        owner_id       TEXT NOT NULL,
        title          TEXT NOT NULL,
        status         TEXT NOT NULL DEFAULT 'triage',
        opened_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        destination_at TEXT,
        front          TEXT,
        type           TEXT,
        origin         TEXT,
        severity       TEXT,
        reminded_at    TEXT
      );

      -- Configurações internas do bot (ex.: webhook registrado na Goalfy)
      CREATE TABLE IF NOT EXISTS kv (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    this.migrate();
  }

  private migrate() {
    const cols = (this.db.prepare('PRAGMA table_info(topics)').all() as Row[]).map((c) => String(c.name));
    if (!cols.includes('classification')) this.db.exec('ALTER TABLE topics ADD COLUMN classification TEXT');
  }

  get(key: string): string | undefined {
    const r = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as Row | undefined;
    return r ? String(r.value) : undefined;
  }

  set(key: string, value: string) {
    this.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  // ── Vínculos ──────────────────────────────────────────────────────────────

  link(l: Omit<CardLink, 'closed'>) {
    this.db
      .prepare(
        `INSERT INTO card_links (thread_id, card_id, channel_id, created_by, phase_id, phase_name)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(l.threadId, l.cardId, l.channelId, l.createdBy, l.phaseId, l.phaseName);
  }

  byThread(threadId: string): CardLink | undefined {
    const r = this.db.prepare('SELECT * FROM card_links WHERE thread_id = ?').get(threadId) as Row | undefined;
    return r && toLink(r);
  }

  byCard(cardId: string): CardLink | undefined {
    const r = this.db.prepare('SELECT * FROM card_links WHERE card_id = ?').get(cardId) as Row | undefined;
    return r && toLink(r);
  }

  openLinks(): CardLink[] {
    return (this.db.prepare('SELECT * FROM card_links WHERE closed = 0').all() as Row[]).map(toLink);
  }

  updatePhase(cardId: string, phaseId: string | null, phaseName: string | null, closed: boolean) {
    this.db
      .prepare('UPDATE card_links SET phase_id = ?, phase_name = ?, closed = ? WHERE card_id = ?')
      .run(phaseId, phaseName, closed ? 1 : 0, cardId);
  }

  unlinkThread(threadId: string) {
    this.db.prepare('DELETE FROM card_links WHERE thread_id = ?').run(threadId);
  }

  /** Marca comentários como vistos e retorna só os que eram novos. */
  markSeen(cardId: string, commentIds: string[]): Set<string> {
    const insert = this.db.prepare('INSERT OR IGNORE INTO seen_comments (card_id, comment_id) VALUES (?, ?)');
    const fresh = new Set<string>();
    for (const id of commentIds) {
      if (insert.run(cardId, id).changes > 0) fresh.add(id);
    }
    return fresh;
  }

  // ── Tópicos ───────────────────────────────────────────────────────────────

  openTopic(threadId: string, ownerId: string, title: string) {
    this.db
      .prepare('INSERT OR IGNORE INTO topics (thread_id, owner_id, title) VALUES (?, ?, ?)')
      .run(threadId, ownerId, title);
  }

  topic(threadId: string): Topic | undefined {
    const r = this.db.prepare('SELECT * FROM topics WHERE thread_id = ?').get(threadId) as Row | undefined;
    return r && toTopic(r);
  }

  /** Atualiza o status; o primeiro destino (card/resolvido/não procede) fica registrado. */
  setStatus(threadId: string, status: TopicStatus, isDestination: boolean) {
    this.db
      .prepare(
        `UPDATE topics SET status = ?,
           destination_at = CASE WHEN ? = 1 AND destination_at IS NULL
                                 THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE destination_at END
         WHERE thread_id = ?`,
      )
      .run(status, isDestination ? 1 : 0, threadId);
  }

  /** Classificação escolhida na criação do card (nome do campo → valor), para os indicadores. */
  classify(threadId: string, classification: Record<string, string>) {
    this.db.prepare('UPDATE topics SET classification = ? WHERE thread_id = ?').run(JSON.stringify(classification), threadId);
  }

  /** Tópicos sem destino (regra 8), mais antigos primeiro. */
  pendingTopics(): Topic[] {
    return (
      this.db.prepare('SELECT * FROM topics WHERE destination_at IS NULL ORDER BY opened_at').all() as Row[]
    ).map(toTopic);
  }

  /** Tópicos sem destino há mais de `hours` e não lembrados nesse intervalo. */
  staleTopics(hours: number): Topic[] {
    const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
    return (
      this.db
        .prepare(
          `SELECT * FROM topics
           WHERE destination_at IS NULL AND opened_at < ? AND (reminded_at IS NULL OR reminded_at < ?)
           ORDER BY opened_at`,
        )
        .all(cutoff, cutoff) as Row[]
    ).map(toTopic);
  }

  markReminded(threadIds: string[]) {
    const stmt = this.db.prepare(`UPDATE topics SET reminded_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE thread_id = ?`);
    for (const id of threadIds) stmt.run(id);
  }

  forgetTopic(threadId: string) {
    this.db.prepare('DELETE FROM topics WHERE thread_id = ?').run(threadId);
  }

  /** Indicadores da seção 18, para tópicos abertos desde `sinceIso`. */
  report(sinceIso: string): Report {
    const one = (sql: string) => (this.db.prepare(sql).get(sinceIso) as Row).n as number;
    const byField: Report['byField'] = {};
    const rows = this.db
      .prepare('SELECT classification FROM topics WHERE opened_at >= ? AND classification IS NOT NULL')
      .all(sinceIso) as Row[];
    for (const r of rows) {
      let c: Record<string, string>;
      try {
        c = JSON.parse(String(r.classification)) as Record<string, string>;
      } catch {
        continue;
      }
      for (const [field, value] of Object.entries(c)) {
        const counts = (byField[field] ??= {});
        counts[value] = (counts[value] ?? 0) + 1;
      }
    }
    const avg = this.db
      .prepare(
        `SELECT AVG((julianday(destination_at) - julianday(opened_at)) * 24) AS h
         FROM topics WHERE opened_at >= ? AND destination_at IS NOT NULL`,
      )
      .get(sinceIso) as Row;

    return {
      opened: one('SELECT COUNT(*) AS n FROM topics WHERE opened_at >= ?'),
      resolvedInTriage: one(`SELECT COUNT(*) AS n FROM topics WHERE opened_at >= ? AND status = 'resolved' AND thread_id NOT IN (SELECT thread_id FROM card_links)`),
      rejected: one(`SELECT COUNT(*) AS n FROM topics WHERE opened_at >= ? AND status = 'rejected'`),
      cards: one('SELECT COUNT(*) AS n FROM topics WHERE opened_at >= ? AND thread_id IN (SELECT thread_id FROM card_links)'),
      pending: one('SELECT COUNT(*) AS n FROM topics WHERE opened_at >= ? AND destination_at IS NULL'),
      avgHoursToDestination: avg.h === null ? null : Number(avg.h),
      byField,
    };
  }
}
