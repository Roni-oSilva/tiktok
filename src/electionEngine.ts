import { randomUUID } from 'node:crypto';
import { CandidateService } from './candidateService.js';
import { ChatCommandProcessor } from './chatCommandProcessor.js';
import { AdminConfigService } from './config.js';
import { EventDeduplicator } from './deduplicator.js';
import { EventBus } from './eventBus.js';
import { EventQueue } from './eventQueue.js';
import { GiftProcessor } from './giftProcessor.js';
import { LikeProcessor } from './likeProcessor.js';
import { createLogger, type Logger } from './logger.js';
import { Metrics } from './metrics.js';
import { PersistenceService, type ElectionRow } from './persistence.js';
import { PresentationQueue, TimerAnimator, InstantAnimator, type VoterAnimator } from './presentationQueue.js';
import type { ProcessorContext } from './processorContext.js';
import { RankingService } from './rankingService.js';
import type { ChatInput, EventSourceName, GiftInput, IngestResult, InputEvent, LikeInput, Mode, Outcome, Voter, VoterSpec } from './types.js';
import { VoterService } from './voterService.js';
import { resolveName } from './processorContext.js';

const ADMIN = Symbol('admin-job');
type AdminJob = { [ADMIN]: () => unknown | Promise<unknown> };

export interface EngineOptions {
  dbPath: string;
  mode: Mode;
  config?: Record<string, unknown>;
  logger?: Logger;
  animator?: VoterAnimator;
  now?: () => number;
  synchronous?: 'NORMAL' | 'FULL';
  /** Reabrir a eleição ativa existente no banco (padrão) ou iniciar uma nova. */
  resume?: boolean;
}

type Json = Record<string, unknown>;

/** Valida e normaliza uma entrada desconhecida. Retorna o evento ou o motivo da rejeição. */
export function validateInput(raw: unknown, limits: { maxUnitsPerEvent: number; maxLikesPerEvent: number }): { ok: true; event: InputEvent } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'evento não é objeto' };
  const e = raw as Json;
  const str = (v: unknown) => (typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined);
  const viewerIn = (e.viewer ?? {}) as Json;
  if (typeof viewerIn !== 'object') return { ok: false, reason: 'viewer inválido' };
  const viewer = { userId: str(viewerIn.userId), uniqueId: str(viewerIn.uniqueId), displayName: typeof viewerIn.displayName === 'string' ? viewerIn.displayName : undefined };
  const source: EventSourceName | undefined = e.source === 'tiktok' || e.source === 'simulation' ? e.source : undefined;
  if (!source) return { ok: false, reason: 'source inválida' };
  if (typeof e.simulated !== 'boolean') return { ok: false, reason: 'simulated ausente' };
  if (e.ts !== undefined && !(typeof e.ts === 'number' && Number.isFinite(e.ts) && e.ts >= 0)) return { ok: false, reason: 'ts inválido' };
  const base = { source, simulated: e.simulated, eventId: str(e.eventId), ts: e.ts as number | undefined, viewer };
  const int = (v: unknown, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= max;

  if (e.kind === 'gift') {
    if (!int(e.repeatCount, limits.maxUnitsPerEvent)) return { ok: false, reason: 'repeatCount inválido' };
    const giftId = str(e.giftId);
    const giftName = typeof e.giftName === 'string' && e.giftName.length <= 100 ? e.giftName : undefined;
    if (!giftId && !giftName) return { ok: false, reason: 'presente sem id nem nome' };
    return { ok: true, event: { ...base, kind: 'gift', giftId, giftName, streakable: !!e.streakable, repeatCount: e.repeatCount as number, repeatEnd: !!e.repeatEnd, groupId: str(e.groupId) } satisfies GiftInput };
  }
  if (e.kind === 'like') {
    const hasCount = e.likeCount !== undefined;
    const hasTotal = e.totalLikeCount !== undefined;
    if (!hasCount && !hasTotal) return { ok: false, reason: 'curtidas sem likeCount nem totalLikeCount' };
    if (hasCount && !int(e.likeCount, limits.maxLikesPerEvent)) return { ok: false, reason: 'likeCount inválido' };
    if (hasTotal && !(typeof e.totalLikeCount === 'number' && Number.isInteger(e.totalLikeCount) && e.totalLikeCount >= 0 && e.totalLikeCount <= Number.MAX_SAFE_INTEGER)) return { ok: false, reason: 'totalLikeCount inválido' };
    return { ok: true, event: { ...base, kind: 'like', likeCount: hasCount ? (e.likeCount as number) : undefined, totalLikeCount: hasTotal ? (e.totalLikeCount as number) : undefined } satisfies LikeInput };
  }
  if (e.kind === 'chat') {
    if (typeof e.text !== 'string' || e.text.length === 0 || e.text.length > 500) return { ok: false, reason: 'texto de chat inválido' };
    return { ok: true, event: { ...base, kind: 'chat', text: e.text } satisfies ChatInput };
  }
  return { ok: false, reason: 'kind desconhecido' };
}

