import { createRevisionsUI } from './revisions-ui.js';
import { createArchiveUI } from './archive-ui.js';
import { createPeopleUI } from './people-ui.js';
import { deriveOpened } from './opened.js';
import { deriveMoves, deriveBranchStatuses, moveSnapshot, validMoveSnapshot } from './thinking.js';
import { artifactBytes, artifactPreview, artifactSourceStatus, ARTIFACT_LIMITS } from './artifacts.js';
import { EXPLORATION_DIALS, DISTILLATION_TYPES, validateProposalProvenance } from './exploration.js';
import { setupOffline } from './offline.js';
import { renderReading, readablePreview } from './reading.js';
import { deriveCommitments } from './intent.js';
import { organizeText, titleOf } from './core/ef.js';
import { createStore, KEY, LIMITS } from './store.js';
import { spanKey, parentOf, threadRoot } from './spans.js';
import { createDraftShelf } from './drafts.js';

const $ = id => document.getElementById(id);
const element = (tag, text, cls) => { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; };
const displayTitle = (text, max = 90) => {
  const firstLine = text.split(/\r?\n/, 1)[0];
  if (/^#{1,6}\s/.test(firstLine)) { const title = readablePreview(firstLine, 4000); return title.length > max ? title.slice(0, max - 1) + '…' : title; }
  return titleOf(readablePreview(text, Math.max(max * 3, 360)), max) || 'Untitled thought';
};
const label = { action_candidate: 'Possible action', explicit_commitment: 'Stated intent', delegation: 'Delegation', waiting_on: 'Waiting on', question: 'Question', idea: 'Idea', decision: 'Decision', constraint: 'Rule or limit', event_or_fact: 'Note', reference: 'Reference', reflection: 'Reflection', unclear: 'Unsorted' };
let peopleUI, archiveUI, revisionsUI, personSelection = null;
let efOn = true;
try { efOn = localStorage.getItem('effort-display-ef') !== 'off'; } catch {}
function setEF(on) { efOn = !!on; try { localStorage.setItem('effort-display-ef', efOn ? 'on' : 'off'); } catch {} renderCapturePreview(); archiveUI?.modeChanged(); }
function renderCapturePreview() {
  const host = $('capture-preview'); if (!host) return;
  $('capture-ef').textContent = efOn ? 'EF ON' : 'EF OFF'; $('capture-ef').setAttribute('aria-pressed', String(efOn));
  const text = value('capture-text');
  try { host.replaceChildren(text ? efOn ? organized({id:'draft',text}, false) : element('pre', text, 'raw') : element('p', 'Organization appears as you write. Saving keeps the exact original.', 'small')); }
  catch { host.replaceChildren(element('p', 'Organization is unavailable. You can still save the original.', 'small'), element('pre', text, 'raw')); }
}
let store, state, activeSpan = null, threadId = null, replyTarget = null, currentView = 'home', sourceId, rawView = true, epoch = 0, saving = false, storageHealthy = true, booting = true, refreshing = Promise.resolve();
let shelf, workspaceEpoch, fenced = false, resetting = false;
let artifactTarget = null, artifactEpoch, artifactSaving = false, artifactSelection = null, artifactFocusPending = false;
let navigationVersion = 0, explorationNavigation = 0, explorationRoute = 'home';
let explorationDraft = null, distillationDraft = null, explorationSaving = false, distillationSaving = false, explorationLoading = false, distillationLoading = false;
let moveEditing = null, moveEpoch, moveSaving = false, moveLoading = false, branchEditing = null, branchEpoch, branchSaving = false, branchLoading = false;
let branchSelection = null, branchFocusPending = false;
const proposalPending = new Set(), revisionPreparationPending = new Set();
const revisionPreparationKey = (id,hash) => `${id}:${hash}`;
let threadOpeningPending = false, openingViewToken = 0, renderedOpening = null;
const openingPending = new Map(), openingErrors = new Map();
const shadows = new Map(), versions = new Map(), adopted = new Set(), completed = new Map(), volatileReplies = new Map();
const value = id => shadows.has(id) ? shadows.get(id) : $(id).value;
function setValue(id, text) { $(id).value = text; shadows.set(id, text); if (id === 'capture-text') renderCapturePreview(); }
function edited(id) { shadows.delete(id); }
function status(id, text) { if ($(id)) $(id).textContent = text; }
async function saveDraft(context, body, target, explicit = false) {
  if (resetting) return;
  if (!shelf) { status(target, 'Draft is only in this window. Copy it before leaving.'); return; }
  const generation = (versions.get(context) ?? 0) + 1; versions.set(context, generation);
  if (fenced && !adopted.has(context)) {
    if (!explicit) { status(target, 'Workspace changed. Your writing remains here. Type or save to keep it in the new workspace.'); return; }
    try { await shelf.load(context); adopted.add(context); if (versions.get(context) !== generation) return; } catch (e) { status(target, `${e.message} Copy your writing before leaving.`); return; }
  }
  if (explicit && context.startsWith('reply:')) volatileReplies.delete(context.slice(6));
  status(target, 'Keeping draft…');
  try { await shelf.save(context, body); if (versions.get(context) === generation) status(target, 'Draft kept in this browser.'); }
  catch (e) { status(target, `${e.message} Copy your writing before leaving.`); }
}
async function loadContext(context) {
  if (!shelf) return null;
  let record = await shelf.load(context);
  if (!record && shelf.migrateLegacy) record = await shelf.migrateLegacy(context);
  return record;
}
async function clearDraft(context, body) { if (!shelf || (fenced && !adopted.has(context))) throw Error("Draft remains in this window after the workspace changed."); await shelf.clear(context, body); }
const captureBody = () => ({ text: value('capture-text'), span: $('capture-span').value });
const replyBody = () => ({ text: value('reply-text'), parentId: replyTarget });
function requestId(context, body) { const key = `${KEY}-request-${context}`; const raw = JSON.stringify(body); try { const old = JSON.parse(sessionStorage.getItem(key) || 'null'); if (old?.body === raw) return old.id; const id = crypto.randomUUID(); sessionStorage.setItem(key, JSON.stringify({body: raw, id})); return id; } catch { const old = requestIds.get(key); if (old?.body === raw) return old.id; const id = crypto.randomUUID(); requestIds.set(key, {body: raw, id}); return id; } }
const requestIds = new Map();
function releaseRequest(context) { const key = `${KEY}-request-${context}`; requestIds.delete(key); try { sessionStorage.removeItem(key); } catch {} }
const DRAFT = `${KEY}-draft`;
function notice(text, error = false) { $('notice').textContent = text; $('notice').classList.toggle('error', error); $('notice').hidden = false; }
function fail(error) { notice(error.message || 'That did not finish. Your original text has not been removed.', true); }
function formatDate(date) { return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(date)); }
function showView(route, focus = true) {
  navigationVersion++;
  const [base, encoded] = route.split('/');
  personSelection = base === 'person' ? encoded : null;
  artifactSelection = base === 'artifact' ? encoded : null; artifactFocusPending = !!artifactSelection;
  branchSelection = base === 'branch' ? encoded : null; branchFocusPending = !!branchSelection;
  const selectedBranch = branchSelection && state?.explorations?.find(b => b.id === branchSelection), branchSource = selectedBranch && state?.captures.find(c => c.id === selectedBranch.sourceId);
  const selectedFile = artifactSelection && state?.artifacts?.find(a => a.id === artifactSelection), fileSource = selectedFile && state?.captures.find(c => c.id === selectedFile.captureId);
  currentView = base === 'person' ? 'spans' : base === 'branch' ? (branchSource ? 'thread' : 'spans') : base === 'artifact' ? (fileSource ? 'thread' : 'spans') : base === 'span' ? 'spans' : ['home', 'spans', 'thread', 'fort', 'engine'].includes(base) ? base : 'home';
  try { activeSpan = base === 'person' ? spanKey('People') : (base === 'artifact' && !fileSource || base === 'branch' && !branchSource) ? spanKey('Workspace') : base === 'span' ? decodeURIComponent(encoded ?? '') : null; } catch { activeSpan = null; }
  const nextThread = base === 'branch' && branchSource ? branchSource.id : base === 'artifact' && fileSource ? fileSource.id : base === 'thread' ? encoded : null;
  if (threadId !== nextThread) { renderedOpening = null; openingViewToken++; threadOpeningPending = !!nextThread; if (fenced && !adopted.has(`reply:${threadId}`)) volatileReplies.set(threadId, replyBody()); else persistReplyDraft(); threadId = nextThread; replyTarget = null; loadReplyDraft(); }
  for (const name of ['home', 'spans', 'thread', 'fort', 'engine']) $(`view-${name}`).hidden = name !== currentView;
  document.querySelectorAll('.rail [data-view]').forEach(button => {
    if (button.dataset.view === (currentView === 'thread' ? 'spans' : currentView)) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
  if (location.hash !== `#${route}`) history.pushState(null, '', `#${route}`);
  if (state) { renderSpans(); renderThread(); if (currentView === 'fort') archiveUI?.enter(base === 'fort' ? encoded ?? null : null); }
  if (focus) { $('main').focus(); scrollTo(0, 0); }
  focusArtifact(); focusBranch(); if (personSelection) peopleUI?.focus(personSelection);
  if (base === 'branch' && !selectedBranch) notice('This branch is unavailable in the active workspace. Its raw copy may be in Engine Room recovery or a backup.', true);
  if (base === 'artifact' && !selectedFile) notice('This file is unavailable in the active workspace. Check Engine Room recovery or a backup.', true);
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
function updateExplorationControls() {
  $('now-explore').disabled = explorationSaving || explorationLoading || resetting;
  for (const button of document.querySelectorAll('[data-open-exploration]')) button.disabled = explorationSaving || explorationLoading || resetting;
  for (const button of document.querySelectorAll('[data-open-distillation]')) button.disabled = distillationSaving || distillationLoading || resetting;
}
function render() {
  const now = state.now;
  $('now-title').textContent = now ? readablePreview(now.quote, 4000) : 'Nothing chosen. Room to think.';
  $('now-origin').textContent = now ? now.origin === 'sample' ? 'Sample choice' : 'Chosen here' : 'No next step';
  $('now-reason').textContent = now ? 'One chosen detail. Capturing or exploring something else leaves it here.' : 'Capture freely. A thought only becomes your next step when you choose it.';
  $('now-done').hidden = $('now-original').hidden = $('hold-open').hidden = $('now-explore').hidden = !now;
  renderReturnPoint(); updateExplorationControls();
  $('recent').replaceChildren(...state.captures.filter(c => !parentOf(c)).slice(-2).reverse().map(entryCard));
  if (!state.captures.length) $('recent').append(element('p', 'Nothing here yet. Capture a fictional thought to try the loop.', 'empty'));
  $('storage-count').textContent = `${state.captures.length} saved original${state.captures.length === 1 ? '' : 's'}`;
  const selected = $('capture-span').value;
  $('capture-span').replaceChildren(...(state.spans ?? []).map(span => { const option = element('option', span.name); option.value = span.name; return option; }));
  if ([...$('capture-span').options].some(o => o.value === selected)) $('capture-span').value = selected;
  else $('capture-span').value = 'Unsorted';
  renderSpans(); renderThread(); archiveUI?.update(); revisionsUI?.update();
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
function openingState() { return deriveOpened({ openedReceipts: state.openedReceipts ?? [], captures: state.captures, recovery: state.recovery ?? [] }); }
function openingSummary(captures, reading) {
  if (state.openedWarning) return 'Opening status unavailable';
  const unknown = captures.filter(c => reading.unknown.has(c.id)).length, fresh = captures.filter(c => !reading.opened.has(c.id) && !reading.unknown.has(c.id)).length;
  return [fresh ? `${fresh} not opened here` : 'Writing opened here', unknown ? `${unknown} opening status needs recovery` : ''].filter(Boolean).join(' · ');
}
async function recordOpened(rootId, items) {
  if (openingPending.has(rootId) || !items.length || resetting) return;
  const generation = epoch, expectedEpoch = workspaceEpoch, operation = {}; openingPending.set(rootId, operation); openingErrors.delete(rootId);
  try { await store.markOpened({ items }, { expectedEpoch }); if (generation !== epoch || workspaceEpoch !== expectedEpoch) return; await refreshed(); }
  catch (error) { if (generation === epoch && workspaceEpoch === expectedEpoch) openingErrors.set(rootId, `Opening status wasn't saved: ${error.message} Your writing and NOW are unchanged.`); }
  finally { if (openingPending.get(rootId) === operation) openingPending.delete(rootId); if (generation === epoch && workspaceEpoch === expectedEpoch && state) { refreshOpeningSummaries(); refreshOpeningContext(); } }
}
function openingBadge(capture, reading) { return state.openedWarning || reading.opened.has(capture.id) ? null : reading.unknown.has(capture.id) ? 'Opening status needs recovery' : 'Not opened in this view yet'; }
function refreshOpeningSummaries() {
  const reading = openingState(), byId = new Map(state.captures.map(c => [c.id, c]));
  for (const node of document.querySelectorAll('[data-opening-span], [data-opening-thread]')) { const captures = state.captures.filter(c => node.dataset.openingSpan ? spanKey(c.span) === node.dataset.openingSpan : threadRoot(c, byId)?.id === node.dataset.openingThread); node.textContent = openingSummary(captures, reading); }
  const span = (state.spans ?? []).find(s => s.id === activeSpan); if (span) $('span-description').textContent = descriptions[span.kind] + (state.openedWarning ? ` ${state.openedWarning}` : '');
}
function refreshOpeningContext() {
  if (currentView !== 'thread' || replyLoading || !renderedOpening || renderedOpening.destination !== threadId) return;
  const captures = renderedOpening.ids.map(id => state.captures.find(c => c.id === id)), root = captures[0]; if (!root || captures.some(c => !c)) return;
  const reading = openingState();
  for (const capture of captures.slice(1)) { const card = $(`reply-${capture.id}`); if (!card) continue; const previous = card.querySelector('.unopened-badge'), text = openingBadge(capture, reading); if (!text) previous?.remove(); else if (previous) previous.textContent = text; else card.append(element('p', text, 'small unopened-badge')); }
  renderOpeningContext(root, captures);
}
const writingState = ({ openedReceipts, openedWarning, sourceRevisions, revisionWarning, recovery = [], ...rest }) => JSON.stringify({...rest,recovery:recovery.filter(row=>row.source!=='sourceRevisions')});
function renderOpeningContext(root, captures) {
  const reading = openingState(), missing = captures.filter(c => !reading.opened.has(c.id)), panel = $('thread-opening'); panel.replaceChildren();
  panel.append(element('p', state.openedWarning || openingErrors.get(root.id) || openingSummary(captures, reading), 'small opening-status'));
  panel.append(element('p', 'Opening records the exact writing displayed here, not whether you read or agree with it. New replies stay separate. NOW is unchanged.', 'small muted'));
  const toMark = missing.length ? missing : openingErrors.has(root.id) ? captures : [];
  if (toMark.length || state.openedWarning) { const mark = element('button', openingPending.has(root.id) ? 'Keeping opening status…' : 'Mark displayed writing opened', 'text-button'); mark.id = 'mark-opened'; mark.disabled = openingPending.has(root.id) || !!state.openedWarning; mark.onclick = () => recordOpened(root.id, toMark.map(c => ({ id: c.id, hash: c.hash }))); panel.append(mark); }
  if (threadOpeningPending && !booting && !state.openedWarning && !document.hidden) {
    threadOpeningPending = false; const token = openingViewToken, destination = threadId, expectedEpoch = workspaceEpoch, items = missing.map(c => ({ id: c.id, hash: c.hash }));
    requestAnimationFrame(() => { if (token !== openingViewToken || currentView !== 'thread' || threadId !== destination || workspaceEpoch !== expectedEpoch) return; if (document.hidden) { threadOpeningPending = true; return; } recordOpened(root.id, items); });
  }
}
function renderSpans() {
  const span = (state.spans ?? []).find(s => s.id === activeSpan);
  $('span-directory').hidden = !!span; $('span-feed').hidden = !span;
  $('directory-title').textContent = span?.name ?? 'Attention Spans.';
  $('directory-intro').textContent = span ? 'An Attention Span. Its posts stay in time order, with the conversation attached.' : 'Named places for thoughts, conversations and things worth returning to.';
  const reading = openingState();
  const query = $('span-search').value.trim().toLowerCase();
  const directory = (state.spans ?? []).filter(s => !query || s.name.toLowerCase().includes(query) || state.captures.some(c => spanKey(c.span) === s.id && c.text.toLowerCase().includes(query)));
  $('span-list').replaceChildren(...directory.map(s => {
    const posts = roots().filter(c => spanKey(c.span) === s.id), all = state.captures.filter(c => spanKey(c.span) === s.id), latest = all.at(-1);
    const card = element('article', undefined, 'span-card'); const link = element('a', s.name, 'span-title'); link.href = `#span/${encodeURIComponent(s.id)}`;
    card.append(element('span', s.kind === 'journal' ? 'ATTENTION SPAN' : s.kind.toUpperCase(), 'eyebrow'), element('h2'));
    card.querySelector('h2').append(link); card.append(element('p', descriptions[s.kind], 'small'));
    card.append(element('p', `${posts.length} post${posts.length === 1 ? '' : 's'} · ${all.length - posts.length} repl${all.length - posts.length === 1 ? 'y' : 'ies'}${latest ? ` · ${formatDate(latest.createdAt)}` : ' · Ready when you are'}`, 'small'));
    if (all.length) { const summary = element('p', openingSummary(all, reading), 'small opening-summary'); summary.dataset.openingSpan = s.id; card.append(summary); }
    if (latest) card.append(element('p', displayTitle(latest.text, 110), 'span-preview'));
    return card;
  }));
  if (!directory.length) $('span-list').append(element('p', 'No Attention Spans match. Try another name or a phrase from a post.', 'empty'));
  if (!span) return;
  $('span-description').textContent = descriptions[span.kind] + (state.openedWarning ? ` ${state.openedWarning}` : '');
  renderSpanDepth(span);
  const posts = roots().filter(c => spanKey(c.span) === span.id).slice().reverse();
  const byId = new Map(state.captures.map(c => [c.id, c])), counts = new Map();
  for (const c of state.captures) { const root = threadRoot(c, byId); if (root && root.id !== c.id) counts.set(root.id, (counts.get(root.id) ?? 0) + 1); }
  $('span-entries').replaceChildren(...posts.map(capture => {
    const group = element('article', undefined, 'journal-post'); const heading = element('div', undefined, 'entry-heading');
    heading.append(element('span', `${formatDate(capture.createdAt)} · ${capture.sample ? 'FICTIONAL EXAMPLE' : 'DEMO POST'}`, 'eyebrow'));
    group.append(heading, element('h2', displayTitle(capture.text, 90)), element('p', readablePreview(capture.text, 360), 'post-excerpt'));
    const related = state.captures.filter(c => threadRoot(c, byId)?.id === capture.id), summary = element('p', openingSummary(related, reading), 'small opening-summary'); summary.dataset.openingThread = capture.id; group.append(summary);
    const replyCount = counts.get(capture.id) ?? 0;
    const actions = element('div', undefined, 'post-actions'); const open = element('button', `Open thread · ${replyCount} repl${replyCount === 1 ? 'y' : 'ies'}`, 'text-button'); open.onclick = () => openThread(capture.id);
    const original = element('button', 'See original ↗', 'text-button'); original.onclick = () => openSource(capture.id, true);
    actions.append(open, original); group.append(actions); return group;
  }));
  if (!posts.length) $('span-entries').append(element('p', 'No posts yet. Capture something here without turning it into a task.', 'empty'));
}
function renderThread() {
  if (currentView !== 'thread') return;
  if (replyLoading) { $('thread-post').replaceChildren(); return; }
  const requested = state.captures.find(c => c.id === threadId), root = requested && threadRoot(requested, state.captures);
  const main = $('thread-post'); main.replaceChildren();
  $('thread-permalink').hidden = $('reply-to-root').hidden = !root;
  if (!root) { renderedOpening = null; $('thread-opening').replaceChildren(); $('thread-explorations').replaceChildren(); $('back-feed').onclick = () => showView('spans'); main.append(element('h1', 'This thought isn’t here.'), element('p', 'Its link may belong to another browser workspace or a record in Engine Room recovery.')); $('thread-replies').replaceChildren(); $('reply-form').hidden = false; $('reply-target').textContent = 'This thread is missing. Your draft remains here; recover the thread or copy the text before choosing another destination.'; $('save-reply').disabled = true; return; }
  $('reply-form').hidden = false; $('thread-permalink').href = `#thread/${root.id}`;
  $('back-feed').onclick = () => openSpan(spanKey(root.span));
  main.append(element('span', `${root.span} · ${formatDate(root.createdAt)} · ${root.sample ? 'FICTIONAL EXAMPLE' : 'DEMO POST'}`, 'eyebrow'), element('h1', displayTitle(root.text, 110)));
  if (parentOf(root)) main.append(element('p', 'The parent original needs recovery. This reply and its own replies are preserved here.', 'notice'));
  const display = element('details', undefined, 'original-disclosure'); display.append(element('summary', 'Read the exact original'), element('pre', root.text, 'raw'), element('p', `Original verified · SHA-256 ${root.hash}`, 'small'));
  const download = element('button', 'Download original text', 'text-button'); download.onclick = () => downloadText(root.text, `effort-original-${root.id}.txt`, 'text/plain'); display.append(download);
  main.append(renderReading(root.text, { titleAlreadyShown: displayTitle(root.text, 110) }), display, revisionsUI.disclosure(root.id));
  const rootProvenance = proposalProvenance(root); if (rootProvenance) main.append(rootProvenance);
  const rootFiles = attachedFiles(root); if (rootFiles) main.append(rootFiles);
  const grouping = element('details', undefined, 'organized-disclosure'); grouping.append(element('summary', 'See organized details'), organized(root, false)); main.append(grouping);
  const actions = element('div', undefined, 'post-actions');
  const choose = element('button', 'Choose a next step…', 'quiet'); choose.onclick = () => openSource(root.id, false);
  const reply = element('button', 'Reply', 'quiet'); reply.onclick = () => targetReply(root.id);
  const hold = element('button', 'Hold my place…', 'text-button'); hold.onclick = openHold;
  const explore = element('button', 'Explore safely…', 'text-button'); explore.dataset.openExploration = 'true'; explore.disabled = explorationSaving || explorationLoading || resetting; explore.onclick = () => openExplore(root.id);
  actions.append(reply, choose, hold, explore, attachButton(root)); main.append(actions);
  const children = new Map();
  for (const capture of state.captures) if (parentOf(capture)) { const list = children.get(capture.parentId) ?? []; list.push(capture); children.set(capture.parentId, list); }
  const rows = [], visited = new Set([root.id]);
  function collect(id, depth) { for (const c of children.get(id) ?? []) { if (visited.has(c.id)) continue; visited.add(c.id); rows.push({ capture: c, depth }); collect(c.id, depth + 1); } }
  collect(root.id, 0);
  $('replies-heading').textContent = `${rows.length} repl${rows.length === 1 ? 'y' : 'ies'}`;
  const reading = openingState();
  $('thread-replies').replaceChildren(...rows.map(({ capture, depth }) => {
    const card = element('article', undefined, `thread-reply depth-${Math.min(depth, 3)}`); card.id = `reply-${capture.id}`;
    card.append(element('p', `You · ${formatDate(capture.createdAt)} · Reply${depth ? ` at depth ${depth + 1}` : ''}`, 'small'), renderReading(capture.text, { headingBase: 3 }));
    const badge = openingBadge(capture, reading); if (badge) card.append(element('p', badge, 'small unopened-badge'));
    const provenance = proposalProvenance(capture); if (provenance) card.append(provenance);
    const files = attachedFiles(capture); if (files) card.append(files);
    const actions = element('div', undefined, 'post-actions'); const button = element('button', 'Reply to this', 'text-button'); button.onclick = () => targetReply(capture.id);
    const source = element('button', 'Original ↗', 'text-button'); source.onclick = () => openSource(capture.id, true);
    const permalink = element('a', 'Permalink', 'small'); permalink.href = `#thread/${capture.id}`;
    actions.append(button, source, permalink, attachButton(capture)); card.append(actions); if (capture.id === threadId) card.classList.add('selected-reply'); return card;
  }));
  if (!rows.length) $('thread-replies').append(element('p', 'Room for the next thought. Replies will stay attached to this post.', 'muted'));
  if (!replyTarget && !value('reply-text')) replyTarget = root.id;
  const target = state.captures.find(c => c.id === replyTarget);
  const validTarget = target && threadRoot(target, state.captures)?.id === root.id;
  $('reply-target').textContent = validTarget ? `Replying to: ${displayTitle(target.text, 100)}` : 'Choose a reply target before saving. Your draft is still here.';
  $('reply-to-root').onclick = () => targetReply(root.id);
  renderedOpening = { destination: threadId, ids: [root.id, ...rows.map(row => row.capture.id)] };
  renderExplorations(root); renderOpeningContext(root, [root, ...rows.map(row => row.capture)]); focusArtifact(); focusBranch();
}
function renderExplorations(root) {
  const host = $('thread-explorations'); host.replaceChildren();
  const branches = (state.explorations ?? []).filter(b => threadRoot(state.captures.find(c => c.id === b.sourceId), state.captures)?.id === root.id);
  if (!branches.length) return;
  host.append(element('h2', 'Room to wander, with a way back.'), element('p', 'Branches and distillations are your own writing. Keeping them creates no obligation.', 'muted'));
  if (state.thinkingWarning) host.append(element('p', state.thinkingWarning, 'notice'));
  const hiddenBranches = element('details', undefined, 'set-aside-branches'), hiddenCount = branches.filter(b => ['parked', 'discarded'].includes(branchInfo(b).status)).length; hiddenBranches.open = branches.some(b => b.id === branchSelection && ['parked', 'discarded'].includes(branchInfo(b).status)); hiddenBranches.append(element('summary', `Set aside, with history kept (${hiddenCount})`));
  const byId = new Map(branches.map(b => [b.id, b]));
  for (const branch of branches.slice().sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))) {
    const card = element('article', undefined, 'panel exploration-card'); card.id = `branch-${branch.id}`; card.dataset.branchId = branch.id; card.tabIndex = -1; if (branch.id === branchSelection) card.classList.add('selected-branch');
    card.append(element('span', `${branch.dial} · YOUR EXPLORATION`, 'eyebrow'), element('h3', displayTitle(branch.text, 100)), renderReading(branch.text, { headingBase: 3 }));
    const parent = byId.get(branch.parentId), lineage = element('p', parent ? 'Branched from: ' : 'From the original thought. ', 'small');
    if (parent) { const link = element('a', displayTitle(parent.text, 90)); link.href = `#branch/${parent.id}`; link.onclick = event => { if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return; event.preventDefault(); showView(`branch/${parent.id}`); }; lineage.append(link); }
    card.append(lineage, element('p', `${formatDate(branch.at)} · Exact writing verified`, 'small')); branchThinking(card, branch);
    const raw = element('details', undefined, 'original-disclosure'); raw.append(element('summary', 'Read exact branch writing'), element('pre', branch.text, 'raw'));
    const download = element('button', 'Download branch text', 'text-button'); download.onclick = () => downloadText(branch.text, `effort-branch-${branch.id}.txt`, 'text/plain'); raw.append(download); card.append(raw);
    const actions = element('div', undefined, 'post-actions');
    const fork = element('button', 'Branch from here…', 'quiet'); fork.dataset.openExploration = 'true'; fork.disabled = explorationSaving || explorationLoading || resetting; fork.onclick = () => openExplore(branch.sourceId, branch);
    const distill = element('button', 'Distill…', 'quiet'); distill.dataset.openDistillation = 'true'; distill.disabled = distillationSaving || distillationLoading || resetting; distill.onclick = () => openDistill(branch);
    const returnPoint = state.places.find(p => p.id === branch.returnPointId);
    const back = element('button', 'Return to where I was', 'text-button'); back.disabled = !returnPoint; back.onclick = () => resumeSavedPlace(returnPoint, back);
    const original = element('button', 'See original ↗', 'text-button'); original.onclick = () => openSource(branch.sourceId, true);
    actions.append(fork, distill, back, original); card.append(actions);
    for (const item of (state.distillations ?? []).filter(d => d.explorationId === branch.id).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))) {
      const kept = element('section', undefined, 'distillation-card'); kept.append(element('span', `${item.type} · YOUR INTERPRETATION`, 'eyebrow'), renderReading(item.text, { headingBase: 4 }));
      const raw = element('details', undefined, 'original-disclosure'); raw.append(element('summary', 'Read exact distillation writing'), element('pre', item.text, 'raw'));
      const download = element('button', 'Download distillation text', 'text-button'); download.onclick = () => downloadText(item.text, `effort-distillation-${item.id}.txt`, 'text/plain'); raw.append(download); kept.append(raw);
      if (branch.dial === 'UNHINGED SANDBOX') kept.append(element('p', 'Kept in the sandbox. To consider action, branch with another dial first. Nothing has become a task.', 'small'));
      else {
        const consider = element('button', proposalPending.has(item.id) ? 'Preparing proposal…' : 'Consider as a next step…', 'quiet'); consider.disabled = proposalPending.has(item.id); consider.onclick = () => considerProposal(item.id); kept.append(consider);
        const promote = element('button', 'Choose from original…', 'text-button'); promote.onclick = () => { openSource(branch.sourceId, false); notice('Review the exact original, then choose a next step explicitly. This distillation hasn’t committed anything.'); }; kept.append(promote); }
      card.append(kept);
    }
    (['parked', 'discarded'].includes(branchInfo(branch).status) ? hiddenBranches : host).append(card);
  }
  if (hiddenCount) host.append(hiddenBranches); focusBranch();
}
const branchLabels = { active: 'Open exploration', parked: 'Set aside', distilled: 'Distilled', discarded: 'Let go, history kept', weird_but_alive: 'Weird but alive' };
const thinkingMoves = () => deriveMoves(state.moveEvents ?? [], state.recovery ?? []);
function branchInfo(branch) {
  if (state.thinkingWarning) return { branchId: branch.id, status: null, note: '', evidence: false, latestId: null, history: [], recovery: true };
  return deriveBranchStatuses(state.branchEvents ?? [], state.recovery ?? []).find(row => row.branchId === branch.id) ?? { branchId: branch.id, status: 'active', note: '', evidence: false, latestId: null, history: [], implicit: true };
}
function sessionRoot(branch) { const map = new Map((state.explorations ?? []).map(row => [row.id, row])), seen = new Set(); let root = branch; while (root.parentId && map.has(root.parentId) && !seen.has(root.id)) { seen.add(root.id); root = map.get(root.parentId); } return root; }
function branchLink(branch, text = displayTitle(branch.text, 90)) { const link = element('a', text, 'small'); link.href = `#branch/${branch.id}`; link.onclick = event => { if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return; event.preventDefault(); showView(`branch/${branch.id}`); }; return link; }
function focusBranch() {
  if (!branchFocusPending || !branchSelection) return;
  requestAnimationFrame(() => { if (!branchFocusPending || !branchSelection) return; const card = [...$('view-thread').querySelectorAll('[data-branch-id]')].find(e => e.dataset.branchId === branchSelection); if (!card) return; branchFocusPending = false; card.focus({ preventScroll: true }); card.scrollIntoView({ block: 'center' }); });
}
function branchPromotion(branch) {
  const distillations = new Set((state.distillations ?? []).filter(d => d.explorationId === branch.id).map(d => d.id)), proposals = new Set(state.captures.filter(c => distillations.has(c.derivedFromId)).map(c => c.id));
  return commitments().filter(c => proposals.has(c.choice.captureId));
}
function branchThinking(card, branch) {
  const info = branchInfo(branch), status = info.recovery ? 'Status needs recovery' : info.implicit ? 'Saved exploration' : branchLabels[info.status];
  card.append(element('p', status, 'branch-status badge'));
  const root = sessionRoot(branch), session = element('p', undefined, 'small'); session.append(root.id === branch.id ? document.createTextNode('Session root · Return point kept') : document.createTextNode('Session: ')); if (root.id !== branch.id) session.append(branchLink(root)); card.append(session);
  if (branch.move) {
    const saved = element('details', undefined, 'saved-move'); const trust = validMoveSnapshot(branch.move, state.moveEvents ?? [], state.recovery ?? []);
    saved.append(element('summary', `Thinking move: ${branch.move.name}`), element('pre', branch.move.prompt, 'raw'), element('p', trust === 'verified' && !state.thinkingWarning ? 'Exact prompt saved with this branch. Later edits don’t rewrite it.' : 'Saved prompt preserved. Its definition history needs recovery.', 'small')); card.append(saved);
  }
  if (info.note) card.append(element('p', info.note, 'branch-note reply-body'));
  if (info.evidence && !info.recovery) card.append(element('p', 'You explicitly kept this branch as move evidence. This isn’t a success score.', 'small branch-evidence'));
  const promotions = branchPromotion(branch);
  if (promotions.length) { const proof = element('details', undefined, 'branch-promotion'); proof.append(element('summary', 'Used for a chosen step'), element('p', 'These source-linked choices came from a proposal. Branch status alone never creates work.', 'small')); for (const c of promotions) proof.append(element('p', `${c.choice.quote} · ${c.state}`, 'small'), sourceButton(c.choice)); card.append(proof); }
  const history = element('details', undefined, 'branch-history'); history.append(element('summary', 'Status history'));
  if (!info.history.length) history.append(element('p', info.recovery ? 'Raw history is preserved in Engine Room recovery.' : 'No status choice yet. Saving the thought didn’t create an obligation.', 'small'));
  for (const row of info.history) history.append(element('p', `${formatDate(row.at)} · ${branchLabels[row.status]}${row.evidence ? ' · Kept as move evidence' : ''}`, 'small'), element('p', row.note || 'No extra note.', 'reply-body'));
  card.append(history);
  const actions = element('div', undefined, 'post-actions'), edit = element('button', 'Update branch status…', 'text-button'); edit.disabled = !!state.thinkingWarning || branchSaving; edit.onclick = () => openBranchStatus(branch); actions.append(edit, branchLink(branch, 'Branch permalink')); card.append(actions);
}
function renderMoves(body) {
  body.append(element('h2', 'Thinking moves'), element('p', 'Optional tools for your own thinking. They’re editable, and you can turn any of them off. They aren’t a personality profile.', 'muted'), element('p', 'Open a thought, choose Explore safely…, then select a move. Each branch keeps its original prompt. Examples below come only from branches you explicitly keep as evidence.', 'small'));
  if (state.thinkingWarning) { body.append(element('p', state.thinkingWarning, 'notice')); return; }
  const add = element('button', '+ Add a thinking move', 'quiet'); add.disabled = moveSaving; add.onclick = () => openMoveEditor(); body.append(add);
  for (const move of thinkingMoves().slice().sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))) {
    const card = element('article', undefined, 'panel move-card'); card.dataset.moveId = move.id;
    card.append(element('h3', move.name), element('p', move.recovery ? 'Definition needs recovery. It isn’t offered for new use.' : move.enabled ? 'Available when you choose it.' : 'Turned off for new explorations. Saved examples remain.', 'small'), element('p', move.prompt || 'The saved definition is preserved in Engine Room recovery.', 'reply-body'));
    const edit = element('button', move.recovery ? 'Recreate definition…' : 'Edit or turn off…', 'text-button'); edit.disabled = moveSaving; edit.onclick = () => openMoveEditor(move); card.append(edit);
    const examples = (state.explorations ?? []).filter(branch => branch.move?.id === move.id && branchInfo(branch).evidence && !branchInfo(branch).recovery);
    const evidence = element('details', undefined, 'move-evidence'); evidence.append(element('summary', `Examples you kept (${examples.length})`)); if (!examples.length) evidence.append(element('p', 'No examples tagged yet. Choosing a move or distilling a branch doesn’t automatically make it evidence.', 'small'));
    for (const branch of examples) { const row = element('p'); row.append(branchLink(branch)); evidence.append(row); } card.append(evidence);
    const history = element('details', undefined, 'move-history'); history.append(element('summary', `Saved revisions (${move.history.length})`));
    for (const row of move.history.slice(-10)) history.append(element('p', `${formatDate(row.at)} · ${row.name} · ${row.enabled ? 'Offered' : 'Turned off'}`, 'small'), element('pre', row.prompt, 'raw'));
    if (!move.history.length) history.append(element('p', move.recovery ? 'Prior definitions are preserved as raw recovery records.' : 'A suggested tool from EFFORT’s existing move library. It hasn’t been edited here.', 'small'));
    if (move.history.length > 10) history.append(element('p', 'Latest ten revisions shown. The full history is downloadable and included in the workspace backup.', 'small'));
    if (move.history.length) { const download = element('button', 'Download move history', 'text-button'); download.onclick = () => downloadText(JSON.stringify(move.history, null, 2), `effort-move-${move.id}-history.json`); history.append(download); } card.append(history); body.append(card);
  }
}
function populateMovePicker() {
  const selected = explorationDraft?.move ?? null, options = [element('option', 'No move selected')]; options[0].value = '';
  if (!state.thinkingWarning) for (const move of thinkingMoves().filter(m => m.enabled && !m.recovery)) { const option = element('option', move.name); option.value = move.id; options.push(option); }
  if (selected && !options.some(option => option.value === selected.id)) { const saved = element('option', `${selected.name} (saved prompt)`); saved.value = selected.id; options.push(saved); }
  $('explore-move').replaceChildren(...options); $('explore-move').value = selected?.id ?? '';
  $('explore-move-prompt').hidden = !selected; $('explore-move-prompt').textContent = selected?.prompt ?? '';
  $('explore-move-note').textContent = state.thinkingWarning ? 'Move history is unavailable. You can choose No move to keep writing without it.' : selected ? 'This exact prompt will stay with your branch. No model runs.' : 'Start with what you’re noticing. A move is optional.';
}
$('explore-current-place').onclick = async () => {
  if (!explorationDraft || explorationDraft.parentId || explorationSaving || explorationLoading) return;
  try { await refreshed(); if (!explorationDraft || explorationDraft.parentId) return; const source = state.captures.find(c => c.id === explorationDraft.sourceId); if (!source) throw Error('The source needs recovery. Your writing remains here.'); explorationDraft.returnPointId = null; explorationDraft.returnData = { route: routeFromHash(), context: { scrollY, spanSearch: $('span-search').value, sourceExpanded: document.querySelector('#thread-post .original-disclosure')?.open ?? false }, expected: structuredClone(state.now), summary: displayTitle(source.text, 300) }; releaseRequest(`explore:${source.id}:return`); await saveDraft(`explore:${source.id}`, exploreBody(), 'explore-error', true); status('explore-error', 'Your wording is kept. The return point will use the chosen work and view you have now. NOW is unchanged.'); } catch (error) { status('explore-error', error.message); }
};
$('explore-move').onchange = () => {
  if (!explorationDraft || explorationSaving) return;
  try { const id = $('explore-move').value; explorationDraft.move = id ? moveSnapshot(id, state.moveEvents ?? [], state.recovery ?? []) : null; populateMovePicker(); saveDraft(`explore:${explorationDraft.sourceId}`, exploreBody(), 'explore-error', true); }
  catch (error) { status('explore-error', error.message); populateMovePicker(); }
};
const moveContext = () => moveEditing?.id ? `move:${moveEditing.id}` : 'move';
const moveBody = () => ({ moveId: moveEditing?.id ?? null, name: value('move-name'), prompt: value('move-prompt'), enabled: $('move-enabled').checked, expectedLatestId: moveEditing?.expectedLatestId ?? null });
const branchBody = () => ({ branchId: branchEditing?.id ?? null, status: $('branch-status').value, note: value('branch-note'), evidence: $('branch-evidence').checked, expectedLatestId: branchEditing?.expectedLatestId ?? null });
async function openMoveEditor(move = null) {
  if (moveSaving || moveLoading || resetting) return; if (state.thinkingWarning) { notice(state.thinkingWarning, true); return; }
  moveLoading = true; moveEpoch = workspaceEpoch; moveEditing = { id: move?.id ?? null, expectedLatestId: move?.latestId ?? null };
  for (const id of ['move-name', 'move-prompt', 'move-enabled', 'save-move', 'move-base']) $(id).disabled = true;
  $('move-heading').textContent = move ? 'Edit a thinking move.' : 'Add your own thinking move.'; setValue('move-name', move?.name ?? ''); setValue('move-prompt', move?.prompt ?? ''); $('move-enabled').checked = move?.enabled ?? true; $('move-base').hidden = !move; $('move-current').textContent = move ? `${move.name}\n${move.enabled ? 'Offered' : 'Turned off'}\n\n${move.prompt}` : 'This is a new move.'; status('move-error', move?.recovery ? 'The seed prompt is shown if available. Prior edits stay in Engine Room recovery; saving creates a new definition.' : ''); $('move-dialog').showModal();
  try { const saved = await loadContext(moveContext()); if (saved && (saved.body.name || saved.body.prompt)) { setValue('move-name', saved.body.name); setValue('move-prompt', saved.body.prompt); $('move-enabled').checked = saved.body.enabled; moveEditing.expectedLatestId = saved.body.expectedLatestId; status('move-error', 'Your draft is restored with its original editing base.'); } } catch (error) { status('move-error', error.message); }
  moveLoading = false; for (const id of ['move-name', 'move-prompt', 'move-enabled', 'save-move', 'move-base']) $(id).disabled = false; $('move-name').focus();
}
async function openBranchStatus(branch) {
  if (branchSaving || branchLoading || resetting) return; if (state.thinkingWarning) { notice(state.thinkingWarning, true); return; }
  branchLoading = true; branchEpoch = workspaceEpoch; const info = branchInfo(branch); branchEditing = { id: branch.id, expectedLatestId: info.latestId };
  $('branch-source').textContent = displayTitle(branch.text, 200); setValue('branch-note', info.note); $('branch-evidence').checked = !!info.evidence; $('branch-evidence').disabled = true;
  $('branch-status').querySelector('[data-unknown]')?.remove(); if (!info.status) { const option = element('option', 'Choose a status'); option.value = ''; option.dataset.unknown = 'true'; $('branch-status').prepend(option); } $('branch-status').value = info.status ?? '';
  $('branch-current').textContent = `${info.recovery ? 'Prior status needs recovery.' : branchLabels[info.status]}\n${info.note}`; status('branch-error', '');
  for (const id of ['branch-status', 'branch-note', 'save-branch-status', 'branch-base']) $(id).disabled = true; $('branch-dialog').showModal();
  try { const saved = await loadContext(`branch:${branch.id}`); if (saved && (saved.body.status || saved.body.note || saved.body.evidence)) { $('branch-status').value = saved.body.status; setValue('branch-note', saved.body.note); $('branch-evidence').checked = saved.body.evidence; branchEditing.expectedLatestId = saved.body.expectedLatestId; status('branch-error', 'Your draft is restored with its original status base.'); } } catch (error) { status('branch-error', error.message); }
  branchLoading = false; $('branch-evidence').disabled = !branch.move; for (const id of ['branch-status', 'branch-note', 'save-branch-status', 'branch-base']) $(id).disabled = false; $('branch-note').focus();
}
for (const id of ['move-name', 'move-prompt']) $(id).oninput = () => { edited(id); if (moveEditing && !moveLoading) saveDraft(moveContext(), moveBody(), 'move-error', true); };
$('move-enabled').onchange = () => { if (moveEditing && !moveLoading) saveDraft(moveContext(), moveBody(), 'move-error', true); };
$('branch-note').oninput = () => { edited('branch-note'); if (branchEditing && !branchLoading) saveDraft(`branch:${branchEditing.id}`, branchBody(), 'branch-error', true); };
for (const id of ['branch-status', 'branch-evidence']) $(id).onchange = () => { if (branchEditing && !branchLoading) saveDraft(`branch:${branchEditing.id}`, branchBody(), 'branch-error', true); };
$('move-base').onclick = async () => {
  if (!moveEditing?.id || moveSaving || moveLoading) return;
  try { await refreshed(); if (workspaceEpoch !== moveEpoch || state.thinkingWarning) throw Error('The workspace changed or its history is unavailable. Close and reopen the current move; your writing remains here.'); const latest = thinkingMoves().find(m => m.id === moveEditing.id); if (!latest) throw Error('The move needs recovery. Your writing remains here.'); moveEditing.expectedLatestId = latest.latestId; $('move-current').textContent = `${latest.name}\n${latest.enabled ? 'Offered' : 'Turned off'}\n\n${latest.prompt}`; await saveDraft(moveContext(), moveBody(), 'move-error', true); status('move-error', 'Your wording is kept. Saving will add a new revision after the current one.'); } catch (error) { status('move-error', error.message); }
};
$('branch-base').onclick = async () => {
  if (!branchEditing || branchSaving || branchLoading) return;
  try { await refreshed(); if (workspaceEpoch !== branchEpoch || state.thinkingWarning) throw Error('The workspace changed or its history is unavailable. Close and reopen the branch; your writing remains here.'); const branch = state.explorations.find(b => b.id === branchEditing.id); if (!branch) throw Error('The branch needs recovery. Your writing remains here.'); const latest = branchInfo(branch); branchEditing.expectedLatestId = latest.latestId; $('branch-current').textContent = `${branchLabels[latest.status] ?? 'Status needs recovery'}\n${latest.note}\n${latest.evidence ? 'Kept as move evidence' : 'Not tagged as move evidence'}`; await saveDraft(`branch:${branch.id}`, branchBody(), 'branch-error', true); status('branch-error', 'Your choice and wording are kept. Saving will add a new status after the current one.'); } catch (error) { status('branch-error', error.message); }
};
$('move-form').onsubmit = async event => {
  event.preventDefault(); if (!moveEditing || moveSaving || moveLoading || resetting) return; moveSaving = true; const body = moveBody(), context = moveContext(), generation = epoch;
  for (const id of ['move-name', 'move-prompt', 'move-enabled', 'save-move', 'move-base']) $(id).disabled = true;
  try { await saveDraft(context, body, 'move-error', true); if (generation !== epoch) return; await store.saveMove(body, { requestId: requestId(context, body), expectedEpoch: moveEpoch }); await refreshed(); if (generation !== epoch || workspaceEpoch !== moveEpoch) return; notice('Thinking move saved. Existing branches keep the exact prompt they used.');
    try { await clearDraft(context, body); releaseRequest(context); if (JSON.stringify(moveBody()) === JSON.stringify(body)) { $('move-dialog').close(); moveEditing = null; } }
    catch (error) { cleanupOffer(context, body, 'move-error', 'Move saved.', () => { releaseRequest(context); $('move-dialog').close(); moveEditing = null; }, () => !!moveEditing && JSON.stringify(moveBody()) === JSON.stringify(body)); }
  } catch (error) { if (generation === epoch) status('move-error', `${error.message} Your editing draft is kept.`); }
  finally { moveSaving = false; for (const id of ['move-name', 'move-prompt', 'move-enabled', 'save-move', 'move-base']) $(id).disabled = false; if (state) renderSpans(); }
};
$('branch-form').onsubmit = async event => {
  event.preventDefault(); if (!branchEditing || branchSaving || branchLoading || resetting) return; branchSaving = true; const body = branchBody(), context = `branch:${body.branchId}`, generation = epoch, route = routeFromHash();
  for (const id of ['branch-status', 'branch-note', 'branch-evidence', 'save-branch-status', 'branch-base']) $(id).disabled = true;
  try { await saveDraft(context, body, 'branch-error', true); if (generation !== epoch) return; await store.setBranchStatus(body, { requestId: requestId(context, body), expectedEpoch: branchEpoch }); await refreshed(); if (generation !== epoch || workspaceEpoch !== branchEpoch) return; notice('Branch choice saved. Its writing and history are kept. NOW is unchanged.');
    try { await clearDraft(context, body); releaseRequest(context); if (JSON.stringify(branchBody()) === JSON.stringify(body)) { $('branch-dialog').close(); branchEditing = null; } }
    catch (error) { cleanupOffer(context, body, 'branch-error', 'Branch choice saved.', () => { releaseRequest(context); $('branch-dialog').close(); branchEditing = null; }, () => !!branchEditing && JSON.stringify(branchBody()) === JSON.stringify(body)); }
    if (routeFromHash() === route) showView(`branch/${body.branchId}`);
  } catch (error) { if (generation === epoch) status('branch-error', `${error.message} Your status draft is kept.`); }
  finally { branchSaving = false; for (const id of ['branch-status', 'branch-note', 'branch-evidence', 'save-branch-status', 'branch-base']) $(id).disabled = false; if (branchEditing) $('branch-evidence').disabled = !state.explorations.find(b => b.id === branchEditing.id)?.move; if (state) renderThread(); }
};
function focusArtifact() {
  if (!artifactFocusPending || !artifactSelection) return;
  requestAnimationFrame(() => {
    if (!artifactFocusPending || !artifactSelection) return;
    const view = currentView === 'thread' ? $('view-thread') : $('view-spans');
    const card = [...view.querySelectorAll('[data-artifact-id]')].find(e => e.dataset.artifactId === artifactSelection);
    if (!card) return; artifactFocusPending = false; card.focus({ preventScroll: true }); card.scrollIntoView({ block: 'center' });
  });
}
const fileSize = bytes => bytes < 1024 ? `${bytes} bytes` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
function artifactCard(row) {
  const card = element('article', undefined, `artifact-card${row.id === artifactSelection ? ' selected-artifact' : ''}`); card.dataset.artifactId = row.id; card.tabIndex = -1;
  let sourceStatus; try { sourceStatus = artifactSourceStatus(row, state); } catch { sourceStatus = 'recovery'; }
  card.append(element('h4', row.name), element('p', `${fileSize(row.bytes)} · ${row.mime || 'Unspecified type'} · ${formatDate(row.at)}`, 'small'), element('p', sourceStatus === 'verified' ? 'File bytes verified · Source linked' : 'File bytes verified · Source needs recovery', 'small'));
  const preview = artifactPreview(row);
  if (preview) { const display = element('details', undefined, 'artifact-preview'); display.append(element('summary', 'Read text preview'), element('pre', preview.text, 'raw')); if (preview.truncated) display.append(element('p', 'Preview ends here. Download the file for its complete original bytes.', 'small')); card.append(display); }
  else card.append(element('p', 'This file is available as an exact download.', 'small'));
  const actions = element('div', undefined, 'post-actions'), download = element('button', 'Download original file', 'quiet');
  download.onclick = () => { try { const url = URL.createObjectURL(new Blob([artifactBytes(row)], { type: 'application/octet-stream' })), a = element('a'); a.href = url; a.download = row.name; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); } catch (error) { fail(error); } };
  const permalink = element('a', 'File permalink', 'small'); permalink.href = `#artifact/${row.id}`;
  permalink.onclick = event => { if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return; event.preventDefault(); if ($('source-dialog').open) $('source-dialog').close(); showView(`artifact/${row.id}`); };
  actions.append(download, permalink);
  const source = element('button', sourceStatus === 'verified' ? 'Open source thought' : 'Inspect source recovery', 'text-button'); source.onclick = () => { if ($('source-dialog').open) $('source-dialog').close(); sourceStatus === 'verified' ? openThread(row.captureId) : showView('engine'); }; actions.append(source);
  card.append(actions); const reference = element('details', undefined, 'file-reference'); reference.append(element('summary', 'Use in another thought'), element('p', 'Paste this into another thought to link this exact file. The original stays attached to its source.', 'small'), element('code', `[Connected file](#artifact/${row.id})`)); card.append(reference); const proof = element('details'); proof.append(element('summary', 'File checksum'), element('p', `SHA-256 ${row.contentHash}`, 'small file-checksum')); card.append(proof); return card;
}
function attachedFiles(capture) {
  if (state.fileWarning) return element('p', state.fileWarning, 'small');
  const rows = (state.artifacts ?? []).filter(a => a.captureId === capture.id); if (!rows.length) return null;
  const section = element('section', undefined, 'attached-files'); section.append(element('h3', `Connected files (${rows.length})`));
  for (const row of rows.slice().sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))) section.append(artifactCard(row)); return section;
}
function attachButton(capture) {
  const button = element('button', 'Attach a file…', 'text-button'); button.disabled = artifactSaving; button.onclick = () => openArtifact(capture.id); return button;
}
function openArtifact(captureId) {
  if (artifactSaving || resetting || !state.captures.some(c => c.id === captureId)) return;
  if ($('artifact-file').files.length && artifactTarget !== captureId) status('artifact-error', 'A file is still selected for the earlier thought. Save it or clear the selection before choosing a new source.');
  else { if (!$('artifact-file').files.length) { artifactTarget = captureId; artifactEpoch = workspaceEpoch; } status('artifact-error', ''); }
  $('artifact-target').textContent = `Source: ${displayTitle(state.captures.find(c => c.id === artifactTarget)?.text ?? 'Source needs recovery.', 200)}`;
  $('artifact-dialog').showModal(); $('artifact-file').focus();
}
$('clear-artifact').onclick = () => { if (!artifactSaving) { $('artifact-file').value = ''; status('artifact-error', 'File selection cleared. Its original file is unchanged.'); } };
$('artifact-form').onsubmit = async event => {
  event.preventDefault(); const file = $('artifact-file').files[0]; if (!file || !artifactTarget || artifactSaving || resetting) return;
  const captureId = artifactTarget, expectedEpoch = artifactEpoch, generation = epoch; artifactSaving = true;
  for (const id of ['artifact-file', 'save-artifact', 'clear-artifact']) $(id).disabled = true;
  status('artifact-error', 'Reading and verifying the original file…');
  try {
    if (file.size > ARTIFACT_LIMITS.fileBytes) throw Error('Choose a file up to 2 MiB.');
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (generation !== epoch) return;
    await store.attach({ captureId, name: file.name, mime: file.type || 'application/octet-stream', bytes }, { expectedEpoch });
    await refreshed();
    if (generation !== epoch || workspaceEpoch !== expectedEpoch) return;
    $('artifact-file').value = ''; artifactTarget = null; $('artifact-dialog').close(); notice('File saved. Exact bytes read back and verified, with their source attached. NOW is unchanged.');
  } catch (error) { if (generation === epoch) status('artifact-error', `${error.message} Your selected file remains here to retry. Your source thought is unchanged.`); }
  finally { artifactSaving = false; for (const id of ['artifact-file', 'save-artifact', 'clear-artifact']) $(id).disabled = false; if (state) renderThread(); }
};
async function considerProposal(distillationId) {
  if (proposalPending.has(distillationId) || resetting || !storageHealthy) return;
  const expectedEpoch = workspaceEpoch, generation = epoch, route = routeFromHash();
  proposalPending.add(distillationId); renderThread();
  try {
    const proposal = await store.prepareProposal({ distillationId }, { expectedEpoch });
    await refreshed();
    if (generation !== epoch || workspaceEpoch !== expectedEpoch) return;
    if (routeFromHash() === route && !$('source-dialog').open) openSource(proposal.id, false);
    notice('Proposal saved with its source attached. NOW is unchanged. Choose an exact detail only if you want to commit to it.');
  } catch (error) { if (generation === epoch) fail(error); }
  finally { proposalPending.delete(distillationId); if (state) renderThread(); }
}
async function considerRevisionProposal({revisionId,revisionHash}) {
  const key=revisionPreparationKey(revisionId,revisionHash);if(revisionPreparationPending.has(key)||resetting||!storageHealthy)return;
  const expectedEpoch=workspaceEpoch,generation=epoch,route=routeFromHash(),navigation=navigationVersion,originSource=$('source-dialog').open?sourceId:null;
  revisionPreparationPending.add(key);revisionsUI.update();
  try{
    const proposal=await store.prepareRevisionProposal({revisionId,revisionHash},{expectedEpoch});await refreshed();
    if(generation!==epoch||workspaceEpoch!==expectedEpoch)return;
    const sameReading=originSource?$('source-dialog').open&&sourceId===originSource:!document.querySelector('dialog[open]');
    if(navigationVersion===navigation&&routeFromHash()===route&&sameReading){if($('source-dialog').open)$('source-dialog').close();openSource(proposal.id,false);}
    notice('Exact revision prepared as a separate proposal. NOW is unchanged. Choosing a detail is a second action.');
  }catch(error){if(generation===epoch)fail(error);}finally{revisionPreparationPending.delete(key);revisionsUI.update();}
}
function revisionProposalProvenance(capture) {
  const box=element('aside',undefined,'proposal-provenance revision-proposal-provenance');let status;try{status=validateProposalProvenance(capture,state);}catch{status='recovery';}
  if(status!=='verified'){box.append(element('p','Revision proposal source links need recovery. Its exact writing is kept.','small'));const recover=element('button','Inspect source recovery','text-button');recover.onclick=()=>{if($('source-dialog').open)$('source-dialog').close();showView('engine');};box.append(recover);return box;}
  const revision=state.sourceRevisions.find(row=>row.id===capture.sourceRevisionId),original=state.captures.find(row=>row.id===capture.parentId);
  box.append(element('p',revision.kind==='edit'?'Prepared from an exact saved correction. Source links verified.':'Prepared from an exact supplied transcript. Source links verified; audio is not verified.','small'));
  const lineage=element('details',undefined,'proposal-lineage');lineage.append(element('summary','Read exact revision lineage'),element('p','Preparation preserved this saved revision, not a later edit. Checksums verify bytes and links, not authorship, factual truth or completed work.','small'),element('p',`Revision ${revision.id} · ${new Date(revision.at).toLocaleString()} · SHA-256 ${revision.hash}`,'small file-checksum'),element('h4',revision.kind==='edit'?'Saved correction':'Supplied transcript text'),element('pre',revision.text,'raw'),element('h4','Original source'),element('pre',original.text,'raw'));
  const download=element('button','Download exact revision record','text-button');download.onclick=()=>downloadText(JSON.stringify(revision,null,2),`effort-revision-${revision.id}.json`);const source=element('button','Open original source thread','text-button');source.onclick=()=>{if($('source-dialog').open)$('source-dialog').close();openThread(original.id);};lineage.append(download,source);box.append(lineage);return box;
}
function proposalProvenance(capture) {
  if (capture.sourceRevisionId) return revisionProposalProvenance(capture);
  if (!capture.derivedFromId) return null;
  const box = element('aside', undefined, 'proposal-provenance'); let status;
  try { status = validateProposalProvenance(capture, state); } catch { status = 'recovery'; }
  box.append(element('p', status === 'verified' ? 'Prepared from your distillation. Saved links verified.' : 'Proposal source links need recovery. Its exact writing is kept.', 'small'));
  if (status !== 'verified') {
    const recovery = element('button', 'Inspect source recovery', 'text-button'); recovery.onclick = () => { if ($('source-dialog').open) $('source-dialog').close(); showView('engine'); }; box.append(recovery); return box;
  }
  const distilled = state.distillations.find(d => d.id === capture.derivedFromId), branch = state.explorations.find(b => b.id === distilled.explorationId), original = state.captures.find(c => c.id === branch.sourceId);
  const lineage = element('details', undefined, 'proposal-lineage'); lineage.append(element('summary', 'Read proposal lineage'), element('p', 'Your own writing, preserved through each step. Verified links and checksums don’t establish factual truth or completed work.', 'small'));
  for (const [heading, text] of [[`Distillation · ${distilled.type}`, distilled.text], [`Exploration · ${branch.dial}`, branch.text], ['Original source', original.text]]) lineage.append(element('h4', heading), element('pre', text, 'raw'));
  const open = element('button', 'Open source thread', 'text-button'); open.onclick = () => { if ($('source-dialog').open) $('source-dialog').close(); openThread(original.id); requestAnimationFrame(() => $(`branch-${branch.id}`)?.scrollIntoView({ block: 'center' })); }; lineage.append(open); box.append(lineage); return box;
}
const exploreBody = () => ({ ...explorationDraft, move: explorationDraft?.move ?? null, text: value('explore-text'), dial: $('explore-dial').value });
const distillBody = () => ({ ...distillationDraft, text: value('distill-text'), type: $('distill-type').value });
async function openExplore(sourceId, parent = null) {
  if (explorationSaving || explorationLoading || resetting) return;
  explorationLoading = true;
  const source = state.captures.find(c => c.id === sourceId); if (!source) { explorationLoading = false; return; }
  explorationNavigation = navigationVersion; explorationRoute = routeFromHash();
  updateExplorationControls();
  const returnData = { route: routeFromHash(), context: { scrollY, spanSearch: $('span-search').value, sourceExpanded: document.querySelector('#thread-post .original-disclosure')?.open ?? false }, expected: structuredClone(state.now), summary: displayTitle(source.text, 300) };
  explorationDraft = { sourceId, parentId: parent?.id ?? null, returnPointId: parent?.returnPointId ?? null, returnData, move: null };
  $('explore-current-place').disabled = true; $('explore-text').disabled = $('explore-dial').disabled = $('explore-move').disabled = true; $('save-exploration').disabled = true;
  setValue('explore-text', ''); $('explore-dial').value = parent?.dial ?? 'NORMAL'; status('explore-error', ''); $('explore-dialog').returnValue = ''; $('explore-dialog').showModal();
  try {
    const saved = await loadContext(`explore:${sourceId}`);
    if (saved?.body.text) { const { text, dial, ...context } = saved.body; explorationDraft = context; setValue('explore-text', text); $('explore-dial').value = dial; status('explore-error', 'Unfinished branch restored with its original parent and return context.'); }
  } catch (e) { status('explore-error', `${e.message} Copy writing before leaving.`); }
  const ancestor = state.explorations?.find(b => b.id === explorationDraft.parentId);
  $('explore-parent').textContent = ancestor ? `Branching from: ${displayTitle(ancestor.text, 150)}` : `From: ${displayTitle(source.text, 150)}`;
  if (explorationDraft.move === undefined) explorationDraft.move = null; populateMovePicker(); $('explore-current-place').hidden = !!explorationDraft.parentId; $('explore-move').disabled = false;
  explorationLoading = false; updateExplorationControls(); $('explore-current-place').disabled = false; $('explore-text').disabled = $('explore-dial').disabled = false; $('save-exploration').disabled = false; $('explore-text').focus();
}
async function openDistill(branch) {
  if (distillationSaving || distillationLoading || resetting) return;
  distillationLoading = true; updateExplorationControls();
  distillationDraft = { explorationId: branch.id };
  $('distill-text').disabled = $('distill-type').disabled = true; $('save-distillation').disabled = true;
  setValue('distill-text', ''); $('distill-type').value = 'INSIGHT'; status('distill-error', ''); $('distill-dialog').showModal();
  try { const saved = await loadContext(`distill:${branch.id}`); if (saved?.body.text) { setValue('distill-text', saved.body.text); $('distill-type').value = saved.body.type; } }
  catch (e) { status('distill-error', `${e.message} Copy writing before leaving.`); }
  $('distill-source').textContent = `From your branch: ${displayTitle(branch.text, 160)}`;
  distillationLoading = false; updateExplorationControls(); $('distill-text').disabled = $('distill-type').disabled = false; $('save-distillation').disabled = false; $('distill-text').focus();
}
for (const [kind, textId, selectId, body] of [['explore', 'explore-text', 'explore-dial', exploreBody], ['distill', 'distill-text', 'distill-type', distillBody]]) {
  const persist = () => { const draft = kind === 'explore' ? explorationDraft : distillationDraft; if (!draft) return; edited(textId); saveDraft(`${kind}:${kind === 'explore' ? draft.sourceId : draft.explorationId}`, body(), `${kind}-error`, true); };
  $(textId).oninput = persist; $(selectId).onchange = persist;
}
$('explore-form').onsubmit = async event => {
  event.preventDefault(); if (!explorationDraft || explorationSaving || explorationLoading || resetting) return;
  explorationSaving = true; updateExplorationControls(); const body = exploreBody(), context = `explore:${body.sourceId}`, generation = epoch, expectedEpoch = workspaceEpoch, originNavigation = explorationNavigation, originRoute = explorationRoute;
  for (const id of ['explore-text', 'explore-dial', 'explore-move', 'explore-current-place', 'save-exploration']) $(id).disabled = true;
  try {
    await saveDraft(context, body, 'explore-error', true);
    if (generation !== epoch) throw Error('The workspace changed. Reopen the exploration.');
    let returnPointId = body.returnPointId;
    if (!returnPointId) { const place = await store.holdPlace({ ...body.returnData, nextAction: '' }, { requestId: requestId(`${context}:return`, body.returnData), expectedEpoch }); returnPointId = place.id; }
    if (generation !== epoch) throw Error('The workspace changed. Your branch was not added.');
    const record = await store.explore({ sourceId: body.sourceId, parentId: body.parentId, returnPointId, text: body.text, dial: body.dial, move: body.move }, { requestId: requestId(context, body), expectedEpoch });
    if (generation !== epoch) return;
    notice('Branch kept. Your chosen NOW is unchanged.');
    try { await clearDraft(context, body); releaseRequest(context); releaseRequest(`${context}:return`); if (JSON.stringify(exploreBody()) === JSON.stringify(body)) { setValue('explore-text', ''); $('explore-dialog').close('saved'); explorationDraft = null; } }
    catch (e) { cleanupOffer(context, body, 'explore-error', 'Branch kept.', () => { releaseRequest(context); releaseRequest(`${context}:return`); setValue('explore-text', ''); $('explore-dialog').close('saved'); explorationDraft = null; }, () => !!explorationDraft && JSON.stringify(exploreBody()) === JSON.stringify(body)); }
    await refreshed();
    if (navigationVersion === originNavigation && routeFromHash() === originRoute && $('explore-dialog').returnValue === 'saved' && !document.querySelector('dialog[open]')) { openThread(record.sourceId); $(`branch-${record.id}`)?.scrollIntoView({ block: 'center' }); }
  } catch (e) { status('explore-error', `${e.message} Your writing is still here.`); }
  finally { explorationSaving = false; updateExplorationControls(); for (const id of ['explore-text', 'explore-dial', 'explore-move', 'explore-current-place', 'save-exploration']) $(id).disabled = false; }
};
$('distill-form').onsubmit = async event => {
  event.preventDefault(); if (!distillationDraft || distillationSaving || distillationLoading || resetting) return;
  distillationSaving = true; updateExplorationControls(); const body = distillBody(), context = `distill:${body.explorationId}`, generation = epoch, expectedEpoch = workspaceEpoch;
  for (const id of ['distill-text', 'distill-type', 'save-distillation']) $(id).disabled = true;
  try {
    await saveDraft(context, body, 'distill-error', true);
    if (generation !== epoch) throw Error('The workspace changed. Reopen the distillation.');
    await store.distill(body, { requestId: requestId(context, body), expectedEpoch });
    if (generation !== epoch) return;
    notice('Distillation kept. Nothing has become a task.');
    try { await clearDraft(context, body); releaseRequest(context); if (JSON.stringify(distillBody()) === JSON.stringify(body)) { setValue('distill-text', ''); $('distill-dialog').close(); distillationDraft = null; } }
    catch (e) { cleanupOffer(context, body, 'distill-error', 'Distillation kept.', () => { releaseRequest(context); setValue('distill-text', ''); $('distill-dialog').close(); distillationDraft = null; }, () => !!distillationDraft && JSON.stringify(distillBody()) === JSON.stringify(body)); }
    await refreshed();
  } catch (e) { status('distill-error', `${e.message} Your writing is still here.`); }
  finally { distillationSaving = false; updateExplorationControls(); for (const id of ['distill-text', 'distill-type', 'save-distillation']) $(id).disabled = false; }
};

