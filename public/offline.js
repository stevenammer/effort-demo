// Offline availability never blocks capture. Updates reload only on an explicit tap.
export async function setupOffline({ status, button, beforeUpdate, serviceWorker = globalThis.navigator?.serviceWorker }) {
  if (!serviceWorker) { status.textContent = 'Offline reopening is unavailable in this browser. Keep a downloaded backup.'; return; }
  let registration, applying = false, probing = 0, releaseWriting, updateTimeout, retryTimeout, failedProbes = 0, claimAttempts = 0, lastController, stopped = false;
  const watched = new Map();
  async function refresh() {
    if (stopped) return;
    clearTimeout(retryTimeout);
    const generation = ++probing;
    button.hidden = !registration?.waiting;
    if (registration?.waiting) { status.textContent = 'An update is ready. Your writing will be checked before reloading.'; return; }
    const controller = serviceWorker.controller;
    if (controller !== lastController) { lastController = controller; failedProbes = 0; }
    if (!controller) {
      if (registration?.active?.state === 'activated' && claimAttempts < 3) {
        // Activation can finish between a reload and client discovery. Adoption never reloads a page.
        claimAttempts++;
        try { registration.active.postMessage({ type: 'CLAIM_CLIENTS' }); } catch {}
        status.textContent = 'Connecting this page to its offline worker. Writing remains available.';
        retryTimeout = setTimeout(() => refresh().catch(() => {}), claimAttempts * 250);
      } else status.textContent = registration?.installing && registration.installing.state !== 'redundant' || registration?.active?.state === 'activating' ? 'Preparing offline reopening. Keep this page open until it is ready.' : 'The page could not connect to its offline worker. Reopen while connected; writing remains available.';
      return;
    }
    claimAttempts = 0;
    const channel = new MessageChannel(); let timeout;
    const ready = await new Promise(resolve => {
      timeout = setTimeout(() => resolve(false), 3000);
      channel.port1.onmessage = event => resolve(event.data?.ready === true);
      controller.postMessage({ type: 'SHELL_STATUS' }, [channel.port2]);
    }).catch(() => false).finally(() => { clearTimeout(timeout); channel.port1.close(); });
    if (stopped || generation !== probing) return;
    if (ready) { failedProbes = 0; status.textContent = 'Available offline in this browser. Browser storage can still be erased, so keep backups.'; }
    else if (++failedProbes < 3) { status.textContent = 'Offline readiness has not been confirmed. Checking again; writing remains available.'; retryTimeout = setTimeout(() => refresh().catch(() => {}), failedProbes * 250); }
    else status.textContent = 'The offline copy is unavailable. Reopen while connected and keep a backup.';
  }
  function observe(worker, refreshNow = true) {
    if (!worker || watched.has(worker)) return;
    const changed = () => { if (['installed', 'redundant', 'activated'].includes(worker.state)) refresh().catch(() => {}); };
    watched.set(worker, changed); worker.addEventListener('statechange', changed);
    if (refreshNow && ['installed', 'redundant', 'activated'].includes(worker.state)) changed();
  }
  const controllerChanged = () => { if (stopped) return; if (applying) location.reload(); else refresh().catch(() => {}); };
  const updateFound = () => observe(registration?.installing);
  serviceWorker.addEventListener('controllerchange', controllerChanged);
  try { registration = await serviceWorker.register(new URL('../sw.js', import.meta.url), { scope: new URL('../', import.meta.url).pathname, type: 'module', updateViaCache: 'none' }); }
  catch { try { registration = await serviceWorker.getRegistration?.(new URL('../', import.meta.url)); } catch {} }
  if (registration) { registration.addEventListener('updatefound', updateFound); observe(registration.installing); observe(registration.active, false); }
  button.onclick = async () => {
    button.disabled = true;
    try {
      if (!registration?.waiting) { failedProbes = 0; await refresh(); return; }
      releaseWriting = await beforeUpdate();
      applying = true; status.textContent = 'Writing checked. Opening the update…';
      updateTimeout = setTimeout(() => { applying = false; releaseWriting?.(); status.textContent = 'The update is taking longer than expected. Your writing remains here.'; button.disabled = false; }, 10000);
      registration.waiting.postMessage({ type: 'APPLY_UPDATE' });
    } catch (error) { clearTimeout(updateTimeout); applying = false; releaseWriting?.(); status.textContent = `Update paused: ${error.message}`; }
    finally { if (!applying) button.disabled = false; }
  };
  await refresh();
  return () => { stopped = true; probing++; clearTimeout(retryTimeout); clearTimeout(updateTimeout); serviceWorker.removeEventListener?.('controllerchange', controllerChanged); registration?.removeEventListener?.('updatefound', updateFound); for (const [worker, listener] of watched) worker.removeEventListener?.('statechange', listener); };
}
