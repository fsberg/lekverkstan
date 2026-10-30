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
let games = load('games.json', []);
let trade = load('trade.json', {}); // lokalt: bara egen markering, ingen bytesbörs
let wishlist = load('wishlist.json', []);
let loans = load('loans.json', []);
let colmeta = load('colmeta.json', {}); // { "Sol Ring": { added: 1730000000000, prints: [...] } }
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
    eur_foil: c.prices?.eur_foil ? Number(c.prices.eur_foil) : null,
    id: c.id, set: c.set,
    scryfall: c.scryfall_uri,
    any_number: /A deck can have any number of cards named/i.test(c.oracle_text || ''),
    commander_ok: /Legendary.*Creature/i.test(c.type_line || '') || /can be your commander/i.test(c.oracle_text || ''),
    game_changer: !!c.game_changer,
    v: 3,
  };
}
// en utgåva av ett kort, för val av utgåva och foil i samlingen
const slimPrint = c => ({
  id: c.id, set: c.set, set_name: c.set_name, cn: c.collector_number, released: c.released_at,
  eur: c.prices?.eur ? Number(c.prices.eur) : null, eur_foil: c.prices?.eur_foil ? Number(c.prices.eur_foil) : null,
  foil: (c.finishes || []).includes('foil') || (c.finishes || []).includes('etched'), nonfoil: (c.finishes || []).includes('nonfoil'),
  thumb: (c.image_uris || c.card_faces?.[0]?.image_uris || {}).small || '',
  extra: [c.border_color === 'borderless' && 'borderless', c.full_art && 'full art', ...(c.frame_effects || []).filter(f => ['showcase', 'extendedart', 'etched', 'inverted'].includes(f))].filter(Boolean),
});

function remember(s) {
  cardCache[s.name.toLowerCase()] = s;
  // dubbelsidiga kort: spara även första sidans namn
  if (s.name.includes(' // ')) cardCache[s.name.split(' // ')[0].toLowerCase()] = s;
}
// v3: billigaste utgåvan (prefer:eur-low), så att dyra specialutgåvor inte blåser upp värdet
async function lookupCards(names) {
  const want = [...new Set(names.map(n => n.trim()).filter(Boolean))];
  const missing = want.filter(n => cardCache[n.toLowerCase()]?.v !== 3);
  const notFound = [];
  let rest = [];
  for (let i = 0; i < missing.length; i += 25) {
    const part = missing.slice(i, i + 25);
    const q = '(' + part.map(n => '!"' + n.replace(/"/g, '') + '"').join(' or ') + ') prefer:eur-low';
    const { status, body } = await scryQ(() => getJson('https://api.scryfall.com/cards/search?q=' + encodeURIComponent(q)));
    const got = new Set();
    if (status !== 404) for (const c of body.data || []) {
      const hit = part.find(n => n.toLowerCase() === c.name.toLowerCase() || n.toLowerCase() === c.name.split(' // ')[0].toLowerCase());
      if (hit) { remember(slimCard(c)); got.add(hit); }
    }
    rest.push(...part.filter(n => !got.has(n)));
  }
  for (let i = 0; i < rest.length; i += 75) {
    const ids = rest.slice(i, i + 75).map(name => ({ name }));
    const { body } = await scryQ(() => getJson('https://api.scryfall.com/cards/collection', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifiers: ids }),
    }));
    for (const c of body.data || []) remember(slimCard(c));
    for (const nf of body.not_found || []) notFound.push(nf.name);
  }
  if (missing.length) save('cardcache.json', cardCache);
  const cards = {};
  for (const n of want) if (cardCache[n.toLowerCase()]) cards[n] = cardCache[n.toLowerCase()];
  return { cards, notFound };
}

