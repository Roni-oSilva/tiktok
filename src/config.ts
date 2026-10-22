import type { EventBus } from './eventBus.js';
import type { PersistenceService } from './persistence.js';

export interface GiftRule {
  /** Nomes aceitos (comparação sem diferenciar maiúsculas/minúsculas). */
  names: string[];
  /** IDs numéricos/textuais do presente na plataforma. */
  ids: string[];
  votes: number;
  label: string;
}

export interface GameConfig {
  election: { name: string; candidates: { id: string; name: string; command: string }[] };
  commands: {
    vote: string[];
    /** Aceita a mensagem só com o comando do candidato (ex.: "13"), sem o prefixo. */
    allowBareNumber: boolean;
  };
  gifts: {
    rules: GiftRule[];
    /** record_only: registra o evento e não atribui votos. default_votes: usa unknownVotes por unidade. */
    unknownPolicy: 'record_only' | 'default_votes';
    unknownVotes: number;
    /** per_event: 1 eleitor por evento lógico (votos = unidades × valor). per_unit: 1 eleitor por unidade. */
    voterMode: 'per_event' | 'per_unit';
    genericVoterName: string;
  };
  viewers: {
    /** Espectador sem candidato escolhido: ignorar o presente ou registrar participação sem votos. */
    noChoicePolicy: 'ignore' | 'record_participation';
  };
  likes: {
    threshold: number;
    votesPerVoter: number;
    mode: 'auto' | 'incremental' | 'cumulative';
    accumulation: 'global' | 'per_user';
    /** proportional_choice: o(s) voto(s) do(s) eleitor(es) de curtidas é(são) repartido(s) entre os candidatos na proporção das curtidas de espectadores identificados com escolha, desde o último eleitor (determinístico, sem sorteio). */
    targetPolicy: 'none' | 'fixed_candidate' | 'user_choice' | 'proportional_choice';
    fixedCandidateId?: string;
    genericVoterName: string;
  };
  presentation: {
    /** false = estados avançam sem esperar temporizadores (testes/carga). */
    enabled: boolean;
    maxConcurrent: number;
    /** Multiplicador de velocidade (2 = metade do tempo). */
    speed: number;
    approachMs: number;
    voteMs: number;
    /** Acima deste backlog, eleitores são agrupados visualmente (votos intactos). */
    groupThreshold: number;
    groupBatchSize: number;
  };
  reconnect: { initialMs: number; maxMs: number; factor: number; jitter: number; maxAttempts: number };
  /** Termos extras a bloquear nos nomes exibidos (além da lista padrão em nameFilter.ts). */
  names: { blocklist: string[] };
  dedupe: { memoryWindow: number };
  limits: { maxUnitsPerEvent: number; maxLikesPerEvent: number; maxNameLength: number };
}

export const DEFAULT_CONFIG: GameConfig = {
  election: {
    name: 'Eleição Presidencial Fictícia',
    candidates: [
      { id: 'candidato1', name: 'Candidato 1', command: 'candidato1' },
      { id: 'candidato2', name: 'Candidato 2', command: 'candidato2' },
      { id: 'candidato3', name: 'Candidato 3', command: 'candidato3' },
    ],
  },
  commands: { vote: ['!votar'], allowBareNumber: false },
  gifts: {
    rules: [
      // O id 5655 é o valor comumente citado pela comunidade para a Rosa; NÃO foi validado em live real.
      { names: ['rose', 'rosa'], ids: ['5655'], votes: 1, label: 'Rosa' },
      // Valores abaixo são EXEMPLOS editáveis, não uma tabela oficial.
      { names: ['finger heart'], ids: [], votes: 5, label: 'Finger Heart (exemplo)' },
      { names: ['lion', 'leão'], ids: [], votes: 50, label: 'Leão (exemplo)' },
    ],
    unknownPolicy: 'record_only',
    unknownVotes: 0,
    voterMode: 'per_event',
    genericVoterName: 'Eleitor',
  },
  viewers: { noChoicePolicy: 'ignore' },
  likes: {
    threshold: 1000,
    votesPerVoter: 1,
    mode: 'auto',
    accumulation: 'global',
    targetPolicy: 'none',
    genericVoterName: 'Eleitor das Curtidas',
  },
  presentation: { enabled: true, maxConcurrent: 5, speed: 1, approachMs: 1500, voteMs: 600, groupThreshold: 50, groupBatchSize: 25 },
  reconnect: { initialMs: 1000, maxMs: 60000, factor: 2, jitter: 0.2, maxAttempts: 0 },
  names: { blocklist: [] },
  dedupe: { memoryWindow: 50000 },
  limits: { maxUnitsPerEvent: 10000, maxLikesPerEvent: 1_000_000, maxNameLength: 40 },
};

export class ConfigError extends Error {
  constructor(public readonly errors: string[]) {
    super('Configuração inválida: ' + errors.join('; '));
    this.name = 'ConfigError';
  }
}

type Json = Record<string, any>;

function isObj(v: unknown): v is Json {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Mescla profunda; arrays e escalares do patch substituem os atuais. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isObj(base) || !isObj(patch)) return (patch === undefined ? base : patch) as T;
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
  return out as T;
}

