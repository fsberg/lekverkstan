// Skriver ut tunnellänken med nyckel (läser cloudflared-loggen)
const fs = require('fs'), path = require('path');
const log = path.join(__dirname, '..', 'data', 'tunnel.log');
const token = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'access.json'), 'utf8')).token;
const start = Date.now();
(function poll() {
  let s = '';
  try { s = fs.readFileSync(log, 'utf8'); } catch {}
  const urls = s.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g);
  if (urls) return console.log(`\n  Lekverkstan utifrån:\n  ${urls[urls.length - 1]}/?t=${token}\n`);
  if (Date.now() - start > 30000) return console.log('Hittade ingen tunneladress - titta i data\tunnel.log');
  setTimeout(poll, 500);
})();
