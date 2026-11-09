import { archiveSnapshot, archiveWindow } from './archive.js';

export function createArchiveUI({ getState, getEpoch, element, organized, openSource, openThread, downloadText, getEF, setEF }) {
  const $ = id => document.getElementById(id);
  let rows = [], next = 0, start = 0, query = '', selection = null, loaded = false, epoch, signature = '';
  const fingerprint = captures => JSON.stringify(captures.map(c => [c.id, c.hash, c.createdAt]));
  function card(capture) {
    const node = element('article', undefined, 'journal-post archive-card'); node.id = `fort-${capture.id}`; node.tabIndex = -1;
    const fresh = getState().captures.find(c => c.id === capture.id && c.hash === capture.hash);
    if (!fresh) { node.append(element('p', 'This source now needs recovery. Check Engine Room or a backup.')); return node; }
    node.append(element('p', `${capture.span} · ${capture.parentId ? 'Reply' : 'Post'} · ${capture.sample ? 'FICTIONAL EXAMPLE · ' : ''}${new Date(capture.createdAt).toLocaleString()}`, 'eyebrow'));
    if (getEF()) {
      try { node.append(organized(capture, false)); }
      catch { node.append(element('p', 'Organization is unavailable. The exact original is below.', 'small'), element('pre', capture.text, 'raw')); }
      const raw = element('details', undefined, 'original-disclosure'); raw.append(element('summary', 'Read the exact original'), element('pre', capture.text, 'raw')); node.append(raw);
    } else node.append(element('pre', capture.text, 'raw'));
    node.append(element('p', `Original verified · SHA-256 ${capture.hash}`, 'small file-checksum'));
    const actions = element('div', undefined, 'post-actions');
    for (const [label, action] of [['Open original', () => openSource(capture.id, true)], ['THREAD', () => openThread(capture.id)], ['Download original', () => downloadText(capture.text, `effort-original-${capture.id}.txt`, 'text/plain')]]) {
      const button = element('button', label, 'text-button'); button.type = 'button'; button.onclick = action; actions.append(button);
    }
    const link = element('a', 'Permalink', 'small'); link.href = `#fort/${capture.id}`; link.dataset.localRoute = `fort/${capture.id}`; actions.append(link); node.append(actions);
    if (capture.id === selection) node.classList.add('selected-branch');
    return node;
  }
  function counts() {
    $('fort-count').textContent = `${Math.max(0, next - start)} of ${rows.length} matching originals shown${start ? `, starting at ${start + 1}` : ''}. Newest captured timestamp first. Posts and replies retain separate identities.`;
    $('fort-more').hidden = next >= rows.length;
    $('fort-ef').textContent = getEF() ? 'EF ON' : 'EF OFF'; $('fort-ef').setAttribute('aria-pressed', String(getEF()));
    $('fort-recovery').textContent = getState().recovery?.length ? 'Some records need recovery. Engine Room preserves their raw copies; they are not presented here as verified originals.' : '';
  }
  function snapshot(id = selection) {
    const state = getState(); rows = archiveSnapshot(state.captures, query); signature = fingerprint(state.captures); epoch = getEpoch(); loaded = true; selection = id;
    const page = archiveWindow(rows, { aroundId: id }); start = page.offset; next = page.next;
    $('fort-entries').replaceChildren(...page.rows.map(card));
    if (!rows.length) $('fort-entries').append(element('p', query ? 'No saved originals match this search.' : 'No saved originals yet.', 'empty'));
    if (id && !rows.some(c => c.id === id)) $('fort-entries').prepend(element('p', 'This original is unavailable in this workspace. Clear the search or check Engine Room recovery or a backup.', 'notice'));
    $('fort-refresh').hidden = true; counts();
  }
  $('fort-search-form').onsubmit = event => { event.preventDefault(); query = $('fort-search').value.trim(); selection = null; snapshot(null); };
  $('fort-clear').onclick = () => { $('fort-search').value = ''; query = ''; selection = null; snapshot(null); };
  $('fort-refresh').onclick = () => snapshot();
  $('fort-more').onclick = () => { const page = archiveWindow(rows, { offset: next }); $('fort-entries').append(...page.rows.map(card)); next = page.next; counts(); };
  $('fort-ef').onclick = () => setEF(!getEF());
  return {
    modeChanged() { if (!loaded) return; $('fort-entries').replaceChildren(...rows.slice(start, next).map(card)); if (!rows.length) $('fort-entries').append(element('p', query ? 'No saved originals match this search.' : 'No saved originals yet.', 'empty')); counts(); },
    enter(id = null) {
      if (!loaded || epoch !== getEpoch() || id !== selection) { if (id) { query = ''; $('fort-search').value = ''; } snapshot(id); }
      else this.update();
      if (id) requestAnimationFrame(() => { const node = $(`fort-${id}`); if (node) { node.focus({ preventScroll: true }); node.scrollIntoView({ block: 'start' }); } });
    },
    update() {
      if (!loaded) return;
      if (epoch !== getEpoch()) { snapshot(null); return; }
      const state = getState(); $('fort-refresh').hidden = signature === fingerprint(state.captures);
      // New arrivals never reorder a page being read. Invalidated originals are removed immediately.
      const valid = new Map(state.captures.map(c => [c.id, c.hash]));
      for (const row of rows.slice(start, next)) if (valid.get(row.id) !== row.hash) { const old = $(`fort-${row.id}`); if (old && !old.dataset.recovery) { const replacement = card(row); replacement.dataset.recovery = 'true'; old.replaceWith(replacement); } }
      counts();
    },
  };
}
