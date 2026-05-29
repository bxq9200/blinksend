const fs = require('node:fs');
const path = require('node:path');
const pngToIco = require('png-to-ico').default;

const pngPath = path.join(__dirname, '..', 'src', 'assets', 'logo.png');
const icoPath = path.join(__dirname, '..', 'src', 'assets', 'logo.ico');
const buildIcoPath = path.join(__dirname, '..', 'build', 'icon.ico');

pngToIco(pngPath).then((buffer) => {
  fs.writeFileSync(icoPath, buffer);
  fs.mkdirSync(path.dirname(buildIcoPath), { recursive: true });
  fs.writeFileSync(buildIcoPath, buffer);
});
