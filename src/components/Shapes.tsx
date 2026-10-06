import { ReactNode } from 'react';

// ── Geometry helpers ──────────────────────────────────────────────────────
export function hexPts(cx: number, cy: number, r: number): string {
  const p: string[] = [];
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 3 * i + Math.PI / 6;
    p.push(`${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}`);
  }
  return p.join(' ');
}
export function pentPts(cx: number, cy: number, r: number): string {
  const p: string[] = [];
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (Math.PI * 2 / 5) * i;
    p.push(`${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}`);
  }
  return p.join(' ');
}
export function starPts(cx: number, cy: number, R: number, r: number, n = 5): string {
  const p: string[] = [];
  for (let i = 0; i < n * 2; i++) {
    const a = -Math.PI / 2 + (Math.PI / n) * i;
    const rad = i % 2 === 0 ? R : r;
    p.push(`${cx + rad * Math.cos(a)},${cy + rad * Math.sin(a)}`);
  }
  return p.join(' ');
}

// ── Tower data (used for shapes only) ────────────────────────────────────
const TOWERS_SHAPES: { id: string; color: string; shape: string }[] = [
  { id: 'arrow',  color: '#595959', shape: 'triangle' },
  { id: 'cannon', color: '#2b2b2b', shape: 'circle' },
  { id: 'spark',  color: '#595959', shape: 'square' },
  { id: 'frost',  color: '#8a9aa0', shape: 'hex' },
  { id: 'sniper', color: '#2b2b2b', shape: 'diamond' },
  { id: 'venom',  color: '#6b7a5a', shape: 'teardrop' },
  { id: 'mortar', color: '#595959', shape: 'pentagon' },
  { id: 'totem',  color: '#a58a4a', shape: 'star' },
];

const ENEMIES_SHAPES: { id: string; color: string; shape: string }[] = [
  { id: 'grunt',  color: '#595959', shape: 'circle' },
  { id: 'scout',  color: '#2b2b2b', shape: 'triangle' },
  { id: 'tank',   color: '#2b2b2b', shape: 'square' },
  { id: 'swarm',  color: '#595959', shape: 'diamond' },
  { id: 'boss',   color: '#2b2b2b', shape: 'hex' },
  // extended enemies
  { id: 'crow',    color: '#2b2b2b', shape: 'triangle' },
  { id: 'warden',  color: '#595959', shape: 'hex' },
  { id: 'medic',   color: '#6b7a5a', shape: 'circle' },
  { id: 'splitter',color: '#595959', shape: 'hex' },
];

// ── TowerShape ────────────────────────────────────────────────────────────
interface TowerShapeProps { type: string; size?: number; equipped?: string; }

export function TowerShape({ type, size = 28, equipped = 'default' }: TowerShapeProps) {
  const t = TOWERS_SHAPES.find(x => x.id === type) || TOWERS_SHAPES[0];
  const s = size;
  const fill = t.color;
  const skin = equipped !== 'default';
  const stroke = '#2b2b2b';
  const common = { stroke, strokeWidth: 1.4, strokeLinejoin: 'round' as const };

  let inner: ReactNode = null;
  switch (t.shape) {
    case 'triangle':
      inner = <polygon points={`${s/2},3 ${s-3},${s-3} 3,${s-3}`} fill={fill} {...common}/>; break;
    case 'circle':
      inner = <circle cx={s/2} cy={s/2} r={s/2-3} fill={fill} {...common}/>; break;
    case 'square':
      inner = <rect x="3" y="3" width={s-6} height={s-6} fill={fill} {...common}/>; break;
    case 'hex':
      inner = <polygon points={hexPts(s/2, s/2, s/2-3)} fill={fill} {...common}/>; break;
    case 'diamond':
      inner = <polygon points={`${s/2},3 ${s-3},${s/2} ${s/2},${s-3} 3,${s/2}`} fill={fill} {...common}/>; break;
    case 'teardrop':
      inner = <path d={`M${s/2} 3 C${s-3} ${s/3}, ${s-3} ${s-5}, ${s/2} ${s-3} C3 ${s-5}, 3 ${s/3}, ${s/2} 3 Z`} fill={fill} {...common}/>; break;
    case 'pentagon':
      inner = <polygon points={pentPts(s/2, s/2, s/2-3)} fill={fill} {...common}/>; break;
    case 'star':
      inner = <polygon points={starPts(s/2, s/2, s/2-3, (s/2-3)/2.3, 5)} fill={fill} {...common}/>; break;
    default:
      inner = <circle cx={s/2} cy={s/2} r={s/2-3} fill={fill} {...common}/>;
  }

  return (
    <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} style={{filter: skin ? 'drop-shadow(0 1px 0 #a58a4a)' : 'none'}}>
      <ellipse cx={s/2} cy={s-3} rx={s/2-3} ry="2.5" fill="#dcdcd4" stroke="#2b2b2b" strokeWidth="1"/>
      {inner}
      {skin && <circle cx={s-5} cy="5" r="3" fill="#a58a4a" stroke="#2b2b2b" strokeWidth="1"/>}
    </svg>
  );
}

