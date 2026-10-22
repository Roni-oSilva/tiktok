import type { ProcessorContext } from './processorContext.js';
import type { ChatInput, Outcome } from './types.js';

export interface ChatDecision {
  outcome: Outcome;
  detail?: string;
  candidateId?: string;
}

/** Interpreta `!votar <comando-do-candidato>` e registra a escolha do espectador (só vale daqui para frente). */
export class ChatCommandProcessor {
  isCommand(text: string, prefixes: readonly string[], bare?: (token: string) => boolean): boolean {
    const t = text.trim().toLowerCase();
    const first = t.split(/\s+/, 1)[0];
    if (!first) return false;
    if (prefixes.some((p) => p.toLowerCase() === first)) return true;
    return !!bare && t === first && bare(first); // mensagem composta só pelo número do candidato
  }

  process(e: ChatInput, ctx: ProcessorContext): ChatDecision {
    const now = ctx.now();
    const log = (result: string, candidateId?: string) =>
      ctx.db.insertCommand({ electionId: ctx.electionId, userId: e.viewer.userId, raw: e.text, result, candidateId, createdAt: now });

    if (!e.viewer.userId) {
      log('no_user_id');
      return { outcome: 'command_rejected', detail: 'sem identificador de usuário: escolha não pode ser associada' };
    }
    const parts = e.text.trim().split(/\s+/);
    const isPrefixed = ctx.cfg().commands.vote.some((p) => p.toLowerCase() === parts[0].toLowerCase());
    const token = isPrefixed ? parts[1] : parts[0];
    const cand = token ? ctx.candidates.byCommandToken(token) : undefined;
    if (!cand) {
      log('unknown_candidate');
      return { outcome: 'command_rejected', detail: 'candidato desconhecido' };
    }
    const ts = e.ts ?? now;
    const prev = ctx.db.getChoice(ctx.electionId, e.viewer.userId);
    if (prev && ts < prev.choiceTs) {
      log('stale', cand.id);
      return { outcome: 'command_rejected', detail: 'comando mais antigo que a escolha atual (fora de ordem)' };
    }
    ctx.db.setChoice(ctx.electionId, e.viewer.userId, cand.id, ts, now);
    log('applied', cand.id);
    return { outcome: 'command_applied', candidateId: cand.id };
  }
}
