import { organizeText } from './ef.js';

function stateFor(commitments, key) {
  if (commitments instanceof Map) return commitments.get(key);
  return commitments?.[key];
}

export function nowCandidates(captures, commitments = {}, now = Date.now()) {
  const candidates = [];
  for (const capture of captures) {
    const organized = organizeText(capture.id, capture.text);
    const section = organized.sections.find((item) => item.id === 'do');
    if (!section) continue;
    for (const item of section.items) {
      const state = stateFor(commitments, item.key);
      if (state?.state === 'done' || state?.state === 'dead') continue;
      if (state?.state === 'snoozed' && state.until && Date.parse(state.until) > now) continue;
      candidates.push({ ...item, captureId: capture.id, createdAt: capture.createdAt });
    }
  }
  return candidates;
}

function compare(a, b) {
  const priority = (item) => item.type === 'explicit_commitment' ? 0 : 1;
  return priority(a) - priority(b) || Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
    a.key.localeCompare(b.key);
}

export function chooseNow(captures, commitments = {}, { now = Date.now(), skipped = [] } = {}) {
  const choices = nowCandidates(captures, commitments, now)
    .filter((item) => !skipped.includes(item.key)).sort(compare);
  const item = choices[0] || null;
  if (!item) return { item: null, remaining: 0, reason: null };
  const days = Math.floor(Math.max(0, now - Date.parse(item.createdAt)) / 86_400_000);
  const reason = (item.type === 'explicit_commitment' ? 'You said you would. ' :
    'It reads like a next step. ') + (days ? `It has waited ${days} day${days === 1 ? '' : 's'}.` :
    'It was captured today.');
  return { item, remaining: choices.length - 1, reason };
}
