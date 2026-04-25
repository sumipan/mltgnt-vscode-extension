// @ts-check
(function () {
  const vscode = acquireVsCodeApi();
  /** @type {{ session: string|null, sessions: any[] }} */
  const state = vscode.getState() || { session: null, sessions: [] };

  const $messages = document.getElementById('messages');
  const $input = /** @type {HTMLTextAreaElement} */ (document.getElementById('input'));
  const $send = /** @type {HTMLButtonElement} */ (document.getElementById('send'));
  const $sessions = document.getElementById('sessions');
  const $newTopic = /** @type {HTMLInputElement} */ (document.getElementById('new-topic'));
  const $newBtn = /** @type {HTMLButtonElement} */ (document.getElementById('new-btn'));
  const $current = document.getElementById('current-session');
  const $activeFile = document.getElementById('active-file');

  /** @type {HTMLElement|null} */
  let streamingEl = null;

  function appendMsg(role, text) {
    const el = document.createElement('div');
    el.className = 'msg ' + role;
    el.textContent = text;
    $messages.appendChild(el);
    $messages.scrollTop = $messages.scrollHeight;
    return el;
  }

  function appendChunk(text) {
    if (!streamingEl) {
      streamingEl = appendMsg('assistant', '');
    }
    streamingEl.textContent += (streamingEl.textContent ? '\n' : '') + text;
    $messages.scrollTop = $messages.scrollHeight;
  }

  function finishStream() {
    streamingEl = null;
    $send.disabled = !$input.value.trim() || !state.session;
  }

  function refreshSendDisabled() {
    $send.disabled = !$input.value.trim() || !state.session;
  }

  function selectSession(name) {
    state.session = name;
    vscode.setState(state);
    $current.textContent = name || '(none)';
    document.querySelectorAll('.session-item').forEach((el) => {
      el.classList.toggle('active', el.getAttribute('data-name') === name);
    });
    $messages.innerHTML = '';
    streamingEl = null;
    refreshSendDisabled();
  }

  function renderSessions(items) {
    state.sessions = items;
    vscode.setState(state);
    $sessions.innerHTML = '';
    for (const it of items) {
      const el = document.createElement('div');
      el.className = 'session-item';
      el.setAttribute('data-name', it.session);
      el.textContent = it.session;
      el.addEventListener('click', () => selectSession(it.session));
      if (state.session === it.session) el.classList.add('active');
      $sessions.appendChild(el);
    }
  }

  $send.addEventListener('click', () => {
    const text = $input.value;
    if (!text.trim() || !state.session) return;
    vscode.postMessage({ type: 'send', session: state.session, text });
    $input.value = '';
    refreshSendDisabled();
  });

  $input.addEventListener('input', refreshSendDisabled);
  $input.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      $send.click();
    }
  });

  $newBtn.addEventListener('click', () => {
    const topic = $newTopic.value.trim();
    if (!topic) return;
    vscode.postMessage({ type: 'newSession', topic });
    $newTopic.value = '';
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'sessions':
        renderSessions(msg.items);
        return;
      case 'activeFile':
        $activeFile.textContent = msg.relpath ? `active: ${msg.relpath}` : 'active: (none)';
        return;
      case 'userEcho':
        appendMsg('user', msg.text);
        return;
      case 'chunk':
        appendChunk(msg.text);
        return;
      case 'done':
        finishStream();
        return;
      case 'error':
        appendMsg('error', `error: ${msg.message}`);
        finishStream();
        return;
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
