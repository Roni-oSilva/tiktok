// Sons gerados no navegador (WebAudio). Nenhum arquivo de áudio é necessário.
// Música de fundo: usa assets/music.mp3 (ou .ogg/.m4a) se existir; senão toca uma melodia provisória sintetizada.
const params = new URLSearchParams(location.search);
const num = (k, d) => (params.has(k) && !Number.isNaN(Number(params.get(k))) ? Number(params.get(k)) : d);

export class Sound {
  constructor() {
    this.fxVol = num('vol', 0.7);
    this.musicVol = num('musicvol', 0.22);
    this.mute = params.get('mute') === '1';
    this.musicOn = params.get('music') !== '0' && !this.mute;
    this.ctx = null;
    this.music = null;
    this.synthTimer = null;
  }

  get running() { return !!this.ctx && this.ctx.state === 'running'; }

  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.mute ? 0 : 1;
      this.master.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  async unlock() {
    const c = this.ensure();
    if (!c) return false;
    try { await c.resume(); } catch { /* ignorado */ }
    if (this.running && this.musicOn && !this.musicStarted) await this.startMusic();
    return this.running;
  }

  tone(freq, dur, { type = 'sine', gain = 0.5, attack = 0.005, release = 0.03, when = 0 } = {}) {
    const c = this.ensure();
    if (!c || !this.running || this.mute) return;
    const t0 = c.currentTime + when;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain * this.fxVol), t0 + attack);
    g.gain.setValueAtTime(Math.max(0.0002, gain * this.fxVol), t0 + Math.max(attack, dur - release));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(this.master);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }

  /** Tecla da urna: bip curto. */
  key() { this.tone(1046, 0.09, { type: 'square', gain: 0.22 }); }
  /** "Confirma": bip longo característico do fim do voto (aproximação sintetizada). */
  confirm() { this.tone(1046, 0.12, { type: 'square', gain: 0.22 }); this.tone(1046, 1.35, { type: 'sine', gain: 0.55, release: 0.25, when: 0.14 }); }
  /** Ping suave de curtidas/entrada na fila. */
  ping() { this.tone(880, 0.12, { type: 'triangle', gain: 0.15 }); this.tone(1320, 0.16, { type: 'triangle', gain: 0.15, when: 0.09 }); }
  step() { this.tone(180 + Math.random() * 40, 0.05, { type: 'triangle', gain: 0.08 }); }

  async startMusic() {
    if (this.musicStarted || !this.musicOn) return;
    this.musicStarted = true;
    for (const ext of ['mp3', 'ogg', 'm4a']) {
      try {
        const r = await fetch(`assets/music.${ext}`, { method: 'HEAD' });
        if (r.ok) {
          const a = new Audio(`assets/music.${ext}`);
          a.loop = true;
          a.volume = Math.min(1, this.musicVol);
          await a.play();
          this.music = a;
          this.musicSource = `assets/music.${ext}`;
          return;
        }
      } catch { /* tenta o próximo */ }
    }
    this.startSynth();
  }

  // Melodia provisória (original, sintetizada). Substitua colocando assets/music.mp3.
  startSynth() {
    const c = this.ensure();
    if (!c) return;
    this.musicSource = 'synth';
    const bpm = 116, beat = 60 / bpm;
    const chords = [[261.63, 329.63, 392.0], [196.0, 246.94, 392.0], [220.0, 261.63, 329.63], [174.61, 220.0, 261.63]];
    const melody = [0, 1, 2, 1, 0, 1, 2, 2];
    let next = c.currentTime + 0.1, bar = 0;
    const g = c.createGain();
    g.gain.value = this.musicVol * 0.5;
    g.connect(this.master);
    const note = (f, t, d, type, gain) => {
      const o = c.createOscillator(), e = c.createGain();
      o.type = type; o.frequency.value = f;
      e.gain.setValueAtTime(0.0001, t);
      e.gain.exponentialRampToValueAtTime(gain, t + 0.01);
      e.gain.exponentialRampToValueAtTime(0.0001, t + d);
      o.connect(e).connect(g); o.start(t); o.stop(t + d + 0.02);
    };
    const schedule = () => {
      while (next < c.currentTime + 1.2) {
        const ch = chords[bar % 4];
        note(ch[0] / 2, next, beat * 0.9, 'triangle', 0.5);
        note(ch[0] / 2, next + beat * 2, beat * 0.9, 'triangle', 0.4);
        for (let i = 0; i < 8; i++) note(ch[melody[i] % 3] * 2, next + i * beat * 0.5, beat * 0.45, 'square', 0.12);
        next += beat * 4;
        bar++;
      }
    };
    schedule();
    this.synthTimer = setInterval(schedule, 400);
  }
}
