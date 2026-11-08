import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFragment, projectSemanticFragments } from '../public/core/semantic.js';
import { organizeText } from '../public/core/ef.js';

test('organisation keeps exact source ranges, Unicode and original ordering within categories', () => {
  const source = '  Maybe build a workshop exercise.\r\nI\'ll review the outline tomorrow.\nWhy does focus wander? 🧠\nI already sent the agenda.  ';
  const fragments = projectSemanticFragments('source', source);
  assert.ok(fragments.length >= 4);
  for (const f of fragments) { assert.equal(source.slice(f.start, f.end), f.quote); assert.ok(Object.isFrozen(f)); }
  const view = organizeText('source', source);
  assert.equal(view.fragmentCount, fragments.length);
  assert.deepEqual(view.sections.flatMap(s => s.items).map(i => i.quote).sort(), fragments.map(f => f.quote).sort());
});
test('a possibility, negation or completed action never becomes a stated commitment', () => {
  for (const text of ['Maybe build a practice tool someday.', "I don't need to book the room, it is already reserved.", 'I already sent the agenda.']) {
    assert.notEqual(classifyFragment(text).type, 'explicit_commitment');
  }
  assert.equal(classifyFragment("I'll review the outline tomorrow.").type, 'explicit_commitment');
  assert.equal(classifyFragment('What should the opening show?').type, 'question');
});
test('repeated projections cannot rewrite or mutate the original', () => {
  const source = '  A thought, exactly as typed.\n\nMaybe leave it alone?  ';
  const one = organizeText('same', source); const two = organizeText('same', source);
  assert.deepEqual(one, two); assert.equal(source, '  A thought, exactly as typed.\n\nMaybe leave it alone?  ');
});
