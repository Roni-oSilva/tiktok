import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ElectionEngine, type EngineOptions } from '../src/electionEngine.js';
import { silentLogger } from '../src/logger.js';
import type { VoterAnimator } from '../src/presentationQueue.js';

export const dirs: string[] = [];
export function tmpDb(): string {
  const d = mkdtempSync(join(tmpdir(), 'elec-'));
  dirs.push(d);
  return join(d, 'test.db');
}
export function cleanup() {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
}

let counter = 0;
export const uid = () => `e${++counter}`;

export function makeEngine(over: Partial<EngineOptions> & { config?: Record<string, unknown> } = {}) {
  return new ElectionEngine({
    dbPath: over.dbPath ?? ':memory:',
    mode: 'simulation',
    logger: silentLogger,
    ...over,
    config: { presentation: { enabled: false }, ...(over.config ?? {}) },
  });
}

const base = () => ({ source: 'simulation', simulated: true, eventId: uid() });
export const viewer = (n: number | string, name?: string) => ({ userId: `u${n}`, uniqueId: `user${n}`, displayName: name ?? `Fulano ${n}` });

export const chat = (n: number | string, cand: string, extra: object = {}) => ({ ...base(), kind: 'chat', viewer: viewer(n), text: `!votar ${cand}`, ...extra });
export const rose = (n: number | string, extra: object = {}) => ({ ...base(), kind: 'gift', viewer: viewer(n), giftId: '5655', giftName: 'Rose', repeatCount: 1, repeatEnd: true, ...extra });
export const gift = (n: number | string, name: string, extra: object = {}) => ({ ...base(), kind: 'gift', viewer: viewer(n), giftName: name, repeatCount: 1, repeatEnd: true, ...extra });
export const likes = (count: number | undefined, extra: object = {}) => ({ ...base(), kind: 'like', viewer: {}, ...(count === undefined ? {} : { likeCount: count }), ...extra });

export function votesOf(e: ElectionEngine): Record<string, number> {
  return Object.fromEntries(e.candidates.all().map((c) => [c.id, c.votes]));
}
export function counts(e: ElectionEngine) {
  const s = e.db.voterStats(e.election.id);
  return { voters: s.total, votes: Object.values(votesOf(e)).reduce((a, b) => a + b, 0), byOrigin: s.byOrigin, byState: s.byState };
}
export const animatorThrowing: VoterAnimator = {
  async approach() {},
  async vote() {
    throw new Error('animação quebrou');
  },
};
