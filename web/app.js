/**
 * ClawChat Web UI
 *
 * Single-page app that connects to a ClawChat daemon via WebSocket bridge.
 * Provides real-time messaging between agents in the P2P mesh.
 */

(function () {
  'use strict';

  // ─── State ─────────────────────────────────────────────────────

  const state = {
    ws: null,
    connected: false,
    authenticated: false,
    identities: [],         // { principal, nick }
    selectedIdentity: null,  // principal string
    peers: [],               // { principal, alias, connected, lastSeen }
    selectedPeer: null,      // principal string or '__all__' for all messages
    messages: new Map(),     // peerId -> Message[]
    allMessages: [],         // flat list of all messages
    unread: new Map(),       // peerId -> count
    nickname: '',
    reconnectAttempts: 0,
    reconnectTimer: null,
    wsUrl: '',
    authToken: '',
  };

  // ─── DOM References ────────────────────────────────────────────

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const dom = {
    // Screens
    connectScreen: $('#connect-screen'),
    chatScreen: $('#chat-screen'),
    // Connect form
    connectForm: $('#connect-form'),
    wsUrlInput: $('#ws-url'),
    authTokenInput: $('#auth-token'),
    nicknameInput: $('#nickname'),
    connectBtn: $('#connect-btn'),
    connectError: $('#connect-error'),
    connectStatus: $('#connect-status'),
    // Sidebar
    sidebar: $('#sidebar'),
    sidebarToggle: $('#sidebar-toggle'),
    mobileSidebarBtn: $('#mobile-sidebar-btn'),
    identitySelect: $('#identity-select'),
    peerList: $('#peer-list'),
    refreshPeers: $('#refresh-peers'),
    connectionStatus: $('#connection-status'),
    disconnectBtn: $('#disconnect-btn'),
    // Chat
    chatTitle: $('#chat-title'),
    chatSubtitle: $('#chat-subtitle'),
    messagesContainer: $('#messages-container'),
    messagesEl: $('#messages'),
    messageForm: $('#message-form'),
    messageInput: $('#message-input'),
    sendBtn: $('#send-btn'),
  };

  // ─── Initialization ────────────────────────────────────────────

  function init() {
    // Restore saved settings
    const saved = loadSettings();
    if (saved.wsUrl) dom.wsUrlInput.value = saved.wsUrl;
    if (saved.nickname) dom.nicknameInput.value = saved.nickname;
    if (saved.authToken) dom.authTokenInput.value = saved.authToken;

    // Auto-detect WebSocket URL
    if (!dom.wsUrlInput.value) {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      dom.wsUrlInput.value = `${proto}//${location.host}`;
    }

    // Event listeners
    dom.connectForm.addEventListener('submit', onConnect);
    dom.messageForm.addEventListener('submit', onSendMessage);
    dom.identitySelect.addEventListener('change', onIdentityChange);
    dom.refreshPeers.addEventListener('click', () => send({ type: 'peers', as: state.selectedIdentity }));
    dom.disconnectBtn.addEventListener('click', disconnect);
    dom.sidebarToggle.addEventListener('click', toggleSidebar);
    dom.mobileSidebarBtn.addEventListener('click', toggleSidebar);

    // Mobile overlay
    const overlay = document.createElement('div');
    overlay.className = 'sidebar-overlay';
    overlay.addEventListener('click', toggleSidebar);
    document.body.appendChild(overlay);

    // Keyboard shortcut
    dom.messageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        dom.messageInput.blur();
      }
    });
  }

  // ─── Settings Persistence ──────────────────────────────────────

  function loadSettings() {
    try {
      return JSON.parse(localStorage.getItem('clawchat_settings') || '{}');
    } catch { return {}; }
  }

  function saveSettings() {
    localStorage.setItem('clawchat_settings', JSON.stringify({
      wsUrl: state.wsUrl,
      nickname: state.nickname,
      authToken: state.authToken,
    }));
  }

  // ─── WebSocket Connection ──────────────────────────────────────

  function onConnect(e) {
    e.preventDefault();

    const url = dom.wsUrlInput.value.trim();
    const token = dom.authTokenInput.value.trim();
    const nickname = dom.nicknameInput.value.trim();

    if (!url) {
      showConnectError('Please enter a gateway URL');
      return;
    }

    state.wsUrl = url;
    state.authToken = token;
    state.nickname = nickname;
    saveSettings();

    connect(url, token, nickname);
  }

  function connect(url, token, nickname) {
    showConnectStatus('Connecting...');
    hideConnectError();
    dom.connectBtn.disabled = true;
    dom.connectBtn.textContent = 'Connecting...';

    try {
      const ws = new WebSocket(url);
      state.ws = ws;

      ws.onopen = () => {
        showConnectStatus('Connected, authenticating...');
        updateConnectionStatus('connecting');

        // Send auth
        send({
          type: 'auth',
          token: token || '',
          nickname: nickname || undefined,
        });
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          handleServerMessage(msg);
        } catch (err) {
          console.error('[clawchat] Failed to parse message:', err);
        }
      };

      ws.onclose = (event) => {
        state.connected = false;
        state.authenticated = false;

        if (state.reconnectAttempts > 0) {
          // We were connected before, try to reconnect
          scheduleReconnect();
        } else {
          // Never connected successfully
          dom.connectBtn.disabled = false;
          dom.connectBtn.textContent = 'Connect';
          hideConnectStatus();
          if (!event.wasClean) {
            showConnectError('Connection failed. Check the URL and try again.');
          }
        }

        updateConnectionStatus('disconnected');
      };

      ws.onerror = () => {
        // Error details come through onclose
      };
    } catch (err) {
      showConnectError('Invalid URL: ' + err.message);
      dom.connectBtn.disabled = false;
      dom.connectBtn.textContent = 'Connect';
    }
  }

  function disconnect() {
    clearReconnect();
    state.reconnectAttempts = 0;
    if (state.ws) {
      state.ws.close(1000);
      state.ws = null;
    }
    state.connected = false;
    state.authenticated = false;
    state.peers = [];
    state.messages.clear();
    state.allMessages = [];
    state.unread.clear();
    state.selectedPeer = null;

    showScreen('connect');
    dom.connectBtn.disabled = false;
    dom.connectBtn.textContent = 'Connect';
    hideConnectStatus();
    removeReconnectBanner();
  }

  function scheduleReconnect() {
    if (state.reconnectTimer) return;

    const delay = Math.min(1000 * Math.pow(2, state.reconnectAttempts - 1), 30000);
    showReconnectBanner(delay);
    updateConnectionStatus('connecting');

    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      state.reconnectAttempts++;
      connect(state.wsUrl, state.authToken, state.nickname);
    }, delay);
  }

  function clearReconnect() {
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    removeReconnectBanner();
  }

  // ─── Message Handling ──────────────────────────────────────────

  function send(msg) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify(msg));
    }
  }

  function handleServerMessage(msg) {
    switch (msg.type) {
      case 'auth_ok':
        onAuthOk(msg);
        break;
      case 'auth_fail':
        onAuthFail(msg);
        break;
      case 'message':
        onMessageReceived(msg.message);
        break;
      case 'inbox':
        onInboxReceived(msg.messages);
        break;
      case 'peers':
        onPeersReceived(msg.peers);
        break;
      case 'status':
        onStatusReceived(msg.data);
        break;
      case 'identities':
        onIdentitiesReceived(msg.identities);
        break;
      case 'peer_connected':
        onPeerStatusChange(msg.principal, true);
        break;
      case 'peer_disconnected':
        onPeerStatusChange(msg.principal, false);
        break;
      case 'error':
        console.warn('[clawchat] Server error:', msg.error, msg.requestType);
        break;
      case 'pong':
        break;
      default:
        console.log('[clawchat] Unknown message type:', msg.type);
    }
  }

  function onAuthOk(msg) {
    state.connected = true;
    state.authenticated = true;
    state.reconnectAttempts = 1; // Mark as "was connected" for reconnect logic
    clearReconnect();

    state.identities = msg.identities || [];
    if (state.identities.length > 0 && !state.selectedIdentity) {
      state.selectedIdentity = state.identities[0].principal;
    }

    updateIdentitySelect();
    showScreen('chat');
    updateConnectionStatus('connected');

    // Request initial data
    send({ type: 'peers', as: state.selectedIdentity });
    send({ type: 'inbox', as: state.selectedIdentity });

    // Select "All Messages" by default
    selectPeer('__all__');
  }

  function onAuthFail(msg) {
    showConnectError(msg.error || 'Authentication failed');
    dom.connectBtn.disabled = false;
    dom.connectBtn.textContent = 'Connect';
    hideConnectStatus();
  }

  function onMessageReceived(message) {
    if (!message) return;

    // Add to allMessages
    if (!state.allMessages.find(m => m.id === message.id)) {
      state.allMessages.push(message);
      state.allMessages.sort((a, b) => a.timestamp - b.timestamp);
    }

    // Determine the peer for this message (the "other" party)
    const isSelf = isOwnIdentity(message.from);
    const peerPrincipal = isSelf ? message.to : message.from;

    // Add to per-peer messages
    if (!state.messages.has(peerPrincipal)) {
      state.messages.set(peerPrincipal, []);
    }
    const peerMessages = state.messages.get(peerPrincipal);
    if (!peerMessages.find(m => m.id === message.id)) {
      peerMessages.push(message);
      peerMessages.sort((a, b) => a.timestamp - b.timestamp);
    }

    // Update unread count if not viewing this peer
    if (state.selectedPeer !== peerPrincipal && state.selectedPeer !== '__all__') {
      state.unread.set(peerPrincipal, (state.unread.get(peerPrincipal) || 0) + 1);
      renderPeerList();
    }

    // Re-render messages if viewing this peer or all messages
    if (state.selectedPeer === peerPrincipal || state.selectedPeer === '__all__') {
      renderMessages();
      scrollToBottom();
    }

    // Auto-add peer if not in list
    if (!state.peers.find(p => p.principal === peerPrincipal)) {
      state.peers.push({
        principal: peerPrincipal,
        alias: message.fromNick || undefined,
        connected: false,
      });
      renderPeerList();
    }
  }

  function onInboxReceived(messages) {
    if (!Array.isArray(messages)) return;

    for (const msg of messages) {
      onMessageReceived(msg);
    }
  }

  function onPeersReceived(peers) {
    if (!Array.isArray(peers)) return;

    state.peers = peers;
    renderPeerList();
  }

  function onStatusReceived(data) {
    // Could be used for status display
    console.log('[clawchat] Status:', data);
  }

  function onIdentitiesReceived(identities) {
    state.identities = identities || [];
    updateIdentitySelect();
  }

  function onPeerStatusChange(principal, connected) {
    const peer = state.peers.find(p => p.principal === principal);
    if (peer) {
      peer.connected = connected;
      peer.lastSeen = Date.now();
      renderPeerList();
    }

    // Add system message
    const systemMsg = {
      id: `sys_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      from: '__system__',
      to: '',
      content: `${formatPeerName(principal)} ${connected ? 'connected' : 'disconnected'}`,
      timestamp: Date.now(),
      status: 'delivered',
    };

    state.allMessages.push(systemMsg);

    if (state.selectedPeer === '__all__' || state.selectedPeer === principal) {
      renderMessages();
      scrollToBottom();
    }
  }

  // ─── UI Rendering ──────────────────────────────────────────────

  function showScreen(name) {
    dom.connectScreen.classList.toggle('active', name === 'connect');
    dom.chatScreen.classList.toggle('active', name === 'chat');
  }

  function showConnectError(text) {
    dom.connectError.textContent = text;
    dom.connectError.hidden = false;
  }

  function hideConnectError() {
    dom.connectError.hidden = true;
  }

  function showConnectStatus(text) {
    dom.connectStatus.textContent = text;
    dom.connectStatus.hidden = false;
  }

  function hideConnectStatus() {
    dom.connectStatus.hidden = true;
  }

  function updateConnectionStatus(status) {
    const dot = dom.connectionStatus.querySelector('.status-dot');
    const label = dom.connectionStatus.querySelector('.status-label');

    dot.className = 'status-dot ' + status;
    const labels = { connected: 'Connected', connecting: 'Connecting...', disconnected: 'Disconnected' };
    label.textContent = labels[status] || status;
  }

  function showReconnectBanner(delay) {
    removeReconnectBanner();
    const banner = document.createElement('div');
    banner.className = 'reconnecting-banner';
    banner.id = 'reconnect-banner';
    banner.textContent = `Reconnecting in ${Math.ceil(delay / 1000)}s...`;
    document.body.appendChild(banner);
  }

  function removeReconnectBanner() {
    const banner = document.getElementById('reconnect-banner');
    if (banner) banner.remove();
  }

  function updateIdentitySelect() {
    dom.identitySelect.innerHTML = '';
    for (const id of state.identities) {
      const opt = document.createElement('option');
      opt.value = id.principal;
      opt.textContent = id.nick || truncatePrincipal(id.principal);
      opt.title = id.principal;
      if (id.principal === state.selectedIdentity) {
        opt.selected = true;
      }
      dom.identitySelect.appendChild(opt);
    }
  }

  function onIdentityChange() {
    state.selectedIdentity = dom.identitySelect.value;
    // Reload data for new identity
    send({ type: 'peers', as: state.selectedIdentity });
    send({ type: 'inbox', as: state.selectedIdentity });
  }

  function renderPeerList() {
    dom.peerList.innerHTML = '';

    // "All Messages" special item
    const allItem = createPeerItem('__all__', '📋 All Messages', '', false, getAllUnreadCount());
    if (state.selectedPeer === '__all__') allItem.classList.add('active');
    allItem.classList.add('all-messages');
    dom.peerList.appendChild(allItem);

    if (state.peers.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'empty-state';
      empty.textContent = 'No peers yet';
      dom.peerList.appendChild(empty);
      return;
    }

    // Sort: connected first, then alphabetical
    const sorted = [...state.peers].sort((a, b) => {
      if (a.connected !== b.connected) return b.connected ? 1 : -1;
      const nameA = a.alias || a.principal;
      const nameB = b.alias || b.principal;
      return nameA.localeCompare(nameB);
    });

    for (const peer of sorted) {
      const name = peer.alias || truncatePrincipal(peer.principal);
      const unread = state.unread.get(peer.principal) || 0;
      const item = createPeerItem(peer.principal, name, peer.principal, peer.connected, unread);
      if (state.selectedPeer === peer.principal) item.classList.add('active');
      dom.peerList.appendChild(item);
    }
  }

  function createPeerItem(principal, name, subtitle, connected, unread) {
    const li = document.createElement('li');
    li.className = 'peer-item';
    li.addEventListener('click', () => selectPeer(principal));

    if (principal !== '__all__') {
      const dot = document.createElement('span');
      dot.className = `peer-status-dot ${connected ? 'online' : 'offline'}`;
      li.appendChild(dot);
    }

    const info = document.createElement('div');
    info.className = 'peer-info';

    const nameEl = document.createElement('div');
    nameEl.className = 'peer-name';
    nameEl.textContent = name;
    info.appendChild(nameEl);

    if (subtitle && principal !== '__all__') {
      const subEl = document.createElement('div');
      subEl.className = 'peer-principal';
      subEl.textContent = truncatePrincipal(subtitle);
      subEl.title = subtitle;
      info.appendChild(subEl);
    }

    li.appendChild(info);

    if (unread > 0) {
      const badge = document.createElement('span');
      badge.className = 'peer-badge';
      badge.textContent = unread > 99 ? '99+' : unread;
      li.appendChild(badge);
    }

    return li;
  }

  function selectPeer(principal) {
    state.selectedPeer = principal;

    // Clear unread for this peer
    if (principal !== '__all__') {
      state.unread.delete(principal);
    } else {
      state.unread.clear();
    }

    // Update header
    if (principal === '__all__') {
      dom.chatTitle.textContent = 'All Messages';
      dom.chatSubtitle.textContent = 'Mesh-wide message feed';
    } else {
      const peer = state.peers.find(p => p.principal === principal);
      dom.chatTitle.textContent = peer?.alias || truncatePrincipal(principal);
      dom.chatSubtitle.textContent = principal;
      dom.chatSubtitle.title = principal;
    }

    // Enable message input
    const canSend = principal !== '__all__';
    dom.messageInput.disabled = !canSend;
    dom.sendBtn.disabled = !canSend;
    dom.messageInput.placeholder = canSend ? 'Type a message...' : 'Select a specific peer to send messages';

    if (canSend) {
      dom.messageInput.focus();
    }

    renderPeerList();
    renderMessages();
    scrollToBottom();

    // Close mobile sidebar
    closeSidebar();
  }

  function renderMessages() {
    const messages = state.selectedPeer === '__all__'
      ? state.allMessages
      : (state.messages.get(state.selectedPeer) || []);

    if (messages.length === 0) {
      dom.messagesEl.innerHTML = `
        <div class="empty-chat">
          <p>🐾 No messages yet</p>
          <p class="muted">${state.selectedPeer === '__all__' ? 'Messages will appear here as they flow through the mesh.' : 'Start the conversation!'}</p>
        </div>
      `;
      return;
    }

    dom.messagesEl.innerHTML = '';
    let lastDate = '';

    for (const msg of messages) {
      // Date separator
      const msgDate = new Date(msg.timestamp).toLocaleDateString();
      if (msgDate !== lastDate) {
        lastDate = msgDate;
        const sep = document.createElement('div');
        sep.className = 'date-separator';
        sep.innerHTML = `<span>${formatDateSeparator(msg.timestamp)}</span>`;
        dom.messagesEl.appendChild(sep);
      }

      const el = createMessageElement(msg);
      dom.messagesEl.appendChild(el);
    }
  }

  function createMessageElement(msg) {
    const div = document.createElement('div');

    if (msg.from === '__system__') {
      div.className = 'message system';
      div.innerHTML = `<div class="message-content">${escapeHtml(msg.content)}</div>`;
      return div;
    }

    const isSelf = isOwnIdentity(msg.from);
    div.className = `message ${isSelf ? 'self' : 'other'}`;

    const header = document.createElement('div');
    header.className = 'message-header';

    const sender = document.createElement('span');
    sender.className = 'message-sender';
    sender.textContent = isSelf ? 'You' : (msg.fromNick || formatPeerName(msg.from));
    header.appendChild(sender);

    const time = document.createElement('span');
    time.className = 'message-time';
    time.textContent = formatRelativeTime(msg.timestamp);
    time.title = new Date(msg.timestamp).toLocaleString();
    header.appendChild(time);

    div.appendChild(header);

    const content = document.createElement('div');
    content.className = 'message-content';
    content.textContent = msg.content;
    div.appendChild(content);

    return div;
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      dom.messagesContainer.scrollTop = dom.messagesContainer.scrollHeight;
    });
  }

  // ─── Send Message ──────────────────────────────────────────────

  function onSendMessage(e) {
    e.preventDefault();

    const content = dom.messageInput.value.trim();
    if (!content || !state.selectedPeer || state.selectedPeer === '__all__') return;

    send({
      type: 'send',
      to: state.selectedPeer,
      content: content,
      as: state.selectedIdentity,
    });

    // Optimistically add message to UI
    const optimisticMsg = {
      id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      from: state.selectedIdentity,
      fromNick: state.nickname || undefined,
      to: state.selectedPeer,
      content: content,
      timestamp: Date.now(),
      status: 'pending',
    };

    onMessageReceived(optimisticMsg);

    dom.messageInput.value = '';
    dom.messageInput.focus();
  }

  // ─── Sidebar ───────────────────────────────────────────────────

  function toggleSidebar() {
    const isOpen = dom.sidebar.classList.contains('open');
    if (isOpen) {
      closeSidebar();
    } else {
      dom.sidebar.classList.add('open');
      document.querySelector('.sidebar-overlay').classList.add('active');
    }
  }

  function closeSidebar() {
    dom.sidebar.classList.remove('open');
    document.querySelector('.sidebar-overlay').classList.remove('active');
  }

  // ─── Helpers ───────────────────────────────────────────────────

  function isOwnIdentity(principal) {
    return state.identities.some(id => id.principal === principal);
  }

  function formatPeerName(principal) {
    // Check peers for alias
    const peer = state.peers.find(p => p.principal === principal);
    if (peer?.alias) return peer.alias;

    // Check identities for nick
    const id = state.identities.find(i => i.principal === principal);
    if (id?.nick) return id.nick;

    return truncatePrincipal(principal);
  }

  function truncatePrincipal(principal) {
    if (!principal) return '???';
    // local:abc123def456... -> local:abc123...456
    // stacks:ST1ABC...XYZ -> stacks:ST1AB...XYZ
    if (principal.length <= 24) return principal;
    const prefix = principal.slice(0, 16);
    const suffix = principal.slice(-6);
    return `${prefix}…${suffix}`;
  }

  function getAllUnreadCount() {
    let total = 0;
    for (const count of state.unread.values()) {
      total += count;
    }
    return total;
  }

  function formatRelativeTime(timestamp) {
    const now = Date.now();
    const diff = now - timestamp;

    if (diff < 60000) return 'now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;

    return new Date(timestamp).toLocaleDateString();
  }

  function formatDateSeparator(timestamp) {
    const date = new Date(timestamp);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    if (date.toDateString() === today.toDateString()) return 'Today';
    if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';

    return date.toLocaleDateString(undefined, {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
    });
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ─── Heartbeat ─────────────────────────────────────────────────

  setInterval(() => {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      send({ type: 'ping' });
    }
  }, 30000);

  // ─── Update relative times periodically ────────────────────────

  setInterval(() => {
    const timeEls = dom.messagesEl.querySelectorAll('.message-time');
    // Only update if there are visible messages
    if (timeEls.length > 0 && state.selectedPeer) {
      // Re-render is cheap enough for the message count we'll have
      renderMessages();
    }
  }, 60000);

  // ─── Start ─────────────────────────────────────────────────────

  init();

})();
