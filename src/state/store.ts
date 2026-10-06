// Global game state + helpers. Stored in localStorage.
import type { RunSession, RunLedgerEntry } from './runs';
import { isCanonicalRun } from './runs';
export const LS_KEY = 'seekdef_v1';

// ── Tower families (4 upgrade lineages) ───────────────────────────────────
export type TowerFamily = 'canon' | 'laser' | 'mortar' | 'glue';

// Maps every real towerId → its family
export const TOWER_FAMILY: Record<string, TowerFamily> = {
  canon: 'canon', dualCanon: 'canon', machineGun: 'canon',
  simpleLaser: 'laser', bouncingLaser: 'laser', straightLaser: 'laser',
  mortar: 'mortar', mineLayer: 'mortar', rocketLauncher: 'mortar',
  glueTower: 'glue', glueGun: 'glue', teleporter: 'glue',
};

export interface GameState {
  tokens: number;
  lives: number;
  dailyFreeLeft: number;
  dailyFreeMax: number;
  paidRuns: number;
  runSequence: number;
  activeRun: RunSession | null;
  runLedger: Record<string, RunLedgerEntry>;
  sol: number;
  streak: number;
  walletConnected: boolean;
  walletAddr: string;
  skinsEnabled: boolean;
  dark: boolean;
  prizePool: number;
  monthlyRank: number;
  equippedSkins: Record<TowerFamily, string>;
  unlockedSkins: string[];
  loginClaimedToday: boolean;
  challengesDone: boolean[];
  lastPlayed: number | null;
  // off-chain economy fields
  bestWave: number;
  totalRuns: number;
  totalEnemiesKilled: number;
  lastBonusClaim: number | null;
  lastRunReset: string | null;
  localScores: { wave: number; ts: number; runId?: string }[];
  // social layer fields
  referralCode: string | null;
  referredBy: string | null;
  referralsCount: number;
  challengeProgress: Record<string, number>;
  challengeClaimed: Record<string, boolean>;
  challengesResetDate: string | null;
  soundEnabled: boolean;
}

export const DEFAULT_STATE: GameState = {
  tokens: 420,
  lives: 3,
  dailyFreeLeft: 3,
  dailyFreeMax: 3,
  paidRuns: 0,
  runSequence: 0,
  activeRun: null,
  runLedger: {},
  sol: 0.42,
  streak: 5,
  walletConnected: false,
  walletAddr: '9k2f…rX8q',
  skinsEnabled: true,
  dark: false,
  prizePool: 12840,
  monthlyRank: 47,
  equippedSkins: { canon: 'canon-default', laser: 'laser-default', mortar: 'mortar-default', glue: 'glue-default' },
  unlockedSkins: [],
  loginClaimedToday: false,
  challengesDone: [false, false, false],
  lastPlayed: null,
  bestWave: 0,
  totalRuns: 0,
  totalEnemiesKilled: 0,
  lastBonusClaim: null,
  lastRunReset: null,
  localScores: [],
  // social layer defaults
  referralCode: null,
  referredBy: null,
  referralsCount: 0,
  challengeProgress: {},
  challengeClaimed: {},
  challengesResetDate: null,
  soundEnabled: true,
};

// ── Economy constants ──────────────────────────────────────────────────────
export const BONUS_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const DAILY_BONUS_AMOUNT = 50;
export const CONTINUE_COST = 50;
export const STD_PER_WAVE = 5;

