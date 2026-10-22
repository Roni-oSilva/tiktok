import { createRng, type Rng } from './prng.js';

/**
 * ATENÇÃO: tudo que este módulo gera é FICTÍCIO (simulated=true, source='simulation').
 * Os eventos passam pelo mesmo ElectionEngine.ingest usado pelo adaptador real.
 */
export type SimStep =
  | { t: 'event'; raw: Record<string, unknown>; label: string; lost?: boolean }
  | { t: 'disconnect' }
  | { t: 'reconnect' }
  | { t: 'restart' };

export interface SimMix {
  chat: number;
  rose: number;
  special: number;
  unknownGift: number;
  combo: number;
  likes: number;
  noChoiceGift: number;
}

export interface SimOptions {
  seed: number;
  viewers?: number;
  /** Comandos dos candidatos (token usado após !votar). */
  candidateCommands: string[];
  candidateIds: string[];
  likeStyle?: 'incremental' | 'cumulative' | 'both';
  likeThreshold?: number;
  duplicateRate?: number;
  invalidRate?: number;
  /** Chance de embaralhar atualizações dentro de um combo (fora de ordem). */
  reorderRate?: number;
  disconnectEvery?: number;
  restartEvery?: number;
  mix?: Partial<SimMix>;
  /** Nome -> votos, deve refletir a configuração do motor. */
  giftVotes?: { rose: number; special: { name: string; votes: number }[] };
}

export interface Oracle {
  votesByCandidate: Record<string, number>;
  giftVoters: number;
  likeVoters: number;
  giftUnitsCounted: number;
  giftUnitsWithVotes: number;
  likesCounted: number;
  likeBalance: number;
  ignoredNoChoice: number;
  unknownGiftEvents: number;
}

export interface GeneratedScenario {
  steps: SimStep[];
  oracle: Oracle;
  stats: { sent: number; delivered: number; lost: number; uniqueValid: number; duplicatesInjected: number; invalidInjected: number; disconnects: number; restarts: number };
}

const DEFAULT_MIX: SimMix = { chat: 15, rose: 30, special: 5, unknownGift: 2, combo: 6, likes: 20, noChoiceGift: 6 };

export class SimulationRunner {
  readonly rng: Rng;
  private n = 0;
  constructor(private readonly o: SimOptions) {
    this.rng = createRng(o.seed);
  }

