import { exactKeys, validId } from './primitives.js';
export function choiceShape(choice) {
  return exactKeys(choice, ['captureId', 'start', 'end', 'quote', 'origin']) && validId(choice.captureId) &&
    Number.isInteger(choice.start) && Number.isInteger(choice.end) && choice.start >= 0 && choice.end > choice.start &&
    typeof choice.quote === 'string' && choice.quote.length === choice.end - choice.start && choice.quote.length <= 4000 && choice.quote.trim().length > 0 &&
    ['sample', 'chosen'].includes(choice.origin);
}
export function validChoice(choice, captures) {
  if (!choiceShape(choice)) return false;
  const source = captures.find(c => c.id === choice.captureId);
  return !!source && choice.end <= source.text.length && source.text.slice(choice.start, choice.end) === choice.quote;
}
export const sourceKey = choice => `${choice.captureId}:${choice.start}:${choice.end}`;
