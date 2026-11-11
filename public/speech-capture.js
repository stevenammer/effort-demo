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
  let finalText = '';
  recognition.onstart = () => onState('listening');
  recognition.onresult = event => {
    let interim = '';
    for (let index = event.resultIndex ?? 0; index < event.results.length; index += 1) {
      const result = event.results[index];
      if (result.isFinal) finalText += result[0].transcript;
      else interim += result[0].transcript;
    }
    onText(finalText + interim, { final: Boolean(finalText), interim });
  };
  recognition.onerror = event => onState(`error:${event.error || 'unavailable'}`);
  recognition.onend = () => onState('idle');
  recognition.start();
  return recognition;
}
