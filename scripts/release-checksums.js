const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { version } = require('../package.json');
const name = `BlinkSend-Portable-${version}.exe`;
const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', 'dist', name))).digest('hex');
fs.writeFileSync(path.join(__dirname, '..', 'dist', 'SHA256SUMS.txt'), `${digest}  ${name}\n`);
