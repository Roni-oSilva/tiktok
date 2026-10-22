#!/usr/bin/env python3
"""Compõe e renderiza uma marchinha ORIGINAL (composição própria, sem samples) para a cena.
Uso: python3 scripts/make-music.py  ->  public/assets/default-music.wav (loop de ~33 s)."""
import numpy as np, wave, os
SR = 22050
BPM = 118
BEAT = 60 / BPM
EIGHTH = BEAT / 2
BARS = 16
N = int(SR * BEAT * 4 * BARS)
out = np.zeros(N)

def midi(m): return 440.0 * 2 ** ((m - 69) / 12)
def env(n, a=0.004, d=0.18, s=0.0):
    t = np.arange(n) / SR
    e = np.minimum(1, t / a) * (s + (1 - s) * np.exp(-t / d))
    return e
def pulse(f, n, duty=0.25, vib=0.0):
    t = np.arange(n) / SR
    ph = (f * t + vib * np.sin(2 * np.pi * 5.5 * t) * 0.01) % 1.0
    return np.where(ph < duty, 1.0, -1.0)
def tri(f, n):
    t = np.arange(n) / SR
    return 2 * np.abs(2 * ((f * t) % 1.0) - 1) - 1
def add(sig, start_s):
    i = int(start_s * SR)
    j = min(N, i + len(sig))
    if i < N: out[i:j] += sig[: j - i]

rng = np.random.default_rng(7)
def kick(t0):
    n = int(SR * 0.22); t = np.arange(n) / SR
    f = 120 * np.exp(-t * 28) + 42
    add(np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 14) * 0.9, t0)
def snare(t0):
    n = int(SR * 0.16); t = np.arange(n) / SR
    add((rng.uniform(-1, 1, n) * np.exp(-t * 26) * 0.5) + np.sin(2 * np.pi * 190 * t) * np.exp(-t * 30) * 0.25, t0)
def hat(t0, g=0.12):
    n = int(SR * 0.04); t = np.arange(n) / SR
    add(rng.uniform(-1, 1, n) * np.exp(-t * 90) * g, t0)

# acordes por compasso (C major) e notas de baixo
CH = {'C': (48, 52, 55), 'G': (43, 47, 50), 'Am': (45, 48, 52), 'F': (41, 45, 48)}
prog = ['C', 'G', 'Am', 'F', 'C', 'G', 'F', 'G', 'C', 'Am', 'F', 'G', 'C', 'F', 'G', 'C']
Nn = None
lead = [
    [76,76,79,79,76,72,76,Nn], [74,74,79,79,74,71,74,Nn], [72,72,76,76,72,69,72,Nn], [69,72,77,76,74,72,69,Nn],
    [79,79,76,76,72,76,79,Nn], [79,79,74,74,71,74,79,Nn], [77,77,72,72,69,72,77,Nn], [74,74,76,77,79,79,Nn,Nn],
    [72,76,79,76,72,76,79,84], [81,79,76,79,81,79,76,72], [77,81,84,81,77,81,84,81], [83,79,74,79,83,79,74,71],
    [72,76,79,84,79,76,72,Nn], [77,77,81,81,84,81,77,Nn], [79,79,83,83,86,83,79,Nn], [84,Nn,79,Nn,76,Nn,72,Nn],
]
for bar in range(BARS):
    t_bar = bar * BEAT * 4
    root, third, fifth = CH[prog[bar]]
    for b in range(4):
        tb = t_bar + b * BEAT
        # bateria de marcha
        if b in (0, 2): kick(tb)
        else: snare(tb)
        hat(tb); hat(tb + EIGHTH, 0.07)
        # baixo (oom): raiz no 1, quinta no 3
        if b in (0, 2):
            n = int(SR * BEAT * 0.9); note = root if b == 0 else fifth
            add(tri(midi(note), n) * env(n, d=0.35, s=0.15) * 0.5, tb)
        else:  # pah: acorde curto nos tempos 2 e 4
            n = int(SR * 0.22)
            for m in (root + 12, third + 12, fifth + 12):
                add(pulse(midi(m), n, 0.5) * env(n, d=0.09) * 0.075, tb)
    for i, m in enumerate(lead[bar]):
        if m is None: continue
        n = int(SR * EIGHTH * 0.95)
        add(pulse(midi(m), n, 0.25, vib=1.0) * env(n, d=0.22, s=0.25) * 0.17, t_bar + i * EIGHTH)

out /= max(1e-9, np.max(np.abs(out)))
out *= 0.7
# fade curto nas pontas para o loop não estalar
f = int(SR * 0.01); out[:f] *= np.linspace(0, 1, f); out[-f:] *= np.linspace(1, 0, f)
pcm = (out * 32767).astype('<i2')
dest = os.path.join(os.path.dirname(__file__), '..', 'public', 'assets', 'default-music.wav')
with wave.open(dest, 'wb') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())
print(f'{dest}: {N / SR:.1f}s, {os.path.getsize(dest) / 1e6:.2f} MB')
