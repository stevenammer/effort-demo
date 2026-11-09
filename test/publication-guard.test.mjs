import test from 'node:test';
import assert from 'node:assert/strict';
import { scanPublicText, termHash } from '../scripts/check-public.mjs';

test('publication guard rejects local permission files and reports no credential values', () => {
  const sentinel = ['AI', 'za'].join('') + 'x'.repeat(35);
  const findings = scanPublicText('.claude/settings.local.json', JSON.stringify({ permissions: { allow: [`tool ${sentinel}`] } }));
  assert.deepEqual(findings.map((f) => f.rule).sort(), ['google-api-key', 'private-local-file']);
  assert.equal(JSON.stringify(findings).includes(sentinel), false);
  assert.deepEqual(scanPublicText('.env.example', 'GEMINI_API_KEY='), []);
});
test('publication guard rejects a planted private denylist fixture', () => {
  const salt = 'test-salt';
  const denylist = { configured: true, salt, hashes: new Set([termHash(salt, 'hidden phrase')]) };
  const findings = scanPublicText('fixture.txt', 'This has a hidden phrase.', denylist);
  assert.deepEqual(findings.map((finding) => finding.rule), ['private-denylist']);
});
test('publication guard covers historical session trailers and personal author metadata', () => {
  const trailer = ['Claude', '-Session:'].join('') + ' https://claude.ai/code/' + ['session_', 'synthetic'].join('');
  assert.ok(scanPublicText('[commit-metadata]', trailer).some((f) => f.rule === 'private-session-link'));
  const email = ['synthetic', '@', 'gmail', '.com'].join('');
  assert.ok(scanPublicText('[commit-metadata]', `author Example <${email}> 1 +0000`).some((f) => f.rule === 'personal-commit-email'));
});
