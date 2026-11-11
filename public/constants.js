export const KEY = 'effort-public-demo-v1';
// Ten thousand short posts remain within the byte budget and are displayed in
// windows. The backup limit remains the hard portable safety boundary.
export const LIMITS = Object.freeze({ captures: 10000, text: 4000, total: 2000000, backupBytes: 32000000, recoveryBytes: 8000000 });
export const SPANS = Object.freeze(['Product demo', 'Learning', 'Unsorted']);