/**
 * Orquestra a eleição. Fluxo por evento (tudo serial, via EventQueue):
 *   validar → modo/estado → deduplicar → [TRANSAÇÃO: evento + processador + eleitor + voto]
 *   → atualizar memória → emitir eventos → enfileirar apresentação.
 * Votos só existem se a transação confirmar. A apresentação roda depois e não pode alterá-los.
 */
export class ElectionEngine {
  readonly bus = new EventBus();
  readonly metrics = new Metrics();
  readonly log: Logger;
  readonly db: PersistenceService;
  readonly admin: AdminConfigService;
  readonly dedupe: EventDeduplicator;
  readonly queue: EventQueue<unknown, any>;
  candidates!: CandidateService;
  ranking!: RankingService;
  voters!: VoterService;
  presentation!: PresentationQueue;
  election!: ElectionRow;

  private readonly gifts = new GiftProcessor();
  private readonly likes = new LikeProcessor();
  private readonly chat = new ChatCommandProcessor();
  private readonly now: () => number;
  private readonly mode: Mode;
  private readonly animatorOpt?: VoterAnimator;

  constructor(private readonly opts: EngineOptions) {
    this.mode = opts.mode;
    this.log = opts.logger ?? createLogger('engine');
    this.now = opts.now ?? Date.now;
    this.animatorOpt = opts.animator;
    this.db = new PersistenceService(opts.dbPath, { synchronous: opts.synchronous });
    this.admin = new AdminConfigService(this.db, this.bus, opts.config);
    this.dedupe = new EventDeduplicator(this.admin.get().dedupe.memoryWindow);
    this.queue = new EventQueue<unknown, any>((raw) => ((raw as AdminJob)?.[ADMIN] ? (raw as AdminJob)[ADMIN]() : this.processSync(raw)));
    this.openElection(opts.resume !== false);
  }

  private openElection(resume: boolean): void {
    let row = resume ? this.db.findActiveElection(this.mode) : null;
    if (!row) {
      const cfg = this.admin.get();
      const id = randomUUID();
      this.db.transaction(() => {
        this.db.insertElection({ id, name: cfg.election.name, mode: this.mode, createdAt: this.now() });
        cfg.election.candidates.forEach((c, i) => this.db.insertCandidate(id, { ...c, order: i }));
      });
      row = this.db.getElection(id)!;
      this.log.info('nova eleição criada', { electionId: id, mode: this.mode });
    } else {
      this.log.info('eleição retomada do banco', { electionId: row.id, mode: this.mode });
    }
    this.election = row;
    this.candidates = new CandidateService(this.db, row.id);
    this.ranking = new RankingService(this.candidates, this.db, row.id);
    this.voters = new VoterService(this.db, this.bus, this.metrics, row.id, this.now);
    const animator = this.animatorOpt ?? (this.admin.get().presentation.enabled ? new TimerAnimator(() => this.admin.get()) : new InstantAnimator());
    this.presentation = new PresentationQueue(() => this.admin.get(), this.voters, this.db, this.bus, this.log, animator);
    this.ranking.orderChanged(this.ranking.compute());
    const integrity = this.ranking.verifyIntegrity();
    if (!integrity.ok) {
      this.db.logError('error', 'integrity', 'ranking divergente na inicialização', integrity.problems);
      this.log.error('integridade do ranking falhou na inicialização', { problems: integrity.problems });
    }
  }

