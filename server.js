'use strict';

/**
 * Sala de Tela — servidor de sinalização + arquivos estáticos.
 *
 * - Serve a interface em public/
 * - WebSocket em /ws (sinalização WebRTC + chat)
 * - HTTPS automático com certificado local (necessário para getDisplayMedia
 *   quando o site é acessado por outro computador/ celular da rede)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const AGENT_DIR = path.join(ROOT, 'agente');
const CERT_DIR = path.join(ROOT, 'certs');

const HTTP_PORT = Number(process.env.PORT || 8090);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 8443);
const MAX_PEERS = Number(process.env.MAX_PEERS || 8);
const MAX_CHAT_LEN = 2000;
const CHAT_BURST = 12; // mensagens
const CHAT_WINDOW = 5000; // por 5 segundos

const ICE_SERVERS = buildIceServers();

function buildIceServers() {
  const list = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  const url = process.env.TURN_URL;
  if (url) {
    list.push({
      urls: url.split(',').map((u) => u.trim()).filter(Boolean),
      username: process.env.TURN_USER || '',
      credential: process.env.TURN_PASS || '',
    });
  }
  return list;
}

function log(...args) {
  console.log('[sala]', ...args);
}

/* ------------------------------------------------------------------ */
/* Arquivos estáticos                                                  */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function handleRequest(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end();
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Requisição inválida');
    return;
  }

  if (pathname === '/health') {
    let peers = 0;
    for (const room of rooms.values()) peers += room.size;
    return sendJson(res, 200, { ok: true, rooms: rooms.size, peers });
  }

  if (pathname === '/config.json') {
    return sendJson(res, 200, { iceServers: ICE_SERVERS, maxPeers: MAX_PEERS });
  }

  if (pathname === '/agente.bat') {
    return sendAgentBat(req, res);
  }

  if (pathname === '/navegador.bat') {
    return sendCompatBrowserBat(req, res);
  }

  if (pathname === '/') pathname = '/index.html';

  const filePath = path.resolve(PUBLIC_DIR, '.' + pathname);
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Acesso negado');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Não encontrado');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(filePath).pipe(res);
  });
}

/* ------------------------------------------------------------------ */
/* Agente de suporte remoto (download)                                 */
/* ------------------------------------------------------------------ */

/**
 * Gera um .bat autossuficiente: traz o agente.ps1 embutido em base64,
 * extrai para %TEMP% e executa. Assim o cliente baixa UM arquivo só.
 */
function sendAgentBat(req, res) {
  let script;
  try {
    script = fs.readFileSync(path.join(AGENT_DIR, 'agente.ps1'));
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Agente indisponível');
    return;
  }

  const url = new URL(req.url, 'http://localhost');
  const base = url.searchParams.get('base') || '/';
  const safeBase = /^\/[A-Za-z0-9/_.-]*$/.test(base) ? base : '/';
  const protoParam = url.searchParams.get('proto');
  const proto =
    protoParam === 'wss' || protoParam === 'ws'
      ? protoParam
      : req.socket.encrypted
        ? 'wss'
        : 'ws';
  const wsUrl = `${proto}://${req.headers.host || 'localhost'}${safeBase.replace(/\/$/, '')}/agente`;
  const code = String(url.searchParams.get('codigo') || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 12);
  const dryRun = url.searchParams.get('dry') === '1';

  const b64 = script.toString('base64');
  const chunks = b64.match(/.{1,76}/g) || [];
  const tag = crypto.randomBytes(4).toString('hex');

  const lines = [
    '@echo off',
    'setlocal',
    'title Suporte remoto - Sala de Tela',
    'chcp 65001 >nul',
    `set "B64F=%TEMP%\\sala-agente-${tag}.b64"`,
    `set "PS1F=%TEMP%\\sala-agente-${tag}.ps1"`,
    '> "%B64F%" (',
    ...chunks.map((c) => 'echo ' + c),
    ')',
    'certutil -decode "%B64F%" "%PS1F%" >nul 2>nul',
    'del "%B64F%" >nul 2>nul',
    'if not exist "%PS1F%" (',
    '  echo.',
    '  echo  Nao foi possivel preparar o agente neste computador.',
    '  echo  Baixe o arquivo novamente ou peca ajuda ao tecnico.',
    '  echo.',
    '  pause',
    '  exit /b 1',
    ')',
    'echo.',
    'echo  ==============================================',
    'echo   Suporte remoto - Sala de Tela',
    'echo   Deixe esta janela aberta durante o atendimento.',
    'echo  ==============================================',
    'echo.',
    `set "COD=${code}"`,
    'if not "%COD%"=="" goto executar',
    'set /p COD=Digite o codigo de 6 caracteres mostrado na pagina: ',
    ':executar',
    'if "%COD%"=="" (',
    '  echo Codigo vazio. Rode o arquivo novamente.',
    '  pause',
    '  exit /b 1',
    ')',
    `powershell -NoProfile -ExecutionPolicy Bypass -NoLogo -File "%PS1F%" -Codigo "%COD%" -Servidor "${wsUrl}"${dryRun ? ' -DryRun' : ''}`,
    'del "%PS1F%" >nul 2>nul',
    'echo.',
    'echo Atendimento encerrado. Pode fechar esta janela.',
    'pause',
  ];

  const bat = lines.join('\r\n') + '\r\n';
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': Buffer.byteLength(bat),
    'Content-Disposition': 'attachment; filename="agente-suporte.bat"',
    'Cache-Control': 'no-store',
  });
  res.end(bat);
}

