export const clone = value => structuredClone(value);
export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const exactKeys = (object, keys) => object && typeof object === 'object' && !Array.isArray(object) &&
  Object.keys(object).sort().join(',') === [...keys].sort().join(',');
export const validDate = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
export const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const validId = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
export class IntegrityError extends Error {}
export async function sha256(text) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Stable local correlation IDs, scoped by callers to a workspace and operation.
export async function stableId(value) {
  const hash = await sha256(value);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
