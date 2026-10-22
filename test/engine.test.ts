import { afterAll, describe, expect, it } from 'vitest';
import { animatorThrowing, chat, cleanup, counts, gift, likes, makeEngine, rose, tmpDb, uid, viewer, votesOf } from './helpers.js';
import { ElectionEngine } from '../src/electionEngine.js';

afterAll(cleanup);

describe('Teste 1 — sem interação', () => {
  it('não cria eleitores nem votos', async () => {
    const e = makeEngine();
    await new Promise((r) => setTimeout(r, 50));
    await e.drain();
    expect(counts(e).voters).toBe(0);
    expect(counts(e).votes).toBe(0);
    expect(e.metrics.eventsReceived).toBe(0);
    // chat que não é comando também não cria nada
    await e.ingest({ source: 'simulation', simulated: true, eventId: uid(), kind: 'chat', viewer: viewer(1), text: 'olá pessoal' });
    expect(counts(e).voters).toBe(0);
  });
});

describe('Teste 2 — uma Rosa', () => {
  it('cria 1 eleitor e exatamente 1 voto para o candidato escolhido', async () => {
    const e = makeEngine();
    await e.ingest(chat(1, 'candidato2'));
    const r = await e.ingest(rose(1));
    await e.drain();
    expect(r.outcome).toBe('accepted');
    expect(votesOf(e)).toEqual({ candidato1: 0, candidato2: 1, candidato3: 0 });
    expect(counts(e)).toMatchObject({ voters: 1, votes: 1 });
    expect(e.db.getVoter(r.voterIds[0])!.state).toBe('completed');
  });
});

describe('Teste 3 — dez Rosas', () => {
  it('10 eventos unitários = 10 eleitores, 10 votos (per_event)', async () => {
    const e = makeEngine();
    await e.ingest(chat(1, 'candidato1'));
    for (let i = 0; i < 10; i++) await e.ingest(rose(1));
    expect(counts(e)).toMatchObject({ voters: 10, votes: 10 });
    expect(e.candidates.get('candidato1')!.giftUnits).toBe(10);
  });
  it('um evento com repeatCount=10 = 1 eleitor com 10 votos (política por evento)', async () => {
    const e = makeEngine();
    await e.ingest(chat(1, 'candidato1'));
    await e.ingest(rose(1, { repeatCount: 10 }));
    expect(counts(e)).toMatchObject({ voters: 1, votes: 10 });
  });
  it('voterMode=per_unit gera 10 eleitores', async () => {
    const e = makeEngine({ config: { gifts: { voterMode: 'per_unit' } } });
    await e.ingest(chat(1, 'candidato1'));
    await e.ingest(rose(1, { repeatCount: 10 }));
    expect(counts(e)).toMatchObject({ voters: 10, votes: 10 });
  });
});

describe('Teste 4 — presente especial', () => {
  it('votos conforme a configuração, editável em tempo de execução', async () => {
    const e = makeEngine();
    await e.ingest(chat(1, 'candidato3'));
    await e.ingest(gift(1, 'Lion'));
    expect(votesOf(e).candidato3).toBe(50);
    e.admin.update({ gifts: { rules: [{ names: ['lion'], ids: [], votes: 7, label: 'Leão' }] } });
    await e.ingest(gift(1, 'LION'));
    expect(votesOf(e).candidato3).toBe(57);
  });
  it('presente desconhecido: evento registrado, nenhum voto', async () => {
    const e = makeEngine();
    await e.ingest(chat(1, 'candidato1'));
    const r = await e.ingest(gift(1, 'Misterio'));
    expect(r.outcome).toBe('unknown_gift');
    expect(counts(e)).toMatchObject({ voters: 0, votes: 0 });
    expect(e.db.eventCounts(e.election.id).unknown_gift).toBe(1);
  });
});

describe('Teste 5 — evento duplicado', () => {
  it('mesmo eventId (memória e após reiniciar): sem votos/eleitores extras', async () => {
    const path = tmpDb();
    let e = makeEngine({ dbPath: path });
    await e.ingest(chat(1, 'candidato1'));
    const g = rose(1);
    await e.ingest(g);
    const dup = await e.ingest(g);
    expect(dup.outcome).toBe('duplicate');
    await e.close();
    e = makeEngine({ dbPath: path }); // memória vazia: quem barra é a restrição UNIQUE do banco
    const dup2 = await e.ingest(g);
    expect(dup2.outcome).toBe('duplicate');
    expect(counts(e)).toMatchObject({ voters: 1, votes: 1 });
    expect(e.metrics.eventsDuplicate).toBe(1);
  });
  it('sem eventId mas com ts: impressão digital detecta repetição exata', async () => {
    const e = makeEngine();
    await e.ingest(chat(1, 'candidato1'));
    const g = { ...rose(1), eventId: undefined, ts: 1234 };
    await e.ingest(g);
    expect((await e.ingest({ ...g })).outcome).toBe('duplicate');
    expect(counts(e).votes).toBe(1);
  });
});