/* ------------------------------------------------------------------ */
/* Navegador em modo compatível (PC com tela preta)                    */
/* ------------------------------------------------------------------ */

/**
 * Gera um .bat que abre o Chrome/Edge com a aceleração de hardware
 * desligada e um perfil separado. Em muitos PCs antigos isso resolve
 * a captura de tela preta. Só aceita abrir uma URL do próprio site.
 */
function sendCompatBrowserBat(req, res) {
  const reqUrl = new URL(req.url, 'http://localhost');
  const target = reqUrl.searchParams.get('url') || '';
  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('URL inválida');
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('URL inválida');
    return;
  }
  const host = String(req.headers.host || '').toLowerCase();
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.host.toLowerCase() !== host && !local) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('URL não permitida');
    return;
  }

  const siteUrl = parsed.toString().replace(/"/g, '%22').replace(/[\r\n]/g, '');
  // No .bat, % precisa virar %% para o cmd não tentar expandir %20, %2F etc.
  const urlNoBat = siteUrl.replace(/%/g, '%%');

  const lines = [
    '@echo off',
    'setlocal',
    'title Sala de Tela - modo compativel',
    `set "URL=${urlNoBat}"`,
    'set "PROFILE=%TEMP%\\sala-navegador-compat"',
    'set "CHROME=%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe"',
    'if exist "%CHROME%" goto chrome',
    'set "CHROME=%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe"',
    'if exist "%CHROME%" goto chrome',
    'set "CHROME=%LocalAppData%\\Google\\Chrome\\Application\\chrome.exe"',
    'if exist "%CHROME%" goto chrome',
    'set "EDGE=%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe"',
    'if exist "%EDGE%" goto edge',
    'set "EDGE=%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe"',
    'if exist "%EDGE%" goto edge',
    'echo.',
    'echo  Nao encontrei o Chrome nem o Edge neste computador.',
    'echo  Instale um dos dois e tente de novo.',
    'echo.',
    'pause',
    'exit /b 1',
    ':chrome',
    'start "" "%CHROME%" --user-data-dir="%PROFILE%" --no-first-run --no-default-browser-check --disable-gpu --disable-gpu-compositing --new-window "%URL%"',
    'exit /b 0',
    ':edge',
    'start "" "%EDGE%" --user-data-dir="%PROFILE%" --no-first-run --no-default-browser-check --disable-gpu --disable-gpu-compositing --new-window "%URL%"',
    'exit /b 0',
  ];

  const bat = lines.join('\r\n') + '\r\n';
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': Buffer.byteLength(bat),
    'Content-Disposition': 'attachment; filename="abrir-navegador-compat.bat"',
    'Cache-Control': 'no-store',
  });
  res.end(bat);
}

/* ------------------------------------------------------------------ */
/* Salas                                                               */
/* ------------------------------------------------------------------ */

const rooms = new Map(); // codigo -> Map(id -> cliente)

function roomOf(code) {
  let room = rooms.get(code);
  if (!room) {
    room = new Map();
    rooms.set(code, room);
  }
  return room;
}

function peersPayload(roomCode, room, exceptId) {
  const out = [];
  for (const c of room.values()) {
    if (c.id === exceptId) continue;
    out.push({
      id: c.id,
      name: c.name,
      media: c.media,
      role: c.role,
      // O técnico precisa saber se o agente daquele cliente está conectado.
      agent: !!agentFor(roomCode, c.id),
    });
  }
  return out;
}

