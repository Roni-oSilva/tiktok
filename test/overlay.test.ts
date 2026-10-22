import { afterAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { LULA_FLAVIO_PRESET } from '../src/preset.js';
import { GameWsServer } from '../src/wsServer.js';
import { InstantAnimator } from '../src/presentationQueue.js';
import { chat, cleanup, makeEngine, rose, viewer, votesOf } from './helpers.js';

afterAll(cleanup);
const preset = { ...LULA_FLAVIO_PRESET, presentation: { ...LULA_FLAVIO_PRESET.presentation, enabled: false } };

describe('Lula 13 × Flávio 22', () => {
  it('aceita "13", "22" e "!votar 13"; texto comum é ignorado', async () => {
    const e = makeEngine({ config: preset });
    expect((await e.ingest(chat(1, '13'))).outcome).toBe('command_applied');
    expect((await e.ingest({ ...chat(2, ''), text: '22' })).outcome).toBe('command_applied');
    expect((await e.ingest({ ...chat(3, ''), text: 'vota no 13 galera' })).outcome).toBe('ignored_chat');
    expect((await e.ingest({ ...chat(4, ''), text: '99' })).outcome).toBe('ignored_chat'); // número que não é candidato
    await e.ingest(rose(1)); await e.ingest(rose(2)); await e.ingest(rose(2));
    expect(votesOf(e)).toEqual({ lula: 1, flavio: 2 });
  });
  it('sem a opção, o número sozinho não vale', async () => {
    const e = makeEngine({ config: { ...preset, commands: { vote: ['!votar'], allowBareNumber: false } } });
    expect((await e.ingest({ ...chat(1, ''), text: '13' })).outcome).toBe('ignored_chat');
  });
});

describe('Cena (HTTP + ACK por WebSocket)', () => {
  it('serve a página, bloqueia path traversal e expõe /api/state', async () => {
    const e = makeEngine({ config: preset });
    const s = new GameWsServer(e, 0);
    const port = await s.start();
    const html = await fetch(`http://127.0.0.1:${port}/`);
    expect(html.status).toBe(200);
    expect(await html.text()).toContain('ELEIÇÃO PRESIDENCIAL');
    expect((await fetch(`http://127.0.0.1:${port}/assets/voter_miles.png`)).headers.get('content-type')).toBe('image/png');
    expect((await fetch(`http://127.0.0.1:${port}/..%2f..%2fpackage.json`)).status).toBeGreaterThanOrEqual(403);
    expect((await fetch(`http://127.0.0.1:${port}/../package.json`)).status).not.toBe(200);
    const st = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json();
    expect(st.candidates.map((c: any) => c.command)).toEqual(['13', '22']);
    await s.stop();
  });

  it('o eleitor só conclui depois do ACK da cena; voto já está confirmado antes', async () => {
    const e = makeEngine({ config: preset });
    const s = new GameWsServer(e, 0, '127.0.0.1', new InstantAnimator());
    e.presentation.animator = s.animator;
    const port = await s.start();
    const c = new WebSocket(`ws://127.0.0.1:${port}`);
    const phases: string[] = [];
    await new Promise<void>((r) => c.on('open', r));
    c.send(JSON.stringify({ type: 'hello', role: 'overlay' }));
    c.on('message', (d) => {
      const m = JSON.parse(String(d));
      if (m.type === 'voter.approaching') { phases.push('approaching'); setTimeout(() => c.send(JSON.stringify({ type: 'ack', voterId: m.data.voterId, phase: 'approach' })), 30); }
      if (m.type === 'voter.voting') { phases.push('voting'); setTimeout(() => c.send(JSON.stringify({ type: 'ack', voterId: m.data.voterId, phase: 'vote' })), 30); }
      if (m.type === 'voter.completed') phases.push('completed');
    });
    await new Promise((r) => setTimeout(r, 50));
    await e.ingest(chat(1, '22'));
    const r = await e.ingest(rose(1));
    expect(votesOf(e).flavio).toBe(1); // confirmado antes de qualquer animação
    expect(e.db.getVoter(r.voterIds[0])!.state).not.toBe('completed');
    await e.drain();
    await new Promise((r) => setTimeout(r, 60));
    expect(phases).toEqual(['approaching', 'voting', 'completed']);
    expect(e.db.getVoter(r.voterIds[0])!.state).toBe('completed');
    c.close(); await s.stop();
  });

  it('ACK de cliente que não é a cena é ignorado; cena que não responde → failed com voto preservado', async () => {
    const e = makeEngine({ config: preset });
    const s = new GameWsServer(e, 0);
    (s.animator as any).timeoutMs = 80;
    e.presentation.animator = s.animator;
    const port = await s.start();
    const c = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((r) => c.on('open', r));
    c.send(JSON.stringify({ type: 'hello', role: 'overlay' }));
    await new Promise((r) => setTimeout(r, 40));
    await e.ingest(chat(1, '13'));
    const r = await e.ingest(rose(1));
    await e.drain();
    expect(e.db.getVoter(r.voterIds[0])).toMatchObject({ state: 'failed', voteConfirmed: true });
    expect(votesOf(e).lula).toBe(1);
    const intruder = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((res) => intruder.on('open', res));
    intruder.send(JSON.stringify({ type: 'ack', voterId: r.voterIds[0], phase: 'approach' }));
    intruder.send(JSON.stringify({ kind: 'gift', hack: true }));
    c.close(); intruder.close(); await s.stop();
  });
});
