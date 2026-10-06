// WebAudio-only paper-textured synthesis; initialized by a user gesture.
export const AUDIO_LIMITS = { maxVoices: 8, maxEventsPerWindow: 8, windowSeconds: 0.05 } as const;

interface SoundProfile {
  notes: number[];
  endRatio: number;
  duration: number;
  type?: OscillatorType;
  noise?: number;
  priority: number;
  spacing?: number;
}
interface Voice {
  nodes: AudioNode[];
  sources: AudioScheduledSourceNode[];
  priority: number;
  remaining: number;
}

const SOUNDS: Record<string, SoundProfile> = {
  shot_canon: { notes: [260], endRatio: 0.42, duration: 0.075, noise: 700, priority: 0 },
  shot_dualCanon: { notes: [300, 235], endRatio: 0.45, duration: 0.065, spacing: 0.025, priority: 0 },
  shot_machineGun: { notes: [720], endRatio: 0.4, duration: 0.025, noise: 1500, priority: 0 },
  shot_simpleLaser: { notes: [1050], endRatio: 0.45, duration: 0.08, type: 'sine', priority: 0 },
  shot_bounceChain: { notes: [780, 1040, 1300], endRatio: 0.85, duration: 0.06, spacing: 0.025, type: 'sine', priority: 0 },
  shot_straightPierce: { notes: [1600], endRatio: 0.24, duration: 0.12, type: 'sine', priority: 0 },
  shot_mortar: { notes: [100], endRatio: 0.5, duration: 0.14, noise: 260, priority: 0 },
  shot_mine: { notes: [170], endRatio: 0.3, duration: 0.055, noise: 480, priority: 0 },
  shot_rocket: { notes: [180], endRatio: 1.8, duration: 0.16, noise: 1000, priority: 0 },
  shot_glueTower: { notes: [105], endRatio: 0.8, duration: 0.13, noise: 180, priority: 0 },
  shot_glueGun: { notes: [200], endRatio: 0.5, duration: 0.07, noise: 380, priority: 0 },
  shot_teleport: { notes: [400, 620], endRatio: 2.5, duration: 0.18, spacing: 0.03, type: 'sine', priority: 0 },
  hit_explosion: { notes: [75], endRatio: 0.5, duration: 0.22, noise: 600, priority: 0 },
  enemy_death: { notes: [440], endRatio: 0.35, duration: 0.065, priority: 0 },
  wave_start: { notes: [330, 440, 550], endRatio: 1, duration: 0.15, spacing: 0.065, priority: 2 },
  build: { notes: [360, 540], endRatio: 1, duration: 0.07, spacing: 0.025, noise: 800, priority: 1 },
  enhance: { notes: [440, 660, 880], endRatio: 1, duration: 0.10, spacing: 0.045, priority: 1 },
  sell: { notes: [520, 350], endRatio: 0.9, duration: 0.08, spacing: 0.04, priority: 1 },
  life_lost: { notes: [330, 220], endRatio: 1, duration: 0.12, spacing: 0.13, priority: 3 },
  victory: { notes: [440, 550, 660], endRatio: 1, duration: 0.24, spacing: 0.11, priority: 4 },
  defeat: { notes: [330, 260, 165], endRatio: 0.85, duration: 0.22, spacing: 0.12, priority: 4 },
};
const ALIASES: Record<string, string> = {
  shot_bullet: 'shot_canon', shot_laser: 'shot_simpleLaser',
  shot_explosive: 'shot_mortar', shot_glue: 'shot_glueTower', sfx_teleport: 'shot_teleport',
  shot_bouncingLaser: 'shot_bounceChain', shot_straightLaser: 'shot_straightPierce',
  shot_mineLayer: 'shot_mine', shot_rocketLauncher: 'shot_rocket',
};

let _ctx: AudioContext | null = null;
let _masterGain: GainNode | null = null;
let _sfxGain: GainNode | null = null;
let _muted = false;
let _ambientWanted = false;
let _ambientNodes: AudioNode[] = [];
let _ambientSources: OscillatorNode[] = [];
const voices = new Set<Voice>();
const noiseCache = new Map<number, AudioBuffer>();
const lastTagTime = new Map<string, number>();
let windowStart = -Infinity;
let windowEvents = 0;
let windowOrdinary = 0;

function disconnect(nodes: AudioNode[]): void {
  for (const node of nodes) {
    try { node.disconnect(); } catch { /* already disconnected */ }
  }
}

function finishVoice(voice: Voice, stop = false): void {
  if (!voices.delete(voice)) return;
  for (const source of voice.sources) {
    source.onended = null;
    if (stop) {
      try { source.stop(); } catch { /* already ended */ }
    }
  }
  disconnect(voice.nodes);
}

function clearVoices(): void {
  for (const voice of [...voices]) finishVoice(voice, true);
  lastTagTime.clear();
  windowStart = -Infinity;
  windowEvents = 0;
  windowOrdinary = 0;
}

export function initAudio(): void {
  if (_muted) return;
  if (!_ctx) {
    try {
      _ctx = new AudioContext();
      _masterGain = _ctx.createGain();
      _masterGain.gain.value = 0.25;
      _masterGain.connect(_ctx.destination);
      _sfxGain = _ctx.createGain();
      _sfxGain.gain.value = 0.3;
      _sfxGain.connect(_masterGain);
    } catch {
      disposeAudio();
      return;
    }
  }
  const ctx = _ctx;
  if (ctx.state === 'suspended') {
    ctx.resume().then(() => {
      if (_ctx !== ctx) return;
      if (_muted) void ctx.suspend().catch(() => {});
      else if (_ambientWanted) startAmbient();
    }).catch(() => {});
  } else if (_ambientWanted) {
    startAmbient();
  }
}

