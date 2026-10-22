// Verificação visual: sobe o motor em simulação, abre a cena no Chromium e salva capturas.
import { chromium } from 'playwright-core';
import { ElectionEngine } from '../src/electionEngine.js';
import { LULA_FLAVIO_PRESET } from '../src/preset.js';
import { silentLogger } from '../src/logger.js';
import { GameWsServer } from '../src/wsServer.js';
import { TimerAnimator } from '../src/presentationQueue.js';

const out = process.argv[2] ?? '/tmp/work/shots';
const engine = new ElectionEngine({ dbPath: ':memory:', mode: 'simulation', logger: silentLogger, config: LULA_FLAVIO_PRESET });
const ws = new GameWsServer(engine, 0, '127.0.0.1', new TimerAnimator(() => engine.admin.get()));
engine.presentation.animator = ws.animator;
const port = await ws.start();
const base = { source: 'simulation', simulated: true };
let n = 0;
const ev = (o: object) => ({ ...base, eventId: `s${++n}`, ...o });
const v = (i: number, name: string) => ({ userId: `u${i}`, uniqueId: `u${i}`, displayName: name });

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 540, height: 960 } });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(() => (window as any).__overlay?.candidates?.length === 2);
await page.screenshot({ path: `${out}/1-vazio.png` });

// espectadores escolhem e enviam rosas
await engine.ingest(ev({ kind: 'chat', viewer: v(1, 'Ana'), text: '13' }));
await engine.ingest(ev({ kind: 'chat', viewer: v(2, 'Bruno'), text: '!votar 22' }));
await engine.ingest(ev({ kind: 'chat', viewer: v(3, 'Carla'), text: '13' }));
await engine.ingest(ev({ kind: 'chat', viewer: v(4, 'Diego'), text: '22' }));
for (const [i, nm] of [[1, 'Ana'], [2, 'Bruno'], [3, 'Carla'], [4, 'Diego']] as const)
  await engine.ingest(ev({ kind: 'gift', viewer: v(i, nm), giftId: '5655', giftName: 'Rose', repeatCount: 1, repeatEnd: true }));
await engine.ingest(ev({ kind: 'like', viewer: {}, likeCount: 640, totalLikeCount: 1_000_640 }));
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/2-caminhando.png` });
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/3-na-cabine.png` });
await page.waitForTimeout(1600);
await page.screenshot({ path: `${out}/4-digitando.png` });
await page.waitForTimeout(1300);
await page.screenshot({ path: `${out}/5-fim.png` });
await engine.drain();
const st = await page.evaluate(() => ({ target: (window as any).__overlay.target, applied: (window as any).__overlay.applied.size }));
console.log('placar na tela:', JSON.stringify(st.target), 'aplicados:', st.applied);
console.log('placar no motor:', JSON.stringify(Object.fromEntries(engine.candidates.all().map((c) => [c.id, c.votes]))));
console.log('estados:', JSON.stringify(engine.db.voterStats(engine.election.id).byState));
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/6-final.png` });
console.log('erros no navegador:', errors);
await browser.close(); await ws.stop(); await engine.close();
