import assert from 'node:assert/strict';
import test from 'node:test';
import { readShareIntake } from '../public/share-intake.js';

test('share intake removes the payload from the URL even when the caller must retain another draft', () => {
  const intake = readShareIntake('https://example.test/public/?share=secret-token-123&keep=1#thread/a', 4000);
  assert.equal(intake.hadShare, true);
  assert.equal(intake.text, 'secret-token-123');
  assert.equal(intake.cleanPath, '/public/?keep=1#thread/a');
});

test('share intake removes an oversized payload rather than returning it to a composer', () => {
  const intake = readShareIntake(`https://example.test/public/?share=${'x'.repeat(11)}`, 10);
  assert.equal(intake.hadShare, true);
  assert.equal(intake.text, null);
  assert.equal(intake.cleanPath, '/public/#home');
});
