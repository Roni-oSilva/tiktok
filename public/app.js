import { Sound } from './audio.js';

const params = new URLSearchParams(location.search);
const THEME = {
  lula: { color: '#e63946', photo: 'assets/cand_lula.jpg', short: 'LULA' },
  flavio: { color: '#1d6fd8', photo: 'assets/cand_flavio.jpg', short: 'FLÁVIO' },
};
const FALLBACK_COLORS = ['#2a9d8f', '#f4a261', '#9b5de5', '#e76f51'];
const SPRITES = ['assets/voter_miles.png', 'assets/voter_gwen.png', 'assets/voter_pavitr.png', 'assets/voter_punk.png'];
const GROUND_Y = 590;            // base dos pés dentro de #scene (px do palco)
const BOOTH_HIDE_X = 700;        // x (esquerda do sprite) em que o eleitor fica atrás da cabine
const EXIT_X = 1120;

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n) => Math.round(n).toLocaleString('pt-BR');
const sound = new Sound();

// ---------- palco responsivo (9:16) ----------
function fit() {
  const s = Math.min(innerWidth / 1080, innerHeight / 1920);
  const st = $('stage');
  st.style.transform = `translate(${(innerWidth - 1080 * s) / 2}px, ${(innerHeight - 1920 * s) / 2}px) scale(${s})`;
}
addEventListener('resize', fit); fit();

// ---------- estado ----------
const S = {
  candidates: [], shown: {}, target: {}, meta: new Map(), applied: new Set(), backlog: 0,
  simulated: false, spriteIdx: 0, walkers: new Map(), urnaBusy: Promise.resolve(), likes: { balance: 0, threshold: 1000 },
  finished: false, ranking: null, voteApplied: 0,
};
window.__overlay = S; // facilita testes e depuração

const theme = (c, i) => THEME[c.id] ?? { color: FALLBACK_COLORS[i % FALLBACK_COLORS.length], photo: null, short: c.name.toUpperCase() };
const speed = () => Math.min(3.5, 1 + S.backlog / 8) * Number(params.get('speed') ?? 1);

// ---------- placar ----------
function buildCards() {
  const wrap = $('cards'); wrap.innerHTML = '';
  S.candidates.forEach((c, i) => {
    const t = theme(c, i);
    const el = document.createElement('div');
    el.className = 'card'; el.id = `card-${c.id}`; el.style.setProperty('--c', t.color);
    el.innerHTML = `<div class="num">${c.command}</div><div class="crown">👑</div>
      <div class="photo">${t.photo ? `<img src="${t.photo}" alt="">` : ''}</div>
      <div class="name">${c.name}</div><div class="votes"><span class="v">0</span><small>VOTOS</small></div><div class="pct">0%</div>`;
    wrap.appendChild(el);
  });
  const [a, b] = S.candidates;
  if (a) $('numA').textContent = a.command;
  if (b) $('numB').textContent = b.command;
  $('shareA').style.background = a ? theme(a, 0).color : '#888';
  $('shareB').style.background = b ? theme(b, 1).color : '#888';
}

const tween = new Map();
function renderTally() {
  const total = S.candidates.reduce((s, c) => s + (S.target[c.id] ?? 0), 0);
  const max = Math.max(0, ...S.candidates.map((c) => S.target[c.id] ?? 0));
  S.candidates.forEach((c, i) => {
    const el = $(`card-${c.id}`); if (!el) return;
    const to = S.target[c.id] ?? 0, from = S.shown[c.id] ?? 0;
    if (from !== to) {
      el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
      cancelAnimationFrame(tween.get(c.id));
      const t0 = performance.now();
      const step = (t) => {
        const k = Math.min(1, (t - t0) / 450);
        const v = from + (to - from) * k;
        S.shown[c.id] = v; el.querySelector('.v').textContent = fmt(v);
        if (k < 1) tween.set(c.id, requestAnimationFrame(step)); else S.shown[c.id] = to;
      };
      tween.set(c.id, requestAnimationFrame(step));
    }
    el.querySelector('.pct').textContent = total ? `${(to / total * 100).toFixed(1).replace('.', ',')}%` : '0%';
    el.classList.toggle('leader', max > 0 && to === max && S.candidates.filter((x) => (S.target[x.id] ?? 0) === max).length === 1);
  });
  const [a, b] = S.candidates;
  if (a && b) {
    const pa = total ? (S.target[a.id] ?? 0) / total * 100 : 50;
    $('shareA').style.width = `${pa}%`; $('shareB').style.width = `${100 - pa}%`;
    $('shareLabel').textContent = total ? `${fmt(S.target[a.id] ?? 0)}  ×  ${fmt(S.target[b.id] ?? 0)}` : 'AGUARDANDO O PRIMEIRO VOTO';
  }
}
function addVotes(cid, n) { S.target[cid] = (S.target[cid] ?? 0) + n; S.voteApplied += n; renderTally(); }

