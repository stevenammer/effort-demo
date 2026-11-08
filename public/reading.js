import { validRoute } from './intent.js';
import { parseReadable } from './core/readable.js';
export { readablePreview } from './core/readable.js';

// All markup is created from a small parser vocabulary. Source text is never HTML.
export function readingLink(value) {
  if (typeof value === 'string' && /^#(?:thread|artifact|branch)\//.test(value) && validRoute(value.slice(1))) return value;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.hostname && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
export function renderReading(text, { document: doc = globalThis.document, headingBase = 2, titleAlreadyShown } = {}) {
  const node = (tag, value, cls) => { const e = doc.createElement(tag); if (value !== undefined) e.textContent = value; if (cls) e.className = cls; return e; };
  const root = node('div', undefined, 'rich-reading');
  function inline(parent, tokens) {
    for (const token of tokens) {
      if (token.type === 'link') {
        const url = readingLink(token.url);
        if (url) { const link = node('a', token.text); link.href = url; if (url.startsWith('#')) link.dataset.localRoute = url.slice(1); else link.target = '_blank'; link.rel = 'noopener noreferrer'; link.referrerPolicy = 'no-referrer'; parent.append(link); }
        else parent.append(doc.createTextNode(token.text));
      } else if (['strong', 'em', 'code'].includes(token.type)) parent.append(node(token.type, token.text));
      else parent.append(doc.createTextNode(token.text));
    }
    return parent;
  }
  const blocks = parseReadable(text);
  for (const [index, block] of blocks.entries()) {
    if (index === 0 && block.type === 'heading' && block.content.map(t => t.text).join('') === titleAlreadyShown && !block.content.some(t => t.type === 'link')) continue;
    if (block.type === 'heading') root.append(inline(node(`h${Math.max(2, Math.min(6, headingBase + block.level - 1))}`), block.content));
    else if (block.type === 'paragraph') root.append(inline(node('p'), block.content));
    else if (block.type === 'quote') root.append(inline(node('blockquote'), block.content));
    else if (block.type === 'rule') root.append(node('hr'));
    else if (block.type === 'code') { const pre = node('pre'); pre.append(node('code', block.text)); root.append(pre); }
    else if (block.type === 'list') {
      const list = node(block.ordered ? 'ol' : 'ul'); const stack = [{ indent: block.items[0]?.indent ?? 0, list }];
      for (const item of block.items) {
        while (stack.length > 1 && item.indent < stack.at(-1).indent) stack.pop();
        if (item.indent > stack.at(-1).indent && stack.at(-1).list.lastElementChild) {
          const nested = node(block.ordered ? 'ol' : 'ul'); stack.at(-1).list.lastElementChild.append(nested); stack.push({ indent: item.indent, list: nested });
        }
        const li = inline(node('li'), item.content);
        if (block.ordered) {
          const marker = Number(item.marker);
          if (Number.isInteger(marker) && marker >= 0 && marker <= 2147483647) li.value = marker;
          else { li.classList.add('literal-list-marker'); li.prepend(node('span', `${item.marker}. `)); }
        }
        stack.at(-1).list.append(li);
      }
      root.append(list);
    } else if (block.type === 'table') {
      const wrap = node('div', undefined, 'reading-table'); wrap.tabIndex = 0; wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', 'Table. Scroll horizontally for more columns.');
      const table = node('table'), head = node('thead'), body = node('tbody');
      block.rows.forEach((row, index) => {
        const tr = node('tr'); for (const cell of row) { const td = inline(node(index === 0 ? 'th' : 'td'), cell); if (index === 0) td.scope = 'col'; tr.append(td); }
        (index === 0 ? head : body).append(tr);
      });
      table.append(head, body); wrap.append(table); root.append(wrap);
    }
  }
  return root;
}
