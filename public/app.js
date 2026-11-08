import { renderReading, readablePreview } from './reading.js';
import { deriveCommitments } from './intent.js';
import { organizeText, titleOf } from './core/ef.js';
import { createStore, KEY, LIMITS } from './store.js';
import { spanKey, parentOf, threadRoot } from './spans.js';

const $ = id => document.getElementById(id);
const element = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
const displayTitle = (text, max = 90) => {
  const firstLine = text.split(/\r?\n/, 1)[0];
  if (/^#{1,6}\s/.test(firstLine)) { const title = readablePreview(firstLine, 4000); return title.length > max ? title.slice(0, max - 1) + '…' : title; }
  return titleOf(readablePreview(text, Math.max(max * 3, 360)), max) || 'Untitled thought';
};
const label = { action_candidate: 'Possible action', explicit_commitment: 'Stated intent', delegation: 'Delegation', waiting_on: 'Waiting on', question: 'Question', idea: 'Idea', decision: 'Decision', constraint: 'Rule or limit', event_or_fact: 'Note', reference: 'Reference', reflection: 'Reflection', unclear: 'Unsorted' };
let store, state, activeSpan = null, threadId = null, replyTarget = null, currentView = 'home', sourceId, rawView = true, epoch = 0, saving = false, storageHealthy = true, booting = true, refreshing = Promise.resolve();
let draftTimer, draftDirty = false;
const DRAFT = `${KEY}-draft`;
function notice(text, error = false) { $('notice').textContent = text; $('notice').classList.toggle('error', error); $('notice').hidden = false; }
function fail(error) { notice(error.message || 'That did not finish. Your original text has not been removed.', true); }
function formatDate(date) { return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(date)); }
function showView(route, focus = true) {
  const [base, encoded] = route.split('/');
  currentView = base === 'span' ? 'spans' : ['home', 'spans', 'thread', 'engine'].includes(base) ? base : 'home';
  try { activeSpan = base === 'span' ? decodeURIComponent(encoded ?? '') : null; } catch { activeSpan = null; }
  const nextThread = base === 'thread' ? encoded : null;
  if (threadId !== nextThread) { persistReplyDraft(); threadId = nextThread; replyTarget = null; loadReplyDraft(); }
  for (const name of ['home', 'spans', 'thread', 'engine']) $(`view-${name}`).hidden = name !== currentView;
  document.querySelectorAll('.rail [data-view]').forEach(button => {
    if (button.dataset.view === (currentView === 'thread' ? 'spans' : currentView)) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
  if (location.hash !== `#${route}`) history.pushState(null, '', `#${route}`);
  if (state) { renderSpans(); renderThread(); }
  if (focus) { $('main').focus(); scrollTo(0, 0); }
}
const routeFromHash = () => location.hash.slice(1) || 'home';
const openThread = id => showView(`thread/${id}`);
const openSpan = id => showView(`span/${encodeURIComponent(id)}`);
function entryCard(capture) {
  const card = element('article', undefined, 'entry-card');
  card.append(element('span', `${capture.span}${capture.sample ? ' · FICTIONAL EXAMPLE' : ' · DEMO CAPTURE'}`, 'eyebrow'));
  card.append(element('h3', displayTitle(capture.text, 90)));
  card.append(element('p', `${formatDate(capture.createdAt)} · Original verified`));
  const open = element('button', 'Open the thought ↗', 'entry-open'); open.onclick = () => openSource(capture.id, false); card.append(open); return card;
}
function render() {
  const now = state.now;
  $('now-title').textContent = now ? readablePreview(now.quote, 4000) : 'Nothing chosen. Room to think.';
  $('now-origin').textContent = now ? now.origin === 'sample' ? 'Sample choice' : 'Chosen here' : 'No next step';
  $('now-reason').textContent = now ? 'One chosen detail. Capturing or exploring something else leaves it here.' : 'Capture freely. A thought only becomes your next step when you choose it.';
  $('now-done').hidden = $('now-original').hidden = $('hold-open').hidden = !now;
  renderReturnPoint();
  $('recent').replaceChildren(...state.captures.filter(c => !parentOf(c)).slice(-2).reverse().map(entryCard));
  if (!state.captures.length) $('recent').append(element('p', 'Nothing here yet. Capture a fictional thought to try the loop.', 'empty'));
  $('storage-count').textContent = `${state.captures.length} saved original${state.captures.length === 1 ? '' : 's'}`;
  const selected = $('capture-span').value;
  $('capture-span').replaceChildren(...(state.spans ?? []).map(span => { const option = element('option', span.name); option.value = span.name; return option; }));
  if ([...$('capture-span').options].some(o => o.value === selected)) $('capture-span').value = selected;
  else $('capture-span').value = 'Unsorted';
  renderSpans(); renderThread();
}
const descriptions = {
  raw: 'A landing place for thoughts that don’t need a destination yet.',
  journal: 'Posts in time order. Keep the history and follow the conversation.',
  proof: 'Evidence of what you did. Keep the source and the human action connected.',
  people: 'Relationship context, follow-ups and conversations worth remembering.',
  moves: 'Possible moves and experiments. Exploring one doesn’t commit you to it.',
  workspace: 'Working notes, decisions and the material behind them.',
};
function roots() { const ids = new Set(state.captures.map(c => c.id)); return state.captures.filter(c => !parentOf(c) || !ids.has(c.parentId)); }
function renderSpans() {
  const span = (state.spans ?? []).find(s => s.id === activeSpan);
  $('span-directory').hidden = !!span; $('span-feed').hidden = !span;
  $('directory-title').textContent = span?.name ?? 'Attention Spans.';
  $('directory-intro').textContent = span ? 'An Attention Span. Its posts stay in time order, with the conversation attached.' : 'Named places for thoughts, conversations and things worth returning to.';
  const query = $('span-search').value.trim().toLowerCase();
  const directory = (state.spans ?? []).filter(s => !query || s.name.toLowerCase().includes(query) || state.captures.some(c => spanKey(c.span) === s.id && c.text.toLowerCase().includes(query)));
  $('span-list').replaceChildren(...directory.map(s => {
    const posts = roots().filter(c => spanKey(c.span) === s.id), all = state.captures.filter(c => spanKey(c.span) === s.id), latest = all.at(-1);
    const card = element('article', undefined, 'span-card'); const link = element('a', s.name, 'span-title'); link.href = `#span/${encodeURIComponent(s.id)}`;
    card.append(element('span', s.kind === 'journal' ? 'ATTENTION SPAN' : s.kind.toUpperCase(), 'eyebrow'), element('h2'));
    card.querySelector('h2').append(link); card.append(element('p', descriptions[s.kind], 'small'));
    card.append(element('p', `${posts.length} post${posts.length === 1 ? '' : 's'} · ${all.length - posts.length} repl${all.length - posts.length === 1 ? 'y' : 'ies'}${latest ? ` · ${formatDate(latest.createdAt)}` : ' · Ready when you are'}`, 'small'));
    if (latest) card.append(element('p', displayTitle(latest.text, 110), 'span-preview'));
    return card;
  }));
  if (!directory.length) $('span-list').append(element('p', 'No Attention Spans match. Try another name or a phrase from a post.', 'empty'));
  if (!span) return;
  $('span-description').textContent = descriptions[span.kind];
  renderSpanDepth(span);
  const posts = roots().filter(c => spanKey(c.span) === span.id).slice().reverse();
  const byId = new Map(state.captures.map(c => [c.id, c])), counts = new Map();
  for (const c of state.captures) { const root = threadRoot(c, byId); if (root && root.id !== c.id) counts.set(root.id, (counts.get(root.id) ?? 0) + 1); }
  $('span-entries').replaceChildren(...posts.map(capture => {
    const group = element('article', undefined, 'journal-post'); const heading = element('div', undefined, 'entry-heading');
    heading.append(element('span', `${formatDate(capture.createdAt)} · ${capture.sample ? 'FICTIONAL EXAMPLE' : 'DEMO POST'}`, 'eyebrow'));
    group.append(heading, element('h2', displayTitle(capture.text, 90)), element('p', readablePreview(capture.text, 360), 'post-excerpt'));
    const replyCount = counts.get(capture.id) ?? 0;
    const actions = element('div', undefined, 'post-actions'); const open = element('button', `Open thread · ${replyCount} repl${replyCount === 1 ? 'y' : 'ies'}`, 'text-button'); open.onclick = () => openThread(capture.id);
    const original = element('button', 'See original ↗', 'text-button'); original.onclick = () => openSource(capture.id, true);
    actions.append(open, original); group.append(actions); return group;
  }));
  if (!posts.length) $('span-entries').append(element('p', 'No posts yet. Capture something here without turning it into a task.', 'empty'));
}
function renderThread() {
  if (currentView !== 'thread') return;
  const requested = state.captures.find(c => c.id === threadId), root = requested && threadRoot(requested, state.captures);
  const main = $('thread-post'); main.replaceChildren();
  $('thread-permalink').hidden = $('reply-to-root').hidden = !root;
  if (!root) { $('back-feed').onclick = () => showView('spans'); main.append(element('h1', 'This thought isn’t here.'), element('p', 'Its link may belong to another browser workspace or a record in Engine Room recovery.')); $('thread-replies').replaceChildren(); $('reply-form').hidden = true; return; }
  $('reply-form').hidden = false; $('thread-permalink').href = `#thread/${root.id}`;
  $('back-feed').onclick = () => openSpan(spanKey(root.span));
  main.append(element('span', `${root.span} · ${formatDate(root.createdAt)} · ${root.sample ? 'FICTIONAL EXAMPLE' : 'DEMO POST'}`, 'eyebrow'), element('h1', displayTitle(root.text, 110)));
  if (parentOf(root)) main.append(element('p', 'The parent original needs recovery. This reply and its own replies are preserved here.', 'notice'));
  const display = element('details', undefined, 'original-disclosure'); display.append(element('summary', 'Read the exact original'), element('pre', root.text, 'raw'), element('p', `Original verified · SHA-256 ${root.hash}`, 'small'));
  const download = element('button', 'Download original text', 'text-button'); download.onclick = () => downloadText(root.text, `effort-original-${root.id}.txt`, 'text/plain'); display.append(download);
  main.append(renderReading(root.text, { titleAlreadyShown: displayTitle(root.text, 110) }), display);
  const grouping = element('details', undefined, 'organized-disclosure'); grouping.append(element('summary', 'See organized details'), organized(root, false)); main.append(grouping);
  const actions = element('div', undefined, 'post-actions');
  const choose = element('button', 'Choose a next step…', 'quiet'); choose.onclick = () => openSource(root.id, false);
  const reply = element('button', 'Reply', 'quiet'); reply.onclick = () => targetReply(root.id);
  const hold = element('button', 'Hold my place…', 'text-button'); hold.onclick = openHold;
  actions.append(reply, choose, hold); main.append(actions);
  const children = new Map();
  for (const capture of state.captures) if (parentOf(capture)) { const list = children.get(capture.parentId) ?? []; list.push(capture); children.set(capture.parentId, list); }
  const rows = [], visited = new Set([root.id]);
  function collect(id, depth) { for (const c of children.get(id) ?? []) { if (visited.has(c.id)) continue; visited.add(c.id); rows.push({ capture: c, depth }); collect(c.id, depth + 1); } }
  collect(root.id, 0);
  $('replies-heading').textContent = `${rows.length} repl${rows.length === 1 ? 'y' : 'ies'}`;
  $('thread-replies').replaceChildren(...rows.map(({ capture, depth }) => {
    const card = element('article', undefined, `thread-reply depth-${Math.min(depth, 3)}`); card.id = `reply-${capture.id}`;
    card.append(element('p', `You · ${formatDate(capture.createdAt)} · Reply${depth ? ` at depth ${depth + 1}` : ''}`, 'small'), renderReading(capture.text, { headingBase: 3 }));
    const actions = element('div', undefined, 'post-actions'); const button = element('button', 'Reply to this', 'text-button'); button.onclick = () => targetReply(capture.id);
    const source = element('button', 'Original ↗', 'text-button'); source.onclick = () => openSource(capture.id, true);
    const permalink = element('a', 'Permalink', 'small'); permalink.href = `#thread/${capture.id}`;
    actions.append(button, source, permalink); card.append(actions); if (capture.id === threadId) card.classList.add('selected-reply'); return card;
  }));
  if (!rows.length) $('thread-replies').append(element('p', 'Room for the next thought. Replies will stay attached to this post.', 'muted'));
  if (!replyTarget || !state.captures.some(c => c.id === replyTarget)) replyTarget = root.id;
  $('reply-target').textContent = `Replying to: ${displayTitle(state.captures.find(c => c.id === replyTarget).text, 100)}`;
  $('reply-to-root').onclick = () => targetReply(root.id);
}
function targetReply(id) { persistReplyDraft(); replyTarget = id; replyDraftDirty = true; persistReplyDraft(); renderThread(); $('reply-text').focus(); $('reply-form').scrollIntoView({ block: 'center', behavior: 'auto' }); }
function organized(capture, choices = true) {
  const body = element('div');
  for (const section of organizeText(capture.id, capture.text).sections) {
    const group = element('section', undefined, 'source-group'); group.append(element('h3', section.label));
    const list = element('div', undefined, 'fragments');
    for (const item of section.items) {
      const row = element('div', undefined, 'fragment'); const words = element('div');
      words.append(element('span', label[item.type] ?? 'Unsorted', 'badge'), renderReading(item.quote, { headingBase: 4 }), element('p', 'Rendered from an exact source range. The category is a rule-based suggestion.', 'small'));
      const choose = element('button', 'Make this my next step', 'quiet');
      choose.onclick = async () => {
        choose.disabled = true;
        try { state = await store.choose(capture.id, item.start, item.end); render(); if ($('source-dialog').open) $('source-dialog').close(); showView('home'); notice('Chosen. Your original thought is unchanged.'); }
        catch (error) { fail(error); } finally { choose.disabled = false; }
      };
      row.append(words); if (choices) row.append(choose); else row.classList.add('reading-fragment'); list.append(row);
    }
    group.append(list); body.append(group);
  }
  return body;
}
function renderSource() {
  const capture = state.captures.find(c => c.id === sourceId); if (!capture) { $('source-body').replaceChildren(element('p', 'This original is no longer in the active workspace. Check Engine Room recovery or your downloaded backup.')); $('source-proof').textContent = ''; return; }
  $('show-raw').setAttribute('aria-pressed', String(rawView)); $('show-organized').setAttribute('aria-pressed', String(!rawView));
  $('source-body').replaceChildren(rawView ? element('pre', capture.text, 'raw') : organized(capture));
  $('source-proof').textContent = `Original verified · SHA-256 ${capture.hash.slice(0, 16)}… · ${capture.text.length} UTF-16 code units`;
}
function openSource(id, raw) { sourceId = id; rawView = raw; renderSource(); $('source-dialog').showModal(); }
function persistDraft() {
  clearTimeout(draftTimer);
  if (!draftDirty) return;
  try {
    localStorage.setItem(DRAFT, JSON.stringify({ text: $('capture-text').value, span: $('capture-span').value }));
    draftDirty = false;
    $('draft-state').textContent = 'Draft kept in this browser.';
  } catch { $('draft-state').textContent = 'The draft could not be stored. Keep this window open and copy it before leaving.'; }
}
function loadDraft() {
  try {
    const draft = JSON.parse(localStorage.getItem(DRAFT) ?? 'null');
    if (draft && typeof draft.text === 'string' && draft.text.length <= LIMITS.text && typeof draft.span === 'string') {
      $('capture-text').value = draft.text; $('capture-span').value = draft.span;
    }
  } catch { /* A malformed draft doesn't prevent viewing verified saved originals. */ }
}
let replyDraftDirty = false;
function replyDraftKey() { return threadId ? `${KEY}-reply-${threadId}` : null; }
function persistReplyDraft() {
  if (!replyDraftDirty || !replyDraftKey()) return;
  try { localStorage.setItem(replyDraftKey(), JSON.stringify({ text: $('reply-text').value, parentId: replyTarget })); replyDraftDirty = false; $('reply-draft-state').textContent = 'Draft kept in this browser.'; }
  catch { $('reply-draft-state').textContent = 'This draft could not be stored. Copy it before leaving.'; }
}
function loadReplyDraft() {
  $('reply-text').value = ''; $('reply-draft-state').textContent = ''; replyDraftDirty = false;
  try { const draft = JSON.parse(localStorage.getItem(replyDraftKey()) ?? 'null'); if (draft && typeof draft.text === 'string' && draft.text.length <= LIMITS.text) { $('reply-text').value = draft.text; replyTarget = draft.parentId; } } catch {}
}
$('reply-text').oninput = () => { replyDraftDirty = true; persistReplyDraft(); };
addEventListener('pagehide', persistReplyDraft);
$('reply-form').onsubmit = async event => {
  event.preventDefault(); const parent = state.captures.find(c => c.id === replyTarget); if (!parent) return;
  const text = $('reply-text').value, destination = threadId; persistReplyDraft(); $('save-reply').disabled = true;
  try {
    await store.capture(text, parent.span, parent.id); await refreshed();
    if (threadId === destination && $('reply-text').value === text) { $('reply-text').value = ''; replyDraftDirty = true; persistReplyDraft(); }
    notice('Reply saved. Exact original verified. NOW is unchanged.');
  } catch (error) { $('reply-draft-state').textContent = `${error.message} Your draft is still here.`; }
  finally { $('save-reply').disabled = false; }
};
function refreshed() {
  refreshing = refreshing.catch(() => {}).then(async () => {
    state = await store.read(); const health = await store.health();
    storageHealthy = true; $('capture-open').disabled = booting; render();
    $('recovery-panel').hidden = !state.recovery.length && !health.migrationWarning;
    $('recovery-status').textContent = health.migrationWarning || `${state.recovery.length} damaged record${state.recovery.length === 1 ? '' : 's'} preserved separately. Verified originals remain available and you can keep capturing.`;
    $('recovery-items').replaceChildren(...state.recovery.map(record => {
      const item = element('details'); item.append(element('summary', `${record.source}: ${record.reason}`), element('pre', record.raw, 'raw')); return item;
    }));
    if (health.heldNow) {
      $('now-title').textContent = 'Your chosen step needs recovery.';
      $('now-reason').textContent = 'Its saved reference could not be verified. Nothing else has been chosen for you. The damaged copy is preserved in Engine Room.';
    }
    if (sourceId && $('source-dialog').open) renderSource();
  });
  return refreshing;
}

let holdExpected = null, holdRoute = 'home', holdContext, dropping = null, holdSaving = false, dropSaving = false;
const commitments = () => deriveCommitments(state.intentEvents ?? []);
const openPlaces = () => (state.places ?? []).filter(place => !(state.resumptions ?? []).some(r => r.placeId === place.id)).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
function placeStatus(place) {
  if (!place.choice) return 'Your reading context is kept. Resuming leaves the current NOW unchanged.';
  const item = commitments().find(c => c.id === place.commitmentId);
  if (!item || !state.captures.some(c => c.id === place.choice.captureId)) return 'The source or commitment needs recovery. Your return notes are kept.';
  if (['COMPLETE', 'DROPPED'].includes(item.state)) return `This commitment is ${item.state.toLowerCase()}. Its return notes are kept; resuming won’t reactivate it.`;
  return state.now?.quote === place.choice.quote ? 'Your chosen step is still here.' : `Resuming will make this step NOW again: ${place.choice.quote}`;
}
function canResume(place) {
  if (!place.choice) return true;
  return commitments().some(c => c.id === place.commitmentId && ['ACTIVE', 'COMMITTED'].includes(c.state)) && state.captures.some(c => c.id === place.choice.captureId);
}
async function resumeSavedPlace(place, button) {
  button.disabled = true;
  try {
    const closeOnly = !canResume(place), result = await store.resumePlace(place.id, state.now, { closeOnly });
    state = result.state; render();
    if (result.alreadyHandled) { notice('This return point was already handled. Your current work is unchanged.'); return; }
    if (!closeOnly) {
      showView(result.route); $('span-search').value = place.context.spanSearch; renderSpans();
      const source = document.querySelector('#thread-post .original-disclosure'); if (source) source.open = place.context.sourceExpanded;
      requestAnimationFrame(() => scrollTo(0, place.context.scrollY));
    }
    notice(closeOnly ? 'Return point closed. Its notes remain in Workspace.' : `Your place is restored.${place.nextAction ? ` Return note: ${place.nextAction}` : ''}`);
  } catch (error) { fail(error); } finally { button.disabled = false; }
}
function renderReturnPoint() {
  const place = openPlaces().at(-1); $('return-card').hidden = !place; if (!place) return;
  $('return-summary').textContent = place.summary; $('return-next').textContent = place.nextAction ? `Return note: ${place.nextAction}` : '';
  $('return-status').textContent = placeStatus(place); $('resume-place').textContent = canResume(place) ? 'Resume this step' : 'Close return point';
  $('resume-place').onclick = () => resumeSavedPlace(place, $('resume-place'));
}
function openHold() {
  if (holdSaving) { notice('Your return point is still saving. Keep this window open.'); return; }
  holdExpected = structuredClone(state.now); holdRoute = routeFromHash();
  holdContext = { scrollY, spanSearch: $('span-search').value, sourceExpanded: document.querySelector('#thread-post .original-disclosure')?.open ?? false };
  const thought = threadId && state.captures.find(c => c.id === threadId);
  $('hold-summary').value = thought ? displayTitle(thought.text, 300) : state.now?.quote ?? '';
  $('hold-next').value = ''; $('hold-error').textContent = ''; $('hold-dialog').showModal(); $('hold-summary').focus();
}
$('hold-open').onclick = openHold;
$('hold-form').onsubmit = async event => {
  event.preventDefault(); if (holdSaving) return; holdSaving = true;
  for (const id of ['save-place', 'hold-summary', 'hold-next']) $(id).disabled = true;
  try {
    await store.holdPlace({ summary: $('hold-summary').value, nextAction: $('hold-next').value, route: holdRoute, context: holdContext, expected: holdExpected });
    await refreshed(); $('hold-dialog').close(); notice('Your place is kept. Capture or explore freely; NOW is unchanged.');
  } catch (error) { $('hold-error').textContent = `${error.message} Your return note is still here.`; }
  finally { holdSaving = false; for (const id of ['save-place', 'hold-summary', 'hold-next']) $(id).disabled = false; }
};
function sourceButton(choice) {
  const button = element('button', 'See source ↗', 'text-button');
  const source = state.captures.find(c => c.id === choice.captureId);
  if (source) button.onclick = () => openSource(source.id, true);
  else { button.textContent = 'Source needs recovery ↗'; button.onclick = () => showView('engine'); }
  return button;
}
function renderSpanDepth(span) {
  const body = $('span-depth'); body.replaceChildren();
  if (span.kind === 'proof') {
    body.append(element('h2', 'Completion receipts'), element('p', 'These record your own Done action. They’re self-reported, not independently verified proof.', 'muted'));
    const completed = commitments().filter(c => c.receipt).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    for (const item of completed) {
      const card = element('article', undefined, 'panel proof-receipt');
      card.append(element('span', 'COMPLETE · SELF-REPORTED', 'eyebrow'), element('h3', item.choice.quote), renderReading(item.receipt.note, { headingBase: 3 }), element('p', formatDate(item.receipt.at), 'small'), sourceButton(item.choice));
      if (state.captures.find(c => c.id === item.choice.captureId)?.sample) card.append(element('p', 'Fictional example source.', 'small'));
      body.append(card);
    }
    if (!completed.length) body.append(element('p', 'No completion receipts yet. When you mark a chosen step done, its receipt will appear here.', 'empty'));
  }
  if (span.kind === 'workspace') {
    body.append(element('h2', 'Chosen work'), element('p', 'Only explicit choices appear here. Captures and replies can stay thoughts.', 'muted'));
    for (const item of commitments().filter(c => ['COMMITTED', 'ACTIVE'].includes(c.state))) {
      const card = element('article', undefined, 'panel commitment-card'); card.append(element('span', item.state, 'eyebrow'), element('h3', item.choice.quote));
      const actions = element('div', undefined, 'post-actions');
      if (item.state !== 'ACTIVE') { const choose = element('button', 'Make this NOW', 'quiet'); choose.onclick = async () => { choose.disabled = true; try { state = await store.selectCommitment(item.id, state.now); render(); showView('home'); notice('Chosen work restored to NOW.'); } catch (error) { fail(error); } finally { choose.disabled = false; } }; actions.append(choose); }
      const drop = element('button', 'Drop commitment…', 'text-button'); drop.onclick = () => { if (dropSaving) { notice('The commitment change is still saving.'); return; } dropping = item; $('drop-choice').textContent = item.choice.quote; $('drop-note').value = ''; $('drop-error').textContent = ''; $('drop-dialog').showModal(); $('drop-note').focus(); };
      actions.append(sourceButton(item.choice), drop); card.append(actions); body.append(card);
    }
    for (const place of state.places ?? []) {
      const card = element('details', undefined, 'panel'); card.append(element('summary', `Return point: ${place.summary}`), element('p', place.nextAction || 'No extra return note.', 'reply-body'));
      const receipt = (state.resumptions ?? []).find(r => r.placeId === place.id);
      card.append(element('p', receipt ? `${receipt.kind === 'closed' ? 'Closed' : 'Resumed'} ${formatDate(receipt.at)}. Original notes kept.` : placeStatus(place), 'small'));
      if (!receipt) { const resume = element('button', canResume(place) ? 'Resume this step' : 'Close return point', 'quiet'); resume.onclick = () => resumeSavedPlace(place, resume); card.append(resume); }
      body.append(card);
    }
    const closed = commitments().filter(c => c.state === 'DROPPED');
    if (closed.length) { const history = element('details', undefined, 'panel'); history.append(element('summary', 'Dropped commitments, with their reasons')); for (const c of closed) history.append(element('h3', c.choice.quote), element('p', c.history.at(-1).note, 'reply-body'), sourceButton(c.choice)); body.append(history); }
  }
}
$('drop-form').onsubmit = async event => {
  event.preventDefault(); if (!dropping || dropSaving) return; dropSaving = true; $('save-drop').disabled = $('drop-note').disabled = true;
  try { state = await store.dropCommitment(dropping.id, $('drop-note').value, dropping.latestId); render(); $('drop-dialog').close(); notice('Commitment dropped. Its reason and original are kept. Nothing else was chosen.'); }
  catch (error) { $('drop-error').textContent = error.message; } finally { dropSaving = false; $('save-drop').disabled = $('drop-note').disabled = false; }
};

document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => showView(button.dataset.view)));
addEventListener('hashchange', () => showView(routeFromHash()));
document.querySelectorAll('[data-close]').forEach(button => button.onclick = () => $(button.dataset.close).close());
function openCapture(destination) { if (destination && !$('capture-text').value) $('capture-span').value = destination; $('capture-dialog').showModal(); $('capture-text').focus(); }
$('capture-open').onclick = () => openCapture();
$('post-to-span').onclick = () => openCapture(state.spans.find(s => s.id === activeSpan)?.name);
$('back-spans').onclick = () => showView('spans');
$('span-search').oninput = renderSpans;
$('new-span').onclick = () => { $('span-error').textContent = ''; $('span-dialog').showModal(); $('span-name').focus(); };
$('span-form').onsubmit = async event => {
  event.preventDefault(); $('save-span').disabled = true;
  try { const span = await store.createSpan($('span-name').value); await refreshed(); $('span-dialog').close(); $('span-name').value = ''; openSpan(span.id); notice('Attention Span ready. Nothing has been made a task.'); }
  catch (error) { $('span-error').textContent = error.message; } finally { $('save-span').disabled = false; }
};
$('capture-text').oninput = () => { draftDirty = true; $('draft-state').textContent = 'Keeping draft…'; clearTimeout(draftTimer); draftTimer = setTimeout(persistDraft, 120); };
$('capture-span').onchange = () => { draftDirty = true; persistDraft(); };
$('capture-dialog').addEventListener('close', persistDraft);
addEventListener('pagehide', persistDraft);
$('fill-example').onclick = () => { $('capture-text').value = "Maybe build a small workshop exercise.\nI'll review the outline tomorrow.\nI'm waiting for the venue to reply."; draftDirty = true; persistDraft(); $('capture-text').focus(); };
$('capture-form').onsubmit = async event => {
  event.preventDefault(); if (saving || !storageHealthy) return;
  const text = $('capture-text').value, span = $('capture-span').value, generation = epoch;
  persistDraft(); saving = true; $('save-capture').disabled = true; $('save-capture').textContent = 'Verifying…';
  try {
    await store.capture(text, span);
    if (generation !== epoch) return;
    await refreshed();
    if ($('capture-text').value === text) { $('capture-text').value = ''; draftDirty = true; persistDraft(); }
    $('capture-dialog').close(); notice('Saved. Exact original read back and verified. Your next step is unchanged.');
  } catch (error) { if (generation !== epoch) return; fail(error); $('draft-state').textContent = `${error.message} Your draft is still here.`; }
  finally { saving = false; $('save-capture').disabled = false; $('save-capture').textContent = 'Save original'; }
};
$('show-raw').onclick = () => { rawView = true; renderSource(); };
$('show-organized').onclick = () => { rawView = false; renderSource(); };
$('now-original').onclick = () => state.now && openSource(state.now.captureId, true);
$('now-done').onclick = async () => { try { state = await store.complete(state.now); render(); notice('Done. Your self-reported receipt is in Proof.'); } catch (error) { fail(error); } };
function downloadText(raw, filename, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([raw], { type })); const link = element('a'); link.href = url; link.download = filename;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('download').onclick = async () => {
  try {
    const raw = await store.exportData(); const url = URL.createObjectURL(new Blob([raw], { type: 'application/json' }));
    const link = element('a'); link.href = url; link.download = 'effort-browser-demo-backup.json'; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    notice('Demo backup prepared for download. This is separate from a native phone backup.');
  } catch (error) { fail(error); }
};
$('restore-open').onclick = () => $('restore-file').click();
$('restore-file').onchange = async () => {
  const file = $('restore-file').files[0]; if (!file) return;
  try {
    if (file.size > LIMITS.backupBytes) throw Error('Choose a demo backup under 32 MB.');
    const added = await store.restore(await file.text()); await refreshed(); notice(`Restore verified. ${added} missing capture${added === 1 ? '' : 's'} added; existing originals kept.`);
  } catch (error) { fail(error); } finally { $('restore-file').value = ''; }
};
async function replaceDemo(samples) {
  if (!confirm(samples ? 'Replace this browser demo with fictional examples? Download a backup first if you want to keep its current captures.' : 'Clear only this browser demo and its draft? This does not touch the Android app.')) return;
  epoch++;
  try {
    if (samples) await store.seed(true); else await store.reset();
    let draftCleanupError;
    try { for (const key of Object.keys(localStorage)) if (key === DRAFT || key.startsWith(`${KEY}-reply-`)) localStorage.removeItem(key); } catch (error) { draftCleanupError = error; }
    draftDirty = false; $('capture-text').value = ''; $('capture-span').value = 'Unsorted'; $('draft-state').textContent = '';
    await refreshed(); showView('home'); notice(draftCleanupError ? 'The workspace changed, but browser draft cleanup failed. Copy any draft you need and retry the clear.' : samples ? 'Fictional examples loaded.' : 'Browser demo cleared. Your private EFFORT app is separate.', !!draftCleanupError);
  } catch (error) { fail(error); }
}
$('sample-reset').onclick = () => replaceDemo(true); $('reset').onclick = () => replaceDemo(false);
$('lock-note').textContent = 'IndexedDB transactions serialize writes across tabs. Changed records refresh when another tab saves or this window becomes active. Browser storage can still be erased: keep downloaded backups.';
loadDraft();
try {
  store = createStore(); await store.seed(); await refreshed(); loadDraft(); booting = false; $('capture-open').disabled = false;
  store.subscribe(() => refreshed().catch(fail));
  addEventListener('visibilitychange', () => { if (!document.hidden) refreshed().catch(fail); });
  addEventListener('focus', () => refreshed().catch(fail));
  showView(routeFromHash(), false);
} catch (error) {
  storageHealthy = false; state = { captures: [], now: null }; render(); $('capture-open').disabled = true; showView('engine', false);
  fail(Error(`The local workspace could not open: ${error.message} Your saved data has not been cleared. Keep this tab open and copy any draft before retrying.`));
}
