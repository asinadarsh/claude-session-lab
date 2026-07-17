'use strict';

const elements = {
  globalStatus: document.querySelector('#global-status'),
  globalStatusText: document.querySelector('#global-status-text'),
  panelState: document.querySelector('#panel-state'),
  inferenceState: document.querySelector('#inference-state'),
  timeline: [...document.querySelectorAll('#auth-timeline li')],
  prepareView: document.querySelector('#prepare-view'),
  authorizeView: document.querySelector('#authorize-view'),
  connectedView: document.querySelector('#connected-view'),
  startAuth: document.querySelector('#start-auth'),
  restartAuth: document.querySelector('#restart-auth'),
  authorizationLink: document.querySelector('#authorization-link'),
  authCountdown: document.querySelector('#auth-countdown'),
  codeForm: document.querySelector('#code-form'),
  codeInput: document.querySelector('#authorization-code'),
  codeError: document.querySelector('#code-error'),
  completeAuth: document.querySelector('#complete-auth'),
  accountEmail: document.querySelector('#account-email'),
  accountPlan: document.querySelector('#account-plan'),
  accessExpiry: document.querySelector('#access-expiry'),
  lockedCallout: document.querySelector('#locked-callout'),
  promptForm: document.querySelector('#prompt-form'),
  prompt: document.querySelector('#prompt'),
  promptCount: document.querySelector('#prompt-count'),
  promptError: document.querySelector('#prompt-error'),
  sendPrompt: document.querySelector('#send-prompt'),
  presetButtons: [...document.querySelectorAll('[data-prompt]')],
  responseCard: document.querySelector('#response-card'),
  responseOutput: document.querySelector('#response-output'),
  responseMeta: document.querySelector('#response-meta'),
  openDisconnect: document.querySelector('#open-disconnect'),
  disconnectDialog: document.querySelector('#disconnect-dialog'),
  cancelDisconnect: document.querySelector('#cancel-disconnect'),
  confirmDisconnect: document.querySelector('#confirm-disconnect'),
  toast: document.querySelector('#toast'),
};

const app = {
  csrfToken: null,
  status: null,
  authorizationUrl: null,
  phaseOverride: null,
  countdownTimer: null,
  toastTimer: null,
};

function setButtonBusy(button, busy, busyLabel) {
  if (!button) return;
  const label = button.querySelector('span');
  if (!button.dataset.defaultLabel && label) button.dataset.defaultLabel = label.textContent;
  button.disabled = busy;
  button.setAttribute('aria-busy', String(busy));
  button.classList.toggle('is-loading', busy);
  if (label) label.textContent = busy ? busyLabel : button.dataset.defaultLabel;
}

function showToast(message) {
  clearTimeout(app.toastTimer);
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  app.toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 5000);
}

function formatExpiry(timestamp) {
  if (!Number.isFinite(timestamp)) return 'Not reported';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(new Date(timestamp));
}

async function api(path, { method = 'GET', body = null, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { Accept: 'application/json' };
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    headers['X-CSRF-Token'] = app.csrfToken ?? '';
  }
  try {
    const response = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      body: body === null ? null : JSON.stringify(body),
      signal: controller.signal,
    });
    let payload = {};
    try { payload = await response.json(); } catch {}
    if (!response.ok) {
      const error = new Error(payload?.error?.message || 'The request could not be completed.');
      error.code = payload?.error?.code || 'REQUEST_FAILED';
      error.status = response.status;
      throw error;
    }
    return payload;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error('The request timed out. Check the VPS process and retry.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function timelinePhase() {
  if (app.phaseOverride) return app.phaseOverride;
  return app.status?.phase || 'prepare';
}

function renderTimeline() {
  const order = ['prepare', 'authorize', 'exchange', 'connected'];
  const current = order.indexOf(timelinePhase());
  elements.timeline.forEach((item) => {
    const index = order.indexOf(item.dataset.step);
    item.classList.toggle('is-complete', index < current || current === 3);
    item.classList.toggle('is-current', index === current);
    item.setAttribute('aria-current', index === current ? 'step' : 'false');
  });
}