async function searchCards(q, max = 60) {
  const { status, body } = await scryQ(() => getJson('https://api.scryfall.com/cards/search?order=edhrec&q=' + encodeURIComponent(q + ' prefer:eur-low')));
  if (status === 404) return { cards: [], total: 0 };
  const cards = (body.data || []).slice(0, Math.min(175, max)).map(slimCard);
  for (const s of cards) cardCache[s.name.toLowerCase()] = s;
  save('cardcache.json', cardCache);
  return { cards, total: body.total_cards || cards.length };
}

// skanning: kortet med billigaste priset + utgåvan som Scryfall gissade på
async function fuzzy(q) {
  const { status, body } = await scryQ(() => getJson('https://api.scryfall.com/cards/named?fuzzy=' + encodeURIComponent(q)));
  if (status === 404) return { notFound: true };
  const { cards } = await lookupCards([body.name]);
  return { ...(cards[body.name] || slimCard(body)), print: slimPrint(body) };
}
async function prints(name) {
  const { status, body } = await scryQ(() => getJson('https://api.scryfall.com/cards/search?unique=prints&order=released&q=' + encodeURIComponent('!"' + name.replace(/"/g, '') + '"')));
  if (status === 404) return [];
  return (body.data || []).filter(c => c.name.toLowerCase() === name.toLowerCase() || c.name.split(' // ')[0].toLowerCase() === name.toLowerCase()).map(slimPrint);
}
// aktuella priser för sparade utgåvor
async function pricesById(ids) {
  const out = {};
  ids = [...new Set(ids)].filter(x => /^[0-9a-f-]{36}$/.test(x)).slice(0, 600);
  for (let i = 0; i < ids.length; i += 75) {
    const { body } = await scryQ(() => getJson('https://api.scryfall.com/cards/collection', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifiers: ids.slice(i, i + 75).map(id => ({ id })) }),
    }));
    for (const c of body.data || []) out[c.id] = { eur: c.prices?.eur ? Number(c.prices.eur) : null, eur_foil: c.prices?.eur_foil ? Number(c.prices.eur_foil) : null };
  }
  return out;
}
// utgåvor i samlingen: [{ id, set, cn, foil, qty, eur }] – tvättas på samma sätt lokalt och i molnet
const cleanPrints = a => (Array.isArray(a) ? a : []).slice(0, 30).filter(p => p && p.qty > 0).map(p => ({
  id: /^[0-9a-f-]{36}$/.test(p.id) ? p.id : null, set: String(p.set || '').slice(0, 10), cn: String(p.cn || '').slice(0, 12),
  foil: !!p.foil, qty: Math.min(999, p.qty | 0), eur: typeof p.eur === 'number' ? p.eur : null,
}));

// ---------- regler ----------
let rulesCache = null;
async function rules() {
  if (rulesCache && Date.now() - rulesCache.at < 24 * 3600e3) return { url: rulesCache.url, text: rulesCache.text };
  const page = await fetch('https://magic.wizards.com/en/rules', { headers: { 'User-Agent': UA } });
  if (!page.ok) throw new Error(`${page.status} från Wizards`);
  const m = (await page.text()).match(/https:\/\/media\.wizards\.com\/[^"']+?\.txt/);
  if (!m) throw new Error('Hittade ingen regeltext hos Wizards');
  const url = m[0].replace(/ /g, '%20');
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`${r.status} från Wizards`);
  rulesCache = { at: Date.now(), url, text: (await r.text()).slice(0, 3e6) };
  return { url, text: rulesCache.text };
}
async function rulings(id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return [];
  const { status, body } = await scryQ(() => getJson(`https://api.scryfall.com/cards/${id}/rulings`));
  return status === 404 ? [] : (body.data || []).map(r => ({ date: r.published_at, text: r.comment, source: r.source }));
}

// ---------- Commander Spellbook och Archidekt ----------
const slimCombo = c => ({
  id: c.id, uses: (c.uses || []).map(u => u.card?.name).filter(Boolean), produces: (c.produces || []).map(p => p.feature?.name).filter(Boolean),
  steps: String(c.description || '').slice(0, 1500), prereq: [c.easyPrerequisites, c.notablePrerequisites].filter(Boolean).join('\n').slice(0, 600), popularity: c.popularity || 0,
});
async function combos(b) {
  const list = a => (Array.isArray(a) ? a : []).slice(0, 250).map(n => ({ card: String(n).slice(0, 150) }));
  const { body } = await getJson('https://backend.commanderspellbook.com/find-my-combos', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ commanders: list(b.commanders), main: list(b.main) }),
  });
  const r = body.results || {};
  const top = (a = [], n) => a.slice().sort((x, y) => (y.popularity || 0) - (x.popularity || 0)).slice(0, n).map(slimCombo);
  return { included: top(r.included, 60), almost: top(r.almostIncluded, 40) };
}
const BOARD = { commander: 'commander', sideboard: 'side', maybeboard: 'maybe', considering: 'maybe' };
async function archidekt(id) {
  if (!/^\d{1,10}$/.test(id)) throw new Error('Ogiltigt lek-id');
  const { status, body: d } = await getJson(`https://archidekt.com/api/decks/${id}/`);
  if (status === 404) throw new Error('Leken finns inte eller är privat');
  const outside = new Set((d.categories || []).filter(c => !c.includedInDeck).map(c => c.name));
  const cards = (d.cards || []).map(c => {
    const cats = c.categories || [];
    let board = 'main';
    for (const k of cats) { const b = BOARD[k.toLowerCase()]; if (b) { board = b; break; } }
    if (board === 'main' && cats.length && cats.every(k => outside.has(k))) board = 'maybe';
    return { name: c.card?.oracleCard?.name, qty: c.quantity || 1, board };
  }).filter(c => c.name);
  return { name: String(d.name || 'Importerad lek').slice(0, 80), format: d.deckFormat === 2 ? 'modern' : 'commander', cards };
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
  if (p === '/api/state' && m === 'GET') return send(res, 200, { decks, collection, trade, games, wishlist, loans, colmeta, v3: true, v4: true, profile: { name: '' }, cloud: false, settings });
  if (p === '/api/wishlist' && m === 'PUT') {
    const b = await readBody(req);
    const name = String(b.name || '').slice(0, 150);
    if (!name) return send(res, 400, { error: 'name saknas' });
    let w = wishlist.find(x => x.name === name);
    if (!w) { w = { name, qty: 1, max_price: null, last_price: null, in_stock: null, checked_at: null, alert: false, note: '', created: new Date().toISOString() }; wishlist.push(w); }
    for (const k of ['qty', 'max_price', 'last_price', 'in_stock', 'checked_at', 'alert', 'note']) if (k in b) w[k] = b[k];
    save('wishlist.json', wishlist);
    return send(res, 200, w);
  }
  if (p === '/api/wishlist' && m === 'DELETE') { const n = url.searchParams.get('name'); wishlist = wishlist.filter(x => x.name !== n); save('wishlist.json', wishlist); return send(res, 200, { ok: true }); }
  if (p === '/api/loans' && m === 'POST') {
    const b = await readBody(req);
    const l = { id: crypto.randomUUID(), name: String(b.name || '').slice(0, 150), qty: Math.max(1, Math.min(99, b.qty | 0 || 1)), borrower: String(b.borrower || '').trim().slice(0, 60), lent_on: b.lent_on || new Date().toISOString().slice(0, 10), note: String(b.note || '').slice(0, 200), created: new Date().toISOString() };
    if (!l.name || !l.borrower) return send(res, 400, { error: 'Kort och lånare krävs' });
    loans.unshift(l); save('loans.json', loans);
    return send(res, 200, l);
  }
  const lm = p.match(/^\/api\/loans\/([\w-]+)$/);
  if (lm && m === 'DELETE') { loans = loans.filter(l => l.id !== lm[1]); save('loans.json', loans); return send(res, 200, { ok: true }); }
  if (p === '/api/rules' && m === 'GET') return send(res, 200, await rules());
  if (p === '/api/rulings' && m === 'GET') return send(res, 200, await rulings(url.searchParams.get('id') || ''));
  if (p === '/api/fuzzy' && m === 'GET') return send(res, 200, await fuzzy(url.searchParams.get('q') || ''));
  if (p === '/api/combos' && m === 'POST') return send(res, 200, await combos(await readBody(req)));
  if (p === '/api/archidekt' && m === 'GET') return send(res, 200, await archidekt(url.searchParams.get('id') || ''));
  if (p === '/api/public-decks' || p === '/api/trades' || p === '/api/bookings') return send(res, 200, []);
  if (p === '/api/profile' && m === 'PUT') return send(res, 200, { name: '' });
  if (p === '/api/trade' && m === 'PUT') {
    const b = await readBody(req);
    for (const [name, n] of Object.entries(b || {})) { const v = Math.max(0, Math.min(collection[name] || 0, n | 0)); if (v) trade[name] = v; else delete trade[name]; }
    save('trade.json', trade);
    return send(res, 200, trade);
  }
  if (p === '/api/games' && m === 'POST') {
    const b = await readBody(req);
    const g = { id: crypto.randomUUID(), deck_id: b.deck_id || null, deck_name: String(b.deck_name || 'Okänd lek').slice(0, 80), played_on: b.played_on || new Date().toISOString().slice(0, 10), result: ['win', 'loss', 'draw'].includes(b.result) ? b.result : 'loss', players: Math.max(2, Math.min(10, b.players | 0 || 2)), opponents: String(b.opponents || '').slice(0, 300), notes: String(b.notes || '').slice(0, 1000), created: new Date().toISOString() };
    games.unshift(g); save('games.json', games);
    return send(res, 200, g);
  }
  const gm = p.match(/^\/api\/games\/([\w-]+)$/);
  if (gm && m === 'DELETE') { games = games.filter(g => g.id !== gm[1]); save('games.json', games); return send(res, 200, { ok: true }); }

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
      if (typeof b.public === 'boolean') d.public = b.public;
      if (Array.isArray(b.versions)) d.versions = b.versions.slice(0, 20);
      if (Array.isArray(b.cards)) d.cards = b.cards.filter(c => c && c.name).map(c => ({
        name: String(c.name).slice(0, 150), qty: Math.max(1, Math.min(99, c.qty | 0 || 1)),
        board: ['main', 'side', 'maybe', 'commander'].includes(c.board) ? c.board : 'main',
        ...(typeof c.cat === 'string' && c.cat ? { cat: c.cat.slice(0, 30) } : {}),
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
      if (n > (collection[name] || 0)) (colmeta[name] = colmeta[name] || {}).added = Date.now();
      if (n) collection[name] = n; else { delete collection[name]; delete colmeta[name]; }
    }
    save('collection.json', collection); save('colmeta.json', colmeta);
    return send(res, 200, collection);
  }
  if (p === '/api/prints' && m === 'PUT') {
    const b = await readBody(req);
    const name = String(b.name || '');
    if (!collection[name]) return send(res, 400, { error: 'Kortet finns inte i samlingen' });
    (colmeta[name] = colmeta[name] || { added: Date.now() }).prints = cleanPrints(b.prints);
    save('colmeta.json', colmeta);
    return send(res, 200, colmeta[name]);
  }
  if (p === '/api/prints' && m === 'GET') return send(res, 200, await prints(url.searchParams.get('name') || ''));
  if (p === '/api/prices' && m === 'POST') return send(res, 200, await pricesById((await readBody(req)).ids || []));
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
  if (p === '/api/search' && m === 'GET') return send(res, 200, await searchCards(url.searchParams.get('q') || '', +url.searchParams.get('max') || 60));
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
