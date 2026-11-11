import assert from 'node:assert/strict';
import test from 'node:test';
import { THREAD_WINDOW, boundedWindow } from '../public/windowed-list.js';

test('red team: a configured thread DOM window never grows beyond its configured bound', () => {
  // renderThread replaces the complete DOM list with page.rows. A real window
  // must therefore remain capped even as the user asks for another page.
  const rows = Array.from({ length: THREAD_WINDOW + 1 }, (_, id) => ({ id }));
  const page = boundedWindow(rows, THREAD_WINDOW, THREAD_WINDOW);
  assert.ok(page.rows.length <= THREAD_WINDOW);
});
