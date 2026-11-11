import assert from 'node:assert/strict';
import test from 'node:test';
import { startBrowserSpeech } from '../public/speech-capture.js';

test('red team: a recognition error must remain terminal instead of being followed by a success-like idle state', () => {
  class DeniedRecognition {
    start() {
      this.onerror({ error: 'not-allowed' });
      this.onend();
    }
  }
  const states = [];
  startBrowserSpeech({
    browser: { SpeechRecognition: DeniedRecognition, navigator: { language: 'en-US' } },
    onText: () => assert.fail('permission denial must not yield transcript text'),
    onState: state => states.push(state),
  });

  // The Capture UI interprets idle as "Voice transcript added as a draft".
  assert.deepEqual(states, ['error:not-allowed']);
});
