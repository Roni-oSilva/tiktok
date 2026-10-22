import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ElectionEngine } from '../src/electionEngine.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { silentLogger } from '../src/logger.js';
import { SimulationRunner } from '../src/simulation/simulationRunner.js';

const arg = (k: string, d: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const LOGICAL = Number(arg('events', '10000'));
const SEED = Number(arg('seed', '2024'));
const CONC = Number(arg('burst', '500'));

const dir = mkdtempSync(join(tmpdir(), 'loadtest-'));
const dbPath = join(dir, 'load.db');
const open = () => new ElectionEngine({ dbPath, mode: 'simulation', logger: silentLogger, config: { presentation: { enabled: false } } });

async function main() {
  let engine = open();
  const cands = DEFAULT_CONFIG.election.candidates;
  const runner = new SimulationRunner({
    seed: SEED, viewers: 500, candidateCommands: cands.map((c) => c.command), candidateIds: cands.map((c) => c.id),
    likeStyle: 'both', duplicateRate: 0.06, invalidRate: 0.03, reorderRate: 0.2, disconnectEvery: 1500, restartEvery: 3500,
    mix: { chat: 12, rose: 35, special: 6, unknownGift: 3, combo: 8, likes: 25, noChoiceGift: 8 },
  });
  const sc = runner.generate(LOGICAL);

  // métricas somadas entre reinicializações (o objeto Metrics vive na memória do processo)
  const acc: Record<string, number> = {};
  const addMetrics = (e: ElectionEngine) => {
    for (const [k, v] of Object.entries(e.metrics.snapshot())) if (typeof v === 'number') acc[k] = (acc[k] ?? 0) + v;
  };
  const outcomes: Record<string, number> = {};
  const addOutcomes = (e: ElectionEngine) => { for (const [k, v] of Object.entries(e.metrics.byOutcome)) outcomes[k] = (outcomes[k] ?? 0) + v; };

  let connected = true;
  let restarts = 0;
  const t0 = process.hrtime.bigint();
  await runner.play(sc.steps, {
    deliver: (raw) => engine.ingest(raw),
    isConnected: () => connected,
    onDisconnect: () => { connected = false; },
    onReconnect: () => { connected = true; },
    onRestart: async () => { await engine.drain(); addMetrics(engine); addOutcomes(engine); await engine.close(); engine = open(); restarts++; },
  }, { concurrent: CONC });
  const tIngest = process.hrtime.bigint();
  await engine.drain();
  const t1 = process.hrtime.bigint();
  addMetrics(engine); addOutcomes(engine);

  const secs = Number(t1 - t0) / 1e9;
  const integrity = engine.ranking.verifyIntegrity();
  const votes = Object.fromEntries(engine.candidates.all().map((c) => [c.id, c.votes]));
  const stats = engine.db.voterStats(engine.election.id);
  const likeTotals = engine.db.likeTotals(engine.election.id);
  const dbEvents = engine.db.eventCounts(engine.election.id);
  const ranking = engine.getRanking();
  const oracleMatch = {
    votes: JSON.stringify(votes) === JSON.stringify(sc.oracle.votesByCandidate),
    giftVoters: (stats.byOrigin.gift ?? 0) === sc.oracle.giftVoters,
    likeVoters: (stats.byOrigin.likes ?? 0) === sc.oracle.likeVoters,
    likesCounted: likeTotals.counted === sc.oracle.likesCounted,
    likeBalance: likeTotals.balance === sc.oracle.likeBalance,
    giftUnits: acc.giftUnitsCounted === sc.oracle.giftUnitsCounted,
  };
  const delivered = acc.eventsReceived;
  const result = {
    params: { logicalEvents: LOGICAL, seed: SEED, burstConcurrency: CONC, restarts, disconnects: sc.stats.disconnects, db: 'SQLite (arquivo, WAL, synchronous=NORMAL)', presentation: 'instantânea (estados avançam sem temporizadores)' },
    events: {
      sentBySimulator: sc.stats.sent,
      lostWhileSourceDisconnected: sc.stats.lost,
      deliveredToEngine: delivered,
      processedStateChanging: acc.eventsProcessed,
      rejectedByRule: acc.eventsRejected,
      invalid: acc.eventsInvalid,
      duplicatesIgnored: acc.eventsDuplicate,
      noopAlreadyCounted: acc.eventsNoop,
      chatIgnoredNotCommand: acc.eventsIgnored,
      failed: acc.eventsFailed,
      injected: { duplicates: sc.stats.duplicatesInjected, invalid: sc.stats.invalidInjected },
      byOutcome: outcomes,
      storedInEventsTable: Object.values(dbEvents).reduce((a, b) => a + b, 0),
    },
    gifts: { giftEvents: acc.giftEvents, giftUnitsCounted: acc.giftUnitsCounted },
    votes: { totalValidVotes: ranking.totalValidVotes, byCandidate: votes, confirmedMetric: acc.votesConfirmed },
    voters: { created: stats.total, fromGifts: stats.byOrigin.gift ?? 0, fromLikes: stats.byOrigin.likes ?? 0, byState: stats.byState, withVotes: undefined as number | undefined },
    likes: { counted: likeTotals.counted, finalBalance: likeTotals.balance, votersGenerated: likeTotals.votersGenerated, threshold: engine.admin.get().likes.threshold },
    timing: { totalSeconds: +secs.toFixed(3), ingestSeconds: +(Number(tIngest - t0) / 1e9).toFixed(3), eventsPerSecondDelivered: Math.round(delivered / secs), eventsPerSecondSent: Math.round(sc.stats.sent / secs), queueHighWater: engine.queue.stats().highWater },
    integrity: { rankingMatchesLedger: integrity.ok, problems: integrity.problems, percentTotal: +ranking.entries.reduce((s, e) => s + e.percent, 0).toFixed(2) },
    oracle: { match: oracleMatch, allMatch: Object.values(oracleMatch).every(Boolean), expected: sc.oracle },
    dbSizeKB: Math.round(statSync(dbPath).size / 1024),
  };
  console.log(JSON.stringify(result, null, 2));
  writeFileSync(arg('out', 'docs/loadtest-result.json'), JSON.stringify(result, null, 2));
  await engine.close();
  rmSync(dir, { recursive: true, force: true });
  if (!result.oracle.allMatch || !integrity.ok || acc.eventsFailed > 0) process.exitCode = 1;
}
main();
