export const when = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;
export const whenMs = (ms: number) => when(new Date(ms).toISOString());
export const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
export const full = new Intl.NumberFormat('en');
export const bytes = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : n >= 1024 ** 2 ? `${Math.round(n / 1024 ** 2)} MB` : `${Math.max(0, Math.round(n / 1024))} KB`);
export const seconds = (ms: number | null) => (ms === null ? '–' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
export const plural = (n: number, one: string, many: string) => `${full.format(n)} ${n === 1 ? one : many}`;
export const detailText = (d: Record<string, unknown>) => Object.entries(d).map(([k, v]) => `${k}: ${String(v)}`).join(', ');
