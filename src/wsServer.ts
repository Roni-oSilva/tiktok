import { WebSocketServer, WebSocket } from 'ws';
import type { BusMessage } from './eventBus.js';
import type { ElectionEngine } from './electionEngine.js';

/**
 * Transmite os eventos do motor à futura interface. Somente leitura: mensagens recebidas dos clientes
 * são ignoradas, então a interface não consegue criar nem alterar votos. Escuta em 127.0.0.1 por padrão.
 */
export class GameWsServer {
  private wss?: WebSocketServer;
  private off?: () => void;
  constructor(private readonly engine: ElectionEngine, private readonly port = 8787, private readonly host = '127.0.0.1') {}

  async start(): Promise<number> {
    this.wss = new WebSocketServer({ port: this.port, host: this.host });
    await new Promise<void>((res, rej) => {
      this.wss!.once('listening', res);
      this.wss!.once('error', rej);
    });
    this.wss.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'snapshot', ts: Date.now(), data: this.engine.snapshot() }));
      ws.on('message', () => {});
      ws.on('error', () => {});
    });
    this.off = this.engine.bus.on('*', (m: BusMessage) => {
      const payload = JSON.stringify(m);
      for (const c of this.wss!.clients) if (c.readyState === WebSocket.OPEN) c.send(payload);
    });
    const addr = this.wss.address();
    return typeof addr === 'object' && addr ? addr.port : this.port;
  }

  async stop(): Promise<void> {
    this.off?.();
    for (const c of this.wss?.clients ?? []) c.terminate();
    await new Promise<void>((r) => (this.wss ? this.wss.close(() => r()) : r()));
  }
}
