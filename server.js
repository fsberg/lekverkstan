// Lekverkstan: lokal server utan beroenden för att bygga MTG-lekar och planera köp.
// Kortdata från Scryfall, lagerstatus från Alara Games (Shopify-butikens publika sidor).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 8793;
const PUB = path.join(__dirname, 'docs');
const DATA = path.join(__dirname, 'data');
const UA = 'Lekverkstan/1.0 (privat lekbyggare)';
fs.mkdirSync(DATA, { recursive: true });

// ---------- lagring ----------
function load(name, def) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8')); } catch { return def; }
}
const saveTimers = {};
function save(name, obj) {
  clearTimeout(saveTimers[name]);
  saveTimers[name] = setTimeout(() => {
    const f = path.join(DATA, name);
    fs.writeFileSync(f + '.tmp', JSON.stringify(obj, null, 1));
    fs.renameSync(f + '.tmp', f);
  }, 300);
}
let decks = load('decks.json', []);
let collection = load('collection.json', {});   // { "Sol Ring": 2 }
let settings = load('settings.json', { svenskaMagicUrl: 'https://www.svenskamagic.com/kortparmen/index.php?action=search&s_name={q}&tokens=1&special=1&basicland=1&order=name&group=1&n=1' });
const cardCache = load('cardcache.json', {});   // lowercased name -> kortinfo
const alaraCache = load('alaracache.json', {}); // lowercased name -> { at, result }

// ---------- utgående anrop med kö (snälla mot källorna) ----------
function queue(minGapMs) {
  let last = 0, chain = Promise.resolve();
  return fn => {
    const run = chain.then(async () => {
      const wait = last + minGapMs - Date.now();
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      last = Date.now();
      return fn();
    });
    chain = run.catch(() => {});
    return run;
  };
}
const scryQ = queue(110);
const alaraQ = queue(600);

async function getJson(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { 'User-Agent': UA, Accept: 'application/json', ...(opts.headers || {}) } });
  if (!r.ok && r.status !== 404) throw new Error(`${r.status} från ${new URL(url).host}`);
  return { status: r.status, body: await r.json() };
}

// ---------- Scryfall ----------
function slimCard(c) {
  const face = c.card_faces && c.card_faces[0];
  const img = c.image_uris || (face && face.image_uris) || {};
  return {
    name: c.name,
    mana_cost: c.mana_cost ?? (face ? face.mana_cost : ''),
    cmc: c.cmc || 0,
    type_line: c.type_line || (face ? face.type_line : ''),
    colors: c.colors || (face ? face.colors : []) || [],
    color_identity: c.color_identity || [],
    legalities: { commander: c.legalities?.commander, modern: c.legalities?.modern },
    oracle_text: c.oracle_text ?? (c.card_faces || []).map(f => f.oracle_text).join('\n//\n'),
    image: img.normal || '',
    thumb: img.small || '',
    eur: c.prices?.eur ? Number(c.prices.eur) : (c.prices?.eur_foil ? Number(c.prices.eur_foil) : null),
    scryfall: c.scryfall_uri,
    any_number: /A deck can have any number of cards named/i.test(c.oracle_text || ''),
    commander_ok: /Legendary.*Creature/i.test(c.type_line || '') || /can be your commander/i.test(c.oracle_text || ''),
  };
}

async function lookupCards(names) {
  const want = [...new Set(names.map(n => n.trim()).filter(Boolean))];
  const missing = want.filter(n => !cardCache[n.toLowerCase()]);
  const notFound = [];
  for (let i = 0; i < missing.length; i += 75) {
    const ids = missing.slice(i, i + 75).map(name => ({ name }));
    const { body } = await scryQ(() => getJson('https://api.scryfall.com/cards/collection', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifiers: ids }),
    }));
    for (const c of body.data || []) {
      const s = slimCard(c);
      cardCache[s.name.toLowerCase()] = s;
      // dubbelsidiga kort: spara även första sidans namn
      if (s.name.includes(' // ')) cardCache[s.name.split(' // ')[0].toLowerCase()] = s;
    }
    for (const nf of body.not_found || []) notFound.push(nf.name);
  }
  if (missing.length) save('cardcache.json', cardCache);
  const cards = {};
  for (const n of want) if (cardCache[n.toLowerCase()]) cards[n] = cardCache[n.toLowerCase()];
  return { cards, notFound };
}

