'use strict';

/**
 * EFFORT's existing deterministic classifier, adapted for a public demo.
 * Every fragment keeps an exact source quote and UTF-16 start/end offsets.
 * No model, network request or source rewrite happens here.
 * Public role aliases replace private names. See SOURCE.md.
 */

const FRAGMENT_TYPES = Object.freeze([
  'delegation',
  'idea',
  'action_candidate',
  'explicit_commitment',
  'question',
  'decision',
  'delegation',
  'waiting_on',
  'event_or_fact',
  'constraint',
  'reference',
  'reflection',
  'unclear',
]);

// Leading filler a person types before the real sentence ("ahm yeah, please ...").
const FILLER = /^(?:(?:ahm|um|uh|hm+|so|and|also|then|ok|okay|yeah|yes|yep|yup|well|hey|please|plz|now|but|btw|alright|right|sure|dude|dudezo|man)\b[,\s.:-]*)+/;

const IMPERATIVE_VERBS = [
  'call', 'text', 'email', 'message', 'buy', 'order', 'pay', 'book', 'schedule', 'send', 'fix', 'finish', 'write', 'ask',
  'check', 'get', 'pick up', 'drop off', 'renew', 'cancel', 'clean', 'make', 'plan', 'look up', 'look into', 'research',
  'build', 'set up', 'print', 'sign', 'file', 'submit', 'return', 'find', 'remove', 'add', 'update', 'change', 'create',
  'delete', 'run', 'test', 'verify', 'review', 'read', 'open', 'close', 'use', 'try', 'start', 'stop', 'launch', 'deploy',
  'commit', 'push', 'merge', 'install', 'connect', 'move', 'rename', 'upgrade', 'investigate', 'figure out', 'go investigate',
  'have', 'let', 'give', 'show', 'tell', 'put', 'take', 'bring', 'grab', 'pull', 'share', 'draft', 'prepare', 'design',
  'implement', 'refactor', 'document', 'summarize', 'list', 'compare', 'double check', 'follow up', 'reach out', 'sort out',
  'turn', 'shut', 'delete', 'wait', 'hold off', 'table', 'drive', 'sync', 'save', 'export', 'import', 'fetch', 'rerun',
  'do', 'report', 'download', 'locate', 'feed', 'iterate', 'ping', 'bump', 'ship', 'hand', 'write up', 'cap', 'ensure', 'make sure', 'keep checking', 'port', 'swap', 'replace', 'fold', 'wire', 'hook up', 'tighten', 'trim', 'cut', 'strip', 'reschedule', 'restart', 'retry', 'reload', 'resume', 'reset', 'reply', 'rewrite',
];
const IMPERATIVE = new RegExp(`^(?:${IMPERATIVE_VERBS.map((v) => v.replace(/ /g, '\\s+')).join('|')})\\b`);

// Who work can be handed to. A directive that names one of these is a DELEGATION, not
// something Steven does himself.
const DOERS = 'assistant|reviewer|agent|agents|someone|somebody|her|him|them';
const DELEGATION = [
  new RegExp(`^(?:have|get|ask|tell|let|send|give)\\b[^.!?]{0,40}\\b(?:${DOERS})\\b`),
  new RegExp(`^(?:${DOERS})\\s*(?:,|should|can|could|needs? to|must|will|please)\\b`),
  /^send\s+(?:a|an|the|some)?\s*(?:swarm|swarms|agent|agents|terra|ibm|ibms|oracle|oracles)\b/,
];

// Acknowledgements and chatter that carry no obligation and should not be organized as anything.
const ACK = /^(?:keep going|keep it going|continue|go on|go|going|keep|nice|thanks|thank you|thx|cool|great|good|perfect|awesome|lol|haha|ok|okay|yes|yeah|yep|no|nope|sure|done|got it|sounds good|makes sense)[.!\s]*$/;

