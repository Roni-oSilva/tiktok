import type { GameConfig } from './config.js';
import type { CandidateService } from './candidateService.js';
import type { PersistenceService } from './persistence.js';
import type { Viewer } from './types.js';

export interface ProcessorContext {
  electionId: string;
  db: PersistenceService;
  cfg: () => Readonly<GameConfig>;
  candidates: CandidateService;
  now: () => number;
  /** Chave do evento no banco (para vincular eleitores/presentes ao evento de origem). */
  eventKey: string;
}

/** Nome exibido: apenas o que a fonte forneceu (sem inventar); sanitizado e truncado. */
export function resolveName(viewer: Viewer, generic: string, maxLen: number): string {
  const raw = viewer.displayName?.trim() || viewer.uniqueId?.trim();
  if (!raw) return generic;
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '').replace(/\s+/g, ' ').trim();
  if (!clean) return generic;
  return [...clean].slice(0, maxLen).join('');
}