describe('Testes 6–8 — curtidas', () => {
  it('6: 1000 curtidas = 1 eleitor', async () => {
    const e = makeEngine();
    const r = await e.ingest(likes(1000));
    expect(r.voterIds).toHaveLength(1);
    expect(e.db.likeTotals(e.election.id)).toMatchObject({ balance: 0, votersGenerated: 1 });
  });
  it('7: 2000 curtidas = 2 eleitores', async () => {
    const e = makeEngine();
    expect((await e.ingest(likes(2000))).voterIds).toHaveLength(2);
  });
  it('8: 2500 curtidas = 2 eleitores e saldo 500; 3000 = 3', async () => {
    const e = makeEngine();
    expect((await e.ingest(likes(2500))).voterIds).toHaveLength(2);
    expect(e.db.likeTotals(e.election.id).balance).toBe(500);
    const e2 = makeEngine();
    expect((await e2.ingest(likes(3000))).voterIds).toHaveLength(3);
  });
  it('saldo 800 + 450 = 1 eleitor e saldo 250', async () => {
    const e = makeEngine();
    expect((await e.ingest(likes(800))).voterIds).toHaveLength(0);
    expect((await e.ingest(likes(450))).voterIds).toHaveLength(1);
    expect(e.db.likeTotals(e.election.id)).toMatchObject({ balance: 250, counted: 1250 });
  });
  it('limite editável pelo administrador', async () => {
    const e = makeEngine();
    e.admin.setLikeThreshold(100);
    expect((await e.ingest(likes(350))).voterIds).toHaveLength(3);
    expect(e.db.likeTotals(e.election.id).balance).toBe(50);
  });
  it('eleitores de curtidas não votam em candidato arbitrário por padrão', async () => {
    const e = makeEngine();
    await e.ingest(likes(3000));
    expect(counts(e)).toMatchObject({ voters: 3, votes: 0 });
    const v = e.db.pendingVoters(e.election.id);
    expect(v).toHaveLength(0);
  });
  it('fixed_candidate atribui votos de curtidas ao destino configurado', async () => {
    const e = makeEngine({ config: { likes: { targetPolicy: 'fixed_candidate', fixedCandidateId: 'candidato2' } } });
    await e.ingest(likes(2000));
    expect(votesOf(e).candidato2).toBe(2);
  });
});

describe('Teste 9 — contador cumulativo', () => {
  it('100 → 150 contabiliza só 50; reenvios/fora de ordem não contam', async () => {
    const e = makeEngine({ config: { likes: { threshold: 1000 } } });
    const r1 = await e.ingest(likes(undefined, { totalLikeCount: 100 }));
    expect(r1.outcome).toBe('baseline');
    await e.ingest(likes(undefined, { totalLikeCount: 150 }));
    expect(e.db.likeTotals(e.election.id).counted).toBe(50);
    const stale = await e.ingest(likes(undefined, { totalLikeCount: 120 }));
    expect(stale.outcome).toBe('stale_total');
    await e.ingest(likes(undefined, { totalLikeCount: 150 }));
    expect(e.db.likeTotals(e.election.id).counted).toBe(50);
    await e.ingest(likes(undefined, { totalLikeCount: 1200 }));
    expect(e.db.likeTotals(e.election.id)).toMatchObject({ counted: 1100, balance: 100, votersGenerated: 1 });
  });
});

