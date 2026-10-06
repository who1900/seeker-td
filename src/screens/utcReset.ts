import { useEffect, useState } from 'react';
import { nextUTCReset } from '../state/store';

export function resetLabel(now = Date.now()): string {
  const minutes = Math.max(1, Math.ceil((nextUTCReset(now) - now) / 60000));
  return `in ${Math.floor(minutes / 60)}h ${minutes % 60}m · 00:00 UTC`;
}

export function useUTCClock(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const refresh = () => setNow(Date.now());
    const timer = window.setInterval(refresh, 1000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, []);
  return now;
}