  /** Reapresenta eleitores que estavam pendentes quando o processo parou (votos já no banco). */
  recoverPending(): number {
    const pending = this.db.pendingVoters(this.election.id);
    if (pending.length) this.presentation.recover(pending);
    return pending.length;
  }

  /** Ponto de entrada único usado pelo adaptador real e pelo simulador. */
  ingest(raw: unknown): Promise<IngestResult> {
    return this.queue.push(raw);
  }

  async drain(): Promise<void> {
    await this.queue.idle();
    await this.presentation.idle();
  }

  get isActive(): boolean {
    return this.election.status === 'active';
  }

  private result(outcome: Outcome, detail?: string, voterIds: string[] = [], votes = 0): IngestResult {
    this.metrics.outcome(outcome);
    return { outcome, detail, voterIds, votes };
  }

  private processSync(raw: unknown): IngestResult {
    const m = this.metrics;
    m.eventsReceived++;
    const cfg = this.admin.get();
    const v = validateInput(raw, cfg.limits);
    if (!v.ok) {
      m.eventsInvalid++;
      this.db.logError('warn', 'ingest', 'evento inválido', { reason: v.reason, sample: safeSample(raw) });
      return this.result('invalid', v.reason);
    }
    const e = v.event;

    // Simulação nunca se mistura com live (e vice-versa).
    if ((this.mode === 'live' && e.simulated) || (this.mode === 'simulation' && !e.simulated)) {
      m.eventsRejected++;
      this.db.logError('warn', 'ingest', 'evento de origem incompatível com o modo', { mode: this.mode, simulated: e.simulated });
      return this.result('rejected_mode', `modo=${this.mode}, simulated=${e.simulated}`);
    }

    if (!this.isActive) {
      m.eventsRejected++;
      if (e.kind === 'gift') {
        m.votersRejected++;
        this.bus.emit('voter.rejected', { reason: 'election_closed', displayName: null, simulated: e.simulated });
      }
      return this.result('rejected_closed', 'eleição encerrada');
    }

    if (e.kind === 'chat' && !this.chat.isCommand(e.text, cfg.commands.vote, cfg.commands.allowBareNumber ? (t) => !!this.candidates.byCommandToken(t) : undefined)) {
      m.eventsIgnored++;
      return this.result('ignored_chat');
    }

    const key = this.dedupe.keyFor(e);
    if (key && this.dedupe.has(key)) {
      m.eventsDuplicate++;
      return this.result('duplicate', 'memória');
    }

    try {
      const out = this.db.transaction(() => this.applyInTx(e, key));
      if (out.kind === 'duplicate') {
        if (key) this.dedupe.remember(key);
        m.eventsDuplicate++;
        return this.result('duplicate', 'banco');
      }
      if (key) this.dedupe.remember(key);
      return this.afterCommit(e, out);
    } catch (err) {
      m.eventsFailed++;
      this.db.logError('error', 'ingest', 'falha ao processar evento (transação revertida)', { error: (err as Error).message, kind: e.kind });
      this.log.error('falha ao processar evento', { error: (err as Error).message, kind: e.kind });
      return this.result('failed', (err as Error).message);
    }
  }

  private applyInTx(e: InputEvent, key: string | null): TxOut {
    const eventKey = key ?? `nokey:${randomUUID()}`;
    const seq = this.db.insertEvent({
      electionId: this.election.id, dedupeKey: key, kind: e.kind, source: e.source, simulated: e.simulated, eventId: e.eventId, userId: e.viewer.userId,
      payloadJson: JSON.stringify(e), receivedAt: this.now(),
    });
    if (seq === null) return { kind: 'duplicate' };
    const ctx: ProcessorContext = { electionId: this.election.id, db: this.db, cfg: () => this.admin.get(), candidates: this.candidates, now: this.now, eventKey };

    let outcome: Outcome;
    let detail: string | undefined;
    let specs: VoterSpec[] = [];
    let extra: ExtraInfo | undefined;
    if (e.kind === 'gift') {
      const d = this.gifts.process(e, ctx);
      ({ outcome, detail, specs } = d);
      extra = { gift: { newUnits: d.newUnits, votesPerUnit: d.votesPerUnit } };
    } else if (e.kind === 'like') {
      const d = this.likes.process(e, ctx);
      ({ outcome, detail, specs } = d);
      extra = { likes: { delta: d.delta, balance: d.balance, votersGenerated: d.votersGenerated } };
    } else {
      const d = this.chat.process(e, ctx);
      ({ outcome, detail } = d);
      extra = { chat: { candidateId: d.candidateId } };
    }
    const created = specs.map((s) => this.voters.createInTx(s, eventKey, e.simulated));
    this.db.setEventOutcome(seq, outcome, detail);
    return { kind: 'done', outcome, detail, created, extra };
  }