// ── Helper: today's date string (local, YYYY-MM-DD) ────────────────────────
export function todayStr(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function migrateRunState(s: GameState): GameState {
  const count = (n: unknown) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : 0;
  const max = count(s.dailyFreeMax);
  const left = count(s.dailyFreeLeft);
  const paid = s.paidRuns === undefined ? Math.max(0, left - max) : count(s.paidRuns);
  const ledger = s.runLedger && typeof s.runLedger === 'object' && !Array.isArray(s.runLedger) ? s.runLedger : {};
  const active = s.activeRun;
  const entry = active && ledger[active.id];
  const validActive = isCanonicalRun(active, entry || undefined) && !entry!.abandoned
    && (!entry!.settled || entry!.continuationAuthorized);
  const runLedger = validActive ? ledger : Object.fromEntries(Object.entries(ledger).map(([id, record]) =>
    [id, record && (!record.settled || record.continuationAuthorized)
      ? { ...record, settled: true, defeated: false, continuationAuthorized: false, abandoned: true } : record]));
  const sequence = Object.keys(ledger).reduce((highest, id) => Math.max(highest,
    /^local-[1-9]\d*$/.test(id) ? count(Number(id.slice(6))) : 0), count(s.runSequence));
  return { ...s, dailyFreeMax: max, dailyFreeLeft: Math.min(left, max), paidRuns: paid,
    runSequence: sequence, activeRun: validActive ? active : null, runLedger };
}

// ── Reset free runs if it's a new day ────────────────────────────────────
export function applyDailyReset(s: GameState, now = Date.now()): GameState {
  const next = migrateRunState(s);
  const date = todayStr(now);
  if (next.lastRunReset === date) return next;
  return { ...next, dailyFreeLeft: next.dailyFreeMax, lastRunReset: date };
}

// ── Can user claim daily bonus? ───────────────────────────────────────────
export function canClaimBonus(s: GameState): boolean {
  return s.lastBonusClaim == null || Date.now() - s.lastBonusClaim >= BONUS_COOLDOWN_MS;
}

// ── Referral helpers ──────────────────────────────────────────────────────
export const REFERRAL_BONUS = 100;

/** 6-char [A-Z0-9] code. Deterministic from seed (walletAddr) if provided. */
export function genReferralCode(seed?: string): string {
  const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no confusables
  if (seed) {
    // Simple deterministic hash
    let h = 0x811c9dc5;
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += CHARS[h % CHARS.length];
      h = (h * 6364136223846793005 + 1442695040888963407) >>> 0;
    }
    return code;
  }
  let code = '';
  for (let i = 0; i < 6; i++) code += CHARS[Math.floor(Math.random() * CHARS.length)];
  return code;
}

/** Ensure player has a referral code; returns updated state. */
export function ensureReferralCode(s: GameState): GameState {
  if (s.referralCode) return s;
  return { ...s, referralCode: genReferralCode(s.walletAddr || undefined) };
}

// ── Challenge helpers ─────────────────────────────────────────────────────

/** Reset daily challenge progress if it's a new day. */
export function applyChallengeReset(s: GameState, now = Date.now()): GameState {
  if (s.challengesResetDate === todayStr(now)) return s;
  return {
    ...s,
    challengeProgress: {},
    challengeClaimed: {},
    challengesResetDate: todayStr(now),
  };
}

export function loadState(): GameState {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...DEFAULT_STATE };
    const parsed = JSON.parse(raw);
    return migrateRunState({ ...DEFAULT_STATE, ...parsed, paidRuns: parsed.paidRuns });
  } catch { return { ...DEFAULT_STATE }; }
}

export function saveState(s: GameState): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch {}
}

// ── Tower specs (8 types) ─────────────────────────────────────────────────
export const TOWERS = [
  { id:'arrow',   name:'Fletcher',   cost:50,  dmg: 8,  rate: 900,  range: 110, color:'#595959', shape:'triangle', desc:'Cheap, fast arrows.' },
  { id:'cannon',  name:'Bombard',    cost:120, dmg: 28, rate: 1600, range: 120, color:'#2b2b2b', shape:'circle',   desc:'Splash damage.' },
  { id:'spark',   name:'Tesla',      cost:150, dmg: 12, rate: 700,  range: 100, color:'#595959', shape:'square',   desc:'Chains lightning.' },
  { id:'frost',   name:'Glacier',    cost:140, dmg: 4,  rate: 1400, range: 95,  color:'#8a9aa0', shape:'hex',      desc:'Slows enemies 40%.' },
  { id:'sniper',  name:'Marksman',   cost:200, dmg: 70, rate: 2000, range: 200, color:'#2b2b2b', shape:'diamond',  desc:'Long range, pierces.' },
  { id:'venom',   name:'Apothecary', cost:130, dmg: 3,  rate: 600,  range: 90,  color:'#6b7a5a', shape:'teardrop', desc:'Poison damage over time.' },
  { id:'mortar',  name:'Howitzer',   cost:220, dmg: 40, rate: 2400, range: 220, color:'#595959', shape:'pentagon', desc:'Targets far, big splash.' },
  { id:'totem',   name:'Bastion',    cost:180, dmg: 0,  rate: 0,    range: 80,  color:'#a58a4a', shape:'star',     desc:'+25% dmg to nearby towers.' },
];

