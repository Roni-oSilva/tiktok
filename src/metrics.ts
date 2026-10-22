/** Contadores separados: eventos, unidades de presente, eleitores, votos e curtidas nunca se misturam. */
export class Metrics {
  eventsReceived = 0;
  eventsProcessed = 0; // alteraram estado (voto, saldo, comando aplicado)
  eventsRejected = 0; // válidos, porém recusados por regra/política
  eventsInvalid = 0; // malformados
  eventsDuplicate = 0;
  eventsNoop = 0; // combo/total cumulativo já contabilizado (nada novo)
  eventsIgnored = 0; // chat que não é comando
  eventsFailed = 0; // erro interno
  giftEvents = 0;
  giftUnitsCounted = 0;
  votesConfirmed = 0;
  votersCreated = 0;
  votersRejected = 0;
  votersCompleted = 0;
  votersFailed = 0;
  likesCounted = 0;
  likeVotersCreated = 0;
  commandsApplied = 0;
  byOutcome: Record<string, number> = {};

  outcome(o: string): void {
    this.byOutcome[o] = (this.byOutcome[o] ?? 0) + 1;
  }

  snapshot() {
    return { ...this, byOutcome: { ...this.byOutcome } };
  }
}