  private afterCommit(e: InputEvent, out: Extract<TxOut, { kind: 'done' }>): IngestResult {
    const m = this.metrics;
    const { outcome, detail, created, extra } = out;
    const totalVotes = created.reduce((s, c) => s + (c.voter.voteConfirmed ? c.voter.votes : 0), 0);

    if (e.kind === 'gift') {
      m.giftEvents++;
      if (extra?.gift) m.giftUnitsCounted += extra.gift.newUnits;
    }
    if (e.kind === 'like' && extra?.likes) m.likesCounted += extra.likes.delta;

    // contagem de eventos por categoria
    if (outcome === 'accepted' || outcome === 'accumulated' || outcome === 'baseline' || outcome === 'command_applied') m.eventsProcessed++;
    else if (outcome === 'no_new_units' || outcome === 'stale_total') m.eventsNoop++;
    else m.eventsRejected++;
    if (outcome === 'command_applied') m.commandsApplied++;

    // memória (derivada do livro já confirmado)
    for (const c of created) {
      if (c.voter.voteConfirmed && c.voter.candidateId && c.voteSeq !== null) {
        this.candidates.applyConfirmedVote(c.voter.candidateId, c.voter.votes, c.voter.origin === 'gift' ? c.voter.units : 0, c.voter.userId, c.voteSeq, c.voter.createdAt, c.newSupporter);
        m.votesConfirmed += c.voter.votes;
      }
      m.votersCreated++;
      if (c.voter.origin === 'likes') m.likeVotersCreated++;
    }

    // eventos para a interface
    if (e.kind === 'gift' && extra?.gift && outcome !== 'no_new_units') {
      this.bus.emit('gift.processed', {
        outcome, giftId: (e as GiftInput).giftId ?? null, giftName: (e as GiftInput).giftName ?? null, units: extra.gift.newUnits, votes: totalVotes,
        voterIds: created.map((c) => c.voter.id), simulated: e.simulated,
      });
    }
    if (outcome === 'no_candidate') {
      m.votersRejected++;
      this.bus.emit('voter.rejected', { reason: 'no_candidate_chosen', displayName: null, simulated: e.simulated });
    }
    if (e.kind === 'like' && extra?.likes && extra.likes.delta > 0) {
      this.bus.emit('likes.progress', { balance: extra.likes.balance, threshold: this.admin.get().likes.threshold, delta: extra.likes.delta, simulated: e.simulated });
    }
    if (outcome === 'command_applied' && extra?.chat?.candidateId) {
      this.bus.emit('viewer.choice', { displayName: resolveName(e.viewer, 'Alguém', this.admin.get().limits.maxNameLength, this.admin.get().names.blocklist), candidateId: extra.chat.candidateId, simulated: e.simulated });
    }
    if (e.kind === 'like' && extra?.likes && created.length > 0) {
      this.bus.emit('likes.threshold_reached', { voters: created.length, delta: extra.likes.delta, balance: extra.likes.balance, threshold: this.admin.get().likes.threshold, simulated: e.simulated });
    }
    for (const c of created) {
      this.bus.emit('voter.created', this.voters.snapshot(c.voter));
      if (c.voter.voteConfirmed && c.voter.candidateId) {
        this.bus.emit('candidate.vote_received', { candidateId: c.voter.candidateId, votes: c.voter.votes, voterId: c.voter.id, voteSeq: c.voteSeq, total: this.candidates.get(c.voter.candidateId)!.votes, simulated: e.simulated });
      }
    }
    if (totalVotes > 0) {
      const ranking = this.ranking.compute();
      this.bus.emit('election.updated', { electionId: this.election.id, ranking, simulated: e.simulated });
      if (this.ranking.orderChanged(ranking)) this.bus.emit('candidate.ranking_changed', { order: ranking.entries.map((x) => x.candidateId), ranking, simulated: e.simulated });
    }
    if (created.length) this.presentation.enqueue(created.map((c) => c.voter));

    return this.result(outcome, detail, created.map((c) => c.voter.id), totalVotes);
  }

