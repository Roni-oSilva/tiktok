import { afterAll, describe, expect, it } from 'vitest';
import { request } from 'node:http';
import { WebSocket } from 'ws';
import { apportion } from '../src/likeProcessor.js';
import { isBlockedName } from '../src/nameFilter.js';
import { LULA_FLAVIO_PRESET } from '../src/preset.js';
import { GameWsServer } from '../src/wsServer.js';
import { chat, cleanup, counts, likes, makeEngine, rose, tmpDb, viewer, votesOf } from './helpers.js';

afterAll(cleanup);
const preset = { ...LULA_FLAVIO_PRESET, presentation: { ...LULA_FLAVIO_PRESET.presentation, enabled: false } };

describe('apportion (maior resto, determinístico)', () => {
  it('reparte proporcionalmente e desempata pela ordem', () => {
    expect(apportion(1, { a: 30, b: 70 }, ['a', 'b'])).toEqual(['b']);
    expect(apportion(1, { a: 50, b: 50 }, ['a', 'b'])).toEqual(['a']);
    expect(apportion(4, { a: 1, b: 3 }, ['a', 'b'])).toEqual(['a', 'b', 'b', 'b']);
    expect(apportion(3, { a: 1, b: 1 }, ['a', 'b'])).toEqual(['a', 'a', 'b']);
    expect(apportion(2, {}, ['a', 'b'])).toEqual([null, null]);
    expect(apportion(0, { a: 1 }, ['a'])).toEqual([]);
  });
});

describe('Curtidas votam (proportional_choice)', () => {
  it('1.000 curtidas = 1 eleitor com 1 voto para o lado com mais curtidas identificadas', async () => {
    const e = makeEngine({ config: preset });
    await e.ingest(chat(1, '13')); await e.ingest(chat(2, '22'));
    await e.ingest(likes(300, { viewer: viewer(1) }));
    await e.ingest(likes(500, { viewer: viewer(2) }));
    await e.ingest(likes(100, { viewer: viewer(9) })); // sem escolha: conta no saldo, não escolhe lado
    const r = await e.ingest(likes(100, { viewer: {} }));
    expect(r.voterIds).toHaveLength(1);
    expect(votesOf(e)).toEqual({ lula: 0, flavio: 1 });
    expect(e.db.likeTotals(e.election.id)).toMatchObject({ balance: 0, votersGenerated: 1 });
  });
  it('várias de uma vez são repartidas na proporção; janela zera depois', async () => {
    const e = makeEngine({ config: preset });
    await e.ingest(chat(1, '13')); await e.ingest(chat(2, '22'));
    await e.ingest(likes(1500, { viewer: viewer(1) }));  // 1 eleitor → lula
    expect(votesOf(e)).toEqual({ lula: 1, flavio: 0 });
    await e.ingest(likes(500, { viewer: viewer(1) }));   // saldo 500+500=1000 → janela só tem lula(500)
    expect(votesOf(e).lula).toBe(2);
    const r = await e.ingest(likes(1000, { viewer: viewer(2) }));
    expect(r.voterIds).toHaveLength(1);
    expect(votesOf(e)).toEqual({ lula: 2, flavio: 1 });
  });
  it('sem curtidas identificadas, o eleitor participa sem votar (nada de sorteio)', async () => {
    const e = makeEngine({ config: preset });
    await e.ingest(likes(2000, { viewer: {} }));
    expect(counts(e)).toMatchObject({ voters: 2, votes: 0 });
  });
  it('é recuperado após reinício (janela persistida)', async () => {
    const path = tmpDb();
    let e = makeEngine({ dbPath: path, config: preset });
    await e.ingest(chat(2, '22'));
    await e.ingest(likes(600, { viewer: viewer(2) }));
    await e.close();
    e = makeEngine({ dbPath: path, config: preset });
    await e.ingest(likes(400, { viewer: {} }));
    expect(votesOf(e).flavio).toBe(1);
  });
  it('cumulativo com usuário identificado também atribui (limitado ao aumento real)', async () => {
    const e = makeEngine({ config: preset });
    await e.ingest(chat(1, '13'));
    await e.ingest(likes(undefined, { totalLikeCount: 5000 }));                       // referência
    await e.ingest(likes(1000, { viewer: viewer(1), totalLikeCount: 6000 }));        // +1000
    await e.ingest(likes(1000, { viewer: viewer(1), totalLikeCount: 6000 }));        // total não subiu: não conta de novo
    expect(votesOf(e).lula).toBe(1);
    expect(e.db.likeTotals(e.election.id).counted).toBe(1000);
  });
  it('config inválida é recusada', () => {
    const e = makeEngine({ config: preset });
    expect(() => e.admin.update({ likes: { accumulation: 'per_user' } })).toThrow(/proportional_choice/);
  });
});