function startCountdown(expiresAt) {
  clearInterval(app.countdownTimer);
  function update() {
    const remaining = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
    const minutes = String(Math.floor(remaining / 60)).padStart(2, '0');
    const seconds = String(remaining % 60).padStart(2, '0');
    elements.authCountdown.textContent = `${minutes}:${seconds}`;
    if (remaining <= 0) {
      clearInterval(app.countdownTimer);
      elements.authCountdown.textContent = 'Expired';
      elements.completeAuth.disabled = true;
      elements.codeError.textContent = 'This attempt expired. Prepare a new authorization link.';
      elements.restartAuth.hidden = false;
    }
  }
  update();
  app.countdownTimer = setInterval(update, 1000);
}

function render(status) {
  app.status = status;
  app.csrfToken = status.csrfToken;
  const connected = Boolean(status.connected);
  const pending = Boolean(status.authorizationPending && !connected);

  elements.prepareView.hidden = connected || pending;
  elements.authorizeView.hidden = connected || !pending;
  elements.connectedView.hidden = !connected;
  elements.lockedCallout.hidden = connected;
  elements.prompt.disabled = !connected;
  elements.sendPrompt.disabled = !connected;
  elements.presetButtons.forEach((button) => { button.disabled = !connected; });

  elements.globalStatus.dataset.state = connected ? 'connected' : 'disconnected';
  elements.globalStatusText.textContent = connected ? 'Test session connected' : (pending ? 'Authorization pending' : 'Not connected');
  elements.panelState.textContent = connected ? 'Connected' : (pending ? 'Pending' : 'Not connected');
  elements.panelState.classList.toggle('is-connected', connected);
  elements.inferenceState.textContent = connected ? 'Ready' : 'Locked';
  elements.inferenceState.classList.toggle('is-connected', connected);

  if (pending) {
    const hasUrl = Boolean(app.authorizationUrl);
    elements.authorizationLink.hidden = !hasUrl;
    elements.restartAuth.hidden = hasUrl;
    if (hasUrl) elements.authorizationLink.href = app.authorizationUrl;
    startCountdown(status.authorizationExpiresAt);
  } else {
    clearInterval(app.countdownTimer);
  }

  if (connected) {
    elements.accountEmail.textContent = status.account?.emailMasked || 'Verified test account';
    elements.accountPlan.textContent = status.account?.plan || status.account?.rateLimitTier || 'Subscription connected';
    elements.accessExpiry.textContent = formatExpiry(status.credentials?.accessExpiresAt);
  }

  renderTimeline();
}

async function loadStatus() {
  try {
    const status = await api('/api/auth/status');
    render(status);
  } catch (error) {
    elements.globalStatus.dataset.state = 'disconnected';
    elements.globalStatusText.textContent = 'Server unavailable';
    elements.codeError.textContent = error.message;
  }
}

async function prepareAuthorization(button) {
  elements.codeError.textContent = '';
  setButtonBusy(button, true, 'Preparing one-time link');
  try {
    const payload = await api('/api/auth/start', { method: 'POST', body: {} });
    app.authorizationUrl = payload.authorizationUrl;
    app.phaseOverride = null;
    render(payload.status);
    elements.authorizationLink.hidden = false;
    elements.authorizationLink.href = payload.authorizationUrl;
    elements.restartAuth.hidden = true;
    showToast('One-time authorization link prepared. Use the test account only.');
  } catch (error) {
    elements.codeError.textContent = error.message;
    showToast(error.message);
  } finally {
    setButtonBusy(button, false, 'Preparing one-time link');
  }
}

elements.startAuth.addEventListener('click', () => prepareAuthorization(elements.startAuth));
elements.restartAuth.addEventListener('click', () => prepareAuthorization(elements.restartAuth));
elements.authorizationLink.addEventListener('click', () => {
  setTimeout(() => elements.codeInput.focus(), 300);
});

