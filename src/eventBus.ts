import { EventEmitter } from 'node:events';

/** Nomes dos eventos internos publicados para a futura interface. */
export type BusEventName =
  | 'voter.created'
  | 'voter.queued'
  | 'voter.approaching'
  | 'voter.voting'
  | 'voter.completed'
  | 'voter.rejected'
  | 'voter.failed'
  | 'voter.group'
  | 'election.updated'
  | 'election.finished'
  | 'candidate.vote_received'
  | 'candidate.ranking_changed'
  | 'gift.processed'
  | 'likes.threshold_reached'
  | 'config.updated'
  | 'source.status'
  | 'health.status';

export interface BusMessage {
  /** Número de sequência monotônico do barramento (a interface pode detectar lacunas). */
  seq: number;
  type: BusEventName;
  ts: number;
  data: Record<string, unknown>;
}

export class EventBus {
  private readonly em = new EventEmitter();
  private seq = 0;
  constructor() {
    this.em.setMaxListeners(100);
  }

  emit(type: BusEventName, data: Record<string, unknown> = {}): BusMessage {
    const msg: BusMessage = { seq: ++this.seq, type, ts: Date.now(), data };
    // Um ouvinte com defeito (ex.: interface) nunca pode quebrar o motor.
    for (const fn of [...this.em.listeners(type), ...this.em.listeners('*')]) {
      try {
        (fn as (m: BusMessage) => void)(msg);
      } catch {
        /* isolado de propósito */
      }
    }
    return msg;
  }

  on(type: BusEventName | '*', fn: (m: BusMessage) => void): () => void {
    this.em.on(type, fn);
    return () => this.em.off(type, fn);
  }
}