describe('Filtro de nomes', () => {
  it('bloqueia palavrões, ofensas políticas, links; não barra nomes comuns', () => {
    for (const n of ['p0rr4', 'Seu Merda', 'PETRALHA 13', 'bols0nazi', 'visite www.site.com', '@meuinsta_oficial', 'fdp', 'v.i.a.d.o']) expect(isBlockedName(n), n).toBe(true);
    for (const n of ['Lucas', 'Curitiba', 'Maria Putinha'.replace('Putinha', 'Souza'), 'Cuca', 'Paulo Pires', 'Ana 13', 'Escudeiro', 'Analista']) expect(isBlockedName(n), n).toBe(false);
    expect(isBlockedName('Zé do Brejo', ['brejo'])).toBe(true);
  });
  it('eleitor e aviso de escolha usam nome genérico quando o nome é bloqueado', async () => {
    const e = makeEngine({ config: preset });
    const seen: string[] = [];
    e.bus.on('voter.created', (m) => seen.push(String(m.data.displayName)));
    e.bus.on('viewer.choice', (m) => seen.push(String(m.data.displayName)));
    await e.ingest(chat(1, '13', { viewer: viewer(1, 'seu merda') }));
    await e.ingest(rose(1, { viewer: viewer(1, 'seu merda') }));
    await e.ingest(chat(2, '22', { viewer: viewer(2, 'Joana') }));
    expect(seen).toEqual(['Alguém', 'Eleitor', 'Joana']);
  });
});

describe('Painel admin', () => {
  it('exige token e host local; encerra, zera e a cena recebe snapshot novo', async () => {
    const e = makeEngine({ config: preset });
    const s = new GameWsServer(e, 0);
    s.adminToken = 'segredo123';
    const port = await s.start();
    const url = (p: string) => `http://127.0.0.1:${port}${p}`;
    expect((await fetch(url('/api/admin/status'))).status).toBe(403);
    expect((await fetch(url('/api/admin/status'), { headers: { 'x-admin-token': 'errado' } })).status).toBe(403);
    expect((await fetch(url('/api/admin/finish'), { method: 'POST' })).status).toBe(403);
    const H = { 'x-admin-token': 'segredo123' };
    await e.ingest(chat(1, '13')); await e.ingest(rose(1));
    const st = await (await fetch(url('/api/admin/status'), { headers: H })).json();
    expect(st.snapshot.ranking.totalValidVotes).toBe(1);
    expect(st.integrity.ok).toBe(true);

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const types: string[] = [];
    await new Promise<void>((r) => ws.on('open', r));
    ws.on('message', (d) => types.push(JSON.parse(String(d)).type));
    const fin = await (await fetch(url('/api/admin/finish'), { method: 'POST', headers: H })).json();
    expect(fin.ranking.entries[0].candidateId).toBe('lula');
    expect((await e.ingest(rose(1))).outcome).toBe('rejected_closed');
    const first = e.election.id;
    const nw = await (await fetch(url('/api/admin/new'), { method: 'POST', headers: H })).json();
    expect(nw.previousElectionId).toBe(first);
    expect(e.election.id).not.toBe(first);
    expect(votesOf(e)).toEqual({ lula: 0, flavio: 0 });
    expect((await e.ingest({ ...chat(1, '13') })).outcome).toBe('command_applied'); // eventos voltam a valer
    await new Promise((r) => setTimeout(r, 60));
    expect(types).toContain('election.finished');
    expect(types.filter((t) => t === 'snapshot').length).toBeGreaterThanOrEqual(1);
    const bad = await fetch(url('/api/admin/likes-threshold'), { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ value: 0 }) });
    expect(bad.status).toBe(400);
    const ok = await fetch(url('/api/admin/likes-threshold'), { method: 'POST', headers: H, body: JSON.stringify({ value: 500 }) });
    expect(ok.status).toBe(200);
    expect(e.admin.get().likes.threshold).toBe(500);
    ws.close(); await s.stop();
  });
  it('rejeita Host não local e WebSocket de outra origem', async () => {
    const e = makeEngine({ config: preset });
    const s = new GameWsServer(e, 0);
    s.adminToken = 'x';
    const port = await s.start();
    const status = await new Promise<number>((res, rej) => {
      const rq = request({ host: '127.0.0.1', port, path: '/api/admin/status', headers: { 'x-admin-token': 'x', host: 'evil.example' } }, (r) => { r.resume(); res(r.statusCode ?? 0); });
      rq.on('error', rej); rq.end();
    });
    expect(status).toBe(403); // token certo, mas Host não local
    const bad = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'http://evil.example' });
    const outcome = await new Promise<string>((res) => { bad.on('open', () => res('open')); bad.on('error', () => res('blocked')); bad.on('unexpected-response', () => res('blocked')); });
    expect(outcome).toBe('blocked');
    await s.stop();
  });
});
