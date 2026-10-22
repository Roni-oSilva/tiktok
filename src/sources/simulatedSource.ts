import type { EventSource, SourceStatus } from '../types.js';

/**
 * Fonte simulada: entrega eventos FICTÍCIOS (simulated=true) ao mesmo ponto de entrada do motor
 * usado pelo adaptador real. Também simula quedas e reconexões da fonte.
 */
export class SimulatedSource implements EventSource {
  connected = false;
  dropped = 0;
  constructor(private readonly sink: (raw: unknown) => void, private readonly onStatus?: (s: SourceStatus) => void) {}

  async start(): Promise<void> {
    this.connected = true;
    this.onStatus?.({ state: 'connected' });
  }
  async stop(): Promise<void> {
    this.connected = false;
    this.onStatus?.({ state: 'stopped' });
  }
  /** Eventos enviados enquanto desconectada são perdidos (como na fonte real, sem garantia de entrega). */
  emit(raw: unknown): boolean {
    if (!this.connected) {
      this.dropped++;
      return false;
    }
    this.sink(raw);
    return true;
  }
  disconnect(): void {
    this.connected = false;
    this.onStatus?.({ state: 'disconnected' });
  }
  reconnect(attempt = 1): void {
    this.onStatus?.({ state: 'reconnecting', attempt });
    this.connected = true;
    this.onStatus?.({ state: 'connected' });
  }
}
