// Browser speech recognition is optional. This module stores no audio and makes no requests.
export function recognitionConstructor(browser = globalThis) {
  return browser.SpeechRecognition ?? browser.webkitSpeechRecognition ?? null;
}

export function startBrowserSpeech({ browser = globalThis, onText, onState = () => {} } = {}) {
  const Recognition = recognitionConstructor(browser);
  if (!Recognition) return null;
  const recognition = new Recognition();
  recognition.lang = browser.navigator?.language || 'en-US';
  recognition.continuous = false;
  recognition.interimResults = true;
  let finalText = '', receivedText = false, failed = false;
  recognition.onstart = () => onState('listening');
  recognition.onresult = event => {
    let interim = '';
    for (let index = event.resultIndex ?? 0; index < event.results.length; index += 1) {
      const result = event.results[index];
      if (result.isFinal) finalText += result[0].transcript;
      else interim += result[0].transcript;
    }
    const text = finalText + interim;
    if (text.trim()) receivedText = true;
    onText(text, { final: Boolean(finalText), interim });
  };
  recognition.onerror = event => { failed = true; onState(`error:${event.error || 'unavailable'}`); };
  // Recognition commonly emits `end` after an error. Do not turn a denial or
  // unavailable result into a success-like idle state unless usable text arrived.
  recognition.onend = () => { if (!failed || receivedText) onState('idle'); };
  recognition.start();
  return recognition;
}
