import type { PersistenceService } from './persistence.js';
import type { Candidate } from './types.js';

/** Gerencia candidatos. Os totais de votos são derivados do livro de votos (tabela `votes`). */
export class CandidateService {
  private readonly byId = new Map<string, Candidate>();
  private readonly byCommand = new Map<string, Candidate>();

  constructor(private readonly db: PersistenceService, private readonly electionId: string) {
    this.reload();
  }

  /** Reconstrói a memória a partir do banco (usado na inicialização e na checagem de integridade). */
  reload(): void {
    this.byId.clear();
    this.byCommand.clear();
    const list = this.db.loadCandidates(this.electionId);
    const ledger = new Map(this.db.voteLedger(this.electionId).map((l) => [l.candidateId, l]));
    for (const c of list) {
      const l = ledger.get(c.id);
      if (l) {
        c.votes = l.votes;
        c.giftUnits = l.giftUnits;
        c.supporters = l.supporters;
        c.lastVoteSeq = l.lastSeq;
      }
      c.history = this.db.candidateHistory(this.electionId, c.id).map((h) => ({ seq: h.seq, delta: h.delta, total: 0, ts: h.ts }));
      let run = 0;
      // totais cumulativos do histórico recente (parciais se houver mais de 200 votos)
      run = c.votes - c.history.reduce((a, h) => a + h.delta, 0);
      for (const h of c.history) h.total = run += h.delta;
      this.byId.set(c.id, c);
      this.byCommand.set(c.command, c);
    }
  }

  all(): Candidate[] {
    return [...this.byId.values()].sort((a, b) => a.order - b.order);
  }
  get(id: string): Candidate | undefined {
    return this.byId.get(id);
  }
  /** Candidato ativo por id (usado para validar destino de votos). */
  active(id: string | null | undefined): Candidate | undefined {
    const c = id ? this.byId.get(id) : undefined;
    return c && c.status === 'active' ? c : undefined;
  }
  byCommandToken(token: string): Candidate | undefined {
    const c = this.byCommand.get(token.toLowerCase());
    return c && c.status === 'active' ? c : undefined;
  }

  /** Aplica na memória um voto JÁ confirmado no banco. */
  applyConfirmedVote(candidateId: string, votes: number, giftUnits: number, userId: string | null, voteSeq: number, ts: number, newSupporter: boolean): void {
    const c = this.byId.get(candidateId);
    if (!c) throw new Error(`candidato inexistente: ${candidateId}`);
    c.votes += votes;
    c.giftUnits += giftUnits;
    if (userId && newSupporter) c.supporters += 1;
    c.lastVoteSeq = voteSeq;
    c.history.push({ seq: voteSeq, delta: votes, total: c.votes, ts });
    if (c.history.length > 500) c.history.splice(0, c.history.length - 500);
  }

  /** Pontos de bônus: campo SEPARADO dos votos; não altera o ranking por votos. */
  addPoints(candidateId: string, points: number): void {
    const c = this.byId.get(candidateId);
    if (!c) throw new Error(`candidato inexistente: ${candidateId}`);
    c.points += points;
    this.db.updateCandidateMeta(this.electionId, candidateId, { points: c.points });
  }
  setEffects(candidateId: string, effects: string[]): void {
    const c = this.byId.get(candidateId);
    if (!c) throw new Error(`candidato inexistente: ${candidateId}`);
    c.effects = [...effects];
    this.db.updateCandidateMeta(this.electionId, candidateId, { effects });
  }
  rename(candidateId: string, name: string): void {
    const c = this.byId.get(candidateId);
    if (!c) throw new Error(`candidato inexistente: ${candidateId}`);
    c.name = name;
    this.db.updateCandidateMeta(this.electionId, candidateId, { name });
  }
}