  /** `count` = quantidade aproximada de eventos lógicos; duplicados/inválidos/combos aumentam o total enviado. */
  generate(count: number): GeneratedScenario {
    const o = this.o;
    const rng = this.rng;
    const mix = { ...DEFAULT_MIX, ...o.mix };
    const total = Object.values(mix).reduce((a, b) => a + b, 0);
    const nViewers = o.viewers ?? 200;
    const threshold = o.likeThreshold ?? 1000;
    const style = o.likeStyle ?? 'both';
    const giftVotes = o.giftVotes ?? { rose: 1, special: [{ name: 'Finger Heart', votes: 5 }, { name: 'Lion', votes: 50 }] };
    // espectadores: os 10% finais nunca escolhem candidato
    const noChoiceFrom = Math.floor(nViewers * 0.9);
    const choice = new Map<number, string>();
    const oracle: Oracle = {
      votesByCandidate: Object.fromEntries(o.candidateIds.map((c) => [c, 0])),
      giftVoters: 0, likeVoters: 0, giftUnitsCounted: 0, giftUnitsWithVotes: 0, likesCounted: 0, likeBalance: 0, ignoredNoChoice: 0, unknownGiftEvents: 0,
    };
    const stats = { sent: 0, delivered: 0, lost: 0, uniqueValid: 0, duplicatesInjected: 0, invalidInjected: 0, disconnects: 0, restarts: 0 };
    const steps: SimStep[] = [];
    const recent: SimStep[] = [];
    let ts = 1_700_000_000_000;
    let roomTotal = 1_000_000 + rng.int(0, 5000); // total da sala já existente ao "entrar"
    let firstTotalSeen: number | null = null;
    let lastTotal = roomTotal;
    let balance = 0;
    let disconnectedLeft = 0;
    let logical = 0;

    const viewer = (i: number) => ({ userId: `u${i}`, uniqueId: `user_${i}`, displayName: `Espectador ${i}` });
    const base = () => ({ source: 'simulation', simulated: true, ts: (ts += rng.int(1, 40)), eventId: `sim-${this.seed()}-${++this.n}` });
    const live = () => disconnectedLeft === 0;

    const push = (raw: Record<string, unknown>, label: string) => {
      const lost = !live();
      const step: SimStep = { t: 'event', raw, label, lost };
      steps.push(step);
      stats.sent++;
      if (lost) stats.lost++;
      else {
        stats.delivered++;
        stats.uniqueValid++;
        recent.push(step);
        if (recent.length > 50) recent.shift();
      }
      if (lost) disconnectedLeft--;
      if (disconnectedLeft === 0 && lost) {
        steps.push({ t: 'reconnect' });
      }
    };

    const applyLikes = (delta: number) => {
      const sum = balance + delta;
      const nv = Math.floor(sum / threshold);
      balance = sum - nv * threshold;
      oracle.likesCounted += delta;
      oracle.likeVoters += nv;
    };

    while (logical < count) {
      logical++;
      if (o.disconnectEvery && logical % o.disconnectEvery === 0 && live()) {
        steps.push({ t: 'disconnect' });
        stats.disconnects++;
        disconnectedLeft = rng.int(2, 6);
      }
      if (o.restartEvery && logical % o.restartEvery === 0 && live()) {
        steps.push({ t: 'restart' });
        stats.restarts++;
      }

      // eventos inválidos
      if (rng.chance(o.invalidRate ?? 0.02)) {
        const bad = [
          { ...base(), kind: 'gift', giftName: 'Rose', repeatCount: -3, viewer: viewer(1) },
          { ...base(), kind: 'gift', repeatCount: 1, viewer: viewer(2) },
          { ...base(), kind: 'like', likeCount: 0, viewer: viewer(3) },
          { ...base(), kind: 'like', likeCount: 'muitas', viewer: viewer(3) },
          { ...base(), kind: 'chat', text: 123, viewer: viewer(4) },
          { ...base(), kind: 'teleport', viewer: viewer(5) },
          { source: 'simulation', simulated: true },
        ];
        const raw = rng.pick(bad) as Record<string, unknown>;
        steps.push({ t: 'event', raw, label: 'invalid', lost: !live() });
        stats.sent++;
        if (live()) {
          stats.delivered++;
          stats.invalidInjected++;
        } else {
          stats.lost++;
          disconnectedLeft--;
          if (disconnectedLeft === 0) steps.push({ t: 'reconnect' });
        }
      }

      // duplicado de evento recente (mesmo eventId/payload)
      if (recent.length && rng.chance(o.duplicateRate ?? 0.05) && live()) {
        const d = rng.pick(recent) as Extract<SimStep, { t: 'event' }>;
        steps.push({ t: 'event', raw: { ...d.raw }, label: `dup:${d.label}` });
        stats.sent++;
        stats.delivered++;
        stats.duplicatesInjected++;
      }

      const lostNow = !live();

      if (rng.next() * total < mix.chat) {
        const i = rng.int(0, noChoiceFrom - 1);
        const idx = rng.int(0, o.candidateCommands.length - 1);
        push({ ...base(), kind: 'chat', viewer: viewer(i), text: `!votar ${o.candidateCommands[idx]}` }, 'chat');
        if (!lostNow) choice.set(i, o.candidateIds[idx]);
        continue;
      }
      const r = rng.next() * (total - mix.chat);
      let cat = pickCat(r, [['rose', mix.rose], ['special', mix.special], ['unknown', mix.unknownGift], ['noChoice', mix.noChoiceGift], ['combo', mix.combo], ['likes', mix.likes]]);
      if (cat === 'combo' && lostNow) cat = 'rose'; // combos são sempre entregues por inteiro

      const giftOracle = (i: number, units: number, votesPerUnit: number, unknown: boolean) => {
        if (lostNow) return;
        oracle.giftUnitsCounted += units;
        if (unknown) {
          oracle.unknownGiftEvents++;
          return;
        }
        const cand = choice.get(i);
        if (!cand) {
          oracle.ignoredNoChoice++;
          return;
        }
        oracle.votesByCandidate[cand] += units * votesPerUnit;
        oracle.giftUnitsWithVotes += units;
        oracle.giftVoters++;
      };

      if (cat === 'rose') {
        const i = rng.int(0, noChoiceFrom - 1);
        push({ ...base(), kind: 'gift', viewer: viewer(i), giftId: '5655', giftName: 'Rose', repeatCount: 1, repeatEnd: true }, 'rose');
        giftOracle(i, 1, giftVotes.rose, false);
      } else if (cat === 'special') {
        const i = rng.int(0, noChoiceFrom - 1);
        const sp = rng.pick(giftVotes.special);
        push({ ...base(), kind: 'gift', viewer: viewer(i), giftName: sp.name, repeatCount: 1, repeatEnd: true }, 'special');
        giftOracle(i, 1, sp.votes, false);
      } else if (cat === 'unknown') {
        const i = rng.int(0, noChoiceFrom - 1);
        push({ ...base(), kind: 'gift', viewer: viewer(i), giftName: `Presente-${rng.int(1, 99)}-desconhecido`, repeatCount: 1, repeatEnd: true }, 'unknown');
        giftOracle(i, 1, 0, true);
      } else if (cat === 'noChoice') {
        const i = rng.int(noChoiceFrom, nViewers - 1);
        push({ ...base(), kind: 'gift', viewer: viewer(i), giftName: 'Rose', repeatCount: 1, repeatEnd: true }, 'rose-nochoice');
        giftOracle(i, 1, giftVotes.rose, false);
      } else if (cat === 'combo') {
        const i = rng.int(0, noChoiceFrom - 1);
        const finalN = rng.int(2, 12);
        const group = `g-${this.seed()}-${this.n}`;
        const seq: number[] = [];
        let c = 0;
        while (c < finalN) seq.push((c = Math.min(finalN, c + rng.int(1, 3))));
        const evs = seq.map((rc) => ({ rc, end: false }));
        evs.push({ rc: finalN, end: true });
        if (rng.chance(o.reorderRate ?? 0) && evs.length > 2) {
          const k = rng.int(0, evs.length - 2);
          [evs[k], evs[k + 1]] = [evs[k + 1], evs[k]];
        }
        let counted = 0;
        for (const ev of evs) {
          const lostEv = !live();
          push({ ...base(), kind: 'gift', viewer: viewer(i), giftId: '5655', giftName: 'Rose', streakable: true, repeatCount: ev.rc, repeatEnd: ev.end, groupId: group }, 'combo');
          if (!lostEv) {
            const delta = Math.max(0, ev.rc - counted);
            counted = Math.max(counted, ev.rc);
            if (delta > 0) giftOracle(i, delta, giftVotes.rose, false);
          }
        }
      } else {
        // curtidas
        const k = rng.int(1, 600);
        const withUser = rng.chance(0.3);
        const who = withUser ? { viewer: viewer(rng.int(0, nViewers - 1)) } : { viewer: {} };
        if (style === 'incremental') {
          push({ ...base(), kind: 'like', ...who, likeCount: k }, 'like-inc');
          if (!lostNow) applyLikes(k);
        } else if (style === 'cumulative') {
          roomTotal += k;
          const t = roomTotal;
          push({ ...base(), kind: 'like', ...who, totalLikeCount: t }, 'like-cum');
          if (!lostNow) {
            if (firstTotalSeen === null) firstTotalSeen = t;
            else if (t > lastTotal) applyLikes(t - lastTotal);
            lastTotal = t;
          }
        } else {
          roomTotal += k;
          push({ ...base(), kind: 'like', ...who, likeCount: k, totalLikeCount: roomTotal }, 'like-both');
          if (!lostNow) {
            if (firstTotalSeen === null) {
              firstTotalSeen = roomTotal;
              applyLikes(k); // primeiro evento: sem referência anterior, conta o lote informado
            } else {
              applyLikes(roomTotal - lastTotal);
            }
            lastTotal = roomTotal;
          } else {
            // total da sala continua subindo durante a queda; ao reconectar o aumento é recuperado
          }
        }
      }
    }
    if (disconnectedLeft > 0) steps.push({ t: 'reconnect' });
    oracle.likeBalance = balance;
    return { steps, oracle, stats };
  }

  private seed(): number {
    return this.o.seed;
  }

  /** Reproduz os passos. `deliver` envia ao motor; hooks tratam desconexão/reinício. */
  async play(
    steps: SimStep[],
    h: { deliver: (raw: unknown) => Promise<unknown>; isConnected: () => boolean; onDisconnect: () => void; onReconnect: () => void; onRestart: () => Promise<void> },
    opts: { concurrent?: number } = {},
  ): Promise<void> {
    const pending: Promise<unknown>[] = [];
    const flush = async () => {
      await Promise.all(pending.splice(0));
    };
    for (const s of steps) {
      if (s.t === 'disconnect') { await flush(); h.onDisconnect(); }
      else if (s.t === 'reconnect') { await flush(); h.onReconnect(); }
      else if (s.t === 'restart') { await flush(); await h.onRestart(); }
      else if (h.isConnected()) {
        pending.push(h.deliver(s.raw));
        if (pending.length >= (opts.concurrent ?? 256)) await flush();
      }
    }
    await flush();
  }
}

function pickCat(r: number, cats: [string, number][]): string {
  for (const [name, w] of cats) {
    if (r < w) return name;
    r -= w;
  }
  return cats[cats.length - 1][0];
}
