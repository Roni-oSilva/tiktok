export type Mode = 'live' | 'simulation';
export type EventSourceName = 'tiktok' | 'simulation';

export interface Viewer {
  /** Identificador estável fornecido pela integração. Nunca derivado do nome. */
  userId?: string;
  uniqueId?: string;
  displayName?: string;
}

interface BaseInput {
  source: EventSourceName;
  /** true = evento fictício gerado pelo simulador (nunca veio de uma live real). */
  simulated: boolean;
  /** Identificador do evento fornecido pela fonte (ex.: msgId), quando existir. */
  eventId?: string;
  /** Epoch em ms informado pela fonte, quando existir. */
  ts?: number;
  viewer: Viewer;
}

export interface GiftInput extends BaseInput {
  kind: 'gift';
  giftId?: string;
  giftName?: string;
  /** giftType === 1 na biblioteca: presente que pode formar sequência (combo). */
  streakable?: boolean;
  /** Contador cumulativo da sequência (ou quantidade do evento, se não for combo). */
  repeatCount: number;
  repeatEnd?: boolean;
  groupId?: string;
}

export interface LikeInput extends BaseInput {
  kind: 'like';
  /** Lote incremental de curtidas deste evento. */
  likeCount?: number;
  /** Contador cumulativo informado pela fonte (total da sala). */
  totalLikeCount?: number;
}

export interface ChatInput extends BaseInput {
  kind: 'chat';
  text: string;
}

export type InputEvent = GiftInput | LikeInput | ChatInput;

export type VoterState = 'queued' | 'approaching' | 'voting' | 'completed' | 'rejected' | 'failed';
export type VoterOrigin = 'gift' | 'likes';

export interface Voter {
  id: string;
  seq: number;
  electionId: string;
  displayName: string;
  origin: VoterOrigin;
  sourceEventKey: string;
  userId: string | null;
  candidateId: string | null;
  votes: number;
  units: number;
  state: VoterState;
  voteConfirmed: boolean;
  participationOnly: boolean;
  createdAt: number;
  completedAt: number | null;
  failureReason: string | null;
  simulated: boolean;
}

export interface VoterSpec {
  displayName: string;
  origin: VoterOrigin;
  userId: string | null;
  candidateId: string | null;
  votes: number;
  units: number;
  participationOnly: boolean;
}

export type Outcome =
  | 'accepted' // gerou eleitor(es)
  | 'accumulated' // curtidas contabilizadas, ainda abaixo do limite
  | 'baseline' // primeiro contador cumulativo: apenas referência
  | 'duplicate'
  | 'invalid'
  | 'rejected_closed'
  | 'rejected_mode'
  | 'no_candidate'
  | 'unknown_gift'
  | 'no_new_units'
  | 'stale_total'
  | 'command_applied'
  | 'command_rejected'
  | 'ignored_chat'
  | 'failed';

export interface IngestResult {
  outcome: Outcome;
  detail?: string;
  voterIds: string[];
  votes: number;
}

export interface Candidate {
  id: string;
  name: string;
  command: string;
  order: number;
  status: 'active' | 'withdrawn';
  /** Votos válidos (derivado do livro de votos). */
  votes: number;
  /** Pontos de bônus: campo separado, NUNCA somado aos votos. */
  points: number;
  /** Efeitos especiais (apenas dados para a futura interface). */
  effects: string[];
  supporters: number;
  giftUnits: number;
  /** Seq do último voto que alterou o total (critério de desempate). */
  lastVoteSeq: number;
  history: { seq: number; delta: number; total: number; ts: number }[];
}

export interface RankingEntry {
  position: number;
  candidateId: string;
  name: string;
  votes: number;
  percent: number;
  points: number;
  effects: string[];
  supporters: number;
  giftUnits: number;
  diffToLeader: number;
  diffToNext: number;
}

export interface Ranking {
  totalValidVotes: number;
  entries: RankingEntry[];
}

export interface SourceStatus {
  state: 'connecting' | 'connected' | 'disconnected' | 'reconnecting' | 'failed' | 'stopped';
  attempt?: number;
  error?: string;
  nextDelayMs?: number;
}

export interface EventSource {
  start(): Promise<void>;
  stop(): Promise<void>;
}