function renderLikes() {
  const { balance, threshold } = S.likes;
  $('thr').textContent = fmt(threshold);
  $('likeFill').style.width = `${Math.min(100, balance / threshold * 100)}%`;
  $('likeText').textContent = `❤ ${fmt(balance)} / ${fmt(threshold)} curtidas para o próximo eleitor`;
}

function tick(text) {
  const t = $('ticker');
  const el = document.createElement('div'); el.className = 'tick'; el.textContent = text;
  t.prepend(el);
  while (t.children.length > 3) t.lastChild.remove();
}

// ---------- eleitores ----------
function spawnVoter(m) {
  const el = document.createElement('div'); el.className = 'voter';
  const img = document.createElement('img'); img.className = 'sprite'; img.src = SPRITES[S.spriteIdx++ % SPRITES.length];
  const tag = document.createElement('div'); tag.className = 'tag';
  tag.textContent = `${m.origin === 'likes' ? '❤' : '🌹'} ${m.displayName}`;
  el.append(img, tag);
  el.style.transform = `translate(-200px, ${GROUND_Y - 190}px)`;
  $('voters').appendChild(el);
  return { el, img, x: -200 };
}

function walk(w, toX, ms) {
  const from = w.x;
  const anim = w.el.animate([{ transform: `translate(${from}px, ${GROUND_Y - 190}px)` }, { transform: `translate(${toX}px, ${GROUND_Y - 190}px)` }], { duration: ms, easing: 'linear', fill: 'forwards' });
  const bob = w.img.animate([{ transform: 'translateY(0) rotate(-2deg)' }, { transform: 'translateY(-14px) rotate(2deg)' }, { transform: 'translateY(0) rotate(-2deg)' }], { duration: 340 / Math.min(2.2, speed()), iterations: Infinity });
  const steps = setInterval(() => sound.step(), 340 / Math.min(2.2, speed()));
  return anim.finished.then(() => { w.x = toX; bob.cancel(); clearInterval(steps); }).catch(() => { bob.cancel(); clearInterval(steps); });
}

async function onApproaching(d) {
  if (S.walkers.has(d.voterId)) return;
  const m = S.meta.get(d.voterId) ?? d;
  const w = spawnVoter(m); S.walkers.set(d.voterId, w);
  await walk(w, BOOTH_HIDE_X, 2600 / speed());
  w.hidden = true;
  send({ type: 'ack', voterId: d.voterId, phase: 'approach' });
}

// ---------- urna ----------
function buildKeypad() {
  const k = $('keypad'); k.innerHTML = '';
  for (const d of ['1','2','3','4','5','6','7','8','9']) k.insertAdjacentHTML('beforeend', `<div class="key" data-k="${d}">${d}</div>`);
  k.insertAdjacentHTML('beforeend', '<div class="key branco">BRANCO</div><div class="key zero" data-k="0">0</div><div class="key corrige">CORRIGE</div>');
  k.insertAdjacentHTML('beforeend', '<div></div><div class="key confirma">CONFIRMA</div><div></div>');
}
const hot = (d) => { const e = document.querySelector(`.key[data-k="${d}"]`); if (!e) return; e.classList.add('hot'); setTimeout(() => e.classList.remove('hot'), 220); };

