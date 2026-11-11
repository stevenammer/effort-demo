// Local, deliberately small first-person keyword check. It does not diagnose,
// report, or block writing. Context, including quoted fiction, is not parsed.
const SIGNALS = [
  /\bi\s+(?:(?:have\s+)?(?:a\s+)?plan\s+to\s+|(?:want|am\s+going|going)\s+to\s+)?kill\s+myself\b/i,
  /\bi\s+(?:(?:have\s+)?(?:a\s+)?plan\s+to\s+|(?:want|am\s+going|going)\s+to\s+)?end\s+my\s+life\b/i,
  /\bi\s+(?:(?:have\s+)?(?:a\s+)?plan\s+to\s+|(?:want|am\s+going|going)\s+to\s+)?take\s+my\s+own\s+life\b/i,
  /\bi\s+(?:want\s+to\s+)?die\b/i,
  /\bi\s+(?:do\s+not|don't)\s+want\s+to\s+be\s+alive\b/i,
  /\bi\s+(?:am|feel)\s+suicidal\b/i,
  /\bi\s+(?:might|will|am\s+going\s+to)\s+self[-\s]?harm\b/i,
  /\bi\s+can(?:not|'t)\s+keep\s+(?:myself|me)\s+safe\b/i,
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
