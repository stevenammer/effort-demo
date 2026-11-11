import assert from 'node:assert/strict';
import test from 'node:test';
import { safetySignal } from '../public/safety-routing.js';

test('red team: an explicit plan to kill the speaker receives the local safety note', () => {
  assert.equal(safetySignal('I have a plan to kill myself tonight.'), true);
});
