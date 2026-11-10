export const START_HOUR = 23;
export const END_HOUR = 6;
function hour(value, label) { if (!Number.isInteger(value) || value < 0 || value > 23) throw Error(`Invalid ${label}.`); return value; }
export function isNight(date, start = START_HOUR, end = END_HOUR) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw Error('Invalid date.');
  hour(start, 'start hour'); hour(end, 'end hour');
  const h = date.getHours();
  return start > end ? h >= start || h < end : h >= start && h < end;
}
/** Advisory only. It never authorizes an action. */
export function frictionFor({ date, action, dial = 'NORMAL', start = START_HOUR, end = END_HOUR }) {
  if (!['TIGHT','NORMAL','WILD','UNHINGED'].includes(dial)) throw Error('Invalid dial.');
  if (!['capture','journal','tomorrow-first-step','explore','promote','think'].includes(action)) throw Error('Invalid action.');
  if (!isNight(date, start, end)) return null;
  if (action === 'explore') return { kind: 'explore', message: 'Your place is safe, and exploration will still be here later.' };
  if (action === 'promote') return { kind: 'promote', message: 'This commitment will still be here tomorrow. Commit anyway?' };
  if (action === 'think' && ['WILD','UNHINGED'].includes(dial)) return { kind: 'wander', message: 'Your thoughts can be captured and revisited later.' };
  return null;
}