describe('Teste 10 — nome do eleitor', () => {
  it('usa o nome do remetente identificado e o genérico quando não há', async () => {
    const e = makeEngine();
    await e.ingest(chat(1, 'candidato1'));
    const names: string[] = [];
    e.bus.on('voter.created', (m) => names.push(m.data.displayName as string));
    await e.ingest(rose(1, { viewer: { userId: 'u1', displayName: 'Maria da Silva' } }));
    await e.ingest(likes(1000));
    await e.ingest(likes(1000, { viewer: { userId: 'u9', displayName: 'Alguém' } })); // acumulação global: ainda genérico
    expect(names).toEqual(['Maria da Silva', 'Eleitor das Curtidas', 'Eleitor das Curtidas']);
  });
  it('sem nome nem id, presente usa nome genérico; nomes são sanitizados', async () => {
    const e = makeEngine({ config: { viewers: { noChoicePolicy: 'record_participation' } } });
    const names: string[] = [];
    e.bus.on('voter.created', (m) => names.push(m.data.displayName as string));
    await e.ingest(rose(1, { viewer: {} }));
    await e.ingest(rose(2, { viewer: { userId: 'u2', displayName: '  Zé‮\n  Bom ' } }));
    expect(names).toEqual(['Eleitor', 'Zé Bom']);
  });
  it('per_user: curtidas identificadas usam o nome do usuário', async () => {
    const e = makeEngine({ config: { likes: { accumulation: 'per_user', targetPolicy: 'user_choice', mode: 'incremental' } } });
    await e.ingest(chat(5, 'candidato3'));
    const names: string[] = [];
    e.bus.on('voter.created', (m) => names.push(m.data.displayName as string));
    await e.ingest(likes(700, { viewer: viewer(5, 'Ana') }));
    await e.ingest(likes(300, { viewer: viewer(5, 'Ana') }));
    await e.ingest(likes(1000, { viewer: viewer(6, 'Beto') }));
    expect(names).toEqual(['Ana', 'Beto']);
    expect(votesOf(e)).toEqual({ candidato1: 0, candidato2: 0, candidato3: 1 });
  });
});

describe('Teste 11 — candidato alterado', () => {
  it('nova escolha vale só para interações futuras', async () => {
    const e = makeEngine();
    await e.ingest(chat(1, 'candidato1'));
    await e.ingest(rose(1));
    await e.ingest(rose(1));
    await e.ingest(chat(1, 'candidato2'));
    await e.ingest(rose(1));
    expect(votesOf(e)).toEqual({ candidato1: 2, candidato2: 1, candidato3: 0 });
  });
  it('comando atrasado (ts anterior) não sobrescreve escolha mais nova', async () => {
    const e = makeEngine();
    await e.ingest(chat(1, 'candidato2', { ts: 2000 }));
    const old = await e.ingest(chat(1, 'candidato1', { ts: 1000 }));
    expect(old.outcome).toBe('command_rejected');
    await e.ingest(rose(1));
    expect(votesOf(e).candidato2).toBe(1);
  });
});

describe('Teste 12 — ranking', () => {
  it('classificação, percentuais, diferenças e desempate determinístico', async () => {
    const e = makeEngine();
    await e.ingest(chat(1, 'candidato1'));
    await e.ingest(chat(2, 'candidato2'));
    await e.ingest(chat(3, 'candidato3'));
    for (let i = 0; i < 3; i++) await e.ingest(rose(1));
    for (let i = 0; i < 3; i++) await e.ingest(rose(2));
    await e.ingest(rose(3));
    const r = e.getRanking();
    // empate 3×3: quem atingiu 3 primeiro (candidato1) fica à frente
    expect(r.entries.map((x) => x.candidateId)).toEqual(['candidato1', 'candidato2', 'candidato3']);
    expect(r.totalValidVotes).toBe(7);
    expect(r.entries.map((x) => x.percent)).toEqual([42.86, 42.86, 14.29]);
    expect(r.entries[0]).toMatchObject({ position: 1, diffToLeader: 0, diffToNext: 0 });
    expect(r.entries[2]).toMatchObject({ diffToLeader: 2, giftUnits: 1, supporters: 1 });
    expect(e.ranking.verifyIntegrity().ok).toBe(true);
  });
  it('pontos de bônus e efeitos não alteram votos nem o ranking', async () => {
    const e = makeEngine();
    await e.ingest(chat(1, 'candidato1'));
    await e.ingest(rose(1));
    e.candidates.addPoints('candidato2', 1000);
    e.candidates.setEffects('candidato2', ['confete']);
    const r = e.getRanking();
    expect(r.entries[0].candidateId).toBe('candidato1');
    expect(r.entries.find((x) => x.candidateId === 'candidato2')).toMatchObject({ votes: 0, points: 1000, effects: ['confete'] });
  });
});

