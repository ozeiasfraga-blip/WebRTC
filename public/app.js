'use strict';

/**
 * Sala de Tela — cliente.
 *
 * Topologia em malha (mesh): cada participante abre uma RTCPeerConnection
 * direta com cada outro participante. Cada conexão tem 2 transceptores fixos
 * (vídeo = tela compartilhada, áudio = microfone + áudio da tela misturados),
 * então nunca é preciso renegociar a sessão: basta trocar a trilha com
 * replaceTrack() quando alguém começa ou para de compartilhar.
 */

(() => {
  /* ------------------------------------------------------------------ */
  /* utilidades                                                          */
  /* ------------------------------------------------------------------ */

  const $ = (sel) => document.querySelector(sel);
  const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const LS_NAME = 'sala-de-tela:nome';
  const LS_TECH = 'sala-de-tela:tecnico';
  const LS_COMPAT = 'sala-de-tela:compat';
  const LS_MUTE = 'sala-de-tela:mudo';
  const AUDIO_MAX = 1; // ganho máximo do mix

  // Funciona tanto na raiz (localhost:8090) quanto em subpasta (ex.: /sala/ no Apache).
  const BASE_PATH = location.pathname.replace(/[^/]*$/, '');

  const randomCode = (n = 4) =>
    Array.from({ length: n }, () => ROOM_CHARS[Math.floor(Math.random() * ROOM_CHARS.length)]).join('');

  const initials = (name) => {
    const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  };

  const timeStr = (ts) =>
    new Date(ts || Date.now()).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

  const MUTED_SVG =
    '<svg class="muted-ico" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 3l16 18"/><path d="M9 9v2a3 3 0 0 0 4.6 2.6M15 10V6a3 3 0 0 0-5.2-2"/><path d="M5.5 11.5a6.5 6.5 0 0 0 10.9 4.9"/></svg>';

  /* ------------------------------------------------------------------ */
  /* estado                                                              */
  /* ------------------------------------------------------------------ */

  const state = {
    ws: null,
    selfId: null,
    selfTile: null,
    name: '',
    room: '',
    maxPeers: 8,
    iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
    peers: new Map(),
    share: { stream: null, track: null },
    mic: { stream: null, track: null, enabled: false },
    mix: { ctx: null, dest: null, micGain: null, screenGain: null, micSrc: null, screenSrc: null, track: null },
    maxBitrate: 2500000,
    compat: false,
    muted: false, // mudo do áudio RECEBIDO (só afeta este navegador)
    chatOpen: false,
    unread: 0,
    spotlightId: null,
    role: 'client', // 'client' | 'tech'
    agent: { code: null, connected: false, host: null },
    tech: { peerId: null, status: 'idle', keys: false }, // quando EU sou o técnico
    ctrlIn: null, // quando EU sou o assistido: { techId, name }
    pendingAsk: null, // pedido de controle aguardando resposta
  };

  /* ------------------------------------------------------------------ */
  /* elementos                                                           */
  /* ------------------------------------------------------------------ */

  const lobby = $('#lobby');
  const call = $('#call');
  const nameInput = $('#nameInput');
  const roomInput = $('#roomInput');
  const joinForm = $('#joinForm');
  const joinBtn = $('#joinBtn');
  const randomRoom = $('#randomRoom');
  const lobbyMsg = $('#lobbyMsg');
  const insecureWarn = $('#insecureWarn');

  const mainArea = $('#mainArea');
  const stage = $('#stage');
  const stageHint = $('#stageHint');
  const roomCodeEl = $('#roomCode');
  const peopleCount = $('#peopleCount');
  const copyBtn = $('#copyBtn');
  const liveDot = $('#liveDot');
  const connBanner = $('#connBanner');
  const connBannerText = $('#connBannerText');
  const audioSink = $('#audioSink');

  const sharingBtn = $('#shareBtn');
  const micBtn = $('#micBtn');
  const audioBtn = $('#audioBtn');
  const leaveBtn = $('#leaveBtn');
  const qualitySel = $('#qualitySel');
  const chatToggle = $('#chatToggle');
  const chatPanel = $('#chatPanel');
  const chatClose = $('#chatClose');
  const chatBadge = $('#chatBadge');
  const chatForm = $('#chatForm');
  const chatInput = $('#chatInput');
  const messagesEl = $('#messages');

  const toastEl = $('#toast');
  const fsNote = $('#fsNote');

  // suporte remoto
  const techModeEl = $('#techMode');
  const ctrlBanner = $('#ctrlBanner');
  const ctrlBannerText = $('#ctrlBannerText');
  const ctrlStopBtn = $('#ctrlStopBtn');
  const techBar = $('#techBar');
  const techAskBtn = $('#techAskBtn');
  const techStatusEl = $('#techStatus');
  const techKeysBtn = $('#techKeysBtn');
  const techReleaseBtn = $('#techReleaseBtn');
  const techText = $('#techText');
  const techTextBtn = $('#techTextBtn');
  const techPasteEl = techText.closest('.tech-paste');
  const supportBtn = $('#supportBtn');
  const supportPanel = $('#supportPanel');
  const supportClose = $('#supportClose');
  const agentCodeEl = $('#agentCode');
  const agentGenBtn = $('#agentGenBtn');
  const agentDownload = $('#agentDownload');
  const agentStatusEl = $('#agentStatus');
  const agentStatusText = $('#agentStatusText');
  const ctrlAsk = $('#ctrlAsk');
  const ctrlAskWho = $('#ctrlAskWho');
  const ctrlAllow = $('#ctrlAllow');
  const ctrlDeny = $('#ctrlDeny');

  // aviso de captura preta
  const captureWarn = $('#captureWarn');
  const captureWarnCompat = $('#captureWarnCompat');
  const captureWarnHelp = $('#captureWarnHelp');
  const captureWarnClose = $('#captureWarnClose');
  const captureHelp = $('#captureHelp');
  const compatBrowser = $('#compatBrowser');
  const diagBtn = $('#diagBtn');

  /* ------------------------------------------------------------------ */
  /* toast / chat                                                        */
  /* ------------------------------------------------------------------ */

  let toastTimer = 0;
  function toast(text, ms = 3400) {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
  }

  function pushMessage({ name, text, ts, self = false, system = false }) {
    const wrap = document.createElement('div');
    wrap.className = 'msg' + (self ? ' self' : '') + (system ? ' system' : '');

    if (system) {
      wrap.textContent = text;
    } else {
      const head = document.createElement('div');
      head.className = 'msg-head';
      const who = document.createElement('span');
      who.className = 'msg-name';
      who.textContent = self ? 'Você' : name;
      const when = document.createElement('span');
      when.className = 'msg-time';
      when.textContent = timeStr(ts);
      head.append(who, when);

      const body = document.createElement('div');
      body.className = 'msg-text';
      body.textContent = text;

      wrap.append(head, body);
    }

    const stick = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
    messagesEl.appendChild(wrap);
    if (stick) messagesEl.scrollTop = messagesEl.scrollHeight;

    if (!system && !self && !state.chatOpen) {
      state.unread += 1;
      updateChatBadge();
    }
  }

  function pushSystem(text) {
    pushMessage({ text, system: true });
  }

  function updateChatBadge() {
    if (state.unread > 0) {
      chatBadge.textContent = state.unread > 99 ? '99+' : String(state.unread);
      chatBadge.hidden = false;
    } else {
      chatBadge.hidden = true;
    }
  }

  function setChatOpen(open) {
    state.chatOpen = open;
    mainArea.classList.toggle('chat-open', open);
    if (open) {
      state.unread = 0;
      updateChatBadge();
      setTimeout(() => chatInput.focus(), 60);
    }
  }

  /* ------------------------------------------------------------------ */
  /* websocket                                                           */
  /* ------------------------------------------------------------------ */

  function send(obj) {
    const { ws } = state;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws;
    try {
      ws = new WebSocket(`${proto}//${location.host}${BASE_PATH}ws`);
    } catch (err) {
      lobbyMsg.textContent = 'Não foi possível conectar ao servidor.';
      joinBtn.disabled = false;
      joinBtn.textContent = 'Entrar na sala';
      return;
    }
    state.ws = ws;

    ws.onopen = () => {
      liveDot.classList.remove('off');
      send({ type: 'join', room: state.room, name: state.name, role: state.role });
    };

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      handleMessage(msg);
    };

    ws.onclose = () => {
      liveDot.classList.add('off');
      if (state.selfId) {
        connBannerText.textContent = 'Você foi desconectado do servidor.';
        connBanner.hidden = false;
      } else {
        joinBtn.disabled = false;
        joinBtn.textContent = 'Entrar na sala';
        lobbyMsg.textContent = 'Não foi possível entrar. O servidor está rodando?';
      }
    };

    ws.onerror = () => {
      /* onclose cuida do aviso */
    };
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'joined': {
        state.selfId = msg.selfId;
        state.room = msg.room;
        state.name = msg.name || state.name;
        if (msg.role) state.role = msg.role;
        if (Array.isArray(msg.iceServers) && msg.iceServers.length) state.iceServers = msg.iceServers;
        if (msg.maxPeers) state.maxPeers = msg.maxPeers;
        if (msg.agent) {
          state.agent.connected = !!msg.agent.connected;
          state.agent.host = msg.agent.host || null;
        }
        enterCall();
        for (const peer of msg.peers || []) createPeer(peer, false);
        updatePeople();
        updateAgentStatus();
        updateTechBar();
        break;
      }

      case 'peer-joined': {
        const peer = msg.peer;
        if (!peer || peer.id === state.selfId) return;
        const p = createPeer(peer, true);
        pushSystem(`${peer.name || 'Alguém'} entrou na sala`);
        updatePeople();
        if (p) makeOffer(p);
        break;
      }

      case 'peer-left': {
        const p = state.peers.get(msg.id);
        if (!p) return;
        pushSystem(`${p.name} saiu da sala`);
        removePeer(msg.id);
        break;
      }

      case 'rename': {
        const p = state.peers.get(msg.id);
        if (!p) return;
        p.name = msg.name;
        p.tile.nameEl.textContent = msg.name;
        break;
      }

      case 'signal': {
        if (!msg.from || !msg.data) return;
        let p = state.peers.get(msg.from);
        if (!p) p = createPeer({ id: msg.from, name: 'Convidado' }, false);
        if (p) handleSignal(p, msg.data);
        break;
      }

      case 'media': {
        const p = state.peers.get(msg.from);
        if (!p) return;
        p.media = { screen: !!msg.media?.screen, mic: !!msg.media?.mic };
        updatePeerTile(p);
        updateTechBar();
        break;
      }

      case 'chat': {
        pushMessage({
          name: msg.name,
          text: msg.text,
          ts: msg.ts,
          self: msg.from === state.selfId,
        });
        break;
      }

      case 'error': {
        toast(msg.message || 'Erro');
        if (!state.selfId) {
          joinBtn.disabled = false;
          joinBtn.textContent = 'Entrar na sala';
          lobbyMsg.textContent = msg.message || 'Erro ao entrar.';
        }
        break;
      }

      /* ---------------- suporte remoto ---------------- */

      case 'agent-code': {
        state.agent.code = msg.code;
        agentCodeEl.textContent = msg.code;
        if (typeof msg.connected === 'boolean') {
          state.agent.connected = msg.connected;
          updateAgentStatus();
        }
        const base = encodeURIComponent(BASE_PATH);
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        agentDownload.href = `${BASE_PATH}agente.bat?codigo=${encodeURIComponent(msg.code)}&base=${base}&proto=${proto}`;
        agentDownload.hidden = false;
        break;
      }

      case 'agent-status': {
        // O agente pertence a um cliente específico (msg.clientId).
        // O técnico guarda o estado por pessoa; o cliente só usa o próprio.
        const peer = msg.clientId ? state.peers.get(msg.clientId) : null;
        if (peer) {
          peer.agentConnected = !!msg.connected;
          peer.agentHost = msg.host || null;
          updateTechBar();
          if (!msg.connected && state.tech.peerId === peer.id) resetTechControl(true);
        }
        if (msg.clientId && msg.clientId !== state.selfId) break;

        const before = state.agent.connected;
        state.agent.connected = !!msg.connected;
        state.agent.host = msg.host || null;
        updateAgentStatus();
        updateTechBar();
        if (state.agent.connected && !before) {
          toast(`Agente de suporte conectado${state.agent.host ? ' em ' + state.agent.host : ''}.`, 5000);
        }
        if (!state.agent.connected && before && state.ctrlIn) {
          setCtrlBanner(false);
          state.ctrlIn = null;
        }
        break;
      }

      case 'control-request': {
        if (state.role === 'tech') return;
        state.pendingAsk = { techId: msg.from, name: msg.name || 'Técnico' };
        showControlRequest(msg.name);
        toast(`${msg.name || 'Um técnico'} quer controlar este computador.`, 7000);
        break;
      }

      case 'control-active': {
        if (msg.with) {
          state.ctrlIn = { techId: msg.with, name: msg.name || 'Técnico' };
          setCtrlBanner(true, state.ctrlIn.name);
          if (state.pendingAsk) {
            state.pendingAsk = null;
            ctrlAsk.hidden = true;
          }
          toast(`Controle liberado para ${state.ctrlIn.name}.`, 5000);
        } else {
          state.ctrlIn = null;
          setCtrlBanner(false);
        }
        break;
      }

      case 'control-pending': {
        if (state.role !== 'tech') return;
        state.tech.status = 'pending';
        updateTechBar();
        break;
      }

      case 'control-granted': {
        if (state.role !== 'tech') return;
        state.tech.peerId = msg.from;
        state.tech.status = 'active';
        updateTechBar();
        enableControlCapture();
        toast(`Você está no controle do PC de ${msg.name || 'cliente'}.`, 5000);
        break;
      }

      case 'control-denied': {
        if (state.role !== 'tech') return;
        resetTechControl(false);
        toast('O cliente não autorizou o controle.');
        break;
      }

      case 'control-revoked': {
        if (state.role === 'tech') {
          resetTechControl(true);
        }
        if (state.ctrlIn && (!msg.from || msg.from === state.ctrlIn.techId)) {
          state.ctrlIn = null;
          setCtrlBanner(false);
          toast('O controle remoto foi encerrado.', 5000);
        }
        break;
      }

      case 'control-error': {
        toast(msg.message || 'Falha no controle.', 5000);
        break;
      }

      default:
        break;
    }
  }

  /* ------------------------------------------------------------------ */
  /* entrada / saída                                                     */
  /* ------------------------------------------------------------------ */

  function enterCall() {
    lobby.hidden = true;
    call.hidden = false;
    roomCodeEl.textContent = state.room;
    try {
      const q = new URLSearchParams({ sala: state.room });
      if (state.compat) q.set('compat', '1');
      history.replaceState(null, '', `${location.pathname}?${q}`);
    } catch {
      /* ignora */
    }
    updateCompatLink();

    state.selfTile = makeTile(state.selfId, state.name, true);
    state.selfTile.phTextEl.textContent = 'Clique em “Compartilhar tela”';

    if (state.role === 'tech') {
      // o técnico não precisa do próprio tile na tela
      state.selfTile.tile.remove();
      state.selfTile = null;
      supportBtn.hidden = true;
      supportPanel.hidden = true;
      stageHint.textContent = 'Aguardando a pessoa compartilhar a tela…';
    } else {
      supportBtn.hidden = false;
    }
    updateTechBar();

    pushSystem(`Você entrou na sala ${state.room}`);
    updatePeople();
    updateSelf();
    setChatOpen(window.matchMedia('(min-width: 981px)').matches);
    setupMiscListeners();
    startPeerWatch();

    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      toast('Este navegador não permite compartilhar tela. Use Chrome, Edge ou Firefox atualizado.', 7000);
    }
  }

  function leave() {
    try {
      send({ type: 'leave' });
    } catch {
      /* ignora */
    }
    stopShare(true);
    stopMic(true);
    for (const p of [...state.peers.values()]) removePeer(p.id);
    try {
      if (state.ws) state.ws.close();
    } catch {
      /* ignora */
    }
    const url = state.room ? `${location.pathname}?sala=${state.room}` : location.pathname;
    location.href = url;
  }

  function updatePeople() {
    const n = state.peers.size + 1;
    peopleCount.textContent = n === 1 ? '1 pessoa' : `${n} pessoas`;
    stageHint.hidden = n > 1 || !!state.share.track;
  }

  /* ------------------------------------------------------------------ */
  /* tiles                                                               */
  /* ------------------------------------------------------------------ */

  function makeTile(id, name, isSelf) {
    const tile = document.createElement('div');
    tile.className = 'tile no-video';
    tile.dataset.id = id;

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.muted = !!isSelf;

    const ph = document.createElement('div');
    ph.className = 'tile-ph';
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = initials(name);
    const phText = document.createElement('div');
    phText.className = 'ph-text';
    phText.textContent = 'Sem vídeo';
    ph.append(avatar, phText);

    const bar = document.createElement('div');
    bar.className = 'tile-bar';
    const nameEl = document.createElement('span');
    nameEl.className = 'tile-name';
    nameEl.textContent = isSelf ? `${name} (você)` : name;
    const stateEl = document.createElement('span');
    stateEl.className = 'tile-state';
    bar.append(nameEl, stateEl);

    const fsBtn = document.createElement('button');
    fsBtn.type = 'button';
    fsBtn.className = 'tile-btn';
    fsBtn.title = 'Tela cheia';
    fsBtn.textContent = '⛶';
    fsBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      requestFullscreen(tile);
    });

    tile.addEventListener('dblclick', () => toggleSpotlight(tile));

    tile.append(video, ph, bar, fsBtn);
    stage.appendChild(tile);

    return { tile, video, nameEl, stateEl, avatarEl: avatar, phTextEl: phText };
  }

  function removePeer(id) {
    const p = state.peers.get(id);
    if (!p) return;
    state.peers.delete(id);
    try {
      p.pc.ontrack = null;
      p.pc.onicecandidate = null;
      p.pc.onconnectionstatechange = null;
      p.pc.close();
    } catch {
      /* ignora */
    }
    if (p.audioEl) {
      try {
        p.audioEl.srcObject = null;
        p.audioEl.remove();
      } catch {
        /* ignora */
      }
    }
    if (state.spotlightId === id) {
      state.spotlightId = null;
      stage.classList.remove('spotlight');
    }
    p.tile.tile.remove();
    if (state.tech.peerId === id) {
      state.tech.peerId = null;
      resetTechControl(false);
    }
    updatePeople();
    updateSelf();
    updateTechBar();
  }

  function toggleSpotlight(tile) {
    if (state.spotlightId === tile.dataset.id) {
      state.spotlightId = null;
      stage.classList.remove('spotlight');
      tile.classList.remove('active');
      return;
    }
    for (const el of stage.querySelectorAll('.tile')) el.classList.remove('active');
    state.spotlightId = tile.dataset.id;
    tile.classList.add('active');
    stage.classList.add('spotlight');
  }

  function requestFullscreen(el) {
    const fn = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
    if (!fn) return;
    Promise.resolve(fn.call(el)).catch(() => {
      toast('O navegador não permitiu entrar em tela cheia.');
    });
  }

  function updateSelf() {
    const sharing = !!state.share.track;
    const micOn = !!(state.mic.track && state.mic.enabled);

    sharingBtn.classList.toggle('active', sharing);
    sharingBtn.querySelector('.label').textContent = sharing ? 'Parar de compartilhar' : 'Compartilhar tela';
    micBtn.classList.toggle('off', !micOn);
    stageHint.hidden = state.peers.size > 0 || sharing;

    if (state.selfTile) {
      const t = state.selfTile;
      t.tile.classList.toggle('no-video', !sharing);
      t.stateEl.innerHTML = sharing ? '<span class="rec"></span><span>ao vivo</span>' : '';
    }
  }

  /* --- som: mudo do áudio que EU ouço (não afeta quem está do outro lado) */
  function applyAudioMute() {
    if (audioBtn) audioBtn.classList.toggle('off', state.muted);
    if (!audioSink) return;
    audioSink.querySelectorAll('audio').forEach((el) => {
      el.muted = state.muted;
      if (!state.muted) el.play().catch(() => {});
    });
  }

  function toggleAudio() {
    state.muted = !state.muted;
    try { localStorage.setItem(LS_MUTE, state.muted ? '1' : '0'); } catch (e) { /* ignora */ }
    applyAudioMute();
    toast(state.muted ? 'Som silenciado — você não ouve mais a sala.' : 'Som ativado.');
  }

  function updatePeerTile(p) {
    const sharing = !!p.media.screen;
    p.tile.tile.classList.toggle('no-video', !sharing);

    p.tile.stateEl.innerHTML = '';
    if (sharing) {
      const rec = document.createElement('span');
      rec.className = 'rec';
      const label = document.createElement('span');
      label.textContent = 'ao vivo';
      p.tile.stateEl.append(rec, label);
    } else if (!p.media.mic) {
      p.tile.stateEl.innerHTML = MUTED_SVG;
    }

    if (!sharing && p.tile.phTextEl.textContent !== 'Conectando…') {
      p.tile.phTextEl.textContent = 'Sem vídeo';
    }
    p.tile.avatarEl.textContent = initials(p.name);
  }

  /* ------------------------------------------------------------------ */
  /* peer connection                                                     */
  /* ------------------------------------------------------------------ */

  function createPeer(info, initiator) {
    const existing = state.peers.get(info.id);
    if (existing) {
      if (info.name && info.name !== existing.name) {
        existing.name = info.name;
        existing.tile.nameEl.textContent = info.name;
      }
      return existing;
    }

    const pc = new RTCPeerConnection({
      iceServers: state.iceServers,
      bundlePolicy: 'max-bundle',
    });

    const p = {
      id: info.id,
      name: info.name || 'Convidado',
      media: { screen: !!(info.media && info.media.screen), mic: !!(info.media && info.media.mic) },
      agentConnected: !!info.agent,
      agentHost: null,
      pc,
      videoTr: null,
      audioTr: null,
      pendingIce: [],
      remoteReady: false,
      makingOffer: false,
      iceSent: 0,
      iceRecv: 0,
      tile: makeTile(info.id, info.name || 'Convidado', false),
      audioEl: null,
    };

    // áudio remoto
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.playsInline = true;
    audio.srcObject = new MediaStream();
    audioSink.appendChild(audio);
    audio.muted = state.muted;
    p.audioEl = audio;

    pc.ontrack = (ev) => {
      if (ev.track.kind === 'video') {
        p.tile.video.srcObject = new MediaStream([ev.track]);
        p.tile.video.play().catch(() => {});
      } else if (ev.track.kind === 'audio') {
        if (audio.srcObject.getAudioTracks().length === 0) audio.srcObject.addTrack(ev.track);
        audio.play().catch(() => {
          toast('Clique em qualquer lugar para ativar o som da sala.', 5000);
        });
      }
    };

    pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      p.iceSent += 1;
      send({ type: 'signal', to: p.id, data: { candidate: ev.candidate } });
    };

    pc.onicecandidateerror = (ev) => {
      console.warn('[sala] erro de candidato ICE:', ev.errorCode, ev.errorText);
    };

    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      p.tile.tile.classList.toggle('stale', s === 'disconnected' || s === 'failed');
      if (s === 'connected') {
        p.tile.phTextEl.textContent = 'Sem vídeo';
        applyBitrate();
      }
      if (s === 'failed' && state.selfId && state.selfId < p.id && pc.signalingState === 'stable') {
        makeOffer(p, true).catch(() => {});
      }
    };

    state.peers.set(p.id, p);
    updatePeerTile(p);

    // Se já estamos compartilhando/microfone ligado, manda junto.
    if (state.share.track || state.mix.track) applyLocalMediaTo(p);

    return p;
  }

  /** Descobre os transceptores ativos de vídeo/áudio (o mid só existe após negociar). */
  function refreshTransceivers(p) {
    const tcs = p.pc.getTransceivers();
    const pick = (kind) =>
      tcs.find((t) => t.receiver.track && t.receiver.track.kind === kind && t.mid !== null) ||
      tcs.find((t) => t.receiver.track && t.receiver.track.kind === kind) ||
      null;
    p.videoTr = pick('video');
    p.audioTr = pick('audio');
  }

  /** Quem inicia a oferta cria os dois transceptores fixos. */
  function ensureTransceivers(p) {
    const tcs = p.pc.getTransceivers();
    const has = (kind) => tcs.some((t) => t.receiver.track && t.receiver.track.kind === kind && !t.stopped);
    if (!has('video')) p.pc.addTransceiver('video', { direction: 'sendrecv' });
    if (!has('audio')) p.pc.addTransceiver('audio', { direction: 'sendrecv' });
    refreshTransceivers(p);
  }

  async function makeOffer(p, iceRestart = false) {
    if (p.makingOffer) return;
    p.makingOffer = true;
    try {
      ensureTransceivers(p);
      applyLocalMediaTo(p);
      const offer = await p.pc.createOffer({ iceRestart });
      await p.pc.setLocalDescription(offer);
      refreshTransceivers(p);
      applyLocalMediaTo(p);
      send({ type: 'signal', to: p.id, data: { sdp: p.pc.localDescription } });
    } catch (err) {
      console.warn('[sala] falha ao criar oferta:', err);
    } finally {
      p.makingOffer = false;
    }
  }

  async function handleSignal(p, data) {
    try {
      if (data.sdp) {
        const desc = data.sdp;
        if (desc.type === 'offer') {
          await p.pc.setRemoteDescription(desc);
          p.remoteReady = true;
          await flushIce(p);

          // Os transceptores criados ao aplicar a oferta nascem "recvonly".
          // Liberamos o envio antes de gerar a resposta, senão este lado
          // conseguiria receber mas nunca enviaria tela/áudio.
          for (const tc of p.pc.getTransceivers()) {
            if (tc.direction === 'recvonly' || tc.direction === 'inactive') tc.direction = 'sendrecv';
          }
          refreshTransceivers(p);
          applyLocalMediaTo(p);

          const answer = await p.pc.createAnswer();
          await p.pc.setLocalDescription(answer);
          send({ type: 'signal', to: p.id, data: { sdp: p.pc.localDescription } });
        } else if (desc.type === 'answer') {
          if (p.pc.signalingState === 'have-local-offer') {
            await p.pc.setRemoteDescription(desc);
            p.remoteReady = true;
            refreshTransceivers(p);
            applyLocalMediaTo(p);
            await flushIce(p);
          }
        }
        return;
      }

      if (data.candidate) {
        p.iceRecv += 1;
        if (p.remoteReady) {
          await p.pc.addIceCandidate(data.candidate).catch((err) => {
            console.warn('[sala] addIceCandidate falhou:', err && err.message ? err.message : err);
          });
        } else {
          p.pendingIce.push(data.candidate);
        }
      }
    } catch (err) {
      console.warn('[sala] falha na sinalização:', err);
    }
  }

  async function flushIce(p) {
    const list = p.pendingIce.splice(0);
    for (const candidate of list) {
      await p.pc.addIceCandidate(candidate).catch((err) => {
        console.warn('[sala] addIceCandidate (fila) falhou:', err && err.message ? err.message : err);
      });
    }
  }

  /* ------------------------------------------------------------------ */
  /* mídia local                                                         */
  /* ------------------------------------------------------------------ */

  function applyLocalMediaTo(p) {
    if (!p.videoTr || !p.audioTr) return;
    const vTrack = state.share.track || null;
    const aTrack = state.mix.track || null;
    try {
      p.videoTr.sender.replaceTrack(vTrack).catch(() => {});
      p.audioTr.sender.replaceTrack(aTrack).catch(() => {});
    } catch {
      /* ignora */
    }
  }

  function applyLocalMedia() {
    for (const p of state.peers.values()) applyLocalMediaTo(p);
    applyBitrate();
  }

  async function applyBitrate() {
    for (const p of state.peers.values()) {
      const sender = p.videoTr && p.videoTr.sender;
      if (!sender || !sender.track) continue;
      try {
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
        params.encodings[0].maxBitrate = state.compat ? 900000 : state.maxBitrate;
        params.encodings[0].priority = 'high';
        if (state.compat) {
          // PC antigo: metade da resolução e no máximo 15 fps — evita codificador travado
          params.encodings[0].scaleResolutionDownBy = 2;
          params.encodings[0].maxFramerate = 15;
          params.degradationPreference = 'balanced';
        } else {
          delete params.encodings[0].scaleResolutionDownBy;
          params.encodings[0].maxFramerate = 30;
          params.degradationPreference = 'maintain-resolution';
        }
        await sender.setParameters(params);
      } catch {
        /* alguns navegadores só permitem depois de conectado */
      }
    }
  }

  function broadcastMedia() {
    send({
      type: 'media',
      media: { screen: !!state.share.track, mic: !!(state.mic.track && state.mic.enabled) },
    });
  }

  /* --- mixagem de áudio (microfone + áudio da tela) ------------------ */

  function ensureMix() {
    if (state.mix.ctx) {
      if (state.mix.ctx.state === 'suspended') state.mix.ctx.resume().catch(() => {});
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;

    const ctx = new AC();
    const dest = ctx.createMediaStreamDestination();
    const micGain = ctx.createGain();
    const screenGain = ctx.createGain();
    micGain.gain.value = 1;
    screenGain.gain.value = 1;
    micGain.connect(dest);
    screenGain.connect(dest);

    state.mix = {
      ctx,
      dest,
      micGain,
      screenGain,
      micSrc: null,
      screenSrc: null,
      track: dest.stream.getAudioTracks()[0],
    };
  }

  function attachMic(track) {
    ensureMix();
    const mix = state.mix;
    if (!mix.ctx) return;
    if (mix.micSrc) {
      try {
        mix.micSrc.disconnect();
      } catch {
        /* ignora */
      }
      mix.micSrc = null;
    }
    if (track) {
      mix.micSrc = mix.ctx.createMediaStreamSource(new MediaStream([track]));
      mix.micSrc.connect(mix.micGain);
    }
  }

  function attachScreenAudio(track) {
    ensureMix();
    const mix = state.mix;
    if (!mix.ctx) return;
    if (mix.screenSrc) {
      try {
        mix.screenSrc.disconnect();
      } catch {
        /* ignora */
      }
      mix.screenSrc = null;
    }
    if (track) {
      mix.screenSrc = mix.ctx.createMediaStreamSource(new MediaStream([track]));
      mix.screenSrc.connect(mix.screenGain);
    }
  }

  /* --- compartilhar tela -------------------------------------------- */

  /**
   * Pede a captura da tela tentando configurações cada vez mais simples.
   * Em PCs antigos (driver de vídeo fraco) a primeira tentativa pode
   * devolver um stream sem frames; a segunda costuma funcionar.
   */
  async function captureScreen() {
    const tries = state.compat
      ? [
          { video: { frameRate: { ideal: 15, max: 20 }, width: { max: 1280 }, height: { max: 720 } }, audio: true },
          { video: { frameRate: { ideal: 10, max: 15 } }, audio: false },
          { video: true },
        ]
      : [
          {
            video: { frameRate: { ideal: 30, max: 60 } },
            audio: {
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
            },
            selfBrowserSurface: 'exclude',
            surfaceSwitching: 'include',
            systemAudio: 'include',
          },
          { video: { frameRate: { ideal: 15, max: 30 } }, audio: false },
          { video: true },
        ];

    let lastErr = null;
    for (const constraints of tries) {
      try {
        return await navigator.mediaDevices.getDisplayMedia(constraints);
      } catch (err) {
        lastErr = err;
        // cancelar/negar é decisão do usuário: não insiste
        if (err && (err.name === 'NotAllowedError' || err.name === 'AbortError')) throw err;
        console.warn('[sala] captura falhou, tentando mais simples:', err && err.name);
      }
    }
    throw lastErr || new Error('captura indisponível');
  }

  function updateCompatLink() {
    try {
      const u = new URL(location.href);
      u.searchParams.set('compat', '1');
      compatBrowser.href = `${BASE_PATH}navegador.bat?url=${encodeURIComponent(u.toString())}`;
    } catch {
      /* ignora */
    }
  }

  function persistCompat(on) {
    state.compat = !!on;
    try {
      localStorage.setItem(LS_COMPAT, state.compat ? '1' : '0');
    } catch {
      /* ignora */
    }
    updateCompatLink();
  }

  function toggleShareCompat() {
    state.compat = true;
    try {
      qualitySel.value = 'compat';
    } catch {
      /* ignora */
    }
    state.maxBitrate = 900000;
    persistCompat(true);
    captureWarn.hidden = true;
    captureHelp.hidden = true;
    if (state.share.track) {
      stopShare(true);
      setTimeout(() => toggleShare(), 400);
    } else {
      toggleShare();
    }
  }

  /* --- vigilância da captura (tela preta / congelada) ---------------- */

  let watchTimer = 0;
  let watchCanvas = null;
  let blackHits = 0;
  let blackWarned = false;
  let noFrameHits = 0;

  function sampleLuma(video) {
    if (!watchCanvas) {
      watchCanvas = document.createElement('canvas');
      watchCanvas.width = 64;
      watchCanvas.height = 36;
    }
    const ctx = watchCanvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    try {
      ctx.drawImage(video, 0, 0, 64, 36);
    } catch {
      return null;
    }
    const { data } = ctx.getImageData(0, 0, 64, 36);
    let sum = 0;
    let max = 0;
    for (let i = 0; i < data.length; i += 4) {
      const v = (data[i] + data[i + 1] + data[i + 2]) / 3;
      sum += v;
      if (v > max) max = v;
    }
    return { avg: sum / (64 * 36), max };
  }

  function stopCaptureWatch() {
    if (watchTimer) clearInterval(watchTimer);
    watchTimer = 0;
    blackHits = 0;
  }

  function startCaptureWatch() {
    stopCaptureWatch();
    blackWarned = false;
    noFrameHits = 0;
    let ticks = 0;
    watchTimer = setInterval(() => {
      if (!state.share.track) {
        stopCaptureWatch();
        return;
      }
      ticks += 1;
      if (ticks < 2) return; // deixa o primeiro frame chegar
      const video = state.selfTile && state.selfTile.video;
      if (!video) return;

      // Track existe, mas o vídeo nem carregou dimensões (captura travada).
      if (!video.videoWidth) {
        noFrameHits += 1;
        if (noFrameHits >= 4 && !blackWarned) {
          blackWarned = true;
          updateCompatLink();
          captureWarn.hidden = false;
          toast('A captura não está gerando imagem neste computador. Veja a dica no topo.', 8000);
        }
        return;
      }
      noFrameHits = 0;

      const luma = sampleLuma(video);
      if (!luma) return;

      if (luma.avg < 4 && luma.max < 14) blackHits += 1;
      else blackHits = 0;

      if (blackHits >= 3 && !blackWarned) {
        blackWarned = true;
        updateCompatLink();
        captureWarn.hidden = false;
        toast('A captura está saindo preta neste computador. Veja a dica no topo da tela.', 8000);
      }
    }, 2000);
  }

  /* --- vigilância do lado de quem assiste (frames parados) ----------- */

  let peerWatch = 0;

  function startPeerWatch() {
    if (peerWatch) return;
    peerWatch = setInterval(() => {
      for (const p of state.peers.values()) {
        const video = p.tile.video;
        const advanced = video.currentTime !== p.lastTime;
        p.lastTime = video.currentTime;

        if (!p.media.screen) {
          p.stalls = 0;
          continue;
        }
        p.stalls = advanced ? 0 : (p.stalls || 0) + 1;

        // tela preta no PC de quem compartilha (frames chegam, mas sem imagem)
        const luma = advanced && video.videoWidth ? sampleLuma(video) : null;
        if (luma) {
          if (luma.avg < 4 && luma.max < 14) {
            p.blackHits = (p.blackHits || 0) + 1;
            if (p.blackHits >= 3 && !p.blackWarned) {
              p.blackWarned = true;
              toast(
                `A tela de ${p.name} está saindo preta. Peça para usar o modo compatível no PC dela.`,
                10000
              );
            }
          } else {
            p.blackHits = 0;
            p.blackWarned = false;
          }
        }

        if (p.stalls === 3) {
          p.tile.tile.classList.add('stale');
          p.tile.stateEl.innerHTML = '<span>sem imagem</span>';
          video.play().catch(() => {});
        } else if (p.stalls === 0 && p.tile.tile.classList.contains('stale') && p.media.screen) {
          updatePeerTile(p);
        }
      }
    }, 2500);
  }

  async function toggleShare() {
    if (state.share.track) {
      stopShare();
      return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
      toast('Este navegador não suporta compartilhamento de tela.', 6000);
      return;
    }
    if (!window.isSecureContext) {
      toast('Compartilhar tela exige HTTPS. Abra a versão https:// desta página.', 7000);
      return;
    }

    let stream;
    try {
      stream = await captureScreen();
    } catch (err) {
      if (err && err.name === 'NotAllowedError') return; // usuário cancelou
      toast('Não foi possível capturar a tela: ' + (err && err.message ? err.message : err), 6000);
      return;
    }

    const track = stream.getVideoTracks()[0];
    if (!track) {
      toast('Nenhuma tela foi selecionada.');
      return;
    }
    track.contentHint = state.compat ? 'motion' : 'detail';

    state.share = { stream, track };

    const sysAudio = stream.getAudioTracks()[0];
    if (sysAudio) {
      attachScreenAudio(sysAudio);
      sysAudio.addEventListener('ended', () => attachScreenAudio(null));
    }

    track.addEventListener('ended', () => {
      if (state.share.track === track) stopShare(true);
    });

    if (state.selfTile) {
      state.selfTile.video.srcObject = new MediaStream([track]);
      state.selfTile.video.play().catch(() => {});
    }

    applyLocalMedia();
    updateSelf();
    broadcastMedia();
    startCaptureWatch();
    if (sysAudio) toast('Compartilhando tela com áudio.');
  }

  function stopShare(silent = false) {
    const { stream } = state.share;
    if (!stream) return;

    state.share = { stream: null, track: null };
    stopCaptureWatch();
    for (const t of stream.getTracks()) {
      try {
        t.stop();
      } catch {
        /* ignora */
      }
    }
    attachScreenAudio(null);
    if (state.selfTile) state.selfTile.video.srcObject = null;

    applyLocalMedia();
    updateSelf();
    broadcastMedia();
    if (!silent) toast('Compartilhamento encerrado.');
  }

  /* --- microfone ---------------------------------------------------- */

  async function toggleMic() {
    if (state.mic.track) {
      stopMic();
      return;
    }

    ensureMix();

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      toast('Não foi possível acessar o microfone. Verifique a permissão do navegador.', 6000);
      return;
    }

    const track = stream.getAudioTracks()[0];
    state.mic = { stream, track, enabled: true };
    attachMic(track);

    applyLocalMedia();
    updateSelf();
    broadcastMedia();
    toast('Microfone ligado.');
  }

  function stopMic(silent = false) {
    if (!state.mic.stream) return;
    const { stream } = state.mic;
    state.mic = { stream: null, track: null, enabled: false };
    attachMic(null);
    for (const t of stream.getTracks()) {
      try {
        t.stop();
      } catch {
        /* ignora */
      }
    }
    applyLocalMedia();
    updateSelf();
    broadcastMedia();
    if (!silent) toast('Microfone desligado.');
  }

  /* ------------------------------------------------------------------ */
  /* suporte remoto — painel do cliente                                  */
  /* ------------------------------------------------------------------ */

  function updateAgentStatus() {
    const on = !!state.agent.connected;
    agentStatusEl.classList.toggle('on', on);
    agentStatusText.textContent = on
      ? `Agente conectado${state.agent.host ? ' em ' + state.agent.host : ''}.`
      : 'Agente não conectado.';
  }

  function requestAgentCode() {
    if (!state.selfId) return;
    send({ type: 'agent-code' });
  }

  function setSupportOpen(open) {
    supportPanel.hidden = !open;
    if (open) {
      updateAgentStatus();
      if (!state.agent.code) requestAgentCode();
      else if (!state.agent.connected) requestAgentCode();
    }
  }

  async function copyDiagnostics() {
    const linhas = [];
    linhas.push('Sala de Tela — diagnóstico');
    linhas.push('Data: ' + new Date().toISOString());
    linhas.push('URL: ' + location.href);
    linhas.push('Sala: ' + (state.room || '-') + ' / papel: ' + state.role);
    linhas.push('Navegador: ' + navigator.userAgent);
    linhas.push('Plataforma: ' + (navigator.userAgentData?.platform || navigator.platform || '-'));
    linhas.push('Idioma: ' + (navigator.language || '-'));
    linhas.push('Contexto seguro (HTTPS): ' + window.isSecureContext);
    linhas.push(
      'getDisplayMedia: ' +
        !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia)
    );
    linhas.push('Tela: ' + screen.width + 'x' + screen.height + ' @' + (window.devicePixelRatio || 1));
    linhas.push('Modo compatível: ' + state.compat + ' / bitrate: ' + state.maxBitrate);

    if (state.share.track) {
      const s = state.share.track.getSettings ? state.share.track.getSettings() : {};
      linhas.push(
        'Captura: ' +
          (s.width || '?') +
          'x' +
          (s.height || '?') +
          ' @' +
          (s.frameRate || '?') +
          'fps, hint=' +
          (state.share.track.contentHint || '-') +
          ', estado=' +
          state.share.track.readyState
      );
      const luma = state.selfTile ? sampleLuma(state.selfTile.video) : null;
      if (luma) {
        linhas.push('Luminância local: média=' + luma.avg.toFixed(1) + ' máximo=' + luma.max.toFixed(1));
      }
    } else {
      linhas.push('Captura: parada');
    }

    for (const p of state.peers.values()) {
      const conn = p.pc.connectionState || p.pc.iceConnectionState || '?';
      let recebido = '';
      try {
        const stats = await p.pc.getStats();
        stats.forEach((r) => {
          if (r.type === 'inbound-rtp' && r.kind === 'video') {
            recebido =
              ', recebido=' +
              (r.bytesReceived || 0) +
              ' bytes, frames=' +
              (r.framesDecoded || 0);
          }
        });
      } catch {
        /* ignora */
      }
      linhas.push(
        'Par ' +
          p.name +
          ': ' +
          conn +
          ', tela=' +
          p.media.screen +
          ', vídeo=' +
          p.tile.video.videoWidth +
          'x' +
          p.tile.video.videoHeight +
          recebido
      );
    }
    linhas.push('Agente: ' + (state.agent.connected ? 'conectado ' + (state.agent.host || '') : 'desconectado'));

    const texto = linhas.join('\n');
    try {
      await navigator.clipboard.writeText(texto);
      toast('Diagnóstico copiado. Cole no chat para o técnico.', 6000);
    } catch {
      window.prompt('Copie o diagnóstico:', texto);
    }
  }

  function showControlRequest(name) {
    ctrlAskWho.textContent = name || 'Um técnico';
    ctrlAsk.hidden = false;
  }

  function setCtrlBanner(on, name) {
    ctrlBanner.hidden = !on;
    if (on) ctrlBannerText.textContent = `Controle remoto ativo: ${name || 'técnico'}`;
  }

  /* ------------------------------------------------------------------ */
  /* suporte remoto — lado do técnico                                    */
  /* ------------------------------------------------------------------ */

  function peerSharing() {
    for (const p of state.peers.values()) if (p.media.screen) return p;
    return null;
  }

  function updateTechBar() {
    if (state.role !== 'tech') {
      techBar.hidden = true;
      return;
    }
    const peer = peerSharing();
    const active = state.tech.status === 'active';
    const pending = state.tech.status === 'pending';
    const agentOn = !!(peer && peer.agentConnected);

    techBar.hidden = false;
    techAskBtn.hidden = active || pending;
    techAskBtn.disabled = !peer;
    techAskBtn.textContent = agentOn ? 'Pedir controle' : 'Pedir controle (agente off)';
    techStatusEl.classList.toggle('on', active);
    techStatusEl.textContent = active
      ? state.tech.keys
        ? 'Controle ativo — teclado sendo enviado'
        : 'Controle ativo'
      : pending
        ? 'Aguardando o cliente autorizar…'
        : peer
          ? agentOn
            ? 'Assistindo a tela (somente leitura)'
            : 'Assistindo a tela — agente não iniciado no PC'
          : 'Ninguém está compartilhando a tela';

    techKeysBtn.hidden = !active;
    techKeysBtn.classList.toggle('active', state.tech.keys);
    techReleaseBtn.hidden = !active;
    techPasteEl.hidden = !active;
  }

  function resetTechControl(notify) {
    if (state.tech.status === 'idle' && !state.tech.peerId) return;
    state.tech.status = 'idle';
    state.tech.keys = false;
    disableControlCapture();
    if (notify) toast('Controle encerrado.');
    updateTechBar();
  }

  /* ---- captura de mouse/teclado do técnico ------------------------- */

  let ctrlCleanup = null;
  let moveRaf = 0;
  let lastMove = null;

  function normPoint(ev, video) {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;
    const rect = video.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const scale = Math.min(rect.width / vw, rect.height / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    const ox = rect.left + (rect.width - dw) / 2;
    const oy = rect.top + (rect.height - dh) / 2;
    const x = (ev.clientX - ox) / dw;
    const y = (ev.clientY - oy) / dh;
    if (x < 0 || y < 0 || x > 1 || y > 1) return null;
    return { x: Math.round(x * 10000) / 10000, y: Math.round(y * 10000) / 10000 };
  }

  function sendControl(data) {
    if (state.tech.status !== 'active') return;
    send({ type: 'control', data });
  }

  function enableControlCapture() {
    disableControlCapture();
    const p = state.peers.get(state.tech.peerId);
    if (!p) return;

    const { tile } = p.tile;
    const video = p.tile.video;
    tile.classList.add('controlling');

    const onMove = (ev) => {
      const pt = normPoint(ev, video);
      if (!pt) return;
      lastMove = pt;
      if (moveRaf) return;
      moveRaf = requestAnimationFrame(() => {
        moveRaf = 0;
        if (lastMove) sendControl({ t: 'm', x: lastMove.x, y: lastMove.y });
      });
    };

    const onDown = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const pt = normPoint(ev, video);
      if (!pt) return;
      sendControl({ t: 'm', x: pt.x, y: pt.y });
      sendControl({ t: 'd', b: ev.button });
    };

    const onUp = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      sendControl({ t: 'u', b: ev.button });
    };

    const onWheel = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      sendControl({ t: 'w', dy: ev.deltaY < 0 ? 1 : -1 });
    };

    const onMenu = (ev) => ev.preventDefault();
    const onDrag = (ev) => ev.preventDefault();

    tile.addEventListener('pointermove', onMove);
    tile.addEventListener('pointerdown', onDown);
    window.addEventListener('pointerup', onUp);
    tile.addEventListener('wheel', onWheel, { passive: false });
    tile.addEventListener('contextmenu', onMenu);
    tile.addEventListener('dragstart', onDrag);

    ctrlCleanup = () => {
      tile.classList.remove('controlling');
      tile.removeEventListener('pointermove', onMove);
      tile.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', onUp);
      tile.removeEventListener('wheel', onWheel);
      tile.removeEventListener('contextmenu', onMenu);
      tile.removeEventListener('dragstart', onDrag);
      ctrlCleanup = null;
    };
  }

  function disableControlCapture() {
    if (moveRaf) {
      cancelAnimationFrame(moveRaf);
      moveRaf = 0;
    }
    lastMove = null;
    if (ctrlCleanup) ctrlCleanup();
  }

  const MOD_VK = { Control: 17, Shift: 16, Alt: 18, Meta: 91, AltGraph: 18 };
  const SPECIAL_VK = {
    Enter: 13,
    Tab: 9,
    Backspace: 8,
    Escape: 27,
    Delete: 46,
    ArrowUp: 38,
    ArrowDown: 40,
    ArrowLeft: 37,
    ArrowRight: 39,
    Home: 36,
    End: 35,
    PageUp: 33,
    PageDown: 34,
    Insert: 45,
    ' ': 32,
    CapsLock: 20,
    NumLock: 144,
    ScrollLock: 145,
    PrintScreen: 44,
    Pause: 19,
    ContextMenu: 93,
  };
  const CODE_VK = {
    Semicolon: 186,
    Equal: 187,
    Comma: 188,
    Minus: 189,
    Period: 190,
    Slash: 191,
    Backquote: 192,
    BracketLeft: 219,
    Backslash: 220,
    BracketRight: 221,
    Quote: 222,
    IntlRo: 193,
    IntlYen: 226,
  };

  function keyPayload(ev, down) {
    if (MOD_VK[ev.key]) return { t: 'k', vk: MOD_VK[ev.key], down };
    if (SPECIAL_VK[ev.key]) return { t: 'k', vk: SPECIAL_VK[ev.key], down };
    const fn = /^F([1-9]|1[0-2])$/.exec(ev.key);
    if (fn) return { t: 'k', vk: 111 + Number(fn[1]), down };

    // com Ctrl/Alt/Win precisamos de código de tecla (senão o atalho não forma)
    if (ev.ctrlKey || ev.altKey || ev.metaKey) {
      let vk = 0;
      if (ev.code && ev.code.startsWith('Key')) vk = ev.code.charCodeAt(3);
      else if (ev.code && ev.code.startsWith('Digit')) vk = ev.code.charCodeAt(5);
      else if (ev.code && CODE_VK[ev.code]) vk = CODE_VK[ev.code];
      return vk ? { t: 'k', vk, down } : null;
    }

    // texto normal: caractere unicode (funciona com acentos e qualquer layout)
    if (ev.key.length === 1) return down ? { t: 'k', ch: ev.key } : null;
    return null;
  }

  function onRemoteKey(ev, down) {
    if (state.role !== 'tech' || !state.tech.keys || state.tech.status !== 'active') return;
    const t = ev.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (ev.key === 'F5' || (ev.ctrlKey && ev.key === 'r')) return; // não bloqueia recarregar
    const payload = keyPayload(ev, down);
    if (!payload) return;
    ev.preventDefault();
    ev.stopPropagation();
    sendControl(payload);
  }


  /* ------------------------------------------------------------------ */
  /* entrada na sala (lobby)                                             */
  /* ------------------------------------------------------------------ */

  async function joinRoom() {
    const name = (nameInput.value || '').replace(/\s+/g, ' ').trim().slice(0, 32);
    const room = (roomInput.value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);

    if (!name) {
      lobbyMsg.textContent = 'Informe seu nome.';
      nameInput.focus();
      return;
    }
    if (room.length < 3) {
      lobbyMsg.textContent = 'O código da sala precisa de pelo menos 3 caracteres.';
      roomInput.focus();
      return;
    }

    lobbyMsg.textContent = '';
    joinBtn.disabled = true;
    joinBtn.textContent = 'Conectando…';
    localStorage.setItem(LS_NAME, name);

    state.name = name;
    state.room = room;
    state.role = techModeEl && techModeEl.checked ? 'tech' : 'client';
    try {
      localStorage.setItem(LS_TECH, state.role === 'tech' ? '1' : '0');
    } catch {
      /* ignora */
    }

    try {
      const cfg = await fetch(`${BASE_PATH}config.json`, { cache: 'no-store' }).then((r) => r.json());
      if (cfg && Array.isArray(cfg.iceServers) && cfg.iceServers.length) state.iceServers = cfg.iceServers;
    } catch {
      /* segue com STUN padrão */
    }

    connect();
  }

  /* ------------------------------------------------------------------ */
  /* eventos                                                             */
  /* ------------------------------------------------------------------ */

  let miscReady = false;
  function setupMiscListeners() {
    if (miscReady) return;
    miscReady = true;

    document.addEventListener('click', () => {
      for (const audio of audioSink.querySelectorAll('audio')) {
        if (audio.paused) audio.play().catch(() => {});
      }
    });

    document.addEventListener('fullscreenchange', () => {
      fsNote.hidden = !document.fullscreenElement;
    });

    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && state.spotlightId) {
        state.spotlightId = null;
        stage.classList.remove('spotlight');
        stage.querySelectorAll('.tile').forEach((el) => el.classList.remove('active'));
      }
    });

    // teclado remoto (só quando o técnico ativou o envio de teclado)
    window.addEventListener('keydown', (ev) => onRemoteKey(ev, true), true);
    window.addEventListener('keyup', (ev) => onRemoteKey(ev, false), true);

    window.addEventListener('beforeunload', () => {
      try {
        send({ type: 'leave' });
      } catch {
        /* ignora */
      }
      stopShare(true);
      stopMic(true);
      for (const p of state.peers.values()) {
        try {
          p.pc.close();
        } catch {
          /* ignora */
        }
      }
    });
  }

  joinForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    joinRoom();
  });

  randomRoom.addEventListener('click', () => {
    roomInput.value = randomCode();
    roomInput.focus();
  });

  roomInput.addEventListener('input', () => {
    roomInput.value = roomInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  });

  sharingBtn.addEventListener('click', toggleShare);
  micBtn.addEventListener('click', toggleMic);
  if (audioBtn) audioBtn.addEventListener('click', toggleAudio);
  leaveBtn.addEventListener('click', leave);
  chatToggle.addEventListener('click', () => setChatOpen(!state.chatOpen));
  chatClose.addEventListener('click', () => setChatOpen(false));

  /* ---------------- suporte remoto: eventos ---------------- */

  supportBtn.addEventListener('click', () => setSupportOpen(supportPanel.hidden));
  supportClose.addEventListener('click', () => setSupportOpen(false));
  agentGenBtn.addEventListener('click', () => {
    agentCodeEl.textContent = '······';
    requestAgentCode();
  });

  ctrlAllow.addEventListener('click', () => {
    const ask = state.pendingAsk;
    state.pendingAsk = null;
    ctrlAsk.hidden = true;
    if (ask) send({ type: 'control-reply', to: ask.techId, allow: true });
  });

  ctrlDeny.addEventListener('click', () => {
    const ask = state.pendingAsk;
    state.pendingAsk = null;
    ctrlAsk.hidden = true;
    if (ask) {
      send({ type: 'control-reply', to: ask.techId, allow: false });
      toast('Pedido recusado.');
    }
  });

  ctrlStopBtn.addEventListener('click', () => {
    send({ type: 'control-revoke' });
    setCtrlBanner(false);
    state.ctrlIn = null;
    toast('Controle remoto encerrado.');
  });

  techAskBtn.addEventListener('click', () => {
    const peer = peerSharing();
    if (!peer) {
      toast('Ninguém está compartilhando a tela ainda.', 5000);
      return;
    }
    if (!peer.agentConnected) {
      toast('O cliente ainda não abriu o agente de suporte. Peça para ele clicar em “Suporte”.', 7000);
      return;
    }
    state.tech.peerId = peer.id;
    state.tech.status = 'pending';
    updateTechBar();
    send({ type: 'control-request', to: peer.id });
  });

  techReleaseBtn.addEventListener('click', () => {
    send({ type: 'control-revoke' });
    state.tech.peerId = null;
    resetTechControl(false);
    toast('Você soltou o controle.');
  });

  techKeysBtn.addEventListener('click', () => {
    state.tech.keys = !state.tech.keys;
    updateTechBar();
    toast(state.tech.keys ? 'Teclado enviado para o PC assistido. Pressione de novo para parar.' : 'Teclado voltou para você.');
  });

  function sendPaste() {
    const text = techText.value;
    if (!text) return;
    send({ type: 'control-text', text });
    techText.value = '';
    toast('Texto enviado para o PC assistido.', 2500);
  }
  techTextBtn.addEventListener('click', sendPaste);
  techText.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      sendPaste();
    }
  });

  qualitySel.addEventListener('change', () => {
    const escolha = qualitySel.value;
    state.compat = escolha === 'compat';
    state.maxBitrate = state.compat ? 900000 : Number(escolha) || 2500000;
    persistCompat(state.compat);
    applyBitrate();
    if (state.compat && state.share.track) {
      // reabre a captura com limites leves
      stopShare(true);
      setTimeout(() => toggleShare(), 400);
      toast('Modo compatível: compartilhe a tela novamente.', 6000);
    }
  });

  captureWarnCompat.addEventListener('click', toggleShareCompat);
  captureWarnHelp.addEventListener('click', () => {
    captureHelp.hidden = !captureHelp.hidden;
    if (!captureHelp.hidden) updateCompatLink();
  });
  captureWarnClose.addEventListener('click', () => {
    captureWarn.hidden = true;
    captureHelp.hidden = true;
  });
  diagBtn.addEventListener('click', copyDiagnostics);

  chatForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const text = chatInput.value.trim();
    if (!text) return;
    send({ type: 'chat', text });
    chatInput.value = '';
    chatInput.style.height = '';
  });

  chatInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      chatForm.requestSubmit();
    }
  });

  chatInput.addEventListener('input', () => {
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 120) + 'px';
  });

  copyBtn.addEventListener('click', async () => {
    const link = `${location.origin}${location.pathname}?sala=${state.room}`;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(link);
      } else {
        throw new Error('sem clipboard');
      }
      toast('Link de convite copiado!');
    } catch {
      window.prompt('Copie o link para convidar:', link);
    }
  });

  // ---- inicialização -------------------------------------------------

  const params = new URLSearchParams(location.search);
  nameInput.value = localStorage.getItem(LS_NAME) || '';
  const salaParam = (params.get('sala') || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 12);
  roomInput.value = salaParam || randomCode();

  const tecnicoParam = params.get('tecnico');
  const tecnicoSalvo = localStorage.getItem(LS_TECH);
  techModeEl.checked = tecnicoParam === '1' || (tecnicoParam !== '0' && tecnicoSalvo === '1');

  const compatParam = params.get('compat');
  const compatSalvo = localStorage.getItem(LS_COMPAT) === '1';
  const compatInicial = compatParam === '1' || (compatParam !== '0' && compatSalvo);
  if (compatInicial) {
    state.compat = true;
    state.maxBitrate = 900000;
    qualitySel.value = 'compat';
  }
  persistCompat(compatInicial);

  // mudo do som recebido (lembra a escolha entre visitas)
  state.muted = localStorage.getItem(LS_MUTE) === '1';
  applyAudioMute();

  if (!window.isSecureContext) insecureWarn.hidden = false;

  if (!nameInput.value) nameInput.focus();
  else roomInput.focus();

  // Gancho de diagnóstico: só o estado da própria página, útil para suporte.
  window.__sala = state;
})();