  // ---- administração ----
  getRanking() {
    return this.ranking.compute();
  }

  /** Encerra a eleição: persiste o resultado final e passa a rejeitar novos eventos. */
  finish(): { ranking: ReturnType<RankingService['compute']> } {
    if (!this.isActive) return { ranking: this.ranking.compute() };
    const ranking = this.ranking.compute();
    const t = this.now();
    this.db.transaction(() => {
      this.db.saveRankingSnapshot(this.election.id, 'final', JSON.stringify(ranking), t);
      this.db.finishElection(this.election.id, t, JSON.stringify({ ranking, stats: this.db.voterStats(this.election.id), likes: this.db.likeTotals(this.election.id) }));
    });
    this.election = this.db.getElection(this.election.id)!;
    this.bus.emit('election.finished', { electionId: this.election.id, ranking, simulated: this.mode === 'simulation' });
    return { ranking };
  }

  /** Executa `fn` na fila, entre dois eventos (nenhum evento é processado durante a operação). */
  runExclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    return this.queue.push({ [ADMIN]: fn } as AdminJob);
  }

  /** Encerra a eleição atual (se ativa) e abre uma nova, zerada. Votos antigos permanecem no banco. */
  startNewElection(): Promise<{ electionId: string; previousElectionId: string }> {
    return this.runExclusive(async () => {
      const previousElectionId = this.election.id;
      if (this.isActive) this.finish();
      await Promise.race([this.presentation.idle(), new Promise((r) => setTimeout(r, 8000))]);
      const animator = this.presentation.animator;
      this.dedupe.clear();
      this.openElection(false);
      this.presentation.animator = animator;
      this.bus.emit('election.started', { electionId: this.election.id, simulated: this.mode === 'simulation' });
      return { electionId: this.election.id, previousElectionId };
    });
  }

  /** Reinicia a referência do contador cumulativo de curtidas (ex.: nova transmissão). */
  resetLikeBaseline(): void {
    this.db.clearLikeBaseline(this.election.id);
  }

  snapshotRanking(reason: string): void {
    this.db.saveRankingSnapshot(this.election.id, reason, JSON.stringify(this.ranking.compute()), this.now());
  }

  /** Estado completo para clientes que se conectam (WebSocket). */
  snapshot() {
    return {
      mode: this.mode,
      simulated: this.mode === 'simulation',
      notice: this.mode === 'simulation' ? 'SIMULAÇÃO: eventos fictícios, não vêm de uma transmissão real' : undefined,
      election: { id: this.election.id, name: this.election.name, status: this.election.status },
      candidates: this.candidates.all().map((c) => ({ id: c.id, name: c.name, command: c.command })),
      ranking: this.ranking.compute(),
      likes: { ...this.db.likeTotals(this.election.id), threshold: this.admin.get().likes.threshold },
      /** Votos já confirmados cujos eleitores ainda não terminaram de votar na cena (a interface os soma ao votarem). */
      pending: this.db.pendingVoters(this.election.id).filter((v) => v.voteConfirmed && v.candidateId).map((v) => ({ voterId: v.id, candidateId: v.candidateId, votes: v.votes })),
      presentationBacklog: this.presentation.backlog,
    };
  }

  async close(): Promise<void> {
    await this.drain();
    this.db.close();
  }
}

type TxOut =
  | { kind: 'duplicate' }
  | {
      kind: 'done';
      outcome: Outcome;
      detail?: string;
      created: { voter: Voter; voteSeq: number | null; newSupporter: boolean }[];
      extra?: ExtraInfo;
    };

interface ExtraInfo {
  gift?: { newUnits: number; votesPerUnit: number };
  likes?: { delta: number; balance: number; votersGenerated: number };
  chat?: { candidateId?: string };
}

function safeSample(raw: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(raw, (_k, v) => (typeof v === 'string' && v.length > 100 ? v.slice(0, 100) : v))?.slice(0, 500) ?? 'null');
  } catch {
    return '[não serializável]';
  }
}
