import type { CandidateService } from './candidateService.js';
import type { PersistenceService } from './persistence.js';
import type { Ranking, RankingEntry } from './types.js';

/**
 * Regra de desempate (determinística, não altera votos):
 *  1. mais votos válidos;
 *  2. em empate, fica à frente quem atingiu aquele total primeiro (menor `lastVoteSeq` do livro de votos);
 *  3. candidatos sem votos (ou ainda empatados): ordem de cadastro.
 * Percentual = votos do candidato / votos válidos totais (soma dos candidatos). Pontos e efeitos NÃO entram.
 */
export class RankingService {
  private lastOrder: string[] = [];
  constructor(private readonly candidates: CandidateService, private readonly db: PersistenceService, private readonly electionId: string) {}

  compute(): Ranking {
    const list = this.candidates.all().filter((c) => c.status === 'active');
    const sorted = [...list].sort((a, b) => b.votes - a.votes || (a.votes > 0 ? a.lastVoteSeq - b.lastVoteSeq : 0) || a.order - b.order);
    const total = sorted.reduce((s, c) => s + c.votes, 0);
    const leader = sorted[0]?.votes ?? 0;
    const entries: RankingEntry[] = sorted.map((c, i) => ({
      position: i + 1,
      candidateId: c.id,
      name: c.name,
      votes: c.votes,
      percent: total > 0 ? Math.round((c.votes / total) * 10000) / 100 : 0,
      points: c.points,
      effects: [...c.effects],
      supporters: c.supporters,
      giftUnits: c.giftUnits,
      diffToLeader: leader - c.votes,
      diffToNext: i + 1 < sorted.length ? c.votes - sorted[i + 1].votes : 0,
    }));
    return { totalValidVotes: total, entries };
  }

  /** Retorna true se a ordem dos candidatos mudou desde a última chamada. */
  orderChanged(r: Ranking): boolean {
    const now = r.entries.map((e) => e.candidateId);
    const changed = now.length !== this.lastOrder.length || now.some((id, i) => id !== this.lastOrder[i]);
    this.lastOrder = now;
    return changed;
  }

  /** Compara a memória com o livro de votos no banco. */
  verifyIntegrity(): { ok: boolean; problems: string[] } {
    const problems: string[] = [];
    const ledger = new Map(this.db.voteLedger(this.electionId).map((l) => [l.candidateId, l.votes]));
    for (const c of this.candidates.all()) {
      const db = ledger.get(c.id) ?? 0;
      if (db !== c.votes) problems.push(`candidato ${c.id}: memória=${c.votes} livro=${db}`);
      ledger.delete(c.id);
    }
    for (const [id, v] of ledger) problems.push(`livro contém candidato desconhecido ${id} (${v} votos)`);
    const stats = this.db.voterStats(this.electionId);
    const ledgerSum = this.db.voteLedger(this.electionId).reduce((s, l) => s + l.votes, 0);
    if (stats.votesSum !== ledgerSum) problems.push(`soma de votos dos eleitores (${stats.votesSum}) != livro de votos (${ledgerSum})`);
    const r = this.compute();
    const pct = r.entries.reduce((s, e) => s + e.percent, 0);
    if (r.totalValidVotes > 0 && Math.abs(pct - 100) > 0.05 * r.entries.length) problems.push(`percentuais somam ${pct}`);
    return { ok: problems.length === 0, problems };
  }
}