// ── Enemy types ───────────────────────────────────────────────────────────
export const ENEMIES = [
  { id:'grunt',  name:'Grunt',   hp: 30,  speed: 0.8, bounty: 6,  color:'#595959', shape:'circle' },
  { id:'scout',  name:'Scout',   hp: 18,  speed: 1.5, bounty: 5,  color:'#2b2b2b', shape:'triangle' },
  { id:'tank',   name:'Tank',    hp: 140, speed: 0.5, bounty: 18, color:'#2b2b2b', shape:'square' },
  { id:'swarm',  name:'Swarm',   hp: 10,  speed: 1.2, bounty: 3,  color:'#595959', shape:'diamond' },
  { id:'boss',   name:'Warden',  hp: 600, speed: 0.4, bounty: 90, color:'#2b2b2b', shape:'hex' },
];

// ── Daily challenges ──────────────────────────────────────────────────────
export const CHALLENGES = [
  { id:'win_3',    title:'Win 3 games',            goal: 3, reward: 120 },
  { id:'no_leak',  title:'Clear a wave w/o leaks', goal: 1, reward: 80  },
  { id:'use_4',    title:'Place 4 tower types',    goal: 4, reward: 150 },
];

// ── Skins catalogue (4 families × 3 skins = 12 total) ────────────────────
// default skins are always available — no purchase needed.
export interface SkinDef {
  id: string;
  name: string;
  family: TowerFamily;
  price: number;  // STD; 0 = default (always free)
  color: string;  // hex override for the tower fill
  desc: string;
}

export const SKINS: SkinDef[] = [
  // ── Canon family ──────────────────────────────────────────────────
  { id:'canon-default', name:'Classic',     family:'canon',  price:0,   color:'#2b2b2b', desc:'Stock iron casing.' },
  { id:'canon-steel',   name:'Blue Steel',  family:'canon',  price:400, color:'#4a5a8a', desc:'Tempered steel finish.' },
  { id:'canon-brass',   name:'Brass Bolt',  family:'canon',  price:700, color:'#a58a4a', desc:'Steampunk bronzework.' },
  // ── Laser family ──────────────────────────────────────────────────
  { id:'laser-default', name:'Classic',     family:'laser',  price:0,   color:'#595959', desc:'Stock crystal prism.' },
  { id:'laser-ruby',    name:'Ruby Ray',    family:'laser',  price:450, color:'#8a4a4a', desc:'Deep crimson lenses.' },
  { id:'laser-jade',    name:'Jade Beam',   family:'laser',  price:650, color:'#4a6a5a', desc:'Resonant green crystal.' },
  // ── Mortar family ─────────────────────────────────────────────────
  { id:'mortar-default',name:'Classic',     family:'mortar', price:0,   color:'#595959', desc:'Stock siege hull.' },
  { id:'mortar-siege',  name:'Siege Works', family:'mortar', price:500, color:'#4a5a8a', desc:'Forged fortress cannon.' },
  { id:'mortar-ochre',  name:'Ochre Shell', family:'mortar', price:800, color:'#a58a4a', desc:'Burnished brass barrel.' },
  // ── Glue family ───────────────────────────────────────────────────
  { id:'glue-default',  name:'Classic',     family:'glue',   price:0,   color:'#6b7a5a', desc:'Stock resin dispenser.' },
  { id:'glue-vine',     name:'Vine Grip',   family:'glue',   price:300, color:'#4a6a5a', desc:'Overgrown with ivy.' },
  { id:'glue-wine',     name:'Merlot',      family:'glue',   price:900, color:'#8a4a4a', desc:'Deep burgundy lacquer.' },
];

