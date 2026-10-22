import type { GameConfig } from './config.js';
import type { EventBus } from './eventBus.js';
import type { Logger } from './logger.js';
import type { PersistenceService } from './persistence.js';
import type { Voter } from './types.js';
import type { VoterService } from './voterService.js';

/** Contrato com a futura interface/animação. A animação NUNCA cria ou altera votos. */
export interface VoterAnimator {
  approach(v: Voter): Promise<void>;
  vote(v: Voter): Promise<void>;
}

export class InstantAnimator implements VoterAnimator {
  async approach(): Promise<void> {}
  async vote(): Promise<void> {}
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Animador por temporizador (placeholder até a interface existir); respeita `speed`. */
export class TimerAnimator implements VoterAnimator {
  constructor(private readonly cfg: () => Readonly<GameConfig>) {}
  approach(): Promise<void> {
    const p = this.cfg().presentation;
    return sleep(p.approachMs / p.speed);
  }
  vote(): Promise<void> {
    const p = this.cfg().presentation;
    return sleep(p.voteMs / p.speed);
  }
}

/**
 * Fila de APRESENTAÇÃO dos eleitores. É independente do processamento de votos: os votos já foram
 * confirmados no banco antes de qualquer item entrar aqui. Limita animações simultâneas e agrupa
 * eleitores quando o backlog é grande (sem remover votos).
 */
export class PresentationQueue {
  private pending: Voter[] = [];
  private active = 0;
  private idleWaiters: (() => void)[] = [];
  groupsEmitted = 0;
  maxBacklog = 0;
  animator: VoterAnimator;

  constructor(
    private readonly cfg: () => Readonly<GameConfig>,
    private readonly voters: VoterService,
    private readonly db: PersistenceService,
    private readonly bus: EventBus,
    private readonly log: Logger,
    animator?: VoterAnimator,
  ) {
    this.animator = animator ?? new InstantAnimator();
  }

  get backlog(): number {
    return this.pending.length;
  }

  enqueue(list: Voter[]): void {
    for (const v of list) {
      this.pending.push(v);
      this.bus.emit('voter.queued', this.voters.snapshot(v));
    }
    this.maxBacklog = Math.max(this.maxBacklog, this.pending.length);
    this.pump();
  }

  /** Reenfileira eleitores pendentes após reinicialização (votos já estão no banco). */
  recover(list: Voter[]): void {
    for (const v of list) {
      v.state = 'queued';
      this.db.setVoterState(v.id, 'queued', null);
    }
    this.enqueue(list);
  }

  private pump(): void {
    const p = this.cfg().presentation;
    while (this.active < p.maxConcurrent && this.pending.length > 0) {
      this.active++;
      if (this.pending.length > p.groupThreshold) {
        const batch = this.pending.splice(0, p.groupBatchSize);
        void this.runGroup(batch).finally(() => this.done());
      } else {
        const v = this.pending.shift()!;
        void this.runOne(v).finally(() => this.done());
      }
    }
  }

  private done(): void {
    this.active--;
    this.pump();
    if (this.active === 0 && this.pending.length === 0) {
      const w = this.idleWaiters;
      this.idleWaiters = [];
      w.forEach((f) => f());
    }
  }

  private async runOne(v: Voter): Promise<void> {
    try {
      this.voters.transition(v, 'approaching');
      await this.animator.approach(v);
      this.voters.transition(v, 'voting');
      await this.animator.vote(v);
      this.voters.transition(v, 'completed');
    } catch (e) {
      // Falha de apresentação: o voto confirmado permanece intacto.
      this.log.warn('falha na apresentação do eleitor', { voterId: v.id, error: (e as Error).message });
      try {
        this.voters.transition(v, 'failed', `presentation: ${(e as Error).message}`.slice(0, 200));
      } catch (e2) {
        this.log.error('falha ao registrar estado failed', { voterId: v.id, error: (e2 as Error).message });
      }
    }
  }

  /** Backlog grande: a cena recebe um evento de grupo; cada eleitor segue com voto confirmado. */
  private async runGroup(batch: Voter[]): Promise<void> {
    try {
      this.groupsEmitted++;
      this.bus.emit('voter.group', {
        count: batch.length,
        voterIds: batch.map((v) => v.id),
        sampleNames: batch.slice(0, 5).map((v) => v.displayName),
        votes: batch.reduce((s, v) => s + (v.voteConfirmed ? v.votes : 0), 0),
        votesByCandidate: batch.reduce<Record<string, number>>((m, v) => {
          if (v.voteConfirmed && v.candidateId) m[v.candidateId] = (m[v.candidateId] ?? 0) + v.votes;
          return m;
        }, {}),
      });
      this.voters.completeGroup(batch);
    } catch (e) {
      this.log.error('falha ao agrupar eleitores', { error: (e as Error).message });
    }
  }

  idle(): Promise<void> {
    if (this.active === 0 && this.pending.length === 0) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }
}
