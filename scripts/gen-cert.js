'use strict';

/**
 * Gera um certificado autoassinado em certs/ para o HTTPS local.
 * O servidor já faz isso sozinho no primeiro start — este script é só
 * para regenerar quando o IP da máquina mudar.
 *
 *   npm run cert
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const selfsigned = require('selfsigned');

const CERT_DIR = path.join(__dirname, '..', 'certs');

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

const ips = lanAddresses();
const altNames = [
  { type: 2, value: 'localhost' },
  { type: 7, ip: '127.0.0.1' },
  ...ips.map((ip) => ({ type: 7, ip })),
];

const pems = selfsigned.generate([{ name: 'commonName', value: 'Sala de Tela' }], {
  days: 3650,
  keySize: 2048,
  extensions: [{ name: 'subjectAltName', altNames }],
});

fs.mkdirSync(CERT_DIR, { recursive: true });
fs.writeFileSync(path.join(CERT_DIR, 'key.pem'), pems.private);
fs.writeFileSync(path.join(CERT_DIR, 'cert.pem'), pems.cert);

console.log('Certificado gerado em certs/');
console.log('Válido para: localhost, 127.0.0.1' + (ips.length ? ', ' + ips.join(', ') : ''));