describe('Teste 13 — concorrência', () => {
  it('rajada simultânea com duplicatas: sem perda e sem duplicação', async () => {
    const e = makeEngine();
    await e.ingest(chat(1, 'candidato1'));
    const evs = Array.from({ length: 500 }, () => rose(1));
    const all = [...evs, ...evs.slice(0, 200), ...evs.slice(100, 300)]; // 400 duplicatas
    const results = await Promise.all(all.map((x) => e.ingest(x)));
    expect(results.filter((r) => r.outcome === 'accepted')).toHaveLength(500);
    expect(results.filter((r) => r.outcome === 'duplicate')).toHaveLength(400);
    expect(counts(e)).toMatchObject({ voters: 500, votes: 500 });
    expect(e.ranking.verifyIntegrity().ok).toBe(true);
  });
  it('processa estritamente em ordem de chegada', async () => {
    const e = makeEngine();
    const rs = await Promise.all([e.ingest(chat(1, 'candidato1')), e.ingest(rose(1)), e.ingest(chat(1, 'candidato2')), e.ingest(rose(1))]);
    expect(rs.map((r) => r.outcome)).toEqual(['command_applied', 'accepted', 'command_applied', 'accepted']);
    expect(votesOf(e)).toMatchObject({ candidato1: 1, candidato2: 1 });
  });
});

