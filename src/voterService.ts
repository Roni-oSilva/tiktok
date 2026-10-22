import { randomUUID } from 'node:crypto';
import type { EventBus } from './eventBus.js';
import type { Metrics } from './metrics.js';
import type { PersistenceService } from './persistence.js';
import type { Voter, VoterSpec, VoterState } from './types.js';

export interface CreatedVoter {
  voter: Voter;
  voteSeq: number | null;
  newSupporter: boolean;
}

/** Ciclo de vida do eleitor: criação (dentro da transação do voto) e transições de estado. */
export class VoterService {
  constructor(
    private readonly db: PersistenceService,
    private readonly bus: EventBus,
    private readonly metrics: Metrics,
    private readonly electionId: string,
    private readonly now: () => number,
  ) {}

  /** DEVE ser chamado dentro da transação que também grava o evento. Grava eleitor + voto atomicamente. */
  createInTx(spec: VoterSpec, eventKey: string, simulated: boolean): CreatedVoter {
    const t = this.now();
    const voter: Voter = {
      id: randomUUID(), seq: 0, electionId: this.electionId, displayName: spec.displayName, origin: spec.origin, sourceEventKey: eventKey,
      userId: spec.userId, candidateId: spec.candidateId, votes: spec.votes, units: spec.units, state: 'queued',
      voteConfirmed: !!spec.candidateId && spec.votes > 0, participationOnly: spec.participationOnly, createdAt: t, completedAt: null, failureReason: null, simulated,
    };
    let voteSeq: number | null = null;
    let newSupporter = false;
    if (spec.candidateId && spec.votes > 0) {
      newSupporter = !!spec.userId && !this.db.hasVoteFrom(this.electionId, spec.candidateId, spec.userId);
      voteSeq = this.db.insertVote({ electionId: this.electionId, voterId: voter.id, candidateId: spec.candidateId, votes: spec.votes, giftUnits: spec.origin === 'gift' ? spec.units : 0, userId: spec.userId, eventKey, createdAt: t });
    }
    this.db.insertVoter(voter);
    return { voter, voteSeq, newSupporter };
  }

  snapshot(v: Voter): Record<string, unknown> {
    return {
      voterId: v.id, displayName: v.displayName, origin: v.origin, candidateId: v.candidateId, votes: v.votes, units: v.units,
      state: v.state, voteConfirmed: v.voteConfirmed, participationOnly: v.participationOnly, simulated: v.simulated,
    };
  }

  /** Transição de estado de APRESENTAÇÃO. Nunca toca em votos. */
  transition(v: Voter, state: VoterState, failure?: string): void {
    v.state = state;
    const terminal = state === 'completed' || state === 'failed' || state === 'rejected';
    const t = this.now();
    this.db.setVoterState(v.id, state, terminal ? t : null, failure);
    if (terminal) v.completedAt = t;
    if (failure) v.failureReason = failure;
    if (state === 'completed') this.metrics.votersCompleted++;
    if (state === 'failed') this.metrics.votersFailed++;
    this.bus.emit(`voter.${state}` as any, { ...this.snapshot(v), ...(failure ? { reason: failure } : {}) });
  }

  /** Conclui vários eleitores de uma vez (agrupamento visual). */
  completeGroup(list: Voter[]): void {
    const t = this.now();
    this.db.setVoterStateMany(list.map((v) => v.id), 'completed', t);
    for (const v of list) {
      v.state = 'completed';
      v.completedAt = t;
      this.metrics.votersCompleted++;
      this.bus.emit('voter.completed', { ...this.snapshot(v), grouped: true });
    }
  }
}