async function searchCards(q) {
  const { status, body } = await scryQ(() => getJson('https://api.scryfall.com/cards/search?order=edhrec&q=' + encodeURIComponent(q)));
  if (status === 404) return { cards: [], total: 0 };
  const cards = (body.data || []).slice(0, 60).map(slimCard);
  for (const s of cards) cardCache[s.name.toLowerCase()] = s;
  save('cardcache.json', cardCache);
  return { cards, total: body.total_cards || cards.length };
}

async function autocomplete(q) {
  const { body } = await scryQ(() => getJson('https://api.scryfall.com/cards/autocomplete?q=' + encodeURIComponent(q)));
  return body.data || [];
}

// ---------- Alara Games ----------
const ALARA = 'https://www.alaragames.se';
const ALARA_TTL = 6 * 3600 * 1000;

function decodeEntities(s) {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

// Produkttiteln ser ut som "Sol Ring (Showcase) [Avatar: ...]" – vi jämför namnet före ( eller [
function titleMatches(title, name) {
  const t = title.toLowerCase(), n = name.toLowerCase();
  const front = n.split(' // ')[0];
  for (const cand of [n, front]) {
    if (t.startsWith(cand)) {
      const rest = t.slice(cand.length).trimStart();
      if (rest === '' || rest.startsWith('[') || rest.startsWith('(') || rest.startsWith('//')) {
        return !/\bart card\b|\btoken\b|\bcheck(list)? card\b|\bsubstitute card\b/i.test(t.slice(cand.length));
      }
    }
  }
  return false;
}

async function alaraLookup(name, fresh) {
  const key = name.toLowerCase();
  const hit = alaraCache[key];
  if (!fresh && hit && Date.now() - hit.at < ALARA_TTL) return { ...hit.result, cached: true };

  // Butikens egen sökning: bara varor i lager, billigast först
  const url = `${ALARA}/search?type=product&filter.v.availability=1&sort_by=price-ascending&q=` +
    encodeURIComponent(`title:"${name.split(' // ')[0]}"`);
  const html = await alaraQ(async () => {
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!r.ok) throw new Error(`${r.status} från Alara`);
    return r.text();
  });
  const handles = [...new Set([...html.matchAll(/"handle":"([^"]+)"/g)].map(m => m[1]))];

  const offers = [];
  for (const h of handles.slice(0, 8)) {
    const { body: p, status } = await alaraQ(() => getJson(`${ALARA}/products/${h}.js`));
    if (status === 404 || !p.title || !titleMatches(decodeEntities(p.title), name)) continue;
    for (const v of p.variants || []) {
      if (!v.available) continue;
      offers.push({
        title: p.title,
        condition: v.title,
        foil: /foil/i.test(v.title) || /foil/i.test(p.title),
        price: v.price / 100,
        url: `${ALARA}/products/${h}?variant=${v.id}`,
      });
    }
    if (offers.length >= 6) break;
  }
  offers.sort((a, b) => a.price - b.price);
  const result = { name, offers: offers.slice(0, 6), searchUrl: `${ALARA}/search?q=${encodeURIComponent(name)}` };
  alaraCache[key] = { at: Date.now(), result };
  save('alaracache.json', alaraCache);
  return result;
}

// ---------- HTTP ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };

function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', d => { s += d; if (s.length > 5e6) req.destroy(); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

async function api(req, res, url) {
  const p = url.pathname, m = req.method;
  if (p === '/api/state' && m === 'GET') return send(res, 200, { decks, collection, settings });

  if (p === '/api/decks' && m === 'POST') {
    const b = await readBody(req);
    const d = { id: crypto.randomUUID(), name: String(b.name || 'Ny lek').slice(0, 80), format: b.format === 'modern' ? 'modern' : 'commander', cards: [], notes: '', created: Date.now(), updated: Date.now() };
    decks.push(d); save('decks.json', decks);
    return send(res, 200, d);
  }
  const dm = p.match(/^\/api\/decks\/([\w-]+)$/);
  if (dm) {
    const i = decks.findIndex(d => d.id === dm[1]);
    if (i < 0) return send(res, 404, { error: 'Leken finns inte' });
    if (m === 'PUT') {
      const b = await readBody(req);
      const d = decks[i];
      if (typeof b.name === 'string') d.name = b.name.slice(0, 80);
      if (b.format === 'modern' || b.format === 'commander') d.format = b.format;
      if (typeof b.notes === 'string') d.notes = b.notes.slice(0, 5000);
      if (Array.isArray(b.cards)) d.cards = b.cards.filter(c => c && c.name).map(c => ({
        name: String(c.name).slice(0, 150), qty: Math.max(1, Math.min(99, c.qty | 0 || 1)),
        board: ['main', 'side', 'maybe', 'commander'].includes(c.board) ? c.board : 'main',
      }));
      d.updated = Date.now(); save('decks.json', decks);
      return send(res, 200, d);
    }
    if (m === 'DELETE') { decks.splice(i, 1); save('decks.json', decks); return send(res, 200, { ok: true }); }
  }

  if (p === '/api/collection' && m === 'PUT') {
    const b = await readBody(req);
    for (const [name, qty] of Object.entries(b || {})) {
      const n = Math.max(0, Math.min(999, qty | 0));
      if (n) collection[name] = n; else delete collection[name];
    }
    save('collection.json', collection);
    return send(res, 200, collection);
  }
  if (p === '/api/settings' && m === 'PUT') {
    const b = await readBody(req);
    if (typeof b.svenskaMagicUrl === 'string') settings.svenskaMagicUrl = b.svenskaMagicUrl.slice(0, 300);
    save('settings.json', settings);
    return send(res, 200, settings);
  }

  if (p === '/api/cards' && m === 'POST') {
    const b = await readBody(req);
    return send(res, 200, await lookupCards(Array.isArray(b.names) ? b.names.slice(0, 400) : []));
  }
  if (p === '/api/search' && m === 'GET') return send(res, 200, await searchCards(url.searchParams.get('q') || ''));
  if (p === '/api/autocomplete' && m === 'GET') return send(res, 200, await autocomplete(url.searchParams.get('q') || ''));
  if (p === '/api/alara' && m === 'GET') {
    const name = url.searchParams.get('name') || '';
    if (!name) return send(res, 400, { error: 'name saknas' });
    return send(res, 200, await alaraLookup(name, url.searchParams.get('fresh') === '1'));
  }
  send(res, 404, { error: 'okänd väg' });
}

// ---------- åtkomst ----------
// Direkt från datorn: fritt. Via Cloudflare-tunneln (har cf-connecting-ip): kräver nyckeln,
// antingen som ?t=... (sätter en cookie) eller via cookien.
let access = load('access.json', {});
if (!access.token) { access.token = crypto.randomBytes(12).toString('base64url'); fs.writeFileSync(path.join(DATA, 'access.json'), JSON.stringify(access, null, 1)); }
const sameToken = t => typeof t === 'string' && t.length === access.token.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(access.token));
function cookieToken(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)lv=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}
// true = släpp igenom, false = svaret är redan skickat
function checkAccess(req, res, url) {
  const viaTunnel = !!req.headers['cf-connecting-ip'];
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  if (local && !viaTunnel) return true;
  const q = url.searchParams.get('t');
  if (q && sameToken(q)) {
    url.searchParams.delete('t');
    res.writeHead(302, {
      'Set-Cookie': `lv=${encodeURIComponent(access.token)}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`,
      Location: url.pathname + (url.search || ''),
    });
    res.end();
    return false;
  }
  if (sameToken(cookieToken(req))) return true;
  res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Förbjudet');
  return false;
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!checkAccess(req, res, url)) return;
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    let f = path.normalize(path.join(PUB, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)));
    if (!f.startsWith(PUB)) { res.writeHead(403); return res.end(); }
    fs.readFile(f, (err, buf) => {
      if (err) { res.writeHead(404); return res.end('Saknas'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
}).listen(PORT, '127.0.0.1', () => console.log(`Lekverkstan: http://localhost:${PORT}/`));
