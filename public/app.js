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
    chatOpen: false,
    unread: 0,
    spotlightId: null,
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
      send({ type: 'join', room: state.room, name: state.name });
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
        if (Array.isArray(msg.iceServers) && msg.iceServers.length) state.iceServers = msg.iceServers;
        if (msg.maxPeers) state.maxPeers = msg.maxPeers;
        enterCall();
        for (const peer of msg.peers || []) createPeer(peer, false);
        updatePeople();
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
      history.replaceState(null, '', `${location.pathname}?sala=${state.room}`);
    } catch {
      /* ignora */
    }

    state.selfTile = makeTile(state.selfId, state.name, true);
    state.selfTile.phTextEl.textContent = 'Clique em “Compartilhar tela”';

    pushSystem(`Você entrou na sala ${state.room}`);
    updatePeople();
    updateSelf();
    setChatOpen(window.matchMedia('(min-width: 981px)').matches);
    setupMiscListeners();

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
    updatePeople();
    updateSelf();
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
        params.encodings[0].maxBitrate = state.maxBitrate;
        params.encodings[0].priority = 'high';
        params.degradationPreference = 'maintain-resolution';
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
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 60 } },
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
        systemAudio: 'include',
      });
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
    track.contentHint = 'detail';

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
    if (sysAudio) toast('Compartilhando tela com áudio.');
  }

  function stopShare(silent = false) {
    const { stream } = state.share;
    if (!stream) return;

    state.share = { stream: null, track: null };
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
  leaveBtn.addEventListener('click', leave);
  chatToggle.addEventListener('click', () => setChatOpen(!state.chatOpen));
  chatClose.addEventListener('click', () => setChatOpen(false));

  qualitySel.addEventListener('change', () => {
    state.maxBitrate = Number(qualitySel.value) || 2500000;
    applyBitrate();
  });

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

  nameInput.value = localStorage.getItem(LS_NAME) || '';
  const salaParam = (new URLSearchParams(location.search).get('sala') || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 12);
  roomInput.value = salaParam || randomCode();

  if (!window.isSecureContext) insecureWarn.hidden = false;

  if (!nameInput.value) nameInput.focus();
  else roomInput.focus();

  // Gancho de diagnóstico: só o estado da própria página, útil para suporte.
  window.__sala = state;
})();
