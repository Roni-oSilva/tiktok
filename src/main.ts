import { ElectionEngine } from './electionEngine.js';
import { HealthMonitor } from './healthMonitor.js';
import { createLogger } from './logger.js';
import { SimulatedSource } from './sources/simulatedSource.js';
import { TikTokLiveAdapter } from './sources/tiktokLiveAdapter.js';
import { SimulationRunner } from './simulation/simulationRunner.js';
import type { Mode } from './types.js';
import { GameWsServer } from './wsServer.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=') as [string, string]));
const mode = (args.mode ?? 'simulation') as Mode;
const log = createLogger('main', (process.env.LOG_LEVEL as any) ?? 'info');

async function main() {
  const engine = new ElectionEngine({ dbPath: args.db ?? `data/${mode}.db`, mode, logger: log });
  const health = new HealthMonitor(engine);
  const ws = new GameWsServer(engine, Number(args.port ?? process.env.WS_PORT ?? 8787));
  const port = await ws.start();
  log.info('WebSocket do motor ativo (somente leitura)', { host: '127.0.0.1', port });
  const recovered = engine.recoverPending();
  if (recovered) log.info('eleitores pendentes reapresentados', { count: recovered });
  health.start();
  engine.bus.on('election.updated', (m) => {
    const r = (m.data as any).ranking;
    log.info('ranking', { top: r.entries.map((e: any) => `${e.position}.${e.name}=${e.votes} (${e.percent}%)`) });
  });

  let stop: () => Promise<void>;
  if (mode === 'simulation') {
    process.stderr.write('\n*** MODO SIMULAÇÃO: todos os eventos são FICTÍCIOS e não vêm de uma transmissão real ***\n\n');
    const source = new SimulatedSource((raw) => void engine.ingest(raw).then(() => health.noteEvent()), health.onStatus);
    await source.start();
    const cfg = engine.admin.get();
    const runner = new SimulationRunner({
      seed: Number(args.seed ?? 42),
      candidateCommands: cfg.election.candidates.map((c) => c.command),
      candidateIds: cfg.election.candidates.map((c) => c.id),
      likeStyle: 'both',
      disconnectEvery: 400,
    });
    const scenario = runner.generate(Number(args.events ?? 300));
    let cancelled = false;
    void (async () => {
      for (const s of scenario.steps) {
        if (cancelled) return;
        if (s.t === 'event') source.emit(s.raw);
        else if (s.t === 'disconnect') source.disconnect();
        else if (s.t === 'reconnect') source.reconnect();
        await new Promise((r) => setTimeout(r, Number(args.paceMs ?? 50)));
      }
      log.info('simulação concluída', { stats: scenario.stats });
    })();
    stop = async () => {
      cancelled = true;
      await source.stop();
    };
  } else {
    const username = process.env.TIKTOK_USERNAME;
    if (!username) throw new Error('Defina TIKTOK_USERNAME (e, se necessário, TIKTOK_SIGN_API_KEY) para o modo live.');
    const adapter = new TikTokLiveAdapter({
      username,
      signApiKey: process.env.TIKTOK_SIGN_API_KEY,
      reconnect: engine.admin.get().reconnect,
      logger: log,
      onStatus: health.onStatus,
      sink: (raw) => void engine.ingest(raw).then(() => health.noteEvent()),
    });
    await adapter.start();
    stop = () => adapter.stop();
  }

  const shutdown = async () => {
    log.info('encerrando');
    await stop();
    health.stop();
    await ws.stop();
    await engine.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  log.error('falha fatal', { error: (e as Error).message });
  process.exit(1);
});
