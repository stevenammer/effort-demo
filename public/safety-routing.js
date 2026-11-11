// Local, deliberately small keyword check. It does not diagnose, report, or block writing.
const SIGNALS = [
  /\b(?:i\s+)?(?:want|plan|am\s+going|going)\s+to\s+(?:kill|end|take)\s+(?:my\s+)?life\b/i,
  /\b(?:i\s+)?(?:want|plan|am\s+going|going)\s+to\s+die\b/i,
  /\b(?:i\s+)?(?:am|feel)\s+suicidal\b/i,
  /\b(?:i\s+)?(?:might|will|am\s+going\s+to)\s+self[-\s]?harm\b/i,
  /\b(?:i\s+)?can(?:not|'t)\s+keep\s+(?:myself|me)\s+safe\b/i,
];

export function safetySignal(text) {
  if (typeof text !== 'string') return false;
  return SIGNALS.some(pattern => pattern.test(text));
}

export function createSafetyNote({ element, text = '' }) {
  let dismissed = false;
  const note = element('aside', undefined, 'safety-note');
  note.hidden = true;
  note.setAttribute('role', 'status');
  const message = element('p', 'This local keyword check noticed language that can mean an immediate safety concern. It can be wrong and it cannot assess your situation. If you may act on it or can’t stay safe, call or text 988 in the US for the Suicide & Crisis Lifeline, or call local emergency services. Saving or sending is still your choice.', 'small');
  const dismiss = element('button', 'Dismiss this note', 'text-button');
  dismiss.type = 'button';
  dismiss.onclick = () => { dismissed = true; note.hidden = true; };
  note.append(message, dismiss);
  return {
    node: note,
    update(value) {
      const active = safetySignal(value);
      if (!active) dismissed = false;
      note.hidden = !active || dismissed;
      return active;
    },
  };
}