describe('Teste 14 — reinicialização', () => {
  it('votos, escolhas, saldo de curtidas e referência cumulativa são recuperados', async () => {
    const path = tmpDb();
    let e = makeEngine({ dbPath: path });
    await e.ingest(chat(1, 'candidato2'));
    await e.ingest(rose(1));
    await e.ingest(gift(1, 'Finger Heart'));
    await e.ingest(likes(2500));
    await e.ingest(likes(undefined, { totalLikeCount: 5000 }));
    await e.ingest(likes(undefined, { totalLikeCount: 5300 }));
    const before = { votes: votesOf(e), likes: e.db.likeTotals(e.election.id), id: e.election.id };
    await e.close();

    e = makeEngine({ dbPath: path });
    expect(e.election.id).toBe(before.id);
    expect(votesOf(e)).toEqual(before.votes);
    expect(e.db.likeTotals(e.election.id)).toEqual(before.likes);
    await e.ingest(rose(1)); // escolha persistida
    expect(votesOf(e).candidato2).toBe(before.votes.candidato2 + 1);
    await e.ingest(likes(undefined, { totalLikeCount: 5400 })); // só +100 sobre o último total
    expect(e.db.likeTotals(e.election.id).counted).toBe(before.likes.counted + 100);
    expect(e.ranking.verifyIntegrity().ok).toBe(true);
  });
  it('eleitores pendentes são reapresentados sem recontar votos', async () => {
    const path = tmpDb();
    let e = makeEngine({ dbPath: path, animator: { approach: () => new Promise(() => {}), vote: async () => {} } }); // trava na caminhada
    await e.ingest(chat(1, 'candidato1'));
    await e.ingest(rose(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(e.db.pendingVoters(e.election.id)[0].state).toBe('approaching');
    e.db.close();
    e = makeEngine({ dbPath: path });
    expect(e.recoverPending()).toBe(1);
    await e.drain();
    expect(counts(e)).toMatchObject({ voters: 1, votes: 1, byState: { completed: 1 } });
  });
});

describe('Teste 15 — combo', () => {
  it('início/atualizações/fim não contam duas vezes', async () => {
    const e = makeEngine();
    await e.ingest(chat(1, 'candidato1'));
    const mk = (rc: number, end: boolean) => rose(1, { streakable: true, groupId: 'G1', repeatCount: rc, repeatEnd: end });
    await e.ingest(mk(1, false));
    await e.ingest(mk(1, false)); // reenvio sem eventId igual
    await e.ingest(mk(3, false));
    await e.ingest(mk(2, false)); // fora de ordem
    await e.ingest(mk(5, false));
    const end = await e.ingest(mk(5, true));
    expect(end.outcome).toBe('no_new_units');
    expect(votesOf(e).candidato1).toBe(5);
    expect(e.metrics.giftUnitsCounted).toBe(5);
    expect(e.metrics.giftEvents).toBe(6); // eventos ≠ unidades
    // um novo combo (outro groupId) conta separado
    await e.ingest(rose(1, { streakable: true, groupId: 'G2', repeatCount: 2, repeatEnd: true }));
    expect(votesOf(e).candidato1).toBe(7);
  });
  it('fim de combo chegando antes das atualizações finais não gera contagem dupla', async () => {
    const e = makeEngine();
    await e.ingest(chat(1, 'candidato1'));
    const mk = (rc: number, end: boolean) => rose(1, { streakable: true, groupId: 'G9', repeatCount: rc, repeatEnd: end });
    await e.ingest(mk(10, true));
    await e.ingest(mk(8, false));
    await e.ingest(mk(10, false));
    expect(votesOf(e).candidato1).toBe(10);
  });
});

describe('Teste 16 — sem candidato escolhido', () => {
  it('ignore: presente é rejeitado, nenhum voto aleatório', async () => {
    const e = makeEngine();
    const rejected: unknown[] = [];
    e.bus.on('voter.rejected', (m) => rejected.push(m.data.reason));
    const r = await e.ingest(rose(7));
    expect(r.outcome).toBe('no_candidate');
    expect(counts(e)).toMatchObject({ voters: 0, votes: 0 });
    expect(rejected).toEqual(['no_candidate_chosen']);
  });
  it('record_participation: eleitor sem votos atribuídos', async () => {
    const e = makeEngine({ config: { viewers: { noChoicePolicy: 'record_participation' } } });
    const r = await e.ingest(rose(7));
    expect(r.outcome).toBe('accepted');
    expect(counts(e)).toMatchObject({ voters: 1, votes: 0 });
    expect(e.getRanking().totalValidVotes).toBe(0);
  });
  it('viewer sem userId não pode ter escolha: comando rejeitado', async () => {
    const e = makeEngine();
    const r = await e.ingest(chat(1, 'candidato1', { viewer: { displayName: 'Anônimo' } }));
    expect(r.outcome).toBe('command_rejected');
  });
  it('comando para candidato inexistente é rejeitado', async () => {
    const e = makeEngine();
    expect((await e.ingest(chat(1, 'ninguem'))).outcome).toBe('command_rejected');
  });
});

describe('Teste 17 — animação falha', () => {
  it('voto confirmado é preservado; eleitor vira failed', async () => {
    const e = makeEngine({ animator: animatorThrowing });
    await e.ingest(chat(1, 'candidato1'));
    const r = await e.ingest(rose(1));
    await e.drain();
    const v = e.db.getVoter(r.voterIds[0])!;
    expect(v.state).toBe('failed');
    expect(v.voteConfirmed).toBe(true);
    expect(votesOf(e).candidato1).toBe(1);
    expect(e.ranking.verifyIntegrity().ok).toBe(true);
    expect(e.metrics.votersFailed).toBe(1);
  });
  it('ouvinte do barramento que lança exceção não afeta o motor', async () => {
    const e = makeEngine();
    e.bus.on('*', () => {
      throw new Error('interface quebrou');
    });
    await e.ingest(chat(1, 'candidato1'));
    await e.ingest(rose(1));
    await e.drain();
    expect(votesOf(e).candidato1).toBe(1);
  });
});

describe('Teste 18 — eleição encerrada', () => {
  it('rejeita novas votações e persiste o resultado final', async () => {
    const path = tmpDb();
    let e = makeEngine({ dbPath: path });
    await e.ingest(chat(1, 'candidato1'));
    await e.ingest(rose(1));
    const fin = e.finish();
    expect(fin.ranking.entries[0].votes).toBe(1);
    const r = await e.ingest(rose(1));
    const l = await e.ingest(likes(5000));
    expect(r.outcome).toBe('rejected_closed');
    expect(l.outcome).toBe('rejected_closed');
    expect(votesOf(e).candidato1).toBe(1);
    expect(JSON.parse(e.db.getElection(e.election.id)!.resultJson!).ranking.entries[0].candidateId).toBe('candidato1');
    const id = e.election.id;
    await e.close();
    e = makeEngine({ dbPath: path }); // eleição finalizada não é reaberta: nasce uma nova
    expect(e.election.id).not.toBe(id);
    expect(e.db.getElection(id)!.status).toBe('finished');
  });
});

describe('Teste 19 — evento inválido', () => {
  it('não altera a votação', async () => {
    const e = makeEngine();
    await e.ingest(chat(1, 'candidato1'));
    const bad: unknown[] = [
      null, 'texto', 42, {}, { kind: 'gift' },
      rose(1, { repeatCount: -1 }), rose(1, { repeatCount: 0 }), rose(1, { repeatCount: 1.5 }), rose(1, { repeatCount: Number.NaN }), rose(1, { repeatCount: 10 ** 9 }),
      rose(1, { giftId: undefined, giftName: undefined }),
      likes(0), likes(-5), likes(undefined), likes(1.5), likes(NaN), likes(10 ** 9), likes(undefined, { totalLikeCount: -1 }),
      { ...chat(1, 'candidato1'), text: 42 }, { ...rose(1), kind: 'dance' }, { ...rose(1), simulated: 'sim' }, { ...rose(1), source: 'x' },
    ];
    for (const b of bad) expect((await e.ingest(b)).outcome).toBe('invalid');
    expect(counts(e)).toMatchObject({ voters: 0, votes: 0 });
    expect(e.metrics.eventsInvalid).toBe(bad.length);
    expect(e.ranking.verifyIntegrity().ok).toBe(true);
  });
  it('eventos de origem incompatível com o modo são recusados', async () => {
    const live = makeEngine({ mode: 'live' });
    expect((await live.ingest(rose(1))).outcome).toBe('rejected_mode'); // simulado dentro do modo live
    const sim = makeEngine();
    expect((await sim.ingest({ ...rose(1), source: 'tiktok', simulated: false })).outcome).toBe('rejected_mode');
  });
});

describe('Falha interna: transação reverte', () => {
  it('erro no meio do processamento não deixa evento/voto parciais', async () => {
    const e = makeEngine();
    await e.ingest(chat(1, 'candidato1'));
    const orig = e.db.setEventOutcome.bind(e.db);
    e.db.setEventOutcome = () => {
      throw new Error('disco cheio (simulado)');
    };
    const g = rose(1);
    const r = await e.ingest(g);
    expect(r.outcome).toBe('failed');
    e.db.setEventOutcome = orig;
    expect(counts(e)).toMatchObject({ voters: 0, votes: 0 });
    // o mesmo evento pode ser reprocessado depois (nada foi marcado como visto)
    expect((await e.ingest(g)).outcome).toBe('accepted');
    expect(votesOf(e).candidato1).toBe(1);
  });
});

describe('Fila de apresentação', () => {
  it('limita animações simultâneas, agrupa backlog grande e preserva todos os votos', async () => {
    let maxActive = 0;
    let active = 0;
    const e = makeEngine({
      config: { presentation: { maxConcurrent: 3, groupThreshold: 10, groupBatchSize: 20 } },
      animator: {
        async approach() { active++; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 2)); },
        async vote() { active--; },
      },
    });
    await e.ingest(chat(1, 'candidato1'));
    const groups: number[] = [];
    e.bus.on('voter.group', (m) => groups.push(m.data.count as number));
    await Promise.all(Array.from({ length: 200 }, () => e.ingest(rose(1))));
    await e.drain();
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(groups.length).toBeGreaterThan(0);
    expect(votesOf(e).candidato1).toBe(200);
    expect(counts(e).byState).toEqual({ completed: 200 });
  });
});