elements.codeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const authorizationCode = elements.codeInput.value.trim();
  elements.codeError.textContent = '';
  if (!authorizationCode) {
    elements.codeError.textContent = 'Paste the authorization code before continuing.';
    elements.codeInput.focus();
    return;
  }

  app.phaseOverride = 'exchange';
  renderTimeline();
  setButtonBusy(elements.completeAuth, true, 'Exchanging securely');
  try {
    const payload = await api('/api/auth/complete', {
      method: 'POST',
      body: { authorizationCode },
      timeoutMs: 40000,
    });
    elements.codeInput.value = '';
    app.authorizationUrl = null;
    app.phaseOverride = null;
    render(payload.status);
    showToast('Test subscription connected. The prompt playground is ready.');
    elements.prompt.focus();
  } catch (error) {
    elements.codeInput.value = '';
    app.authorizationUrl = null;
    app.phaseOverride = null;
    elements.codeError.textContent = error.message;
    elements.restartAuth.hidden = false;
    elements.completeAuth.disabled = true;
    showToast(error.message);
    await loadStatus();
  } finally {
    setButtonBusy(elements.completeAuth, false, 'Exchanging securely');
  }
});

elements.prompt.addEventListener('input', () => {
  elements.promptCount.textContent = `${elements.prompt.value.length.toLocaleString()} / 12,000`;
  elements.promptError.textContent = '';
});

elements.presetButtons.forEach((button) => {
  button.addEventListener('click', () => {
    elements.prompt.value = button.dataset.prompt;
    elements.prompt.dispatchEvent(new Event('input'));
    elements.prompt.focus();
  });
});

elements.promptForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const prompt = elements.prompt.value.trim();
  elements.promptError.textContent = '';
  if (!prompt) {
    elements.promptError.textContent = 'Enter a prompt before running inference.';
    elements.prompt.focus();
    return;
  }

  setButtonBusy(elements.sendPrompt, true, 'Running isolated inference');
  elements.responseCard.hidden = true;
  try {
    const payload = await api('/api/chat', {
      method: 'POST',
      body: { prompt },
      timeoutMs: 130000,
    });
    const response = payload.response;
    elements.responseOutput.textContent = response.text || '(Claude returned an empty response.)';
    const meta = [response.model, Number.isFinite(response.durationMs) ? `${(response.durationMs / 1000).toFixed(1)}s` : null, Number.isFinite(response.outputTokens) ? `${response.outputTokens} output tokens` : null].filter(Boolean);
    elements.responseMeta.textContent = meta.join(' / ') || 'Completed';
    elements.responseCard.hidden = false;
    render(payload.status);
    elements.responseOutput.focus();
  } catch (error) {
    elements.promptError.textContent = error.message;
    showToast(error.message);
    if (error.status === 401) await loadStatus();
  } finally {
    setButtonBusy(elements.sendPrompt, false, 'Running isolated inference');
    elements.sendPrompt.disabled = !app.status?.connected;
  }
});

elements.openDisconnect.addEventListener('click', () => elements.disconnectDialog.showModal());
elements.cancelDisconnect.addEventListener('click', () => elements.disconnectDialog.close('cancel'));
elements.confirmDisconnect.addEventListener('click', async (event) => {
  event.preventDefault();
  setButtonBusy(elements.confirmDisconnect, true, 'Disconnecting');
  try {
    const payload = await api('/api/auth/disconnect', { method: 'POST', body: {}, timeoutMs: 10000 });
    app.authorizationUrl = null;
    app.phaseOverride = null;
    elements.responseCard.hidden = true;
    elements.prompt.value = '';
    elements.prompt.dispatchEvent(new Event('input'));
    render(payload.status);
    elements.disconnectDialog.close('default');
    showToast('The test session was removed from this VPS process.');
  } catch (error) {
    showToast(error.message);
  } finally {
    setButtonBusy(elements.confirmDisconnect, false, 'Disconnecting');
  }
});

elements.disconnectDialog.addEventListener('click', (event) => {
  if (event.target === elements.disconnectDialog) elements.disconnectDialog.close('cancel');
});

loadStatus();