function broadcast(room, message, exceptId) {
  const data = JSON.stringify(message);
  for (const c of room.values()) {
    if (c.id === exceptId) continue;
    if (c.ws.readyState === c.ws.OPEN) c.ws.send(data);
  }
}

function leaveRoom(client) {
  if (!client.roomCode) return;
  const code = client.roomCode;
  const room = rooms.get(code);
  client.roomCode = null;
  if (!room) return;
  clearControlFor(code, client.id, false);

  // se este cliente tinha um agente de suporte, encerra junto
  const agent = agents.get(client.id);
  if (agent) {
    agents.delete(client.id);
    try {
      agent.ws.close();
    } catch {
      /* ignora */
    }
    broadcastAgentStatus(code, client.id, false, null, null);
  }
  for (const [c, info] of agentCodes) {
    if (info.clientId === client.id) agentCodes.delete(c);
  }

  room.delete(client.id);
  if (room.size === 0) {
    rooms.delete(code);
  } else {
    broadcast(room, { type: 'peer-left', id: client.id }, client.id);
  }
}

let idSeq = 0;
function newPeerId() {
  idSeq += 1;
  return 'p' + idSeq.toString(36) + crypto.randomBytes(2).toString('hex');
}

/* ------------------------------------------------------------------ */
/* Suporte remoto: agentes + autorizações de controle                 */
/* ------------------------------------------------------------------ */

const AGENT_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const AGENT_CODE_TTL = 20 * 60 * 1000; // 20 minutos

const agents = new Map(); // codigo da sala -> { ws, host, screen, since }
const agentCodes = new Map(); // codigo de acesso -> { room, exp }
const controlAuth = new Map(); // "SALA|idDoTecnico" -> { clientId, since }

function newAgentCode() {
  for (;;) {
    let code = '';
    for (let i = 0; i < 6; i += 1) code += AGENT_CODE_CHARS[crypto.randomInt(AGENT_CODE_CHARS.length)];
    if (!agentCodes.has(code)) return code;
  }
}

function pruneAgentCodes() {
  const now = Date.now();
  for (const [code, info] of agentCodes) if (info.exp < now) agentCodes.delete(code);
}

/**
 * O agente é vinculado ao cliente que gerou o código (e não só à sala).
 * Assim, em uma sala com duas pessoas, o técnico nunca controla o PC errado.
 */
function agentFor(roomCode, clientId) {
  const agent = agents.get(clientId);
  if (!agent || agent.room !== roomCode) return null;
  return agent.ws.readyState === agent.ws.OPEN ? agent : null;
}

function broadcastAgentStatus(roomCode, clientId, connected, host, screen) {
  const room = rooms.get(roomCode);
  if (!room) return;
  broadcast(room, {
    type: 'agent-status',
    clientId,
    connected: !!connected,
    host: host || null,
    screen: screen || null,
  });
}

/** Corta autorizações de controle (de um par específico, ou todas quando peerId é null). */
function clearControlFor(roomCode, peerId, notifySelf) {
  for (const [key, info] of [...controlAuth]) {
    const sep = key.lastIndexOf('|');
    if (key.slice(0, sep) !== roomCode) continue;
    const techId = key.slice(sep + 1);
    if (peerId && techId !== peerId && info.clientId !== peerId) continue;
    controlAuth.delete(key);
    const room = rooms.get(roomCode);
    for (const target of [room && room.get(techId), room && room.get(info.clientId)]) {
      if (!target || target.ws.readyState !== target.ws.OPEN) continue;
      if (!notifySelf && target.id === peerId) continue;
      target.ws.send(JSON.stringify({ type: 'control-revoked', from: peerId || null }));
    }
  }
}


/* ------------------------------------------------------------------ */
/* WebSocket                                                           */
/* ------------------------------------------------------------------ */

const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024, clientTracking: true });

wss.on('connection', (ws) => {
  const client = {
    id: newPeerId(),
    ws,
    roomCode: null,
    name: '',
    role: 'client',
    media: { screen: false, mic: false },
    alive: true,
    chatStamps: [],
    ctrlStamps: [],
    agentWarnedAt: 0,
  };
  ws.ctx = client;

  ws.on('pong', () => {
    client.alive = true;
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;
    try {
      handleMessage(client, msg);
    } catch (err) {
      log('erro ao tratar mensagem:', err.message);
    }
  });

  ws.on('close', () => {
    leaveRoom(client);
  });

  ws.on('error', () => {
    /* ignora */
  });
});

