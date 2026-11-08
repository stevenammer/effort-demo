// Offline availability never blocks capture. Updates reload only on an explicit tap.
export async function setupOffline({ status, button, beforeUpdate, serviceWorker = globalThis.navigator?.serviceWorker }) {
  if (!serviceWorker) { status.textContent = 'Offline reopening is unavailable in this browser. Keep a downloaded backup.'; return; }
  let registration, applying = false, probing = 0, releaseWriting, updateTimeout;
  async function refresh() {
    const generation = ++probing;
    button.hidden = !registration?.waiting;
    if (registration?.waiting) { status.textContent = 'An update is ready. Your writing will be checked before reloading.'; return; }
    const controller = serviceWorker.controller;
    if (!controller) { status.textContent = registration?.installing && registration.installing.state !== 'redundant' || registration?.active?.state === 'activating' ? 'Preparing offline reopening. Keep this page open until it is ready.' : 'The offline copy could not be prepared. Reopen while connected; the current page still works.'; return; }
    const channel = new MessageChannel();
    const ready = await new Promise(resolve => {
      const timeout = setTimeout(() => resolve(false), 3000);
      channel.port1.onmessage = event => { clearTimeout(timeout); resolve(event.data?.ready === true); };
      controller.postMessage({type:'SHELL_STATUS'}, [channel.port2]);
    }).finally(() => channel.port1.close());
    if (generation === probing) status.textContent = ready ? 'Available offline in this browser. Browser storage can still be erased, so keep backups.' : 'The offline copy is unavailable. Reopen while connected and keep a backup.';
  }
  serviceWorker.addEventListener('controllerchange', () => { if (applying) location.reload(); else refresh().catch(() => {}); });
  try {
    registration = await serviceWorker.register(new URL('../sw.js', import.meta.url), {scope:new URL('../', import.meta.url).pathname, type:'module', updateViaCache:'none'});
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', () => { if (worker.state === 'installed' || worker.state === 'redundant') refresh().catch(() => {}); });
    });
    button.onclick = async () => {
      button.disabled = true;
      try {
        if (!registration.waiting) { await refresh(); return; }
        releaseWriting = await beforeUpdate();
        applying = true; status.textContent = 'Writing checked. Opening the update…';
        updateTimeout = setTimeout(() => { applying = false; releaseWriting?.(); status.textContent = 'The update is taking longer than expected. Your writing remains here.'; button.disabled = false; }, 10000);
        registration.waiting.postMessage({type:'APPLY_UPDATE'});
      } catch (error) { clearTimeout(updateTimeout); applying = false; releaseWriting?.(); status.textContent = `Update paused: ${error.message}`; }
      finally { if (!applying) button.disabled = false; }
    };
    await refresh();
  } catch {
    registration = await serviceWorker.getRegistration(new URL('../', import.meta.url)).catch(() => null);
    if (serviceWorker.controller) await refresh();
    else status.textContent = 'Offline reopening could not be prepared. The current page still works; keep a downloaded backup.';
  }
}
