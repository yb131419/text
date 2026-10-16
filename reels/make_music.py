"""產生 Reels 用的背景音樂（自己合成，沒有版權問題）。

用法：python3 reels/make_music.py   → 在 reels/music/ 產生幾首 mp3
想用自己的音樂：把 mp3 放進 reels/music/，剪片時會隨機挑一首。
"""
import os
import subprocess
import wave

import numpy as np

SR = 44100
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'music')

NOTE = {'C': 0, 'C#': 1, 'D': 2, 'D#': 3, 'E': 4, 'F': 5, 'F#': 6, 'G': 7, 'G#': 8, 'A': 9, 'A#': 10, 'B': 11}


def freq(name, octave):
    return 440.0 * 2 ** ((NOTE[name] + 12 * (octave - 4) - 9) / 12)


def env(n, attack, release):
    e = np.ones(n)
    a, r = int(attack * SR), int(release * SR)
    if a:
        e[:a] = np.linspace(0, 1, a)
    if r:
        e[-r:] *= np.linspace(1, 0, r)
    return e


def tone(f, dur, harmonics=(1, .35, .12), attack=.02, release=.3, detune=0.0):
    t = np.arange(int(dur * SR)) / SR
    s = sum(h * np.sin(2 * np.pi * f * (k + 1) * t) for k, h in enumerate(harmonics))
    if detune:
        s = s + .5 * np.sin(2 * np.pi * f * (1 + detune) * t)
    return s * env(len(t), attack, min(release, dur / 2))


def pluck(f, dur):
    t = np.arange(int(dur * SR)) / SR
    s = (np.sin(2 * np.pi * f * t) + .3 * np.sin(2 * np.pi * 2 * f * t)) * np.exp(-t * 5)
    return s * env(len(t), .004, .05)


def kick(dur=.35):
    t = np.arange(int(dur * SR)) / SR
    f = 110 * np.exp(-t * 18) + 45
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 9)


def hat(dur=.06, seed=0):
    rng = np.random.default_rng(seed)
    n = int(dur * SR)
    s = rng.standard_normal(n)
    s = np.diff(np.concatenate([[0], s]))   # 高頻一點
    return s * np.exp(-np.arange(n) / SR * 60) * .25


def add(buf, sig, at):
    i = int(at * SR)
    j = min(len(buf), i + len(sig))
    buf[i:j] += sig[:j - i]


def song(chords, bpm, bars_per_chord, loops, pad_oct, arp, drums, seed):
    beat = 60 / bpm
    bar = beat * 4
    total = len(chords) * bars_per_chord * bar * loops
    buf = np.zeros(int(total * SR) + SR)
    rng = np.random.default_rng(seed)
    pos = 0.0
    for _ in range(loops):
        for root, quality in chords:
            third = 3 if quality == 'm' else 4
            r = NOTE[root]
            notes = [r, r + third, r + 7, r + 12 + (2 if quality == 'add9' else 0)]
            length = bars_per_chord * bar
            for i, n in enumerate(notes[:3]):
                f = 440 * 2 ** ((n + 12 * (pad_oct - 4) - 9) / 12)
                add(buf, .16 * tone(f, length + .4, attack=.6, release=1.0, detune=.003), pos)
            fb = 440 * 2 ** ((r + 12 * (2 - 4) - 9) / 12)
            add(buf, .22 * tone(fb, length, harmonics=(1, .2), attack=.05, release=.4), pos)
            if arp:
                steps = int(length / (beat / 2))
                for s in range(steps):
                    n = notes[[0, 1, 2, 3, 2, 1][s % 6]] + 12
                    f = 440 * 2 ** ((n + 12 * (pad_oct - 4) - 9) / 12)
                    add(buf, .12 * (.8 + .2 * rng.random()) * pluck(f, beat), pos + s * beat / 2)
            if drums:
                for b in range(int(length / beat)):
                    t = pos + b * beat
                    if b % 2 == 0:
                        add(buf, .45 * kick(), t)
                    add(buf, hat(seed=b) * (1 if b % 2 else .6), t + beat / 2)
            pos += length
    # 簡單殘響：幾個延遲疊加
    wet = np.zeros_like(buf)
    for d, g in ((.031, .3), (.047, .25), (.071, .2), (.113, .15), (.173, .1)):
        k = int(d * SR)
        wet[k:] += g * buf[:-k]
    out = buf + .5 * wet
    out = out[:int(total * SR)]
    fade = int(.3 * SR)   # 接頭接尾只做短淡入淡出，循環播放比較順；成品結尾的淡出由 reels.py 做
    out[:int(.3 * SR)] *= np.linspace(0, 1, int(.3 * SR))
    out[-fade:] *= np.linspace(1, 0, fade)
    out /= np.max(np.abs(out)) + 1e-9
    return (out * .85 * 32767).astype(np.int16)


def save(name, data):
    os.makedirs(OUT, exist_ok=True)
    wav = os.path.join(OUT, name + '.wav')
    with wave.open(wav, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(data.tobytes())
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', wav, '-ac', '2', '-b:a', '128k',
                    os.path.join(OUT, name + '.mp3')], check=True)
    os.remove(wav)


if __name__ == '__main__':
    # 溫暖輕快：C G Am F
    save('溫暖輕快', song([('C', ''), ('G', ''), ('A', 'm'), ('F', '')], 96, 1, 6, 4, True, True, 1))
    # 清新療癒：F C Dm Bb（慢、沒有鼓）
    save('清新療癒', song([('F', ''), ('C', ''), ('D', 'm'), ('A#', '')], 76, 1, 5, 4, True, False, 2))
    # 質感沉穩：Am F C G
    save('質感沉穩', song([('A', 'm'), ('F', ''), ('C', ''), ('G', '')], 84, 1, 5, 3, False, True, 3))