export function validateConfig(c: GameConfig): string[] {
  const e: string[] = [];
  const posInt = (v: unknown, name: string, min = 1) => {
    if (!Number.isInteger(v) || (v as number) < min) e.push(`${name} deve ser inteiro >= ${min}`);
  };
  const posNum = (v: unknown, name: string) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) e.push(`${name} deve ser número > 0`);
  };
  const ids = new Set<string>();
  const cmds = new Set<string>();
  if (!Array.isArray(c.election?.candidates) || c.election.candidates.length < 2) e.push('election.candidates precisa de ao menos 2 candidatos');
  for (const k of c.election?.candidates ?? []) {
    if (!k.id || !k.name || !k.command) e.push('candidato precisa de id, name e command');
    if (ids.has(k.id)) e.push(`id de candidato duplicado: ${k.id}`);
    if (cmds.has(k.command?.toLowerCase())) e.push(`command de candidato duplicado: ${k.command}`);
    ids.add(k.id);
    cmds.add(k.command?.toLowerCase());
  }
  if (!Array.isArray(c.commands?.vote) || c.commands.vote.length === 0) e.push('commands.vote não pode ser vazio');
  for (const r of c.gifts?.rules ?? []) {
    if (!Number.isInteger(r.votes) || r.votes < 0) e.push(`regra de presente "${r.label}": votes deve ser inteiro >= 0`);
    if (!r.names?.length && !r.ids?.length) e.push(`regra de presente "${r.label}": informe names ou ids`);
  }
  if (!['record_only', 'default_votes'].includes(c.gifts?.unknownPolicy)) e.push('gifts.unknownPolicy inválido');
  posInt(c.gifts?.unknownVotes, 'gifts.unknownVotes', 0);
  if (!['per_event', 'per_unit'].includes(c.gifts?.voterMode)) e.push('gifts.voterMode inválido');
  if (!['ignore', 'record_participation'].includes(c.viewers?.noChoicePolicy)) e.push('viewers.noChoicePolicy inválido');
  posInt(c.likes?.threshold, 'likes.threshold');
  posInt(c.likes?.votesPerVoter, 'likes.votesPerVoter', 0);
  if (!['auto', 'incremental', 'cumulative'].includes(c.likes?.mode)) e.push('likes.mode inválido');
  if (!['global', 'per_user'].includes(c.likes?.accumulation)) e.push('likes.accumulation inválido');
  if (!['none', 'fixed_candidate', 'user_choice', 'proportional_choice'].includes(c.likes?.targetPolicy)) e.push('likes.targetPolicy inválido');
  if (c.likes?.targetPolicy === 'fixed_candidate' && !ids.has(c.likes.fixedCandidateId ?? '')) e.push('likes.fixedCandidateId deve ser um candidato existente');
  if (c.likes?.targetPolicy === 'user_choice' && c.likes.accumulation !== 'per_user')
    e.push('likes.targetPolicy=user_choice exige likes.accumulation=per_user (num acumulador global, quem completa o limite não é "dono" das curtidas)');
  if (c.likes?.targetPolicy === 'proportional_choice' && c.likes.accumulation !== 'global') e.push('likes.targetPolicy=proportional_choice exige likes.accumulation=global');
  if (!Array.isArray(c.names?.blocklist)) e.push('names.blocklist deve ser lista');
  if (c.likes?.accumulation === 'per_user' && c.likes.mode === 'cumulative') e.push('likes.accumulation=per_user não é compatível com mode=cumulative (o total da fonte é da sala)');
  posInt(c.presentation?.maxConcurrent, 'presentation.maxConcurrent');
  posNum(c.presentation?.speed, 'presentation.speed');
  posInt(c.presentation?.groupThreshold, 'presentation.groupThreshold');
  posInt(c.presentation?.groupBatchSize, 'presentation.groupBatchSize');
  posInt(c.reconnect?.initialMs, 'reconnect.initialMs');
  posInt(c.reconnect?.maxMs, 'reconnect.maxMs');
  posInt(c.dedupe?.memoryWindow, 'dedupe.memoryWindow');
  posInt(c.limits?.maxUnitsPerEvent, 'limits.maxUnitsPerEvent');
  posInt(c.limits?.maxLikesPerEvent, 'limits.maxLikesPerEvent');
  return e;
}

/** Configurações editáveis pelo administrador; validadas e persistidas. */
export class AdminConfigService {
  private cfg: GameConfig;
  constructor(private readonly db: PersistenceService, private readonly bus: EventBus, initial?: Partial<GameConfig> | Json) {
    const stored = db.loadConfig();
    this.cfg = deepMerge(deepMerge(DEFAULT_CONFIG, stored ?? {}), initial ?? {});
    const errs = validateConfig(this.cfg);
    if (errs.length) throw new ConfigError(errs);
    db.saveConfig(this.cfg);
  }

  get(): Readonly<GameConfig> {
    return this.cfg;
  }

  update(patch: Json): Readonly<GameConfig> {
    const next = deepMerge(this.cfg, patch);
    const errs = validateConfig(next);
    if (errs.length) throw new ConfigError(errs);
    this.cfg = next;
    this.db.saveConfig(next);
    this.bus.emit('config.updated', { keys: Object.keys(patch) });
    return this.cfg;
  }

  setLikeThreshold(n: number): void {
    this.update({ likes: { threshold: n } });
  }
}
