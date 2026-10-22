import type { ElectionEngine } from './electionEngine.js';
import type { SourceStatus } from './types.js';

/** Monitora conexão da fonte, fila e integridade do ranking. */
export class HealthMonitor {
  state: SourceStatus['state'] = 'stopped';
  reconnects = 0;
  disconnects = 0;
  lastEventAt: number | null = null;
  lastIntegrity: { ok: boolean; problems: string[]; at: number } | null = null;
  private timer?: NodeJS.Timeout;

  constructor(private readonly engine: ElectionEngine) {}

  onStatus = (s: SourceStatus): void => {
    if (s.state === 'disconnected') this.disconnects++;
    if (s.state === 'connected' && (this.state === 'reconnecting' || this.state === 'disconnected')) this.reconnects++;
    this.state = s.state;
    this.engine.db.logConnection(s.state, s.error);
    this.engine.bus.emit('source.status', { ...s });
  };

  noteEvent(): void {
    this.lastEventAt = Date.now();
  }

  checkIntegrity() {
    const r = this.engine.ranking.verifyIntegrity();
    this.lastIntegrity = { ...r, at: Date.now() };
    if (!r.ok) this.engine.db.logError('error', 'integrity', 'ranking divergente', r.problems);
    return r;
  }

  snapshot() {
    return {
      connection: this.state,
      reconnects: this.reconnects,
      disconnects: this.disconnects,
      lastEventAt: this.lastEventAt,
      queue: this.engine.queue.stats(),
      presentationBacklog: this.engine.presentation.backlog,
      integrity: this.lastIntegrity,
      metrics: this.engine.metrics.snapshot(),
    };
  }

  start(intervalMs = 30000): void {
    this.stop();
    this.timer = setInterval(() => {
      this.checkIntegrity();
      this.engine.bus.emit('health.status', this.snapshot() as any);
    }, intervalMs);
    this.timer.unref();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