function runUrna(voterId) {
  // Uma sequência por vez (a urna é uma só).
  S.urnaBusy = S.urnaBusy.then(() => urnaSequence(voterId)).catch(() => {});
  return S.urnaBusy;
}

async function urnaSequence(voterId) {
  const m = S.meta.get(voterId) ?? {};
  const cand = S.candidates.find((c) => c.id === m.candidateId);
  const sp = speed(), T = (ms) => sleep(ms / sp);
  const urna = $('urna'), scr = $('urnaScreen');
  urna.hidden = false;
  scr.innerHTML = `<div class="small">SEU VOTO PARA</div><div style="font-size:30px">PRESIDENTE</div><div class="boxes"><div class="box"></div><div class="box"></div></div><div class="small">Número</div>`;
  await T(450);
  if (cand && m.votes > 0) {
    const t = theme(cand, S.candidates.indexOf(cand));
    const boxes = scr.querySelectorAll('.box');
    for (let i = 0; i < cand.command.length; i++) { boxes[i].textContent = cand.command[i]; hot(cand.command[i]); sound.key(); await T(520); }
    scr.insertAdjacentHTML('beforeend', `<div class="cand">${t.photo ? `<img src="${t.photo}" alt="">` : ''}<div class="nm">${cand.name}<small>PRESIDENTE • Nº ${cand.command}</small></div></div>`);
    await T(800);
    sound.confirm();
    scr.insertAdjacentHTML('beforeend', `<div class="fim"><div class="big"><i>★</i> FIM <i>★</i></div><div class="who">VOTOU NO ${t.short}</div></div>`);
    if (!S.applied.has(voterId)) { S.applied.add(voterId); addVotes(cand.id, m.votes); }
    tick(`${m.displayName} votou no ${cand.command}${m.votes > 1 ? ` (+${m.votes} votos)` : ''}`);
    await T(1700);
  } else {
    scr.insertAdjacentHTML('beforeend', `<div class="fim"><div class="big" style="font-size:54px">PARTICIPOU</div><div class="who">${m.origin === 'likes' ? 'ELEITOR DAS CURTIDAS' : 'SEM CANDIDATO ESCOLHIDO'}</div></div>`);
    sound.ping();
    await T(1400);
  }
  urna.hidden = true;
  send({ type: 'ack', voterId, phase: 'vote' });
}

async function onVoting(d) {
  if (!S.walkers.has(d.voterId)) { // cena conectada no meio do caminho: encosta o eleitor na cabine
    const w = spawnVoter(S.meta.get(d.voterId) ?? d); w.x = BOOTH_HIDE_X; w.el.style.transform = `translate(${BOOTH_HIDE_X}px, ${GROUND_Y - 190}px)`; S.walkers.set(d.voterId, w);
  }
  await runUrna(d.voterId);
}

async function onDone(d) {
  const m = S.meta.get(d.voterId);
  if (m && !S.applied.has(d.voterId) && m.candidateId && m.votes > 0) { S.applied.add(d.voterId); addVotes(m.candidateId, m.votes); }
  S.backlog = Math.max(0, S.backlog - 1);
  const w = S.walkers.get(d.voterId); if (!w) return;
  S.walkers.delete(d.voterId);
  await walk(w, EXIT_X, 2000 / speed());
  w.el.remove(); S.meta.delete(d.voterId);
}

function onGroup(d) {
  for (const [cid, n] of Object.entries(d.votesByCandidate ?? {})) addVotes(cid, n);
  for (const id of d.voterIds ?? []) { S.applied.add(id); S.meta.delete(id); }
  S.backlog = Math.max(0, S.backlog - (d.count ?? 0));
  const g = $('groupBurst'); g.hidden = false; g.replaceWith(g.cloneNode(false)); const g2 = $('groupBurst');
  g2.hidden = false; g2.innerHTML = `+${d.count} eleitores votaram!<br><small style="font-size:24px">${(d.sampleNames ?? []).join(' • ')}</small>`;
  sound.ping(); tick(`+${d.count} eleitores votaram de uma vez`);
  setTimeout(() => { g2.hidden = true; }, 2200);
}