/* --- agente de suporte remoto (roda no PC assistido) --------------- */

const agentWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

agentWss.on('connection', (ws) => {
  let roomCode = null;
  let clientId = null;
  let hostName = 'PC';

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type !== 'hello') return;
    if (roomCode) return;

    pruneAgentCodes();
    const code = String(msg.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const info = agentCodes.get(code);
    if (!info) {
      ws.send(JSON.stringify({ type: 'bye', reason: 'Código inválido ou expirado. Gere um novo na página.' }));
      ws.close();
      return;
    }

    const room = rooms.get(info.room);
    const dono = room && room.get(info.clientId);
    if (!room || !dono || dono.role !== 'client') {
      ws.send(
        JSON.stringify({
          type: 'bye',
          reason: 'A pessoa que gerou o código saiu da sala. Recarregue a página e gere outro.',
        })
      );
      ws.close();
      return;
    }

    roomCode = info.room;
    clientId = info.clientId;
    hostName = String(msg.host || 'PC').replace(/[^\w .\-()]/g, '').slice(0, 40) || 'PC';
    const screen = msg.screen && msg.screen.w > 0 ? { w: Math.round(msg.screen.w), h: Math.round(msg.screen.h) } : null;

    const previous = agents.get(clientId);
    if (previous && previous.ws !== ws) {
      try {
        previous.ws.close();
      } catch {
        /* ignora */
      }
    }
    agents.set(clientId, { ws, room: roomCode, host: hostName, screen, since: Date.now() });
    ws.send(JSON.stringify({ type: 'ok', room: roomCode }));
    broadcastAgentStatus(roomCode, clientId, true, hostName, screen);
    log(`agente conectado em ${roomCode} para ${dono.name} (${hostName}${screen ? ` ${screen.w}x${screen.h}` : ''})`);
  });

  ws.on('close', () => {
    if (!roomCode || !clientId) return;
    const current = agents.get(clientId);
    if (!current || current.ws !== ws) return;
    agents.delete(clientId);
    // revoga qualquer autorização dada a este cliente e avisa o técnico
    clearControlFor(roomCode, clientId, true);
    broadcastAgentStatus(roomCode, clientId, false, null, null);
    log(`agente desconectou de ${roomCode}`);
  });

  ws.on('error', () => {
    /* ignora */
  });
});