function targetReply(id) { if (replyLoading) return; persistReplyDraft(); replyTarget = id; persistReplyDraft(); renderThread(); $('reply-text').focus(); $('reply-form').scrollIntoView({ block: 'center', behavior: 'auto' }); }
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
  const capture = state.captures.find(c => c.id === sourceId); if (!capture) { $('source-body').replaceChildren(element('p', 'This original is no longer in the active workspace. Check Engine Room recovery or your downloaded backup.')); $('source-body').append(revisionsUI.panel(sourceId)); $('source-proof').textContent = ''; return; }
  $('show-raw').setAttribute('aria-pressed', String(rawView)); $('show-organized').setAttribute('aria-pressed', String(!rawView));
  const provenance = proposalProvenance(capture);
  const files = attachedFiles(capture);
  $('source-body').replaceChildren(...(provenance ? [provenance] : []), rawView ? element('pre', capture.text, 'raw') : organized(capture), ...(files ? [files] : []), revisionsUI.disclosure(capture.id));
  $('source-proof').textContent = `Original verified · SHA-256 ${capture.hash.slice(0, 16)}… · ${capture.text.length} UTF-16 code units`;
}
function openSource(id, raw) { sourceId = id; rawView = raw; renderSource(); $('source-dialog').showModal(); }
function persistDraft(explicit = false) { return saveDraft('capture', captureBody(), 'draft-state', explicit); }
function persistReplyDraft(explicit = false) { if (threadId && !replyLoading) return saveDraft(`reply:${threadId}`, replyBody(), 'reply-draft-state', explicit); }
let replyLoad = 0, replyLoading = false;
async function loadReplyDraft() {
  const token = ++replyLoad, context = threadId && `reply:${threadId}`; replyLoading = !!context;
  $('reply-text').disabled = true; $('save-reply').disabled = true;
  setValue('reply-text', ''); replyTarget = null;
  if (!context) return;
  try { const savedMemory = volatileReplies.get(threadId); const record = savedMemory ? { body: savedMemory } : await loadContext(context); if (token !== replyLoad) return; if (record) { setValue('reply-text', record.body.text); replyTarget = record.body.parentId; } }
  catch (e) { status('reply-draft-state', `${e.message} Draft recovery is available in Engine Room.`); }
  if (token === replyLoad) { replyLoading = false; $('reply-text').disabled = false; $('save-reply').disabled = !storageHealthy; renderThread(); }
}
$('reply-text').oninput = () => { edited('reply-text'); persistReplyDraft(true); };
addEventListener('pagehide', () => { persistReplyDraft(); });
$('reply-form').onsubmit = async event => {
  event.preventDefault(); const parent = state.captures.find(c => c.id === replyTarget), root = state.captures.find(c => c.id === threadId); if (!parent || !root || threadRoot(parent, state.captures)?.id !== threadRoot(root, state.captures)?.id) { status('reply-draft-state', 'Choose a reply target in this thread first.'); return; }
  const body = replyBody(), text = body.text, destination = threadId; $('save-reply').disabled = true; await persistReplyDraft(true);
  try {
    await store.capture(text, parent.span, parent.id, { requestId: requestId(`reply:${destination}`, body) });
    notice('Reply saved. Exact original verified. NOW is unchanged.');
    if (threadId === destination && JSON.stringify(replyBody()) === JSON.stringify(body)) { try { await clearDraft(`reply:${destination}`, body); releaseRequest(`reply:${destination}`); if (threadId === destination && JSON.stringify(replyBody()) === JSON.stringify(body)) setValue('reply-text', ''); } catch (e) { cleanupOffer(`reply:${destination}`, body, 'reply-draft-state', 'Reply saved.', () => { releaseRequest(`reply:${destination}`); if (threadId === destination && JSON.stringify(replyBody()) === JSON.stringify(body)) setValue('reply-text', ''); }, () => threadId === destination && JSON.stringify(replyBody()) === JSON.stringify(body)); } }
    try { await refreshed(); } catch (e) { status('reply-draft-state', `Reply saved, but refresh failed: ${e.message}`); }
  } catch (error) { $('reply-draft-state').textContent = `${error.message} Your draft is still here.`; }
  finally { $('save-reply').disabled = false; }
};
function renderRecovery(health) {
    $('recovery-panel').hidden = !state.recovery.length && !health.migrationWarning;
    const damagedOriginals = state.recovery.filter(record => record.source !== 'draft').length, draftCopies = state.recovery.length - damagedOriginals;
    $('recovery-status').textContent = health.migrationWarning || `${damagedOriginals} damaged record${damagedOriginals === 1 ? '' : 's'} preserved separately.${draftCopies ? ` ${draftCopies} draft recovery cop${draftCopies === 1 ? 'y' : 'ies'} also preserved.` : ''} Verified originals remain available and you can keep capturing.`;
    const host=$('recovery-items'),existing=new Map([...host.children].map(node=>[node.dataset.recoveryId,node]));
    const nodes=state.recovery.map(record=>{
      const previous=existing.get(record.id);if(previous){previous.querySelector('summary').textContent=`${record.source}: ${record.reason}`;return previous;}
      const item = element('details');item.dataset.recoveryId=record.id; item.append(element('summary', `${record.source}: ${record.reason}`), element('pre', record.raw.slice(0, 8000), 'raw'));
      if (record.raw.length > 8000) item.append(element('p', 'Preview truncated. Download the raw recovery record for its complete preserved bytes.', 'small'));
      const download = element('button', 'Download raw recovery record', 'text-button'); download.onclick = () => downloadText(record.raw, `effort-recovery-${record.id}.json`, 'application/json'); item.append(download); return item;
    });
    for(const child of [...host.children])if(!nodes.includes(child))child.remove();for(let i=0;i<nodes.length;i++)if(host.children[i]!==nodes[i])host.insertBefore(nodes[i],host.children[i]??null);
}
function refreshed() {
  refreshing = refreshing.catch(() => {}).then(async () => {
    const previous = state; state = await store.read({ includeDrafts: false }); const openingOnly = previous && writingState(previous) === writingState(state); const health = await store.health();
    if (workspaceEpoch !== undefined && health.epoch !== workspaceEpoch) { renderedOpening = null; openingViewToken++; threadOpeningPending = false; openingPending.clear(); openingErrors.clear(); fenced = true; adopted.clear(); status('draft-state', 'Workspace changed in another tab. Your writing remains here; copy it before leaving.'); status('reply-draft-state', 'Workspace changed in another tab. Your writing remains here; copy it before leaving.'); } workspaceEpoch = health.epoch;
    storageHealthy = true; $('capture-open').disabled = booting;
    if (artifactSelection) {
      const file = state.artifacts?.find(a => a.id === artifactSelection), source = file && state.captures.find(c => c.id === file.captureId);
      if (currentView !== (source ? 'thread' : 'spans') || threadId !== (source?.id ?? null)) showView(routeFromHash(), false);
    }
    if (branchSelection) { const branch = state.explorations?.find(b => b.id === branchSelection), source = branch && state.captures.find(c => c.id === branch.sourceId); if (currentView !== (source ? 'thread' : 'spans') || threadId !== (source?.id ?? null)) showView(routeFromHash(), false); }
    if (openingOnly) { if(JSON.stringify(previous.recovery)!==JSON.stringify(state.recovery))renderRecovery(health); refreshOpeningSummaries(); refreshOpeningContext(); archiveUI?.update(); revisionsUI?.update(); return; }
    render();
    renderRecovery(health);
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
      showView(result.route); artifactFocusPending = false; branchFocusPending = false; $('span-search').value = place.context.spanSearch; renderSpans();
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
async function openHold() {
  if (booting || !state || resetting) return;
  if (holdSaving) { notice('Your return point is still saving. Keep this window open.'); return; }
  $('hold-summary').disabled = $('hold-next').disabled = true;
  let saved; try { saved = await loadContext('hold'); } catch (e) { status('hold-error', e.message); }
  holdExpected = structuredClone(state.now); holdRoute = routeFromHash();
  holdContext = { scrollY, spanSearch: $('span-search').value, sourceExpanded: document.querySelector('#thread-post .original-disclosure')?.open ?? false };
  const thought = threadId && state.captures.find(c => c.id === threadId);
  $('hold-summary').value = thought ? displayTitle(thought.text, 300) : state.now?.quote ?? '';
  $('hold-next').value = ''; if (saved && (saved.body.summary || saved.body.nextAction)) { holdExpected = saved.body.expected; holdRoute = saved.body.route; holdContext = saved.body.context; setValue('hold-summary', saved.body.summary); setValue('hold-next', saved.body.nextAction); } else { shadows.delete('hold-summary'); shadows.delete('hold-next'); } $('hold-summary').disabled = $('hold-next').disabled = false; $('hold-error').textContent = saved ? 'Saved return notes restored with their original context.' : ''; $('hold-dialog').showModal(); $('hold-summary').focus();
}
const holdBody = () => ({ summary: value('hold-summary'), nextAction: value('hold-next'), route: holdRoute, context: holdContext, expected: holdExpected });
for (const id of ['hold-summary', 'hold-next']) $(id).oninput = () => { edited(id); saveDraft('hold', holdBody(), 'hold-error', true); };
$('hold-open').onclick = openHold;
$('hold-form').onsubmit = async event => {
  event.preventDefault(); if (holdSaving) return; holdSaving = true;
  for (const id of ['save-place', 'hold-summary', 'hold-next']) $(id).disabled = true;
  const body = holdBody(), signature = JSON.stringify(body);
  try {
    await saveDraft('hold', body, 'hold-error', true);
    if (completed.get('hold') !== signature) { await store.holdPlace(body, { requestId: requestId('hold', body) }); completed.set('hold', signature); }
    notice('Your place is kept. NOW is unchanged.');
    try { await clearDraft('hold', body); releaseRequest('hold'); completed.delete('hold'); $('hold-dialog').close(); }
    catch (e) { cleanupOffer('hold', body, 'hold-error', 'Your place is kept.', () => { releaseRequest('hold'); completed.delete('hold'); $('hold-dialog').close(); }); }
    try { await refreshed(); } catch (e) { notice(`Your place is kept, but the view could not refresh: ${e.message}`, true); }
  } catch (error) { status('hold-error', `${error.message} Your return note is still here.`); }
  finally { holdSaving = false; for (const id of ['save-place', 'hold-summary', 'hold-next']) $(id).disabled = false; }
};
function cleanupOffer(context, body, target, message, onClean = () => {}, isCurrent = () => true) {
  if (!isCurrent()) { status(target, `${message} Newer writing was kept as a draft.`); return; }
  status(target, `${message} Draft cleanup failed. Use Retry draft cleanup or copy the draft.`);
  let button = $(target).parentElement.querySelector('.retry-draft-cleanup');
  if (!button) { button = element('button', 'Retry draft cleanup', 'quiet retry-draft-cleanup'); button.type = 'button'; $(target).after(button); }
  button.onclick = async () => { button.disabled = true; try { await clearDraft(context, body); button.remove(); if (isCurrent()) { status(target, `${message} Draft cleared.`); onClean(); } else status(target, `${message} Newer writing remains in this window.`); } catch (e) { status(target, `${message} Draft cleanup still failed: ${e.message}`); } finally { button.disabled = false; } };
}
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
  if (span.kind === 'moves') renderMoves(body);
  if (span.kind === 'people') peopleUI?.render(body, personSelection);
  if (span.kind === 'workspace') {
    const library = element('details', undefined, 'panel file-library'); library.open = !!artifactSelection; library.append(element('summary', state.fileWarning ? 'Connected files unavailable' : `Connected files (${(state.artifacts ?? []).length})`), element('p', 'Exact files, linked to their source thoughts. Files with a damaged source stay downloadable here.', 'small'));
    for (const row of (state.artifacts ?? []).slice().sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))) library.append(artifactCard(row));
    if (state.fileWarning) library.append(element('p', state.fileWarning, 'notice'));
    if (!state.fileWarning && !(state.artifacts ?? []).length) library.append(element('p', 'Attach a file from a saved thought or reply. Nothing becomes a task.', 'small'));
    body.append(library);
    body.append(element('h2', 'Chosen work'), element('p', 'Only explicit choices appear here. Captures and replies can stay thoughts.', 'muted'));
    for (const item of commitments().filter(c => ['COMMITTED', 'ACTIVE'].includes(c.state))) {
      const card = element('article', undefined, 'panel commitment-card'); card.append(element('span', item.state, 'eyebrow'), element('h3', item.choice.quote));
      const actions = element('div', undefined, 'post-actions');
      if (item.state !== 'ACTIVE') { const choose = element('button', 'Make this NOW', 'quiet'); choose.onclick = async () => { choose.disabled = true; try { state = await store.selectCommitment(item.id, state.now); render(); showView('home'); notice('Chosen work restored to NOW.'); } catch (error) { fail(error); } finally { choose.disabled = false; } }; actions.append(choose); }
      const drop = element('button', 'Drop commitment…', 'text-button'); drop.onclick = async () => { if (dropSaving) { notice('The commitment change is still saving.'); return; } dropping = item; $('drop-choice').textContent = item.choice.quote; $('drop-note').disabled = true; setValue('drop-note', ''); $('drop-error').textContent = ''; $('drop-dialog').showModal(); try { const saved = await loadContext(`drop:${item.id}`); if (saved) { setValue('drop-note', saved.body.note); dropping = {...item, latestId: saved.body.latestId}; } } catch (e) { status('drop-error', e.message); } $('drop-note').disabled = false; $('drop-note').focus(); };
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
$('drop-note').oninput = () => { edited('drop-note'); if (dropping) saveDraft(`drop:${dropping.id}`, { note: value('drop-note'), commitmentId: dropping.id, latestId: dropping.latestId }, 'drop-error', true); };
$('drop-form').onsubmit = async event => {
  event.preventDefault(); if (!dropping || dropSaving) return; dropSaving = true; $('save-drop').disabled = $('drop-note').disabled = true;
  const body = { note: value('drop-note'), commitmentId: dropping.id, latestId: dropping.latestId }, context = `drop:${dropping.id}`, signature = JSON.stringify(body);
  try {
    await saveDraft(context, body, 'drop-error', true);
    if (completed.get(context) !== signature) { state = await store.dropCommitment(dropping.id, body.note, body.latestId); completed.set(context, signature); }
    notice('Commitment dropped. Its reason and original are kept. Nothing else was chosen.');
    try { await clearDraft(context, body); completed.delete(context); $('drop-dialog').close(); } catch (e) { cleanupOffer(context, body, 'drop-error', 'Commitment dropped.', () => { completed.delete(context); $('drop-dialog').close(); }); }
    try { render(); } catch (e) { notice(`Commitment dropped, but the view could not refresh: ${e.message}`, true); }
  } catch (error) { status('drop-error', error.message); } finally { dropSaving = false; $('save-drop').disabled = $('drop-note').disabled = false; }
};

document.addEventListener('click', event => { const link = event.target.closest?.('a[data-local-route]'); if (!link || event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return; event.preventDefault(); if ($('source-dialog').open) $('source-dialog').close(); showView(link.dataset.localRoute); });

document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => showView(button.dataset.view)));
addEventListener('hashchange', () => showView(routeFromHash()));
document.querySelectorAll('[data-close]').forEach(button => button.onclick = () => $(button.dataset.close).close());
function openCapture(destination) { if (destination && !$('capture-text').value) $('capture-span').value = destination; renderCapturePreview(); $('capture-dialog').showModal(); $('capture-text').focus(); }
$('capture-open').onclick = () => openCapture();
$('post-to-span').onclick = () => openCapture(state.spans.find(s => s.id === activeSpan)?.name);
$('back-spans').onclick = () => showView('spans');
$('span-search').oninput = renderSpans;
$('new-span').onclick = async () => { $('span-name').disabled = true; $('span-dialog').showModal(); try { const saved = await loadContext('span'); setValue('span-name', saved?.body.name ?? ''); } catch (e) { status('span-error', e.message); } $('span-name').disabled = false; $('span-name').focus(); };
$('span-name').oninput = () => { edited('span-name'); saveDraft('span', { name: value('span-name') }, 'span-error', true); };
$('span-form').onsubmit = async event => {
  event.preventDefault(); $('save-span').disabled = true;
  const body = { name: value('span-name') }, signature = JSON.stringify(body);
  try {
    await saveDraft('span', body, 'span-error', true);
    let result = completed.get('span'); if (!result || result.signature !== signature) { result = { signature, span: await store.createSpan(body.name) }; completed.set('span', result); }
    notice('Attention Span ready. Nothing has been made a task.');
    try { await clearDraft('span', body); completed.delete('span'); if (value('span-name') === body.name) { $('span-dialog').close(); setValue('span-name', ''); } } catch (e) { cleanupOffer('span', body, 'span-error', 'Attention Span created.', () => { completed.delete('span'); $('span-dialog').close(); }); }
    try { await refreshed(); openSpan(result.span.id); } catch (e) { notice(`Attention Span created, but the view could not refresh: ${e.message}`, true); }
  } catch (error) { status('span-error', error.message); } finally { $('save-span').disabled = false; }
};
$('capture-text').oninput = () => { edited('capture-text'); persistDraft(true); renderCapturePreview(); };
$('capture-ef').onclick = () => setEF(!efOn);
$('capture-span').onchange = () => persistDraft(true);
$('capture-dialog').addEventListener('close', () => { if (value('capture-text')) persistDraft(); });
addEventListener('pagehide', () => { if (value('capture-text')) persistDraft(); });
$('fill-example').onclick = () => { setValue('capture-text', "Maybe build a small workshop exercise.\nI'll review the outline tomorrow.\nI'm waiting for the venue to reply."); persistDraft(true); $('capture-text').focus(); };
$('capture-form').onsubmit = async event => {
  event.preventDefault(); if (saving || !storageHealthy) return;
  const body = captureBody(), text = body.text, span = body.span, generation = epoch;
  saving = true; $('save-capture').disabled = true; await persistDraft(true); $('save-capture').textContent = 'Verifying…';
  try {
    await store.capture(text, span, null, { requestId: requestId('capture', body) });
    if (generation !== epoch) return;
    notice('Saved. Exact original read back and verified. Your next step is unchanged.');
    if (JSON.stringify(captureBody()) === JSON.stringify(body)) { try { await clearDraft('capture', body); releaseRequest('capture'); if (JSON.stringify(captureBody()) === JSON.stringify(body)) { setValue('capture-text', ''); $('capture-dialog').close(); } } catch (e) { cleanupOffer('capture', body, 'draft-state', 'Original saved.', () => { releaseRequest('capture'); if (JSON.stringify(captureBody()) === JSON.stringify(body)) { setValue('capture-text', ''); $('capture-dialog').close(); } }, () => JSON.stringify(captureBody()) === JSON.stringify(body)); } }
    try { await refreshed(); } catch (e) { status('draft-state', `Original saved; refresh failed: ${e.message}`); }
  } catch (error) { if (generation !== epoch) return; fail(error); $('draft-state').textContent = `${error.message} Your draft is still here.`; }
  finally { saving = false; $('save-capture').disabled = false; $('save-capture').textContent = 'Save original'; }
};
$('show-raw').onclick = () => { rawView = true; renderSource(); };
$('show-organized').onclick = () => { rawView = false; renderSource(); };
$('now-original').onclick = () => state.now && openSource(state.now.captureId, true);
$('now-explore').onclick = () => state.now && openExplore(state.now.captureId);
$('now-done').onclick = async () => { try { state = await store.complete(state.now); render(); notice('Done. Your self-reported receipt is in Proof.'); } catch (error) { fail(error); } };
function downloadText(raw, filename, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([raw], { type })); const link = element('a'); link.href = url; link.download = filename;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('download').onclick = async () => {
  try {
    try { await shelf?.flush(); } catch {}
    const report = await shelf?.list().catch(() => ({ damaged: [] }));
    const draftCopies = (report?.damaged ?? []).filter(x => typeof x.raw === 'string').map(({source, raw, reason}) => ({source, raw, reason}));
    const raw = await store.exportData({ draftCopies }); const url = URL.createObjectURL(new Blob([raw], { type: 'application/json' }));
    const link = element('a'); link.href = url; link.download = 'effort-browser-demo-backup.json'; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    notice('Demo backup prepared for download. This is separate from a native phone backup.');
  } catch (error) { fail(error); }
};
$('restore-open').onclick = () => $('restore-file').click();
$('restore-file').onchange = async () => {
  const file = $('restore-file').files[0]; if (!file) return;
  try {
    if (file.size > LIMITS.backupBytes) throw Error('Choose a demo backup under 32 MB.');
    const added = await store.restore(await file.text()); await refreshed(); notice(`Restore verified. ${added} missing capture${added === 1 ? '' : 's'} added; existing originals kept.${state.artifacts?.length ? ` ${state.artifacts.length} connected files and their source links are available.` : ''}`);
  } catch (error) { fail(error); } finally { $('restore-file').value = ''; }
};
async function replaceDemo(samples) {
  if (!confirm(samples ? 'Replace this browser demo with fictional examples? Download a backup first if you want to keep its current captures and files.' : 'Clear this browser workspace, including captures, files and drafts? Download a backup first. This does not touch the Android app.')) return;
  epoch++; resetting = true;
  try {
    if (samples) await store.seed(true); else await store.reset();
    let draftCleanupError;
    try { for (const key of Object.keys(localStorage)) if (key === DRAFT || key.startsWith(`${KEY}-reply-`) || key.startsWith(`${KEY}-shelf-`)) localStorage.removeItem(key); } catch (error) { draftCleanupError = error; }
    await shelf?.close(); shelf = null;
    ++replyLoad; replyLoading = false; threadId = null; replyTarget = null; dropping = null; holdExpected = null; holdRoute = 'home'; holdContext = undefined; explorationDraft = null; distillationDraft = null;
    peopleUI?.reset(); revisionsUI?.reset(); revisionPreparationPending.clear(); personSelection = null;
    artifactTarget = null; artifactSelection = null; branchSelection = null; moveEditing = null; branchEditing = null; $('artifact-file').value = ''; status('artifact-error', '');
    shadows.clear(); versions.clear(); adopted.clear(); completed.clear(); volatileReplies.clear(); requestIds.clear();
    try { for (const key of Object.keys(sessionStorage)) if (key.startsWith(`${KEY}-request-`)) sessionStorage.removeItem(key); } catch {}
    for (const id of ['capture-text', 'reply-text', 'hold-summary', 'hold-next', 'drop-note', 'span-name', 'explore-text', 'distill-text', 'move-name', 'move-prompt', 'branch-note']) $(id).value = '';
    renderCapturePreview();
    for (const id of ['draft-state', 'reply-draft-state', 'hold-error', 'drop-error', 'span-error', 'explore-error', 'distill-error']) status(id, '');
    document.querySelectorAll('.retry-draft-cleanup').forEach(button => button.remove());
    $('capture-span').value = 'Unsorted';
    renderedOpening = null; openingViewToken++; threadOpeningPending = false; openingPending.clear(); openingErrors.clear();
    for (const id of ['capture-dialog', 'hold-dialog', 'drop-dialog', 'span-dialog', 'explore-dialog', 'distill-dialog', 'artifact-dialog', 'move-dialog', 'branch-dialog']) if ($(id).open) $(id).close();
    workspaceEpoch = (await store.health()).epoch; fenced = false;
    try { shelf = createDraftShelf(); await shelf.ready; } catch (error) { shelf = null; draftCleanupError = error; }
    await refreshed(); showView('home'); notice(draftCleanupError ? 'The workspace changed, but draft storage or cleanup failed. Check Engine Room before writing.' : samples ? 'Fictional examples loaded.' : 'Browser demo cleared. Your private EFFORT app is separate.', !!draftCleanupError);
  } catch (error) { fail(error); } finally { resetting = false; }
}
$('sample-reset').onclick = () => replaceDemo(true); $('reset').onclick = () => replaceDemo(false);
function addDraftDownloads(item, body) {
  for (const [key, label] of [['text', 'writing'], ['name', 'name'], ['prompt', 'prompt'], ['note', 'note'], ['summary', 'summary'], ['nextAction', 'return note']]) {
    if (typeof body?.[key] !== 'string') continue;
    const button = element('button', `Download ${label} as text`, 'text-button');
    button.onclick = () => downloadText(body[key], `effort-draft-${key}.txt`, 'text/plain'); item.append(button);
  }
}
async function renderDraftRecovery() {
  const host = $('draft-recovery-items'); if (!host || !shelf) return;
  try {
    const report = await shelf.list(); host.replaceChildren();
    const warnings = shelf.health().warnings; $('draft-recovery-status').textContent = warnings.join(' ') || 'Draft copies and recovery entries are kept in this browser.';
    for (const record of report.records) {
      const item = element('details'); item.append(element('summary', `${record.context} · ${formatDate(record.updatedAt)}`));
      const raw = JSON.stringify(record.body, null, 2); item.append(element('pre', raw, 'raw'));
      addDraftDownloads(item, record.body);
      const recover = element('button', 'Recover into this tab', 'quiet'); recover.onclick = async () => { try { if (record.context === 'capture' && $('capture-text').value && JSON.stringify(captureBody()) !== JSON.stringify(record.body)) throw Error('This composer already has different writing.'); if (record.context === `reply:${threadId}` && $('reply-text').value && JSON.stringify(replyBody()) !== JSON.stringify(record.body)) throw Error('This composer already has different writing.'); const current = await shelf.load(record.context); const empty = b => !b || !(b.text || b.name || b.note || b.summary || b.nextAction || b.profile && Object.values(b.profile).some(Boolean) || b.when); if (!empty(current?.body) && JSON.stringify(current.body) !== JSON.stringify(record.body)) throw Error('This tab already has a different draft in that context.'); await shelf.recoverRecord(record); if (record.context === 'capture' && !$('capture-text').value) { setValue('capture-text', record.body.text); $('capture-span').value = record.body.span; } else if (record.context === `reply:${threadId}` && !$('reply-text').value) { setValue('reply-text', record.body.text); replyTarget = record.body.parentId; renderThread(); } notice('Draft recovered into its matching context.'); } catch (e) { fail(e); } }; item.append(recover); host.append(item);
    }
    for (const copy of report.damaged) {
      const item = element('details'); item.append(element('summary', `${copy.source}: ${copy.reason}`)); if (copy.raw !== null) { item.append(element('pre', copy.raw, 'raw')); const download = element('button', 'Download raw recovery copy (JSON)', 'text-button'); download.onclick = () => downloadText(copy.raw, 'effort-draft-recovery.json', 'application/json'); try { const parsed = JSON.parse(copy.raw); addDraftDownloads(item, parsed.body ?? parsed); } catch {} const recover = element('button', 'Recover into matching context', 'quiet'); recover.onclick = async () => { try { if ($('capture-text').value || $('reply-text').value) throw Error('Copy or save the open composer writing before recovering this copy.'); const record = await shelf.recover(copy.source); if (record.context === 'capture' && !$('capture-text').value) { setValue('capture-text', record.body.text); $('capture-span').value = record.body.span; } notice('Copy recovered into its matching context.'); } catch (e) { fail(e); } }; item.append(download, recover); } host.append(item);
    }
  } catch (e) { $('draft-recovery-status').textContent = `Draft recovery could not open: ${e.message}`; }
}
$('draft-recovery').addEventListener('toggle', () => { if ($('draft-recovery').open) renderDraftRecovery(); });
$('lock-note').textContent = 'IndexedDB transactions serialize writes across tabs. Changed records refresh when another tab saves or this window becomes active. Browser storage can still be erased: keep downloaded backups.';
function recoverLegacyCapture() {
  if (workspaceEpoch !== undefined && workspaceEpoch !== null) return false;
  try { const raw = localStorage.getItem(DRAFT); if (!raw) return false; const draft = JSON.parse(raw); if (typeof draft?.text !== 'string' || draft.text.length > LIMITS.text || typeof draft.span !== 'string') return false; setValue('capture-text', draft.text); $('capture-span').value = draft.span; return true; } catch { return false; }
}
peopleUI = createPeopleUI({getState:()=>state,getStore:()=>store,getEpoch:()=>workspaceEpoch,getGeneration:()=>epoch,saveDraft,loadContext,clearDraft,requestId,releaseRequest,refreshed,showView,openSource,notice,downloadText,element,displayTitle,formatDate});
revisionsUI = createRevisionsUI({prepareProposal:considerRevisionProposal,isPreparing:(id,hash)=>revisionPreparationPending.has(revisionPreparationKey(id,hash)),getState:()=>state,getStore:()=>store,getEpoch:()=>workspaceEpoch,getGeneration:()=>epoch,saveDraft,loadContext,clearDraft,refreshed,element,organized,downloadText,notice,onSaved:id=>{if(currentView==='fort')archiveUI.refresh(id);}});
$('revision-directory').addEventListener('toggle',async()=>{if(!$('revision-directory').open)return;try{await refreshed();if($('revision-directory').open)revisionsUI.directory();}catch(error){fail(error);}});
archiveUI = createArchiveUI({refreshState:refreshed,onError:fail,getRevisionUI:()=>revisionsUI,getState:()=>state,getEpoch:()=>workspaceEpoch,element,organized,openSource,openThread,downloadText,getEF:()=>efOn,setEF});
try {
  store = createStore(); await store.seed(); await refreshed(); workspaceEpoch = (await store.health()).epoch;
  try {
    shelf = createDraftShelf(); await shelf.ready;
    const draft = await loadContext('capture'); if (draft) { setValue('capture-text', draft.body.text); $('capture-span').value = draft.body.span; }
    else if ((await shelf.list()).records.some(record => record.body.text || record.body.name || record.body.note || record.body.summary || record.body.nextAction || record.body.prompt || record.body.status || record.body.profile?.name || record.body.when)) notice('Unfinished writing is available in Engine Room → Draft recovery.');
  } catch (error) {
    await shelf?.close().catch(() => {}); shelf = null; const recovered = recoverLegacyCapture();
    status('draft-state', `Draft storage could not open: ${error.message}. ${recovered ? 'A legacy copy is visible here; copy it before leaving.' : 'Writing is only kept in this window. Copy it before leaving.'} Original saving is available.`);
    status('draft-recovery-status', `Draft recovery could not open: ${error.message}`);
  }
  booting = false; $('main').inert = false; $('main').removeAttribute('aria-busy'); $('capture-open').disabled = false;
  store.subscribe(() => refreshed().catch(fail));
  addEventListener('visibilitychange', () => { if (!document.hidden) refreshed().catch(fail); });
  addEventListener('focus', () => refreshed().catch(fail));
  showView(routeFromHash(), false);
} catch (error) {
  booting = false; $('main').inert = false; $('main').removeAttribute('aria-busy'); storageHealthy = false; state = { captures: [], now: null, spans: [], recovery: [], sourceRevisions: [], revisionWarning: 'The workspace could not open. Source history is unknown.' }; render(); $('capture-open').disabled = false; $('save-capture').disabled = true;
  $('storage-count').textContent = 'Saved originals unavailable'; $('now-title').textContent = 'NOW is unavailable.'; $('now-origin').textContent = 'Workspace unavailable'; $('now-reason').textContent = 'The workspace could not open, so its chosen step cannot be shown.';
  recoverLegacyCapture(); status('draft-state', 'Workspace unavailable. You can write and copy text, but saving is unavailable.'); showView('engine', false);
  fail(Error(`The local workspace could not open: ${error.message} Your saved data has not been cleared. Keep this tab open and copy any draft before retrying.`));
}

async function prepareUpdate() {
  if (booting || revisionPreparationPending.size || revisionsUI?.busy() || peopleUI?.busy() || openingPending.size || saving || holdSaving || dropSaving || replyLoading || resetting || explorationSaving || distillationSaving || explorationLoading || distillationLoading || proposalPending.size || artifactSaving || moveSaving || branchSaving || moveLoading || branchLoading) throw Error('Wait for the current save or view to finish.');
  if ($('artifact-file').files.length) throw Error("Save the selected file or clear its selection before opening an update. File selections aren't retained after reload.");
  document.body.inert = true;
  try {
    const pending = [['capture', captureBody()], ...(revisionsUI?.pendingDrafts()??[]).map(d=>[d.context,d.body]), ...(peopleUI?.pendingDrafts()??[]).map(d=>[d.context,d.body])];
    if (moveEditing) pending.push([moveContext(), moveBody()]);
    if (branchEditing) pending.push([`branch:${branchEditing.id}`, branchBody()]);
    if (explorationDraft) pending.push([`explore:${explorationDraft.sourceId}`, exploreBody()]);
    if (distillationDraft) pending.push([`distill:${distillationDraft.explorationId}`, distillBody()]);
    if (threadId) pending.push([`reply:${threadId}`, replyBody()]);
    for (const [context, body] of pending) {
      if (fenced && !adopted.has(context)) throw Error('The workspace changed in another tab. Copy any visible draft before reloading.');
      if (!shelf) throw Error('Draft storage is unavailable. Copy your writing before reloading.');
      await shelf.save(context, body);
    }
    await shelf.flush();
    return () => { document.body.inert = false; };
  } catch (error) { document.body.inert = false; throw error; }
}
setupOffline({status:$('offline-status'), button:$('apply-update'), beforeUpdate:prepareUpdate}).catch(() => { $('offline-status').textContent = 'Offline availability could not be checked. Keep a backup.'; });
