import { isNight } from './night.js';
const DAY = 86400000;
export function inQuietHours(date, start = 23, end = 6) { return isNight(date, start, end); }
export function shouldInterrupt(candidate, ctx) {
  if (!candidate || typeof candidate.key !== 'string' || !candidate.key || typeof candidate.type !== 'string' || !candidate.type || !ctx || !Number.isFinite(ctx.now)) throw Error('Invalid interruption input.');
  const limits = { quiet: 0, normal: 1, loud: 3 };
  if (!Object.hasOwn(limits, ctx.dial)) throw Error('Invalid interruption dial.');
  const sent = ctx.sentToday ?? 0;
  if (!Number.isInteger(sent) || sent < 0 || (ctx.lastShown && (typeof ctx.lastShown !== 'object' || Array.isArray(ctx.lastShown))) || (ctx.recentDismissals && !Array.isArray(ctx.recentDismissals))) throw Error('Invalid interruption context.');
  const date = new Date(ctx.now);
  if (!Number.isFinite(date.getTime())) throw Error('Invalid time.');
  const quiet = inQuietHours(date, ctx.quietStart ?? 23, ctx.quietEnd ?? 6);
  for (const value of Object.values(ctx.lastShown ?? {})) if (!Number.isFinite(value) || value > ctx.now) throw Error('Invalid shown time.');
  for (const d of ctx.recentDismissals ?? []) if (!d || typeof d.type !== 'string' || !Number.isFinite(d.at) || d.at > ctx.now) throw Error('Invalid dismissal.');
  if (!limits[ctx.dial]) return { allow: false, reason: 'dial is quiet' };
  if (quiet) return { allow: false, reason: 'quiet hours' };
  if (sent >= limits[ctx.dial]) return { allow: false, reason: 'daily budget used' };
  if (ctx.activeCommitment) return { allow: false, reason: 'protecting current work' };
  const shown = ctx.lastShown?.[candidate.key];
  if (shown !== undefined && ctx.now - shown < 3 * DAY) return { allow: false, reason: 'shown recently' };
  if ((ctx.recentDismissals ?? []).some(d => d.type === candidate.type && ctx.now - d.at < DAY)) return { allow: false, reason: 'similar item dismissed recently' };
  if (candidate.type === 'idea' && ctx.dial !== 'loud') return { allow: false, reason: 'speculative' };
  return { allow: true, reason: 'earned' };
}
export function budgeted(candidates, ctx) {
  if (!Array.isArray(candidates)) throw Error('Candidates must be an array.');
  shouldInterrupt({ key: '_validation_', type: '_validation_' }, ctx);
  const out = []; const seen = new Set(); let sent = ctx.sentToday ?? 0;
  for (const candidate of candidates) {
    const result = shouldInterrupt(candidate, { ...ctx, sentToday: sent });
    if (!seen.has(candidate.key) && result.allow) { out.push(candidate); sent++; }
    seen.add(candidate.key);
  }
  return out;
}