// ---------- mensagens do motor ----------
function applySnapshot(s) {
  S.simulated = !!s.simulated; $('simBanner').hidden = !s.simulated;
  S.candidates = s.candidates ?? [];
  S.target = {}; S.shown = {};
  for (const c of S.candidates) { S.target[c.id] = 0; S.shown[c.id] = 0; }
  for (const e of s.ranking?.entries ?? []) S.target[e.candidateId] = e.votes;
  for (const p of s.pending ?? []) S.target[p.candidateId] -= p.votes; // entram no placar quando votarem na cena
  S.shown = { ...S.target };
  S.likes = { balance: s.likes?.balance ?? 0, threshold: s.likes?.threshold ?? 1000 };
  S.backlog = s.presentationBacklog ?? 0;
  S.finished = s.election?.status === 'finished';
  buildCards(); renderTally(); renderLikes();
  S.candidates.forEach((c) => { const v = $(`card-${c.id}`)?.querySelector('.v'); if (v) v.textContent = fmt(S.target[c.id]); });
}

function onMessage(m) {
  const d = m.data;
  switch (m.type) {
    case 'snapshot': applySnapshot(d); break;
    case 'voter.created': S.meta.set(d.voterId, d); break;
    case 'voter.queued': S.meta.set(d.voterId, { ...(S.meta.get(d.voterId) ?? {}), ...d }); if (!d.replay) S.backlog++; break;
    case 'voter.approaching': S.meta.set(d.voterId, { ...(S.meta.get(d.voterId) ?? {}), ...d }); void onApproaching(d); break;
    case 'voter.voting': void onVoting(d); break;
    case 'voter.completed': if (!d.grouped) void onDone(d); break;
    case 'voter.failed': void onDone(d); break;
    case 'voter.group': onGroup(d); break;
    case 'likes.progress': S.likes = { balance: d.balance, threshold: d.threshold }; renderLikes(); break;
    case 'likes.threshold_reached': sound.ping(); tick(`❤ ${fmt(d.threshold)} curtidas! +${d.voters} eleitor${d.voters > 1 ? 'es' : ''}`); break;
    case 'viewer.choice': { const c = S.candidates.find((x) => x.id === d.candidateId); if (c) tick(`${d.displayName ?? 'Alguém'} escolheu o ${c.command}`); break; }
    case 'election.finished': showWinner(d); break;
    default: break;
  }
}

function showWinner(d) {
  const top = d.ranking?.entries?.[0]; if (!top) return;
  const tie = d.ranking.entries[1] && d.ranking.entries[1].votes === top.votes;
  const i = S.candidates.findIndex((c) => c.id === top.candidateId); const t = theme(S.candidates[i] ?? { id: '', name: top.name }, i);
  const w = $('winner'); w.hidden = false;
  w.innerHTML = tie ? `<h1>RESULTADO FINAL</h1><p>EMPATE</p>` : `<h1>RESULTADO FINAL</h1>${t.photo ? `<img src="${t.photo}" alt="">` : ''}<p>${top.name}<br>${fmt(top.votes)} votos (${top.percent.toFixed(1).replace('.', ',')}%)</p>`;
}

// ---------- conexão ----------
let ws, backoff = 500;
function send(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/`);
  ws.onopen = () => { backoff = 500; $('connDot').className = 'on'; send({ type: 'hello', role: 'overlay' }); };
  ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch (err) { console.error(err); } };
  ws.onclose = () => { $('connDot').className = 'off'; for (const w of S.walkers.values()) w.el.remove(); S.walkers.clear(); $('urna').hidden = true; setTimeout(connect, backoff); backoff = Math.min(5000, backoff * 2); };
  ws.onerror = () => ws.close();
}

// ---------- som ----------
async function tryAudio() {
  const ok = await sound.unlock();
  $('soundBtn').hidden = ok || sound.mute;
  return ok;
}
$('soundBtn').addEventListener('click', tryAudio);
addEventListener('pointerdown', tryAudio, { once: false });
addEventListener('keydown', tryAudio);

buildKeypad(); renderLikes(); connect(); tryAudio().then((ok) => { if (!ok) $('soundBtn').hidden = sound.mute; });
