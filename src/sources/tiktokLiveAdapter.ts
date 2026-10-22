import type { GameConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { EventSource, SourceStatus } from '../types.js';
import { normalizeChat, normalizeGift, normalizeLike } from './inputNormalizer.js';

/** Superfície mínima usada da biblioteca (permite trocar de biblioteca e testar sem rede). */
export interface LiveConnection {
  connect(): Promise<unknown>;
  disconnect(): Promise<unknown> | void;
  on(event: string, cb: (...args: any[]) => void): unknown;
  removeAllListeners?(): unknown;
}
export type ConnectionFactory = (username: string, opts: { signApiKey?: string }) => Promise<LiveConnection> | LiveConnection;

export interface AdapterOptions {
  username: string;
  sink: (raw: unknown) => void;
  reconnect: GameConfig['reconnect'];
  onStatus?: (s: SourceStatus) => void;
  logger: Logger;
  /** Chave do serviço de assinatura (Euler Stream). Lida de TIKTOK_SIGN_API_KEY; jamais logada. */
  signApiKey?: string;
  factory?: ConnectionFactory;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/** Fábrica padrão: importa a biblioteca só quando necessário (fica isolada neste arquivo). */
export const defaultFactory: ConnectionFactory = async (username, opts) => {
  const lib = await import('tiktok-live-connector');
  return new lib.TikTokLiveConnection(username, opts.signApiKey ? { signApiKey: opts.signApiKey } : {}) as unknown as LiveConnection;
};

/** Backoff exponencial limitado, com jitter ±`jitter`. attempt começa em 1. */
export function backoffDelay(attempt: number, r: GameConfig['reconnect'], rand: () => number = Math.random): number {
  const base = Math.min(r.maxMs, r.initialMs * Math.pow(r.factor, attempt - 1));
  const j = 1 + (rand() * 2 - 1) * r.jitter;
  return Math.max(0, Math.round(base * j));
}

/**
 * Adaptador do TikTok LIVE. Conecta, normaliza eventos e reconecta com espera progressiva.
 * NÃO há garantia de entrega: eventos emitidos enquanto estiver desconectado são perdidos
 * (a biblioteca não reenvia histórico), exceto o contador cumulativo de curtidas, que recupera o aumento.
 */
export class TikTokLiveAdapter implements EventSource {
  private conn: LiveConnection | null = null;
  private stopped = true;
  private attempt = 0;
  private generation = 0;
  private reconnecting = false;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly o: AdapterOptions) {
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.connectLoop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.generation++;
    const c = this.conn;
    this.conn = null;
    try {
      c?.removeAllListeners?.();
      await c?.disconnect();
    } catch {
      /* ignorado ao parar */
    }
    this.status({ state: 'stopped' });
  }

  private status(s: SourceStatus): void {
    this.o.onStatus?.(s);
  }

  private async connectLoop(): Promise<void> {
    if (this.reconnecting) return;
    this.reconnecting = true;
    try {
      while (!this.stopped) {
        const gen = ++this.generation;
        this.status({ state: this.attempt === 0 ? 'connecting' : 'reconnecting', attempt: this.attempt });
        try {
          const conn = await (this.o.factory ?? defaultFactory)(this.o.username, { signApiKey: this.o.signApiKey });
          this.wire(conn, gen);
          this.conn = conn;
          await conn.connect();
          if (this.stopped || gen !== this.generation) return;
          this.attempt = 0;
          this.status({ state: 'connected' });
          return;
        } catch (e) {
          this.attempt++;
          const max = this.o.reconnect.maxAttempts;
          const msg = errMsg(e);
          this.o.logger.warn('falha ao conectar ao TikTok LIVE', { attempt: this.attempt, error: msg });
          this.safeDrop();
          if (max > 0 && this.attempt >= max) {
            this.status({ state: 'failed', attempt: this.attempt, error: msg });
            return;
          }
          const delay = backoffDelay(this.attempt, this.o.reconnect, this.o.random);
          this.status({ state: 'reconnecting', attempt: this.attempt, error: msg, nextDelayMs: delay });
          await this.sleep(delay);
        }
      }
    } finally {
      this.reconnecting = false;
    }
  }

  private safeDrop(): void {
    const c = this.conn;
    this.conn = null;
    try {
      c?.removeAllListeners?.();
      void Promise.resolve(c?.disconnect()).catch(() => {});
    } catch {
      /* noop */
    }
  }

  private wire(conn: LiveConnection, gen: number): void {
    const live = () => !this.stopped && gen === this.generation;
    const push = (fn: () => unknown) => {
      if (!live()) return;
      try {
        this.o.sink(fn());
      } catch (e) {
        this.o.logger.error('falha ao normalizar evento da biblioteca', { error: errMsg(e) });
      }
    };
    conn.on('gift', (d: any) => push(() => normalizeGift(d)));
    conn.on('like', (d: any) => push(() => normalizeLike(d)));
    conn.on('chat', (d: any) => push(() => normalizeChat(d)));
    conn.on('disconnected', () => {
      if (!live()) return;
      this.status({ state: 'disconnected' });
      this.safeDrop();
      void this.connectLoop();
    });
    conn.on('streamEnd', () => this.o.logger.info('transmissão encerrada pela plataforma'));
    // O evento 'error' da biblioteca não derruba o processo; falhas de conexão chegam por connect()/disconnected.
    conn.on('error', (e: unknown) => this.o.logger.warn('erro reportado pela biblioteca', { error: errMsg(e) }));
  }
}

function errMsg(e: unknown): string {
  const m = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return m.replace(/(sessionid|token|cookie|apikey|api_key)=[^\s&;]+/gi, '$1=[REDACTED]').slice(0, 300);
}
