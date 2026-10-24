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

function peersPayload(room, exceptId) {
  const out = [];
  for (const c of room.values()) {
    if (c.id === exceptId) continue;
    out.push({ id: c.id, name: c.name, media: c.media });
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
/* WebSocket                                                           */
/* ------------------------------------------------------------------ */

const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024, clientTracking: true });

wss.on('connection', (ws) => {
  const client = {
    id: newPeerId(),
    ws,
    roomCode: null,
    name: '',
    media: { screen: false, mic: false },
    alive: true,
    chatStamps: [],
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
    client.media = { screen: false, mic: false };

    // Quem já está na sala recebe o aviso e inicia a conexão com o recém-chegado.
    broadcast(room, { type: 'peer-joined', peer: { id: client.id, name, media: client.media } });

    room.set(client.id, client);

    ws.send(
      JSON.stringify({
        type: 'joined',
        selfId: client.id,
        room: code,
        name,
        iceServers: ICE_SERVERS,
        maxPeers: MAX_PEERS,
        peers: peersPayload(room, client.id),
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
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
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

function shutdown() {
  clearInterval(heartbeat);
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
