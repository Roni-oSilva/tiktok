import { createHash } from 'node:crypto';
import type { InputEvent } from './types.js';

/**
 * Prevenção de duplicações. O caminho rápido é uma janela LRU em memória; a garantia real é a
 * restrição UNIQUE(election_id, dedupe_key) no banco (sobrevive a reinicializações).
 */
export class EventDeduplicator {
  private readonly seen = new Set<string>();
  constructor(private readonly window: number) {}

  /**
   * Chave de deduplicação:
   *  - com eventId da fonte: `kind:eventId`;
   *  - sem eventId e com timestamp: impressão digital dos campos (repetição exata);
   *  - caso contrário: null (não há como distinguir repetição de novo envio; presentes de
   *    combo continuam protegidos pelo controle de progresso do combo).
   */
  keyFor(e: InputEvent): string | null {
    if (e.eventId) return `${e.kind}:${e.eventId}`;
    if (e.ts === undefined) return null;
    const parts =
      e.kind === 'gift'
        ? [e.viewer.userId, e.giftId, e.giftName, e.groupId, e.repeatCount, e.repeatEnd, e.ts]
        : e.kind === 'like'
          ? [e.viewer.userId, e.likeCount, e.totalLikeCount, e.ts]
          : [e.viewer.userId, e.text, e.ts];
    return `fp:${e.kind}:` + createHash('sha1').update(JSON.stringify(parts)).digest('hex');
  }

  has(key: string): boolean {
    return this.seen.has(key);
  }

  remember(key: string): void {
    this.seen.delete(key);
    this.seen.add(key);
    if (this.seen.size > this.window) {
      const oldest = this.seen.values().next().value as string;
      this.seen.delete(oldest);
    }
  }
}
