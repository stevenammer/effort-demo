import test from 'node:test';
import assert from 'node:assert/strict';
import { safetySignal } from '../public/safety-routing.js';
import { recognitionConstructor, startBrowserSpeech } from '../public/speech-capture.js';

test('local safety routing catches plain acute self-harm statements without catching ordinary work stress', () => {
  assert.equal(safetySignal('I want to end my life.'), true);
  assert.equal(safetySignal("I can't keep myself safe tonight."), true);
  assert.equal(safetySignal('I am stressed about my work deadline and need a break.'), false);
  assert.equal(safetySignal('This project is killing my schedule.'), false);
});

test('browser voice capture is unavailable honestly when the browser exposes no recognizer', () => {
  assert.equal(recognitionConstructor({}), null);
  assert.equal(startBrowserSpeech({browser:{}, onText:()=>{}}), null);
});

test('browser voice capture uses a fake recognizer and gives editable transcript text without storing audio', () => {
  let instance, state = [], heard = [];
  class FakeRecognition {
    constructor() { instance = this; }
    start() { this.onstart(); }
  }
  const recognition = startBrowserSpeech({browser:{SpeechRecognition:FakeRecognition,navigator:{language:'en-US'}},onText:(text,detail)=>heard.push({text,detail}),onState:value=>state.push(value)});
  assert.equal(recognition, instance);
  assert.equal(instance.continuous, false);
  assert.equal(instance.interimResults, true);
  instance.onresult({resultIndex:0,results:[Object.assign([{transcript:'Draft words'}],{isFinal:false})]});
  instance.onresult({resultIndex:0,results:[Object.assign([{transcript:'Final words'}],{isFinal:true})]});
  instance.onend();
  assert.deepEqual(state, ['listening','idle']);
  assert.equal(heard[0].text, 'Draft words');
  assert.equal(heard[1].text, 'Final words');
});
