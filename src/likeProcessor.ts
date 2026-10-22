import { resolveName, type ProcessorContext } from './processorContext.js';
import type { LikeInput, Outcome, VoterSpec } from './types.js';

export interface LikeDecision {
  outcome: Outcome;
  detail?: string;
  specs: VoterSpec[];
  /** Curtidas novas contabilizadas neste evento. */
  delta: number;
  balance: number;
  votersGenerated: number;
}

/**
 * Acumulador de curtidas. Roda dentro da transação do motor; saldo e baseline são persistidos,
 * então a contagem sobrevive a reinicializações.
 *
 * Fontes de contagem:
 *  - incremental: `likeCount` é o lote novo (deduplicado por eventId/impressão digital);
 *  - cumulativo: `totalLikeCount` é o total da SALA; conta-se só o aumento sobre o último total visto.
 *    O primeiro total observado vira referência (não se conta o histórico anterior à entrada do motor).
 *    Total menor/igual ao último = evento fora de ordem/repetido: não conta e não reduz a referência.
 */
export class LikeProcessor {
  process(e: LikeInput, ctx: ProcessorContext): LikeDecision {
    const cfg = ctx.cfg();
    const L = cfg.likes;
    const has = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
    const perUser = L.accumulation === 'per_user' && !!e.viewer.userId;
    const scope = perUser ? `user:${e.viewer.userId}` : 'global';
    const useCumulative = !perUser && (L.mode === 'cumulative' || (L.mode === 'auto' && has(e.totalLikeCount)));

    let delta = 0;
    let baselineOnly = false;
    let stale = false;
    if (useCumulative) {
      const total = e.totalLikeCount!;
      const last = ctx.db.getLikeBaseline(ctx.electionId);
      if (last === null) {
        ctx.db.setLikeBaseline(ctx.electionId, total);
        delta = has(e.likeCount) && e.likeCount > 0 ? e.likeCount : 0;
        baselineOnly = delta === 0;
      } else if (total > last) {
        delta = total - last;
        ctx.db.setLikeBaseline(ctx.electionId, total);
      } else {
        stale = true;
      }
    } else {
      delta = e.likeCount!;
    }

    // Atribuição das curtidas a candidatos (só espectadores identificados, com escolha registrada).
    if (L.targetPolicy === 'proportional_choice' && !perUser && delta > 0 && e.viewer.userId && has(e.likeCount) && e.likeCount > 0) {
      const cid = ctx.candidates.active(ctx.db.getChoice(ctx.electionId, e.viewer.userId)?.candidateId)?.id;
      if (cid) ctx.db.addLikeWindow(ctx.electionId, cid, Math.min(e.likeCount, delta));
    }

    const acc = ctx.db.getAccumulator(ctx.electionId, scope);
    const sum = acc.balance + delta;
    const n = Math.floor(sum / L.threshold);
    const next = { balance: sum - n * L.threshold, totalCounted: acc.totalCounted + delta, votersGenerated: acc.votersGenerated + n };
    if (delta > 0 || n > 0) ctx.db.saveAccumulator(ctx.electionId, scope, next);

    if (n === 0) {
      return {
        outcome: stale ? 'stale_total' : baselineOnly ? 'baseline' : 'accumulated',
        detail: stale ? 'total cumulativo não aumentou' : undefined,
        specs: [], delta, balance: next.balance, votersGenerated: next.votersGenerated,
      };
    }

    let candidateId: string | null = null;
    if (L.targetPolicy === 'fixed_candidate') candidateId = ctx.candidates.active(L.fixedCandidateId)?.id ?? null;
    else if (L.targetPolicy === 'user_choice' && e.viewer.userId) candidateId = ctx.candidates.active(ctx.db.getChoice(ctx.electionId, e.viewer.userId)?.candidateId)?.id ?? null;
    let targets: (string | null)[] = Array.from({ length: n }, () => candidateId);
    if (L.targetPolicy === 'proportional_choice') {
      targets = apportion(n, ctx.db.getLikeWindow(ctx.electionId), ctx.candidates.all().map((c) => c.id));
      ctx.db.clearLikeWindow(ctx.electionId);
    }

    // Nome só quando a acumulação é por usuário (identidade confirmada); caso contrário, o genérico.
    const name = perUser ? resolveName(e.viewer, L.genericVoterName, cfg.limits.maxNameLength, cfg.names.blocklist) : L.genericVoterName;
    const specs: VoterSpec[] = targets.map((cid) => ({ displayName: name, origin: 'likes', userId: perUser ? e.viewer.userId! : null, candidateId: cid, votes: cid ? L.votesPerVoter : 0, units: 0, participationOnly: cid === null }));
    return { outcome: 'accepted', specs, delta, balance: next.balance, votersGenerated: next.votersGenerated };
  }
}

/**
 * Reparte `n` eleitores entre candidatos na proporção de `weights` (método do maior resto).
 * Determinístico: empates de resto seguem a ordem dos candidatos. Sem pesos => todos sem destino (null).
 */
export function apportion(n: number, weights: Record<string, number>, order: readonly string[]): (string | null)[] {
  const total = order.reduce((s, id) => s + (weights[id] ?? 0), 0);
  if (n <= 0) return [];
  if (total <= 0) return Array.from({ length: n }, () => null);
  const rows = order.map((id, i) => {
    const q = (n * (weights[id] ?? 0)) / total;
    return { id, i, base: Math.floor(q), rem: q - Math.floor(q) };
  });
  let left = n - rows.reduce((s, r) => s + r.base, 0);
  for (const r of [...rows].sort((a, b) => b.rem - a.rem || a.i - b.i)) {
    if (left <= 0) break;
    if (r.rem > 0) { r.base++; left--; }
  }
  const out: (string | null)[] = [];
  for (const r of rows) for (let k = 0; k < r.base; k++) out.push(r.id);
  while (out.length < n) out.push(null);
  return out;
}
