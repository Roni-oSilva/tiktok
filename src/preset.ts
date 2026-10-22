/** Configuração da eleição desta live: Lula (13) × Flávio Bolsonaro (22). Tudo editável via AdminConfigService. */
export const LULA_FLAVIO_PRESET = {
  election: {
    name: 'Eleição Presidencial — jogo de entretenimento',
    candidates: [
      { id: 'lula', name: 'Lula', command: '13' },
      { id: 'flavio', name: 'Flávio Bolsonaro', command: '22' },
    ],
  },
  // O espectador escolhe digitando 13 ou 22 (ou !votar 13 / !votar 22) no chat.
  commands: { vote: ['!votar', '!voto'], allowBareNumber: true },
  // 1.000 curtidas = 1 eleitor, que VOTA: o voto vai para o candidato com mais curtidas de espectadores
  // identificados que escolheram 13/22 (repartido proporcionalmente; sem sorteio). Sem curtidas identificadas, o eleitor só participa.
  likes: { threshold: 1000, votesPerVoter: 1, accumulation: 'global', targetPolicy: 'proportional_choice' },
  // Eleitores entram um de cada vez; com fila muito grande, a cena agrupa (votos continuam todos contados).
  presentation: { enabled: true, maxConcurrent: 1, groupThreshold: 30, groupBatchSize: 15, speed: 1 },
};
