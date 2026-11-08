import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReadable, inline, readablePreview, safeUrl } from '../public/core/readable.js';
import { readingLink } from '../public/reading.js';
const textOf = tokens => tokens.map(t => t.text).join('');

test('native reader preserves identifiers, code punctuation and original source', () => {
  const source = '# Workshop\r\n\r\nUse **strong** and _emphasis_. Keep snake_case_value and `C# => x`.\r\n\r\n~~~js\r\n# code **stays**\r\n~~~';
  const before = source, blocks = parseReadable(source);
  assert.equal(blocks[0].type, 'heading'); assert.equal(textOf(blocks[0].content), 'Workshop');
  assert.ok(textOf(blocks[1].content).includes('snake_case_value')); assert.deepEqual(blocks[2], { type: 'code', text: '# code **stays**' });
  assert.equal(source, before); assert.ok(readablePreview(source).startsWith('Workshop'));
});
test('native tables and nested list indentation stay structured and previews stay bounded', () => {
  const blocks = parseReadable('- first\n  - nested\n- last\n\n| Name | Value |\n| --- | --- |\n| C# | #1 |');
  assert.equal(blocks[0].type, 'list'); assert.equal(blocks[0].items[1].indent, 2); assert.equal(blocks[1].type, 'table');
  assert.equal(textOf(blocks[1].rows[1][0]), 'C#'); assert.ok(readablePreview('x'.repeat(900), 80).length <= 80);
});
test('literal HTML stays text and unsupported schemes never become reading links', () => {
  const source = '<img src=x onerror=alert(1)>\n[bad](javascript:alert(1))\n[data](data:text/html,x)';
  assert.ok(textOf(parseReadable(source)[0].content).includes('<img src=x onerror=alert(1)>'));
  assert.equal(inline(source).filter(t => t.type === 'link').length, 0);
  for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'https://user:password@example.com', '//example.com', 'https://']) assert.equal(readingLink(url), null);
  assert.equal(safeUrl('javascript:alert(1)'), null); assert.equal(readingLink('https://example.com/path?q=1'), 'https://example.com/path?q=1');
});
test('sentence-ending URL punctuation stays visible and a heading marker requires a space', () => {
  assert.equal(textOf(inline('Read https://example.com. Then C# and #tag.')), 'Read https://example.com. Then C# and #tag.');
  assert.equal(parseReadable('C# is a language\n#tag is a tag')[0].type, 'paragraph');
  assert.deepEqual(parseReadable('```text\n```keep this line\n# code, not heading\n```'), [{ type: 'code', text: '```keep this line\n# code, not heading' }]);
});


test('source-linked thought and file routes are local links while malformed routes remain literal', () => {
  const id = '12345678-1234-4123-8123-123456789abc';
  for (const kind of ['thread', 'artifact']) { const url = `#${kind}/${id}`; assert.equal(readingLink(url), url); assert.deepEqual(inline(`[Reference](${url})`), [{ type: 'link', text: 'Reference', url }]); }
  for (const value of ['#artifact/no-id', `#artifact/${id}/../engine`, `#artifact/${id}?url=javascript:alert`, '#engine', '#thread/javascript:alert']) { assert.equal(readingLink(value), null); assert.equal(inline(`[Unsafe](${value})`).some(token => token.type === 'link'), false); }
});
