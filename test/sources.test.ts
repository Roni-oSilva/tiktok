import { afterAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { HealthMonitor } from '../src/healthMonitor.js';
import { silentLogger } from '../src/logger.js';
import { SimulationRunner } from '../src/simulation/simulationRunner.js';
import { SimulatedSource } from '../src/sources/simulatedSource.js';
import { backoffDelay, TikTokLiveAdapter, type LiveConnection } from '../src/sources/tiktokLiveAdapter.js';
import { normalizeGift, normalizeLike } from '../src/sources/inputNormalizer.js';
import { GameWsServer } from '../src/wsServer.js';
import { cleanup, counts, makeEngine, rose, chat, tmpDb, votesOf } from './helpers.js';
import { EventEmitter } from 'node:events';
import { DEFAULT_CONFIG } from '../src/config.js';

afterAll(cleanup);

class FakeConn extends EventEmitter implements LiveConnection {
  static instances: FakeConn[] = [];
  static failNext = 0;
  connected = false;
  constructor() { super(); FakeConn.instances.push(this); }
  async connect() {
    if (FakeConn.failNext > 0) { FakeConn.failNext--; throw new Error('UserOfflineError: sala offline (simulado)'); }
    this.connected = true;
  }
  disconnect() { this.connected = false; }
}

describe('Teste 20 — reconexão (adaptador real com conexão falsa)', () => {
  it('reconecta com espera progressiva e o estado do jogo permanece íntegro', async () => {
    FakeConn.instances = [];
    FakeConn.failNext = 2;
    const e = makeEngine({ mode: 'live', dbPath: tmpDb() });
    const health = new HealthMonitor(e);
    const delays: number[] = [];
    const statuses: string[] = [];
    const adapter = new TikTokLiveAdapter({
      username: 'alguem', logger: silentLogger, reconnect: { ...DEFAULT_CONFIG.reconnect, jitter: 0 },
      factory: () => new FakeConn(), sleep: async (ms) => { delays.push(ms); },
      onStatus: (s) => { statuses.push(s.state); health.onStatus(s); },
      sink: (raw) => void e.ingest(raw),
    });
    await adapter.start();
    expect(delays).toEqual([1000, 2000]);
    expect(statuses.at(-1)).toBe('connected');

    const live = (): FakeConn => FakeConn.instances.at(-1)!;
    const user = { userId: 'u1', uniqueId: 'u1', nickname: 'Ana' };
    // Os eventos reais ainda precisam ser "tiktok/simulated=false": usamos o modo live aqui
    live().emit('chat', { user, comment: '!votar candidato1', msgId: 'm1' });
    live().emit('gift', { user, giftId: 5655, giftDetails: { giftName: 'Rose', giftType: 1 }, repeatCount: 1, repeatEnd: false, groupId: 'g1', msgId: 'm2' });
    await e.drain();
    expect(votesOf(e).candidato1).toBe(1);

    // queda da conexão -> nova conexão; evento duplicado/antigo da conexão antiga é ignorado
    const old = live();
    old.emit('disconnected');
    await new Promise((r) => setTimeout(r, 10));
    expect(FakeConn.instances.length).toBeGreaterThan(3);
    expect(live()).not.toBe(old);
    old.emit('gift', { user, giftId: 5655, giftDetails: { giftName: 'Rose', giftType: 1 }, repeatCount: 5, repeatEnd: true, groupId: 'g1', msgId: 'zumbi' });
    // combo continua na nova conexão: fim do combo conta só o delta
    live().emit('gift', { user, giftId: 5655, giftDetails: { giftName: 'Rose', giftType: 1 }, repeatCount: 3, repeatEnd: true, groupId: 'g1', msgId: 'm3' });
    live().emit('gift', { user, giftId: 5655, giftDetails: { giftName: 'Rose', giftType: 1 }, repeatCount: 3, repeatEnd: true, groupId: 'g1', msgId: 'm3' }); // reenvio
    await e.drain();
    expect(votesOf(e).candidato1).toBe(3);
    expect(e.ranking.verifyIntegrity().ok).toBe(true);
    expect(health.reconnects).toBeGreaterThanOrEqual(0);
    await adapter.stop();
  });

  it('respeita o limite de tentativas e o teto do backoff', async () => {
    FakeConn.failNext = 100;
    const states: string[] = [];
    const a = new TikTokLiveAdapter({
      username: 'x', logger: silentLogger, reconnect: { initialMs: 100, maxMs: 500, factor: 2, jitter: 0, maxAttempts: 5 },
      factory: () => new FakeConn(), sleep: async () => {}, onStatus: (s) => states.push(s.state), sink: () => {},
    });
    await a.start();
    expect(states.at(-1)).toBe('failed');
    expect([1, 2, 3, 4, 5, 6].map((n) => backoffDelay(n, { initialMs: 100, maxMs: 500, factor: 2, jitter: 0, maxAttempts: 0 }))).toEqual([100, 200, 400, 500, 500, 500]);
    FakeConn.failNext = 0;
  });

  it('fonte simulada: eventos durante a queda são perdidos (sem garantia de entrega) e o estado segue consistente', async () => {
    const e = makeEngine();
    const h = new HealthMonitor(e);
    const src = new SimulatedSource((raw) => void e.ingest(raw), h.onStatus);
    await src.start();
    src.emit(chat(1, 'candidato1'));
    src.emit(rose(1));
    src.disconnect();
    expect(src.emit(rose(1))).toBe(false);
    src.reconnect();
    src.emit(rose(1));
    await e.drain();
    expect(votesOf(e).candidato1).toBe(2);
    expect(src.dropped).toBe(1);
    expect(h.reconnects).toBe(1);
    expect(h.disconnects).toBe(1);
    expect(h.checkIntegrity().ok).toBe(true);
  });
});

describe('Normalizador da biblioteca', () => {
  it('mapeia campos documentados e não inventa identidade', () => {
    const g = normalizeGift({ user: { uniqueId: 'a', nickname: 'Ana' }, giftId: 5655, giftDetails: { giftType: 1, giftName: 'Rose' }, repeatCount: 3, repeatEnd: 1 });
    expect(g).toMatchObject({ giftId: '5655', giftName: 'Rose', streakable: true, repeatCount: 3, repeatEnd: true, simulated: false, source: 'tiktok' });
    expect(g.viewer).toEqual({ userId: undefined, uniqueId: 'a', displayName: 'Ana' });
    const l = normalizeLike({ likeCount: 15, totalLikeCount: '12345' });
    expect(l).toMatchObject({ likeCount: 15, totalLikeCount: 12345, viewer: {} });
  });
});

describe('Simulador', () => {
  const mk = (seed: number, extra = {}) => {
    const cfg = DEFAULT_CONFIG.election.candidates;
    return new SimulationRunner({ seed, candidateCommands: cfg.map((c) => c.command), candidateIds: cfg.map((c) => c.id), ...extra });
  };
  it('é reproduzível por semente e marca tudo como fictício', () => {
    const a = mk(7).generate(300);
    const b = mk(7).generate(300);
    const c = mk(8).generate(300);
    expect(JSON.stringify(a.steps)).toBe(JSON.stringify(b.steps));
    expect(JSON.stringify(a.steps)).not.toBe(JSON.stringify(c.steps));
    for (const s of a.steps) if (s.t === 'event' && s.label !== 'invalid') expect(s.raw).toMatchObject({ simulated: true, source: 'simulation' });
  });
  for (const style of ['incremental', 'cumulative', 'both'] as const) {
    it(`motor e oráculo independente concordam (curtidas ${style}, duplicados, inválidos, fora de ordem, quedas, reinícios)`, async () => {
      const path = tmpDb();
      let e = makeEngine({ dbPath: path });
      const sc = mk(1234, { likeStyle: style, reorderRate: 0.3, disconnectEvery: 50, restartEvery: 70, duplicateRate: 0.1, invalidRate: 0.05 }).generate(1500);
      let connected = true;
      const total = { dup: 0 };
      await mk(1).play(sc.steps, {
        deliver: async (raw) => { const r = await e.ingest(raw); if (r.outcome === 'duplicate') total.dup++; return r; },
        isConnected: () => connected,
        onDisconnect: () => { connected = false; },
        onReconnect: () => { connected = true; },
        onRestart: async () => { await e.close(); e = makeEngine({ dbPath: path }); },
      });
      await e.drain();
      const votes = votesOf(e);
      expect(votes).toEqual(sc.oracle.votesByCandidate);
      const stats = e.db.voterStats(e.election.id);
      expect(stats.byOrigin.gift ?? 0).toBe(sc.oracle.giftVoters);
      expect(stats.byOrigin.likes ?? 0).toBe(sc.oracle.likeVoters);
      expect(e.db.likeTotals(e.election.id)).toMatchObject({ counted: sc.oracle.likesCounted, balance: sc.oracle.likeBalance });
      expect(e.ranking.verifyIntegrity().ok).toBe(true);
      expect(sc.stats.duplicatesInjected).toBeGreaterThan(0);
      expect(sc.stats.invalidInjected).toBeGreaterThan(0);
      expect(sc.stats.restarts).toBeGreaterThan(0);
      expect(sc.stats.lost).toBeGreaterThan(0);
    });
  }
});

describe('WebSocket para a futura interface', () => {
  it('envia snapshot + eventos, é somente leitura e marca simulação', async () => {
    const e = makeEngine();
    const ws = new GameWsServer(e, 0);
    const port = await ws.start();
    const msgs: any[] = [];
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((res) => client.on('message', (d) => { msgs.push(JSON.parse(String(d))); if (msgs.length === 1) res(); }));
    expect(msgs[0].type).toBe('snapshot');
    expect(msgs[0].data.simulated).toBe(true);
    expect(msgs[0].data.notice).toMatch(/SIMULAÇÃO/);
    client.send(JSON.stringify({ kind: 'gift', hack: 'tentando votar pelo cliente' }));
    await e.ingest(chat(1, 'candidato1'));
    await e.ingest(rose(1));
    await e.drain();
    await new Promise((r) => setTimeout(r, 50));
    const types = msgs.map((m) => m.type);
    expect(types).toContain('candidate.vote_received');
    expect(types).toContain('voter.completed');
    expect(counts(e).votes).toBe(1);
    const seqs = msgs.slice(1).map((m) => m.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    client.close();
    await ws.stop();
  });
});