export function setMuted(muted: boolean): void {
  _muted = muted;
  if (muted) {
    const wanted = _ambientWanted;
    stopAmbient();
    _ambientWanted = wanted;
    clearVoices();
    if (_masterGain && _ctx) {
      _masterGain.gain.cancelScheduledValues(_ctx.currentTime);
      _masterGain.gain.value = 0;
      void _ctx.suspend().catch(() => {});
    }
  } else {
    if (_masterGain) _masterGain.gain.value = 0.25;
    if (_ctx) initAudio();
  }
}

export function isMuted(): boolean { return _muted; }

function noiseBuffer(ctx: AudioContext): AudioBuffer {
  const cached = noiseCache.get(ctx.sampleRate);
  if (cached) return cached;
  const buffer = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * 0.5)), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  noiseCache.set(ctx.sampleRate, buffer);
  return buffer;
}

export function playSfx(tag: string): void {
  if (!_ctx || !_sfxGain || _muted || _ctx.state !== 'running') return;
  const key = ALIASES[tag] ?? tag;
  const profile = SOUNDS[key];
  if (!profile) return;
  const ctx = _ctx;
  const now = ctx.currentTime;
  if (now - windowStart >= AUDIO_LIMITS.windowSeconds || now < windowStart) {
    windowStart = now;
    windowEvents = 0;
    windowOrdinary = 0;
  }
  const cooldown = profile.priority >= 2 ? 0.2 : AUDIO_LIMITS.windowSeconds;
  if (now - (lastTagTime.get(key) ?? -Infinity) < cooldown) return;
  // Reserve two admissions for life/result cues, including after a wave alert.
  if (windowEvents >= AUDIO_LIMITS.maxEventsPerWindow
    || (profile.priority < 3 && windowEvents >= AUDIO_LIMITS.maxEventsPerWindow - 2)
    || (profile.priority === 3 && windowEvents >= AUDIO_LIMITS.maxEventsPerWindow - 1)
    || (profile.priority < 2 && windowOrdinary >= AUDIO_LIMITS.maxEventsPerWindow - 2)) return;
  if (voices.size >= AUDIO_LIMITS.maxVoices) {
    const victim = [...voices].sort((a, b) => a.priority - b.priority)[0];
    if (victim.priority >= profile.priority) return;
    finishVoice(victim, true);
  }

  const voice: Voice = { nodes: [], sources: [], priority: profile.priority, remaining: 0 };
  voices.add(voice);
  const attach = (source: AudioScheduledSourceNode, nodes: AudioNode[], time: number, duration: number) => {
    voice.nodes.push(...nodes);
    voice.sources.push(source);
    voice.remaining++;
    source.onended = () => {
      if (!voices.has(voice)) return;
      disconnect(nodes);
      voice.remaining--;
      if (voice.remaining === 0) finishVoice(voice);
    };
    source.start(time);
    source.stop(time + duration + 0.015);
  };
  try {
    profile.notes.forEach((frequency, i) => {
      const time = now + i * (profile.spacing ?? 0);
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = profile.type ?? 'triangle';
      oscillator.frequency.setValueAtTime(frequency, time);
      oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, frequency * profile.endRatio), time + profile.duration);
      gain.gain.setValueAtTime(0.001, time);
      gain.gain.linearRampToValueAtTime(0.11 / Math.sqrt(profile.notes.length), time + 0.004);
      gain.gain.exponentialRampToValueAtTime(0.001, time + profile.duration);
      oscillator.connect(gain);
      gain.connect(_sfxGain!);
      attach(oscillator, [oscillator, gain], time, profile.duration);
    });
    if (profile.noise !== undefined) {
      const source = ctx.createBufferSource();
      const filter = ctx.createBiquadFilter();
      const gain = ctx.createGain();
      source.buffer = noiseBuffer(ctx);
      filter.type = 'lowpass';
      filter.frequency.value = profile.noise;
      gain.gain.setValueAtTime(0.045, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + profile.duration);
      source.connect(filter);
      filter.connect(gain);
      gain.connect(_sfxGain!);
      attach(source, [source, filter, gain], now, profile.duration);
    }
    lastTagTime.set(key, now);
    windowEvents++;
    if (profile.priority < 2) windowOrdinary++;
  } catch {
    finishVoice(voice, true);
  }
}

export function startAmbient(): void {
  _ambientWanted = true;
  if (_ambientSources.length || !_ctx || !_masterGain || _muted || _ctx.state !== 'running') return;
  const ctx = _ctx;
  const now = ctx.currentTime;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(0.045, now + 1);
  gain.connect(_masterGain);
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 250;
  filter.connect(gain);
  _ambientNodes = [gain, filter];
  for (const frequency of [55, 82.4, 110]) {
    const oscillator = ctx.createOscillator();
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    oscillator.connect(filter);
    _ambientNodes.push(oscillator);
    _ambientSources.push(oscillator);
    oscillator.start(now);
  }
}

export function stopAmbient(): void {
  _ambientWanted = false;
  for (const source of _ambientSources) {
    source.onended = null;
    try { source.stop(); } catch { /* already stopped */ }
  }
  disconnect(_ambientNodes);
  _ambientNodes = [];
  _ambientSources = [];
}

export function stopGameAudio(): void {
  stopAmbient();
  clearVoices();
}

// Optional full teardown on app shutdown, not required for ordinary pause.
export function disposeAudio(): void {
  stopGameAudio();
  disconnect([_sfxGain, _masterGain].filter((node): node is GainNode => node !== null));
  const ctx = _ctx;
  _ctx = null;
  _masterGain = null;
  _sfxGain = null;
  noiseCache.clear();
  if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => {});
}