function handleMessage(client, msg) {
  const { ws } = client;

  if (msg.type === 'join') {
    if (client.roomCode) return;

    const name = String(msg.name || '').replace(/\s+/g, ' ').trim().slice(0, 32) || 'Convidado';
    const code = String(msg.room || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
    if (code.length < 3) {
      ws.send(JSON.stringify({ type: 'error', message: 'Código de sala inválido.' }));
      return;
    }

    const room = roomOf(code);
    if (room.size >= MAX_PEERS) {
      ws.send(JSON.stringify({ type: 'error', message: `Sala cheia (limite de ${MAX_PEERS} pessoas).` }));
      return;
    }

    client.roomCode = code;
    client.name = name;
    client.role = msg.role === 'tech' ? 'tech' : 'client';
    client.media = { screen: false, mic: false };

    // Quem já está na sala recebe o aviso e inicia a conexão com o recém-chegado.
    broadcast(room, {
      type: 'peer-joined',
      peer: {
        id: client.id,
        name,
        media: client.media,
        role: client.role,
        agent: !!agentFor(code, client.id),
      },
    });

    room.set(client.id, client);

    ws.send(
      JSON.stringify({
        type: 'joined',
        selfId: client.id,
        room: code,
        name,
        role: client.role,
        iceServers: ICE_SERVERS,
        maxPeers: MAX_PEERS,
        peers: peersPayload(code, room, client.id),
        agent: (() => {
          const a = agentFor(code, client.id);
          return a ? { connected: true, host: a.host, screen: a.screen } : { connected: false };
        })(),
      })
    );

    log(`entrou em ${code}: ${name} (${room.size} na sala)`);
    return;
  }

  if (!client.roomCode) return;
  const room = rooms.get(client.roomCode);
  if (!room) return;

  switch (msg.type) {
    case 'signal': {
      const target = room.get(String(msg.to || ''));
      if (!target || target === client) return;
      if (target.ws.readyState !== target.ws.OPEN) return;
      target.ws.send(JSON.stringify({ type: 'signal', from: client.id, data: msg.data }));
      break;
    }

    case 'media': {
      const media = msg.media || {};
      client.media = { screen: !!media.screen, mic: !!media.mic };
      broadcast(room, { type: 'media', from: client.id, media: client.media }, client.id);
      break;
    }

    case 'chat': {
      const text = String(msg.text || '').replace(/\u0000/g, '').slice(0, MAX_CHAT_LEN).trim();
      if (!text) return;

      const now = Date.now();
      client.chatStamps = client.chatStamps.filter((t) => now - t < CHAT_WINDOW);
      if (client.chatStamps.length >= CHAT_BURST) {
        client.ws.send(JSON.stringify({ type: 'error', message: 'Calma aí! Muitas mensagens em pouco tempo.' }));
        return;
      }
      client.chatStamps.push(now);

      broadcast(room, {
        type: 'chat',
        id: crypto.randomUUID(),
        from: client.id,
        name: client.name,
        text,
        ts: now,
      });
      break;
    }

    case 'rename': {
      const name = String(msg.name || '').replace(/\s+/g, ' ').trim().slice(0, 32);
      if (!name) return;
      client.name = name;
      broadcast(room, { type: 'rename', id: client.id, name }, client.id);
      break;
    }

    case 'leave': {
      leaveRoom(client);
      break;
    }

    /* ---------------- suporte remoto ---------------- */

    case 'agent-code': {
      if (client.role !== 'client') return;
      pruneAgentCodes();
      let code = null;
      for (const [c, info] of agentCodes) {
        if (info.room === client.roomCode && info.clientId === client.id && info.exp > Date.now()) {
          code = c;
          break;
        }
      }
      if (!code) {
        // invalida códigos antigos deste cliente para não deixar agente órfão
        for (const [c, info] of agentCodes) {
          if (info.room === client.roomCode && info.clientId === client.id) agentCodes.delete(c);
        }
        code = newAgentCode();
        agentCodes.set(code, { room: client.roomCode, clientId: client.id, exp: Date.now() + AGENT_CODE_TTL });
      }
      ws.send(
        JSON.stringify({
          type: 'agent-code',
          code,
          expiresAt: agentCodes.get(code).exp,
          connected: !!agentFor(client.roomCode, client.id),
        })
      );
      break;
    }

    case 'control-request': {
      if (client.role !== 'tech') return;
      const target = room.get(String(msg.to || ''));
      if (!target || target === client || target.role !== 'client') return;
      target.ws.send(JSON.stringify({ type: 'control-request', from: client.id, name: client.name }));
      ws.send(JSON.stringify({ type: 'control-pending', to: target.id, name: target.name }));
      break;
    }

    case 'control-reply': {
      if (client.role !== 'client') return;
      const tech = room.get(String(msg.to || ''));
      if (!tech || tech === client || tech.role !== 'tech') return;
      if (msg.allow) {
        // um cliente tem no máximo um técnico controlando; um técnico controla
        // no máximo um cliente por vez (evita dois técnicos no mesmo mouse).
        clearControlFor(client.roomCode, client.id, false);
        clearControlFor(client.roomCode, tech.id, false);
        controlAuth.set(`${client.roomCode}|${tech.id}`, { clientId: client.id, since: Date.now() });
        tech.ws.send(JSON.stringify({ type: 'control-granted', from: client.id, name: client.name }));
        ws.send(JSON.stringify({ type: 'control-active', with: tech.id, name: tech.name }));
        log(`controle liberado em ${client.roomCode}: ${tech.name} -> ${client.name}`);
      } else {
        tech.ws.send(JSON.stringify({ type: 'control-denied', from: client.id, name: client.name }));
      }
      break;
    }

    case 'control-revoke': {
      clearControlFor(client.roomCode, client.id, true);
      ws.send(JSON.stringify({ type: 'control-active', with: null }));
      break;
    }

    case 'control': {
      if (client.role !== 'tech') return;
      const auth = controlAuth.get(`${client.roomCode}|${client.id}`);
      if (!auth) return;

      // limite simples para não inundar o agente
      const now = Date.now();
      client.ctrlStamps = client.ctrlStamps.filter((t) => now - t < 1000);
      if (client.ctrlStamps.length > 400) return;
      client.ctrlStamps.push(now);

      const agent = agentFor(client.roomCode, auth.clientId);
      if (!agent) {
        if (now - client.agentWarnedAt > 4000) {
          client.agentWarnedAt = now;
          ws.send(
            JSON.stringify({
              type: 'control-error',
              message: 'O agente não está conectado no computador assistido.',
            })
          );
        }
        return;
      }
      agent.ws.send(JSON.stringify({ type: 'input', data: msg.data }));
      break;
    }

    case 'control-text': {
      if (client.role !== 'tech') return;
      const auth = controlAuth.get(`${client.roomCode}|${client.id}`);
      if (!auth) return;
      const agent = agentFor(client.roomCode, auth.clientId);
      if (!agent) return;
      const text = String(msg.text || '').slice(0, 4000);
      if (!text) return;
      agent.ws.send(JSON.stringify({ type: 'input', data: { t: 'paste', text } }));
      break;
    }

    default:
      break;
  }
}

/* ------------------------------------------------------------------ */
/* HTTPS local                                                         */
/* ------------------------------------------------------------------ */

function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

function ensureCerts() {
  const keyPath = path.join(CERT_DIR, 'key.pem');
  const certPath = path.join(CERT_DIR, 'cert.pem');
  try {
    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
      return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
    }
    const selfsigned = require('selfsigned');
    const altNames = [
      { type: 2, value: 'localhost' },
      { type: 7, ip: '127.0.0.1' },
      ...lanAddresses().map((ip) => ({ type: 7, ip })),
    ];
    const pems = selfsigned.generate([{ name: 'commonName', value: 'Sala de Tela' }], {
      days: 3650,
      keySize: 2048,
      extensions: [{ name: 'subjectAltName', altNames }],
    });
    fs.mkdirSync(CERT_DIR, { recursive: true });
    fs.writeFileSync(keyPath, pems.private);
    fs.writeFileSync(certPath, pems.cert);
    log('certificado HTTPS gerado em certs/ (o navegador vai pedir para confiar)');
    return { key: pems.private, cert: pems.cert };
  } catch (err) {
    log('não foi possível preparar HTTPS:', err.message);
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Inicialização                                                       */
/* ------------------------------------------------------------------ */

const servers = [];
const httpServer = http.createServer(handleRequest);
servers.push(httpServer);

const certs = process.env.NO_HTTPS ? null : ensureCerts();
let httpsServer = null;
if (certs) {
  httpsServer = https.createServer(certs, handleRequest);
  servers.push(httpsServer);
}

for (const server of servers) {
  server.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      /* deixa cair no destroy */
    }
    if (pathname === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
      return;
    }
    if (pathname === '/agente') {
      agentWss.handleUpgrade(req, socket, head, (ws) => agentWss.emit('connection', ws, req));
      return;
    }
    socket.destroy();
  });
}