// ── Extended data ─────────────────────────────────────────────────────────
export const DMG_TABLE: Record<string, Record<string, number>> = {
  LIGHT:    { physical:1.25, explosive:0.75, energy:1.00, poison:1.25, magic:1.00 },
  HEAVY:    { physical:0.60, explosive:1.40, energy:0.90, poison:0.70, magic:1.00 },
  FLYING:   { physical:0.80, explosive:0.20, energy:1.20, poison:0.50, magic:1.00 },
  SHIELDED: { physical:0.50, explosive:0.70, energy:1.60, poison:0.40, magic:1.10 },
  NONE:     { physical:1.00, explosive:1.00, energy:1.00, poison:1.00, magic:1.00 },
};

export const TOWERS_EX = [
  { id:'arrow',   name:'Fletcher',   shape:'triangle', color:'#595959', air:false,
    type:'physical', target:'first',
    tiers: [
      { dmg: 8,  rate: 900, range: 110, cost: 50  },
      { dmg: 14, rate: 820, range: 120, cost: 80,  name:'Longbow' },
      { dmg: 26, rate: 720, range: 135, cost: 140, name:'Ballista' },
    ], desc:'Cheap, fast physical arrows.' },

  { id:'cannon',  name:'Bombard',    shape:'circle', color:'#2b2b2b', air:false, splash:24,
    type:'explosive', target:'first',
    tiers: [
      { dmg: 28, rate: 1600, range: 120, cost: 120 },
      { dmg: 48, rate: 1500, range: 130, cost: 180, name:'Mortar' },
      { dmg: 82, rate: 1400, range: 150, cost: 260, name:'Thunderer' },
    ], desc:'Splash explosive. Bad vs flyers.' },

  { id:'spark',   name:'Tesla',      shape:'square', color:'#595959', air:true, chain:2,
    type:'energy', target:'first',
    tiers: [
      { dmg: 12, rate: 700, range: 100, cost: 150 },
      { dmg: 20, rate: 640, range: 110, cost: 200, name:'Arc Coil',  chain:3 },
      { dmg: 34, rate: 560, range: 125, cost: 290, name:'Storm Pylon', chain:4 },
    ], desc:'Chains lightning. Great vs shielded.' },

  { id:'frost',   name:'Glacier',    shape:'hex', color:'#8a9aa0', air:false,
    type:'magic', target:'first', slow: 0.4, slowMs: 800,
    tiers: [
      { dmg: 4,  rate: 1400, range: 95,  cost: 140 },
      { dmg: 8,  rate: 1300, range: 105, cost: 200, name:'Rimeward', slow:0.5, slowMs:1000 },
      { dmg: 14, rate: 1200, range: 120, cost: 300, name:'Winter King', slow:0.6, slowMs:1200 },
    ], desc:'Slows. AOE ring.' },

  { id:'sniper',  name:'Marksman',   shape:'diamond', color:'#2b2b2b', air:true,
    type:'physical', target:'strongest', pierce:true,
    tiers: [
      { dmg: 70,  rate: 2000, range: 200, cost: 200 },
      { dmg: 120, rate: 1800, range: 230, cost: 280, name:'Sharpshooter' },
      { dmg: 220, rate: 1600, range: 270, cost: 400, name:'Oracle Eye' },
    ], desc:'Long-range, pierces. Targets strongest.' },

  { id:'venom',   name:'Apothecary', shape:'teardrop', color:'#6b7a5a', air:false,
    type:'poison', target:'first', dot: 8, dotMs: 2500,
    tiers: [
      { dmg: 3,  rate: 600, range: 90,  cost: 130 },
      { dmg: 5,  rate: 520, range: 100, cost: 190, name:'Herbalist', dot:14, dotMs: 3000 },
      { dmg: 9,  rate: 460, range: 115, cost: 280, name:'Hemlock Druid', dot: 22, dotMs: 3500 },
    ], desc:'Poison DOT. Excels vs LIGHT.' },

  { id:'mortar',  name:'Howitzer',   shape:'pentagon', color:'#595959', air:false, splash:34,
    type:'explosive', target:'last',
    tiers: [
      { dmg: 40, rate: 2400, range: 220, cost: 220 },
      { dmg: 66, rate: 2200, range: 240, cost: 300, name:'Siege Works', splash:40 },
      { dmg:110, rate: 2000, range: 270, cost: 420, name:'Fortress Gun', splash:48 },
    ], desc:'Long splash. Targets last.' },

  { id:'totem',   name:'Bastion',    shape:'star', color:'#a58a4a', air:false,
    type:null, target:null, aura: 0.25,
    tiers: [
      { dmg: 0, rate: 0, range: 80,  cost: 180 },
      { dmg: 0, rate: 0, range: 95,  cost: 240, name:'Warden Stone', aura: 0.35 },
      { dmg: 0, rate: 0, range: 115, cost: 360, name:'Ancestor Monolith', aura: 0.50 },
    ], desc:'Support: +% dmg to nearby towers.' },
];

