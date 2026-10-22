import { randomBytes } from 'node:crypto';
import { ElectionEngine } from './electionEngine.js';
import { HealthMonitor } from './healthMonitor.js';
import { createLogger } from './logger.js';
import { LULA_FLAVIO_PRESET } from './preset.js';
import { TimerAnimator } from './presentationQueue.js';
import { SimulatedSource } from './sources/simulatedSource.js';
import { TikTokLiveAdapter } from './sources/tiktokLiveAdapter.js';
import { SimulationRunner } from './simulation/simulationRunner.js';
import type { Mode } from './types.js';
import { GameWsServer } from './wsServer.js';

try {
  process.loadEnvFile('.env'); // TIKTOK_USERNAME, TIKTOK_SIGN_API_KEY (opcional). O arquivo .env é ignorado pelo git.
} catch {
  /* sem .env: usa o ambiente */
}

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=') as [string, string]));
const mode = (args.mode ?? 'simulation') as Mode;
const log = createLogger('main', (process.env.LOG_LEVEL as any) ?? 'info');

async function main() {
  const engine = new ElectionEngine({ dbPath: args.db ?? `data/${mode}.db`, mode, logger: log, config: LULA_FLAVIO_PRESET });
  const health = new HealthMonitor(engine);
  const ws = new GameWsServer(engine, Number(args.port ?? process.env.WS_PORT ?? 8787), '127.0.0.1', new TimerAnimator(() => engine.admin.get()));
  ws.adminToken = process.env.ADMIN_TOKEN || randomBytes(12).toString('hex');
  ws.extraStatus = () => health.snapshot();
  engine.presentation.animator = ws.animator; // a cena confirma (ACK) cada etapa; sem cena conectada, usa temporizador
  const port = await ws.start();
  log.info(`Cena (adicione como fonte de navegador/janela): http://127.0.0.1:${port}/`, { port });
  log.info(`Painel admin (encerrar/zerar): http://127.0.0.1:${port}/admin.html#token=${ws.adminToken}`);
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
    let cancelled = false;
    void (async () => {
      let round = 0;
      do {
        const runner = new SimulationRunner({
          seed: Number(args.seed ?? 42) + round,
          viewers: 120,
          candidateCommands: cfg.election.candidates.map((c) => c.command),
          candidateIds: cfg.election.candidates.map((c) => c.id),
          likeStyle: 'both',
          disconnectEvery: 400,
          bareRate: 0.5,
          mix: { chat: 14, rose: 30, special: 4, unknownGift: 1, combo: 6, likes: 18, noChoiceGift: 4 },
        });
        const scenario = runner.generate(Number(args.events ?? 300));
        for (const s of scenario.steps) {
          if (cancelled) return;
          if (s.t === 'event') source.emit(s.raw);
          else if (s.t === 'disconnect') source.disconnect();
          else if (s.t === 'reconnect') source.reconnect();
          await new Promise((r) => setTimeout(r, Number(args.paceMs ?? 50)));
        }
        log.info('rodada de simulação concluída', { round, stats: scenario.stats });
        round++;
      } while (args.loop === 'true' && !cancelled);
    })();
    stop = async () => {
      cancelled = true;
      await source.stop();
    };
  } else {
    const username = process.env.TIKTOK_USERNAME;
    if (!username) throw new Error('Defina TIKTOK_USERNAME no arquivo .env (ex.: TIKTOK_USERNAME=@seuusuario).');
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