function classifyFragment(text) {
  const lowered = text.toLowerCase().trim();
  // Attachments, bare list markers and fragments of a path are references, never obligations.
  if (/^\[image[:\s]/.test(lowered) || /^\[?(?:file|attachment)[:\s]/.test(lowered)) return { type: 'reference', confidence: 'high' };
  if (/^\(?[a-z0-9]{1,2}[.)]?$/.test(lowered)) return { type: 'unclear', confidence: 'low' };
  if (ACK.test(lowered)) return { type: 'reflection', confidence: 'low' };

  const hadAck = /^(?:yes|yeah|yep|yup|ok|okay|sure|alright)\b/.test(lowered);
  let core = lowered.replace(FILLER, '').trim() || lowered;
  // "If done, verify the repo" / "When it finishes, report back": the instruction is what follows the condition.
  const cond = core.match(/^(?:if|once|when|after|unless)\b[^,;:]*[,:]\s*(.+)$/);
  if (cond && cond[1].length > 2) core = cond[1].replace(FILLER, '').trim();

  if (/^(?:can|could|would|will) you\b/.test(core)) return { type: 'delegation', confidence: 'medium' };
  const startsImperative = IMPERATIVE.test(core) && !/^(?:do|have|let|get|make|keep|wait|use|go|try|put|take|give|tell|show)\s+(?:not|n'?t)\b/.test(core);
  const isQuestion =
    /[?]$/.test(text.trim()) ||
    /^\s*(why|what|when|where|who|how|should|could|would|does|is|can|did|do|are|which|any)\b/.test(core) && /\b(you|we|i|it|there|this|that|they|he|she)\b/.test(core) && !/^do (?:not|n'?t)\b/.test(core);
  if (isQuestion) return { type: 'question', confidence: 'high' };

  const waitingOnPatterns = [
    /\bwaiting on\b/, /\bwaiting for\b/, /\bonce .+ (?:responds|replies|answers?)\b/,
    /\bsaid (?:they|he|she|you|we) will\b/, /\bwill (?:get|receive|respond)\b/, /\bhasn'?t (?:replied|responded|answered|called back)\b/,
    /\bbeen waiting\b/, /\bgonna (?:hear|get) back\b/,
  ];
  if (!startsImperative && waitingOnPatterns.some((re) => re.test(core))) return { type: 'waiting_on', confidence: 'high' };

  // Second-person rules and limits: "no deploys", "never push", "only commits", "don't ...", "wait for me to say".
  const rulePatterns = [
    /^(?:no|never|only|always|don'?t|do not|do n'?t|stop|avoid|not)\b/, /^wait for me\b/, /\bwait for me to\b/, /\bonly (?:commits?|local|free)\b/,
    /^(?:we|you) (?:only|never|always|must|shouldn'?t|can'?t|cannot|won'?t)\b/, /\bhold off on\b/, /\bno more\b/,
    /^(?:make sure|ensure|remember) (?:to |that )?(?:never|not|always|no)\b/, /^keep\b.*\b(?:separate|private|local|apart)\b/,
  ];
  // "I don't need to call Mom" is a fact about the speaker, not a rule: only second-person style rules count.
  if (!/^i\b/.test(core) && rulePatterns.some((re) => re.test(core))) return { type: 'constraint', confidence: 'medium' };

  // Decisions: choices he states for the work.
  const decisionPatterns = [
    /^let'?s\b/, /^(?:we|i) (?:should|decided|chose|want to go with)\b/, /^we (?:will|'ll|are going to)\b/, /^i say\b/, /^i want (?:both|it|that|this|them|one)\b/,
    /^(?:table|park|skip|scrap|drop|kill|ditch|leave|keep|stick with|go with)\b(?! going)/,
    /^(?:the )?(?:plan|decision|call) is\b/,
  ];
  if (decisionPatterns.some((re) => re.test(core)) && !/^(?:we|i) should (?:probably )?(?:maybe|might)\b/.test(core)) {
    if (/^let'?s\b/.test(core) && IMPERATIVE.test(core.replace(/^let'?s\s+/, ''))) return { type: 'decision', confidence: 'medium' };
    if (!/^(?:keep|leave)\b/.test(core) || /\b(?:it|that|this|them|as is|alone)\b/.test(core)) return { type: 'decision', confidence: 'medium' };
  }

  const pastOrNegationPatterns = [
    /\bdon'?t need to\b/, /\bdo not need to\b/, /\balready\b/,
    /\b(i|we|they) (?:called|did|finished|completed|sent|replied|responded|met|got|made|spent|set up|fixed|found)\b/, /\bi'?ve (?:\w+ )?(?:spent|done|built|made|sent|tried|used|lost)\b/,
    /\bcodex (?:took|hit|ran|finished)\b/,
  ];
  if (!startsImperative && pastOrNegationPatterns.some((re) => re.test(core))) return { type: 'event_or_fact', confidence: 'medium' };

  const hedgePatterns = [/\bmaybe\b/, /\bmight\b/, /\bsomeday\b/, /\bpossibly\b/, /\bi wonder if\b/, /\bi'?m not sure\b/, /\bi hope\b/, /\bwhat if\b/, /\bit would be (?:cool|nice|neat|great)\b/];
  if (hedgePatterns.some((re) => re.test(core))) return { type: 'idea', confidence: 'low' };

  // First-person intent, including how he actually says it: "I'll test it tonight", "I'm gonna plug in my phone".
  const commitmentPatterns = [
    /\bi will\b/, /\bi'?ll\b/, /\bi'?m gonna\b/, /\bi'?m going to\b/, /\bi am going to\b/, /\bi plan(?:ned)? to\b/, /\bi intend to\b/,
    /\bi promised\b/, /\bi told .+? i'?d have it by\b/, /\bi told .+? i will\b/, /\bgonna\b/,
    /^(?:i\s+)?need to\b/, /^(?:i\s+)?have to\b/, /^(?:i\s+)?must\b/, /^(?:i\s+)?(?:got|gotta)\s+to\b/, /^gotta\b/,
  ];
  if (commitmentPatterns.some((re) => re.test(core))) return { type: 'explicit_commitment', confidence: 'high' };

  // "I want ..." in his voice: wanting to know is a question, wanting something made is a request,
  // wanting someone else to see or do something is an idea about them.
  if (/^i (?:want|need|wanna) (?:to )?(?:know|understand|figure out|see how)\b/.test(core)) return { type: 'question', confidence: 'medium' };
  if (/^i (?:want|wanna) (?:her|him|them|everyone|people|the team) to\b/.test(core)) return { type: 'idea', confidence: 'low' };
  if (/^i (?:want|need|wanna) (?:the|a|an|my|both|it|that|this|those|these|one|some|more)\b/.test(core)) return { type: 'action_candidate', confidence: 'medium' };
  if (/^keep\s+(?:\w+ing|going through|checking|feeding|iterating)\b/.test(core)) return { type: 'action_candidate', confidence: 'medium' };

  // Handing work to an agent or a person.
  if (DELEGATION.some((re) => re.test(core))) return { type: 'delegation', confidence: 'medium' };

  // Directives: something to do, said as an instruction (to himself, an agent, or a person).
  if (IMPERATIVE.test(core)) {
    if (/\b(?:maybe|might|someday|possibly)\b/.test(core)) return { type: 'idea', confidence: 'low' };
    return { type: 'action_candidate', confidence: hadAck ? 'high' : 'medium' };
  }

  // A described thing he'd like to exist: "a read along reader that listens...", "something simple where ...".
  if (/^(?:also,?\s+)?(?:a|an|something|some kind of)\b[^.!?]{3,}\b(?:that|where|which)\b/.test(core)) return { type: 'idea', confidence: 'low' };

  return { type: 'unclear', confidence: 'low' };
}

/**
 * Split into sentences with exact offsets. A boundary is . ! ? or newline followed by
 * whitespace or the end, so "1.03", "deploy.sh", "e.g." and URLs are not broken apart.
 */
function sentenceSpans(rawText) {
  const spans = [];
  let start = 0;
  const n = rawText.length;
  let bracket = 0; // never split inside [ ... ] (attachment markers, pasted tags)
  for (let i = 0; i < n; i += 1) {
    const ch = rawText[i];
    if (ch === '[') bracket += 1;
    if (ch === ']' && bracket > 0) bracket -= 1;
    let boundary = false;
    let end = i + 1;
    if (ch === '\n') boundary = bracket === 0;
    else if (bracket === 0 && (ch === '.' || ch === '!' || ch === '?')) {
      let j = i;
      while (j + 1 < n && /[.!?]/.test(rawText[j + 1])) j += 1; // swallow "...", "?!"
      const next = rawText[j + 1];
      if (j + 1 >= n || /\s/.test(next)) {
        // "e.g." / "i.e." / a lone initial or number-dot is not a sentence end
        const before = rawText.slice(Math.max(start, i - 4), i + 1).toLowerCase();
        const abbrev = ch === '.' && (/\b(?:e\.g|i\.e|etc|vs|mr|mrs|dr|st)\.$/.test(before));
        if (!abbrev) { boundary = true; end = j + 1; i = j; }
      }
    }
    if (boundary || i === n - 1) {
      const stop = boundary ? end : n;
      const rawFragment = rawText.slice(start, stop);
      const trimmed = rawFragment.trim();
      if (trimmed) {
        const lead = rawFragment.indexOf(trimmed);
        spans.push({ start: start + lead, end: start + lead + trimmed.length, quote: trimmed });
      }
      start = stop;
    }
  }
  return spans;
}

function projectSemanticFragments(sourceId, rawText) {
  if (typeof sourceId !== 'string' || sourceId.length === 0) throw new TypeError('sourceId must be a non-empty string');
  if (typeof rawText !== 'string') throw new TypeError('rawText must be a string');
  const fragments = [];
  for (const sp of sentenceSpans(rawText)) {
    const { type, confidence } = classifyFragment(sp.quote);
    fragments.push(Object.freeze({ sourceId, type, quote: sp.quote, start: sp.start, end: sp.end, confidence }));
  }
  return Object.freeze(fragments);
}

export {
  sentenceSpans,
  FRAGMENT_TYPES,
  classifyFragment,
  projectSemanticFragments,
};