export const ENEMIES_EX = [
  { id:'grunt',  name:'Grunt',   hp: 30,  speed: 0.8, bounty: 6,  color:'#595959', shape:'circle',   armor:'NONE' },
  { id:'scout',  name:'Scout',   hp: 18,  speed: 1.5, bounty: 5,  color:'#2b2b2b', shape:'triangle', armor:'LIGHT' },
  { id:'tank',   name:'Tank',    hp: 140, speed: 0.5, bounty: 18, color:'#2b2b2b', shape:'square',   armor:'HEAVY' },
  { id:'swarm',  name:'Swarm',   hp: 10,  speed: 1.2, bounty: 3,  color:'#595959', shape:'diamond',  armor:'LIGHT' },
  { id:'crow',   name:'Crow',    hp: 40,  speed: 1.3, bounty: 10, color:'#2b2b2b', shape:'triangle', armor:'FLYING' },
  { id:'warden', name:'Warden',  hp: 90,  speed: 0.6, bounty: 14, color:'#595959', shape:'hex',      armor:'SHIELDED' },
  { id:'medic',  name:'Medic',   hp: 60,  speed: 0.7, bounty: 12, color:'#6b7a5a', shape:'circle',   armor:'LIGHT',
    ability:'heal', healAmt: 0.4, healRange: 40, healRate: 1200 },
  { id:'splitter', name:'Splitter', hp: 70, speed: 0.9, bounty: 12, color:'#595959', shape:'hex', armor:'NONE',
    ability:'split', splitInto:'swarm', splitCount:3 },
  { id:'boss',   name:'Warlord', hp: 900, speed: 0.4, bounty:120, color:'#2b2b2b', shape:'hex',      armor:'HEAVY' },
];

export const WAVES_EX = [
  [{e:'scout', n:6, gap:550}],
  [{e:'grunt', n:8, gap:500}, {e:'swarm', n:4, gap:300, delay:3500}],
  [{e:'scout', n:10, gap:380}, {e:'grunt', n:4, gap:600, delay:2500}],
  [{e:'crow',  n:6, gap:500}],
  [{e:'swarm', n:18, gap:260}, {e:'medic', n:2, gap:1500, delay:3000}],
  [{e:'tank',  n:2, gap:1200}, {e:'grunt', n:10, gap:480, delay:1500}],
  [{e:'warden',n:6, gap:700}, {e:'crow', n:6, gap:600, delay:2000}],
  [{e:'splitter', n:4, gap:1200}, {e:'scout', n:8, gap:420, delay:2500}],
  [{e:'tank',  n:3, gap:1000}, {e:'warden', n:4, gap:700, delay:1800}, {e:'crow', n:4, gap:600, delay:4000}],
  [{e:'boss',  n:1, gap:1, delay:500}, {e:'swarm', n:20, gap:220, delay:2500}],
];

export const TARGET_MODES = ['first','last','strongest','weakest','closest'];

export function damageMul(dmgType: string | null, armor: string): number {
  if (!dmgType) return 0;
  return (DMG_TABLE[armor] || DMG_TABLE.NONE)[dmgType] || 1;
}