// ── EnemyShape ────────────────────────────────────────────────────────────
interface EnemyShapeProps { type: string; size?: number; hpPct?: number; }

export function EnemyShape({ type, size = 18, hpPct = 1 }: EnemyShapeProps) {
  const e = ENEMIES_SHAPES.find(x => x.id === type) || ENEMIES_SHAPES[0];
  const s = size;
  const fill = e.color;
  const stroke = '#2b2b2b';
  const common = { stroke, strokeWidth: 1.2, strokeLinejoin: 'round' as const };

  let inner: ReactNode = null;
  switch (e.shape) {
    case 'circle':   inner = <circle cx={s/2} cy={s/2} r={s/2-2} fill={fill} {...common}/>; break;
    case 'triangle': inner = <polygon points={`${s/2},2 ${s-2},${s-2} 2,${s-2}`} fill={fill} {...common}/>; break;
    case 'square':   inner = <rect x="2" y="2" width={s-4} height={s-4} fill={fill} {...common}/>; break;
    case 'diamond':  inner = <polygon points={`${s/2},2 ${s-2},${s/2} ${s/2},${s-2} 2,${s/2}`} fill={fill} {...common}/>; break;
    case 'hex':      inner = <polygon points={hexPts(s/2, s/2, s/2-2)} fill={fill} {...common}/>; break;
    default:         inner = <circle cx={s/2} cy={s/2} r={s/2-2} fill={fill} {...common}/>;
  }

  return (
    <g>
      {inner}
      <rect x="1" y={-5} width={s-2} height="2.5" fill="#e8e8e3" stroke="#2b2b2b" strokeWidth="0.6"/>
      <rect x="1" y={-5} width={Math.max(0,(s-2)*hpPct)} height="2.5" fill="#8a4a4a"/>
    </g>
  );
}

// ── Badge / UI helpers ────────────────────────────────────────────────────
export function TokenBadge({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20">
      <circle cx="10" cy="10" r="9" fill="#f6f5f0" stroke="#2b2b2b" strokeWidth="1.4"/>
      <circle cx="10" cy="10" r="6.5" fill="none" stroke="#2b2b2b" strokeWidth="0.8" strokeDasharray="1 2"/>
      <text x="10" y="13" textAnchor="middle" fontFamily="JetBrains Mono, monospace" fontSize="6" fontWeight="700" fill="#2b2b2b">STD</text>
    </svg>
  );
}

export function SolBadge({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20">
      <circle cx="10" cy="10" r="9" fill="#2b2b2b" stroke="#2b2b2b" strokeWidth="1.4"/>
      <text x="10" y="13" textAnchor="middle" fontFamily="JetBrains Mono, monospace" fontSize="7" fontWeight="700" fill="#f6f5f0">◎</text>
    </svg>
  );
}

export function LifeHeart({ size = 16, filled = true }: { size?: number; filled?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16">
      <path d="M8 14 C 2 10, 1 5, 4 3 C 6 1.5, 8 4, 8 5 C 8 4, 10 1.5, 12 3 C 15 5, 14 10, 8 14 Z"
        fill={filled ? '#2b2b2b' : 'none'} stroke="#2b2b2b" strokeWidth="1.2" strokeLinejoin="round"/>
    </svg>
  );
}

export function SketchRule({ w = 280 }: { w?: number }) {
  return (
    <svg width={w} height="8" viewBox={`0 0 ${w} 8`} style={{display:'block'}}>
      <path d={`M2 4 Q ${w/4} 1, ${w/2} 4 T ${w-2} 4`} stroke="#2b2b2b" strokeWidth="1.2" fill="none" strokeLinecap="round"/>
    </svg>
  );
}

export function IsoPedestal({ children, size = 110 }: { children?: ReactNode; size?: number }) {
  return (
    <div style={{
      width: size, height: size,
      display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
      position: 'relative',
    }}>
      <svg width={size} height={size*0.4} viewBox="0 0 100 40" style={{position:'absolute', bottom: 0}}>
        <polygon points="50,4 96,24 50,44 4,24" fill="#e8e8e3" stroke="#2b2b2b" strokeWidth="1.4"/>
        <polygon points="50,4 96,24 50,44 4,24" fill="none" stroke="#2b2b2b" strokeWidth="0.6" strokeDasharray="2 2" opacity="0.5"/>
      </svg>
      <div style={{position:'relative', marginBottom: size*0.22}}>
        {children}
      </div>
    </div>
  );
}