describe('Barramento e eventos para a interface', () => {
  it('emite a sequência esperada para uma Rosa', async () => {
    const e = makeEngine();
    await e.ingest(chat(1, 'candidato1'));
    const seen: string[] = [];
    e.bus.on('*', (m) => seen.push(m.type));
    await e.ingest(rose(1));
    await e.drain();
    expect(seen).toEqual(['gift.processed', 'voter.created', 'candidate.vote_received', 'election.updated', 'voter.queued', 'voter.approaching', 'voter.voting', 'voter.completed']);
  });
});

describe('Mudança de posição no ranking', () => {
  it('emite candidate.ranking_changed apenas quando a ordem muda', async () => {
    const e = makeEngine();
    await e.ingest(chat(1, 'candidato1'));
    await e.ingest(chat(2, 'candidato3'));
    const changes: string[][] = [];
    e.bus.on('candidate.ranking_changed', (m) => changes.push(m.data.order as string[]));
    await e.ingest(rose(1)); // candidato1 já era o primeiro: ordem inalterada
    expect(changes).toEqual([]);
    await e.ingest(rose(2)); // candidato3 (1 voto) passa candidato2 (0); empata com c1, que chegou antes
    await e.ingest(rose(2)); // candidato3 passa candidato1
    expect(changes).toEqual([['candidato1', 'candidato3', 'candidato2'], ['candidato3', 'candidato1', 'candidato2']]);
  });
});

describe('Configuração', () => {
  it('rejeita configuração inválida sem alterar a atual', () => {
    const e = makeEngine();
    expect(() => e.admin.update({ likes: { threshold: 0 } })).toThrow(/threshold/);
    expect(() => e.admin.update({ likes: { targetPolicy: 'user_choice' } })).toThrow(/per_user/);
    expect(e.admin.get().likes.threshold).toBe(1000);
  });
});

describe('Dupla identidade: ElectionEngine importado', () => {
  it('a classe existe', () => expect(ElectionEngine).toBeTypeOf('function'));
});
