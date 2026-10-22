import Database from 'better-sqlite3';
import type { Candidate, Mode, Voter, VoterSpec, VoterState } from './types.js';

export interface ElectionRow {
  id: string;
  name: string;
  mode: Mode;
  status: 'active' | 'finished';
  createdAt: number;
  finishedAt: number | null;
  resultJson: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS elections(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL,
  created_at INTEGER NOT NULL, finished_at INTEGER, result_json TEXT);
CREATE TABLE IF NOT EXISTS candidates(
  election_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, command TEXT NOT NULL,
  position_order INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active',
  points INTEGER NOT NULL DEFAULT 0, effects_json TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY(election_id, id), UNIQUE(election_id, command));
CREATE TABLE IF NOT EXISTS config(key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, election_id TEXT NOT NULL, dedupe_key TEXT,
  kind TEXT NOT NULL, source TEXT NOT NULL, simulated INTEGER NOT NULL, event_id TEXT, user_id TEXT,
  payload_json TEXT NOT NULL, outcome TEXT, detail TEXT, received_at INTEGER NOT NULL,
  UNIQUE(election_id, dedupe_key));
CREATE TABLE IF NOT EXISTS voters(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, election_id TEXT NOT NULL,
  display_name TEXT NOT NULL, origin TEXT NOT NULL, source_event_key TEXT NOT NULL, user_id TEXT,
  candidate_id TEXT, votes INTEGER NOT NULL, units INTEGER NOT NULL, state TEXT NOT NULL,
  vote_confirmed INTEGER NOT NULL, participation_only INTEGER NOT NULL, simulated INTEGER NOT NULL,
  created_at INTEGER NOT NULL, completed_at INTEGER, failure_reason TEXT);
CREATE INDEX IF NOT EXISTS voters_state ON voters(election_id, state);
CREATE TABLE IF NOT EXISTS votes(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, election_id TEXT NOT NULL, voter_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL, votes INTEGER NOT NULL, gift_units INTEGER NOT NULL, user_id TEXT,
  event_key TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS votes_cand ON votes(election_id, candidate_id, user_id);
CREATE TABLE IF NOT EXISTS gift_log(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, election_id TEXT NOT NULL, event_key TEXT NOT NULL, user_id TEXT,
  gift_key TEXT, gift_name TEXT, units INTEGER NOT NULL, votes INTEGER NOT NULL, combo_key TEXT,
  outcome TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS combo_progress(
  election_id TEXT NOT NULL, combo_key TEXT NOT NULL, counted_units INTEGER NOT NULL, ended INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL, PRIMARY KEY(election_id, combo_key));
CREATE TABLE IF NOT EXISTS like_accumulators(
  election_id TEXT NOT NULL, scope TEXT NOT NULL, balance INTEGER NOT NULL, total_counted INTEGER NOT NULL,
  voters_generated INTEGER NOT NULL, PRIMARY KEY(election_id, scope));
CREATE TABLE IF NOT EXISTS like_window(
  election_id TEXT NOT NULL, candidate_id TEXT NOT NULL, likes INTEGER NOT NULL, PRIMARY KEY(election_id, candidate_id));
CREATE TABLE IF NOT EXISTS like_baseline(election_id TEXT PRIMARY KEY, last_total INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS viewer_choices(
  election_id TEXT NOT NULL, user_id TEXT NOT NULL, candidate_id TEXT NOT NULL, choice_ts INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, PRIMARY KEY(election_id, user_id));
CREATE TABLE IF NOT EXISTS chat_commands(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, election_id TEXT NOT NULL, user_id TEXT, raw TEXT NOT NULL,
  result TEXT NOT NULL, candidate_id TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ranking_snapshots(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, election_id TEXT NOT NULL, created_at INTEGER NOT NULL,
  reason TEXT NOT NULL, ranking_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS error_log(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, level TEXT NOT NULL, component TEXT NOT NULL,
  message TEXT NOT NULL, detail_json TEXT);
CREATE TABLE IF NOT EXISTS connection_log(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, state TEXT NOT NULL, detail TEXT);
`;

export interface PersistenceOptions {
  /** 'NORMAL' (padrão, WAL) ou 'FULL' (fsync a cada commit). */
  synchronous?: 'NORMAL' | 'FULL';
}

/**
 * Camada de persistência (SQLite via better-sqlite3).
 * Todas as gravações do processamento de um evento ocorrem em UMA transação síncrona.
 * O acesso é feito somente por esta classe, o que permite trocar por PostgreSQL depois.
 */
export class PersistenceService {
  readonly db: Database.Database;
  private readonly st = new Map<string, Database.Statement>();

  constructor(path: string, opts: PersistenceOptions = {}) {
    this.db = new Database(path);
    if (path !== ':memory:') this.db.pragma('journal_mode = WAL');
    this.db.pragma(`synchronous = ${opts.synchronous ?? 'NORMAL'}`);
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
  }

  private s(sql: string): Database.Statement {
    let st = this.st.get(sql);
    if (!st) {
      st = this.db.prepare(sql);
      this.st.set(sql, st);
    }
    return st;
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    this.db.close();
  }

  // ---- configuração ----
  loadConfig(): Record<string, unknown> | null {
    const r = this.s('SELECT value_json v FROM config WHERE key=?').get('game') as { v: string } | undefined;
    return r ? JSON.parse(r.v) : null;
  }
  saveConfig(cfg: unknown): void {
    this.s('INSERT INTO config(key,value_json) VALUES(\'game\',?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json').run(JSON.stringify(cfg));
  }

  // ---- eleição / candidatos ----
  findActiveElection(mode: Mode): ElectionRow | null {
    const r = this.s("SELECT * FROM elections WHERE mode=? AND status='active' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(mode) as any;
    return r ? this.mapElection(r) : null;
  }
  getElection(id: string): ElectionRow | null {
    const r = this.s('SELECT * FROM elections WHERE id=?').get(id) as any;
    return r ? this.mapElection(r) : null;
  }
  private mapElection(r: any): ElectionRow {
    return { id: r.id, name: r.name, mode: r.mode, status: r.status, createdAt: r.created_at, finishedAt: r.finished_at, resultJson: r.result_json };
  }
  insertElection(e: { id: string; name: string; mode: Mode; createdAt: number }): void {
    this.s("INSERT INTO elections(id,name,mode,status,created_at) VALUES(?,?,?,'active',?)").run(e.id, e.name, e.mode, e.createdAt);
  }
  finishElection(id: string, finishedAt: number, resultJson: string): void {
    this.s("UPDATE elections SET status='finished', finished_at=?, result_json=? WHERE id=?").run(finishedAt, resultJson, id);
  }
  insertCandidate(electionId: string, c: { id: string; name: string; command: string; order: number }): void {
    this.s('INSERT INTO candidates(election_id,id,name,command,position_order) VALUES(?,?,?,?,?)').run(electionId, c.id, c.name, c.command.toLowerCase(), c.order);
  }
  loadCandidates(electionId: string): Candidate[] {
    const rows = this.s('SELECT * FROM candidates WHERE election_id=? ORDER BY position_order').all(electionId) as any[];
    return rows.map((r) => ({
      id: r.id, name: r.name, command: r.command, order: r.position_order, status: r.status,
      votes: 0, points: r.points, effects: JSON.parse(r.effects_json), supporters: 0, giftUnits: 0, lastVoteSeq: 0, history: [],
    }));
  }
  updateCandidateMeta(electionId: string, id: string, f: { name?: string; points?: number; effects?: string[]; status?: string }): void {
    if (f.name !== undefined) this.s('UPDATE candidates SET name=? WHERE election_id=? AND id=?').run(f.name, electionId, id);
    if (f.points !== undefined) this.s('UPDATE candidates SET points=? WHERE election_id=? AND id=?').run(f.points, electionId, id);
    if (f.effects !== undefined) this.s('UPDATE candidates SET effects_json=? WHERE election_id=? AND id=?').run(JSON.stringify(f.effects), electionId, id);
    if (f.status !== undefined) this.s('UPDATE candidates SET status=? WHERE election_id=? AND id=?').run(f.status, electionId, id);
  }

  // ---- eventos recebidos ----
  /** Retorna o seq do evento, ou null se (election, dedupe_key) já existia. */
  insertEvent(e: { electionId: string; dedupeKey: string | null; kind: string; source: string; simulated: boolean; eventId?: string; userId?: string; payloadJson: string; receivedAt: number }): number | null {
    const r = this.s(
      'INSERT OR IGNORE INTO events(election_id,dedupe_key,kind,source,simulated,event_id,user_id,payload_json,received_at) VALUES(?,?,?,?,?,?,?,?,?)',
    ).run(e.electionId, e.dedupeKey, e.kind, e.source, e.simulated ? 1 : 0, e.eventId ?? null, e.userId ?? null, e.payloadJson, e.receivedAt);
    return r.changes === 0 ? null : Number(r.lastInsertRowid);
  }
  setEventOutcome(seq: number, outcome: string, detail?: string): void {
    this.s('UPDATE events SET outcome=?, detail=? WHERE seq=?').run(outcome, detail ?? null, seq);
  }

  // ---- presentes ----
  getCombo(electionId: string, key: string): number {
    const r = this.s('SELECT counted_units c FROM combo_progress WHERE election_id=? AND combo_key=?').get(electionId, key) as { c: number } | undefined;
    return r?.c ?? 0;
  }
  setCombo(electionId: string, key: string, units: number, ended: boolean, now: number): void {
    this.s(
      `INSERT INTO combo_progress(election_id,combo_key,counted_units,ended,updated_at) VALUES(?,?,?,?,?)
       ON CONFLICT(election_id,combo_key) DO UPDATE SET counted_units=excluded.counted_units, ended=MAX(ended,excluded.ended), updated_at=excluded.updated_at`,
    ).run(electionId, key, units, ended ? 1 : 0, now);
  }
  insertGiftLog(g: { electionId: string; eventKey: string; userId?: string | null; giftKey?: string | null; giftName?: string | null; units: number; votes: number; comboKey?: string | null; outcome: string; createdAt: number }): void {
    this.s('INSERT INTO gift_log(election_id,event_key,user_id,gift_key,gift_name,units,votes,combo_key,outcome,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(g.electionId, g.eventKey, g.userId ?? null, g.giftKey ?? null, g.giftName ?? null, g.units, g.votes, g.comboKey ?? null, g.outcome, g.createdAt);
  }

  // ---- curtidas ----
  getAccumulator(electionId: string, scope: string): { balance: number; totalCounted: number; votersGenerated: number } {
    const r = this.s('SELECT balance,total_counted,voters_generated FROM like_accumulators WHERE election_id=? AND scope=?').get(electionId, scope) as any;
    return r ? { balance: r.balance, totalCounted: r.total_counted, votersGenerated: r.voters_generated } : { balance: 0, totalCounted: 0, votersGenerated: 0 };
  }
  saveAccumulator(electionId: string, scope: string, a: { balance: number; totalCounted: number; votersGenerated: number }): void {
    this.s(
      `INSERT INTO like_accumulators(election_id,scope,balance,total_counted,voters_generated) VALUES(?,?,?,?,?)
       ON CONFLICT(election_id,scope) DO UPDATE SET balance=excluded.balance,total_counted=excluded.total_counted,voters_generated=excluded.voters_generated`,
    ).run(electionId, scope, a.balance, a.totalCounted, a.votersGenerated);
  }
  getLikeBaseline(electionId: string): number | null {
    const r = this.s('SELECT last_total t FROM like_baseline WHERE election_id=?').get(electionId) as { t: number } | undefined;
    return r ? r.t : null;
  }
  setLikeBaseline(electionId: string, total: number): void {
    this.s('INSERT INTO like_baseline(election_id,last_total) VALUES(?,?) ON CONFLICT(election_id) DO UPDATE SET last_total=excluded.last_total').run(electionId, total);
  }
  clearLikeBaseline(electionId: string): void {
    this.s('DELETE FROM like_baseline WHERE election_id=?').run(electionId);
  }
  likeTotals(electionId: string): { counted: number; balance: number; votersGenerated: number } {
    const r = this.s('SELECT COALESCE(SUM(total_counted),0) c, COALESCE(SUM(balance),0) b, COALESCE(SUM(voters_generated),0) v FROM like_accumulators WHERE election_id=?').get(electionId) as any;
    return { counted: r.c, balance: r.b, votersGenerated: r.v };
  }

  // ---- janela de curtidas por candidato (política proportional_choice) ----
  addLikeWindow(electionId: string, candidateId: string, likes: number): void {
    this.s('INSERT INTO like_window(election_id,candidate_id,likes) VALUES(?,?,?) ON CONFLICT(election_id,candidate_id) DO UPDATE SET likes=likes+excluded.likes').run(electionId, candidateId, likes);
  }
  getLikeWindow(electionId: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.s('SELECT candidate_id c, likes l FROM like_window WHERE election_id=? AND likes>0').all(electionId) as any[]) out[r.c] = r.l;
    return out;
  }
  clearLikeWindow(electionId: string): void {
    this.s('DELETE FROM like_window WHERE election_id=?').run(electionId);
  }

  // ---- escolhas e comandos ----
  getChoice(electionId: string, userId: string): { candidateId: string; choiceTs: number } | null {
    const r = this.s('SELECT candidate_id c, choice_ts t FROM viewer_choices WHERE election_id=? AND user_id=?').get(electionId, userId) as any;
    return r ? { candidateId: r.c, choiceTs: r.t } : null;
  }
  setChoice(electionId: string, userId: string, candidateId: string, choiceTs: number, now: number): void {
    this.s(
      `INSERT INTO viewer_choices(election_id,user_id,candidate_id,choice_ts,updated_at) VALUES(?,?,?,?,?)
       ON CONFLICT(election_id,user_id) DO UPDATE SET candidate_id=excluded.candidate_id,choice_ts=excluded.choice_ts,updated_at=excluded.updated_at`,
    ).run(electionId, userId, candidateId, choiceTs, now);
  }
  insertCommand(c: { electionId: string; userId?: string | null; raw: string; result: string; candidateId?: string | null; createdAt: number }): void {
    this.s('INSERT INTO chat_commands(election_id,user_id,raw,result,candidate_id,created_at) VALUES(?,?,?,?,?,?)')
      .run(c.electionId, c.userId ?? null, c.raw.slice(0, 200), c.result, c.candidateId ?? null, c.createdAt);
  }

  // ---- eleitores e votos ----
  insertVoter(v: Voter): void {
    this.s(
      `INSERT INTO voters(id,election_id,display_name,origin,source_event_key,user_id,candidate_id,votes,units,state,vote_confirmed,participation_only,simulated,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(v.id, v.electionId, v.displayName, v.origin, v.sourceEventKey, v.userId, v.candidateId, v.votes, v.units, v.state, v.voteConfirmed ? 1 : 0, v.participationOnly ? 1 : 0, v.simulated ? 1 : 0, v.createdAt);
  }
  insertVote(v: { electionId: string; voterId: string; candidateId: string; votes: number; giftUnits: number; userId: string | null; eventKey: string; createdAt: number }): number {
    return Number(this.s('INSERT INTO votes(election_id,voter_id,candidate_id,votes,gift_units,user_id,event_key,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(v.electionId, v.voterId, v.candidateId, v.votes, v.giftUnits, v.userId, v.eventKey, v.createdAt).lastInsertRowid);
  }
  hasVoteFrom(electionId: string, candidateId: string, userId: string): boolean {
    return !!this.s('SELECT 1 FROM votes WHERE election_id=? AND candidate_id=? AND user_id=? LIMIT 1').get(electionId, candidateId, userId);
  }
  setVoterState(id: string, state: VoterState, now: number | null, failure?: string): void {
    this.s('UPDATE voters SET state=?, completed_at=COALESCE(?,completed_at), failure_reason=COALESCE(?,failure_reason) WHERE id=?').run(state, now, failure ?? null, id);
  }
  setVoterStateMany(ids: string[], state: VoterState, now: number): void {
    this.transaction(() => ids.forEach((id) => this.setVoterState(id, state, now)));
  }
  pendingVoters(electionId: string): Voter[] {
    const rows = this.s("SELECT * FROM voters WHERE election_id=? AND state IN ('queued','approaching','voting') ORDER BY seq").all(electionId) as any[];
    return rows.map((r) => this.mapVoter(r));
  }
  getVoter(id: string): Voter | null {
    const r = this.s('SELECT * FROM voters WHERE id=?').get(id) as any;
    return r ? this.mapVoter(r) : null;
  }
  private mapVoter(r: any): Voter {
    return {
      id: r.id, seq: r.seq, electionId: r.election_id, displayName: r.display_name, origin: r.origin, sourceEventKey: r.source_event_key,
      userId: r.user_id, candidateId: r.candidate_id, votes: r.votes, units: r.units, state: r.state, voteConfirmed: !!r.vote_confirmed,
      participationOnly: !!r.participation_only, createdAt: r.created_at, completedAt: r.completed_at, failureReason: r.failure_reason, simulated: !!r.simulated,
    };
  }

  /** Livro de votos agregado por candidato: fonte da verdade para o ranking. */
  voteLedger(electionId: string): { candidateId: string; votes: number; giftUnits: number; supporters: number; lastSeq: number }[] {
    const rows = this.s(
      `SELECT candidate_id c, SUM(votes) v, SUM(gift_units) g, COUNT(DISTINCT user_id) s, MAX(seq) l FROM votes WHERE election_id=? GROUP BY candidate_id`,
    ).all(electionId) as any[];
    return rows.map((r) => ({ candidateId: r.c, votes: r.v, giftUnits: r.g, supporters: r.s, lastSeq: r.l }));
  }
  candidateHistory(electionId: string, candidateId: string, limit = 200): { seq: number; delta: number; ts: number }[] {
    const rows = this.s('SELECT seq, votes d, created_at t FROM votes WHERE election_id=? AND candidate_id=? ORDER BY seq DESC LIMIT ?').all(electionId, candidateId, limit) as any[];
    return rows.reverse().map((r) => ({ seq: r.seq, delta: r.d, ts: r.t }));
  }
  voterStats(electionId: string): { total: number; byState: Record<string, number>; byOrigin: Record<string, number>; votesSum: number } {
    const byState: Record<string, number> = {};
    const byOrigin: Record<string, number> = {};
    for (const r of this.s('SELECT state s, COUNT(*) n FROM voters WHERE election_id=? GROUP BY state').all(electionId) as any[]) byState[r.s] = r.n;
    for (const r of this.s('SELECT origin o, COUNT(*) n FROM voters WHERE election_id=? GROUP BY origin').all(electionId) as any[]) byOrigin[r.o] = r.n;
    const t = this.s('SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN candidate_id IS NOT NULL THEN votes ELSE 0 END),0) v FROM voters WHERE election_id=?').get(electionId) as any;
    return { total: t.n, byState, byOrigin, votesSum: t.v };
  }
  eventCounts(electionId: string): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.s('SELECT COALESCE(outcome,\'(none)\') o, COUNT(*) n FROM events WHERE election_id=? GROUP BY outcome').all(electionId) as any[]) out[r.o] = r.n;
    return out;
  }

  // ---- ranking / logs ----
  saveRankingSnapshot(electionId: string, reason: string, rankingJson: string, now: number): void {
    this.s('INSERT INTO ranking_snapshots(election_id,created_at,reason,ranking_json) VALUES(?,?,?,?)').run(electionId, now, reason, rankingJson);
  }
  logError(level: string, component: string, message: string, detail: unknown, now = Date.now()): void {
    try {
      this.s('INSERT INTO error_log(ts,level,component,message,detail_json) VALUES(?,?,?,?,?)').run(now, level, component, message.slice(0, 500), detail === undefined ? null : JSON.stringify(detail).slice(0, 2000));
    } catch {
      /* log nunca pode derrubar o motor */
    }
  }
  logConnection(state: string, detail?: string, now = Date.now()): void {
    try {
      this.s('INSERT INTO connection_log(ts,state,detail) VALUES(?,?,?)').run(now, state, detail?.slice(0, 500) ?? null);
    } catch {
      /* idem */
    }
  }
}

export type { VoterSpec };
