import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import type { BusMessage } from './eventBus.js';
import type { ElectionEngine } from './electionEngine.js';
import type { VoterAnimator } from './presentationQueue.js';
import { InstantAnimator } from './presentationQueue.js';
import type { Voter } from './types.js';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
};

type Phase = 'approach' | 'vote';

/** Só aceita Host local: bloqueia DNS rebinding e acesso por outro nome/IP. */
export function isLocalHost(h: string | undefined): boolean {
  if (!h) return false;
  const host = h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0];
  return ['127.0.0.1', 'localhost', '[::1]'].includes(host.toLowerCase());
}
function readBody(req: IncomingMessage, max = 4096): Promise<string> {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > max) { reject(new Error('corpo grande demais')); req.destroy(); } });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}

/**
 * Animador dirigido pela cena: aguarda o ACK da interface ao fim da caminhada e ao fim da votação.
 * Sem nenhuma cena (overlay) conectada, cai no animador de reserva (temporizador/instantâneo).
 * Se a cena conectada não responder no prazo, o eleitor vira `failed` — o voto já está confirmado e intacto.
 */
export class WsAnimator implements VoterAnimator {
  private waits = new Map<string, { phase: Phase; resolve: () => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  readonly inflight = new Map<string, { phase: Phase; voter: Voter }>();
  constructor(private readonly hasOverlay: () => boolean, private readonly fallback: VoterAnimator = new InstantAnimator(), private readonly timeoutMs = 25000) {}

  approach(v: Voter): Promise<void> {
    return this.wait(v, 'approach');
  }
  vote(v: Voter): Promise<void> {
    return this.wait(v, 'vote');
  }

  private wait(v: Voter, phase: Phase): Promise<void> {
    if (!this.hasOverlay()) return phase === 'approach' ? this.fallback.approach(v) : this.fallback.vote(v);
    this.inflight.set(v.id, { phase, voter: v });
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waits.delete(v.id);
        this.inflight.delete(v.id);
        reject(new Error(`cena não confirmou (${phase}) em ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.waits.set(v.id, { phase, resolve: () => { clearTimeout(timer); this.inflight.delete(v.id); resolve(); }, reject, timer });
    });
  }

  /** ACK vindo da cena. Só avança a apresentação; não toca em votos. */
  ack(voterId: string, phase: Phase): boolean {
    const w = this.waits.get(voterId);
    if (!w || w.phase !== phase) return false;
    this.waits.delete(voterId);
    w.resolve();
    return true;
  }

  /** Quando a última cena cai, libera quem estava esperando (segue pelo reserva em vez de falhar). */
  releaseAll(): void {
    for (const [id, w] of [...this.waits]) {
      this.waits.delete(id);
      w.resolve();
    }
    this.inflight.clear();
  }
}

/**
 * Servidor HTTP + WebSocket do motor.
 *  - GET /            → cena (public/index.html); GET /assets/* → imagens e áudio
 *  - GET /api/state   → snapshot JSON
 *  - WS  /            → eventos do barramento (somente leitura). A única mensagem aceita dos clientes é
 *                       `hello` (role=overlay) e `ack` (avanço da apresentação). Nada cria ou altera votos.
 * Escuta em 127.0.0.1 por padrão.
 */
export class GameWsServer {
  private http?: Server;
  private wss?: WebSocketServer;
  private off?: () => void;
  private overlays = new Set<WebSocket>();
  readonly animator: WsAnimator;
  /** Token do painel admin. Sem token, os endpoints /api/admin/* ficam desativados. */
  adminToken?: string;
  /** Informações extras no status do admin (ex.: saúde da conexão). */
  extraStatus?: () => unknown;

  constructor(private readonly engine: ElectionEngine, private readonly port = 8787, private readonly host = '127.0.0.1', fallback?: VoterAnimator) {
    this.animator = new WsAnimator(() => this.overlays.size > 0, fallback);
  }

  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname.startsWith('/api/admin/')) {
        await this.admin(req, res, url.pathname);
        return;
      }
      if (url.pathname === '/api/state') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(this.engine.snapshot()));
        return;
      }
      const rel = normalize(decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)).replace(/^([/\\])+/, '');
      const file = join(PUBLIC_DIR, rel);
      if (!file.startsWith(PUBLIC_DIR.endsWith(sep) ? PUBLIC_DIR : PUBLIC_DIR + sep) || rel.includes('..')) {
        res.writeHead(403).end('forbidden');
        return;
      }
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-cache' }).end(data);
    } catch {
      res.writeHead(404).end('not found');
    }
  }

  private async admin(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    const json = (code: number, body: unknown): void => void res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
    const given = Buffer.from(String(req.headers['x-admin-token'] ?? ''));
    const want = Buffer.from(this.adminToken ?? '');
    if (!this.adminToken || !isLocalHost(req.headers.host) || given.length !== want.length || !timingSafeEqual(given, want)) return json(403, { error: 'não autorizado' });
    const e = this.engine;
    if (path === '/api/admin/status' && req.method === 'GET') {
      return json(200, { snapshot: e.snapshot(), metrics: e.metrics.snapshot(), queue: e.queue.stats(), integrity: e.ranking.verifyIntegrity(), voters: e.db.voterStats(e.election.id), config: { likeThreshold: e.admin.get().likes.threshold }, health: this.extraStatus?.() ?? null, overlays: this.overlays.size });
    }
    if (req.method !== 'POST') return json(405, { error: 'método' });
    if (path === '/api/admin/finish') {
      const r = await e.runExclusive(() => e.finish());
      return json(200, { ok: true, ranking: r.ranking });
    }
    if (path === '/api/admin/new') return json(200, { ok: true, ...(await e.startNewElection()) });
    if (path === '/api/admin/likes-threshold') {
      const v = Number(JSON.parse((await readBody(req)) || '{}').value);
      try { e.admin.setLikeThreshold(v); } catch (err) { return json(400, { error: (err as Error).message }); }
      return json(200, { ok: true, threshold: v });
    }
    return json(404, { error: 'rota' });
  }

  async start(): Promise<number> {
    this.http = createServer((req, res) => void this.serve(req, res));
    this.wss = new WebSocketServer({
      server: this.http,
      verifyClient: ({ req }: { req: IncomingMessage }) => {
        if (!isLocalHost(req.headers.host)) return false;
        const origin = req.headers.origin; // páginas de outros sites não podem se conectar
        if (origin) { try { if (!isLocalHost(new URL(origin).host)) return false; } catch { return false; } }
        return true;
      },
    });
    await new Promise<void>((res, rej) => {
      this.http!.once('error', rej);
      this.http!.listen(this.port, this.host, () => res());
    });
    this.wss.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'snapshot', ts: Date.now(), data: this.engine.snapshot() }));
      ws.on('message', (raw) => {
        let m: any;
        try { m = JSON.parse(String(raw)); } catch { return; }
        if (m?.type === 'hello' && m.role === 'overlay') {
          this.overlays.add(ws);
          // reenvia o eleitor em andamento para uma cena que acabou de conectar
          for (const { phase, voter } of this.animator.inflight.values()) {
            ws.send(JSON.stringify({ seq: 0, type: phase === 'approach' ? 'voter.approaching' : 'voter.voting', ts: Date.now(), data: { ...this.engine.voters.snapshot(voter), replay: true } }));
          }
        } else if (m?.type === 'ack' && this.overlays.has(ws) && typeof m.voterId === 'string' && (m.phase === 'approach' || m.phase === 'vote')) {
          this.animator.ack(m.voterId, m.phase);
        }
      });
      ws.on('close', () => {
        this.overlays.delete(ws);
        if (this.overlays.size === 0) this.animator.releaseAll();
      });
      ws.on('error', () => {});
    });
    this.off = this.engine.bus.on('*', (m: BusMessage) => {
      const payload = JSON.stringify(m);
      if (m.type === 'election.started') {
        // nova eleição: todas as cenas recebem um estado zerado
        const snap = JSON.stringify({ type: 'snapshot', ts: Date.now(), data: this.engine.snapshot() });
        for (const c of this.wss!.clients) if (c.readyState === WebSocket.OPEN) c.send(snap);
        return;
      }
      for (const c of this.wss!.clients) if (c.readyState === WebSocket.OPEN) c.send(payload);
    });
    const addr = this.http.address();
    return typeof addr === 'object' && addr ? addr.port : this.port;
  }

  async stop(): Promise<void> {
    this.off?.();
    this.animator.releaseAll();
    for (const c of this.wss?.clients ?? []) c.terminate();
    await new Promise<void>((r) => (this.wss ? this.wss.close(() => r()) : r()));
    await new Promise<void>((r) => (this.http ? this.http.close(() => r()) : r()));
  }
}
