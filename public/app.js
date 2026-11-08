import { organizeText, titleOf } from './core/ef.js';
import { createStore, KEY, LIMITS, SPANS } from './store.js';

const $ = id => document.getElementById(id);
const element = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
const label = { action_candidate: 'Possible action', explicit_commitment: 'Stated intent', delegation: 'Delegation', waiting_on: 'Waiting on', question: 'Question', idea: 'Idea', decision: 'Decision', constraint: 'Rule or limit', event_or_fact: 'Note', reference: 'Reference', reflection: 'Reflection', unclear: 'Unsorted' };
let store, state, activeSpan = 'All', sourceId, rawView = true, epoch = 0, saving = false, storageHealthy = true;
let draftTimer, draftDirty = false;
const DRAFT = `${KEY}-draft`;
function notice(text, error = false) { $('notice').textContent = text; $('notice').classList.toggle('error', error); $('notice').hidden = false; }
function fail(error) { notice(error.message || 'That did not finish. Your original text has not been removed.', true); }
function formatDate(date) { return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(date)); }
function showView(view, focus = true) {
  for (const name of ['home', 'spans', 'engine']) $(`view-${name}`).hidden = name !== view;
  document.querySelectorAll('.rail [data-view]').forEach(button => {
    if (button.dataset.view === view) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
  history.replaceState(null, '', `#${view}`);
  if (focus) { $('main').focus(); scrollTo(0, 0); }
}
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
  $('recent').replaceChildren(...state.captures.slice(-2).reverse().map(entryCard));
  if (!state.captures.length) $('recent').append(element('p', 'Nothing here yet. Capture a fictional thought to try the loop.', 'empty'));
  $('storage-count').textContent = `${state.captures.length} saved original${state.captures.length === 1 ? '' : 's'}`;
  $('span-tabs').replaceChildren(...['All', ...SPANS].map(span => {
    const button = element('button', span); button.setAttribute('aria-pressed', String(span === activeSpan)); button.onclick = () => { activeSpan = span; render(); }; return button;
  }));
  const entries = state.captures.filter(c => activeSpan === 'All' || c.span === activeSpan).slice().reverse();
  $('span-entries').replaceChildren(...entries.map(capture => {
    const group = element('article', undefined, 'entry-group'); const heading = element('div', undefined, 'entry-heading');
    heading.append(element('span', `${capture.span} · ${capture.sample ? 'Fictional example' : 'Demo capture'}`, 'eyebrow'));
    const open = element('button', 'See original ↗', 'text-button'); open.onclick = () => openSource(capture.id, true); heading.append(open);
    group.append(heading, element('h2', titleOf(capture.text, 70)), element('p', formatDate(capture.createdAt), 'small'));
    group.append(organized(capture)); return group;
  }));
  if (!entries.length) $('span-entries').append(element('p', 'No thoughts in this Attention Span yet.', 'empty'));
}
function organized(capture) {
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
      row.append(words, choose); list.append(row);
    }
    group.append(list); body.append(group);
  }
  return body;
}
function renderSource() {
  const capture = state.captures.find(c => c.id === sourceId); if (!capture) return;
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
    if (draft && typeof draft.text === 'string' && draft.text.length <= LIMITS.text && SPANS.includes(draft.span)) {
      $('capture-text').value = draft.text; $('capture-span').value = draft.span;
    }
  } catch { /* A malformed draft doesn't prevent viewing verified saved originals. */ }
}
async function refreshed() { state = await store.read(); storageHealthy = true; $('capture-open').disabled = false; render(); }

document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => showView(button.dataset.view)));
addEventListener('hashchange', () => showView(['spans', 'engine'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'home'));
document.querySelectorAll('[data-close]').forEach(button => button.onclick = () => $(button.dataset.close).close());
$('capture-open').onclick = () => { $('capture-dialog').showModal(); $('capture-text').focus(); };
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
  } catch (error) { fail(error); $('draft-state').textContent = `${error.message} Your draft is still here.`; }
  finally { saving = false; $('save-capture').disabled = false; $('save-capture').textContent = 'Save original'; }
};
$('show-raw').onclick = () => { rawView = true; renderSource(); };
$('show-organized').onclick = () => { rawView = false; renderSource(); };
$('now-original').onclick = () => state.now && openSource(state.now.captureId, true);
$('now-done').onclick = async () => { try { state = await store.complete(state.now); render(); notice('Done. The original is still in Attention Spans. Nothing else was promoted.'); } catch (error) { fail(error); } };
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
    if (file.size > LIMITS.backupBytes) throw Error('Choose a demo backup under 512 KB.');
    const added = await store.restore(await file.text()); await refreshed(); notice(`Restore verified. ${added} missing capture${added === 1 ? '' : 's'} added; existing originals kept.`);
  } catch (error) { fail(error); } finally { $('restore-file').value = ''; }
};
async function replaceDemo(samples) {
  if (!confirm(samples ? 'Replace this browser demo with fictional examples? Download a backup first if you want to keep its current captures.' : 'Clear only this browser demo and its draft? This does not touch the Android app.')) return;
  epoch++;
  try {
    if (samples) await store.seed(true); else await store.reset();
    localStorage.removeItem(DRAFT); draftDirty = false; $('capture-text').value = ''; $('capture-span').value = 'Unsorted'; $('draft-state').textContent = '';
    await refreshed(); showView('home'); notice(samples ? 'Fictional examples loaded.' : 'Browser demo cleared. Your private EFFORT app is separate.');
  } catch (error) { fail(error); }
}
$('sample-reset').onclick = () => replaceDemo(true); $('reset').onclick = () => replaceDemo(false);
$('lock-note').textContent = navigator.locks ? 'This browser serializes demo writes across tabs using Web Locks.' : 'Web Locks are unavailable here. Use one demo tab at a time; cross-tab writes are not guaranteed.';
loadDraft();
try {
  store = createStore(localStorage); await store.seed(); await refreshed();
  showView(['spans', 'engine'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'home', false);
} catch (error) {
  storageHealthy = false; state = { captures: [], now: null }; render(); $('capture-open').disabled = true; showView('engine', false);
  fail(Error('Saved demo data could not be verified. Nothing was silently removed. You can explicitly clear this demo to recover.'));
}
