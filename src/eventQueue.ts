/**
 * Fila FIFO com um único consumidor: garante que dois processadores jamais contabilizem
 * eventos ao mesmo tempo (escritor único) e preserva a ordem de chegada.
 * Não descarta itens: picos aumentam a profundidade (observável em `stats`), não causam perda.
 */
export class EventQueue<I, O> {
  private items: { input: I; resolve: (o: O) => void; reject: (e: unknown) => void }[] = [];
  private head = 0;
  private running = false;
  private idleWaiters: (() => void)[] = [];
  highWater = 0;
  processed = 0;

  constructor(private readonly handler: (input: I) => O | Promise<O>, private readonly yieldEvery = 256) {}

  get depth(): number {
    return this.items.length - this.head;
  }

  push(input: I): Promise<O> {
    return new Promise<O>((resolve, reject) => {
      this.items.push({ input, resolve, reject });
      this.highWater = Math.max(this.highWater, this.depth);
      if (!this.running) void this.run();
    });
  }

  private async run(): Promise<void> {
    this.running = true;
    let n = 0;
    try {
      while (this.head < this.items.length) {
        const it = this.items[this.head++];
        try {
          it.resolve(await this.handler(it.input));
        } catch (e) {
          it.reject(e);
        }
        this.processed++;
        if (this.head > 4096 && this.head * 2 > this.items.length) {
          this.items = this.items.slice(this.head);
          this.head = 0;
        }
        // cede o laço de eventos para não travar timers/WebSocket durante picos
        if (++n % this.yieldEvery === 0) await new Promise<void>((r) => setImmediate(r));
      }
    } finally {
      this.running = false;
      this.items = [];
      this.head = 0;
      const w = this.idleWaiters;
      this.idleWaiters = [];
      w.forEach((f) => f());
    }
  }

  /** Resolve quando a fila esvazia. */
  idle(): Promise<void> {
    if (!this.running && this.depth === 0) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  stats() {
    return { depth: this.depth, highWater: this.highWater, processed: this.processed };
  }
}
