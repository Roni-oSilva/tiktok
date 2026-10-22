import type { GiftRule } from './config.js';
import { resolveName, type ProcessorContext } from './processorContext.js';
import type { GiftInput, Outcome, VoterSpec } from './types.js';

export interface GiftDecision {
  outcome: Outcome;
  detail?: string;
  specs: VoterSpec[];
  /** Unidades NOVAS contabilizadas neste evento (distintas do nº de eventos). */
  newUnits: number;
  votesPerUnit: number;
}

export function findGiftRule(rules: readonly GiftRule[], e: Pick<GiftInput, 'giftId' | 'giftName'>): GiftRule | undefined {
  const name = e.giftName?.trim().toLowerCase();
  return rules.find((r) => (e.giftId !== undefined && r.ids.includes(String(e.giftId))) || (name !== undefined && r.names.some((n) => n.toLowerCase() === name)));
}

/**
 * Processa presentes. Roda dentro da transação do motor.
 * Combos: o progresso (unidades já contadas) é persistido por sequência (usuário|groupId|presente).
 * Cada atualização conta apenas o DELTA, então início/atualização/fim e reenvios nunca contam duas vezes
 * e uma atualização fora de ordem (contador menor) não conta nada.
 */
export class GiftProcessor {
  process(e: GiftInput, ctx: ProcessorContext): GiftDecision {
    const cfg = ctx.cfg();
    const now = ctx.now();
    const giftKey = e.giftId ?? e.giftName ?? 'unknown';
    const comboKey = e.groupId ? `${e.viewer.userId ?? 'anon'}|${e.groupId}|${giftKey}` : null;

    let newUnits = e.repeatCount;
    if (comboKey) {
      const prior = ctx.db.getCombo(ctx.electionId, comboKey);
      newUnits = Math.max(0, e.repeatCount - prior);
      ctx.db.setCombo(ctx.electionId, comboKey, Math.max(prior, e.repeatCount), !!e.repeatEnd, now);
      if (newUnits === 0) {
        return { outcome: 'no_new_units', detail: e.repeatEnd ? 'fim de combo sem unidades novas' : 'atualização repetida ou fora de ordem', specs: [], newUnits: 0, votesPerUnit: 0 };
      }
    }

    const rule = findGiftRule(cfg.gifts.rules, e);
    let votesPerUnit: number;
    if (rule) votesPerUnit = rule.votes;
    else if (cfg.gifts.unknownPolicy === 'default_votes') votesPerUnit = cfg.gifts.unknownVotes;
    else votesPerUnit = 0;

    const log = (outcome: string, votes: number) =>
      ctx.db.insertGiftLog({ electionId: ctx.electionId, eventKey: ctx.eventKey, userId: e.viewer.userId, giftKey, giftName: e.giftName, units: newUnits, votes, comboKey, outcome, createdAt: now });

    if (!rule && cfg.gifts.unknownPolicy === 'record_only') {
      log('unknown_gift', 0);
      return { outcome: 'unknown_gift', detail: `presente sem regra: ${giftKey}`, specs: [], newUnits, votesPerUnit: 0 };
    }

    // Destino do voto: SOMENTE a escolha registrada do espectador. Nunca aleatório.
    const choice = e.viewer.userId ? ctx.db.getChoice(ctx.electionId, e.viewer.userId) : null;
    const target = ctx.candidates.active(choice?.candidateId);
    const participationOnly = !target;
    if (participationOnly && cfg.viewers.noChoicePolicy === 'ignore') {
      log('no_candidate', 0);
      return { outcome: 'no_candidate', detail: 'espectador sem candidato escolhido', specs: [], newUnits, votesPerUnit };
    }

    const name = resolveName(e.viewer, cfg.gifts.genericVoterName, cfg.limits.maxNameLength, cfg.names.blocklist);
    const base = { displayName: name, origin: 'gift' as const, userId: e.viewer.userId ?? null, candidateId: target?.id ?? null, participationOnly };
    const specs: VoterSpec[] =
      cfg.gifts.voterMode === 'per_unit'
        ? Array.from({ length: newUnits }, () => ({ ...base, units: 1, votes: participationOnly ? 0 : votesPerUnit }))
        : [{ ...base, units: newUnits, votes: participationOnly ? 0 : votesPerUnit * newUnits }];
    log('accepted', specs.reduce((s, x) => s + x.votes, 0));
    return { outcome: 'accepted', specs, newUnits, votesPerUnit };
  }
}