function reportListenError(err, port) {
  if (err.code === 'EADDRINUSE') {
    log(`a porta ${port} já está em uso. Rode com outra porta, ex.: set PORT=8092 && node server.js`);
  } else {
    log('falha ao abrir a porta ' + port + ':', err.message);
  }
}

httpServer.on('error', (err) => reportListenError(err, HTTP_PORT));
if (httpsServer) httpsServer.on('error', (err) => reportListenError(err, HTTPS_PORT));

httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
  log(`http  em http://localhost:${HTTP_PORT}`);
  for (const ip of lanAddresses()) log(`      em http://${ip}:${HTTP_PORT}`);
});

if (httpsServer) {
  httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
    log(`https em https://localhost:${HTTPS_PORT}`);
    for (const ip of lanAddresses()) log(`      em https://${ip}:${HTTPS_PORT}`);
  });
} else {
  log('sem HTTPS local — compartilhar tela só funciona em http://localhost');
}

// ping/pong para derrubar conexões mortas
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    const client = ws.ctx;
    if (!client) continue;
    if (!client.alive) {
      ws.terminate();
      continue;
    }
    client.alive = false;
    try {
      ws.ping();
    } catch {
      /* ignora */
    }
  }
}, 30000);

// mantém os agentes vivos (o ClientWebSocket do .NET responde ao ping sozinho)
const agentHeartbeat = setInterval(() => {
  for (const ws of agentWss.clients) {
    try {
      ws.ping();
    } catch {
      /* ignora */
    }
  }
}, 25000);

function shutdown() {
  clearInterval(heartbeat);
  clearInterval(agentHeartbeat);
  for (const ws of wss.clients) {
    try {
      ws.close();
    } catch {
      /* ignora */
    }
  }
  for (const server of servers) server.close();
  setTimeout(() => process.exit(0), 200).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
