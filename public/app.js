import { organizeText, titleOf } from './core/ef.js';
import { createStore, KEY, LIMITS } from './store.js';
import { spanKey, parentOf, threadRoot } from './spans.js';

const $ = id => document.getElementById(id);
const element = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
const label = { action_candidate: 'Possible action', explicit_commitment: 'Stated intent', delegation: 'Delegation', waiting_on: 'Waiting on', question: 'Question', idea: 'Idea', decision: 'Decision', constraint: 'Rule or limit', event_or_fact: 'Note', reference: 'Reference', reflection: 'Reflection', unclear: 'Unsorted' };
let store, state, activeSpan = null, threadId = null, replyTarget = null, currentView = 'home', sourceId, rawView = true, epoch = 0, saving = false, storageHealthy = true, refreshing = Promise.resolve();
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
  card.append(element('h3', titleOf(capture.text, 90)));
  card.append(element('p', `${formatDate(capture.createdAt)} · Original verified`));
  const open = element('button', 'Open the thought ↗', 'entry-open'); open.onclick = () => openSource(capture.id, false); card.append(open); return card;
}
function render() {
  const now = state.now;
  $('now-title').textContent = now?.quote ?? 'Nothing chosen. Room to think.';
  $('now-origin').textContent = now ? now.origin === 'sample' ? 'Sample choice' : 'Chosen here' : 'No next step';
  $('now-reason').textContent = now ? 'One chosen detail. Capturing or exploring something else leaves it here.' : 'Capture freely. A thought only becomes your next step when you choose it.';
  $('now-done').hidden = $('now-original').hidden = !now;
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
    if (latest) card.append(element('p', titleOf(latest.text, 110), 'span-preview'));
    return card;
  }));
  if (!directory.length) $('span-list').append(element('p', 'No Attention Spans match. Try another name or a phrase from a post.', 'empty'));
  if (!span) return;
  $('span-description').textContent = descriptions[span.kind];
  const posts = roots().filter(c => spanKey(c.span) === span.id).slice().reverse();
  const byId = new Map(state.captures.map(c => [c.id, c])), counts = new Map();
  for (const c of state.captures) { const root = threadRoot(c, byId); if (root && root.id !== c.id) counts.set(root.id, (counts.get(root.id) ?? 0) + 1); }
  $('span-entries').replaceChildren(...posts.map(capture => {
    const group = element('article', undefined, 'journal-post'); const heading = element('div', undefined, 'entry-heading');
    heading.append(element('span', `${formatDate(capture.createdAt)} · ${capture.sample ? 'FICTIONAL EXAMPLE' : 'DEMO POST'}`, 'eyebrow'));
    group.append(heading, element('h2', titleOf(capture.text, 90)), element('p', capture.text.slice(0, 360) + (capture.text.length > 360 ? '…' : ''), 'post-excerpt'));
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
  main.append(element('span', `${root.span} · ${formatDate(root.createdAt)} · ${root.sample ? 'FICTIONAL EXAMPLE' : 'DEMO POST'}`, 'eyebrow'), element('h1', titleOf(root.text, 110)));
  if (parentOf(root)) main.append(element('p', 'The parent original needs recovery. This reply and its own replies are preserved here.', 'notice'));
  const display = element('details', undefined, 'original-disclosure'); display.append(element('summary', 'Read the exact original'), element('pre', root.text, 'raw'), element('p', `Original verified · SHA-256 ${root.hash}`, 'small'));
  const download = element('button', 'Download original text', 'text-button'); download.onclick = () => downloadText(root.text, `effort-original-${root.id}.txt`, 'text/plain'); display.append(download);
  main.append(organized(root, false), display);
  const actions = element('div', undefined, 'post-actions');
  const choose = element('button', 'Choose a next step…', 'quiet'); choose.onclick = () => openSource(root.id, false);
  const reply = element('button', 'Reply', 'quiet'); reply.onclick = () => targetReply(root.id);
  actions.append(reply, choose); main.append(actions);
  const children = new Map();
  for (const capture of state.captures) if (parentOf(capture)) { const list = children.get(capture.parentId) ?? []; list.push(capture); children.set(capture.parentId, list); }
  const rows = [], visited = new Set([root.id]);
  function collect(id, depth) { for (const c of children.get(id) ?? []) { if (visited.has(c.id)) continue; visited.add(c.id); rows.push({ capture: c, depth }); collect(c.id, depth + 1); } }
  collect(root.id, 0);
  $('replies-heading').textContent = `${rows.length} repl${rows.length === 1 ? 'y' : 'ies'}`;
  $('thread-replies').replaceChildren(...rows.map(({ capture, depth }) => {
    const card = element('article', undefined, `thread-reply depth-${Math.min(depth, 3)}`); card.id = `reply-${capture.id}`;
    card.append(element('p', `You · ${formatDate(capture.createdAt)} · Reply${depth ? ` at depth ${depth + 1}` : ''}`, 'small'), element('p', capture.text, 'reply-body'));
    const actions = element('div', undefined, 'post-actions'); const button = element('button', 'Reply to this', 'text-button'); button.onclick = () => targetReply(capture.id);
    const source = element('button', 'Original ↗', 'text-button'); source.onclick = () => openSource(capture.id, true);
    const permalink = element('a', 'Permalink', 'small'); permalink.href = `#thread/${capture.id}`;
    actions.append(button, source, permalink); card.append(actions); if (capture.id === threadId) card.classList.add('selected-reply'); return card;
  }));
  if (!rows.length) $('thread-replies').append(element('p', 'Room for the next thought. Replies will stay attached to this post.', 'muted'));
  if (!replyTarget || !state.captures.some(c => c.id === replyTarget)) replyTarget = root.id;
  $('reply-target').textContent = `Replying to: ${titleOf(state.captures.find(c => c.id === replyTarget).text, 100)}`;
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
      words.append(element('span', label[item.type] ?? 'Unsorted', 'badge'), element('blockquote', item.quote), element('p', 'Exact source quote. The category is a rule-based suggestion.', 'small'));
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
    storageHealthy = true; $('capture-open').disabled = false; render();
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
$('now-done').onclick = async () => { try { state = await store.complete(state.now); render(); notice('Done. The original is still in Attention Spans. Nothing else was promoted.'); } catch (error) { fail(error); } };
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
  store = createStore(); await store.seed(); await refreshed(); loadDraft();
  store.subscribe(() => refreshed().catch(fail));
  addEventListener('visibilitychange', () => { if (!document.hidden) refreshed().catch(fail); });
  addEventListener('focus', () => refreshed().catch(fail));
  showView(routeFromHash(), false);
} catch (error) {
  storageHealthy = false; state = { captures: [], now: null }; render(); $('capture-open').disabled = true; showView('engine', false);
  fail(Error(`The local workspace could not open: ${error.message} Your saved data has not been cleared. Keep this tab open and copy any draft before retrying.`));
}
