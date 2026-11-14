// Lekverkstan – gränssnitt (vanilla JS, ingen byggprocess)
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const kr = n => n == null ? '–' : n.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' kr';
const eur = n => n == null ? '–' : '€' + n.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const S = { decks: [], collection: {}, settings: {}, cards: {}, alara: {}, tab: 'lista', basicsOwned: true, notFound: new Set(), alaraRun: null };
try { S.basicsOwned = localStorage.getItem('basicsOwned') !== '0'; S.view = localStorage.getItem('lv-view') || 'lista'; } catch {}
Object.assign(S, { trade: {}, games: [], profile: { name: '' }, cloud: false, trades: null, publicDecks: null, edhrec: {} });
Object.assign(S, { wishlist: [], loans: [], v3: false, rate: 11.5, combos: {}, offline: false });
Object.assign(S, { colmeta: {}, v4: false, bookings: null, v6: false, v7: false, events: null, valueLog: null });
try { S.group = localStorage.getItem('lv-group') || 'typ'; } catch {}
// ungefärligt värde i kronor från Scryfalls europris (Cardmarket, billigaste utgåvan).
// Svenska butiker tar i snitt ca 30 % mer för samma utgåva (jämfört mot Alara), så det är standard.
const MARKUP = 1.3;
try { S.priceLevel = localStorage.getItem('lv-price') === 'cm' ? 'cm' : 'butik'; } catch { S.priceLevel = 'butik'; }
const sek = e => e * S.rate * (S.priceLevel === 'cm' ? 1 : MARKUP);
const krE = e => e == null ? '–' : (e > 0 && sek(e) < 1 ? '<1' : Math.round(sek(e)).toLocaleString('sv-SE')) + ' kr';
const priceWhat = () => S.priceLevel === 'cm' ? 'Cardmarket-pris, billigaste utgåvan' : 'ungefärligt svenskt butikspris (Cardmarket + 30 %)';
const lentQty = name => S.loans.filter(l => l.name === name).reduce((a, l) => a + l.qty, 0);

const BASICS = new Set(['Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Wastes', 'Snow-Covered Plains', 'Snow-Covered Island', 'Snow-Covered Swamp', 'Snow-Covered Mountain', 'Snow-Covered Forest']);
const TYPE_ORDER = ['Creature', 'Planeswalker', 'Battle', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Land'];
const TYPE_SV = { Commander: 'Befälhavare', Creature: 'Varelser', Planeswalker: 'Planeswalkers', Battle: 'Strider', Instant: 'Instants', Sorcery: 'Sorceries', Artifact: 'Artefakter', Enchantment: 'Förtrollningar', Land: 'Länder', Other: 'Övrigt', side: 'Sidolek', maybe: 'Kanske' };
const FORMAT_SV = { commander: 'Commander', modern: 'Modern' };

// ---------- API ----------
async function api(path, opts = {}) {
  if (window.LV_BACKEND) return window.LV_BACKEND(path, opts); // molnläge, se backend.js
  const r = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json' }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
function toast(msg, ms = 2200) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), ms);
}

async function ensureCards(names, fresh) {
  const need = [...new Set(names)].filter(n => fresh || (!S.cards[n] && !S.notFound.has(n)));
  const missing = [];
  for (let i = 0; i < need.length; i += 400) {
    const part = need.slice(i, i + 400);
    const { cards, notFound } = await api('/api/cards', { method: 'POST', body: { names: part, fresh: !!fresh } });
    Object.assign(S.cards, cards);
    for (const n of part) if (!cards[n]) S.notFound.add(n);
    missing.push(...notFound);
  }
  return missing;
}

const saveDeckSoon = (() => {
  let t;
  return deck => { clearTimeout(t); t = setTimeout(() => api('/api/decks/' + deck.id, { method: 'PUT', body: deck }).catch(e => toast('Kunde inte spara: ' + e.message)), 350); };
})();
async function setOwned(name, qty) {
  qty = Math.max(0, qty | 0);
  if (qty > (S.collection[name] || 0)) (S.colmeta[name] = S.colmeta[name] || { prints: [] }).added = Date.now();
  if (qty) S.collection[name] = qty; else { delete S.collection[name]; delete S.colmeta[name]; }
  await api('/api/collection', { method: 'PUT', body: { [name]: qty } });
  // färre ex än angivna utgåvor: ta bort från de senast angivna
  const pr = S.colmeta[name]?.prints || [];
  let over = pr.reduce((a, p) => a + p.qty, 0) - qty;
  if (qty && over > 0) {
    const next = pr.map(p => ({ ...p }));
    for (let i = next.length - 1; i >= 0 && over > 0; i--) { const d = Math.min(over, next[i].qty); next[i].qty -= d; over -= d; }
    await savePrints(name, next.filter(p => p.qty > 0)).catch(() => {});
  }
}
// utgåvor och foil per kort i samlingen: [{ id, set, cn, foil, qty, eur }]
async function savePrints(name, prints) {
  const r = await api('/api/prints', { method: 'PUT', body: { name, prints } });
  (S.colmeta[name] = S.colmeta[name] || { added: Date.now() }).prints = r.prints || prints;
}
const printsOf = name => S.colmeta[name]?.prints || [];
// värdet för ett antal ex: dina angivna utgåvor först (foil, specialutgåvor), resten till billigaste utgåvan
function cardVal(name, qty) {
  const c = S.cards[name];
  let v = 0, left = qty, any = c?.eur != null;
  for (const p of printsOf(name)) {
    if (left <= 0) break;
    const e = p.eur ?? (p.foil ? c?.eur_foil : null) ?? c?.eur;
    if (e == null) continue;
    const k = Math.min(left, p.qty); v += e * k; left -= k; any = true;
  }
  return any ? v + left * (c?.eur || 0) : null;
}
const ownPrinted = (name, qty) => printsOf(name).some(p => p.eur != null) && cardVal(name, qty) !== (S.cards[name]?.eur ?? 0) * qty;
const foilQty = name => printsOf(name).filter(p => p.foil).reduce((a, p) => a + p.qty, 0);
// värde för det man äger: angivna utgåvor med sina priser, resten till billigaste utgåvan
function colValue(name) {
  const c = S.cards[name], q = S.collection[name] || 0;
  let v = 0, n = 0;
  for (const p of printsOf(name)) { v += (p.eur ?? (p.foil ? c?.eur_foil : null) ?? c?.eur ?? 0) * p.qty; n += p.qty; }
  return v + Math.max(0, q - n) * (c?.eur || 0);
}
// bild för en viss utgåva: Scryfalls bildadress byggs av kortets id
const printImg = (p, size = 'normal') => p?.id ? `https://cards.scryfall.io/${size}/front/${p.id[0]}/${p.id[1]}/${p.id}.jpg` : '';
// bilden som visas för ett kort i samlingen: första angivna utgåvan, annars standardbilden
const printOf1 = name => printsOf(name).find(p => p.id);
const ownImg = name => printImg(printsOf(name).find(p => p.id)) || S.cards[name]?.image || '';
const printLabel = p => `${p.foil ? '✦ foil ' : ''}${(p.set || '').toUpperCase()}${p.cn ? ' #' + p.cn : ''}`;

// ---------- regler ----------
const owned = name => S.collection[name] || (S.basicsOwned && BASICS.has(name) ? 999 : 0);
// ex som sitter i ihopbyggda lekar: [{ id, name, qty }]
function builtIn(name) {
  if (S.basicsOwned && BASICS.has(name)) return [];
  const out = [];
  for (const d of S.decks) {
    if (!d.built) continue;
    const qty = d.cards.filter(c => c.name === name && c.board !== 'maybe').reduce((a, c) => a + c.qty, 0);
    if (qty) out.push({ id: d.id, name: d.name, qty });
  }
  return out;
}
const reserved = (name, deck) => deck?.built ? 0 : builtIn(name).reduce((a, x) => a + x.qty, 0);
// ex som är lediga för en lek: en ihopbyggd lek räknar allt, andra lekar bara det som inte sitter i en ihopbyggd
const free = (name, deck) => Math.max(0, owned(name) - reserved(name, deck));
// så många ex som samlingen måste ha för att leken ska få sina utan att ta från en ihopbyggd lek
const ownTarget = (name, deck, need) => Math.max(S.collection[name] || 0, need + reserved(name, deck));
function mainType(card) {
  const t = (card?.type_line || '').split(' // ')[0];
  return TYPE_ORDER.find(x => t.includes(x)) || 'Other';
}
function isFreeQty(name) {
  return BASICS.has(name) || S.cards[name]?.any_number;
}

function deckIssues(deck) {
  const out = [];
  const inDeck = deck.cards.filter(c => c.board === 'main' || c.board === 'commander');
  const total = inDeck.reduce((a, c) => a + c.qty, 0);
  const side = deck.cards.filter(c => c.board === 'side').reduce((a, c) => a + c.qty, 0);
  const fmt = deck.format;
  if (fmt === 'commander') {
    const cmd = deck.cards.filter(c => c.board === 'commander');
    if (!cmd.length) out.push(['warn', 'Ingen befälhavare vald. Klicka ★ på ett kort.']);
    if (total !== 100) out.push([total > 100 ? 'bad' : 'warn', `${total} av 100 kort.`]);
    const ident = new Set(cmd.flatMap(c => S.cards[c.name]?.color_identity || []));
    for (const c of cmd) if (S.cards[c.name] && !S.cards[c.name].commander_ok) out.push(['bad', `${c.name} kan inte vara befälhavare.`]);
    for (const c of inDeck) {
      if (c.qty > 1 && !isFreeQty(c.name)) out.push(['bad', `${c.name}: ${c.qty} ex – Commander tillåter bara 1.`]);
      const info = S.cards[c.name];
      if (cmd.length && info && c.board !== 'commander' && info.color_identity.some(x => !ident.has(x))) out.push(['bad', `${c.name} ligger utanför befälhavarens färger.`]);
    }
  } else {
    if (total < 60) out.push(['warn', `${total} kort i huvudleken (minst 60).`]);
    if (side > 15) out.push(['bad', `${side} kort i sidoleken (max 15).`]);
    const counts = {};
    for (const c of deck.cards) if (c.board !== 'maybe') counts[c.name] = (counts[c.name] || 0) + c.qty;
    for (const [n, q] of Object.entries(counts)) if (q > 4 && !isFreeQty(n)) out.push(['bad', `${n}: ${q} ex – max 4.`]);
  }
  for (const c of deck.cards) {
    if (c.board === 'maybe') continue;
    const info = S.cards[c.name];
    if (!info) { out.push(['warn', `Hittar inte "${c.name}" hos Scryfall – kontrollera stavningen.`]); continue; }
    const l = info.legalities[fmt];
    if (l === 'banned') out.push(['bad', `${c.name} är bannad i ${FORMAT_SV[fmt]}.`]);
    else if (l && l !== 'legal') out.push(['bad', `${c.name} är inte tillåten i ${FORMAT_SV[fmt]}.`]);
  }
  if (!out.length) out.push(['good', `Leken ser laglig ut för ${FORMAT_SV[fmt]}.`]);
  return out;
}

// ---------- roller (gissning från korttexten, kan ändras per kort) ----------
const ROLES = {
  Ramp: /add \{|adds? (one|two|three) mana|search your library for (a|an|up to \w+) (basic )?lands?|put (a|up to \w+) lands? cards? .*onto the battlefield|create (a|\w+) treasure/i,
  Kortdragning: /draws? (a|an|two|three|four|five|x|that many|\w+) cards?|investigate|exile the top .* you may play (it|them|those)|look at the top .* put .* into your hand/i,
  Removal: /destroy target|exile target|deals? (\d+|x) damage to (any target|target creature|target planeswalker|target permanent)|counter target|return target (creature|nonland permanent|permanent|artifact|enchantment) to (its|their) owner'?s hand|target creature gets -\d+\/-\d+|fights? (target|up to one target)/i,
  Massborttagning: /destroy all|exile all|all creatures get -|deals? (\d+|x) damage to each creature|return all (creatures|nonland)|each player sacrifices (all|\w+) creatures/i,
  Tutors: /search your library for (a|an|up to \w+) (?!basic|land)\w+/i,
};
const ROLE_ORDER = ['Ramp', 'Kortdragning', 'Removal', 'Massborttagning', 'Tutors'];
// mallen för Commander: [min, max]
const ROLE_TARGET = { Länder: [36, 38], Ramp: [10, 12], Kortdragning: [10, 12], Removal: [8, 10], Massborttagning: [2, 3] };
function rolesOf(c) {
  if (c.cat === 'none') return [];
  if (c.cat) return [c.cat];
  const info = S.cards[c.name];
  if (!info || mainType(info) === 'Land') return [];
  return ROLE_ORDER.filter(k => ROLES[k].test(info.oracle_text || ''));
}
function roleCounts(deck) {
  const play = deck.cards.filter(c => c.board === 'main' || c.board === 'commander');
  const out = { Länder: 0, ...Object.fromEntries(ROLE_ORDER.map(k => [k, 0])) };
  for (const c of play) {
    if (mainType(S.cards[c.name]) === 'Land' && !c.cat) out.Länder += c.qty;
    for (const r of rolesOf(c)) out[r] += c.qty;
  }
  return out;
}

// ---------- Commander-bracket (uppskattning enligt Wizards bracket-system) ----------
const MLD = /destroy all (non\w+ )?lands|sacrifices? (all|\w+) lands|lands (you|your opponents|players) control don'?t untap|players can'?t untap more than/i;
const BRACKET_SV = { 1: 'Exhibition', 2: 'Core', 3: 'Upgraded', 4: 'Optimized' };
function bracketInfo(deck) {
  const play = deck.cards.filter(c => c.board === 'main' || c.board === 'commander');
  const gc = play.filter(c => S.cards[c.name]?.game_changer).map(c => c.name);
  const mld = play.filter(c => MLD.test(S.cards[c.name]?.oracle_text || '')).map(c => c.name);
  const extra = play.filter(c => /take an extra turn/i.test(S.cards[c.name]?.oracle_text || '')).map(c => c.name);
  const cmb = S.combos[deck.id]?.data;
  const two = cmb ? cmb.included.filter(x => x.uses.length <= 2) : null;
  const why = [];
  let b = 2;
  if (gc.length) { b = 3; why.push(`${gc.length} game changer${gc.length > 1 ? 's' : ''}`); }
  if (extra.length >= 2) { b = Math.max(b, 3); why.push(`${extra.length} kort med extra turer`); }
  if (gc.length > 3) { b = 4; }
  if (mld.length) { b = 4; why.push('massförstörelse av länder'); }
  if (two?.length) { b = 4; why.push(`${two.length} kombo${two.length > 1 ? 's' : ''} med bara två kort`); }
  return { b, gc, mld, extra, two, why };
}

function missingCards(deck, includeMaybe = false) {
  const need = {};
  for (const c of deck.cards) if (includeMaybe || c.board !== 'maybe') need[c.name] = (need[c.name] || 0) + c.qty;
  return Object.entries(need).map(([name, qty]) => ({ name, qty, missing: Math.max(0, qty - free(name, deck)) })).filter(x => x.missing > 0);
}

// ---------- import ----------
function parseList(text, format) {
  const out = [];
  let board = 'main', sawHeader = false, blankSeen = false;
  for (let raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) { if (out.length) blankSeen = true; continue; }
    if (line.startsWith('//') || line.startsWith('#')) continue;
    const h = line.toLowerCase().replace(/[:\s]+$/, '');
    if (/^(commander|befälhavare)$/.test(h)) { board = 'commander'; sawHeader = true; continue; }
    if (/^(deck|main|mainboard|huvudlek)$/.test(h)) { board = 'main'; sawHeader = true; continue; }
    if (/^(sideboard|sidolek)$/.test(h)) { board = 'side'; sawHeader = true; continue; }
    if (/^(maybe|maybeboard|kanske)$/.test(h)) { board = 'maybe'; sawHeader = true; continue; }
    if (/^(companion|tokens?)$/.test(h)) { board = h.startsWith('token') ? 'skip' : 'side'; sawHeader = true; continue; }
    if (board === 'skip') continue;
    let b = board;
    if (/^sb:\s*/i.test(line)) { b = 'side'; line = line.replace(/^sb:\s*/i, ''); }
    else if (!sawHeader && blankSeen && format === 'modern') b = 'side';
    const m = line.match(/^(\d+)\s*x?\s+(.+)$/i);
    let qty = 1, name = line;
    if (m) { qty = +m[1]; name = m[2]; }
    const cmdTag = /\*cmdr\*|\[commander\]/i.test(name);
    name = name
      .replace(/\s+\*[A-Z]+\*/gi, '')          // *F* *CMDR*
      .replace(/\s+\[[^\]]*\]\s*$/g, '')      // [Commander]
      .replace(/\s+\([A-Z0-9]{2,6}\)(\s+[\w★-]+)?\s*$/i, '') // (SET) 123
      .replace(/\s+#.*$/, '')
      .trim();
    if (name.includes(' / ') && !name.includes(' // ')) name = name.replace(' / ', ' // ');
    if (name) out.push({ name, qty, board: cmdTag ? 'commander' : b });
  }
  return out;
}

function mergeCards(deck, list) {
  for (const n of list) {
    const ex = deck.cards.find(c => c.name.toLowerCase() === n.name.toLowerCase() && c.board === n.board);
    if (ex) ex.qty += n.qty; else deck.cards.push({ ...n });
  }
}
// Byt importerade namn mot Scryfalls stavning
function canonicalize(deck) {
  for (const c of deck.cards) {
    const hit = S.cards[c.name] || Object.values(S.cards).find(x => x.name.toLowerCase() === c.name.toLowerCase() || x.name.split(' // ')[0].toLowerCase() === c.name.toLowerCase());
    if (hit && hit.name !== c.name) { S.cards[hit.name] = hit; c.name = hit.name; }
  }
  // slå ihop dubbletter som uppstått
  const seen = {};
  deck.cards = deck.cards.filter(c => {
    const k = c.board + '|' + c.name;
    if (seen[k]) { seen[k].qty += c.qty; return false; }
    seen[k] = c; return true;
  });
}

function exportText(deck) {
  const by = b => deck.cards.filter(c => c.board === b).map(c => `${c.qty} ${c.name}`).join('\n');
  const parts = [];
  if (deck.format === 'commander' && by('commander')) parts.push('Commander\n' + by('commander'));
  parts.push((deck.format === 'commander' ? 'Deck\n' : '') + by('main'));
  if (by('side')) parts.push('Sideboard\n' + by('side'));
  if (by('maybe')) parts.push('Maybe\n' + by('maybe'));
  return parts.join('\n\n');
}

// länk till en lek på Archidekt -> { name, format, cards }; null om texten inte är en länk
async function fetchDeckUrl(text) {
  const t = text.trim();
  if (!/^https?:\/\/\S+$/i.test(t)) return null;
  const a = t.match(/archidekt\.com\/(?:api\/)?decks\/(\d+)/i);
  if (a) return api('/api/archidekt?id=' + a[1]);
  if (/moxfield\.com/i.test(t)) throw new Error('Moxfield tillåter inte att andra appar hämtar lekar. Öppna leken på Moxfield, välj Export → Copy as plain text och klistra in texten här i stället.');
  throw new Error('Bara länkar till Archidekt kan hämtas. Från andra sidor: kopiera lekens exporttext och klistra in den.');
}

// ---------- mana ----------
function manaHtml(cost) {
  if (!cost) return '';
  return cost.split(' // ').map(part => (part.match(/\{[^}]+\}/g) || []).map(s => {
    const v = s.slice(1, -1).replace('/', '');
    const cls = /^[WUBRG]$/.test(v) ? v : '';
    return `<span class="sym ${cls}">${esc(v.length > 2 ? v[0] : v)}</span>`;
  }).join('')).join(' // ');
}

// ---------- förhandsvisning ----------
document.addEventListener('mouseover', e => {
  const el = e.target.closest('[data-img]');
  const pv = $('#preview');
  if (!el) { pv.hidden = true; return; }
  const img = el.dataset.img; if (!img) return;
  $('img', pv).src = img; pv.hidden = false;
});
document.addEventListener('mousemove', e => {
  const pv = $('#preview'); if (pv.hidden) return;
  const x = e.clientX + 20 + 250 > innerWidth ? e.clientX - 270 : e.clientX + 20;
  const y = Math.min(e.clientY - 40, innerHeight - 360);
  pv.style.left = x + 'px'; pv.style.top = Math.max(8, y) + 'px';
});

// ---------- modal ----------
function openModal(html, onMount) {
  // ny ruta varje gång, så att lyssnare från förra innehållet inte hänger kvar
  const m = $('#modal'), old = $('.modal-box', m), box = old.cloneNode(false);
  old.replaceWith(box); box.innerHTML = html; m.hidden = false; $('#preview').hidden = true;
  onMount && onMount(box);
}
function closeModal() { $('#modal').hidden = true; }
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal' || e.target.closest('[data-close]')) closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

function cardModal(name, deck) {
  const c = S.cards[name];
  const entry = deck && deck.cards.find(x => x.name === name);
  openModal(`
    <div class="card-detail">
      ${(() => {
        // har man angett utgåvor visas den man äger, med små bilder för att byta mellan dem
        const own = S.collection[name] ? printsOf(name).filter((p, i, a) => p.id && a.findIndex(x => x.id === p.id) === i) : [];
        const main = own.length ? printImg(own[0]) : c?.image;
        return `<div>${main ? `<img id="cdImg" src="${esc(main)}" alt="${esc(name)}">` : '<div class="empty">Ingen bild</div>'}
          ${own.length > 1 || (own.length && c?.image) ? `<div class="row small" style="margin-top:.4rem;flex-wrap:wrap">${own.map(p => `<img src="${esc(printImg(p, 'small'))}" data-swap="${esc(printImg(p))}" alt="${esc(printLabel(p))}" title="${esc(printLabel(p))}" style="width:46px;border-radius:3px;cursor:pointer">`).join('')}${c?.image ? `<img src="${esc(c.thumb || c.image)}" data-swap="${esc(c.image)}" title="Billigaste utgåvan" alt="" style="width:46px;border-radius:3px;cursor:pointer;opacity:.6">` : ''}</div>` : ''}
          ${own.length ? `<div class="muted small">${esc(printLabel(own[0]))}</div>` : ''}</div>`;
      })()}
      <div>
        <div class="row"><h2 style="margin:0">${esc(name)}</h2><span class="spacer"></span><button class="icon-btn" data-close aria-label="Stäng">✕</button></div>
        <p class="muted small">${esc(c?.type_line || '')} ${c ? manaHtml(c.mana_cost) : ''}</p>
        <p class="oracle">${esc(c?.oracle_text || '')}</p>
        ${c?.id ? '<p class="small" style="margin:.2rem 0"><a href="#" id="rulGo">Regelfrågor och förtydliganden</a></p><div id="rulBox" class="small"></div>' : ''}
        <p class="small">Commander: <b>${esc(c?.legalities.commander || '?')}</b> · Modern: <b>${esc(c?.legalities.modern || '?')}</b> · värde ca ${krE(c?.eur)} <span class="muted">(Cardmarket ${eur(c?.eur)})</span>
          ${c?.game_changer ? ' · <span class="pill warn" title="Kortet finns på Wizards lista över game changers och påverkar lekens bracket">game changer</span>' : ''}</p>
        <div class="row small">
          <label class="own">Jag äger <input type="number" min="0" max="999" value="${S.collection[name] || 0}" id="ownQty" style="width:5rem"> ex</label>
          ${S.v3 ? `<button class="btn small" id="toWish">${S.wishlist.some(w => w.name === name) ? '♥ På önskelistan' : '♡ Önskelista'}</button>` : ''}
        </div>
        ${S.v4 && S.collection[name] ? `<div class="row small" style="margin-top:.4rem">
          <span class="muted">${printsOf(name).length ? printsOf(name).map(p => `${p.qty} × ${esc(printLabel(p))}`).join(', ') : 'Ingen utgåva angiven'} · värde ca ${krE(colValue(name))}</span>
          <button class="btn small" id="toPrints">Utgåva / foil</button></div>` : ''}
        ${entry ? `<h3>I leken</h3><div class="row">
          <select id="boardSel">${['main', 'commander', 'side', 'maybe'].map(b => `<option value="${b}" ${entry.board === b ? 'selected' : ''}>${b === 'main' ? 'Huvudlek' : TYPE_SV[b] || 'Befälhavare'}</option>`).join('')}</select>
          <input type="number" id="deckQty" min="1" max="99" value="${entry.qty}" style="width:5rem"> ex
          ${c?.eur != null && sek(c.eur) >= 10 ? '<button class="btn small" id="cheapGo" title="Billigare kort som gör samma sak">Billigare alternativ</button>' : ''}
          <label class="small">Roll <select id="catSel"><option value="">Automatisk${(r => r.length ? ` (${r.join(', ')})` : '')(rolesOf({ name }))}</option>${[...ROLE_ORDER, 'Länder'].map(r => `<option ${entry.cat === r ? 'selected' : ''}>${r}</option>`).join('')}<option value="none" ${entry.cat === 'none' ? 'selected' : ''}>Ingen roll</option></select></label>
        </div>` : ''}
        ${S.v3 ? `<h3>Utlånat</h3>
          ${S.loans.filter(l => l.name === name).map(l => `<div class="row small">↗ ${l.qty} ex hos <b>${esc(l.borrower)}</b> sedan ${esc(l.lent_on)} <button class="btn small" data-back="${esc(l.id)}">Tillbaka ✓</button></div>`).join('')}
          <div class="row small"><input type="text" id="loanTo" placeholder="Låna ut till…" maxlength="60" style="flex:1"><input type="number" id="loanQty" min="1" max="99" value="1" style="width:4rem"><button class="btn small" id="loanGo">Låna ut</button></div>` : ''}
        <div class="links" style="margin-top:1rem">${buyLinks(name)}${c?.scryfall ? `<a href="${esc(c.scryfall)}" target="_blank" rel="noopener">Scryfall</a>` : ''}</div>
      </div>
    </div>`, box => {
    $('#ownQty', box).addEventListener('change', async e => { await setOwned(name, +e.target.value); render(); });
    if (entry) {
      $('#boardSel', box).addEventListener('change', e => { entry.board = e.target.value; saveDeckSoon(deck); render(); });
      $('#deckQty', box).addEventListener('change', e => { entry.qty = Math.max(1, +e.target.value || 1); saveDeckSoon(deck); render(); });
      $('#catSel', box).addEventListener('change', e => { if (e.target.value) entry.cat = e.target.value; else delete entry.cat; saveDeckSoon(deck); render(); });
      if ($('#cheapGo', box)) $('#cheapGo', box).onclick = () => cheaperModal(name, deck);
    }
    if ($('#toWish', box)) $('#toWish', box).onclick = async () => { await addToWishlist(name); closeModal(); render(); };
    if ($('#rulGo', box)) $('#rulGo', box).onclick = async e => {
      e.preventDefault();
      const el = $('#rulBox', box); el.innerHTML = '<p class="muted">Hämtar…</p>';
      try {
        const r = await api('/api/rulings?id=' + c.id);
        el.innerHTML = r.length ? r.map(x => `<p style="margin:.3rem 0"><span class="muted">${esc(x.date)}</span> ${esc(x.text)}</p>`).join('') : '<p class="muted">Inga förtydliganden för det här kortet.</p>';
      } catch (err) { el.innerHTML = `<p class="muted">Kunde inte hämta: ${esc(err.message)}</p>`; }
    };
    box.addEventListener('click', e => { const t = e.target.closest('[data-swap]'); if (t) $('#cdImg', box).src = t.dataset.swap; });
    if ($('#toPrints', box)) $('#toPrints', box).onclick = () => printsModal(name, () => cardModal(name, deck));
    if ($('#loanGo', box)) $('#loanGo', box).onclick = async () => {
      const borrower = $('#loanTo', box).value.trim();
      if (!borrower) return toast('Skriv vem som lånar kortet');
      await addLoan(name, +$('#loanQty', box).value || 1, borrower); cardModal(name, deck); render();
    };
    box.addEventListener('click', async e => { const b = e.target.closest('[data-back]'); if (b) { await returnLoan(b.dataset.back); cardModal(name, deck); render(); } });
  });
}

// välj utgåva och foil för exemplaren man äger
async function printsModal(name, back) {
  const total = S.collection[name] || 0;
  let list = printsOf(name).map(p => ({ ...p }));
  openModal(`<p class="muted">Hämtar utgåvor…</p>`);
  let all = [];
  try { all = await api('/api/prints?name=' + encodeURIComponent(name)); } catch (e) { toast('Kunde inte hämta utgåvor: ' + e.message, 4000); }
  const byId = Object.fromEntries(all.map(p => [p.id, p]));
  const priceOf = (p, foil) => foil ? p.eur_foil : p.eur;
  const draw = () => {
    const used = list.reduce((a, p) => a + p.qty, 0), c = S.cards[name];
    openModal(`<div class="row"><h2 style="margin:0">${esc(name)}</h2><span class="spacer"></span><button class="icon-btn" data-close aria-label="Stäng">✕</button></div>
      <p class="small muted">Du äger ${total} ex. Ange vilka utgåvor och vilka som är foil, så räknas värdet på just dem. Exemplar utan angiven utgåva värderas till billigaste utgåvan (${krE(c?.eur)}).</p>
      ${list.length ? `<table><tbody>${list.map((p, i) => `<tr><td><img src="${esc(printImg(p, 'small'))}" alt="" style="width:40px;border-radius:3px;vertical-align:middle;margin-right:.4rem" data-img="${esc(printImg(p))}">${esc(printLabel(p))}<div class="muted small">${esc(byId[p.id]?.set_name || '')}${byId[p.id]?.extra?.length ? ' · ' + esc(byId[p.id].extra.join(', ')) : ''}</div></td>
        <td class="num small">${krE(p.eur)}/st</td><td class="num"><input type="number" min="0" max="${total}" value="${p.qty}" data-pq="${i}" style="width:4rem"></td></tr>`).join('')}</tbody></table>` : ''}
      <p class="small">${used < total ? `${total - used} ex utan angiven utgåva.` : '<span class="good">Alla ex har en utgåva.</span>'}</p>
      ${used < total ? `<h3>Lägg till</h3>
        ${all.length > 12 ? '<p><input type="search" id="prFind" placeholder="Filtrera utgåvor, t.ex. MH2 eller borderless…" style="width:100%"></p>' : ''}
        <p><select id="prSet" style="width:100%">${all.map(p => `<option value="${p.id}">${esc(p.set.toUpperCase())} #${esc(p.cn)} – ${esc(p.set_name)}${p.extra.length ? ' (' + esc(p.extra.join(', ')) + ')' : ''} · ${p.eur != null ? krE(p.eur) : '–'}${p.eur_foil != null ? ' / foil ' + krE(p.eur_foil) : ''}</option>`).join('')}</select></p>
        <img id="prPrev" alt="" style="width:146px;border-radius:7px;display:block;margin:0 auto .5rem">
        <div class="row"><label class="small"><input type="checkbox" id="prFoil"> Foil</label><input type="number" id="prQty" min="1" max="${total - used}" value="1" style="width:4rem"> ex
          <span class="spacer"></span><button class="btn primary small" id="prAdd" ${all.length ? '' : 'disabled'}>Lägg till</button></div>` : ''}
      <div class="row" style="margin-top:1rem">${back ? '<button class="btn small" id="prBack">← Tillbaka</button>' : ''}<span class="spacer"></span><button class="btn primary" id="prSave">Spara</button></div>`, box => {
      const sel = $('#prSet', box);
      const syncFoil = () => { const p = byId[sel.value]; if (!p) return; if ($('#prPrev', box)) $('#prPrev', box).src = p.thumb || printImg(p, 'small'); const f = $('#prFoil', box); f.disabled = !(p.foil && p.nonfoil); f.checked = p.foil && !p.nonfoil ? true : p.nonfoil && !p.foil ? false : f.checked; };
      if (sel) { sel.onchange = syncFoil; syncFoil(); }
      if ($('#prFind', box)) $('#prFind', box).oninput = e => {
        const q = e.target.value.toLowerCase();
        let first = null;
        for (const o of sel.options) { o.hidden = !!q && !o.textContent.toLowerCase().includes(q); if (!o.hidden && !first) first = o; }
        if (first && sel.selectedOptions[0]?.hidden) { sel.value = first.value; syncFoil(); }
      };
      box.onchange = e => { // onchange, inte addEventListener: rutan ritas om i samma element
        const q = e.target.closest('[data-pq]'); if (!q) return;
        const i = +q.dataset.pq, others = list.reduce((a, p, j) => a + (j === i ? 0 : p.qty), 0);
        list[i].qty = Math.max(0, Math.min(total - others, +q.value || 0));
        list = list.filter(p => p.qty > 0); draw();
      };
      if ($('#prAdd', box)) $('#prAdd', box).onclick = () => {
        const p = byId[sel.value], foil = $('#prFoil', box).checked, qty = Math.max(1, Math.min(total - used, +$('#prQty', box).value || 1));
        const same = list.find(x => x.id === p.id && x.foil === foil);
        if (same) same.qty += qty; else list.push({ id: p.id, set: p.set, cn: p.cn, foil, qty, eur: priceOf(p, foil) ?? null });
        draw();
      };
      if ($('#prBack', box)) $('#prBack', box).onclick = back;
      $('#prSave', box).onclick = async () => {
        try { await savePrints(name, list); toast('Sparat'); render(); back ? back() : closeModal(); }
        catch (e) { toast('Kunde inte spara: ' + e.message, 4000); }
      };
    });
  };
  draw();
}
// dagsfärska priser för angivna utgåvor (bara i minnet)
async function refreshPrintPrices() {
  if (!S.v4 || S.offline || Date.now() - (refreshPrintPrices.at || 0) < 6 * 3600e3) return;
  refreshPrintPrices.at = Date.now();
  const ids = Object.values(S.colmeta).flatMap(m => (m.prints || []).map(p => p.id)).filter(Boolean);
  if (!ids.length) return;
  const pr = await api('/api/prices', { method: 'POST', body: { ids } }).catch(() => null);
  if (!pr) return;
  for (const m of Object.values(S.colmeta)) for (const p of m.prints || []) { const x = pr[p.id]; if (x) p.eur = (p.foil ? x.eur_foil : x.eur) ?? p.eur; }
  if (location.hash.startsWith('#/samling')) render();
}

function buyLinks(name) {
  const q = encodeURIComponent(name);
  const sm = S.settings.svenskaMagicUrl || 'https://www.svenskamagic.com/';
  const smUrl = sm.includes('{q}') ? sm.replace('{q}', q) : sm;
  return `<a href="https://www.alaragames.se/search?q=${q}" target="_blank" rel="noopener">Alara</a>
    <a href="https://www.cardmarket.com/en/Magic/Products/Search?searchString=${q}" target="_blank" rel="noopener">Cardmarket</a>
    <a href="${esc(smUrl)}" target="_blank" rel="noopener" data-copy="${esc(sm.includes('{q}') ? '' : name)}">Svenska Magic</a>`;
}
document.addEventListener('click', e => {
  const a = e.target.closest('a[data-copy]');
  if (a && a.dataset.copy) { navigator.clipboard?.writeText(a.dataset.copy).then(() => toast('Kortnamnet kopierat – klistra in i sökrutan'), () => {}); }
});

// ---------- vyer ----------
function setNav(which) {
  $$('.top nav a').forEach(a => {
    a.classList.toggle('on', a.dataset.nav === which);
    if (a.dataset.nav === which && window.matchMedia?.('(max-width: 720px)').matches) a.scrollIntoView?.({ inline: 'center', block: 'nearest' });
  });
}
document.addEventListener('click', e => {
  const m = e.target.closest?.('.shared[title], .lent[title]');
  if (!m) return;
  e.preventDefault(); e.stopPropagation();
  toast(m.title, 4000);
}, true);

function viewDecks() {
  setNav('lekar');
  const app = $('#app');
  let sortBy = 'updated';
  try { sortBy = localStorage.getItem('lv-sort') || 'updated'; } catch {}
  const sorters = { updated: (a, b) => b.updated - a.updated, owned: (a, b) => ownedShare(b) - ownedShare(a), name: (a, b) => a.name.localeCompare(b.name) };
  const tiles = S.decks.slice().sort(sorters[sortBy] || sorters.updated).map(d => {
    const art = deckArt(d);
    const miss = missingCards(d).reduce((a, c) => a + c.missing, 0);
    const share = ownedShare(d);
    const rec = deckRecord(S.games.filter(g => g.deck_id === d.id));
    return `<a class="card deck-tile" href="#/lek/${d.id}">
      <div class="art" style="${art ? `background-image:url('${esc(art).replace(/'/g, '%27')}')` : ''}"></div>
      <div class="body"><b>${esc(d.name)}</b>${d.public ? ' <span class="pill" title="Syns för andra under Utforska">publik</span>' : ''}
        <div class="row small" style="margin-top:.3rem"><span class="pill">${FORMAT_SV[d.format]}</span><span class="pill">${deckTotal(d)} kort</span>
        ${d.built ? '<span class="pill good" title="Korten sitter i leken">byggd</span>' : ''}<span class="pill ${miss ? 'warn' : 'good'}">${miss ? `saknar ${miss}` : 'komplett'}</span>${rec.n ? `<span class="pill" title="Vinster i spelloggen">${rec.win}/${rec.n} vinster</span>` : ''}
        <span class="pill" title="Värde: ${priceWhat()}">${krE(deckValue(d))}</span></div>
        <div class="ownbar" title="Du äger ${Math.round(share * 100)} % av korten"><div style="width:${share * 100}%"></div></div>
        <div class="muted small">Du äger ${Math.round(share * 100)} %</div></div></a>`;
  }).join('');
  app.innerHTML = `
    <div class="row"><h1>Mina lekar</h1><span class="spacer"></span>
      <label class="small">Sortera <select id="deckSort"><option value="updated">Senast ändrad</option><option value="owned">Mest komplett</option><option value="name">Namn</option></select></label>
      <a class="btn" href="#/bygg">Bygg från samlingen</a>
      <button class="btn primary" id="newDeck">+ Ny lek</button></div>
    ${S.cloud && !S.profile.name ? '<div class="next small" style="margin-top:.8rem"><span>Du har inget namn än. Det behövs för att andra ska se vem du är.</span><a class="btn small" href="#/installningar">Sätt ditt namn</a></div>' : ''}
    ${S.decks.length ? `<div class="deck-grid">${tiles}</div>` : `<div class="card empty" style="margin-top:1rem"><p>Inga lekar än. Skapa en ny, eller klistra in en lista från Moxfield/Archidekt.</p>
      <div class="row" style="justify-content:center"><a class="btn" href="#/samling">1. Lägg in dina kort</a><a class="btn" href="#/bygg">2. Bygg från samlingen</a></div></div>`}`;
  $('#deckSort').value = sortBy;
  $('#deckSort').onchange = e => { try { localStorage.setItem('lv-sort', e.target.value); } catch {} render(); };
  $('#newDeck').onclick = () => openModal(`
    <div class="row"><h2 style="margin:0">Ny lek</h2><span class="spacer"></span><button class="icon-btn" data-close>✕</button></div>
    <p><input type="text" id="nd-name" placeholder="Namn, t.ex. Atraxa-superfriends" style="width:100%"></p>
    <p class="row"><label><input type="radio" name="nd-f" value="commander" checked> Commander</label><label><input type="radio" name="nd-f" value="modern"> Modern</label></p>
    <h3>Klistra in lista eller länk (valfritt)</h3>
    <textarea id="nd-list" placeholder="1 Sol Ring&#10;1 Arcane Signet&#10;...&#10;&#10;Eller en länk: https://archidekt.com/decks/123456&#10;Rubriker som Commander / Deck / Sideboard fungerar, liksom export från Moxfield, Archidekt och MTG Arena."></textarea>
    <p class="row"><span class="spacer"></span><button class="btn primary" id="nd-ok">Skapa</button></p>`, box => {
    $('#nd-name', box).focus();
    $('#nd-ok', box).onclick = async () => {
      let format = $('input[name=nd-f]:checked', box).value, name = $('#nd-name', box).value.trim();
      let fromUrl;
      try {
        $('#nd-ok', box).disabled = true;
        fromUrl = await fetchDeckUrl($('#nd-list', box).value);
      } catch (e) { $('#nd-ok', box).disabled = false; return toast(e.message, 6000); }
      if (fromUrl) { format = fromUrl.format; name = name || fromUrl.name; }
      const d = await api('/api/decks', { method: 'POST', body: { name: name || 'Ny lek', format } });
      const list = fromUrl ? fromUrl.cards : parseList($('#nd-list', box).value, format);
      if (list.length) {
        $('#nd-ok', box).disabled = true; $('#nd-ok', box).textContent = 'Hämtar kort…';
        mergeCards(d, list);
        const nf = await ensureCards(d.cards.map(c => c.name)).catch(() => []);
        canonicalize(d);
        await api('/api/decks/' + d.id, { method: 'PUT', body: d });
        if (nf.length) toast(`${nf.length} kort hittades inte – kolla stavningen`, 4000);
      }
      S.decks.push(d); closeModal(); location.hash = '#/lek/' + d.id;
    };
  });
}

// en rad som säger vad som är rimligast att göra härnäst med leken
function nextStep(deck) {
  if (!deck.cards.length) return '';
  const bar = (text, btn = '') => `<div class="next small"><span>${text}</span>${btn}</div>`;
  if (deck.format === 'commander' && !deck.cards.some(c => c.board === 'commander')) return bar('Leken saknar befälhavare. Tryck på ★ vid kortet som ska leda leken.');
  const miss = missingCards(deck).reduce((a, m) => a + m.missing, 0);
  if (S.v6 && !S.decks.some(d => d.built) && Object.values(sharedShortage()).some(x => x.decks.some(y => y.id === deck.id)))
    return bar('Vissa kort behövs i flera lekar. Bocka i <b>Ihopbyggd</b> på de lekar du redan satt ihop, så vet appen vad som är ledigt.');
  if (miss) return bar(`Du saknar <b>${miss}</b> kort.`, '<button class="btn small" data-next="kop">Till köplistan</button><button class="btn small" data-next="pick">Plockguide</button>');
  if (!deck.built) return bar(`Du har alla kort!${S.v6 ? ' Plocka ihop leken och bocka i <b>Ihopbyggd</b>.' : ''}`, '<button class="btn small" data-next="pick">Plockguide</button>');
  return bar('Leken är ihopbyggd.', '<button class="btn small" data-next="provhand">Testa en hand</button>');
}

function viewDeck(id) {
  setNav('lekar');
  const deck = S.decks.find(d => d.id === id);
  if (!deck) { $('#app').innerHTML = '<div class="empty">Leken finns inte. <a href="#/">Tillbaka</a></div>'; return; }
  const missingInfo = deck.cards.filter(c => !S.cards[c.name] && !S.notFound.has(c.name)).map(c => c.name);
  if (missingInfo.length && !viewDeck.loading) {
    viewDeck.loading = true;
    ensureCards(missingInfo).catch(e => toast(e.message)).finally(() => { viewDeck.loading = false; render(); });
  }
  const commander = deck.format === 'commander';
  const tabs = [['lista', 'Lista'], ['sok', 'Hitta kort'], ...(commander ? [['forslag', 'Förslag']] : []), ['forbattra', 'Förbättra'], ['kop', 'Köpa'], ['statistik', 'Statistik'], ['provhand', 'Provhand'],
    ...(commander ? [['kombos', 'Kombos']] : []), ['versioner', 'Versioner'], ['text', 'Import/Export']];
  if (!tabs.some(t => t[0] === S.tab)) S.tab = 'lista';
  $('#app').innerHTML = `
    <div class="row">
      <a href="#/" class="icon-btn" aria-label="Tillbaka">←</a>
      <input type="text" id="deckName" value="${esc(deck.name)}" style="font-size:1.3rem;font-weight:700;flex:1;min-width:180px;border-color:transparent;background:transparent">
      <select id="deckFormat"><option value="commander" ${deck.format === 'commander' ? 'selected' : ''}>Commander</option><option value="modern" ${deck.format === 'modern' ? 'selected' : ''}>Modern</option></select>
      ${S.cloud ? `<label class="small row" title="Publika lekar syns för alla inloggade under Utforska. Bara du kan ändra dem."><input type="checkbox" id="deckPublic" ${deck.public ? 'checked' : ''}> Publik</label>` : ''}
      ${S.v6 ? `<label class="small row" title="Korten sitter i leken och räknas som upptagna i dina andra lekar"><input type="checkbox" id="built" ${deck.built ? 'checked' : ''}> Ihopbyggd</label>` : ''}
      <button class="btn small" id="cmpDeck">Jämför</button>
      <button class="btn danger small" id="delDeck">Radera</button>
    </div>
    <div class="tabs">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${S.tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    ${S.tab === 'lista' ? nextStep(deck) : ''}
    <div id="tab"></div>`;
  $('#deckName').onchange = e => { deck.name = e.target.value.trim() || deck.name; saveDeckSoon(deck); };
  $('#deckFormat').onchange = e => { deck.format = e.target.value; saveDeckSoon(deck); render(); };
  if ($('#deckPublic')) $('#deckPublic').onchange = e => {
    deck.public = e.target.checked; saveDeckSoon(deck);
    toast(deck.public ? (S.profile?.name ? 'Leken är publik under Utforska' : 'Publik! Sätt ditt namn under Inställningar så syns vem den är från') : 'Leken är privat igen', 3500);
  };
  if ($('#built')) $('#built').onchange = async e => {
    const on = e.target.checked;
    deck.built = on; render();
    try {
      await api('/api/decks/' + deck.id, { method: 'PUT', body: { built: on } });
      toast(on ? 'Korten räknas nu som upptagna i dina andra lekar' : 'Korten räknas som lediga igen', 3000);
    } catch (err) { deck.built = !on; render(); toast('Kunde inte spara: ' + err.message); }
  };
  $('#cmpDeck').onclick = () => compareModal(deck);
  $('#delDeck').onclick = () => openModal(`<h2>Radera "${esc(deck.name)}"?</h2><p class="muted">Din samling påverkas inte.</p>
    <p class="row"><span class="spacer"></span><button class="btn" data-close>Avbryt</button><button class="btn primary" id="delOk">Radera</button></p>`, box => {
    $('#delOk', box).onclick = async () => { await api('/api/decks/' + deck.id, { method: 'DELETE' }); S.decks = S.decks.filter(d => d !== deck); closeModal(); location.hash = '#/'; };
  });
  $$('.tabs button').forEach(b => b.onclick = () => { S.tab = b.dataset.tab; render(); });
  $$('[data-next]').forEach(b => b.onclick = () => {
    if (b.dataset.next === 'pick') return pickModal(deck);
    S.tab = b.dataset.next; render();
  });
  const tab = $('#tab');
  ({ lista: tabList, statistik: tabStats, provhand: tabHand, forbattra: tabImprove, kop: tabBuy, sok: tabSearch, forslag: tabSuggest, kombos: tabCombos, versioner: tabVersions, text: tabText })[S.tab](deck, tab);
}

// --- Lista ---
function addCardUI(container, onPick, placeholder = 'Lägg till kort…') {
  container.innerHTML = `<input type="search" placeholder="${placeholder}" autocomplete="off"><div class="suggest" hidden></div>`;
  const inp = $('input', container), box = $('.suggest', container);
  let items = [], idx = 0, t;
  const show = () => {
    box.hidden = !items.length;
    box.innerHTML = items.map((n, i) => `<div class="${i === idx ? 'on' : ''}" data-i="${i}">${esc(n)}</div>`).join('');
  };
  inp.addEventListener('input', () => {
    clearTimeout(t);
    const q = inp.value.trim();
    if (q.length < 2) { items = []; show(); return; }
    t = setTimeout(async () => { items = await api('/api/autocomplete?q=' + encodeURIComponent(q)).catch(() => []); idx = 0; show(); }, 180);
  });
  inp.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { idx = Math.min(items.length - 1, idx + 1); show(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { idx = Math.max(0, idx - 1); show(); e.preventDefault(); }
    else if (e.key === 'Enter' && items[idx]) { pick(items[idx]); e.preventDefault(); }
    else if (e.key === 'Escape') { items = []; show(); }
  });
  box.addEventListener('mousedown', e => { const d = e.target.closest('[data-i]'); if (d) { e.preventDefault(); pick(items[+d.dataset.i]); } });
  inp.addEventListener('blur', () => setTimeout(() => { items = []; show(); }, 150));
  async function pick(name) { items = []; show(); inp.value = ''; await onPick(name); inp.focus(); }
  return inp;
}

async function addToDeck(deck, name, board = 'main') {
  await ensureCards([name]).catch(() => {});
  const ex = deck.cards.find(c => c.name === name && c.board === board);
  if (ex) {
    if (deck.format === 'commander' && !isFreeQty(name)) { toast(`${name} finns redan i leken`); return; }
    ex.qty++;
  } else deck.cards.push({ name, qty: 1, board });
  saveDeckSoon(deck); render(); toast(`+ ${name}`);
}

function cardRow(deck, c) {
  const info = S.cards[c.name];
  const have = free(c.name, deck);
  const full = have >= c.qty;
  const part = !full && have > 0;
  const showOwn = !(S.basicsOwned && BASICS.has(c.name));
  return `<li class="${full ? 'owned' : ''}" data-name="${esc(c.name)}" data-board="${c.board}">
    ${showOwn ? `<label class="own" title="Jag har detta kort"><input type="checkbox" data-own ${full ? 'checked' : ''}>${part ? `<span class="part">${have}/${c.qty}</span>` : ''}</label>` : '<span style="width:1.05rem"></span>'}
    <span class="q">${c.qty}</span>
    <span class="nm ${info ? '' : 'missing'}" data-open data-img="${esc(ownImg(c.name))}">${esc(c.name)}${info?.game_changer ? ' <span class="gc" title="Game changer">GC</span>' : ''}${lentQty(c.name) ? ` <span class="lent" title="Utlånat: ${esc(S.loans.filter(l => l.name === c.name).map(l => l.borrower).join(', '))}">↗</span>` : ''}${S.taken?.[c.name] ? ` <span class="shared" title="${esc(S.taken[c.name])}">⇄</span>` : S.shared?.[c.name] ? ` <span class="shared" title="Du har ${S.shared[c.name].own} ex men ${S.shared[c.name].sum} behövs i ${esc(S.shared[c.name].decks.map(x => x.name).join(', '))}">⇄</span>` : ''}</span>
    <span class="mana">${info ? manaHtml(info.mana_cost) : ''}</span>
    <span class="pr ${ownPrinted(c.name, c.qty) ? 'own' : ''}" title="${ownPrinted(c.name, c.qty) ? 'Räknat på dina utgåvor' : c.qty > 1 && info?.eur != null ? krE(info.eur) + '/st' : ''}">${cardVal(c.name, c.qty) != null ? krE(cardVal(c.name, c.qty)) : ''}</span>
    <span class="acts">
      ${deck.format === 'commander' && c.board !== 'commander' && info?.commander_ok ? '<button class="icon-btn" data-act="cmd" title="Gör till befälhavare">★</button>' : ''}
      <button class="icon-btn" data-act="plus" title="En till">+</button>
      <button class="icon-btn" data-act="minus" title="En mindre">−</button>
      ${c.board === 'main' ? `<button class="icon-btn" data-act="${deck.format === 'modern' ? 'side' : 'maybe'}" title="Flytta till ${deck.format === 'modern' ? 'sidolek' : 'kanske'}">⇢</button>` : '<button class="icon-btn" data-act="main" title="Flytta till huvudleken">⇠</button>'}
    </span></li>`;
}

// bildläge: samma li-struktur som listan, så att samma klick- och bock-hantering fungerar
function cardTile(deck, c) {
  const info = S.cards[c.name];
  const have = free(c.name, deck), full = have >= c.qty;
  const showOwn = !(S.basicsOwned && BASICS.has(c.name));
  return `<li class="${full ? 'owned' : 'lack'}" data-name="${esc(c.name)}" data-board="${c.board}">
    ${info?.thumb ? `<img loading="lazy" src="${esc(printOf1(c.name) ? printImg(printOf1(c.name), 'small') : info.thumb)}" alt="${esc(c.name)}" data-open data-img="${esc(ownImg(c.name))}">` : `<div class="noimg" data-open>${esc(c.name)}</div>`}
    ${c.qty > 1 ? `<span class="qbadge">${c.qty}×</span>` : ''}
    ${cardVal(c.name, c.qty) != null ? `<span class="pbadge">${krE(cardVal(c.name, c.qty))}</span>` : ''}
    ${showOwn ? `<label class="own-badge" title="Jag har detta kort"><input type="checkbox" data-own ${full ? 'checked' : ''}>${!full && have ? `<span>${have}/${c.qty}</span>` : ''}</label>` : ''}
  </li>`;
}

function tabList(deck, tab) {
  const groups = {};
  const byRole = S.group === 'roll';
  for (const c of deck.cards) {
    const k = c.board !== 'main' ? (c.board === 'commander' ? 'Commander' : c.board)
      : byRole ? (rolesOf(c)[0] || (mainType(S.cards[c.name]) === 'Land' ? 'Land' : 'Övrigt')) : mainType(S.cards[c.name]);
    (groups[k] = groups[k] || []).push(c);
  }
  const order = byRole ? ['Commander', ...ROLE_ORDER, 'Övrigt', 'Länder', 'Land', 'side', 'maybe'] : ['Commander', ...TYPE_ORDER, 'Other', 'side', 'maybe'];
  const visual = S.view === 'bilder';
  const rc = roleCounts(deck);
  const br = deck.format === 'commander' ? bracketInfo(deck) : null;
  S.shared = sharedShortage();
  const clash = Object.entries(S.shared).filter(([, x]) => x.decks.some(y => y.id === deck.id)).sort((a, b) => a[0].localeCompare(b[0]));
  const taken = takenCards(deck);
  S.taken = Object.fromEntries(taken.map(x => [x.name, x.text]));
  const sections = order.filter(k => groups[k]).map(k => {
    const list = groups[k].sort((a, b) => (S.cards[a.name]?.cmc ?? 99) - (S.cards[b.name]?.cmc ?? 99) || a.name.localeCompare(b.name));
    const val = list.reduce((a, c) => a + (cardVal(c.name, c.qty) || 0), 0);
    return `<section><div class="section-head"><h3>${TYPE_SV[k] || k}</h3><span class="muted small">${list.reduce((a, c) => a + c.qty, 0)}${val ? ` · ${krE(val)}` : ''}</span></div>
      ${visual ? `<ul class="vgrid">${list.map(c => cardTile(deck, c)).join('')}</ul>` : `<ul class="clist">${list.map(c => cardRow(deck, c)).join('')}</ul>`}</section>`;
  }).join('');
  const issues = deckIssues(deck);
  const miss = missingCards(deck);
  const total = deckValue(deck), missVal = miss.reduce((a, m) => a + (S.cards[m.name]?.eur || 0) * m.missing, 0);
  const top = deck.cards.filter(c => c.board !== 'maybe' && cardVal(c.name, c.qty)).sort((a, b) => cardVal(b.name, b.qty) - cardVal(a.name, a.qty)).slice(0, 5);
  const noPrice = deck.cards.filter(c => c.board !== 'maybe' && S.cards[c.name] && S.cards[c.name].eur == null && !BASICS.has(c.name)).length;
  tab.innerHTML = `
    <div class="grid cols-2">
      <div class="card">
        <div class="row" style="margin-bottom:.6rem"><div class="add-bar" id="addBar"></div>
          <select id="addBoard"><option value="main">Huvudlek</option>${deck.format === 'commander' ? '<option value="commander">Befälhavare</option>' : '<option value="side">Sidolek</option>'}<option value="maybe">Kanske</option></select>
          <div class="seg" role="group" aria-label="Visning"><button data-view="lista" class="${visual ? '' : 'on'}">☰ Lista</button><button data-view="bilder" class="${visual ? 'on' : ''}">▦ Bilder</button></div>
          <div class="seg" role="group" aria-label="Gruppera"><button data-group="typ" class="${byRole ? '' : 'on'}">Typ</button><button data-group="roll" class="${byRole ? 'on' : ''}">Roll</button></div></div>
        ${deck.cards.length ? `<div class="${visual ? '' : 'cols-cards'}">${sections}</div>` : '<div class="empty">Leken är tom. Sök ett kort ovan, eller klistra in en lista under Import/Export.</div>'}
      </div>
      <div class="grid" style="align-content:start">
        ${deck.cards.length ? `<div class="card" id="deckValue"><h2>Värde</h2>
          <p style="margin:.2rem 0"><b style="font-size:1.4rem">${krE(total)}</b> <span class="muted small">hela leken</span></p>
          ${missVal ? `<p class="small" style="margin:.2rem 0">Du har kort för <b>${krE(Math.max(0, total - missVal))}</b>. Det som saknas kostar ca <b>${krE(missVal)}</b>.</p>` : ''}
          ${top.length ? `<h3>Dyraste korten</h3><table class="small"><tbody>${top.map(c => `<tr><td><span data-img="${esc(ownImg(c.name))}">${esc(c.name)}</span>${c.qty > 1 ? ` <span class="muted">${c.qty}×</span>` : ''}${S.cards[c.name]?.eur != null && sek(S.cards[c.name].eur) >= 10 ? ` <a href="#" class="muted" data-cheap="${esc(c.name)}" title="Billigare kort som gör samma sak">billigare?</a>` : ''}</td><td class="num">${krE(cardVal(c.name, c.qty))}</td></tr>`).join('')}</tbody></table>` : ''}
          <p class="muted small">${priceWhat()[0].toUpperCase() + priceWhat().slice(1)}. Kort du äger räknas på de utgåvor du angett i samlingen, resten på billigaste utgåvan. Kanske-korten räknas inte.${noPrice ? ` ${noPrice} kort saknar pris.` : ''}</p></div>` : ''}
        <div class="card"><h2>Kontroll</h2><ul class="issues">${issues.map(([k, t]) => `<li class="${k}">${esc(t)}</li>`).join('')}</ul>
          ${br ? `<h3>Bracket</h3><p style="margin:.2rem 0"><b>Ungefär ${br.b} – ${BRACKET_SV[br.b]}</b></p>
            <p class="small muted" style="margin:0">${br.why.length ? esc(br.why.join(', ')) + '.' : 'Inga game changers, kombos med två kort eller massförstörelse av länder.'}
            ${br.gc.length ? `<br>Game changers: ${esc(br.gc.join(', '))}` : ''}${br.two === null ? `<br><a href="#" id="chkCombos">Kolla kombos</a> för en säkrare bedömning.` : ''}</p>` : ''}
          ${clash.length ? `<h3>Delas med andra lekar (${clash.length})</h3>
            <p class="small muted" style="margin:.2rem 0">Korten finns i flera lekar men du har inte så många att alla kan vara ihopplockade samtidigt.</p>
            <ul class="small" style="margin:.2rem 0;padding-left:1.1rem">${clash.map(([n, x]) => `<li><b>${esc(n)}</b>: har ${x.own}, behövs ${x.sum} – ${esc(x.decks.filter(y => y.id !== deck.id).map(y => y.name).join(', '))}</li>`).join('')}</ul>` : ''}</div>
        <div class="card"><h2>Roller</h2>
          <table class="small"><tbody>${Object.entries(rc).map(([k, v]) => {
            const t = deck.format === 'commander' && ROLE_TARGET[k];
            const cls = !t ? '' : v < t[0] ? 'warn' : v > t[1] + 4 ? 'warn' : 'good';
            return `<tr><td>${k}</td><td class="num ${cls}"><b>${v}</b></td><td class="muted">${t ? `mål ${t[0]}–${t[1]}` : ''}</td></tr>`;
          }).join('')}</tbody></table>
          <p class="muted small">Rollerna gissas från korttexten. Klicka på ett kort och välj Roll om gissningen är fel.</p></div>
        <div class="card"><h2>Dina kort</h2>
          <p>${miss.length ? `Du saknar <b>${miss.reduce((a, c) => a + c.missing, 0)}</b> kort (${miss.length} olika).` : '<b>Du har alla kort!</b>'}</p>
          ${taken.length ? `<p class="small" style="margin:.2rem 0">${taken.length} av korten finns i din samling men sitter i en ihopbyggd lek:</p>
            <ul class="small" style="margin:.2rem 0;padding-left:1.1rem">${taken.map(x => `<li><b>${esc(x.name)}</b> – ${esc(x.where)}</li>`).join('')}</ul>` : ''}
          <label class="small row"><input type="checkbox" id="basics" ${S.basicsOwned ? 'checked' : ''}> Räkna basländer som ägda</label>
          <div class="row" style="margin-top:.6rem"><button class="btn small" id="ownAll">Bocka i alla</button><button class="btn small" id="pickGo">Plockguide</button><button class="btn small" id="toBuy">Till köplistan →</button></div>
          <p class="muted small">Bocka i rutan framför ett kort när du har det. Det sparas i din samling och gäller alla lekar.${S.v6 ? ' Bocka i Ihopbyggd högst upp när korten sitter i leken, så räknas de som upptagna i dina andra lekar.' : ''}</p>
        </div>
      </div>
    </div>`;
  addCardUI($('#addBar'), name => addToDeck(deck, name, $('#addBoard').value));
  $('#basics').onchange = e => { S.basicsOwned = e.target.checked; try { localStorage.setItem('basicsOwned', S.basicsOwned ? '1' : '0'); } catch {} render(); };
  $('#toBuy').onclick = () => { S.tab = 'kop'; render(); };
  $('#pickGo').onclick = () => pickModal(deck);
  $('#ownAll').onclick = async () => {
    const body = {}, list = missingCards(deck);
    if (!list.length) return toast('Du har redan alla kort');
    if (!confirm(`Lägga ${list.reduce((a, m) => a + m.missing, 0)} kort i din samling?`)) return;
    for (const m of list) body[m.name] = ownTarget(m.name, deck, m.qty);
    Object.assign(S.collection, body);
    await api('/api/collection', { method: 'PUT', body }); render();
  };
  tab.addEventListener('change', async e => {
    if (!e.target.matches('[data-own]')) return;
    const li = e.target.closest('li'), name = li.dataset.name;
    const need = deck.cards.filter(c => c.name === name && c.board !== 'maybe').reduce((a, c) => a + c.qty, 0) || 1;
    await setOwned(name, e.target.checked ? ownTarget(name, deck, need) : Math.min(S.collection[name] || 0, reserved(name, deck)));
    render();
  });
  tab.addEventListener('click', e => {
    const vb = e.target.closest('[data-view]');
    if (vb) { S.view = vb.dataset.view; try { localStorage.setItem('lv-view', S.view); } catch {} return render(); }
    const gb = e.target.closest('[data-group]');
    if (gb) { S.group = gb.dataset.group; try { localStorage.setItem('lv-group', S.group); } catch {} return render(); }
    if (e.target.id === 'chkCombos') { e.preventDefault(); S.tab = 'kombos'; return render(); }
    const li = e.target.closest('li[data-name]'); if (!li) return;
    const c = deck.cards.find(x => x.name === li.dataset.name && x.board === li.dataset.board); if (!c) return;
    if (e.target.closest('[data-open]')) return cardModal(c.name, deck);
    const act = e.target.closest('[data-act]')?.dataset.act; if (!act) return;
    if (act === 'plus') { if (deck.format === 'commander' && !isFreeQty(c.name) && c.board !== 'maybe') return toast('Commander tillåter bara 1 ex'); c.qty++; }
    if (act === 'minus') { c.qty--; if (c.qty < 1) deck.cards.splice(deck.cards.indexOf(c), 1); }
    if (act === 'cmd' || act === 'side' || act === 'maybe' || act === 'main') {
      const to = act === 'cmd' ? 'commander' : act;
      const ex = deck.cards.find(x => x.name === c.name && x.board === to && x !== c);
      if (ex) { ex.qty += c.qty; deck.cards.splice(deck.cards.indexOf(c), 1); } else c.board = to;
    }
    saveDeckSoon(deck); render();
  });
}

// --- Statistik ---
function barChart(bins, labels, title) {
  const W = 420, H = 170, pad = 22, max = Math.max(1, ...bins), bw = (W - pad) / bins.length;
  const bars = bins.map((v, i) => {
    const h = Math.round((v / max) * (H - 40));
    const x = pad + i * bw + 2, y = H - 20 - h, w = bw - 4;
    const r = Math.min(4, h / 2, w / 2);
    const path = h ? `M${x},${H - 20}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${H - 20}Z` : '';
    return `<g data-tip="${esc(title(labels[i], v))}"><rect class="hit" x="${pad + i * bw}" y="0" width="${bw}" height="${H - 20}"></rect>
      ${path ? `<path class="bar" d="${path}"></path>` : ''}
      ${v ? `<text class="val" x="${x + w / 2}" y="${y - 5}" text-anchor="middle">${v}</text>` : ''}
      <text x="${x + w / 2}" y="${H - 5}" text-anchor="middle">${labels[i]}</text></g>`;
  }).join('');
  return `<div class="chart-wrap"><svg viewBox="0 0 ${W} ${H}" role="img"><line class="axis" x1="${pad}" x2="${W}" y1="${H - 20}" y2="${H - 20}"></line>${bars}</svg><div class="tip" hidden></div></div>`;
}
function hookTips(root) {
  $$('.chart-wrap', root).forEach(w => {
    const tip = $('.tip', w);
    w.addEventListener('mousemove', e => {
      const g = e.target.closest('[data-tip]');
      if (!g) { tip.hidden = true; return; }
      const r = w.getBoundingClientRect();
      tip.textContent = g.dataset.tip; tip.hidden = false;
      tip.style.left = (e.clientX - r.left) + 'px'; tip.style.top = (e.clientY - r.top) + 'px';
    });
    w.addEventListener('mouseleave', () => (tip.hidden = true));
  });
}

function tabStats(deck, tab) {
  const play = deck.cards.filter(c => c.board === 'main' || c.board === 'commander');
  const nonLand = play.filter(c => mainType(S.cards[c.name]) !== 'Land');
  const lands = play.filter(c => mainType(S.cards[c.name]) === 'Land').reduce((a, c) => a + c.qty, 0);
  const total = play.reduce((a, c) => a + c.qty, 0);
  const curve = Array(8).fill(0);
  let cmcSum = 0, cmcN = 0;
  for (const c of nonLand) {
    const v = Math.round(S.cards[c.name]?.cmc || 0);
    curve[Math.min(7, v)] += c.qty; cmcSum += v * c.qty; cmcN += c.qty;
  }
  const pips = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
  for (const c of play) for (const s of (S.cards[c.name]?.mana_cost || '').match(/\{[^}]+\}/g) || []) {
    for (const ch of s.slice(1, -1).split('/')) if (pips[ch] !== undefined) pips[ch] += c.qty;
  }
  const types = {};
  for (const c of play) { const t = c.board === 'commander' ? 'Commander' : mainType(S.cards[c.name]); types[t] = (types[t] || 0) + c.qty; }
  const value = play.reduce((a, c) => a + (cardVal(c.name, c.qty) || 0), 0);
  const missVal = missingCards(deck).reduce((a, m) => a + (S.cards[m.name]?.eur || 0) * m.missing, 0);
  const { Länder: _l, ...roleCount } = roleCounts(deck);
  const pipNames = { W: 'Vit', U: 'Blå', B: 'Svart', R: 'Röd', G: 'Grön', C: 'Färglös' };
  const pipMax = Math.max(1, ...Object.values(pips));
  const sources = colorCheck(deck, pips);
  const hbars = (obj, names = {}) => `<div class="hbars">${Object.entries(obj).map(([k, v]) => `<span>${names[k] || TYPE_SV[k] || k}</span><div class="track"><div class="fill" style="width:${(v / Math.max(1, ...Object.values(obj))) * 100}%"></div></div><span class="n">${v}</span>`).join('')}</div>`;
  tab.innerHTML = `
    <div class="stats">
      <div class="stat"><b>${total}</b><span>kort i leken</span></div>
      <div class="stat"><b>${lands}</b><span>länder</span></div>
      <div class="stat"><b>${cmcN ? (cmcSum / cmcN).toFixed(2) : '–'}</b><span>snitt-manavärde</span></div>
      <div class="stat"><b>${krE(value)}</b><span>ungefärligt värde (Cardmarket ${eur(value)})</span></div>
      <div class="stat"><b>${krE(missVal)}</b><span>för det du saknar</span></div>
      ${(r => r.n ? `<div class="stat"><b>${r.pct} %</b><span>vinster (${r.win} av ${r.n} matcher) · <a href="#/matcher/analys/${esc(deck.id)}">analys</a></span></div>` : '')(deckRecord(S.games.filter(g => g.deck_id === deck.id)))}
    </div>
    <div class="grid cols-2" style="margin-top:1rem">
      <div class="card"><h2>Manakurva <span class="muted small">(icke-länder)</span></h2>${barChart(curve, ['0', '1', '2', '3', '4', '5', '6', '7+'], (l, v) => `${v} kort med manavärde ${l}`)}</div>
      <div class="card"><h2>Färgsymboler</h2>${Object.values(pips).some(Boolean) ? `<div class="hbars">${Object.entries(pips).filter(([, v]) => v).map(([k, v]) => `<span><span class="sym ${k}">${k}</span> ${pipNames[k]}</span><div class="track"><div class="fill" style="width:${(v / pipMax) * 100}%"></div></div><span class="n">${v}</span>`).join('')}</div>` : '<p class="muted">Inga färgade kort än.</p>'}</div>
      ${sources.length ? `<div class="card"><h2>Färgkällor</h2><table class="small"><thead><tr><th>Färg</th><th class="num">Symboler</th><th class="num">Länder</th><th class="num">Ramp</th><th class="num">Bör ha</th></tr></thead><tbody>
        ${sources.map(r => `<tr><td><span class="sym ${r.c}">${r.c}</span> ${pipNames[r.c]}</td><td class="num">${r.pips}</td><td class="num ${r.low ? 'warn' : ''}"><b>${r.lands}</b></td><td class="num">${r.other}</td><td class="num muted">${r.want ? `ca ${r.want}` : '–'}</td></tr>`).join('')}</tbody></table>
        ${sources.some(r => r.low) ? `<p class="warn small">För få länder ger ${sources.filter(r => r.low).map(r => pipNames[r.c].toLowerCase()).join(' och ')}.</p>` : '<p class="good small">Färgerna ser balanserade ut.</p>'}
        <p class="muted small">Tumregel: länder per färg efter hur många symboler färgen har. Ramp är kort för högst 3 mana som ger färgen.</p></div>` : ''}
      <div class="card"><h2>Korttyper</h2>${hbars(types)}</div>
      <div class="card"><h2>Roller <span class="muted small">(gissning från korttexten)</span></h2>${hbars(roleCount)}
        ${deck.format === 'commander' ? '<p class="muted small">Tumregel för Commander: ca 36–38 länder, 10 ramp, 10 kortdragning, 8–10 removal och 2–3 massborttagningar.</p>' : ''}</div>
    </div>
    <p class="muted small">Värdet är ${priceWhat()}, omräknat med dagens kurs (1 € = ${S.rate.toLocaleString('sv-SE')} kr). Det är en fingervisning. Riktiga butikspriser finns under Köpa. Prisnivån ändras under Inställningar.</p>`;
  hookTips(tab);
}

// --- Provhand ---
function binom(n, k) {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = r * (n - k + i) / i;
  return r;
}
const hyper = (N, K, n, k) => binom(K, k) * binom(N - K, n - k) / binom(N, n);
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function tabHand(deck, tab) {
  const lib0 = deck.cards.filter(c => c.board === 'main').flatMap(c => Array(c.qty).fill(c.name));
  const N = lib0.length;
  const L = lib0.filter(n => mainType(S.cards[n]) === 'Land').length;
  let st = tabHand.st;
  const fresh = mull => {
    const lib = shuffle(lib0.slice());
    st = tabHand.st = { deck: deck.id, size: N, lib, hand: lib.splice(0, Math.min(7, lib.length)), mull, bottom: deck.format === 'commander' && mull === 1 ? 0 : mull, drawn: 0 };
  };
  if (!st || st.deck !== deck.id || st.size !== N) fresh(0);
  const cmd = deck.cards.filter(c => c.board === 'commander');
  const landsInHand = st.hand.filter(n => mainType(S.cards[n]) === 'Land').length;
  const dist = Array.from({ length: 8 }, (_, k) => N >= 7 ? hyper(N, L, 7, k) : 0);
  const good = dist[2] + dist[3] + dist[4];
  const pct = v => (v * 100).toFixed(v < 0.1 ? 1 : 0) + ' %';
  // sannolikhet att ha minst 3 länder efter att ha dragit till tur 3 (7 + 2 kort på dragplats)
  const atLeast = (draws, need) => 1 - Array.from({ length: need }, (_, k) => hyper(N, L, Math.min(N, draws), k)).reduce((a, b) => a + b, 0);
  tab.innerHTML = N < 7 ? '<div class="card empty">Lägg in minst 7 kort i huvudleken först.</div>' : `
    <div class="grid cols-2">
      <div class="card">
        <div class="row">
          <button class="btn primary" id="hNew">Ny hand</button>
          <button class="btn" id="hMull">Mulligan</button>
          <button class="btn" id="hDraw" ${st.bottom ? 'disabled' : ''}>Dra ett kort</button>
          <span class="spacer"></span>
          <span class="muted small">${st.mull ? `Mulligan ${st.mull} · ` : ''}${st.hand.length} kort · ${landsInHand} länder${st.drawn ? ` · ${st.drawn} dragna` : ''}</span>
        </div>
        ${st.bottom ? `<p class="warn small" style="margin:.6rem 0 0">Klicka på ${st.bottom} kort som ska läggas längst ner i leken (London-mulligan).</p>` : ''}
        ${cmd.length ? `<p class="muted small">I kommandozonen: ${cmd.map(c => esc(c.name)).join(', ')}</p>` : ''}
        <div class="hand">${st.hand.map((n, i) => {
          const c = S.cards[n];
          return `<figure data-i="${i}" class="${st.bottom ? 'pickable' : ''}">${c?.thumb ? `<img src="${esc(c.thumb)}" alt="${esc(n)}" data-img="${esc(c.image)}">` : `<div class="noimg">${esc(n)}</div>`}</figure>`;
        }).join('')}</div>
        <p class="muted small">${deck.format === 'commander' ? 'I Commander är första mulligan gratis: du drar 7 nya och lägger inget kort under.' : 'London-mulligan: dra 7 nya och lägg lika många kort under som antal mulligans.'}</p>
      </div>
      <div class="grid" style="align-content:start">
        <div class="card"><h2>Länder i starthanden</h2>
          <p class="small muted">${L} länder av ${N} kort i leken.</p>
          <div class="hbars">${dist.map((v, k) => `<span>${k}</span><div class="track" title="${pct(v)}"><div class="fill" style="width:${(v / Math.max(...dist)) * 100}%;${k >= 2 && k <= 4 ? '' : 'opacity:.45'}"></div></div><span class="n">${pct(v)}</span>`).join('')}</div>
          <p style="margin-top:.8rem">Chans till <b>2–4 länder</b>: <b>${pct(good)}</b></p>
        </div>
        <div class="card"><h2>Hinner jag få länder?</h2>
          <table class="small"><tbody>
            <tr><td>Minst 2 länder tur 2 (på dragplats)</td><td class="num">${pct(atLeast(8, 2))}</td></tr>
            <tr><td>Minst 3 länder tur 3</td><td class="num">${pct(atLeast(9, 3))}</td></tr>
            <tr><td>Minst 4 länder tur 4</td><td class="num">${pct(atLeast(10, 4))}</td></tr>
          </tbody></table>
          <p class="muted small">Räknat på att du går först och drar ett kort per tur från tur 2. Mana från artefakter räknas inte.</p>
        </div>
      </div>
    </div>
    <div class="grid cols-2" style="margin-top:1rem"><div class="card" id="gold"></div><div class="card" id="sim" style="align-self:start"></div></div>`;
  if (N < 7) return;
  goldPlay(deck, st, $('#gold'));
  simCard(deck, $('#sim'));
  $('#hNew').onclick = () => { fresh(0); render(); };
  $('#hMull').onclick = () => { fresh(Math.min(6, st.mull + 1)); render(); };
  $('#hDraw').onclick = () => { if (st.lib.length) { st.hand.push(st.lib.shift()); st.drawn++; } render(); };
  tab.querySelector('.hand').addEventListener('click', e => {
    const f = e.target.closest('figure[data-i]'); if (!f || !st.bottom) return;
    st.lib.push(...st.hand.splice(+f.dataset.i, 1)); st.bottom--; render();
  });
}

// --- Förbättra: svagheter och uppgraderingsplan ---
// Varje kontroll räknar kort i leken. Roller går via rolesOf (kan ändras per kort), resten via korttexten.
const GAPS = [
  { k: 'land', label: 'Länder', land: true, min: { commander: 35, modern: 19 }, max: { commander: 39, modern: 25 }, why: 'För få länder ger händer som kör fast, för många gör att du får slut på saker att göra.', q: 't:land -t:basic' },
  { k: 'ramp', label: 'Ramp', role: 'Ramp', min: { commander: 9 }, why: 'Ramp gör att du hinner spela befälhavaren och de dyra korten i tid.', q: 'otag:ramp' },
  { k: 'draw', label: 'Kortdragning', role: 'Kortdragning', min: { commander: 9 }, why: 'Utan kortdragning tar korten på handen slut efter några turer.', q: 'otag:draw' },
  { k: 'removal', label: 'Removal', role: 'Removal', min: { commander: 8, modern: 6 }, why: 'Riktad removal tar hand om det farligaste motståndarna spelar.', q: 'otag:removal' },
  { k: 'wipe', label: 'Massborttagning', role: 'Massborttagning', min: { commander: 2 }, why: 'Ett sätt att nollställa bordet när någon drar ifrån.', q: 'otag:board-wipe' },
  { k: 'artench', label: 'Svar på artefakter och förtrollningar', side: true, re: /(destroy|exile) (target|each|all|up to \w+ target) [^.]*?\b(artifacts?|enchantments?|nonland permanents?|permanents?)\b/i, min: { commander: 3, modern: 2 }, why: 'Utan dem blir motståndarnas Sol Ring, Rhystic Study och liknande liggande kvar.', q: '(otag:removal-artifact or otag:removal-enchantment)' },
  { k: 'gy', label: 'Kyrkogårdshat', side: true, re: /exile (all cards from |each opponent's |target player's |all |)graveyards?|exile (up to \w+ )?target cards? from (a|an opponent's|any) graveyard|cards in graveyards can't|graveyard, exile it instead/i, min: { commander: 1, modern: 2 }, why: 'Behövs mot lekar som återupplivar varelser eller spelar kort från kyrkogården.', q: 'otag:graveyard-hate' },
  { k: 'prot', label: 'Skydd för dina kort', re: /hexproof|indestructible|phases? out|protection from|shroud|counter target (spell|noncreature spell)/i, min: { commander: 2 }, why: 'Skyddar befälhavaren mot removal, så att du slipper betala skatt gång på gång.', q: 'otag:protects-creature' },
  { k: 'recur', label: 'Återvinning', re: /return (target|up to \w+ target|a|another target|all) [^.]*?from your graveyard to (your hand|the battlefield)/i, min: { commander: 2 }, why: 'Ger tillbaka viktiga kort som förstörts.', q: 'otag:recursion' },
  { k: 'inst', label: 'Svar på andras tur', test: (c, roles) => roles.some(r => r === 'Removal' || r === 'Massborttagning') && (/Instant/.test(c.type_line || '') || /\bFlash\b/.test(c.oracle_text || '')), min: { commander: 4, modern: 4 }, why: 'Removal som instant eller med flash kan användas när hotet dyker upp, inte bara på din egen tur.', q: 'otag:removal (t:instant or o:flash)' },
  { k: 'fly', label: 'Blockerare mot flygare', test: c => /Creature/.test(c.type_line || '') && /\b(Flying|Reach)\b/.test(c.oracle_text || ''), min: { commander: 4 }, why: 'Utan varelser med flying eller reach kommer motståndarnas flygare fritt, om du inte har gott om removal.', q: 't:creature (keyword:flying or keyword:reach)' },
];
function gapMatch(g, c, info) {
  if (!info) return false;
  const land = mainType(info) === 'Land';
  if (g.land) return c.cat ? c.cat === 'Länder' : land;
  if (land) return false;
  const roles = rolesOf(c);
  return g.role ? roles.includes(g.role) : g.re ? g.re.test(info.oracle_text || '') : g.test(info, roles);
}
function deckIdent(deck) {
  const cmd = deck.cards.filter(c => c.board === 'commander');
  if (cmd.length) return new Set(cmd.flatMap(c => S.cards[c.name]?.color_identity || []));
  if (deck.format === 'commander') return null;
  const s = new Set(deck.cards.filter(c => c.board !== 'maybe').flatMap(c => S.cards[c.name]?.color_identity || []));
  return s.size ? s : null;
}
function deckGaps(deck) {
  const fmt = deck.format === 'modern' ? 'modern' : 'commander';
  const main = deck.cards.filter(c => c.board === 'main' || c.board === 'commander'), side = deck.cards.filter(c => c.board === 'side');
  const out = [];
  for (const g of GAPS) {
    const min = g.min[fmt]; if (!min) continue;
    const hits = (g.side ? [...main, ...side] : main).filter(c => gapMatch(g, c, S.cards[c.name]));
    const n = hits.reduce((a, c) => a + c.qty, 0), max = g.max?.[fmt];
    out.push({ ...g, n, min, max, over: !!max && n > max, hits: [...new Set(hits.map(c => c.name))], state: n >= min && !(max && n > max) ? 'ok' : n === 0 || n < min / 2 ? 'bad' : 'warn' });
  }
  const nl = main.filter(c => c.board === 'main' && S.cards[c.name] && mainType(S.cards[c.name]) !== 'Land');
  const q = nl.reduce((a, c) => a + c.qty, 0), avg = q ? nl.reduce((a, c) => a + (S.cards[c.name].cmc || 0) * c.qty, 0) / q : 0, lim = fmt === 'modern' ? 2.8 : 3.5;
  if (q) out.push({ k: 'curve', label: 'Manakurva', disp: avg.toFixed(2).replace('.', ','), range: `snitt högst ${String(lim).replace('.', ',')}`, state: avg <= lim ? 'ok' : avg <= lim + .5 ? 'warn' : 'bad', why: 'Leken är tung. Byt några dyra kort mot billigare, eller lägg in mer ramp, så kommer du igång snabbare.', hits: [], over: true });
  return out;
}
// lediga kort i samlingen som fyller luckan och passar leken
function gapOwned(deck, g) {
  const fmt = deck.format === 'modern' ? 'modern' : 'commander', ident = deckIdent(deck);
  const inDeck = new Set(deck.cards.map(c => c.name));
  return Object.keys(S.collection).filter(n => !inDeck.has(n) && !BASICS.has(n) && free(n, deck) > 0).filter(n => {
    const c = S.cards[n];
    return c && c.legalities?.[fmt] === 'legal' && (!ident || (c.color_identity || []).every(x => ident.has(x))) && gapMatch(g, { name: n }, c);
  }).sort((a, b) => (S.cards[a].cmc || 0) - (S.cards[b].cmc || 0)).slice(0, 6);
}
// byten som ger mest för pengarna: EDHREC-kort som saknas mot de minst spelade korten i samma roll eller typ
function upgradePlan(deck, data, budget) {
  const edh = {}, proper = {};
  for (const l of data.lists) for (const c of l.cards) { const k = c.name.toLowerCase(); proper[k] = c.name; if (c.incl != null && !(edh[k] >= c.incl)) edh[k] = c.incl; }
  const score = n => edh[n.toLowerCase()] ?? 0;
  const inDeck = new Set(deck.cards.map(c => c.name.toLowerCase()));
  const pool = deck.cards.filter(c => c.board === 'main' && S.cards[c.name] && mainType(S.cards[c.name]) !== 'Land' && !BASICS.has(c.name))
    .map(c => ({ name: c.name, s: score(c.name), roles: rolesOf(c), type: mainType(S.cards[c.name]) }));
  const cands = Object.keys(edh).filter(k => !inDeck.has(k)).map(k => proper[k]).filter(n => {
    const c = S.cards[n]; return c && mainType(c) !== 'Land' && c.legalities?.commander === 'legal' && (c.eur != null || free(n, deck) > 0);
  }).sort((a, b) => score(b) - score(a)).slice(0, 80);
  const used = new Set(), pairs = [];
  for (const n of cands) {
    const roles = rolesOf({ name: n }), type = mainType(S.cards[n]), left = pool.filter(p => !used.has(p.name));
    // ett kort med en roll (ramp, removal …) byts bara mot ett kort med samma roll
    const same = roles.length ? left.filter(p => p.roles.some(r => roles.includes(r))) : [];
    const base = same.length ? same : left.filter(p => !p.roles.length), typed = base.filter(p => p.type === type);
    const opts = typed.length ? typed : base;
    const cut = opts.sort((a, b) => a.s - b.s)[0];
    if (!cut || score(n) - cut.s < .08) continue;
    used.add(cut.name);
    const own = free(n, deck) > 0;
    pairs.push({ out: cut.name, outS: cut.s, in: n, inS: score(n), gain: score(n) - cut.s, own, eur: own ? 0 : S.cards[n].eur, why: same.length ? roles.filter(r => cut.roles.includes(r))[0] : '' });
  }
  pairs.sort((a, b) => b.own - a.own || b.gain / (sek(b.eur) + 10) - a.gain / (sek(a.eur) + 10));
  const picks = []; let cost = 0;
  for (const p of pairs) { if (picks.length >= 15) break; if (cost + sek(p.eur) > budget) continue; picks.push(p); cost += sek(p.eur); }
  return { picks, cost, more: pairs.length - picks.length };
}
async function drawPlan(deck, el) {
  const head = '<h2>Uppgraderingsplan</h2>';
  const cmd = deck.cards.filter(c => c.board === 'commander').map(c => c.name);
  if (!cmd.length) { el.innerHTML = head + '<p class="muted small">Välj en befälhavare först (★ på ett kort i listan).</p>'; return; }
  const data = await edhrecFor(cmd).catch(() => null);
  if (!el.isConnected) return;
  if (!data) { el.innerHTML = head + '<p class="muted small">EDHREC har ingen sida för den här befälhavaren än.</p>'; return; }
  const need = [...new Set(data.lists.flatMap(l => l.cards.map(c => c.name)))].filter(n => !S.cards[n] && !S.notFound.has(n));
  if (need.length) { el.innerHTML = head + '<p class="muted">Hämtar priser…</p>'; await ensureCards(need).catch(() => {}); if (!el.isConnected) return; }
  let budget = 200; try { const v = JSON.parse(localStorage.getItem('lv-upbudget') || '{}')[deck.id]; if (v != null) budget = +v; } catch {}
  const plan = upgradePlan(deck, data, budget);
  const sel = drawPlan.sel?.deck === deck.id && drawPlan.sel.sig === plan.picks.map(p => p.in).join() ? drawPlan.sel.set : new Set(plan.picks.map((_, i) => i));
  drawPlan.sel = { deck: deck.id, sig: plan.picks.map(p => p.in).join(), set: sel };
  const pct = v => Math.round(v * 100) + ' %';
  el.innerHTML = `${head}
    <label class="small row">Jag vill lägga högst <input type="number" id="upBudget" min="0" max="100000" step="50" value="${budget}" style="width:6rem"> kr</label>
    ${plan.picks.length ? `<p class="small">${plan.picks.length} byten för ca <b>${Math.round(plan.cost).toLocaleString('sv-SE')} kr</b>${plan.picks.some(p => p.own) ? `, varav ${plan.picks.filter(p => p.own).length} med kort du redan har` : ''}.${plan.more ? ` ${plan.more} byten till ryms inte i budgeten.` : ''}</p>
    <div class="table-scroll"><table class="small"><thead><tr><th></th><th>Ta ut</th><th>Lägg in</th><th class="num">Vinst</th><th class="num">Kostar</th></tr></thead><tbody>
    ${plan.picks.map((p, i) => `<tr><td><input type="checkbox" data-us="${i}" ${sel.has(i) ? 'checked' : ''}></td>
      <td><span data-img="${esc(S.cards[p.out]?.image || '')}">${esc(p.out)}</span><div class="muted">${pct(p.outS)}</div></td>
      <td><span data-img="${esc(S.cards[p.in]?.image || '')}"><b>${esc(p.in)}</b></span><div class="muted">${pct(p.inS)}${p.why ? ' · ' + esc(p.why.toLowerCase()) : ''}</div></td>
      <td class="num good">+${Math.round(p.gain * 100)}</td><td class="num">${p.own ? '<span class="pill good">har</span>' : krE(p.eur)}</td></tr>`).join('')}</tbody></table></div>
    <div class="row" style="margin-top:.6rem"><button class="btn primary small" id="upDo" ${sel.size ? '' : 'disabled'}>Gör ${sel.size} valda byten</button>${S.v3 ? `<button class="btn small" id="upWish" ${[...sel].some(i => !plan.picks[i]?.own) ? '' : 'disabled'}>♡ Valda till önskelistan</button>` : ''}</div>`
      : '<p class="muted small">Hittade inga byten som gör tydlig skillnad inom budgeten. Leken ligger nära det EDHREC föreslår, eller så behövs en högre budget.</p>'}
    <p class="muted small">Procenten är hur stor andel av lekarna med ${esc(cmd.join(' + '))} på EDHREC som spelar kortet. Kort som inte finns bland EDHRECs förslag räknas som 0 %, även om de kan vara bra just i din lek. Byten görs inom samma roll när det går. Länder byts inte. Den gamla listan sparas under Versioner.</p>`;
  $('#upBudget', el).onchange = e => {
    try { const all = JSON.parse(localStorage.getItem('lv-upbudget') || '{}'); all[deck.id] = Math.max(0, +e.target.value || 0); localStorage.setItem('lv-upbudget', JSON.stringify(all)); } catch {}
    drawPlan.sel = null; drawPlan(deck, el);
  };
  el.onchange = e => { const c = e.target.closest('[data-us]'); if (!c) return; if (c.checked) sel.add(+c.dataset.us); else sel.delete(+c.dataset.us); drawPlan(deck, el); };
  if ($('#upDo', el)) $('#upDo', el).onclick = () => {
    const chosen = [...sel].map(i => plan.picks[i]).filter(Boolean);
    if (!chosen.length) return;
    saveVersion(deck, 'Före uppgradering');
    for (const p of chosen) { const x = deck.cards.find(c => c.name === p.out && c.board === 'main'); if (x) { x.name = p.in; delete x.cat; } }
    drawPlan.sel = null; saveDeckSoon(deck); render();
    toast(`${chosen.length} kort bytta. Den gamla listan finns under Versioner.`, 4000);
  };
  if ($('#upWish', el)) $('#upWish', el).onclick = async () => {
    const chosen = [...sel].map(i => plan.picks[i]).filter(p => p && !p.own);
    for (const p of chosen) await addToWishlist(p.in, 1, true);
    toast(`${chosen.length} kort på önskelistan`);
  };
}
function tabImprove(deck, tab) {
  const unknown = Object.keys(S.collection).filter(n => !S.cards[n] && !S.notFound.has(n));
  if (unknown.length && !tabImprove.loading) { tabImprove.loading = true; ensureCards(unknown).catch(() => {}).finally(() => { tabImprove.loading = false; if (S.tab === 'forbattra' && tab.isConnected) render(); }); }
  const gaps = deckGaps(deck), icon = { ok: '✅', warn: '⚠️', bad: '❌' };
  const bad = gaps.filter(g => g.state !== 'ok').length;
  tab.innerHTML = `<div class="grid cols-2">
    <div class="card"><h2>Svagheter</h2>
      <p class="small">${bad ? `<b>${bad}</b> saker att titta på.` : '<span class="good">Leken täcker det mesta.</span>'} <span class="muted">Siffrorna är tumregler för ${deck.format === 'modern' ? 'Modern (sidoleken räknas för svar på artefakter och kyrkogårdar)' : 'Commander'}, och korten känns igen på regeltexten. Ändra rollen på ett kort i kortrutan om gissningen blir fel.</span></p>
      ${gaps.map(g => {
        const own = g.state !== 'ok' && !g.over ? gapOwned(deck, g) : [];
        return `<div class="gap ${g.state}"><div class="row"><span>${icon[g.state]}</span><b>${esc(g.label)}</b><span class="spacer"></span><span class="small">${g.disp || g.n + ' st'} <span class="muted">(${g.range || (g.max ? g.min + '–' + g.max : 'minst ' + g.min)})</span></span></div>
        ${g.state !== 'ok' ? `<p class="small muted" style="margin:.2rem 0">${g.over && g.k === 'land' ? 'Många länder. Byt några mot ramp eller kortdragning.' : esc(g.why)}</p>
          ${own.length ? `<div class="row small" style="flex-wrap:wrap;gap:.3rem">Lediga i samlingen: ${own.map(n => `<button class="btn small" data-gadd="${esc(n)}" title="Lägg till i leken"><span data-img="${esc(S.cards[n]?.image || '')}">+ ${esc(n)}</span></button>`).join('')}</div>` : ''}
          ${g.q && !g.over ? `<button class="btn small" data-gq="${esc(g.q)}" style="margin-top:.3rem">Sök fler</button>` : ''}` : ''}
        ${g.hits.length ? `<details class="small"><summary class="muted">Visa vilka</summary>${g.hits.map(esc).join(', ')}</details>` : ''}</div>`;
      }).join('')}
    </div>
    <div class="card" id="upPlan"><h2>Uppgraderingsplan</h2>${deck.format === 'commander' ? '<p class="muted">Hämtar från EDHREC…</p>' : '<p class="muted small">Planen bygger på EDHREC och finns bara för Commander-lekar.</p>'}</div>
  </div>`;
  tab.addEventListener('click', async e => {
    const a = e.target.closest('[data-gadd]'); if (a) { await addToDeck(deck, a.dataset.gadd); return; }
    const q = e.target.closest('[data-gq]'); if (q) { tabSearch.last = q.dataset.gq; S.tab = 'sok'; render(); }
  });
  if (deck.format === 'commander') drawPlan(deck, $('#upPlan', tab));
}

// --- Provspela: spela själv och räkna på 1 000 matcher utan motståndare ---
function manaOf(c) {
  if (!c) return 0;
  if (mainType(c) === 'Land') return 1;
  if (!/Artifact|Creature|Enchantment/.test(c.type_line || '')) return 0;
  const t = c.oracle_text || '', m = t.match(/add ((?:\{[^}]+\})+)/i);
  if (m) return Math.min(3, m[1].split('}').length - 1);
  const w = t.match(/add (one|two|three) mana/i);
  return w ? { one: 1, two: 2, three: 3 }[w[1].toLowerCase()] : 0;
}
const fetchesLand = c => !!c && /Sorcery|Instant/.test(c.type_line || '') && /search your library for [^.]*lands?[^.]*onto the battlefield|put (a|up to \w+) lands? cards? [^.]*onto the battlefield/i.test(c.oracle_text || '');
const isSick = c => /Creature/.test(c?.type_line || '');
function goldfish(deck, runs = 1000) {
  const lib0 = deck.cards.filter(c => c.board === 'main').flatMap(c => Array(c.qty).fill(c.name));
  const info = Object.fromEntries([...new Set(lib0)].map(n => { const c = S.cards[n]; return [n, { land: mainType(c) === 'Land', cmc: c?.cmc || 0, mana: c && mainType(c) !== 'Land' ? manaOf(c) : 0, fetch: fetchesLand(c), sick: isSick(c) }]; }));
  const cmd = deck.cards.filter(c => c.board === 'commander').map(c => S.cards[c.name]?.cmc || 0).sort((a, b) => a - b);
  const edh = deck.format === 'commander', T = 8;
  const res = { runs, mull: 0, stuck: 0, cmdT: [], turns: Array.from({ length: T }, () => ({ mana: 0, spent: 0, curve: 0 })) };
  const lands = h => h.filter(n => info[n].land).length;
  for (let r = 0; r < runs; r++) {
    let lib, hand, mull = 0;
    for (;;) {
      lib = shuffle(lib0.slice()); hand = lib.splice(0, 7);
      const l = lands(hand);
      if ((l >= 2 && l <= 5) || mull >= 2) break;
      mull++;
    }
    if (mull) res.mull++;
    for (let k = edh ? mull - 1 : mull; k > 0; k--) { // lägg de dyraste korten under
      const i = hand.reduce((b, n, j) => (info[n].cmc > info[hand[b]].cmc ? j : b), 0); lib.push(hand.splice(i, 1)[0]);
    }
    let land = 0, tapped = 0, rocks = 0, sick = 0, cmdLeft = cmd.slice(), cmdT = null;
    for (let t = 1; t <= T; t++) {
      if ((t > 1 || edh) && lib.length) hand.push(lib.shift());
      land += tapped; tapped = 0; rocks += sick; sick = 0;
      const li = hand.findIndex(n => info[n].land); if (li >= 0) { hand.splice(li, 1); land++; }
      let mana = land + rocks; const total = mana; let spent = 0;
      for (;;) {
        if (cmdLeft.length && cmdLeft[0] <= mana) { mana -= cmdLeft[0]; spent += cmdLeft.shift(); if (cmdT == null) cmdT = t; continue; }
        const ok = hand.map((n, i) => ({ n, i, x: info[n] })).filter(o => !o.x.land && o.x.cmc <= mana);
        if (!ok.length) break;
        const ramp = ok.filter(o => o.x.mana || o.x.fetch).sort((a, b) => a.x.cmc - b.x.cmc)[0];
        const pick = ramp || ok.sort((a, b) => b.x.cmc - a.x.cmc)[0];
        hand.splice(pick.i, 1); mana -= pick.x.cmc; spent += pick.x.cmc;
        if (pick.x.mana) { if (pick.x.sick) sick += pick.x.mana; else { rocks += pick.x.mana; mana += pick.x.mana; } }
        if (pick.x.fetch) tapped++;
      }
      const tt = res.turns[t - 1]; tt.mana += total; tt.spent += spent; if (total >= t) tt.curve++;
      if (t === 4 && land < 3) res.stuck++;
    }
    res.cmdT.push(cmdT);
  }
  return res;
}
function simCard(deck, el) {
  const sig = deck.cards.map(c => c.name + c.qty + c.board).join();
  const draw = r => {
    const pct = v => Math.round(v / r.runs * 100) + ' %', avg = v => (v / r.runs).toFixed(1).replace('.', ',');
    const cmd = deck.cards.filter(c => c.board === 'commander'), cmc = cmd.length ? Math.min(...cmd.map(c => S.cards[c.name]?.cmc || 0)) : null;
    const cast = r.cmdT.filter(t => t != null), by = t => r.cmdT.filter(x => x != null && x <= t).length;
    return `${cmd.length ? `<p>Befälhavaren (${cmc} mana) kommer ut i snitt <b>tur ${cast.length ? (cast.reduce((a, b) => a + b, 0) / cast.length).toFixed(1).replace('.', ',') : '–'}</b>. Senast tur ${cmc + 1} i <b>${pct(by(cmc + 1))}</b> av matcherna${cast.length < r.runs ? `, och i ${pct(r.runs - cast.length)} hinner den inte ut före tur 9` : ''}.</p>` : ''}
      <p class="small">Mulligan i ${pct(r.mull)} av matcherna. I <b>${pct(r.stuck)}</b> har du färre än 3 länder tur 4.</p>
      <table class="small"><thead><tr><th>Tur</th><th class="num">Mana</th><th class="num" title="Andel matcher med minst lika mycket mana som turens nummer">Mana i fas</th><th class="num">Använt</th></tr></thead><tbody>
      ${r.turns.slice(0, 7).map((t, i) => `<tr><td>${i + 1}</td><td class="num">${avg(t.mana)}</td><td class="num">${pct(t.curve)}</td><td class="num">${avg(t.spent)}</td></tr>`).join('')}</tbody></table>
      <p class="muted small">Mana = länder plus artefakter och varelser som ger mana (varelser först turen efter). Använt = hur mycket mana som gick till kort, när datorn spelar ramp först och sedan dyraste kortet som går. Färger räknas inte, så verkligheten är lite sämre. Mana i fas = andel matcher med minst lika mycket mana som turens nummer. Händer med färre än 2 eller fler än 5 länder tas mulligan på.</p>`;
  };
  const done = simCard.res?.deck === deck.id && simCard.res.sig === sig ? simCard.res.r : null;
  el.innerHTML = `<div class="row"><h2 style="margin:0">Hur snabbt kommer leken igång?</h2><span class="spacer"></span><button class="btn small ${done ? '' : 'primary'}" id="simGo">${done ? 'Räkna igen' : 'Räkna på 1 000 matcher'}</button></div>
    <div id="simRes">${done ? draw(done) : '<p class="small muted">Datorn spelar leken 1 000 gånger utan motståndare och räknar hur mycket mana du har varje tur och när befälhavaren kommer ut.</p>'}</div>`;
  $('#simGo', el).onclick = () => { const r = goldfish(deck, 1000); simCard.res = { deck: deck.id, sig, r }; simCard(deck, el); };
}
function goldPlay(deck, st, el) {
  const g = st.g, cmd = deck.cards.filter(c => c.board === 'commander');
  if (!g) {
    el.innerHTML = `<h2>Provspela</h2><p class="small muted">Spela de första turerna själv med handen ovan, utan motståndare. Då ser du hur snabbt leken kommer igång.</p>
      <button class="btn primary" id="gStart" ${st.bottom ? 'disabled' : ''}>▶ Spela med den här handen</button>`;
    $('#gStart', el).onclick = () => {
      st.g = { turn: 1, hand: st.hand.slice(), lib: st.lib.slice(), lands: [], board: [], land: false, used: 0, cmdOut: [], casts: cmd.map(() => 0) };
      if (deck.format === 'commander' && st.g.lib.length) st.g.hand.push(st.g.lib.shift());
      render();
    };
    return;
  }
  const ready = x => x.t < g.turn || !x.tapped;
  const avail = g.lands.filter(ready).length + g.board.reduce((a, b) => a + (b.t < g.turn || !isSick(S.cards[b.n]) ? manaOf(S.cards[b.n]) : 0), 0);
  const left = avail - g.used, fig = (n, attrs = '') => { const c = S.cards[n]; return `<figure ${attrs}>${c?.thumb ? `<img src="${esc(c.thumb)}" alt="${esc(n)}" data-img="${esc(c.image)}">` : `<div class="noimg">${esc(n)}</div>`}</figure>`; };
  el.innerHTML = `<div class="row"><h2 style="margin:0">Tur ${g.turn}</h2><span class="spacer"></span><span>Mana kvar <b>${left}</b> av ${avail}</span><span class="muted small">${g.lands.length} länder · ${g.lib.length} kort i leken</span></div>
    <div class="row" style="margin:.5rem 0"><button class="btn primary small" id="gNext" ${g.turn >= 20 ? 'disabled' : ''}>Nästa tur ▶</button>${cmd.map((c, i) => `<button class="btn small" data-gcmd="${i}" ${g.cmdOut[i] ? 'disabled' : ''}>★ ${esc(c.name)} (${(S.cards[c.name]?.cmc || 0) + 2 * g.casts[i]})</button>`).join('')}<button class="btn small" id="gStop">Avsluta</button></div>
    <h3>Handen <span class="muted small">(tryck för att spela)</span></h3><div class="hand">${g.hand.map((n, i) => fig(n, `data-gh="${i}" class="pickable"`)).join('') || '<p class="muted small">Tom hand.</p>'}</div>
    <h3>På bordet</h3><div class="board">${[...g.lands.map(x => fig(x.n, `class="${ready(x) ? '' : 'tapped'}" title="Land"`)), ...g.board.map(x => fig(x.n))].join('') || '<p class="muted small">Inget än.</p>'}</div>
    <p class="muted small">Ett land per tur. Mana från artefakter räknas direkt, från varelser turen efter. Kort som söker fram länder lägger dem tappade. Färger räknas inte.</p>`;
  $('#gNext', el).onclick = () => { g.turn++; g.land = false; g.used = 0; if (g.lib.length) g.hand.push(g.lib.shift()); render(); };
  $('#gStop', el).onclick = () => { st.g = null; render(); };
  el.onclick = e => {
    const c = e.target.closest('[data-gcmd]');
    if (c) {
      const i = +c.dataset.gcmd, n = cmd[i].name, cost = (S.cards[n]?.cmc || 0) + 2 * g.casts[i];
      if (cost > left) return toast(`${n} kostar ${cost}, du har ${left} kvar`);
      g.used += cost; g.casts[i]++; g.cmdOut[i] = true; g.board.push({ n, t: g.turn }); return render();
    }
    const h = e.target.closest('[data-gh]'); if (!h) return;
    const i = +h.dataset.gh, n = g.hand[i], info = S.cards[n];
    if (mainType(info) === 'Land') {
      if (g.land) return toast('Du har redan spelat ett land den här turen');
      g.land = true; g.lands.push({ n, t: g.turn }); g.hand.splice(i, 1); return render();
    }
    const cost = info?.cmc || 0;
    if (cost > left) return toast(`${n} kostar ${cost}, du har ${left} kvar`);
    g.used += cost; g.hand.splice(i, 1);
    if (fetchesLand(info)) { g.lands.push({ n: 'Basic land', t: g.turn, tapped: true }); toast('Ett land läggs in tappat'); }
    if (!/Instant|Sorcery/.test(info?.type_line || '')) g.board.push({ n, t: g.turn });
    render();
  };
}

// --- Förslag från EDHREC ---
const edhSlug = n => n.split(' // ')[0].toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const scryImg = (n, v = 'normal') => `https://api.scryfall.com/cards/named?format=image&version=${v}&exact=${encodeURIComponent(n)}`;
async function edhrecFor(names) {
  const slugs = names.map(edhSlug);
  const tries = slugs.length > 1 ? [slugs.slice().sort().join('-'), slugs[0]] : slugs;
  for (const s of tries) {
    if (S.edhrec[s]) return S.edhrec[s];
    const r = await fetch(`https://json.edhrec.com/pages/commanders/${s}.json`);
    if (!r.ok) continue;
    const j = await r.json();
    const lists = (j.container?.json_dict?.cardlists || []).map(l => ({
      header: l.header,
      cards: (l.cardviews || []).map(v => ({ name: v.name, incl: v.potential_decks ? v.num_decks / v.potential_decks : null, synergy: v.synergy })),
    })).filter(l => l.cards.length);
    if (!lists.length) continue;
    return (S.edhrec[s] = { slug: s, decks: j.num_decks_avg || j.container?.json_dict?.card?.num_decks || null, lists });
  }
  return null;
}
const EDH_SV = { 'New Cards': 'Nya kort', 'High Synergy Cards': 'Hög synergi', 'Top Cards': 'Toppkort', 'Game Changers': 'Game changers', 'Creatures': 'Varelser', 'Instants': 'Instants', 'Sorceries': 'Sorceries', 'Utility Artifacts': 'Artefakter', 'Enchantments': 'Förtrollningar', 'Planeswalkers': 'Planeswalkers', 'Utility Lands': 'Specialländer', 'Mana Artifacts': 'Mana-artefakter', 'Lands': 'Länder', 'Battles': 'Strider' };

function tabSuggest(deck, tab) {
  const cmd = deck.cards.filter(c => c.board === 'commander').map(c => c.name);
  if (!cmd.length) { tab.innerHTML = '<div class="card empty">Välj en befälhavare först (★ på ett kort i listan).</div>'; return; }
  const opt = tabSuggest.opt || (tabSuggest.opt = { hideIn: true, onlyOwned: false });
  const isFree = n => free(n, deck) > 0;
  tab.innerHTML = `<div class="card"><p class="muted">Hämtar förslag från EDHREC för ${esc(cmd.join(' + '))}…</p></div>`;
  edhrecFor(cmd).then(data => {
    if (!tab.isConnected) return;
    if (!data) { tab.innerHTML = '<div class="card empty">EDHREC har ingen sida för den här befälhavaren än.</div>'; return; }
    const inDeck = new Set(deck.cards.map(c => c.name.toLowerCase()));
    const show = c => !(opt.hideIn && inDeck.has(c.name.toLowerCase())) && !(opt.onlyOwned && !isFree(c.name));
    tab.innerHTML = `<div class="card">
      <div class="row"><h2 style="margin:0">Populärt med ${esc(cmd.join(' + '))}</h2><span class="spacer"></span>
        <label class="small"><input type="checkbox" id="sgHide" ${opt.hideIn ? 'checked' : ''}> Dölj kort i leken</label>
        <label class="small"><input type="checkbox" id="sgOwned" ${opt.onlyOwned ? 'checked' : ''}> Bara lediga kort jag äger</label></div>
      <p class="muted small">${data.decks ? `Bygger på ${data.decks.toLocaleString('sv-SE')} lekar på EDHREC. ` : ''}Andel = hur stor del av lekarna med den här befälhavaren som spelar kortet. Synergi = hur mycket vanligare kortet är här än i andra lekar.
        <a href="https://edhrec.com/commanders/${esc(data.slug)}" target="_blank" rel="noopener">Öppna på EDHREC</a></p>
      ${data.lists.map(l => {
        const cards = l.cards.filter(show).sort((a, b) => isFree(b.name) - isFree(a.name));
        if (!cards.length) return '';
        return `<h3>${esc(EDH_SV[l.header] || l.header)}</h3><div class="table-scroll"><table class="small"><tbody>${cards.map(c => `<tr>
          <td style="width:1.4rem">${isFree(c.name) ? '<span title="Du har kortet ledigt" class="good">✓</span>' : owned(c.name) ? `<span title="Sitter i ${esc(builtIn(c.name).map(x => x.name).join(', '))}" class="shared">⇄</span>` : ''}</td>
          <td><span data-img="${esc(scryImg(c.name))}" data-sname="${esc(c.name)}" style="cursor:pointer">${esc(c.name)}</span></td>
          <td class="num">${c.incl != null ? Math.round(c.incl * 100) + ' %' : ''}</td>
          <td class="num muted">${c.synergy != null ? (c.synergy > 0 ? '+' : '') + Math.round(c.synergy * 100) + ' %' : ''}</td>
          <td class="num">${inDeck.has(c.name.toLowerCase()) ? '<span class="muted">I leken</span>' : `<button class="btn small" data-add="${esc(c.name)}">+ Lägg till</button>`}</td></tr>`).join('')}</tbody></table></div>`;
      }).join('') || '<p class="muted">Inga kort kvar med de filtren.</p>'}
    </div>`;
    $('#sgHide').onchange = e => { opt.hideIn = e.target.checked; render(); };
    $('#sgOwned').onchange = e => { opt.onlyOwned = e.target.checked; render(); };
    tab.addEventListener('click', async e => {
      const a = e.target.closest('[data-add]'); if (a) { a.disabled = true; await addToDeck(deck, a.dataset.add); return; }
      const s = e.target.closest('[data-sname]'); if (s) { await ensureCards([s.dataset.sname]).catch(() => {}); cardModal(s.dataset.sname, deck); }
    });
  }).catch(e => { if (tab.isConnected) tab.innerHTML = `<div class="card empty">Kunde inte hämta från EDHREC: ${esc(e.message)}</div>`; });
}

// --- Kombos från Commander Spellbook ---
async function combosFor(deck, force) {
  const cmd = deck.cards.filter(c => c.board === 'commander').map(c => c.name);
  const main = deck.cards.filter(c => c.board === 'main').map(c => c.name);
  const key = [...cmd, '|', ...main.slice().sort()].join('\n');
  const hit = S.combos[deck.id];
  if (hit && hit.key === key && !force) return hit.data;
  const data = await api('/api/combos', { method: 'POST', body: { commanders: cmd, main } });
  S.combos[deck.id] = { key, data };
  return data;
}
function comboHtml(x, deck, almost) {
  const inDeck = new Set(deck.cards.filter(c => c.board !== 'maybe').map(c => c.name.toLowerCase()));
  const lacking = x.uses.filter(n => !inDeck.has(n.toLowerCase()));
  return `<div class="combo">
    <div class="row"><b>${x.uses.map(n => `<span class="${inDeck.has(n.toLowerCase()) ? '' : 'warn'}" data-img="${esc(S.cards[n]?.image || scryImg(n))}">${esc(n)}</span>`).join(' + ')}</b>
      <span class="spacer"></span>${almost && lacking.length === 1 ? `<button class="btn small" data-add="${esc(lacking[0])}">+ ${esc(lacking[0])}</button><button class="btn small" data-maybe="${esc(lacking[0])}" title="Lägg i Kanske">Kanske</button>` : ''}</div>
    <div class="small">${x.produces.map(p => `<span class="pill">${esc(p)}</span>`).join(' ')}</div>
    <details class="small"><summary class="muted">Så fungerar den</summary>
      ${x.prereq ? `<p><b>Förutsättningar:</b><br>${esc(x.prereq).replace(/\n/g, '<br>')}</p>` : ''}
      <p>${esc(x.steps).replace(/\n/g, '<br>')}</p>
      <a href="https://commanderspellbook.com/combo/${esc(x.id)}/" target="_blank" rel="noopener">Öppna på Commander Spellbook</a></details>
  </div>`;
}
function tabCombos(deck, tab) {
  if (!deck.cards.some(c => c.board === 'main' || c.board === 'commander')) { tab.innerHTML = '<div class="card empty">Lägg in kort i leken först.</div>'; return; }
  const draw = data => {
    if (!tab.isConnected) return;
    tab.innerHTML = `<div class="grid cols-2">
      <div class="card"><div class="row"><h2 style="margin:0">Kombos i leken (${data.included.length})</h2><span class="spacer"></span><button class="btn small" id="cRe">↻ Kolla igen</button></div>
        ${data.included.length ? data.included.map(x => comboHtml(x, deck)).join('') : '<p class="muted">Inga kända kombos hittades.</p>'}</div>
      <div class="card" style="align-self:start"><h2>Saknar ett kort (${data.almost.length})</h2>
        <p class="muted small">Kombos där du har alla kort utom ett. Det saknade kortet är markerat.</p>
        ${data.almost.length ? data.almost.map(x => comboHtml(x, deck, true)).join('') : '<p class="muted">Inga.</p>'}</div>
    </div>
    <p class="muted small">Från Commander Spellbook, sorterat efter hur populära kombona är. Kombos med bara två kort räknas in i lekens bracket.</p>`;
    $('#cRe').onclick = () => { tab.innerHTML = '<div class="card"><p class="muted">Letar kombos…</p></div>'; combosFor(deck, true).then(draw, fail); };
  };
  const fail = e => { if (tab.isConnected) tab.innerHTML = `<div class="card empty">Kunde inte hämta kombos: ${esc(e.message)}</div>`; };
  tab.innerHTML = '<div class="card"><p class="muted">Letar kombos i Commander Spellbook…</p></div>';
  combosFor(deck).then(draw, fail);
  tab.addEventListener('click', async e => {
    const a = e.target.closest('[data-add]'); if (a) { a.disabled = true; await addToDeck(deck, a.dataset.add); return; }
    const m = e.target.closest('[data-maybe]'); if (m) { m.disabled = true; await addToDeck(deck, m.dataset.maybe, 'maybe'); }
  });
}

// --- Versioner ---
const cardKey = c => c.board + '|' + c.name;
function diffCards(from, to) {
  const a = {}, b = {};
  for (const c of from) a[cardKey(c)] = (a[cardKey(c)] || 0) + c.qty;
  for (const c of to) b[cardKey(c)] = (b[cardKey(c)] || 0) + c.qty;
  const out = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const d = (b[k] || 0) - (a[k] || 0);
    if (d) { const [board, name] = [k.slice(0, k.indexOf('|')), k.slice(k.indexOf('|') + 1)]; out.push({ name, board, d }); }
  }
  return out.sort((x, y) => y.d - x.d || x.name.localeCompare(y.name));
}
function saveVersion(deck, label) {
  deck.versions = [{ at: new Date().toISOString(), label: String(label || '').slice(0, 60), cards: deck.cards.map(c => ({ ...c })) }, ...(deck.versions || [])].slice(0, 20);
  saveDeckSoon(deck);
}
function diffHtml(diff) {
  if (!diff.length) return '<span class="muted">Inga skillnader</span>';
  const bn = b => b === 'main' ? '' : ` <span class="muted">(${b === 'commander' ? 'befälhavare' : TYPE_SV[b].toLowerCase()})</span>`;
  return diff.map(x => `<div class="${x.d > 0 ? 'good' : 'bad'}">${x.d > 0 ? '+' : '−'}${Math.abs(x.d)} ${esc(x.name)}${bn(x.board)}</div>`).join('');
}
function tabVersions(deck, tab) {
  const vs = deck.versions || [];
  tab.innerHTML = `<div class="grid cols-2">
    <div class="card"><h2>Sparade versioner</h2>
      ${vs.length ? `<table><thead><tr><th>När</th><th>Namn</th><th>Ändring sedan dess</th><th></th></tr></thead><tbody>
        ${vs.map((v, i) => {
          const diff = diffCards(v.cards, deck.cards);
          const plus = diff.filter(x => x.d > 0).reduce((a, x) => a + x.d, 0), minus = diff.filter(x => x.d < 0).reduce((a, x) => a - x.d, 0);
          return `<tr><td class="small">${new Date(v.at).toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' })}</td><td>${esc(v.label || '–')}</td>
            <td><details><summary class="small">${diff.length ? `<span class="good">+${plus}</span> <span class="bad">−${minus}</span>` : 'samma som nu'}</summary><div class="small">${diffHtml(diff)}</div></details></td>
            <td class="num"><button class="btn small" data-restore="${i}">Återställ</button> <button class="icon-btn" data-delv="${i}" title="Ta bort versionen">✕</button></td></tr>`;
        }).join('')}</tbody></table>` : '<p class="muted">Inga versioner än. Spara en innan du gör stora ändringar.</p>'}
      <p class="muted small">Upp till 20 versioner sparas. "Ändring sedan dess" visar vad som har lagts till (+) och tagits bort (−) fram till nu.</p>
    </div>
    <div class="card" style="align-self:start"><h2>Spara läget nu</h2>
      <p><input type="text" id="vLabel" placeholder="Namn, t.ex. Före turnering" style="width:100%" maxlength="60"></p>
      <p class="row"><span class="spacer"></span><button class="btn primary" id="vSave">Spara version</button></p></div>
  </div>`;
  $('#vSave').onclick = () => { saveVersion(deck, $('#vLabel').value.trim()); toast('Version sparad'); render(); };
  tab.addEventListener('click', e => {
    const r = e.target.closest('[data-restore]');
    if (r) {
      const v = vs[+r.dataset.restore];
      saveVersion(deck, 'Före återställning');
      deck.cards = v.cards.map(c => ({ ...c }));
      saveDeckSoon(deck); toast('Återställd. Läget innan sparades som en egen version.', 3500); render();
    }
    const d = e.target.closest('[data-delv]');
    if (d) { deck.versions = vs.filter((_, i) => i !== +d.dataset.delv); saveDeckSoon(deck); render(); }
  });
}

// ---------- billigare alternativ ----------
// Samma roll (Scryfalls taggar för ramp, kortdragning …) eller samma korttyp, liknande kostnad, högst halva priset.
const ROLE_OTAG = { Ramp: 'otag:ramp', Kortdragning: 'otag:draw', Removal: 'otag:removal', Massborttagning: 'otag:board-wipe', Tutors: 'otag:tutor' };
const TYPE_Q = { Creature: 't:creature', Planeswalker: 't:planeswalker', Battle: 't:battle', Instant: 't:instant', Sorcery: 't:sorcery', Artifact: 't:artifact', Enchantment: 't:enchantment', Land: 't:land -t:basic' };
function cheaperQuery(name, deck) {
  const c = S.cards[name]; if (!c || c.eur == null) return null;
  const entry = deck?.cards.find(x => x.name === name);
  const type = mainType(c), roles = rolesOf(entry ? { ...entry, name } : { name }).filter(r => ROLE_OTAG[r]);
  const q = [];
  if (roles.length) q.push(roles.length > 1 ? `(${roles.map(r => ROLE_OTAG[r]).join(' or ')})` : ROLE_OTAG[roles[0]]);
  else if (TYPE_Q[type]) q.push(TYPE_Q[type]);
  if (type !== 'Land') q.push('-t:land', `cmc<=${(c.cmc || 0) + 1}`);
  const max = Math.max(0.2, Math.floor(c.eur * 50) / 100);
  q.push(`eur<${max}`, `-!"${name.replace(/"/g, '')}"`);
  if (deck?.format === 'modern') q.push('f:modern');
  else {
    const cmd = (deck?.cards || []).filter(x => x.board === 'commander');
    const ident = cmd.length ? [...new Set(cmd.flatMap(x => S.cards[x.name]?.color_identity || []))].join('') : (c.color_identity || []).join('');
    q.push(`id<=${ident || 'c'}`, 'f:commander');
  }
  return { q: q.join(' '), roles, type, max };
}
async function cheaperModal(name, deck) {
  const cq = cheaperQuery(name, deck);
  if (!cq) return toast('Kortet saknar pris');
  openModal('<p class="muted">Letar billigare kort…</p>');
  let r;
  try { r = await api('/api/search?max=24&q=' + encodeURIComponent(cq.q)); }
  catch (e) { return openModal(`<div class="row"><h2 style="margin:0">Billigare alternativ</h2><span class="spacer"></span><button class="icon-btn" data-close aria-label="Stäng">✕</button></div><p class="bad">${esc(e.message)}</p>`); }
  for (const c of r.cards) S.cards[c.name] = c;
  const entry = deck?.cards.find(x => x.name === name && x.board !== 'maybe');
  const inDeck = new Set((deck?.cards || []).filter(x => x.board !== 'maybe').map(x => x.name));
  const have = n => deck ? free(n, deck) : S.collection[n] || 0;
  // kort man redan har lediga först, annars Scryfalls popularitetsordning
  const list = r.cards.filter(c => c.eur != null).map((c, i) => ({ c, i, h: have(c.name) })).sort((a, b) => (b.h > 0) - (a.h > 0) || a.i - b.i).slice(0, 12);
  const what = cq.roles.length ? 'Kort med samma roll (' + cq.roles.join(' eller ').toLowerCase() + ')' : (TYPE_SV[cq.type] || 'Kort') + ' med liknande manakostnad';
  openModal(`<div class="row"><h2 style="margin:0">Billigare än ${esc(name)}</h2><span class="spacer"></span><button class="icon-btn" data-close aria-label="Stäng">✕</button></div>
    <p class="small muted">${esc(what)}, under halva priset: ${krE(S.cards[name]?.eur)} → under ${krE(cq.max)}. Kort du redan har lediga visas först, sedan efter popularitet.</p>
    ${list.length ? `<div class="alts">${list.map(({ c, h }) => `<div class="alt" data-n="${esc(c.name)}"><img loading="lazy" src="${esc(c.thumb || c.image || '')}" alt="" data-img="${esc(c.image || '')}" data-openalt>
      <div class="grow"><b data-openalt style="cursor:pointer">${esc(c.name)}</b> <span class="small">${manaHtml(c.mana_cost || '')}</span>
        <div class="small">ca ${krE(c.eur)}${h ? ` · <span class="pill good">du har ${h} ledig${h > 1 ? 'a' : ''}</span>` : ''}</div>
        <div class="small muted clamp">${esc((c.oracle_text || '').slice(0, 140))}</div></div>
      <div class="altbtn">${entry && !inDeck.has(c.name) ? '<button class="btn small primary" data-swapto>Byt ut</button>' : ''}${deck && !entry && !inDeck.has(c.name) ? '<button class="btn small" data-addalt>+ Lägg till</button>' : ''}${inDeck.has(c.name) ? '<span class="muted small">I leken</span>' : ''}${S.v3 && !h ? `<button class="btn small" data-wishalt title="Önskelista">${S.wishlist.some(w => w.name === c.name) ? '♥' : '♡'}</button>` : ''}</div></div>`).join('')}</div>`
      : '<p class="muted">Hittade inga billigare kort som gör samma sak. Prova Hitta kort i leken.</p>'}
    ${entry ? '<p class="small muted">Byt ut ersätter kortet i leken. Den gamla listan sparas under Versioner.</p>' : ''}`, box => {
    box.onclick = async e => {
      const row = e.target.closest('.alt'); if (!row) return;
      const n = row.dataset.n;
      if (e.target.closest('[data-swapto]')) return swapInDeck(deck, name, n);
      if (e.target.closest('[data-addalt]')) { await addToDeck(deck, n); return cheaperModal(name, deck); }
      if (e.target.closest('[data-wishalt]')) { await addToWishlist(n); e.target.closest('[data-wishalt]').textContent = '♥'; return; }
      if (e.target.closest('[data-openalt]')) cardModal(n, deck);
    };
  });
}
function swapInDeck(deck, from, to) {
  if (deck.cards.some(x => x.name === to && x.board !== 'maybe')) return toast(`${to} finns redan i leken`);
  saveVersion(deck, `Före byte: ${from} → ${to}`);
  for (const x of deck.cards) if (x.name === from && x.board !== 'maybe') { x.name = to; delete x.cat; }
  saveDeckSoon(deck); closeModal(); render();
  toast(`${from} bytt mot ${to}. Den gamla listan finns under Versioner.`, 4000);
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-cheap]'); if (!b) return;
  e.preventDefault(); e.stopPropagation();
  const id = (location.hash.match(/^#\/lek\/([\w-]+)/) || [])[1];
  cheaperModal(b.dataset.cheap, S.decks.find(d => d.id === id));
}, true);

// --- Köpa ---
async function alaraFor(name, fresh) {
  if (!fresh && S.alara[name]) return S.alara[name];
  const r = await api('/api/alara?name=' + encodeURIComponent(name) + (fresh ? '&fresh=1' : ''));
  S.alara[name] = r; return r;
}
function tabBuy(deck, tab) {
  const miss = missingCards(deck);
  const pickOffer = r => r && r.offers.find(o => !o.foil) || r?.offers[0];
  let alaraTotal = 0, alaraCount = 0;
  const rest = [];
  for (const m of miss) {
    const o = pickOffer(S.alara[m.name]);
    if (o) { alaraTotal += o.price * m.missing; alaraCount += m.missing; } else rest.push(m);
  }
  const checked = miss.filter(m => S.alara[m.name]).length;
  const wants = (checked ? rest : miss).map(m => `${m.missing} ${m.name}`).join('\n');
  const inBuilt = Object.fromEntries(takenCards(deck).map(x => [x.name, x.where]));
  if (S.cloud && !S.trades) loadTrades().then(() => S.tab === 'kop' && tab.isConnected && render());
  const offers = tradeIndex();
  const sel = tabBuy.sel || (tabBuy.sel = new Set());
  let budget = 0;
  try { budget = +JSON.parse(localStorage.getItem('lv-budget') || '{}')[deck.id] || 0; } catch {}
  const priceOf = n => pickOffer(S.alara[n])?.price ?? (S.cards[n]?.eur != null ? sek(S.cards[n].eur) : null);
  const plan = budget ? budgetPlan(deck, miss, budget, priceOf) : null;
  tab.innerHTML = miss.length ? `
    <div class="grid cols-2">
      <div class="card">
        <div class="row"><h2 style="margin:0">Det här saknar du (${miss.reduce((a, m) => a + m.missing, 0)} kort)</h2><span class="spacer"></span>
          <button class="btn primary" id="runAlara">${checked ? 'Kolla Alara igen' : 'Kolla lagret hos Alara'}</button></div>
        <div class="progress" id="prog" hidden style="margin:.6rem 0"><div style="width:0"></div></div>
        <div class="row small" style="margin:.6rem 0"><button class="btn small" id="selAlara" ${checked ? '' : 'disabled'}>Markera allt som finns hos Alara</button>
          <button class="btn small primary" id="gotSel" ${sel.size ? '' : 'disabled'}>Markera ${sel.size || ''} valda som köpta</button>
          ${S.v3 ? `<button class="btn small" id="wishSel" ${sel.size ? '' : 'disabled'}>♡ Valda till önskelistan</button>` : ''}
          <span class="muted">Köpta kort läggs i samlingen.</span></div>
        <div class="table-scroll"><table>
          <thead><tr><th><input type="checkbox" id="selAll" title="Markera alla"></th><th>Kort</th><th class="num">Antal</th><th>Alara Games</th>${S.cloud ? '<th>Kompisar</th>' : ''}<th>Andra butiker</th><th></th></tr></thead>
          <tbody>${miss.map(m => {
            const r = S.alara[m.name], o = pickOffer(r), info = S.cards[m.name];
            const cell = !r ? '<span class="muted small">ej kollat</span>'
              : o ? `<div class="offer"><a href="${esc(o.url)}" target="_blank" rel="noopener"><span class="price">${kr(o.price)}</span></a> <span class="muted">${esc(o.condition)}</span>
                  ${r.offers.length > 1 ? `<details class="small"><summary class="muted">${r.offers.length - 1} till</summary>${r.offers.slice(1).map(x => `<div><a href="${esc(x.url)}" target="_blank" rel="noopener">${kr(x.price)}</a> ${esc(x.condition)} – <span class="muted">${esc(x.title)}</span></div>`).join('')}</details>` : ''}</div>`
              : '<span class="pill warn">ej i lager</span>';
            const fr = offers[m.name.toLowerCase()] || [];
            return `<tr data-name="${esc(m.name)}"><td><input type="checkbox" data-sel ${sel.has(m.name) ? 'checked' : ''}></td><td><span data-img="${esc(info?.image || '')}">${esc(m.name)}</span><div class="muted small">ca ${krE(info?.eur)}${inBuilt[m.name] ? ` · du har kortet i ${esc(inBuilt[m.name])}` : ''}</div></td>
              <td class="num">${m.missing}</td><td>${cell}</td>${S.cloud ? `<td class="small">${fr.map(t => `<div title="Till byte">⇄ ${esc(t.ownerName)} har ${t.qty}</div>`).join('') || '<span class="muted">–</span>'}</td>` : ''}<td><div class="links">${buyLinks(m.name).replace(/<a href="https:\/\/www\.alaragames[^>]*>Alara<\/a>/, '')}</div></td>
              <td><button class="btn small" data-got title="Jag har köpt/fått kortet">Har ✓</button></td></tr>`;
          }).join('')}</tbody></table></div>
      </div>
      <div class="grid" style="align-content:start">
        <div class="card"><h2>Sammanställning</h2>
          ${checked ? `<p>Hos <b>Alara</b>: ${alaraCount} kort för <b>${kr(alaraTotal)}</b> (billigaste ej-foil i lager, exkl. frakt).</p>
            <p>Kvar att leta på Cardmarket och Svenska Magic: <b>${rest.reduce((a, m) => a + m.missing, 0)}</b> kort.</p>`
            : '<p class="muted">Tryck på "Kolla lagret hos Alara" för priser i kronor. Det tar ungefär en sekund per kort.</p>'}
          ${checked < miss.length && checked ? `<p class="small warn">${miss.length - checked} kort är inte kollade än.</p>` : ''}
        </div>
        ${(x => x.length ? `<div class="card"><h2>Billigare alternativ</h2><p class="small muted">De dyraste korten du saknar. Tryck för att se billigare kort som gör samma sak.</p>
          <table class="small"><tbody>${x.map(m => `<tr><td>${esc(m.name)}</td><td class="num">${krE(S.cards[m.name].eur)}</td><td class="num"><button class="btn small" data-cheap="${esc(m.name)}">Visa</button></td></tr>`).join('')}</tbody></table></div>` : '')(miss.filter(m => S.cards[m.name]?.eur != null && sek(S.cards[m.name].eur) >= 30 && m.board !== 'commander').sort((p, q) => S.cards[q.name].eur - S.cards[p.name].eur).slice(0, 6))}
        <div class="card"><h2>Budget</h2>
          <label class="small row">Jag vill lägga <input type="number" id="bgMax" min="0" max="1000000" step="50" value="${budget || ''}" placeholder="500" style="width:6rem"> kr</label>
          ${plan ? `<p>${plan.picks.length} av ${plan.picks.length + plan.skipped + plan.noPrice} kort för <b>${kr(plan.cost)}</b>.</p>
            <ul class="small" style="margin:.2rem 0;padding-left:1.1rem">${plan.picks.map(x => `<li>${esc(x.name)} <span class="muted">${kr(x.price)}</span></li>`).join('')}</ul>
            ${plan.noPrice ? `<p class="small warn">${plan.noPrice} kort saknar pris.</p>` : ''}
            ${plan.picks.length ? '<button class="btn small" id="bgSel">Markera dessa</button>' : ''}` : ''}
          <p class="muted small">Befälhavaren och det leken har för lite av kommer först. Alarapriset används om det finns, annars ${priceWhat()}.</p></div>
        <div class="card"><h2>Önskelista för Cardmarket</h2>
          <p class="small muted">${checked ? 'Korten som Alara inte har i lager.' : 'Alla kort du saknar.'}</p>
          <textarea id="wants" readonly style="min-height:160px">${esc(wants)}</textarea>
          <div class="row"><button class="btn small" id="copyWants">Kopiera</button><a class="btn small" href="https://www.cardmarket.com/en/Magic/Wants" target="_blank" rel="noopener">Öppna Cardmarket Wants</a></div>
          <ol class="steps small">
            <li>Skapa en ny önskelista under <b>Wants</b> och välj att lägga till kort från text (klistra in).</li>
            <li>Kör <b>Shopping Wizard</b> på listan och välj <b>Sverige</b> som säljarland.</li>
            <li>Wizarden räknar ut billigaste kombinationen av säljare inklusive frakt.</li>
          </ol>
        </div>
        <div class="card"><h2>Proxies för att testa</h2>
          <p class="small muted">Skriv ut kort du inte har, 9 per A4 i rätt storlek (63 × 88 mm), och testa leken innan du köper. Bara för eget spel, inte för turneringar.</p>
          <div class="row"><button class="btn small" id="prMiss">Skriv ut saknade (${miss.reduce((a, m) => a + m.missing, 0)})</button>${sel.size ? `<button class="btn small" id="prSel">Skriv ut valda (${sel.size})</button>` : ''}</div>
        </div>
      </div>
    </div>` : '<div class="card empty"><b>Du har alla kort i den här leken!</b><br>Inget att köpa.</div>';
  if (!miss.length) return;
  $('#copyWants').onclick = () => navigator.clipboard.writeText($('#wants').value).then(() => toast('Kopierat'));
  tab.addEventListener('change', e => {
    if (e.target.id === 'selAll') { if (e.target.checked) miss.forEach(m => sel.add(m.name)); else sel.clear(); return render(); }
    if (e.target.matches('[data-sel]')) { const n = e.target.closest('tr').dataset.name; if (e.target.checked) sel.add(n); else sel.delete(n); render(); }
  });
  $('#selAlara').onclick = () => { miss.forEach(m => pickOffer(S.alara[m.name]) && sel.add(m.name)); render(); };
  if ($('#wishSel')) $('#wishSel').onclick = async () => {
    for (const m of miss) if (sel.has(m.name)) await addToWishlist(m.name, m.missing, true);
    toast(`${sel.size} kort på önskelistan`); sel.clear(); render();
  };
  $('#prMiss').onclick = () => printProxies(miss.flatMap(m => Array(m.missing).fill(m.name)));
  if ($('#prSel')) $('#prSel').onclick = () => printProxies(miss.filter(m => sel.has(m.name)).flatMap(m => Array(m.missing).fill(m.name)));
  $('#gotSel').onclick = async () => {
    const body = {};
    for (const m of miss) if (sel.has(m.name)) body[m.name] = ownTarget(m.name, deck, m.qty);
    Object.assign(S.collection, body);
    await api('/api/collection', { method: 'PUT', body });
    toast(`${Object.keys(body).length} kort lagda i samlingen`); sel.clear(); render();
  };
  tab.addEventListener('click', async e => {
    const b = e.target.closest('[data-got]'); if (!b) return;
    const name = b.closest('tr').dataset.name;
    const need = deck.cards.filter(c => c.name === name && c.board !== 'maybe').reduce((a, c) => a + c.qty, 0);
    await setOwned(name, ownTarget(name, deck, need)); render();
  });
  // körningen fortsätter även om sidan ritas om; knappen visar bara läget
  $('#bgMax').onchange = e => {
    try {
      const all = JSON.parse(localStorage.getItem('lv-budget') || '{}');
      if (+e.target.value > 0) all[deck.id] = +e.target.value; else delete all[deck.id];
      localStorage.setItem('lv-budget', JSON.stringify(all));
    } catch {}
    render();
  };
  if ($('#bgSel')) $('#bgSel').onclick = () => { sel.clear(); for (const x of plan.picks) sel.add(x.name); render(); };
  const showRun = () => {
    const run = S.alaraRun, btn = $('#runAlara'), prog = $('#prog');
    if (!run || !btn) return;
    btn.disabled = true; prog.hidden = false;
    $('div', prog).style.width = (run.done / run.total * 100) + '%';
    btn.textContent = `Kollar… ${run.done}/${run.total}`;
  };
  showRun();
  $('#runAlara').onclick = async () => {
    if (S.alaraRun) return;
    const fresh = checked === miss.length;
    const run = S.alaraRun = { done: 0, total: miss.length, errors: 0 };
    showRun();
    for (const m of miss) {
      if (fresh || !S.alara[m.name]) await alaraFor(m.name, fresh).catch(() => run.errors++);
      run.done++;
      if (S.tab === 'kop') showRun();
    }
    S.alaraRun = null;
    if (run.errors) toast(`${run.errors} kort kunde inte kollas – försök igen senare`, 4000);
    if (S.tab === 'kop') render();
  };
}

// --- Hitta kort ---
function tabSearch(deck, tab) {
  const cmd = deck.cards.filter(c => c.board === 'commander');
  const ident = [...new Set(cmd.flatMap(c => S.cards[c.name]?.color_identity || []))].join('') || 'c';
  const base = deck.format === 'commander' ? (cmd.length ? `id<=${ident} f:commander` : 'f:commander') : 'f:modern';
  const presets = deck.format === 'commander'
    ? [['Ramp', 'o:"add {" t:artifact cmc<=3'], ['Kortdragning', 'o:"draw" (t:instant or t:sorcery or t:enchantment)'], ['Removal', '(o:"destroy target" or o:"exile target") (t:instant or t:sorcery)'], ['Massborttagning', 'o:"destroy all" or o:"exile all"'], ['Länder', 't:land -t:basic'], ['Befälhavare', 't:legendary t:creature']]
    : [['Removal', '(o:"destroy target" or o:"exile target" or o:"damage to any target") cmc<=2'], ['Kortdragning', 'o:draw cmc<=3'], ['Motspel', 'o:"counter target"'], ['Länder', 't:land -t:basic']];
  tab.innerHTML = `<div class="card">
    <div class="row"><input type="search" id="sq" placeholder="Scryfall-sökning, t.ex. t:dragon cmc<=5" style="flex:1;min-width:220px" value="${esc(tabSearch.last || '')}"><button class="btn primary" id="sgo">Sök</button></div>
    <div class="row small" style="margin-top:.5rem">${presets.map(([l, q]) => `<button class="btn small" data-q="${esc(q)}">${l}</button>`).join('')}
      <span class="muted">Filtreras automatiskt på: <code>${esc(base)}</code></span></div>
    <div id="sres"></div></div>`;
  const run = async q => {
    tabSearch.last = q;
    const res = $('#sres'); res.innerHTML = '<p class="muted">Söker…</p>';
    try {
      const r = await api('/api/search?q=' + encodeURIComponent(`${q} ${base}`));
      for (const c of r.cards) S.cards[c.name] = c;
      const inDeck = new Set(deck.cards.map(c => c.name));
      res.innerHTML = r.cards.length ? `<p class="muted small">${r.total} träffar, sorterade efter popularitet (EDHREC). Visar ${r.cards.length}.</p>
        <div class="search-results">${r.cards.map(c => `<figure><img loading="lazy" src="${esc(c.thumb)}" alt="${esc(c.name)}" data-img="${esc(c.image)}" data-open="${esc(c.name)}">
          <figcaption><button class="btn small" data-add="${esc(c.name)}" ${inDeck.has(c.name) ? 'disabled' : ''}>${inDeck.has(c.name) ? 'I leken' : '+ Lägg till'}</button></figcaption></figure>`).join('')}</div>`
        : '<p class="muted">Inga träffar.</p>';
    } catch (e) { res.innerHTML = `<p class="bad">${esc(e.message)}</p>`; }
  };
  $('#sgo').onclick = () => run($('#sq').value);
  $('#sq').onkeydown = e => { if (e.key === 'Enter') run($('#sq').value); };
  tab.addEventListener('click', async e => {
    const q = e.target.closest('[data-q]'); if (q) { $('#sq').value = q.dataset.q; return run(q.dataset.q); }
    const a = e.target.closest('[data-add]'); if (a) { await addToDeck(deck, a.dataset.add); return; }
    const o = e.target.closest('[data-open]'); if (o) cardModal(o.dataset.open, deck);
  });
  if (tabSearch.last) run(tabSearch.last);
}

// --- Import/Export ---
function tabText(deck, tab) {
  tab.innerHTML = `<div class="grid cols-2">
    <div class="card"><h2>Lägg till från text</h2>
      <textarea id="imp" placeholder="1 Sol Ring&#10;4 Lightning Bolt (M10) 146&#10;&#10;Sideboard&#10;2 Blood Moon"></textarea>
      <div class="row"><label class="small"><input type="checkbox" id="replace"> Ersätt hela leken</label><span class="spacer"></span><button class="btn primary" id="impGo">Lägg till</button></div>
      <p class="muted small">Fungerar med export från Moxfield, Archidekt, MTG Arena och vanliga listor. Rubriker som Commander, Deck, Sideboard och Maybe styr vart korten hamnar. Du kan också klistra in en länk till en publik lek på Archidekt.</p></div>
    <div class="card"><h2>Exportera</h2><textarea readonly id="exp">${esc(exportText(deck))}</textarea>
      <div class="row"><button class="btn small" id="copyExp">Kopiera</button></div>
      <h3>Anteckningar</h3><textarea id="notes" style="min-height:100px;font-family:inherit">${esc(deck.notes || '')}</textarea></div></div>`;
  $('#copyExp').onclick = () => navigator.clipboard.writeText($('#exp').value).then(() => toast('Kopierat'));
  $('#notes').onchange = e => { deck.notes = e.target.value; saveDeckSoon(deck); };
  $('#impGo').onclick = async () => {
    $('#impGo').disabled = true; $('#impGo').textContent = 'Hämtar kort…';
    let list;
    try { list = (await fetchDeckUrl($('#imp').value))?.cards || parseList($('#imp').value, deck.format); }
    catch (e) { $('#impGo').disabled = false; $('#impGo').textContent = 'Lägg till'; return toast(e.message, 6000); }
    if (!list.length) { $('#impGo').disabled = false; $('#impGo').textContent = 'Lägg till'; return toast('Hittade inga kort i texten'); }
    if ($('#replace').checked) { if (deck.cards.length) saveVersion(deck, 'Före import'); deck.cards = []; }
    mergeCards(deck, list);
    const nf = await ensureCards(deck.cards.map(c => c.name)).catch(e => { toast(e.message); return []; });
    canonicalize(deck);
    saveDeckSoon(deck);
    toast(nf.length ? `Klart. ${nf.length} kort hittades inte: ${nf.slice(0, 3).join(', ')}${nf.length > 3 ? '…' : ''}` : `Lade till ${list.reduce((a, c) => a + c.qty, 0)} kort`, 4500);
    S.tab = 'lista'; render();
  };
}

// --- Samling ---
function viewCollection() {
  setNav('samling');
  const names = Object.keys(S.collection).sort((a, b) => a.localeCompare(b));
  const unknown = names.filter(n => !S.cards[n] && !S.notFound.has(n));
  if (unknown.length && !viewCollection.loading) {
    viewCollection.loading = true;
    ensureCards(unknown).catch(() => {}).finally(() => { viewCollection.loading = false; render(); });
  }
  const total = names.reduce((a, n) => a + S.collection[n], 0);
  const value = names.reduce((a, n) => a + colValue(n), 0);
  refreshPrintPrices();
  valueSnapshot();
  const used = {};
  for (const d of S.decks) for (const c of d.cards) if (c.board !== 'maybe') (used[c.name] = used[c.name] || new Set()).add(d.name);
  let show = viewCollection.show || 'alla';
  if (show === 'lan' && !S.v3) show = 'alla';
  const unused = names.filter(n => !used[n]).length;
  const shared = sharedShortage(), nShared = names.filter(n => shared[n]).length;
  const sortBy = viewCollection.sort || 'namn';
  const shown = (show === 'oanvanda' ? names.filter(n => !used[n]) : show === 'delas' ? names.filter(n => shared[n]) : show === 'byte' ? names.filter(n => S.trade[n]) : names.slice())
    .sort({
      varde: (a, b) => colValue(b) - colValue(a),
      senast: (a, b) => (S.colmeta[b]?.added || 0) - (S.colmeta[a]?.added || 0) || a.localeCompare(b),
      antal: (a, b) => S.collection[b] - S.collection[a] || a.localeCompare(b),
    }[sortBy] || (() => 0));
  const day = t => t ? new Date(t).toLocaleDateString('sv-SE') : '';
  const loanRows = S.loans.map(l => `<tr data-loan="${esc(l.id)}"><td><span data-img="${esc(S.cards[l.name]?.image || scryImg(l.name))}">${esc(l.name)}</span></td><td class="num">${l.qty}</td>
    <td>${esc(l.borrower)}</td><td class="small">${esc(l.lent_on)}</td><td><button class="btn small" data-back="${esc(l.id)}">Tillbaka ✓</button></td></tr>`).join('');
  $('#app').innerHTML = `<div id="col">
    <div class="row"><h1>Min samling</h1><span class="spacer"></span><span class="muted">${names.length} olika · ${total} kort · ca <b>${krE(value)}</b></span><button class="btn small" id="scanTop">📷 Skanna</button></div>
    <div class="grid cols-2" style="margin-top:1rem">
      <div class="card">
        <div class="row" style="margin-bottom:.6rem"><div class="add-bar" id="colAdd"></div><input type="search" id="colFilter" placeholder="Filtrera…" style="width:160px"></div>
        <div class="row small" style="margin-bottom:.6rem">
          <div class="seg" id="colShow"><button data-show="alla" class="${show === 'alla' ? 'on' : ''}">Alla</button><button data-show="oanvanda" class="${show === 'oanvanda' ? 'on' : ''}">Används inte i någon lek (${unused})</button>${nShared ? `<button data-show="delas" class="${show === 'delas' ? 'on' : ''}" title="Kort som flera lekar behöver men där du inte har så många att alla kan vara ihopplockade samtidigt">Räcker inte till alla lekar (${nShared})</button>` : ''}${S.cloud ? `<button data-show="byte" class="${show === 'byte' ? 'on' : ''}">Till byte (${Object.keys(S.trade).length})</button>` : ''}${S.v3 ? `<button data-show="lan" class="${show === 'lan' ? 'on' : ''}">Utlånat (${S.loans.length})</button>` : ''}</div>
          ${show !== 'lan' ? `<label>Sortera <select id="colSort">${[['namn', 'Namn'], ['varde', 'Värde'], ...(S.v4 ? [['senast', 'Senast inlagt']] : []), ['antal', 'Antal']].map(([v, l]) => `<option value="${v}" ${sortBy === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>` : ''}</div>
        ${show === 'lan' ? `${S.loans.length ? `<div class="table-scroll"><table><thead><tr><th>Kort</th><th class="num">Antal</th><th>Hos</th><th>Sedan</th><th></th></tr></thead><tbody>${loanRows}</tbody></table></div>` : '<p class="muted">Inga utlånade kort.</p>'}
          <h3>Låna ut ett kort</h3><div class="row"><div class="add-bar" id="loanCard"></div><input type="text" id="loanTo" placeholder="Till vem?" maxlength="60" style="width:140px"><input type="number" id="loanQty" min="1" max="99" value="1" style="width:4rem"></div>
          <p class="muted small">Välj kortet i listan så sparas lånet. Utlånade kort markeras med ↗ i dina lekar.</p>`
        : shown.length ? `<div class="table-scroll"><table><thead><tr><th>Kort</th><th>Typ</th><th>I lekar</th><th class="num">Värde</th><th class="num">Antal</th>${S.cloud ? '<th class="num" title="Hur många du kan tänka dig att byta bort. Syns för andra i bytesbörsen.">Till byte</th>' : ''}</tr></thead><tbody>
          ${shown.map(n => `<tr data-name="${esc(n)}"><td><span data-img="${esc(ownImg(n))}" data-open style="cursor:pointer">${esc(n)}</span>${lentQty(n) ? ' <span class="lent" title="Utlånat">↗</span>' : ''}${foilQty(n) ? ` <span class="foil" title="${foilQty(n)} foil">✦${foilQty(n) > 1 ? foilQty(n) : ''}</span>` : ''}${sortBy === 'senast' && S.colmeta[n]?.added ? `<div class="muted small">${day(S.colmeta[n].added)}</div>` : ''}</td>
            <td class="muted small">${esc((S.cards[n]?.type_line || '').split(' — ')[0])}</td>
            <td class="small muted">${used[n] ? esc([...used[n]].join(', ')) : ''}${shared[n] ? `<div class="warn">⇄ har ${shared[n].own}, behövs ${shared[n].sum}</div>` : ''}</td>
            <td class="num small">${S.cards[n]?.eur || printsOf(n).length ? krE(colValue(n)) : ''}</td>
            <td class="num"><input type="number" min="0" max="999" value="${S.collection[n]}" style="width:4.5rem" data-qty></td>
            ${S.cloud ? `<td class="num"><input type="number" min="0" max="${S.collection[n]}" value="${S.trade[n] || 0}" style="width:4.5rem" data-trade></td>` : ''}</tr>`).join('')}
          </tbody></table></div>` : `<div class="empty">${names.length ? 'Inga kort med det filtret.' : 'Samlingen är tom. Bocka i kort i dina lekar, sök ovan, eller klistra in en lista till höger.'}</div>`}
      </div>
      <div class="grid" style="align-content:start">
        ${valueCard()}
        <div class="card"><h2>Skanna kort</h2>
          <p class="small muted">Håll upp korten framför kameran ett i taget. Appen läser namnet och lägger till kortet.</p>
          <button class="btn primary" id="scanGo">📷 Starta kameran</button></div>
        <div class="card"><h2>Lägg till många</h2>
        <textarea id="colImp" placeholder="4 Lightning Bolt&#10;1 Sol Ring" style="min-height:160px"></textarea>
        <div class="row"><span class="spacer"></span><button class="btn primary" id="colImpGo">Lägg till i samlingen</button></div>
        <p class="muted small">Antalen läggs ovanpå det du redan har.</p></div></div>
    </div></div>`;
  $('#scanGo').onclick = $('#scanTop').onclick = () => scanModal();
  hookTips($('#app'));
  if ($('#colSort')) $('#colSort').onchange = e => { viewCollection.sort = e.target.value; render(); };
  if ($('#loanCard')) addCardUI($('#loanCard'), async name => {
    const to = $('#loanTo').value.trim();
    if (!to) { toast('Skriv först vem som lånar'); return; }
    await addLoan(name, +$('#loanQty').value || 1, to); render();
  }, 'Vilket kort?');
  addCardUI($('#colAdd'), async name => { await ensureCards([name]).catch(() => {}); await setOwned(name, (S.collection[name] || 0) + 1); toast(`+1 ${name}`); render(); }, 'Lägg till kort i samlingen…');
  $('#colFilter').oninput = e => { const q = e.target.value.toLowerCase(); $$('tbody tr').forEach(tr => tr.hidden = !tr.dataset.name.toLowerCase().includes(q)); };
  $('#col').addEventListener('change', async e => {
    if (e.target.matches('[data-trade]')) {
      const name = e.target.closest('tr').dataset.name;
      const n = Math.max(0, Math.min(S.collection[name] || 0, +e.target.value || 0));
      try {
        await api('/api/trade', { method: 'PUT', body: { [name]: n } });
        if (n) S.trade[name] = n; else delete S.trade[name];
        if (n && !S.profile.name) toast('Sätt ditt namn under Inställningar så att andra ser vem som har kortet', 4000);
      } catch (err) { toast('Kunde inte spara: ' + err.message, 4000); }
      e.target.value = n;
      return;
    }
    if (!e.target.matches('[data-qty]')) return;
    const name = e.target.closest('tr').dataset.name, q = +e.target.value;
    await setOwned(name, q);
    if (S.trade[name] > q) { if (q) S.trade[name] = q; else delete S.trade[name]; }
    if (!q || S.cloud) render();
  });
  $('#col').addEventListener('click', e => {
    const sb = e.target.closest('[data-show]'); if (sb) { viewCollection.show = sb.dataset.show; return render(); }
    const bk = e.target.closest('[data-back]'); if (bk) { returnLoan(bk.dataset.back).then(render); return; }
    const o = e.target.closest('[data-open]'); if (o) cardModal(o.closest('tr').dataset.name);
  });
  $('#colImpGo').onclick = async () => {
    const list = parseList($('#colImp').value, 'commander');
    if (!list.length) return;
    await ensureCards(list.map(c => c.name)).catch(() => {});
    const body = {};
    for (const c of list) {
      const hit = S.cards[c.name] || Object.values(S.cards).find(x => x.name.toLowerCase() === c.name.toLowerCase());
      const n = hit ? hit.name : c.name;
      body[n] = (body[n] ?? (S.collection[n] || 0)) + c.qty;
      (S.colmeta[n] = S.colmeta[n] || { prints: [] }).added = Date.now();
    }
    Object.assign(S.collection, body);
    await api('/api/collection', { method: 'PUT', body });
    toast(`Lade till ${list.reduce((a, c) => a + c.qty, 0)} kort`); render();
  };
}

// --- Inställningar ---
function viewSettings() {
  setNav('installningar');
  $('#app').innerHTML = `<div class="card" style="max-width:640px"><h1>Inställningar</h1>
    <h3>Utseende</h3>
    <div class="seg" id="themeSeg" role="group" aria-label="Tema">${[['auto', 'Som telefonen'], ['light', '☀️ Ljust'], ['dark', '🌙 Mörkt']].map(([k, l]) => `<button data-theme-set="${k}" class="${themeNow() === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    ${S.cloud ? `<h3>Ditt namn</h3>
    <p class="small muted">Syns för andra inloggade på dina publika lekar och i bytesbörsen. Inloggad som ${esc(S.profile.email || '')}.</p>
    <div class="row"><input type="text" id="dispName" maxlength="40" placeholder="T.ex. Jonte" style="flex:1" value="${esc(S.profile.name || '')}"><button class="btn primary" id="saveName">Spara namn</button></div>` : ''}
    ${S.cloud && S.v8 ? `<h3>Bytesförslag</h3>
    <label class="small row"><input type="checkbox" id="shareWants" ${S.profile.wants ? 'checked' : ''}> Visa vad jag saknar för den som har kortet till byte</label>
    <p class="small muted">Den som har ett kort till byte som saknas i dina lekar eller står på din önskelista får se det under Bytesförslag. Inget annat i din samling eller önskelista visas.</p>` : ''}
    <h3>Säkerhetskopia</h3>
    <p class="small muted">Ladda ner lekar, samling, utgåvor, önskelista, utlånat och spellogg som en fil. Spara den i molnet eller på datorn. Inläsning lägger bara till det som saknas.
      ${(t => t ? `Senast nedladdad ${new Date(t).toLocaleDateString('sv-SE')}.` : 'Ingen kopia nedladdad från den här enheten än.')((() => { try { return +localStorage.getItem('lv-backup-at') || 0; } catch { return 0; } })())}</p>
    <div class="row"><button class="btn" id="bkDown">⬇ Ladda ner säkerhetskopia</button><label class="btn">⬆ Läs in fil<input type="file" id="bkFile" accept=".json,application/json" hidden></label></div>
    <h3>Installera som app</h3>
    ${window.matchMedia?.('(display-mode: standalone)').matches ? '<p class="small good">Lekverkstan körs redan som installerad app.</p>'
      : installEvt ? '<p class="small muted">Lägg Lekverkstan på hemskärmen. Den startar då som en vanlig app och lekarna går att titta på utan nät.</p><button class="btn primary" id="install">Installera</button>'
      : '<p class="small muted">På iPhone: tryck på Dela-knappen i Safari och välj <b>Lägg till på hemskärmen</b>. På Android: öppna menyn i Chrome och välj <b>Installera app</b> eller <b>Lägg till på startskärmen</b>.</p>'}
    <h3>Priser</h3>
    <div class="seg" id="priceSeg" role="group" aria-label="Prisnivå">${[['butik', 'Svensk butik'], ['cm', 'Cardmarket']].map(([k, l]) => `<button data-price-set="${k}" class="${S.priceLevel === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <p class="small muted">Priserna kommer från Cardmarket via Scryfall och gäller billigaste utgåvan, eller den utgåva du angett i samlingen. De räknas om till kronor med dagens kurs, 1 € = ${S.rate.toLocaleString('sv-SE')} kr.
      <b>Svensk butik</b> lägger på 30 %, ungefär vad Alara tar mer för samma utgåva. <b>Cardmarket</b> visar vad korten kostar där, utan frakt. Priserna hämtas om var tredje dag.</p>
    <h3>Prislarm</h3>
    <label class="small">Säg till när ett kort jag äger stiger, eller ett önskekort blir billigare, med minst
      <select id="alarmSel">${[[0, 'Av'], [15, '15 %'], [25, '25 %'], [50, '50 %']].map(([v, l]) => `<option value="${v}" ${alarmPct() === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    <p class="small muted">Larmen syns i klockan. ${S.v7 ? `Kort du äger jämförs med värdet för en vecka sedan och måste ha stigit minst ${ALARM_MIN_KR} kr. ` : ''}Önskekort jämförs med det högsta priset sedan du senast markerade larmet som läst.</p>
    <p class="small muted">Alara-priser hämtas från butikens öppna sidor, cachas i 6 timmar och visar bara varianter som finns i lager. Cardmarket har inget öppet API för privatpersoner, därför används en önskelista plus deras egen Shopping Wizard.</p>
  </div>`;
  $('#themeSeg').onclick = e => { const b = e.target.closest('[data-theme-set]'); if (b) { setTheme(b.dataset.themeSet); render(); } };
  $('#alarmSel').onchange = e => { try { localStorage.setItem('lv-alarm', String(+e.target.value)); } catch {} updateBell(); };
  $('#bkDown').onclick = () => { downloadBackup(); toast('Säkerhetskopian laddas ner'); setTimeout(render, 300); };
  $('#bkFile').onchange = e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) restoreFile(f); };
  $('#priceSeg').onclick = e => {
    const b = e.target.closest('[data-price-set]'); if (!b) return;
    S.priceLevel = b.dataset.priceSet; try { localStorage.setItem('lv-price', S.priceLevel); } catch {}
    render();
  };
  if ($('#install')) $('#install').onclick = async () => { installEvt.prompt(); await installEvt.userChoice.catch(() => {}); installEvt = null; render(); };
  if ($('#shareWants')) $('#shareWants').onchange = async e => {
    if (!S.profile.name) { e.target.checked = false; return toast('Sätt ditt namn först', 3500); }
    try { await api('/api/profile', { method: 'PUT', body: { name: S.profile.name, wants: e.target.checked } }); S.profile.wants = e.target.checked; toast(e.target.checked ? 'Kompisar med kort till byte ser nu vad du saknar' : 'Det du saknar delas inte längre'); }
    catch (err) { e.target.checked = !e.target.checked; toast('Kunde inte spara: ' + err.message, 4000); }
  };
  if ($('#saveName')) $('#saveName').onclick = async () => {
    const name = $('#dispName').value.trim();
    if (!name) return toast('Skriv ett namn');
    try { await api('/api/profile', { method: 'PUT', body: { name } }); S.profile.name = name; toast('Namnet är sparat'); }
    catch (e) { toast('Kunde inte spara: ' + e.message, 4000); }
  };
}

// ---------- delat: bytesbörs och publika lekar ----------
async function loadTrades(force) {
  if (!S.cloud) { S.trades = []; return; }
  if (S.trades && !force && Date.now() - loadTrades.at < 120000) return;
  S.trades = await api('/api/trades').catch(() => []);
  loadTrades.at = Date.now();
}
function tradeIndex() {
  const idx = {};
  for (const t of S.trades || []) (idx[t.name.toLowerCase()] = idx[t.name.toLowerCase()] || []).push(t);
  return idx;
}
async function loadPublic(force) {
  if (!S.cloud) { S.publicDecks = []; return; }
  if (S.publicDecks && !force && Date.now() - loadPublic.at < 120000) return;
  S.publicDecks = await api('/api/public-decks').catch(() => []);
  loadPublic.at = Date.now();
}
const deckTotal = d => d.cards.filter(c => c.board === 'main' || c.board === 'commander').reduce((a, c) => a + c.qty, 0);
const deckValue = d => d.cards.filter(c => c.board !== 'maybe').reduce((a, c) => a + (cardVal(c.name, c.qty) || 0), 0);
// kort som flera lekar behöver men där samlingen inte räcker till alla samtidigt: { namn: { own, sum, decks: [{ id, name, qty }] } }
function sharedShortage() {
  const need = {};
  for (const d of S.decks) for (const c of d.cards) {
    if (c.board === 'maybe') continue;
    const per = (need[c.name] = need[c.name] || {});
    (per[d.id] = per[d.id] || { id: d.id, name: d.name, qty: 0 }).qty += c.qty;
  }
  const out = {};
  for (const [n, per] of Object.entries(need)) {
    const decks = Object.values(per);
    if (decks.length < 2 || (S.basicsOwned && BASICS.has(n)) || S.cards[n]?.any_number) continue;
    const sum = decks.reduce((a, x) => a + x.qty, 0), own = owned(n) - lentQty(n);
    if (own > 0 && own < sum) out[n] = { own, sum, decks };
  }
  return out;
}
// lekens kort som saknas för att ex sitter i ihopbyggda lekar
function takenCards(deck) {
  return missingCards(deck).filter(m => owned(m.name) > free(m.name, deck)).map(m => {
    const where = builtIn(m.name).map(x => x.name).join(', ');
    return { name: m.name, where, text: `${m.name} sitter i ${where}` };
  }).sort((a, b) => a.name.localeCompare(b.name));
}
// andel av lekens kort (exkl. kanske) som finns i samlingen
function ownedShare(d) {
  let need = 0, have = 0;
  for (const c of d.cards) if (c.board !== 'maybe') { need += c.qty; have += Math.min(c.qty, free(c.name, d)); }
  return need ? have / need : 1;
}
function deckArt(d) {
  const c = d.cards.find(x => x.board === 'commander') || d.cards.find(x => x.board === 'main' && mainType(S.cards[x.name]) !== 'Land');
  return c && S.cards[c.name]?.image;
}

function viewExplore(sub) {
  setNav('utforska');
  const tabs = [['lekar', 'Publika lekar'], ['byte', 'Bytesbörs'], ['forslag', 'Bytesförslag'], ...(S.v4 ? [['bokningar', 'Bokningar' + (bookingAlerts() ? ` <span class="badge">${bookingAlerts()}</span>` : '')]] : [])];
  sub = ['byte', 'forslag', 'bokningar'].includes(sub) ? sub : 'lekar';
  $('#app').innerHTML = `<div class="row"><h1>Utforska</h1><span class="spacer"></span><button class="btn small" id="reload">↻ Uppdatera</button></div>
    <div class="tabs">${tabs.map(([k, l]) => `<a class="${k === sub ? 'on' : ''}" href="#/utforska/${k}">${l}</a>`).join('')}</div><div id="ex"></div>`;
  $('#reload').onclick = async () => { await Promise.all([loadPublic(true), loadTrades(true), loadBookings(true), loadWants(true)]); render(); };
  const ex = $('#ex');
  if (!S.cloud) { ex.innerHTML = '<div class="card empty">Utforska finns bara i molnversionen.</div>'; return; }
  if (sub === 'lekar') {
    if (!S.publicDecks) { ex.innerHTML = '<p class="muted">Hämtar…</p>'; loadPublic().then(async () => { await ensureCards(S.publicDecks.flatMap(d => d.cards.filter(c => c.board !== 'side' && c.board !== 'maybe').map(c => c.name))).catch(() => {}); render(); }); return; }
    ex.innerHTML = S.publicDecks.length ? `<div class="deck-grid">${S.publicDecks.map(d => {
      const art = deckArt(d), share = ownedShare(d);
      return `<a class="card deck-tile" href="#/publik/${d.id}"><div class="art" style="${art ? `background-image:url('${esc(art).replace(/'/g, '%27')}')` : ''}"></div>
        <div class="body"><b>${esc(d.name)}</b><div class="muted small">av ${esc(d.ownerName)}</div>
        <div class="row small" style="margin-top:.3rem"><span class="pill">${FORMAT_SV[d.format]}</span><span class="pill">${deckTotal(d)} kort</span></div>
        <div class="ownbar" title="Du äger ${Math.round(share * 100)} % av korten"><div style="width:${share * 100}%"></div></div><div class="muted small">Du äger ${Math.round(share * 100)} %</div></div></a>`;
    }).join('')}</div>` : '<div class="card empty">Inga publika lekar än. Bocka i <b>Publik</b> på en av dina lekar så syns den här för alla.</div>';
    return;
  }
  if (sub === 'bokningar') return tabBookings(ex);
  if (sub === 'forslag') return tabTradeIdeas(ex);
  // bytesbörs
  if (!S.trades || !S.bookings) {
    ex.innerHTML = '<p class="muted">Hämtar…</p>';
    Promise.all([loadTrades(), loadBookings()]).then(async () => { await ensureCards(S.trades.map(t => t.name)).catch(() => {}); render(); });
    return;
  }
  const need = {};
  for (const d of S.decks) for (const m of missingCards(d)) (need[m.name.toLowerCase()] = need[m.name.toLowerCase()] || new Set()).add(d.name);
  const opt = viewExplore.opt || (viewExplore.opt = { onlyNeed: true, q: '' });
  const rows = S.trades.filter(t => (!opt.onlyNeed || need[t.name.toLowerCase()]) && (!opt.q || t.name.toLowerCase().includes(opt.q.toLowerCase())))
    .sort((a, b) => a.name.localeCompare(b.name) || a.ownerName.localeCompare(b.ownerName));
  const mine = Object.keys(S.trade).length;
  // min senaste aktiva bokning på just den användarens kort
  const myBooking = t => S.bookings.find(b => b.mine && b.seller === t.owner && b.name === t.name && ['requested', 'accepted'].includes(b.status));
  ex.innerHTML = `<div class="card">
    <div class="row"><label class="small"><input type="checkbox" id="onlyNeed" ${opt.onlyNeed ? 'checked' : ''}> Bara kort som saknas i mina lekar</label>
      <span class="spacer"></span><input type="search" id="tq" placeholder="Sök kort…" value="${esc(opt.q)}" style="width:200px"></div>
    ${rows.length ? `<div class="table-scroll"><table><thead><tr><th>Kort</th><th>Har till byte</th><th class="num">Antal</th><th class="num" title="${priceWhat()}">Pris ca</th><th>Behövs i</th>${S.v4 ? '<th></th>' : ''}</tr></thead><tbody>
      ${rows.map((t, i) => {
        const foil = (t.prints || []).filter(p => p.foil), b = S.v4 && myBooking(t);
        return `<tr><td><span data-img="${esc(S.cards[t.name]?.image || scryImg(t.name))}">${esc(t.name)}</span>${foil.length ? ` <span class="foil" title="Har foil: ${esc(foil.map(printLabel).join(', '))}">✦</span>` : ''}</td><td>${esc(t.ownerName)}</td><td class="num">${t.qty}</td>
        <td class="num small">${krE(S.cards[t.name]?.eur)}</td>
        <td class="small muted">${need[t.name.toLowerCase()] ? esc([...need[t.name.toLowerCase()]].join(', ')) : ''}</td>
        ${S.v4 ? `<td>${b ? `<span class="pill ${b.status === 'accepted' ? 'good' : ''}">${BOOK_SV[b.status]}</span>` : `<button class="btn small" data-book="${i}">Boka</button>`}</td>` : ''}</tr>`;
      }).join('')}</tbody></table></div>`
      : `<p class="muted">${S.trades.length ? 'Inga träffar med de filtren.' : 'Ingen har markerat kort till byte än.'}</p>`}
    <p class="muted small">Priset är ungefärligt för billigaste utgåvan, ✦ betyder att ägaren har foil. ${S.v4 ? 'Boka ett kort så ser ägaren det under Bokningar och kan svara. ' : ''}Du har ${mine} olika kort markerade till byte. Markera dina under <a href="#/samling">Samling</a>, och sätt ditt namn under <a href="#/installningar">Inställningar</a> så att andra ser vem du är.</p></div>`;
  $('#onlyNeed').onchange = e => { opt.onlyNeed = e.target.checked; render(); };
  $('#tq').oninput = e => { opt.q = e.target.value; clearTimeout(viewExplore.t); viewExplore.t = setTimeout(() => { render(); const i = $('#tq'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 250); };
  ex.addEventListener('click', e => { const b = e.target.closest('[data-book]'); if (b) bookModal(rows[+b.dataset.book]); });
}

// ---------- bytesförslag: vad du kan få och ge, per person ----------
async function loadWants(force) {
  if (!S.cloud || !S.v8) { S.wants = []; return; }
  if (S.wants && !force && Date.now() - loadWants.at < 120000) return;
  S.wants = await api('/api/trade-wants').catch(() => S.wants || []);
  loadWants.at = Date.now();
}
function tradeIdeas() {
  const need = {}, bump = (n, q) => { const k = n.toLowerCase(); need[k] = Math.max(need[k] || 0, q); };
  for (const d of S.decks) for (const m of missingCards(d)) bump(m.name, m.missing);
  for (const w of S.wishlist) bump(w.name, w.qty || 1);
  const mine = Object.fromEntries(Object.entries(S.trade).map(([n, q]) => [n.toLowerCase(), { name: n, q }]));
  const people = {}, P = (id, name) => (people[id] = people[id] || { id, name, get: [], give: [] });
  for (const t of S.trades || []) { const n = need[t.name.toLowerCase()]; if (n && !(S.basicsOwned && BASICS.has(t.name))) P(t.owner, t.ownerName).get.push({ t, name: t.name, qty: Math.min(n, t.qty) }); }
  for (const w of S.wants || []) { const m = mine[String(w.name).toLowerCase()]; if (m && !BASICS.has(m.name)) P(w.owner, w.player).give.push({ name: m.name, qty: Math.min(m.q, w.qty), src: w.src }); }
  const val = l => l.reduce((a, x) => a + (S.cards[x.name]?.eur || 0) * x.qty, 0);
  return Object.values(people).map(p => ({ ...p, getVal: val(p.get), giveVal: val(p.give) }))
    .sort((x, y) => (Math.min(y.get.length, 1) + Math.min(y.give.length, 1)) - (Math.min(x.get.length, 1) + Math.min(x.give.length, 1)) || (y.getVal + y.giveVal) - (x.getVal + x.giveVal));
}
function tabTradeIdeas(ex) {
  if (!S.trades || !S.bookings || !S.wants) {
    ex.innerHTML = '<p class="muted">Hämtar…</p>';
    Promise.all([loadTrades(), loadBookings(), loadWants()]).then(async () => { await ensureCards([...S.trades.map(t => t.name), ...S.wants.map(w => w.name)]).catch(() => {}); render(); });
    return;
  }
  const list = tradeIdeas();
  const myBooking = t => S.bookings.find(b => b.mine && b.seller === t.owner && b.name === t.name && ['requested', 'accepted'].includes(b.status));
  const books = [];
  const balance = p => {
    if (!p.get.length) return 'Du har kort som hen saknar. Hen har inget till byte som du behöver just nu.';
    if (!p.give.length) return S.v8 ? 'Hen har kort du behöver, men saknar inget av det du har till byte.' : '';
    const d = sek(p.getVal) - sek(p.giveVal);
    return Math.abs(d) <= Math.max(10, 0.15 * sek(Math.max(p.getVal, p.giveVal))) ? '<b class="good">Ungefär jämnt byte.</b>' : d > 0 ? `Du får ca <b>${krE(p.getVal - p.giveVal)}</b> mer, lägg till något från din byteslista.` : `Du ger ca <b>${krE(p.giveVal - p.getVal)}</b> mer.`;
  };
  const item = x => `<li><span data-img="${esc(S.cards[x.name]?.image || scryImg(x.name))}">${x.qty > 1 ? x.qty + ' ' : ''}${esc(x.name)}</span> <span class="muted">${krE(S.cards[x.name]?.eur != null ? S.cards[x.name].eur * x.qty : null)}</span>${x.src ? ` <span class="muted small">(${esc(x.src.split(',').map(s => s === 'lek' ? 'saknas i en lek' : 'önskelista').join(', '))})</span>` : ''}${x.t && S.v4 ? (b => b ? ` <span class="pill ${b.status === 'accepted' ? 'good' : ''}">${BOOK_SV[b.status]}</span>` : ` <button class="btn small" data-tbook="${books.push(x.t) - 1}">Boka</button>`)(myBooking(x.t)) : ''}</li>`;
  const tips = [
    !Object.keys(S.trade).length && 'Markera kort till byte under <a href="#/samling">Samling</a>, så kan andra se vad du har.',
    S.v8 && !S.profile.wants && 'Slå på <b>Visa vad jag saknar</b> under <a href="#/installningar">Inställningar</a>, så ser kompisarna vad de kan ge dig.',
    !S.v8 && 'Vad du kan ge andra visas när databasen har uppdaterats.',
  ].filter(Boolean);
  ex.innerHTML = `${list.length ? list.map(p => `<div class="card trade-idea" style="margin-bottom:1rem"><h2>${esc(p.name)}</h2>
      <div class="grid cols-2">
        <div><h3>Du kan få <span class="muted small">${p.get.length ? 'ca ' + krE(p.getVal) : ''}</span></h3>${p.get.length ? `<ul class="small">${p.get.map(item).join('')}</ul>` : '<p class="muted small">Inget du behöver just nu.</p>'}</div>
        <div><h3>Du kan ge <span class="muted small">${p.give.length ? 'ca ' + krE(p.giveVal) : ''}</span></h3>${p.give.length ? `<ul class="small">${p.give.map(item).join('')}</ul>` : `<p class="muted small">${S.v8 ? 'Inget av det du har till byte, eller så delar hen inte vad hen saknar.' : '–'}</p>`}</div>
      </div><p class="small" style="margin-bottom:0">${balance(p)}</p></div>`).join('')
    : '<div class="card empty">Inga förslag än. Förslagen bygger på kort som saknas i era lekar och på önskelistorna, och på vad var och en har markerat till byte.</div>'}
    <p class="muted small">Du kan få: kort andra har till byte som saknas i dina lekar eller står på din önskelista. Du kan ge: kort du har till byte som någon saknar, om hen delar det. Priserna är ${priceWhat()}.</p>
    ${tips.map(t => `<p class="small">${t}</p>`).join('')}`;
  ex.onclick = e => { const b = e.target.closest('[data-tbook]'); if (b) bookModal(books[+b.dataset.tbook]); };
}

// ---------- bokningar i bytesbörsen ----------
const BOOK_SV = { requested: 'Väntar på svar', accepted: 'Godkänd', declined: 'Nekad', done: 'Klar', cancelled: 'Ångrad' };
async function refreshCollection() {
  const st = await api('/api/state').catch(() => null);
  if (st) Object.assign(S, { collection: st.collection, colmeta: st.colmeta, trade: st.trade });
}
async function loadBookings(force) {
  if (!S.cloud || !S.v4) { S.bookings = []; return; }
  if (S.bookings && !force && Date.now() - loadBookings.at < 60000) return;
  S.bookings = await api('/api/bookings').catch(() => S.bookings || []);
  loadBookings.at = Date.now();
  // en godkänd bokning flyttar kort mellan samlingarna i databasen: hämta om min samling när något flyttats
  const sig = S.bookings.filter(b => b.moved).map(b => b.id).sort().join();
  if (loadBookings.sig != null && sig !== loadBookings.sig) await refreshCollection();
  loadBookings.sig = sig;
  updateBookBadge();
}
// nya förfrågningar på mina kort + svar på mina bokningar som jag inte sett
function bookingAlerts() {
  let seen = 0; try { seen = +localStorage.getItem('lv-book-seen') || 0; } catch {}
  return (S.bookings || []).filter(b => (!b.mine && b.status === 'requested') || (b.mine && ['accepted', 'declined', 'done'].includes(b.status) && Date.parse(b.updated) > seen)).length;
}
function updateBookBadge() {
  const a = $('[data-nav=utforska]'); if (!a) return;
  const n = bookingAlerts();
  a.innerHTML = `Utforska${n ? ` <span class="badge">${n}</span>` : ''}`;
  updateBell();
}
function bookModal(t) {
  openModal(`<div class="row"><h2 style="margin:0">Boka ${esc(t.name)}</h2><span class="spacer"></span><button class="icon-btn" data-close aria-label="Stäng">✕</button></div>
    <p class="small muted">${esc(t.ownerName)} har ${t.qty} ex till byte · ca ${krE(S.cards[t.name]?.eur)}/st. Ägaren ser din bokning och kan godkänna eller neka den.</p>
    <p class="row"><label class="small">Antal <input type="number" id="bkQty" min="1" max="${t.qty}" value="1" style="width:4rem"></label></p>
    <p><input type="text" id="bkNote" maxlength="300" placeholder="Meddelande, t.ex. vad du kan byta med eller när ni ses" style="width:100%"></p>
    <div class="row"><span class="spacer"></span><button class="btn primary" id="bkGo">Boka</button></div>`, box => {
    $('#bkGo', box).onclick = async () => {
      try {
        const b = await api('/api/bookings', { method: 'POST', body: { seller: t.owner, name: t.name, qty: Math.max(1, Math.min(t.qty, +$('#bkQty', box).value || 1)), note: $('#bkNote', box).value.trim() } });
        S.bookings.unshift({ ...b, other: t.ownerName });
        closeModal(); toast(`Bokat hos ${t.ownerName}`); render();
      } catch (e) { toast('Kunde inte boka: ' + e.message, 4000); }
    };
  });
}
function tabBookings(ex) {
  if (!S.bookings) { ex.innerHTML = '<p class="muted">Hämtar…</p>'; loadBookings().then(render); return; }
  markBookingsSeen();
  const open = b => ['requested', 'accepted'].includes(b.status);
  const inc = S.bookings.filter(b => !b.mine), out = S.bookings.filter(b => b.mine);
  const sortB = a => a.slice().sort((x, y) => open(y) - open(x) || Date.parse(y.updated) - Date.parse(x.updated));
  const row = b => `<tr data-id="${esc(b.id)}" class="${!b.mine && b.status === 'requested' ? 'alert' : ''}">
    <td><span data-img="${esc(S.cards[b.name]?.image || scryImg(b.name))}">${esc(b.name)}</span> <span class="muted">× ${b.qty}</span>
      ${b.note ? `<div class="small">”${esc(b.note)}”</div>` : ''}${b.reply ? `<div class="small muted">Svar: ”${esc(b.reply)}”</div>` : ''}</td>
    <td>${esc(b.other)}</td><td><span class="pill ${b.status === 'accepted' || b.status === 'done' ? 'good' : ''}">${BOOK_SV[b.status]}</span>${b.moved ? `<div class="small good">${b.mine ? 'Ligger i din samling' : 'Flyttad från din samling'}</div>` : ''}<div class="muted small">${new Date(b.updated).toLocaleDateString('sv-SE')}</div></td>
    <td class="num">${b.mine
      ? (open(b) ? '<button class="btn small" data-bs="cancelled">Ångra</button>' : `${b.status === 'done' && !b.moved ? '<button class="btn small" data-bown>+ Samlingen</button> ' : ''}<button class="icon-btn" data-bdel title="Ta bort">✕</button>`)
      : b.status === 'requested' ? '<button class="btn small primary" data-bs="accepted">Godkänn</button> <button class="btn small" data-bs="declined">Neka</button>'
      : b.status === 'accepted' ? '<button class="btn small primary" data-bs="done">Överlämnat ✓</button> <button class="btn small" data-bs="declined">Neka</button>'
      : '<button class="icon-btn" data-bdel title="Ta bort">✕</button>'}</td></tr>`;
  const table = (list, who) => list.length ? `<div class="table-scroll"><table><thead><tr><th>Kort</th><th>${who}</th><th>Status</th><th></th></tr></thead><tbody>${sortB(list).map(row).join('')}</tbody></table></div>` : '';
  ex.innerHTML = `<div class="card"><h2>Förfrågningar på mina kort</h2>${table(inc, 'Från') || '<p class="muted">Ingen har bokat dina kort än.</p>'}</div>
    <div class="card"><h2>Mina bokningar</h2>${table(out, 'Hos') || '<p class="muted">Du har inte bokat något. Boka kort under <a href="#/utforska/byte">Bytesbörs</a>.</p>'}</div>
    <p class="muted small">Bara du och den andra ser en bokning. När du godkänner en bokning flyttas korten från din samling till den som bokade. Nekar eller ångrar någon efteråt flyttas de tillbaka.</p>`;
  updateBookBadge();
  ex.addEventListener('click', async e => {
    const tr = e.target.closest('tr[data-id]'); if (!tr) return;
    const b = S.bookings.find(x => x.id === tr.dataset.id);
    try {
      const s = e.target.closest('[data-bs]');
      if (s) {
        const status = s.dataset.bs;
        let reply;
        if (!b.mine && (status === 'accepted' || status === 'declined')) { reply = prompt(status === 'accepted' ? ('moved' in b ? `${b.qty} ex ${b.name} flyttas från din samling till ${b.other} när du godkänner. ` : '') + 'Svar till ' + b.other + ' (valfritt), t.ex. när ni kan ses:' : ('moved' in b && b.moved ? 'Kortet flyttas tillbaka till din samling. ' : '') + 'Varför? (valfritt)', b.reply || ''); if (reply === null) return; }
        if (status === 'cancelled' && !confirm(`Ångra bokningen av ${b.name}?${b.moved ? ' Kortet går tillbaka till ' + b.other + '.' : ''}`)) return;
        const was = b.moved;
        Object.assign(b, await api('/api/bookings/' + b.id, { method: 'PUT', body: { status, ...(reply != null ? { reply } : {}) } }));
        if (b.moved !== was && 'moved' in b) {
          await refreshCollection(); loadBookings.sig = S.bookings.filter(x => x.moved).map(x => x.id).sort().join();
          toast(b.moved ? `${b.qty} ex ${b.name} flyttades till ${b.other}` : `${b.name} flyttades tillbaka`, 3500);
        }
        if (status === 'done' && !b.moved && S.collection[b.name] && confirm(`Ta bort ${b.qty} ex ${b.name} ur din samling?`)) {
          const left = Math.max(0, S.collection[b.name] - b.qty), tr2 = Math.min(S.trade[b.name] || 0, left);
          await setOwned(b.name, left);
          if ((S.trade[b.name] || 0) !== tr2) { await api('/api/trade', { method: 'PUT', body: { [b.name]: tr2 } }); if (tr2) S.trade[b.name] = tr2; else delete S.trade[b.name]; }
        }
        return render();
      }
      if (e.target.closest('[data-bown]')) { await setOwned(b.name, (S.collection[b.name] || 0) + b.qty); toast(`+${b.qty} ${b.name} i samlingen`); }
      if (e.target.closest('[data-bown]') || e.target.closest('[data-bdel]')) {
        await api('/api/bookings/' + b.id, { method: 'DELETE' });
        S.bookings = S.bookings.filter(x => x !== b); render();
      }
    } catch (err) { toast('Det gick inte: ' + err.message, 4000); }
  });
}

// ---------- jämför två lekar ----------
const findDeck = id => S.decks.find(d => d.id === id) || (S.publicDecks || []).find(d => d.id === id);
async function compareModal(deck) {
  if (S.cloud && !S.publicDecks) await loadPublic().catch(() => {});
  const others = [...S.decks.filter(d => d.id !== deck.id).map(d => ({ id: d.id, label: d.name, sub: FORMAT_SV[d.format] })),
    ...(S.publicDecks || []).filter(d => d.id !== deck.id && !S.decks.some(x => x.id === d.id)).map(d => ({ id: d.id, label: d.name, sub: 'av ' + d.ownerName }))];
  if (!others.length) return toast('Det finns ingen annan lek att jämföra med');
  const mine = S.decks.some(d => d.id === deck.id);
  openModal(`<div class="row"><h2 style="margin:0">Jämför ${esc(deck.name)} med…</h2><span class="spacer"></span><button class="icon-btn" data-close aria-label="Stäng">✕</button></div>
    <div class="grid" style="margin-top:.6rem">${others.map(o => `<a class="btn" style="justify-content:space-between" href="#/jamfor/${mine ? deck.id : o.id}/${mine ? o.id : deck.id}"><span>${esc(o.label)}</span><span class="muted small">${esc(o.sub)}</span></a>`).join('')}</div>`,
    box => { box.onclick = e => { if (e.target.closest('a')) closeModal(); }; });
}
function deckSummary(d) {
  const play = d.cards.filter(c => c.board === 'main' || c.board === 'commander');
  const isLand = c => mainType(S.cards[c.name]) === 'Land';
  const curve = Array(8).fill(0);
  let sum = 0, n = 0;
  for (const c of play.filter(c => !isLand(c))) { const v = Math.round(S.cards[c.name]?.cmc || 0); curve[Math.min(7, v)] += c.qty; sum += v * c.qty; n += c.qty; }
  const ident = new Set(play.flatMap(c => S.cards[c.name]?.color_identity || []));
  const names = new Map();
  for (const c of play) names.set(c.name, (names.get(c.name) || 0) + c.qty);
  return { total: play.reduce((a, c) => a + c.qty, 0), lands: play.filter(isLand).reduce((a, c) => a + c.qty, 0), avg: n ? sum / n : 0, curve,
    roles: roleCounts(d), value: deckValue(d), share: ownedShare(d), bracket: d.format === 'commander' ? bracketInfo(d).b : null, colors: WUBRG.filter(c => ident.has(c)), names };
}
function viewCompare(aId, bId) {
  setNav('lekar');
  const A = findDeck(aId), B = findDeck(bId);
  if ((!A || !B) && S.cloud && !S.publicDecks) { $('#app').innerHTML = '<p class="muted">Hämtar…</p>'; loadPublic().then(render); return; }
  if (!A || !B) { $('#app').innerHTML = '<div class="empty">Någon av lekarna finns inte längre. <a href="#/">Tillbaka</a></div>'; return; }
  const unknown = [...A.cards, ...B.cards].map(c => c.name).filter(n => !S.cards[n] && !S.notFound.has(n));
  if (unknown.length && !viewCompare.loading) { viewCompare.loading = true; ensureCards(unknown).catch(() => {}).finally(() => { viewCompare.loading = false; render(); }); }
  const a = deckSummary(A), b = deckSummary(B);
  const link = d => S.decks.some(x => x.id === d.id) ? '#/lek/' + d.id : '#/publik/' + d.id;
  const pips = cs => cs.length ? cs.map(c => `<span class="sym ${c}">${c}</span>`).join('') : '<span class="muted">färglös</span>';
  const row = (label, x, y, fmt = v => v, better) => {
    const w = better && x !== y ? (better(x, y) ? 'a' : 'b') : '';
    return `<tr><td>${label}</td><td class="num ${w === 'a' ? 'good' : ''}">${fmt(x)}</td><td class="num ${w === 'b' ? 'good' : ''}">${fmt(y)}</td></tr>`;
  };
  const max = Math.max(1, ...a.curve, ...b.curve);
  const curve = `<div class="cmpcurve">${a.curve.map((v, i) => `<div><div class="bars"><span class="a" style="height:${v / max * 100}%" title="${esc(A.name)}: ${v} kort"></span><span class="b" style="height:${b.curve[i] / max * 100}%" title="${esc(B.name)}: ${b.curve[i]} kort"></span></div><small>${i === 7 ? '7+' : i}</small></div>`).join('')}</div>`;
  const onlyA = [...a.names].filter(([n]) => !b.names.has(n)), onlyB = [...b.names].filter(([n]) => !a.names.has(n)), both = [...a.names].filter(([n]) => b.names.has(n));
  const list = (l, other) => l.length ? `<ul class="small cmplist">${l.sort((x, y) => x[0].localeCompare(y[0])).map(([n, q]) => `<li><span data-img="${esc(S.cards[n]?.image || '')}">${q > 1 ? q + ' ' : ''}${esc(n)}</span>${other && other.get(n) !== q ? ` <span class="muted">(${other.get(n)} i den andra)</span>` : ''}</li>`).join('')}</ul>` : '<p class="muted small">Inga.</p>';
  const roleKeys = Object.keys(a.roles);
  $('#app').innerHTML = `<div class="row"><a href="#/" class="icon-btn" aria-label="Tillbaka">←</a><h1 style="margin:0">Jämför lekar</h1></div>
    <div class="grid cols-2" style="margin-top:1rem">
      <div class="card"><table><thead><tr><th></th><th class="num"><span class="dot a"></span> <a href="${link(A)}">${esc(A.name)}</a></th><th class="num"><span class="dot b"></span> <a href="${link(B)}">${esc(B.name)}</a></th></tr></thead><tbody>
        ${row('Format', FORMAT_SV[A.format], FORMAT_SV[B.format])}
        ${row('Färger', a.colors, b.colors, pips)}
        ${row('Kort', a.total, b.total)}
        ${row('Länder', a.lands, b.lands)}
        ${row('Snitt-manavärde', a.avg, b.avg, v => v ? v.toFixed(2) : '–', (x, y) => x < y)}
        ${a.bracket || b.bracket ? row('Bracket, ungefär', a.bracket, b.bracket, v => v ?? '–') : ''}
        ${row('Värde', a.value, b.value, krE)}
        ${row('Du äger', a.share, b.share, v => Math.round(v * 100) + ' %', (x, y) => x > y)}
        ${roleKeys.filter(k => k !== 'Länder' && (a.roles[k] || b.roles[k])).map(k => row(k, a.roles[k], b.roles[k])).join('')}
      </tbody></table>
      <p class="muted small">Grönt visar vilken lek som har lägst manavärde och störst del av korten i din samling.</p></div>
      <div class="card"><h2>Manakurva <span class="muted small">(icke-länder)</span></h2>${curve}
        <p class="small"><span class="dot a"></span> ${esc(A.name)} &nbsp; <span class="dot b"></span> ${esc(B.name)}</p></div>
    </div>
    <div class="grid cols-3" style="margin-top:1rem">
      <div class="card"><h2>Bara i ${esc(A.name)} <span class="muted small">${onlyA.length}</span></h2>${list(onlyA)}</div>
      <div class="card"><h2>I båda <span class="muted small">${both.length}</span></h2>${list(both, b.names)}</div>
      <div class="card"><h2>Bara i ${esc(B.name)} <span class="muted small">${onlyB.length}</span></h2>${list(onlyB)}</div>
    </div>`;
}

function viewPublicDeck(id) {
  setNav('utforska');
  if (!S.publicDecks) { $('#app').innerHTML = '<p class="muted">Hämtar…</p>'; loadPublic().then(render); return; }
  const d = S.publicDecks.find(x => x.id === id);
  if (!d) { $('#app').innerHTML = '<div class="empty">Leken finns inte längre eller är inte publik. <a href="#/utforska">Tillbaka</a></div>'; return; }
  const unknown = d.cards.map(c => c.name).filter(n => !S.cards[n] && !S.notFound.has(n));
  if (unknown.length && !viewPublicDeck.loading) { viewPublicDeck.loading = true; ensureCards(unknown).catch(() => {}).finally(() => { viewPublicDeck.loading = false; render(); }); }
  const groups = {};
  for (const c of d.cards) { const k = c.board === 'main' ? mainType(S.cards[c.name]) : c.board === 'commander' ? 'Commander' : c.board; (groups[k] = groups[k] || []).push(c); }
  const order = ['Commander', ...TYPE_ORDER, 'Other', 'side', 'maybe'];
  const miss = missingCards(d);
  $('#app').innerHTML = `<div class="row"><a href="#/utforska" class="icon-btn" aria-label="Tillbaka">←</a><div style="flex:1"><h1>${esc(d.name)}</h1><div class="muted small">${FORMAT_SV[d.format]} · av ${esc(d.ownerName)} · ${deckTotal(d)} kort · uppdaterad ${new Date(d.updated).toLocaleDateString('sv-SE')}</div></div>
      ${S.decks.length ? `<button class="btn" id="cmpPub">Jämför med min lek</button>` : ''}<button class="btn primary" id="copyDeck">Kopiera till mina lekar</button></div>
    <div class="grid cols-2" style="margin-top:1rem">
      <div class="card"><div class="cols-cards">${order.filter(k => groups[k]).map(k => `<section><div class="section-head"><h3>${TYPE_SV[k]}</h3><span class="muted small">${groups[k].reduce((a, c) => a + c.qty, 0)}</span></div>
        <ul class="clist">${groups[k].sort((a, b) => (S.cards[a.name]?.cmc ?? 99) - (S.cards[b.name]?.cmc ?? 99) || a.name.localeCompare(b.name)).map(c => {
          const have = free(c.name, d) >= c.qty;
          return `<li class="${have ? 'owned' : ''}"><span style="width:1.05rem" class="good">${have ? '✓' : ''}</span><span class="q">${c.qty}</span><span class="nm" data-img="${esc(S.cards[c.name]?.image || '')}">${esc(c.name)}</span><span class="mana">${S.cards[c.name] ? manaHtml(S.cards[c.name].mana_cost) : ''}</span></li>`;
        }).join('')}</ul></section>`).join('')}</div></div>
      <div class="grid" style="align-content:start">
        <div class="card"><h2>Du och leken</h2><p>Du äger <b>${Math.round(ownedShare(d) * 100)} %</b> av korten. ${miss.length ? `Det saknas <b>${miss.reduce((a, m) => a + m.missing, 0)}</b> kort.` : 'Du kan bygga den direkt!'}</p>
          <p class="muted small">✓ = du har kortet i din samling.</p></div>
        ${d.notes ? `<div class="card"><h2>Anteckningar</h2><p style="white-space:pre-wrap">${esc(d.notes)}</p></div>` : ''}
      </div></div>`;
  if ($('#cmpPub')) $('#cmpPub').onclick = () => compareModal(d);
  $('#copyDeck').onclick = async () => {
    const nd = await api('/api/decks', { method: 'POST', body: { name: `${d.name} (från ${d.ownerName})`.slice(0, 80), format: d.format } });
    nd.cards = d.cards.map(c => ({ ...c }));
    await api('/api/decks/' + nd.id, { method: 'PUT', body: nd });
    S.decks.push(nd); toast('Kopierad till dina lekar'); location.hash = '#/lek/' + nd.id;
  };
}

// ---------- spellogg ----------
const RES_SV = { win: 'Vinst', loss: 'Förlust', draw: 'Oavgjort' };
function deckRecord(games) {
  const r = { n: games.length, win: 0, loss: 0, draw: 0 };
  for (const g of games) r[g.result]++;
  r.pct = r.n ? Math.round(r.win / r.n * 100) : 0;
  return r;
}
function viewGames(sub, arg) {
  if (sub === 'analys') return viewAnalysis(arg ? decodeURIComponent(arg) : '');
  sub = S.cloud && S.v7 && ['topplista', 'spelkvall'].includes(sub) ? sub : '';
  if (sub) return viewGroup(sub);
  setNav('matcher');
  const today = new Date().toISOString().slice(0, 10);
  const byDeck = {};
  for (const g of S.games) (byDeck[g.deck_id || 'x:' + g.deck_name] = byDeck[g.deck_id || 'x:' + g.deck_name] || { name: g.deck_name, games: [] }).games.push(g);
  const stats = Object.values(byDeck).map(x => ({ ...x, ...deckRecord(x.games) })).sort((a, b) => b.n - a.n);
  const total = deckRecord(S.games);
  $('#app').innerHTML = `<div id="gm"><div class="row"><h1>Matcher</h1><span class="spacer"></span><span class="muted">${total.n} matcher · ${total.pct} % vinster</span>
      <a class="btn primary" href="#/liv">▶ Livräknare${lifeState()?.players ? ' (pågår)' : ''}</a></div>
    ${gameTabs('')}
    <div class="grid cols-2" style="margin-top:1rem">
      <div class="grid" style="align-content:start">
        <div class="card"><h2>Per lek</h2>${stats.length ? `<table><thead><tr><th>Lek</th><th class="num">Matcher</th><th class="num">V–F–O</th><th class="num">Vinst</th></tr></thead><tbody>
          ${stats.map(s => `<tr><td>${esc(s.name)}</td><td class="num">${s.n}</td><td class="num">${s.win}–${s.loss}–${s.draw}</td><td class="num"><b>${s.pct} %</b></td></tr>`).join('')}</tbody></table>` : '<p class="muted">Inga matcher loggade än.</p>'}</div>
        <div class="card"><h2>Senaste matcherna</h2>${S.games.length ? `<div class="table-scroll"><table><thead><tr><th>Datum</th><th>Lek</th><th>Resultat</th><th>Mot</th><th></th></tr></thead><tbody>
          ${S.games.slice(0, 100).map(g => `<tr><td class="small">${esc(g.played_on)}</td><td>${g.logged_by && !g.deck_id ? `<button class="btn small" data-editg="${esc(g.id)}" title="Loggad av någon annan – välj vilken lek du spelade">Välj lek</button>` : esc(g.deck_name)}</td>
            <td><span class="pill ${g.result === 'win' ? 'good' : g.result === 'loss' ? 'bad' : ''}">${RES_SV[g.result]}</span> <span class="muted small">${g.players} sp.</span></td>
            <td class="small">${esc(g.opponents)}${g.notes ? `<div class="muted">${esc(g.notes)}</div>` : ''}</td>
            <td style="white-space:nowrap"><button class="icon-btn" data-editg="${esc(g.id)}" title="Ändra" aria-label="Ändra matchen">✎</button><button class="icon-btn" data-delg="${esc(g.id)}" title="Ta bort" aria-label="Ta bort matchen">✕</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Här hamnar dina matcher.</p>'}</div>
      </div>
      <div class="card" style="align-self:start"><h2>Logga en match</h2>
        <p><label class="small">Lek<br><select id="gDeck" style="width:100%">${S.decks.slice().sort((a, b) => b.updated - a.updated).map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}<option value="">Annan lek…</option></select></label></p>
        <p id="gOtherWrap" hidden><input type="text" id="gOther" placeholder="Lekens namn" style="width:100%" maxlength="80"></p>
        <p class="row"><label class="small">Datum<br><input type="date" id="gDate" value="${today}"></label>
          <label class="small">Spelare<br><input type="number" id="gPlayers" min="2" max="10" value="4" style="width:5rem"></label></p>
        <div class="seg" id="gRes" style="margin:.4rem 0"><button data-r="win" class="on">Vinst</button><button data-r="loss">Förlust</button><button data-r="draw">Oavgjort</button></div>
        <p><input type="text" id="gOpp" placeholder="Mot vilka? T.ex. Jonte (Atraxa), Kalle (Krenko)" style="width:100%" maxlength="300"></p>
        <p><input type="text" id="gNotes" placeholder="Anteckning (valfritt)" style="width:100%" maxlength="1000"></p>
        <p class="row"><span class="spacer"></span><button class="btn primary" id="gSave">Spara match</button></p>
        <p class="muted small">${S.cloud && S.v7 ? 'Spelloggen är privat om du inte väljer att visa den i Topplistan. Anteckningar syns aldrig.' : 'Spelloggen är privat, ingen annan ser den.'}</p></div>
    </div></div>`;
  let result = 'win';
  $('#gDeck').onchange = e => { $('#gOtherWrap').hidden = !!e.target.value; };
  $('#gDeck').dispatchEvent(new Event('change'));
  $('#gRes').onclick = e => { const b = e.target.closest('[data-r]'); if (!b) return; result = b.dataset.r; $$('#gRes button').forEach(x => x.classList.toggle('on', x === b)); };
  $('#gSave').onclick = async () => {
    const id = $('#gDeck').value, d = S.decks.find(x => x.id === id);
    const deck_name = d ? d.name : $('#gOther').value.trim();
    if (!deck_name) return toast('Skriv lekens namn');
    try {
      const g = await api('/api/games', { method: 'POST', body: { deck_id: d ? d.id : null, deck_name, played_on: $('#gDate').value || today, result, players: +$('#gPlayers').value || 2, opponents: $('#gOpp').value.trim(), notes: $('#gNotes').value.trim() } });
      S.games.unshift(g); S.games.sort((a, b) => (b.played_on > a.played_on ? 1 : b.played_on < a.played_on ? -1 : 0));
      toast('Matchen är sparad'); render();
    } catch (e) { toast('Kunde inte spara: ' + e.message, 4000); }
  };
  $('#gm').addEventListener('click', async e => {
    const ed = e.target.closest('[data-editg]'); if (ed) return editGame(ed.dataset.editg);
    const b = e.target.closest('[data-delg]'); if (!b) return;
    if (!confirm('Ta bort matchen?')) return;
    await api('/api/games/' + b.dataset.delg, { method: 'DELETE' });
    S.games = S.games.filter(g => g.id !== b.dataset.delg); render();
  });
}
// ändra en loggad match: lek, datum, resultat, spelare, motståndare, anteckning
function editGame(id) {
  const g = S.games.find(x => x.id === id); if (!g) return;
  const known = S.decks.some(d => d.id === g.deck_id);
  let result = g.result;
  openModal(`<div class="row"><h2 style="margin:0">Ändra match</h2><span class="spacer"></span><button class="icon-btn" data-close aria-label="Stäng">✕</button></div>
    ${g.logged_by ? '<p class="muted small">Loggad av någon annan. Välj vilken lek du spelade.</p>' : ''}
    <p><label class="small">Lek<br><select id="eDeck" style="width:100%"><option value="">Annan lek…</option>${S.decks.slice().sort((a, b) => b.updated - a.updated).map(d => `<option value="${d.id}" ${d.id === g.deck_id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></label></p>
    <p id="eOtherWrap" ${known ? 'hidden' : ''}><input type="text" id="eOther" placeholder="Lekens namn" style="width:100%" maxlength="80" value="${known || g.deck_name === 'Ingen lek vald' ? '' : esc(g.deck_name)}"></p>
    <p class="row"><label class="small">Datum<br><input type="date" id="eDate" value="${esc(g.played_on)}"></label>
      <label class="small">Spelare<br><input type="number" id="ePlayers" min="2" max="10" value="${g.players}" style="width:5rem"></label></p>
    <div class="seg" id="eRes" style="margin:.4rem 0">${Object.entries(RES_SV).map(([k, v]) => `<button data-r="${k}" class="${k === g.result ? 'on' : ''}">${v}</button>`).join('')}</div>
    <p><input type="text" id="eOpp" placeholder="Mot vilka?" style="width:100%" maxlength="300" value="${esc(g.opponents || '')}"></p>
    <p><input type="text" id="eNotes" placeholder="Anteckning (valfritt)" style="width:100%" maxlength="1000" value="${esc(g.notes || '')}"></p>
    <p class="row"><span class="spacer"></span><button class="btn" data-close>Avbryt</button><button class="btn primary" id="eSave">Spara</button></p>`, box => {
    $('#eDeck', box).onchange = e => { $('#eOtherWrap', box).hidden = !!e.target.value; };
    $('#eRes', box).onclick = e => { const b = e.target.closest('[data-r]'); if (!b) return; result = b.dataset.r; $$('#eRes button', box).forEach(x => x.classList.toggle('on', x === b)); };
    $('#eSave', box).onclick = async () => {
      const d = S.decks.find(x => x.id === $('#eDeck', box).value);
      const deck_name = d ? d.name : $('#eOther', box).value.trim();
      if (!deck_name) return toast('Välj lek eller skriv lekens namn');
      try {
        const n = await api('/api/games/' + id, { method: 'PUT', body: { deck_id: d ? d.id : null, deck_name, played_on: $('#eDate', box).value, result, players: +$('#ePlayers', box).value || 2, opponents: $('#eOpp', box).value.trim(), notes: $('#eNotes', box).value.trim() } });
        S.games = S.games.map(x => (x.id === id ? { ...x, ...n } : x)).sort((a, b) => (b.played_on > a.played_on ? 1 : b.played_on < a.played_on ? -1 : 0));
        closeModal(); toast('Matchen är ändrad'); render();
      } catch (err) { toast('Kunde inte spara: ' + err.message, 4000); }
    };
  });
}

// ---------- lekanalys ----------
// Motståndare skrivs som "Jonte (Atraxa), Kalle (Krenko)": namnet före parentesen, befälhavaren i den.
function parseOpps(text) {
  return String(text || '').split(/[,;&\n]| och | mot /i).map(t => t.trim()).filter(Boolean).map(t => {
    const m = t.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
    return { name: (m ? m[1] : t).trim(), cmdr: m ? m[2].trim() : '' };
  });
}
const gameKey = g => g.deck_id || 'x:' + g.deck_name;
function recBy(games, keysOf) {
  const out = {};
  for (const g of games) for (const [k, label] of keysOf(g)) {
    const r = out[k] = out[k] || { label, n: 0, win: 0, loss: 0, draw: 0 };
    r.n++; r[g.result]++;
  }
  return Object.values(out).map(r => ({ ...r, pct: Math.round(r.win / r.n * 100) }));
}
function viewAnalysis(sel) {
  setNav('matcher');
  const decks = {};
  for (const g of S.games) decks[gameKey(g)] = decks[gameKey(g)] || g.deck_name;
  if (sel && !decks[sel]) sel = '';
  const games = S.games.filter(g => !sel || gameKey(g) === sel);
  const asc = games.slice().sort((a, b) => (a.played_on < b.played_on ? -1 : a.played_on > b.played_on ? 1 : 0));
  const tot = deckRecord(games);
  let best = 0, run = 0;
  for (const g of asc) { run = g.result === 'win' ? run + 1 : 0; best = Math.max(best, run); }
  let cur = 0; const lastRes = asc.at(-1)?.result;
  for (let i = asc.length - 1; i >= 0 && asc[i].result === lastRes; i--) cur++;
  const mins = games.map(g => +(String(g.notes || '').match(/(\d+) min/) || [])[1]).filter(x => x > 0);
  const avgMin = mins.length ? Math.round(mins.reduce((a, b) => a + b, 0) / mins.length) : null;
  const bucket = n => n <= 2 ? ['2', '2 spelare'] : n <= 4 ? ['3', '3–4 spelare'] : ['5', '5 eller fler'];
  const byPl = recBy(games, g => [bucket(g.players)]).sort((a, b) => a.label.localeCompare(b.label));
  const real = o => o.name && !/^spelare \d+$/i.test(o.name);
  const opp = recBy(games, g => [...new Map(parseOpps(g.opponents).filter(real).map(o => [o.name.toLowerCase(), o.name])).entries()]).sort((a, b) => b.n - a.n || b.pct - a.pct);
  const cmd = recBy(games, g => [...new Map(parseOpps(g.opponents).filter(o => o.cmdr).map(o => [o.cmdr.toLowerCase(), o.cmdr])).entries()]).sort((a, b) => b.n - a.n || b.pct - a.pct);
  const months = recBy(games, g => [[g.played_on.slice(0, 7), g.played_on.slice(0, 7)]]).sort((a, b) => b.label.localeCompare(a.label)).slice(0, 12);
  const perDeck = sel ? [] : recBy(games, g => [[gameKey(g), g.deck_name]]).sort((a, b) => b.n - a.n);
  const form = list => list.map(g => `<span class="form ${esc(g.result)}" title="${esc(g.played_on)}: ${RES_SV[g.result]}${g.opponents ? ' mot ' + esc(g.opponents) : ''}"></span>`).join('');
  const bar = p => `<div class="wbar"><div style="width:${p}%"></div></div>`;
  const table = (rows, head) => `<div class="table-scroll"><table class="small"><thead><tr><th>${head}</th><th class="num">Matcher</th><th class="num">V–F–O</th><th class="num">Vinst</th><th style="width:30%"></th></tr></thead><tbody>
    ${rows.map(r => `<tr class="${r.n < 3 ? 'few' : ''}"><td>${esc(r.label)}</td><td class="num">${r.n}</td><td class="num">${r.win}–${r.loss}–${r.draw}</td><td class="num"><b>${r.pct} %</b></td><td>${bar(r.pct)}</td></tr>`).join('')}</tbody></table></div>`;
  // några meningar om det som sticker ut (minst 3 matcher)
  const tips = [], enough = opp.filter(r => r.n >= 3);
  if (enough.length >= 2) {
    const s = enough.slice().sort((a, b) => b.pct - a.pct);
    if (s[0].pct > s.at(-1).pct) tips.push(`Du vinner oftast mot <b>${esc(s[0].label)}</b> (${s[0].pct} %) och har svårast mot <b>${esc(s.at(-1).label)}</b> (${s.at(-1).pct} %).`);
  }
  const plOk = byPl.filter(r => r.n >= 3);
  if (plOk.length >= 2) { const s = plOk.slice().sort((a, b) => b.pct - a.pct); if (s[0].pct > s.at(-1).pct) tips.push(`${sel ? 'Leken' : 'Du'} går bäst med ${esc(s[0].label.toLowerCase())} (${s[0].pct} %), sämst med ${esc(s.at(-1).label.toLowerCase())} (${s.at(-1).pct} %).`); }
  const last10 = deckRecord(asc.slice(-10));
  if (asc.length >= 15) tips.push(`Senaste 10 matcherna: ${last10.pct} % vinster, mot ${tot.pct} % totalt.`);
  if (perDeck.length >= 2) { const s = perDeck.filter(r => r.n >= 3).sort((a, b) => b.pct - a.pct); if (s.length >= 2) tips.push(`Bästa leken är <b>${esc(s[0].label)}</b> (${s[0].pct} % på ${s[0].n} matcher).`); }
  $('#app').innerHTML = `<div class="row"><h1>Matcher</h1></div>${gameTabs('analys')}
    <div class="row" style="margin-top:1rem"><label class="small">Lek <select id="anDeck"><option value="">Alla lekar</option>${Object.entries(decks).sort((a, b) => a[1].localeCompare(b[1])).map(([k, n]) => `<option value="${esc(k)}" ${k === sel ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select></label>
      ${sel && !sel.startsWith('x:') && S.decks.some(d => d.id === sel) ? `<a class="btn small" href="#/lek/${esc(sel)}">Öppna leken</a>` : ''}</div>
    ${!games.length ? '<div class="card empty" style="margin-top:1rem">Inga matcher loggade än. Logga matcher under Mina matcher eller avsluta en match i livräknaren.</div>' : `
    <div class="stats" style="margin-top:1rem">
      <div class="stat"><b>${tot.pct} %</b><span>vinster (${tot.win} av ${tot.n})</span></div>
      <div class="stat"><b>${cur}</b><span>${lastRes === 'win' ? 'vinster' : lastRes === 'loss' ? 'förluster' : 'oavgjorda'} i rad just nu</span></div>
      <div class="stat"><b>${best}</b><span>längsta vinstsviten</span></div>
      ${avgMin ? `<div class="stat"><b>${avgMin} min</b><span>snittlängd (${mins.length} matcher från livräknaren)</span></div>` : ''}
    </div>
    ${tips.length ? `<div class="card" style="margin-top:1rem"><h2>Det här sticker ut</h2>${tips.map(t => `<p class="small" style="margin:.3rem 0">${t}</p>`).join('')}</div>` : ''}
    <div class="grid cols-2" style="margin-top:1rem">
      <div class="grid" style="align-content:start">
        <div class="card"><h2>Form</h2><div class="formrow">${form(asc.slice(-30))}</div><p class="muted small">De senaste ${Math.min(30, asc.length)} matcherna, äldst till vänster. Grön vinst, röd förlust, grå oavgjort.</p></div>
        ${perDeck.length ? `<div class="card"><h2>Per lek</h2>${table(perDeck, 'Lek')}</div>` : ''}
        <div class="card"><h2>Antal spelare</h2>${table(byPl, 'Spelare')}</div>
        <div class="card"><h2>Per månad</h2>${table(months, 'Månad')}</div>
      </div>
      <div class="grid" style="align-content:start">
        <div class="card"><h2>Mot motståndare</h2>${opp.length ? table(opp, 'Motståndare') : '<p class="muted small">Skriv vilka ni spelade mot i fältet Mot när du loggar, t.ex. <i>Jonte (Atraxa), Kalle (Krenko)</i>.</p>'}</div>
        <div class="card"><h2>Mot befälhavare</h2>${cmd.length ? table(cmd, 'Befälhavare') : '<p class="muted small">Skriv motståndarens befälhavare inom parentes, t.ex. <i>Jonte (Atraxa)</i>, så syns hur det går mot olika lekar.</p>'}</div>
        <p class="muted small">Vinst räknas när du vann matchen. Rader med färre än 3 matcher är ljusare, de säger inte så mycket än.</p>
      </div>
    </div>`}`;
  $('#anDeck').onchange = e => { location.hash = '#/matcher/analys' + (e.target.value ? '/' + encodeURIComponent(e.target.value) : ''); };
}

// ---------- önskelista med bevakning ----------
const bestOffer = r => r && (r.offers.find(o => !o.foil) || r.offers[0]);
async function saveWish(w) {
  const row = await api('/api/wishlist', { method: 'PUT', body: w });
  const i = S.wishlist.findIndex(x => x.name === row.name);
  if (i >= 0) S.wishlist[i] = { ...S.wishlist[i], ...row }; else S.wishlist.push(row);
  updateWishBadge();
  return row;
}
async function addToWishlist(name, qty = 1, quiet) {
  if (!S.v3) return;
  const ex = S.wishlist.find(w => w.name === name);
  await saveWish({ name, qty: Math.max(ex?.qty || 0, qty) });
  if (!quiet) toast(`♥ ${name} på önskelistan`);
}
// Kollar Alara för kort som inte kollats på ett dygn. Larmar när ett kort kommit in i lager eller
// när priset gått ner till maxpriset.
async function checkWishlist(force) {
  if (!S.v3 || checkWishlist.busy) return;
  const due = S.wishlist.filter(w => force || !w.checked_at || Date.now() - Date.parse(w.checked_at) > 20 * 3600e3).slice(0, 40);
  if (!due.length) return;
  checkWishlist.busy = true;
  try {
    for (const w of due) {
      const r = await alaraFor(w.name, force).catch(() => null);
      if (!r) continue;
      const o = bestOffer(r), price = o ? o.price : null;
      const wasOk = w.in_stock && (w.max_price == null || (w.last_price != null && w.last_price <= w.max_price));
      const isOk = !!o && (w.max_price == null || price <= w.max_price);
      await saveWish({ name: w.name, in_stock: !!o, last_price: price, checked_at: new Date().toISOString(), alert: w.alert || (isOk && !wasOk) });
    }
  } finally { checkWishlist.busy = false; }
  if (location.hash.startsWith('#/onskelista')) render();
}
function updateWishBadge() {
  const a = $('[data-nav=onskelista]'); if (!a) return;
  const n = S.wishlist.filter(w => w.alert).length;
  a.innerHTML = `Önskelista${n ? ` <span class="badge">${n}</span>` : ''}`;
  updateBell();
}
function viewWishlist() {
  setNav('onskelista');
  if (!S.v3) { $('#app').innerHTML = '<div class="card empty">Önskelistan kräver en uppdatering av databasen.</div>'; return; }
  const unknown = S.wishlist.map(w => w.name).filter(n => !S.cards[n] && !S.notFound.has(n));
  if (unknown.length && !viewWishlist.loading) { viewWishlist.loading = true; ensureCards(unknown).catch(() => {}).finally(() => { viewWishlist.loading = false; render(); }); }
  const list = S.wishlist.slice().sort((a, b) => (b.alert - a.alert) || a.name.localeCompare(b.name));
  const alerts = list.filter(w => w.alert).length, drops = Object.fromEntries(wishDrops().map(d => [d.name, d]));
  $('#app').innerHTML = `<div id="wl"><div class="row"><h1>Önskelista</h1><span class="spacer"></span>
      ${alerts ? `<button class="btn small" id="wSeen">Markera ${alerts} nyheter som sedda</button>` : ''}<button class="btn small" id="wCheck" ${checkWishlist.busy ? 'disabled' : ''}>${checkWishlist.busy ? 'Kollar…' : '↻ Kolla Alara nu'}</button></div>
    <div class="grid cols-2" style="margin-top:1rem">
      <div class="card">
        <div class="row" style="margin-bottom:.6rem"><div class="add-bar" id="wAdd"></div></div>
        ${list.length ? `<div class="table-scroll"><table><thead><tr><th>Kort</th><th class="num">Antal</th><th class="num" title="Larma när priset hos Alara är högst så här mycket">Maxpris</th><th>Alara</th><th>Kollad</th><th></th></tr></thead><tbody>
        ${list.map(w => `<tr data-name="${esc(w.name)}" class="${w.alert ? 'alert' : ''}"><td>${w.alert ? '<span class="badge">Nytt</span> ' : ''}<span data-img="${esc(S.cards[w.name]?.image || scryImg(w.name))}">${esc(w.name)}</span><div class="muted small">ca ${krE(S.cards[w.name]?.eur)}${drops[w.name] ? ` <span class="pill good" title="Var ${krE(drops[w.name].from)}">↓ ${Math.round((1 - drops[w.name].to / drops[w.name].from) * 100)} %</span>` : ''}</div></td>
          <td class="num"><input type="number" min="1" max="99" value="${w.qty}" style="width:4rem" data-wq></td>
          <td class="num"><input type="number" min="0" step="1" value="${w.max_price ?? ''}" placeholder="kr" style="width:5.5rem" data-wp></td>
          <td>${w.in_stock == null ? '<span class="muted small">ej kollat</span>' : w.in_stock ? `<a href="${esc(bestOffer(S.alara[w.name])?.url || `https://www.alaragames.se/search?q=${encodeURIComponent(w.name)}`)}" target="_blank" rel="noopener"><b>${kr(w.last_price)}</b></a>${w.max_price != null && w.last_price <= w.max_price ? ' <span class="pill good">under maxpris</span>' : ''}` : '<span class="pill warn">ej i lager</span>'}</td>
          <td class="small muted">${w.checked_at ? new Date(w.checked_at).toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' }) : ''}</td>
          <td class="num"><button class="btn small" data-wgot title="Köpt – lägg i samlingen och ta bort från listan">Köpt ✓</button> <button class="icon-btn" data-wdel title="Ta bort">✕</button></td></tr>`).join('')}</tbody></table></div>`
        : '<p class="muted">Önskelistan är tom. Lägg till kort här, från ett korts ruta eller från Köpa-fliken i en lek.</p>'}
      </div>
      <div class="grid" style="align-content:start">
        <div class="card"><h2>Lägg till från en lek</h2>
          <p class="small muted">Alla kort du saknar i leken hamnar på listan.</p>
          <div class="row"><select id="wDeck" style="flex:1">${S.decks.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select><button class="btn small" id="wDeckGo" ${S.decks.length ? '' : 'disabled'}>Lägg till</button></div></div>
        <div class="card"><h2>Så fungerar bevakningen</h2>
          <p class="small">När du öppnar appen kollas Alaras lager för kort som inte kollats det senaste dygnet. Kommer ett kort in i lager, eller sjunker priset till ditt maxpris, markeras det med <span class="badge">Nytt</span> och syns i menyn.</p>
          <p class="small muted">Utan maxpris larmar appen när kortet kommer in i lager.</p></div>
      </div></div></div>`;
  addCardUI($('#wAdd'), async name => { await ensureCards([name]).catch(() => {}); await addToWishlist(name); render(); }, 'Lägg till kort på önskelistan…');
  if ($('#wSeen')) $('#wSeen').onclick = async () => { for (const w of S.wishlist.filter(x => x.alert)) await saveWish({ name: w.name, alert: false }); render(); };
  $('#wCheck').onclick = () => { const p = checkWishlist(true); render(); p.then(render); };
  $('#wDeckGo').onclick = async () => {
    const d = S.decks.find(x => x.id === $('#wDeck').value); if (!d) return;
    const miss = missingCards(d);
    for (const m of miss) await addToWishlist(m.name, m.missing, true);
    toast(`${miss.length} kort på önskelistan`); render();
  };
  $('#wl').addEventListener('change', async e => {
    const tr = e.target.closest('tr[data-name]'); if (!tr) return;
    if (e.target.matches('[data-wq]')) await saveWish({ name: tr.dataset.name, qty: Math.max(1, +e.target.value || 1) });
    if (e.target.matches('[data-wp]')) await saveWish({ name: tr.dataset.name, max_price: e.target.value === '' ? null : Math.max(0, +e.target.value) });
  });
  $('#wl').addEventListener('click', async e => {
    const tr = e.target.closest('tr[data-name]'); if (!tr) return;
    const name = tr.dataset.name, w = S.wishlist.find(x => x.name === name);
    if (e.target.closest('[data-wgot]')) {
      await setOwned(name, (S.collection[name] || 0) + (w?.qty || 1));
      await api('/api/wishlist?name=' + encodeURIComponent(name), { method: 'DELETE' });
      S.wishlist = S.wishlist.filter(x => x.name !== name); updateWishBadge(); toast(`${name} lagt i samlingen`); render();
    }
    if (e.target.closest('[data-wdel]')) {
      await api('/api/wishlist?name=' + encodeURIComponent(name), { method: 'DELETE' });
      S.wishlist = S.wishlist.filter(x => x.name !== name); updateWishBadge(); render();
    }
  });
}

// ---------- utlånat ----------
async function addLoan(name, qty, borrower) {
  const l = await api('/api/loans', { method: 'POST', body: { name, qty, borrower, lent_on: new Date().toISOString().slice(0, 10) } });
  S.loans.unshift(l); toast(`↗ ${name} utlånat till ${borrower}`);
}
async function returnLoan(id) {
  await api('/api/loans/' + id, { method: 'DELETE' });
  S.loans = S.loans.filter(l => l.id !== id); toast('Tillbaka hos dig');
}

// ---------- proxyutskrift ----------
function printProxies(names) {
  if (!names.length) return toast('Inga kort att skriva ut');
  const big = n => (S.cards[n]?.image || '').replace('/normal/', '/large/') || scryImg(n, 'large');
  const el = document.createElement('div');
  el.id = 'print';
  const pages = [];
  for (let i = 0; i < names.length; i += 9) pages.push(names.slice(i, i + 9));
  el.innerHTML = pages.map(p => `<div class="sheet">${p.map(n => `<img src="${esc(big(n))}" alt="${esc(n)}">`).join('')}</div>`).join('');
  document.body.appendChild(el);
  toast(`Förbereder ${names.length} kort…`);
  const imgs = $$('img', el);
  const loaded = Promise.all(imgs.map(i => i.complete && i.naturalWidth ? 0 : new Promise(r => { i.onload = i.onerror = r; })));
  Promise.race([loaded, new Promise(r => setTimeout(r, 15000))]).then(() => {
    const done = () => { el.remove(); removeEventListener('afterprint', done); };
    addEventListener('afterprint', done);
    print();
    setTimeout(done, 120000); // reserv om afterprint aldrig kommer (syns ändå bara vid utskrift)
  });
}

// ---------- skanna kort med kameran ----------
function loadScript(src) {
  return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Kunde inte ladda ' + src)); document.head.appendChild(s); });
}
async function ocrWorker() {
  if (ocrWorker.w) return ocrWorker.w;
  if (!window.Tesseract) await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js');
  const w = await window.Tesseract.createWorker('eng');
  // en rad text, bara tecken som finns i kortnamn
  await w.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyzÀÁÂÄÉÍÓÖÚÛàáâäéíóöúû',- ", preserve_interword_spaces: '1' });
  return (ocrWorker.w = w);
}
// Klipper ut den del av kamerabilden som syns i den gula rutan. Videon visas med object-fit: cover,
// så rutans läge på skärmen måste räknas om till kamerans egna pixlar.
function scanCrop(video, guide) {
  const vw = video.videoWidth, vh = video.videoHeight, vr = video.getBoundingClientRect(), gr = guide.getBoundingClientRect();
  const k = Math.max(vr.width / vw, vr.height / vh) || 1;
  const ox = (vw * k - vr.width) / 2, oy = (vh * k - vr.height) / 2;
  let sx = (gr.left - vr.left + ox) / k, sy = (gr.top - vr.top + oy) / k, sw = gr.width / k, sh = gr.height / k;
  if (!(sw > 0 && sh > 0)) { sx = vw * 0.08; sy = vh * 0.30; sw = vw * 0.84; sh = vh * 0.15; } // ingen layout (test)
  return { sx, sy, sw, sh };
}
// Två sätt att tvätta bilden, de klarar olika kort: 'sv' = uppskalat svartvitt (Otsu, ljus text på mörk botten vänds),
// 'grå' = gråskala med förstärkt kontrast. Pixlarna räknas för hand eftersom Safari saknar ctx.filter.
function scanPrep(video, { sx, sy, sw, sh }, mode = 'sv') {
  const scale = mode === 'sv' ? Math.min(4, Math.max(1, 160 / sh)) : 1.5;
  const cv = document.createElement('canvas');
  cv.width = Math.round(sw * scale); cv.height = Math.round(sh * scale);
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
  let img;
  try { img = ctx.getImageData(0, 0, cv.width, cv.height); } catch { return cv; }
  const d = img.data, n = d.length / 4, gray = new Uint8Array(n), hist = new Array(256).fill(0);
  for (let i = 0; i < n; i++) { const g = (d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114) | 0; gray[i] = g; hist[g]++; }
  if (mode === 'grå') {
    for (let i = 0; i < n; i++) d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = Math.max(0, Math.min(255, (gray[i] - 128) * 1.4 + 128));
    ctx.putImageData(img, 0, 0);
    return cv;
  }
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, th = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = n - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF, between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; th = t; }
  }
  const darkBg = gray.filter(g => g < th).length > n / 2; // mest mörkt = ljus text
  for (let i = 0; i < n; i++) { const on = gray[i] >= th; const v = on !== darkBg ? 255 : 0; d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; }
  ctx.putImageData(img, 0, 0);
  return cv;
}
// tänkbara namn ur textläsarens rad: hela raden, utan skräp i kanterna, utan sista ordet (manakostnad)
function scanCandidates(text) {
  const line = (text || '').split('\n').map(s => s.replace(/[^A-Za-zÀ-ÿ',\- ]/g, ' ').replace(/\s+/g, ' ').trim()).sort((a, b) => b.length - a.length)[0] || '';
  const small = /^(of|the|to|in|and|from|with|a|an|for|on|at|into)$/;
  // kortnamn: ord med stor bokstav, småord emellan. Skräp från ramen och manasymboler hamnar i kanterna.
  const words = line.split(' ').filter(w => w.length > 2 || small.test(w));
  while (words.length && (words[0].length < 3 || !/^[A-ZÀ-Ý]/.test(words[0]))) words.shift();
  while (words.length && (words[words.length - 1].length < 3 || !/^[A-ZÀ-Ý]/.test(words[words.length - 1]))) words.pop();
  // hela raden först, sedan utan de sista orden (oftast manakostnad som lästs som bokstäver)
  const out = [];
  for (let k = words.length; k >= Math.max(1, words.length - 2); k--) out.push(words.slice(0, k).join(' '));
  return [...new Set(out)].filter(s => s.length >= 4);
}
function scanModal() {
  if (!navigator.mediaDevices?.getUserMedia) return toast('Kameran går inte att använda i den här webbläsaren', 4000);
  let stream, added = [], auto = true, busy = false, hitShown = false, lastAdd = { name: '', at: 0 }, timer;
  try { auto = localStorage.getItem('lv-scan-auto') !== '0'; } catch {}
  openModal(`<div class="row"><h2 style="margin:0">Skanna kort</h2><span class="spacer"></span><button class="icon-btn" data-close aria-label="Stäng">✕</button></div>
    <div class="scan"><video playsinline muted autoplay></video><div class="guide"></div></div>
    <p class="small muted">Håll kortet så att <b>namnraden</b> fyller den gula rutan. Håll stilla en sekund. Bra ljus hjälper, undvik reflexer på foilkort.</p>
    <div class="row"><button class="btn primary" id="scRead" disabled>Startar kameran…</button><label class="small"><input type="checkbox" id="scAuto" ${auto ? 'checked' : ''}> Läs automatiskt</label>
      <button class="btn small" id="scTorch" hidden>🔦 Lampa</button><span id="scMsg" class="small"></span></div>
    <div id="scHit"></div><div id="scLog" class="small muted"></div>`, async box => {
    const video = $('video', box), guide = $('.guide', box), btn = $('#scRead', box), msg = $('#scMsg', box);
    const stop = () => { clearTimeout(timer); stream && stream.getTracks().forEach(t => t.stop()); };
    const obs = new MutationObserver(() => { if ($('#modal').hidden || !video.isConnected) { stop(); obs.disconnect(); if (added.length) render(); } });
    obs.observe($('#modal'), { attributes: true, childList: true, subtree: true });
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
      video.srcObject = stream;
    } catch (e) { btn.textContent = 'Ingen kamera'; msg.textContent = 'Tillåt kameran i webbläsaren och försök igen.'; return; }
    // lampa och autofokus där telefonen klarar det
    const track = stream.getVideoTracks()[0], caps = track.getCapabilities?.() || {};
    if (caps.focusMode?.includes('continuous')) track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
    if (caps.torch) {
      let on = false; const tb = $('#scTorch', box); tb.hidden = false;
      tb.onclick = () => { on = !on; track.applyConstraints({ advanced: [{ torch: on }] }).catch(() => {}); tb.classList.toggle('primary', on); };
    }
    btn.textContent = 'Laddar textläsaren…';
    try { await ocrWorker(); } catch (e) { btn.textContent = 'Fel'; msg.textContent = e.message; return; }
    btn.disabled = false; btn.textContent = '📷 Läs';
    const add = async (card, foil) => {
      S.cards[card.name] = { ...card }; delete S.cards[card.name].print;
      await setOwned(card.name, (S.collection[card.name] || 0) + 1);
      if (foil && card.print) {
        const pr = printsOf(card.name).map(p => ({ ...p })), same = pr.find(p => p.id === card.print.id && p.foil);
        if (same) same.qty++; else pr.push({ id: card.print.id, set: card.print.set, cn: card.print.cn, foil: true, qty: 1, eur: card.print.eur_foil ?? null });
        await savePrints(card.name, pr).catch(e => toast('Foil sparades inte: ' + e.message, 4000));
      }
      added.unshift(card.name + (foil ? ' ✦' : '')); lastAdd = { name: card.name, at: Date.now() };
      $('#scLog', box).textContent = 'Tillagt: ' + added.slice(0, 8).join(', ') + (added.length > 8 ? '…' : '');
      $('#scHit', box).innerHTML = ''; msg.textContent = ''; hitShown = false; loop();
    };
    const showHit = card => {
      hitShown = true; navigator.vibrate?.(40);
      $('#scHit', box).innerHTML = `<div class="row" style="margin-top:.6rem">${card.thumb ? `<img src="${esc(card.thumb)}" alt="" style="width:90px;border-radius:5px">` : ''}
        <div><b>${esc(card.name)}</b><div class="small muted">Du har ${S.collection[card.name] || 0} · ca ${krE(card.eur)}</div>
        <div class="row" style="margin-top:.4rem"><button class="btn primary" id="scAdd">+1</button>${S.v4 && card.print ? `<button class="btn" id="scFoil" title="Som foil, utgåva ${esc(card.print.set.toUpperCase())} – går att ändra i samlingen">+1 foil</button>` : ''}<button class="btn small" id="scWrong">Fel kort</button><button class="btn small" id="scSkip">Hoppa över</button></div></div></div>`;
      $('#scAdd', box).onclick = () => add(card, false);
      if ($('#scFoil', box)) $('#scFoil', box).onclick = () => add(card, true);
      $('#scSkip', box).onclick = () => { lastAdd = { name: card.name, at: Date.now() }; $('#scHit', box).innerHTML = ''; hitShown = false; loop(); };
      $('#scWrong', box).onclick = () => {
        $('#scHit', box).innerHTML = '<div class="add-bar" id="scFix" style="margin-top:.6rem"></div>';
        addCardUI($('#scFix', box), async name => { await ensureCards([name]).catch(() => {}); if (S.cards[name]) showHit(S.cards[name]); }, 'Skriv rätt namn…').focus();
      };
    };
    const read = async manual => {
      if (busy || !video.videoWidth || hitShown) return;
      busy = true; if (manual) { btn.disabled = true; msg.textContent = 'Läser…'; }
      try {
        const w = await ocrWorker(), crop = scanCrop(video, guide);
        // knappen provar båda sätten, automatläget växlar mellan dem för varje bild
        const modes = manual ? ['sv', 'grå'] : [(read.flip = !read.flip) ? 'sv' : 'grå'];
        let seen = '';
        for (const mode of modes) {
          const { data } = await w.recognize(scanPrep(video, crop, mode));
          const cands = data.confidence >= (manual ? 25 : 40) ? scanCandidates(data.text) : [];
          seen = seen || cands[0] || '';
          for (const q of cands) {
            const card = await api('/api/fuzzy?q=' + encodeURIComponent(q)).catch(() => ({ notFound: true }));
            if (card.notFound || !card.name) continue;
            // samma kort som nyss lades till: vänta tills ett nytt kort hålls upp
            if (!manual && card.name === lastAdd.name && Date.now() - lastAdd.at < 4000) return;
            msg.textContent = ''; showHit(card); return;
          }
        }
        if (manual) msg.textContent = seen ? `Läste ”${seen}” men hittade inget kort. Försök igen.` : 'Hittade ingen text. Flytta kortet så att namnet fyller rutan.';
      } catch (e) { msg.textContent = 'Fel: ' + e.message; }
      finally { busy = false; btn.disabled = false; }
    };
    const loop = () => { clearTimeout(timer); if (auto && video.isConnected) timer = setTimeout(async () => { await read(false); loop(); }, 700); };
    btn.onclick = () => read(true);
    $('#scAuto', box).onchange = e => { auto = e.target.checked; try { localStorage.setItem('lv-scan-auto', auto ? '1' : '0'); } catch {} loop(); };
    loop();
  });
}

// ---------- livräknare ----------
// Lokalt: en telefon mitt på bordet. Delad (molnläge): alla ansluter med en kod och ser samma räknare.
// Ändringar skickas som tillägg (+1, −3 …) över Supabase Realtime, så de kan komma i vilken ordning som helst.
const LIFE_KEY = 'lv-life';
const CID = Math.random().toString(36).slice(2, 10); // den här fliken
function lifeState() {
  if (!lifeState.s) { try { lifeState.s = JSON.parse(localStorage.getItem(LIFE_KEY)); } catch {} }
  return lifeState.s;
}
function saveLife() { try { localStorage.setItem(LIFE_KEY, JSON.stringify(lifeState.s)); } catch {} }
async function wakeLock(on) {
  try {
    if (on && !wakeLock.l && navigator.wakeLock) { wakeLock.l = await navigator.wakeLock.request('screen'); wakeLock.l.addEventListener('release', () => (wakeLock.l = null)); }
    if (!on && wakeLock.l) { await wakeLock.l.release(); wakeLock.l = null; }
  } catch {}
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && location.hash.startsWith('#/liv') && lifeState()?.players) wakeLock(true); });
const isOut = (p, s) => p.life <= 0 || p.poison >= 10 || s.players.some((_, j) => (p.cmd[j] || 0) >= 21);
const roomCode = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), b => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('');
const shared = ['setup', 'start', 'players', 'seats', 'starter', 'marks'];
// räknare per spelare, markörer som en spelare i taget har, och vanliga tokens
const CTRS = [['energy', '⚡', 'Energi'], ['exp', '✦', 'Erfarenhet'], ['rad', '☢', 'Rad'], ['tax', '🔁', 'Befälhavarskatt']];
const MARKS = [['monarch', '👑', 'Monark', 'Drar ett extra kort i slutet av sin tur. Den som gör stridsskada på monarken tar över.'], ['initiative', '🏰', 'Initiativ', 'Utforskar Undercity. Den som gör stridsskada på den som har initiativet tar över.']];
const TOKENS = ['Treasure', 'Food', 'Clue', 'Blood', 'Soldier 1/1', 'Zombie 2/2', 'Goblin 1/1', 'Saproling 1/1', 'Spirit 1/1', 'Beast 3/3', 'Elf Warrior 1/1', 'Thopter 1/1'];
const cleanTok = v => String(v ?? '').replace(/[<>"]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);

// ---- delad räknare ----
const room = { ch: null, code: '', peers: new Map() }; // peers: annan flik -> senast hörd
const livePeers = () => [...room.peers.values()].filter(t => Date.now() - t < 60000).length;
function roomSend(msg) { room.ch?.send({ type: 'broadcast', event: 'm', payload: { ...msg, from: CID } }); }
function roomJoin(code) {
  if (!window.LV_CHANNEL) return false;
  if (room.code === code && room.ch) return true;
  roomLeave();
  room.code = code; room.peers = new Map();
  clearInterval(room.ping); room.ping = setInterval(() => { roomSend({ t: 'ping' }); updateRoomBar(); }, 20000);
  // ny anslutning: ta emot de andras läge om någon svarar (vi kan ha missat ändringar)
  const s = lifeState(); if (s?.players) { s.synced = false; saveLife(); }
  room.ch = window.LV_CHANNEL('lv-life-' + code);
  room.ch.on('broadcast', { event: 'm' }, ({ payload }) => roomMsg(payload));
  room.ch.subscribe(st => {
    if (st === 'SUBSCRIBED') { room.err = false; roomSend({ t: 'hello' }); }
    else if ((st === 'CHANNEL_ERROR' || st === 'TIMED_OUT') && !room.err) { room.err = true; toast('Kunde inte ansluta till den delade räknaren – kolla nätet', 4000); }
    updateRoomBar();
  });
  return true;
}
function roomLeave() { clearInterval(room.ping); if (room.ch) { try { room.ch.unsubscribe(); } catch {} } room.ch = null; room.code = ''; }
// allt som kommer från andra telefoner tvättas: rätt typer, rimliga gränser
const num = (v, lo, hi, d = 0) => Number.isFinite(+v) ? Math.max(lo, Math.min(hi, Math.round(+v))) : d;
function cleanShared(st) {
  if (!st || !Array.isArray(st.players) || st.players.length < 2 || st.players.length > 6) return null;
  const n = st.players.length;
  const players = st.players.map((p, i) => ({
    name: String(p?.name || `Spelare ${i + 1}`).slice(0, 20), uid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(p?.uid) ? p.uid : undefined, life: num(p?.life, -999, 9999, 40), poison: num(p?.poison, 0, 99),
    cmd: Object.fromEntries(Object.entries(p?.cmd || {}).filter(([j]) => /^\d$/.test(j) && +j < n).map(([j, v]) => [j, num(v, 0, 999)])),
    ctr: Object.fromEntries(Object.entries(p?.ctr || {}).filter(([k]) => CTRS.some(c => c[0] === k)).map(([k, v]) => [k, num(v, 0, 999)]).filter(([, v]) => v)),
    tok: Object.fromEntries(Object.entries(p?.tok || {}).slice(0, 12).map(([k, v]) => [cleanTok(k), num(v, 0, 999)]).filter(([k, v]) => k && v)),
  }));
  const marks = Object.fromEntries(MARKS.map(([k]) => [k, Number.isInteger(st.marks?.[k]) && st.marks[k] >= 0 && st.marks[k] < n ? st.marks[k] : null]));
  const setup = { n, life: num(st.setup?.life, 1, 999, 40), names: players.map(p => p.name), deck: '', share: true };
  const seats = Object.fromEntries(Object.entries(st.seats || {}).filter(([j]) => /^\d$/.test(j) && +j < n).map(([j, v]) => [j, String(v).slice(0, 20)]));
  return { setup, start: num(st.start, 0, 9e15, Date.now()), players, seats, starter: st.starter == null ? undefined : num(st.starter, 0, n - 1), marks };
}
function applyOp(s, op) {
  if (!op || typeof op.id !== 'string' || !['life', 'poison', 'cmd', 'ctr', 'tok', 'mark'].includes(op.k)) return false;
  op = { id: op.id.slice(0, 40), k: op.k, p: num(op.p, 0, 5, -1), d: num(op.d, -999, 999), j: op.j == null ? undefined : num(op.j, 0, 5), n: op.k === 'tok' ? cleanTok(op.n) : undefined };
  if ((op.k === 'tok' && !op.n) || (op.k === 'ctr' && !CTRS[op.j]) || (op.k === 'mark' && !MARKS[op.j])) return false;
  s.applied = s.applied || [];
  if (s.applied.includes(op.id)) return false;
  s.applied.push(op.id); if (s.applied.length > 400) s.applied.splice(0, 100);
  const p = s.players[op.p]; if (!p) return false;
  if (op.k === 'life') p.life += op.d;
  else if (op.k === 'poison') p.poison = Math.max(0, p.poison + op.d);
  else if (op.k === 'cmd') { p.cmd[op.j] = Math.max(0, (p.cmd[op.j] || 0) + op.d); p.life -= op.d; }
  else if (op.k === 'ctr') { const c = p.ctr = p.ctr || {}, k = CTRS[op.j][0]; c[k] = Math.max(0, (c[k] || 0) + op.d); if (!c[k]) delete c[k]; }
  else if (op.k === 'tok') {
    const t = p.tok = p.tok || {};
    if (!(op.n in t) && Object.keys(t).length >= 12) return true;
    t[op.n] = Math.max(0, (t[op.n] || 0) + op.d); if (!t[op.n]) delete t[op.n];
  } else if (op.k === 'mark') { const m = s.marks = s.marks || {}, k = MARKS[op.j][0]; if (op.d > 0) m[k] = op.p; else if (m[k] === op.p) m[k] = null; }
  return true;
}
// en ändring härifrån: gör den direkt och skicka den till de andra
function lifeOp(p, k, d, j, n) {
  const s = lifeState();
  const op = { id: CID + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), p, k, d, j, n };
  if (k === 'cmd') { const before = s.players[p].cmd[j] || 0; op.d = Math.max(0, before + d) - before; if (!op.d) return; }
  if (k === 'ctr' && d < 0 && !s.players[p].ctr?.[CTRS[j][0]]) return;
  if (k === 'tok') { op.n = cleanTok(n); if (!op.n || (d < 0 && !s.players[p].tok?.[op.n])) return; }
  if (k === 'mark') op.d = s.marks?.[MARKS[j][0]] === p ? 0 : 1; // tryck igen = ta bort
  applyOp(s, op); saveLife();
  if (k === 'life' || k === 'cmd') lifeFx(s.room ? s.me : null, p, k === 'cmd' ? -op.d : op.d, k === 'cmd');
  if (s.room) roomSend({ t: 'op', op });
}
function roomMsg(m) {
  const s = lifeState();
  if (!s || m.from === CID) return;
  room.peers.set(String(m.from).slice(0, 20), Date.now());
  if (m.t === 'ping') return updateRoomBar();
  if (m.t === 'hello') {
    if (s.players && s.room === room.code) roomSend({ t: 'state', to: m.from, state: Object.fromEntries(shared.map(k => [k, s[k]])), applied: s.applied || [] });
    return updateRoomBar();
  }
  if (m.t === 'state' && m.to === CID) {
    const st = cleanShared(m.state);
    if (s.synced || !st) return;
    // egen lek och plats behålls, startlivet följer med för Börja om
    Object.assign(s, st, { setup: { ...st.setup, deck: s.setup?.deck || '' }, applied: (Array.isArray(m.applied) ? m.applied : []).filter(x => typeof x === 'string').slice(-400), synced: true }); clearDeltas(); saveLife();
    if (s.me == null || !s.players[s.me]) return location.hash.startsWith('#/liv') ? render() : null;
    return lifeRedraw();
  }
  if (!s.players || s.room !== room.code) return;
  if (m.t === 'op') {
    if (!applyOp(s, m.op)) return;
    saveLife(); lifeRedraw();
    if (m.op.k === 'life' || m.op.k === 'cmd') {
      const src = Object.entries(s.seats || {}).find(([, v]) => v === String(m.from).slice(0, 20))?.[0];
      const d = num(m.op.d, -999, 999);
      lifeFx(src == null ? null : +src, num(m.op.p, 0, 5), m.op.k === 'cmd' ? -d : d, m.op.k === 'cmd');
    }
    return;
  }
  if (m.t === 'dice') {
    const n = s.players.length, r = m.res || {};
    if (!Array.isArray(r.rolls) || r.rolls.length !== n) return;
    const rolls = r.rolls.map(x => (Array.isArray(x) ? x : []).slice(0, 10).map(v => num(v, 1, 20, 1)));
    const win = Number.isInteger(r.win) && r.win >= 0 && r.win < n ? r.win : -1; if (win < 0 || !rolls.every(x => x.length)) return;
    return lifeDice({ rolls, win }, m.by ? String(m.by).slice(0, 20) : '');
  }
  if (m.t === 'seat') {
    const i = num(m.p, 0, 5, -1); if (!s.players[i]) return;
    s.seats = s.seats || {}; s.seats[i] = String(m.from).slice(0, 20);
    if (m.name && !s.players[i].uid) s.players[i].name = String(m.name).slice(0, 20);
    saveLife(); return lifeRedraw();
  }
  if (m.t === 'reset') { const st = cleanShared(m.state); if (!st) return; Object.assign(s, st, { setup: { ...st.setup, deck: s.setup?.deck || '' }, applied: [] }); clearDeltas(); saveLife(); toast('Matchen började om'); return lifeRedraw(); }
  if (m.t === 'end') return lifeFinish(m.win === 'draw' ? 'draw' : m.win == null ? null : String(num(m.win, 0, 5)), m.by ? String(m.by).slice(0, 20) : '');
}
// effekter i delad räknare: skada flyger från den som gör den till den som tar den, liv lyser grönt
const fxCalm = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
function fxPulse(pl, cls) {
  if (!pl) return;
  pl.classList.remove('hitfx', 'healfx'); void pl.offsetWidth; pl.classList.add(cls);
  clearTimeout(pl.fxT); pl.fxT = setTimeout(() => pl.classList.remove(cls), 900);
}
function fxCenter(pl) { const r = ($('.lifeval', pl) || pl).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
function fxSparks(x, y, heal) {
  if (fxCalm() || !document.body.animate) return;
  for (let k = 0; k < 9; k++) {
    const e = document.createElement('div'); e.className = 'fx-spark' + (heal ? ' heal' : '');
    e.style.left = x + 'px'; e.style.top = y + 'px'; document.body.appendChild(e);
    const a = (k / 9) * Math.PI * 2 + Math.random() * .5, r = 30 + Math.random() * 40;
    e.animate([{ transform: 'translate(-50%,-50%) scale(1)', opacity: 1 }, { transform: `translate(calc(-50% + ${Math.cos(a) * r}px), calc(-50% + ${Math.sin(a) * r}px)) scale(.3)`, opacity: 0 }], { duration: 420 + Math.random() * 200, easing: 'cubic-bezier(.2,.7,.3,1)' }).onfinish = () => e.remove();
  }
}
function fxRise(pl) {
  if (fxCalm() || !pl.animate) return;
  for (let k = 0; k < 6; k++) {
    const e = document.createElement('div'); e.className = 'fx-plus'; e.textContent = k % 2 ? '✚' : '✦';
    e.style.left = (25 + Math.random() * 50) + '%'; e.style.top = (55 + Math.random() * 25) + '%'; pl.appendChild(e);
    e.animate([{ transform: 'translateY(0) scale(.6)', opacity: 0 }, { opacity: 1, offset: .25 }, { transform: `translateY(-${50 + Math.random() * 50}px) scale(1.1)`, opacity: 0 }], { duration: 800 + Math.random() * 400, delay: k * 70, easing: 'ease-out', fill: 'backwards' }).onfinish = () => e.remove();
  }
}
let fxLive = 0;
// ljud skapas i webbläsaren (Web Audio), inga ljudfiler. Telefonen släpper bara fram ljud efter ett tryck.
const snd = { ctx: null, nb: null, last: {} };
const soundOn = () => { try { return localStorage.getItem('lv-sound') !== '0'; } catch { return true; } };
function audio() {
  try {
    if (!snd.ctx) { const C = window.AudioContext || window.webkitAudioContext; if (!C) return null; snd.ctx = new C(); }
    if (snd.ctx.state === 'suspended') snd.ctx.resume().catch(() => {});
    return snd.ctx;
  } catch { return null; }
}
function sfx(kind) {
  if (!soundOn()) return;
  const a = audio(); if (!a) return;
  const now = a.currentTime;
  if (now - (snd.last[kind] ?? -1) < .06) return; snd.last[kind] = now;
  try {
    if (!snd.nb) { const b = a.createBuffer(1, Math.floor(a.sampleRate * .5), a.sampleRate), d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; snd.nb = b; }
    const out = a.createGain(); out.gain.value = .55; out.connect(a.destination);
    const env = (g, t, peak, dur) => { g.gain.setValueAtTime(.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + .012); g.gain.exponentialRampToValueAtTime(.0001, t + dur); };
    const noise = (t, dur, type, f0, f1, peak, q = 1) => {
      const n = a.createBufferSource(), f = a.createBiquadFilter(), g = a.createGain();
      n.buffer = snd.nb; f.type = type; f.Q.value = q; f.frequency.setValueAtTime(f0, t); if (f1) f.frequency.exponentialRampToValueAtTime(f1, t + dur);
      env(g, t, peak, dur); n.connect(f); f.connect(g); g.connect(out); n.start(t); n.stop(t + dur + .05);
    };
    const tone = (t, dur, type, f0, f1, peak) => {
      const o = a.createOscillator(), g = a.createGain();
      o.type = type; o.frequency.setValueAtTime(f0, t); if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
      env(g, t, peak, dur); o.connect(g); g.connect(out); o.start(t); o.stop(t + dur + .05);
    };
    if (kind === 'hit') { tone(now, .22, 'sine', 210, 55, .9); noise(now, .12, 'bandpass', 1800, 600, .45, .8); }
    else if (kind === 'cmd') { tone(now, .32, 'sawtooth', 120, 38, .35); tone(now, .3, 'sine', 160, 45, .8); noise(now, .18, 'bandpass', 900, 300, .4, .7); }
    else if (kind === 'heal') [523, 784, 1047, 1568].forEach((f, k) => tone(now + k * .065, .4, 'triangle', f, 0, .22));
    else if (kind === 'whoosh') noise(now, .38, 'bandpass', 350, 2600, .3, 1.6);
    else if (kind === 'healwhoosh') { noise(now, .35, 'bandpass', 900, 3500, .15, 2); tone(now, .35, 'sine', 600, 1200, .08); }
  } catch {}
}
function lifeFx(src, to, d, cmd) {
  if (!d || !location.hash.startsWith('#/liv')) return;
  const tp = $(`.pl[data-p="${to}"]`), sp = src == null ? null : $(`.pl[data-p="${src}"]`);
  const heal = d > 0;
  const land = () => { sfx(heal ? 'heal' : cmd ? 'cmd' : 'hit'); fxPulse(tp, heal ? 'healfx' : 'hitfx'); if (heal) fxRise(tp); else if (tp) { const c = fxCenter(tp); fxSparks(c.x, c.y, false); } };
  // till sig själv, okänd källa eller lugnt läge: bara effekten på spelaren
  if (!tp || !sp || sp === tp || fxCalm() || !document.body.animate || fxLive > 8) return land();
  const a = fxCenter(sp), b = fxCenter(tp);
  const bolt = document.createElement('div'); bolt.className = 'fx-bolt' + (heal ? ' heal' : cmd ? ' cmd' : '');
  document.body.appendChild(bolt); fxLive++; sfx(heal ? 'healwhoosh' : 'whoosh');
  // båge: kontrollpunkt vinkelrätt mot linjen
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1, bend = Math.min(120, len * .35) * (Math.random() < .5 ? -1 : 1);
  const cx = (a.x + b.x) / 2 - (dy / len) * bend, cy = (a.y + b.y) / 2 + (dx / len) * bend;
  const frames = Array.from({ length: 13 }, (_, k) => { const t = k / 12, u = 1 - t; const x = u * u * a.x + 2 * u * t * cx + t * t * b.x, y = u * u * a.y + 2 * u * t * cy + t * t * b.y; return { transform: `translate(${x}px, ${y}px) scale(${.7 + Math.sin(t * Math.PI) * .6})` }; });
  const done = () => { bolt.remove(); fxLive--; land(); };
  const an = bolt.animate(frames, { duration: Math.min(650, 300 + len * .6), easing: 'cubic-bezier(.4,0,.7,1)' });
  an.onfinish = done; an.oncancel = () => { bolt.remove(); fxLive--; };
}
// summan av livändringar i rad visas en liten stund, nollas efter 5 s utan nya ändringar
const lifeDelta = {};
function paintDelta(i) {
  const el = $(`.pl[data-p="${i}"] .ldelta`), x = lifeDelta[i]; if (!el) return;
  el.hidden = !x; if (!x) return;
  el.textContent = x.sum > 0 ? '+' + x.sum : x.sum < 0 ? '−' + -x.sum : '±0';
  el.className = 'ldelta ' + (x.sum < 0 ? 'neg' : 'pos');
  el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
}
function showDelta(i, d) {
  const x = lifeDelta[i] = lifeDelta[i] || { sum: 0 };
  x.sum += d; clearTimeout(x.t);
  x.t = setTimeout(() => { delete lifeDelta[i]; paintDelta(i); }, 5000);
  paintDelta(i);
}
function clearDeltas() { for (const k in lifeDelta) { clearTimeout(lifeDelta[k].t); delete lifeDelta[k]; } }
function updateRoomBar() { const el = $('#lPeers'); if (el) el.textContent = room.err ? 'ingen anslutning' : livePeers() ? `${livePeers() + 1} anslutna` : 'väntar på de andra…'; }
// rita om bara siffrorna, så att pågående tryck inte avbryts
function lifeRedraw() {
  const s = lifeState();
  if (!location.hash.startsWith('#/liv') || !s?.players || !$('.life')) return;
  if ($$('.pl').length !== s.players.length) return render();
  s.players.forEach((p, i) => {
    const pl = $(`.pl[data-p="${i}"]`); if (!pl) return;
    const old = +$('.lifeval', pl).textContent;
    if (old !== p.life) showDelta(i, p.life - old);
    $('.lifeval', pl).textContent = p.life;
    $('.pname', pl).textContent = p.name;
    $('.extra', pl).innerHTML = lifeExtra(p, s);
    pl.classList.toggle('out', isOut(p, s));
  });
  if (!$('#modal').hidden && $('.modal-box').dataset.lifeMore != null) lifeMore(+$('.modal-box').dataset.lifeMore);
}
const lifeExtra = (p, s) => `${s.starter != null && s.players[s.starter] === p ? '<span title="Slog högst och börjar">🎲 börjar</span>' : ''}${MARKS.map(([k, ic, l]) => s.marks?.[k] != null && s.players[s.marks[k]] === p ? `<span title="${l}">${ic} ${l.toLowerCase()}</span>` : '').join('')}${p.poison ? `<span title="Gift">☠ ${p.poison}</span>` : ''}${CTRS.map(([k, ic, l]) => p.ctr?.[k] ? `<span title="${l}">${ic} ${k === 'tax' ? '+' + p.ctr[k] * 2 : p.ctr[k]}</span>` : '').join('')}${Object.entries(p.tok || {}).map(([t, v]) => `<span title="Tokens">◆ ${esc(t.replace(/ \d+\/\d+$/, ''))} ${v}</span>`).join('')}${s.players.map((_, j) => p.cmd[j] ? `<span title="Befälhavarskada från ${esc(s.players[j].name)}">⚔ ${esc(s.players[j].name.slice(0, 8))} ${p.cmd[j]}</span>` : '').join('')}`;

function viewLife(code) {
  setNav('matcher');
  let s = lifeState();
  // anslut till en delad räknare via länk eller kod
  if (code && (!s || s.room !== code)) {
    if (!window.LV_CHANNEL) { $('#app').innerHTML = '<div class="card empty">Delad livräknare kräver molnversionen och inloggning.</div>'; return; }
    lifeState.s = s = { room: code, synced: false, me: null, myDeck: s?.myDeck || s?.setup?.deck || '' };
    saveLife();
  }
  if (s?.room) roomJoin(s.room);
  if (s?.room && !s.players) {
    document.body.classList.remove('life-on');
    $('#app').innerHTML = `<div class="card" style="max-width:520px;margin:0 auto"><h1>Ansluter till ${esc(s.room)}…</h1>
      <p class="muted">Väntar på att någon vid bordet skickar räknaren. Den som startade matchen behöver ha appen öppen.</p>
      <button class="btn" id="lQuit">Avbryt</button></div>`;
    clearTimeout(viewLife.t); viewLife.t = setTimeout(() => { if (!lifeState()?.players && room.ch) roomSend({ t: 'hello' }); }, 3000);
    $('#lQuit').onclick = () => { roomLeave(); lifeState.s = { setup: s.setup }; saveLife(); location.hash = '#/matcher'; };
    return;
  }
  // välj vilken spelare man är (delad räknare)
  if (s?.room && s.players && (s.me == null || !s.players[s.me])) {
    document.body.classList.remove('life-on');
    const taken = s.seats || {};
    $('#app').innerHTML = `<div class="card" style="max-width:520px;margin:0 auto"><h1>Vem är du?</h1>
      <div class="grid">${s.players.map((p, i) => `<button class="btn ${p.uid && p.uid === S.profile?.id ? 'primary' : ''}" data-seat="${i}">${esc(p.name)}${p.uid && p.uid === S.profile?.id ? ' (du)' : ''}${taken[i] && taken[i] !== CID ? ' <span class="muted small">(vald av någon)</span>' : ''}</button>`).join('')}</div>
      <p><label class="small">Ditt namn<br><input type="text" id="lMyName" maxlength="20" placeholder="Lämna tomt för att behålla" style="width:100%" value="${esc(S.profile?.name || '')}"></label></p>
      <p><label class="small">Min lek (för spelloggen)<br><select id="lDeck" style="width:100%"><option value="">Logga inte matchen</option>${S.decks.map(d => `<option value="${d.id}" ${d.id === (s.myDeck || lastDeckId()) ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></label></p></div>`;
    $('#app').onclick = e => {
      const b = e.target.closest('[data-seat]'); if (!b) return;
      $('#app').onclick = null;
      const i = +b.dataset.seat, name = $('#lMyName').value.trim();
      s.me = i; s.myDeck = $('#lDeck').value; s.seats = { ...(s.seats || {}), [i]: CID };
      const nm = s.players[i].uid ? '' : name; // användarnamn ändras inte
      if (nm) s.players[i].name = nm;
      saveLife(); roomSend({ t: 'seat', p: i, name: nm }); render();
    };
    return;
  }
  if (!s || !s.players) {
    document.body.classList.remove('life-on');
    const last = s?.setup || { n: 4, life: 40, names: ['Jag', '', '', '', '', ''], deck: S.decks[0]?.id || '' };
    $('#app').innerHTML = `<div class="card" style="max-width:520px;margin:0 auto"><div class="row"><a href="#/matcher" class="icon-btn" aria-label="Tillbaka">←</a><h1 style="margin:0">Livräknare</h1></div>
      <p class="row"><label class="small">Spelare<br><select id="lN">${[2, 3, 4, 5, 6].map(n => `<option ${n === last.n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <label class="small">Startliv<br><select id="lL">${[40, 30, 25, 20].map(n => `<option ${n === last.life ? 'selected' : ''}>${n}</option>`).join('')}</select></label></p>
      <div id="lNames"></div>
      <p><label class="small">Min lek (för spelloggen)<br><select id="lDeck" style="width:100%"><option value="">Logga inte matchen</option>${S.decks.map(d => `<option value="${d.id}" ${d.id === last.deck ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></label></p>
      ${window.LV_CHANNEL ? `<p><label class="small"><input type="checkbox" id="lShare" ${last.share ? 'checked' : ''}> Dela räknaren – alla vid bordet ser och ändrar den i sina egna telefoner</label></p>` : ''}
      <p class="row"><span class="spacer"></span><button class="btn primary" id="lGo">Starta</button></p>
      ${window.LV_CHANNEL ? `<h3>Gå med i någon annans räknare</h3><div class="row"><input type="text" id="lCode" maxlength="6" placeholder="Kod, t.ex. K7Q2XM" style="text-transform:uppercase;width:9rem"><button class="btn" id="lJoin">Gå med</button></div>` : ''}
      <p class="muted small">Skärmen hålls tänd medan räknaren är öppen. Tryck på ⋯ för gift, befälhavarskada, monark, räknare och tokens. Allt sparas i telefonen om sidan laddas om.</p></div>`;
    // inloggad: spelarna väljs bland användarna, så att matchen loggas hos alla
    const users = useUsers() ? [...S.users.filter(u => u.id !== S.profile.id), { id: S.profile.id, name: S.profile.name || 'Jag' }].sort((a, b) => a.name.localeCompare(b.name, 'sv')) : null;
    const pick = k => last.uids?.[k] ?? (k === 0 ? S.profile.id : '');
    const names = () => {
      const n = +$('#lN').value;
      $('#lNames').innerHTML = users ? `${Array.from({ length: n }, (_, k) => `<p><select data-pu="${k}" style="width:100%"><option value="">Välj spelare ${k + 1}…</option>${users.map(u => `<option value="${u.id}" ${pick(k) === u.id ? 'selected' : ''}>${esc(u.name)}${u.id === S.profile.id ? ' (du)' : ''}</option>`).join('')}</select></p>`).join('')}
        ${S.profile.name ? '' : '<p class="small" style="color:var(--bad)">Skriv ditt namn under <a href="#/installningar">Inställningar</a> först.</p>'}
        <p class="muted small">Bara de som har ett konto med namn i Lekverkstan går att välja. Matchen loggas hos alla, och var och en väljer sin lek i spelloggen efteråt.</p>`
        : Array.from({ length: n }, (_, i) => `<p><input type="text" data-pn="${i}" maxlength="20" placeholder="Spelare ${i + 1}" value="${esc(last.names[i] || '')}" style="width:100%"></p>`).join('');
    };
    names(); $('#lN').onchange = names;
    $('#lDeck').onchange = e => { const d = S.decks.find(x => x.id === e.target.value); if (d) $('#lL').value = d.format === 'modern' ? '20' : '40'; };
    if ($('#lJoin')) $('#lJoin').onclick = () => { const c = $('#lCode').value.trim().toUpperCase(); if (/^[A-Z0-9]{6}$/.test(c)) location.hash = '#/liv/' + c; else toast('Koden är 6 tecken'); };
    $('#lGo').onclick = () => {
      const n = +$('#lN').value, life = +$('#lL').value, share = !!$('#lShare')?.checked;
      let nm, uids;
      if (users) {
        uids = $$('[data-pu]').map(x => x.value);
        if (uids.some(x => !x)) return toast('Välj alla spelare');
        if (uids.includes(S.profile.id) && !S.profile.name) return toast('Skriv ditt namn under Inställningar först');
        if (new Set(uids).size !== uids.length) return toast('Samma spelare är vald två gånger');
        nm = uids.map(id => (id === S.profile.id ? S.profile.name : S.users.find(u => u.id === id)?.name || 'Okänd').slice(0, 20));
      } else nm = $$('[data-pn]').map((i, k) => i.value.trim() || `Spelare ${k + 1}`);
      lifeState.s = { setup: { n, life, names: nm, uids, deck: $('#lDeck').value, share }, start: Date.now(), players: nm.map((name, k) => ({ name, uid: uids?.[k], life, poison: 0, cmd: {}, ctr: {}, tok: {} })), applied: [], marks: {} };
      const mine = uids ? Math.max(0, uids.indexOf(S.profile.id)) : 0;
      if (share) Object.assign(lifeState.s, { room: roomCode(), me: mine, myDeck: $('#lDeck').value, synced: true, seats: { [mine]: CID } });
      saveLife();
      if (share) { roomJoin(lifeState.s.room); location.hash = '#/liv/' + lifeState.s.room; } else render();
    };
    return;
  }
  document.body.classList.add('life-on');
  wakeLock(true);
  const n = s.players.length, sh = !!s.room;
  // en telefon mitt på bordet: övre halvan vänds mot spelarna på andra sidan. Delad: ingen vänds, min spelare först.
  const top = sh ? 0 : n === 2 ? 1 : Math.floor(n / 2);
  $('#app').innerHTML = `<div class="life n${n} ${sh ? 'shared' : ''}">${s.players.map((p, i) => `
    <div class="pl ${i < top ? 'flip' : ''} ${isOut(p, s) ? 'out' : ''} ${sh && i === s.me ? 'mine' : ''}" data-p="${i}">
      <div class="pname">${esc(p.name)}</div>
      <button class="hit minus" data-d="-1" aria-label="Minus ett liv"></button><button class="hit plus" data-d="1" aria-label="Plus ett liv"></button>
      <div class="lifeval">${p.life}</div><div class="ldelta" hidden></div>
      <div class="extra">${lifeExtra(p, s)}</div>
      <button class="more" data-more aria-label="Gift, befälhavarskada, räknare och tokens">⋯</button>
    </div>`).join('')}
    <div class="lbar">${sh ? `<button class="btn small" id="lInvite" title="Bjud in de andra">Kod ${esc(s.room)}</button><span class="small" id="lPeers" style="color:#aaa"></span>` : ''}<button class="btn small" id="lSound" title="Ljud på/av" aria-label="Ljud ${soundOn() ? 'på' : 'av'}">${soundOn() ? '🔊' : '🔇'}</button><button class="btn small" id="lDice" title="Vem börjar?" aria-label="Slå tärning om vem som börjar">🎲</button><button class="btn small" id="lEnd">Avsluta</button><button class="btn small" id="lReset">Börja om</button><button class="btn small" id="lExit">Stäng</button></div></div>`;
  updateRoomBar();
  s.players.forEach((_, i) => paintDelta(i));
  const life = $('.life');
  // håll inne = ±10 i taget
  let hold, held;
  const change = (i, d) => { lifeOp(i, 'life', d); lifeRedraw(); };
  life.addEventListener('pointerdown', e => {
    if (soundOn()) audio(); // låser upp ljudet på telefonen
    const b = e.target.closest('.hit'); if (!b) return;
    const i = +b.closest('.pl').dataset.p, d = +b.dataset.d;
    held = false; clearInterval(hold);
    hold = setTimeout(() => { held = true; change(i, d * 10); hold = setInterval(() => change(i, d * 10), 600); }, 500);
  });
  const up = () => { clearTimeout(hold); clearInterval(hold); };
  life.addEventListener('pointerup', up); life.addEventListener('pointercancel', up); life.addEventListener('pointerleave', up);
  life.addEventListener('click', e => {
    const b = e.target.closest('.hit');
    if (b) { if (!held) change(+b.closest('.pl').dataset.p, +b.dataset.d); held = false; return; }
    const m = e.target.closest('[data-more]');
    if (m) return lifeMore(+m.closest('.pl').dataset.p);
  });
  if ($('#lInvite')) $('#lInvite').onclick = async () => {
    const url = location.origin + location.pathname + '#/liv/' + s.room;
    try {
      if (navigator.share) await navigator.share({ title: 'Livräknare', text: 'Gå med i livräknaren, kod ' + s.room, url });
      else { await navigator.clipboard.writeText(url); toast('Länken är kopierad – skicka den till de andra'); }
    } catch {}
  };
  $('#lReset').onclick = () => {
    if (!confirm('Börja om med samma spelare?')) return;
    for (const p of s.players) Object.assign(p, { life: s.setup.life, poison: 0, cmd: {}, ctr: {}, tok: {} });
    s.start = Date.now(); s.applied = []; s.starter = undefined; s.marks = {}; clearDeltas(); saveLife();
    if (sh) roomSend({ t: 'reset', state: Object.fromEntries(shared.map(k => [k, s[k]])) });
    render();
  };
  $('#lExit').onclick = () => { wakeLock(false); document.body.classList.remove('life-on'); location.hash = '#/matcher'; };
  $('#lEnd').onclick = () => lifeEnd();
  $('#lDice').onclick = () => lifeRoll();
  $('#lSound').onclick = e => {
    const on = !soundOn(); try { localStorage.setItem('lv-sound', on ? '1' : '0'); } catch {}
    e.currentTarget.textContent = on ? '🔊' : '🔇'; e.currentTarget.setAttribute('aria-label', 'Ljud ' + (on ? 'på' : 'av'));
    if (on) { audio(); sfx('heal'); } toast(on ? 'Ljudet är på' : 'Ljudet är av');
  };
}
// ---- vem börjar: alla slår en d20, högst börjar, de som delar högsta slår om ----
const d20 = () => 1 + crypto.getRandomValues(new Uint32Array(1))[0] % 20;
function rollStart(n) {
  const rolls = Array.from({ length: n }, () => [d20()]);
  let tied = [...rolls.keys()];
  for (;;) {
    const best = Math.max(...tied.map(i => rolls[i].at(-1)));
    tied = tied.filter(i => rolls[i].at(-1) === best);
    if (tied.length === 1 || rolls[0].length >= 10) return { rolls, win: tied[0] };
    for (const i of tied) rolls[i].push(d20());
  }
}
function lifeRoll() {
  const s = lifeState(), res = rollStart(s.players.length);
  const by = s.room ? s.players[s.me]?.name || '' : '';
  if (s.room) roomSend({ t: 'dice', res, by });
  lifeDice(res);
}
// tärningen rullar i varje spelares ruta (vänd mot spelaren), sedan lyser vinnaren
function lifeDice(res, by = '') {
  const s = lifeState();
  if (!s?.players?.[res.win]) return;
  const run = lifeDice.run = (lifeDice.run || 0) + 1;
  $$('.die').forEach(e => e.remove());
  if (!location.hash.startsWith('#/liv') || !$('.life')) return lifeDiceDone(res, by);
  s.starter = undefined; saveLife(); lifeRedraw();
  const rounds = Math.max(...res.rolls.map(r => r.length));
  const dice = s.players.map((_, i) => {
    const el = document.createElement('div'); el.className = 'die'; el.innerHTML = '<span></span>';
    $(`.pl[data-p="${i}"]`)?.append(el); return el;
  });
  const step = round => {
    if (run !== lifeDice.run) return;
    if (round === rounds) return finish();
    const rolling = res.rolls.map((r, i) => (r.length > round ? i : -1)).filter(i => i >= 0);
    if (round) toast('Lika! De som delar högsta slår om', 1500);
    dice.forEach((el, i) => el.classList.toggle('dim', !rolling.includes(i)));
    rolling.forEach(i => { dice[i].classList.remove('done'); dice[i].classList.add('rolling'); });
    const spin = setInterval(() => rolling.forEach(i => (dice[i].firstChild.textContent = d20())), 70);
    setTimeout(() => {
      clearInterval(spin); if (run !== lifeDice.run) return;
      rolling.forEach(i => { dice[i].classList.replace('rolling', 'done'); dice[i].firstChild.textContent = res.rolls[i][round]; });
      setTimeout(() => step(round + 1), round + 1 < rounds ? 1200 : 400);
    }, 1200);
  };
  const finish = () => {
    dice.forEach((el, i) => { el.classList.toggle('win', i === res.win); el.classList.toggle('dim', i !== res.win); });
    lifeDiceDone(res, by);
    setTimeout(() => { if (run === lifeDice.run) dice.forEach(e => e.remove()); }, 3000);
  };
  step(0);
}
function lifeDiceDone(res, by) {
  const s = lifeState();
  s.starter = res.win; saveLife(); lifeRedraw();
  if (location.hash.startsWith('#/liv')) toast(`🎲 ${by ? by + ' slog – ' : ''}${s.players[res.win].name} börjar!`, 3500);
}
function lifeMore(i) {
  const s = lifeState(), p = s.players[i];
  const val = (key, j, n) => key === 'poison' ? p.poison : key === 'cmd' ? p.cmd[j] || 0 : key === 'ctr' ? p.ctr?.[CTRS[j][0]] || 0 : p.tok?.[n] || 0;
  const row = (label, key, j, n) => `<div class="row" style="justify-content:space-between"><span>${label}</span><span class="row"><button class="btn small" data-k="${key}" data-j="${j ?? ''}" data-n="${esc(n || '')}" data-d="-1">−</button><b style="min-width:2rem;text-align:center">${val(key, j, n)}</b><button class="btn small" data-k="${key}" data-j="${j ?? ''}" data-n="${esc(n || '')}" data-d="1">+</button></span></div>`;
  const toks = Object.keys(p.tok || {});
  const draft = $('#tokName')?.value || '';
  openModal(`<div class="row"><h2 style="margin:0">${esc(p.name)}</h2><span class="spacer"></span><button class="icon-btn" data-close aria-label="Stäng">✕</button></div>
    <h3>Markörer</h3><div class="row">${MARKS.map(([k, ic, l, why], j) => `<button class="btn small ${s.marks?.[k] === i ? 'primary' : ''}" data-k="mark" data-j="${j}" data-d="1" title="${esc(why)}">${ic} ${l}${s.marks?.[k] != null && s.marks[k] !== i && s.players[s.marks[k]] ? ` <span class="small">(${esc(s.players[s.marks[k]].name)})</span>` : ''}</button>`).join('')}</div>
    <p class="muted small" style="margin:.2rem 0">Bara en spelare i taget. Tryck för att ta över, tryck igen för att ta bort.</p>
    <h3>Gift</h3>${row('☠ Giftmarkörer (10 = ute)', 'poison')}
    <h3>Befälhavarskada (21 = ute)</h3>${s.players.map((o, j) => j === i ? '' : row('⚔ från ' + esc(o.name), 'cmd', j)).join('')}
    <p class="muted small">Befälhavarskada drar också av liv.</p>
    <h3>Räknare</h3>${CTRS.map(([k, ic, l], j) => row(`${ic} ${l}${k === 'tax' ? ` <span class="muted small">(spelad ur command zone, kostar +${(p.ctr?.tax || 0) * 2})</span>` : ''}`, 'ctr', j)).join('')}
    <h3>Tokens</h3>${toks.map(t => row('◆ ' + esc(t), 'tok', '', t)).join('') || '<p class="muted small" style="margin:.2rem 0">Inga tokens.</p>'}
    <div class="row small" style="flex-wrap:wrap;margin-top:.4rem">${TOKENS.filter(t => !toks.includes(t)).map(t => `<button class="btn small" data-k="tok" data-n="${esc(t)}" data-d="1">+ ${esc(t)}</button>`).join('')}</div>
    <div class="row" style="margin-top:.4rem"><input type="text" id="tokName" maxlength="24" placeholder="Annan token, t.ex. Dragon 4/4" style="flex:1" value="${esc(draft)}"><button class="btn small" id="tokAdd">Lägg till</button></div>`, box => {
    box.dataset.lifeMore = i;
    const addTok = () => { const n = cleanTok($('#tokName', box).value); if (!n) return; $('#tokName', box).value = ''; lifeOp(i, 'tok', 1, undefined, n); lifeMore(i); lifeRedraw(); };
    $('#tokName', box).onkeydown = e => { if (e.key === 'Enter') addTok(); };
    box.onclick = e => {
      if (e.target.closest('#tokAdd')) return addTok();
      const b = e.target.closest('[data-k]'); if (!b) return;
      const k = b.dataset.k;
      lifeOp(i, k, +b.dataset.d, ['cmd', 'ctr', 'mark'].includes(k) ? +b.dataset.j : undefined, k === 'tok' ? b.dataset.n : undefined);
      lifeMore(i); lifeRedraw();
    };
  });
}
const lastDeckId = () => S.decks.slice().sort((a, b) => b.updated - a.updated)[0]?.id || '';
// konton utan namn syns inte för de andra (spelare i livräknaren, bytesbörsen), så fråga en gång per besök
function askName() {
  if (S.profile?.name || sessionStorage.getItem('lv-askname') || !$('#modal').hidden) return;
  try { sessionStorage.setItem('lv-askname', '1'); } catch {}
  openModal(`<h2 style="margin-top:0">Vad heter du?</h2>
    <p class="muted small">Namnet visas för kompisarna, så att de kan välja dig som spelare i livräknaren och se vem som har kort till byte.</p>
    <p><input type="text" id="anName" maxlength="20" placeholder="T.ex. Jonte" style="width:100%"></p>
    <p class="row"><span class="spacer"></span><button class="btn" data-close>Senare</button><button class="btn primary" id="anSave">Spara</button></p>`, box => {
    $('#anName', box).focus();
    $('#anName', box).onkeydown = e => { if (e.key === 'Enter') $('#anSave', box).click(); };
    $('#anSave', box).onclick = async () => {
      const name = $('#anName', box).value.trim(); if (!name) return toast('Skriv ett namn');
      try { await api('/api/profile', { method: 'PUT', body: { name } }); S.profile.name = name; closeModal(); toast('Namnet är sparat'); }
      catch (err) { toast('Kunde inte spara: ' + err.message, 4000); }
    };
  });
}
const useUsers = () => !!(S.cloud && S.v10 && S.profile?.id && S.users?.length);
function lifeEnd() {
  const s = lifeState();
  const alive = s.players.map((p, i) => ({ p, i })).filter(x => !isOut(x.p, s));
  const myDeck = s.room ? s.myDeck : s.setup.deck;
  openModal(`<div class="row"><h2 style="margin:0">Vem vann?</h2><span class="spacer"></span><button class="icon-btn" data-close aria-label="Stäng">✕</button></div>
    <div class="grid" style="margin-top:.6rem">${s.players.map((p, i) => `<button class="btn ${alive.length === 1 && alive[0].i === i ? 'primary' : ''}" data-win="${i}">${esc(p.name)}</button>`).join('')}<button class="btn" data-win="draw">Oavgjort</button></div>
    <p class="muted small">${myDeck ? 'Matchen sparas i spelloggen med din lek.' : 'Ingen lek vald, matchen sparas inte i spelloggen.'}${s.room ? ' Matchen avslutas för alla vid bordet, och var och en sparar den i sin egen spellogg.' : ''}</p>
    <div class="row" style="margin-top:.8rem"><span class="spacer"></span><button class="btn small" id="lAbort">Avbryt matchen utan resultat</button></div>`, box => {
    $('#lAbort', box).onclick = () => {
      if (!confirm('Avbryta matchen? Den sparas inte i spelloggen.')) return;
      if (s.room) roomSend({ t: 'end', win: null, by: s.players[s.me]?.name });
      lifeFinish(null);
    };
    box.onclick = e => {
      const b = e.target.closest('[data-win]'); if (!b) return;
      if (s.room) roomSend({ t: 'end', win: b.dataset.win, by: s.players[s.me]?.name });
      lifeFinish(b.dataset.win);
    };
  });
}
// matchen är slut (här eller hos någon annan vid bordet): spara i egen spellogg och stäng
async function lifeFinish(w, by) {
  const s = lifeState();
  if (!s?.players) return;
  // en telefon: jag är den plats där mitt konto är valt (eller plats 1 utan konton). Är jag inte med sparas inget hos mig.
  const myIdx = s.setup?.uids ? s.setup.uids.indexOf(S.profile?.id) : 0;
  const me = s.room ? s.me : myIdx >= 0 ? myIdx : null, d = S.decks.find(x => x.id === (s.room ? s.myDeck : s.setup.deck));
  if (w != null && d && me != null) {
    const result = w === 'draw' ? 'draw' : +w === me ? 'win' : 'loss';
    const mins = Math.round((Date.now() - s.start) / 60000);
    const uids = s.players.map(p => p.uid), mid = 'liv-' + Math.round(s.start);
    const linked = !!(S.v10 && uids.every(Boolean) && uids[me] === S.profile?.id);
    try {
      const g = await api('/api/games', { method: 'POST', body: { deck_id: d.id, deck_name: d.name, result, players: s.players.length, match_id: linked ? mid : undefined,
        opponents: s.players.filter((_, i) => i !== me).map(p => p.name).join(', '), notes: `Livräknare: ${w === 'draw' ? 'oavgjort' : s.players[+w].name + ' vann'}, ${mins} min` } });
      S.games = [g, ...S.games.filter(x => x.id !== g.id)];
      let msg = 'Matchen är sparad';
      if (linked) {
        try { const k = await api('/api/match-log', { method: 'POST', body: { match: mid, players: uids, winner: w === 'draw' ? null : +w, minutes: mins } }); if (k) msg = 'Matchen är sparad hos alla'; }
        catch (err) { msg = 'Sparad hos dig, men inte hos de andra: ' + err.message; }
      }
      toast(msg, 4000);
    } catch (err) { toast('Kunde inte spara: ' + err.message, 4000); }
  } else if (by) toast(w == null ? `${by} avbröt matchen` : 'Matchen är slut');
  else if (w == null) toast('Matchen avbröts');
  roomLeave();
  lifeState.s = { setup: s.setup, myDeck: s.myDeck }; saveLife();
  if (!location.hash.startsWith('#/liv')) return;
  closeModal(); wakeLock(false); document.body.classList.remove('life-on');
  location.hash = '#/matcher';
}

// ---------- regler ----------
const RULES_SV = {
  commander: `<h2>Commander i korthet</h2>
    <ul>
      <li><b>Leken:</b> exakt 100 kort inklusive befälhavaren. Bara ett exemplar av varje kort, utom basländer och kort som säger något annat (t.ex. Relentless Rats).</li>
      <li><b>Befälhavaren:</b> en legendarisk varelse, eller ett kort där det står att det kan vara befälhavare. Två befälhavare går bara med t.ex. <i>Partner</i>, <i>Friends forever</i>, <i>Choose a Background</i> eller <i>Doctor's companion</i>.</li>
      <li><b>Färgidentitet:</b> alla kort i leken måste hålla sig inom befälhavarens färgidentitet. Den räknas från manakostnaden <i>och</i> manasymboler i regeltexten.</li>
      <li><b>Start:</b> 40 liv. Befälhavaren börjar i <i>command zone</i>, utanför leken.</li>
      <li><b>Commander tax:</b> du kan spela befälhavaren från command zone. Den kostar {2} mer för varje gång du redan spelat den därifrån.</li>
      <li><b>Tillbaka till command zone:</b> om befälhavaren skulle hamna på kyrkogården, i exil, på handen eller i biblioteket får du flytta den till command zone i stället.</li>
      <li><b>Befälhavarskada:</b> en spelare som fått 21 stridsskada från samma befälhavare under matchen förlorar.</li>
      <li><b>Mulligan:</b> London-mulligan (dra 7, lägg lika många kort som du tagit mulligan under biblioteket). I multiplayer är första mulligan gratis.</li>
      <li><b>Förlust:</b> 0 liv, 10 giftmarkörer, 21 befälhavarskada, eller att du ska dra ur ett tomt bibliotek.</li>
      <li><b>Multiplayer:</b> alla mot alla. Du får attackera vilka motståndare du vill, och fördela anfallarna mellan dem.</li>
    </ul>`,
  turn: `<h2>Turens delar</h2>
    <ol>
      <li><b>Början:</b> <i>untap</i> (vänd upp dina kort), <i>upkeep</i> (förmågor som triggar "at the beginning of your upkeep"), <i>draw</i> (dra ett kort). I en match med två spelare drar den som börjar inget kort första turen. I multiplayer drar alla.</li>
      <li><b>Första huvudfasen:</b> spela länder (ett per tur), varelser, sorceries och andra kort.</li>
      <li><b>Strid:</b> början på striden → välj anfallare → försvararen väljer blockerare → skada (first strike delar ut skada före övriga) → slut på striden.</li>
      <li><b>Andra huvudfasen:</b> samma som den första.</li>
      <li><b>Slut:</b> <i>end step</i> (förmågor som triggar "at the beginning of the end step"), sedan <i>cleanup</i>: släng ner till 7 kort på handen, skada på varelser försvinner och "until end of turn"-effekter tar slut.</li>
    </ol>
    <h2>Stacken och prioritet</h2>
    <ul>
      <li>Spells och förmågor läggs på <b>stacken</b>. Alla får chans att svara (prioritet). Det som lades sist löses först.</li>
      <li><b>Instants</b> och förmågor kan spelas när du har prioritet, även på andras tur. Sorceries, varelser och liknande bara i din egen huvudfas när stacken är tom.</li>
      <li><b>Manaförmågor</b> (t.ex. att tappa ett land för mana) går inte via stacken och kan inte svaras på.</li>
      <li><b>Triggade förmågor</b> ("when", "whenever", "at") läggs på stacken nästa gång någon skulle få prioritet. Triggar flera samtidigt väljer varje spelare ordningen på sina egna.</li>
      <li>Ett spell som motverkas (<i>countered</i>) gör ingenting och läggs på kyrkogården.</li>
    </ul>`,
  brackets: `<h2>Commander Brackets</h2>
    <p class="muted">Wizards indelning för att hitta jämna matcher. Prata alltid ihop er före matchen – siffran är en hjälp, inte en regel.</p>
    <table><tbody>
      <tr><td><b>1</b></td><td><b>Exhibition</b> – tema och skoj före styrka. Inga game changers, ingen massförstörelse av länder, inga kombos med två kort, inga extra turer i följd.</td></tr>
      <tr><td><b>2</b></td><td><b>Core</b> – ungefär som en förbyggd lek från butiken. Inga game changers, ingen massförstörelse av länder, inga kombos med två kort, inga extra turer i följd.</td></tr>
      <tr><td><b>3</b></td><td><b>Upgraded</b> – genomtänkta och uppgraderade lekar. Högst 3 game changers, ingen massförstörelse av länder, inga kombos med två kort tidigt i matchen, inga extra turer i följd.</td></tr>
      <tr><td><b>4</b></td><td><b>Optimized</b> – så starkt som möjligt, bara banlistan gäller.</td></tr>
      <tr><td><b>5</b></td><td><b>cEDH</b> – turneringsnivå med metan i fokus.</td></tr>
    </tbody></table>
    <p class="small muted">Lekverkstan uppskattar bracket under Lista → Kontroll i varje Commander-lek.</p>`,
};
// vanliga nyckelord: engelska namnet (som på korten) och en kort förklaring
const KEYWORDS = [
  ['Flying', 'Kan bara blockeras av varelser med flying eller reach.'],
  ['Reach', 'Kan blockera varelser med flying.'],
  ['Trample', 'Skada utöver det som dödar blockerarna går vidare till spelaren (eller planeswalkern) som anfölls.'],
  ['Deathtouch', 'All skada från den här varelsen räcker för att döda en varelse, även 1 skada.'],
  ['Lifelink', 'Skada som varelsen gör ger dig lika mycket liv.'],
  ['First strike', 'Gör stridsskada före varelser utan first strike.'],
  ['Double strike', 'Gör stridsskada två gånger: både med first strike och i vanlig ordning.'],
  ['Vigilance', 'Tappas inte när den anfaller.'],
  ['Haste', 'Kan anfalla och använda tap-förmågor samma tur som den kom in.'],
  ['Menace', 'Kan bara blockeras av två eller fler varelser.'],
  ['Defender', 'Kan inte anfalla.'],
  ['Flash', 'Kan spelas när du kan spela en instant.'],
  ['Hexproof', 'Kan inte bli mål för motståndarnas spells eller förmågor.'],
  ['Shroud', 'Kan inte bli mål för några spells eller förmågor, inte ens dina egna.'],
  ['Ward', 'När den blir mål för en motståndares spell eller förmåga motverkas det, om inte motståndaren betalar ward-kostnaden.'],
  ['Indestructible', 'Förstörs inte av "destroy" eller dödlig skada. Kan fortfarande offras, exilas eller dö av −X/−X.'],
  ['Protection', '"Protection from X": kan inte skadas, förtrollas, blockeras eller bli mål av något som är X.'],
  ['Equip', 'Betala kostnaden för att fästa utrustningen på en egen varelse. Bara när du kan spela en sorcery.'],
  ['Cascade', 'När du spelar kortet: vänd kort från biblioteket tills du hittar ett som inte är land med lägre manavärde. Du får spela det gratis.'],
  ['Convoke', 'Varje varelse du tappar betalar {1} eller en mana i varelsens färg.'],
  ['Cycling', 'Betala kostnaden och släng kortet från handen för att dra ett nytt.'],
  ['Kicker', 'En extra kostnad du kan välja att betala för en starkare effekt.'],
  ['Flashback', 'Kan spelas från kyrkogården för flashback-kostnaden. Exilas sedan.'],
  ['Scry', '"Scry N": titta på de N översta korten i biblioteket och lägg valfria under, resten tillbaka i valfri ordning.'],
  ['Surveil', '"Surveil N": titta på de N översta korten och lägg valfria på kyrkogården, resten tillbaka i valfri ordning.'],
  ['Mill', '"Mill N": lägg de N översta korten i biblioteket på kyrkogården.'],
  ['Proliferate', 'Välj valfritt antal permanenter och spelare och ge dem ett extra av varje sorts markör de redan har.'],
  ['Treasure', 'Token-artefakt: tappa och offra den för en mana i valfri färg.'],
  ['Clue', 'Token-artefakt: betala {2} och offra den för att dra ett kort. "Investigate" skapar en.'],
  ['Food', 'Token-artefakt: betala {2}, tappa och offra den för 3 liv.'],
  ['Landfall', 'Triggar när ett land kommer in under din kontroll.'],
  ['Storm', 'När du spelar kortet kopieras det en gång för varje annat spell som spelats tidigare under turen.'],
  ['Affinity', '"Affinity for artifacts": kostar {1} mindre för varje artefakt du kontrollerar.'],
  ['Delve', 'Varje kort du exilar från kyrkogården betalar {1} av kostnaden.'],
  ['Crew', '"Crew N": tappa varelser med sammanlagd styrka N eller mer så blir fordonet en varelse tills turen är slut.'],
  ['Annihilator', '"Annihilator N": när varelsen anfaller offrar försvarande spelare N permanenter.'],
  ['Exile', 'Kortet läggs utanför spelet. Det är inte på kyrkogården och kan bara komma tillbaka om något säger det.'],
  ['Sacrifice', 'Offra: lägg en egen permanent på kyrkogården. Kan inte stoppas av indestructible.'],
  ['Counter', 'Motverka ett spell eller en förmåga på stacken, så att det inte gör något.'],
  ['Token', 'En permanent som inte är ett kort. Försvinner om den lämnar slagfältet.'],
  ['Summoning sickness', 'En varelse kan inte anfalla eller använda tap-förmågor förrän du kontrollerat den sedan början av din senaste tur (se Haste).'],
  ['Legend rule', 'Har du två legendariska permanenter med samma namn väljer du en att behålla och lägger den andra på kyrkogården.'],
  ['ETB', '"Enters the battlefield" – när kortet kommer in på slagfältet.'],
  ['Dies', 'När en varelse läggs från slagfältet på kyrkogården.'],
];

// regelboken hämtas en gång och sparas i webbläsarens cache i 30 dagar
async function loadRules() {
  if (loadRules.r) return loadRules.r;
  let data;
  try {
    const c = await caches.open('lv-rules'), hit = await c.match('rules');
    if (hit) { const j = await hit.json(); if (Date.now() - j.at < 30 * 864e5) data = j; }
  } catch {}
  if (!data) {
    data = { ...(await api('/api/rules')), at: Date.now() };
    try { await (await caches.open('lv-rules')).put('rules', new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } })); } catch {}
  }
  return (loadRules.r = { ...parseRules(data.text), url: data.url });
}
function parseRules(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const effective = (text.match(/These rules are effective as of ([^.]+)\./) || [])[1] || '';
  // innehållsförteckningen upprepar rubrikerna: själva reglerna börjar vid andra "Glossary"-fria förekomsten av 100.1.
  const start = lines.findIndex(l => /^100\.1\. /.test(l));
  const gStart = lines.findIndex((l, i) => i > start && /^Glossary\s*$/.test(l));
  const gEnd = lines.findIndex((l, i) => i > gStart && /^Credits\s*$/.test(l));
  const rules = [], sections = {};
  let sec = '';
  for (let i = Math.max(0, start - 6); i < (gStart > 0 ? gStart : lines.length); i++) {
    const l = lines[i].trim(); if (!l) continue;
    let m;
    if ((m = l.match(/^(\d)\. (.+)$/))) { sections[m[1]] = m[2]; continue; }
    if ((m = l.match(/^(\d{3})\. (.+)$/))) { sec = m[1]; sections[sec] = m[2]; continue; }
    if ((m = l.match(/^(\d{3}\.\d+[a-z]?)\.? (.+)$/))) { rules.push({ n: m[1], t: m[2], sec }); continue; }
    if (rules.length) rules[rules.length - 1].t += '\n' + l; // t.ex. "Example: …"
  }
  const glossary = [];
  if (gStart > 0) {
    let cur = null;
    for (let i = gStart + 1; i < (gEnd > 0 ? gEnd : lines.length); i++) {
      const l = lines[i].trim();
      if (!l) { cur = null; continue; }
      if (!cur) { cur = { term: l, t: '' }; glossary.push(cur); } else cur.t += (cur.t ? '\n' : '') + l;
    }
  }
  return { rules, sections, glossary, effective };
}
const ruleLinks = t => esc(t).replace(/\b(\d{3}\.\d+[a-z]?)\b/g, '<a href="#" data-rule="$1">$1</a>').replace(/\n/g, '<br>');
function hiliteRule(html, words) {
  // lookbehind finns inte i äldre Safari: då blir det bara ingen markering
  for (const w of words) if (w.length > 2) try { html = html.replace(new RegExp('(?![^<]*>)(?<!&[#a-z0-9]*)(' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi'), '<mark>$1</mark>'); } catch {}
  return html;
}

function viewRules(sub) {
  setNav('regler');
  const tabs = [['commander', 'Commander'], ['tur', 'Turen och stacken'], ['brackets', 'Brackets'], ['ord', 'Ordlista'], ['bok', 'Regelboken'], ['bannade', 'Bannade kort']];
  sub = tabs.some(t => t[0] === sub) ? sub : 'commander';
  $('#app').innerHTML = `<div class="row"><h1>Regler</h1></div>
    <div class="tabs">${tabs.map(([k, l]) => `<a class="${k === sub ? 'on' : ''}" href="#/regler/${k}">${l}</a>`).join('')}</div><div id="rl"></div>`;
  const rl = $('#rl');
  if (sub === 'commander' || sub === 'tur' || sub === 'brackets') {
    rl.innerHTML = `<div class="card rules" style="max-width:820px">${RULES_SV[sub === 'tur' ? 'turn' : sub]}
      <p class="small muted">Förenklad sammanfattning. Det exakta står i <a href="#/regler/bok">regelboken</a>.</p></div>`;
    return;
  }
  if (sub === 'ord') {
    const q = (viewRules.oq || '').toLowerCase();
    const mine = KEYWORDS.filter(([k, t]) => !q || k.toLowerCase().includes(q) || t.toLowerCase().includes(q));
    const gl = q && loadRules.r ? loadRules.r.glossary.filter(g => g.term.toLowerCase().includes(q)).slice(0, 30) : [];
    rl.innerHTML = `<div class="card" style="max-width:820px">
      <input type="search" id="oq" placeholder="Sök ett ord, t.ex. trample eller ward…" value="${esc(viewRules.oq || '')}" style="width:100%">
      ${mine.length ? `<table class="small" style="margin-top:.6rem"><tbody>${mine.map(([k, t]) => `<tr><td style="white-space:nowrap"><b>${esc(k)}</b></td><td>${esc(t)}</td></tr>`).join('')}</tbody></table>` : ''}
      ${q ? (loadRules.r ? (gl.length ? `<h3>I regelbokens ordlista (engelska)</h3>${gl.map(g => `<p class="small"><b>${esc(g.term)}</b><br>${ruleLinks(g.t)}</p>`).join('')}` : (mine.length ? '' : '<p class="muted">Inga träffar.</p>'))
        : '<p class="muted small">Hämtar regelbokens ordlista…</p>') : '<p class="muted small">Skriv ett ord för att även söka i regelbokens hela ordlista.</p>'}</div>`;
    const inp = $('#oq');
    inp.oninput = () => { viewRules.oq = inp.value; clearTimeout(viewRules.t); viewRules.t = setTimeout(() => { render(); const i = $('#oq'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 250); };
    if (q && !loadRules.r) loadRules().then(render).catch(e => toast('Kunde inte hämta regelboken: ' + e.message, 4000));
    rl.onclick = e => { const a = e.target.closest('[data-rule]'); if (a) { e.preventDefault(); viewRules.q = a.dataset.rule; location.hash = '#/regler/bok'; } };
    return;
  }
  if (sub === 'bok') {
    if (!loadRules.r) {
      rl.innerHTML = '<div class="card"><p class="muted">Hämtar regelboken från Wizards (ungefär 1 MB, sparas sedan i telefonen)…</p></div>';
      loadRules().then(render).catch(e => { rl.innerHTML = `<div class="card empty">Kunde inte hämta regelboken: ${esc(e.message)}</div>`; });
      return;
    }
    const R = loadRules.r, q = (viewRules.q || '').trim();
    let hits = [], note = '';
    if (/^\d{3}(\.\d+[a-z]?)?\.?$/.test(q)) {
      const n = q.replace(/\.$/, '');
      hits = R.rules.filter(r => r.n === n || r.n.startsWith(n + (n.includes('.') ? '' : '.')) || (n.includes('.') && /^\d{3}\.\d+$/.test(n) && r.n.startsWith(n) && /[a-z]$/.test(r.n)));
    } else if (q) {
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      hits = R.rules.filter(r => { const t = r.t.toLowerCase(); return words.every(w => t.includes(w)); });
      if (hits.length > 60) { note = `Visar 60 av ${hits.length} träffar – lägg till fler ord.`; hits = hits.slice(0, 60); }
    }
    const words = /^\d/.test(q) ? [] : q.split(/\s+/);
    rl.innerHTML = `<div class="card" style="max-width:900px">
      <div class="row"><input type="search" id="rq" placeholder="Sök på engelska, t.ex. commander tax, eller ett regelnummer som 903.8" value="${esc(q)}" style="flex:1"></div>
      <p class="small muted">Comprehensive Rules${R.effective ? `, gäller från ${esc(R.effective)}` : ''}. <a href="${esc(R.url)}" target="_blank" rel="noopener">Originalet hos Wizards</a></p>
      ${q ? (hits.length ? `${note ? `<p class="small warn">${esc(note)}</p>` : ''}${hits.map(r => `<div class="rule"><a href="#" data-rule="${r.n}"><b>${r.n}</b></a> <span class="muted small">${esc(R.sections[r.sec] || '')}</span><div>${hiliteRule(ruleLinks(r.t), words)}</div></div>`).join('')}` : '<p class="muted">Inga regler matchar.</p>')
        : `<h3>Snabbval</h3><div class="row small" style="flex-wrap:wrap">${[['903', 'Commander'], ['702', 'Nyckelord'], ['500', 'Turens delar'], ['506', 'Strid'], ['405', 'Stacken'], ['117', 'Prioritet'], ['104', 'Att vinna och förlora'], ['704', 'State-based actions'], ['613', 'Effekters ordning (lager)'], ['800', 'Multiplayer']].map(([n, l]) => `<a href="#" class="pill" data-rule="${n}">${n} ${l}</a>`).join('')}</div>`}</div>`;
    const inp = $('#rq');
    inp.oninput = () => { viewRules.q = inp.value; clearTimeout(viewRules.t); viewRules.t = setTimeout(() => { render(); const i = $('#rq'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 300); };
    rl.onclick = e => { const a = e.target.closest('[data-rule]'); if (a) { e.preventDefault(); viewRules.q = a.dataset.rule; render(); } };
    return;
  }
  // bannade kort och game changers från Scryfall
  const lists = [['banned:commander', 'Bannade i Commander'], ['banned:modern', 'Bannade i Modern'], ['is:gamechanger', 'Game changers (Commander)']];
  const which = viewRules.ban || lists[0][0];
  const data = (viewRules.banData = viewRules.banData || {})[which];
  rl.innerHTML = `<div class="card"><div class="seg" id="banSeg">${lists.map(([k, l]) => `<button data-ban="${k}" class="${k === which ? 'on' : ''}">${l}</button>`).join('')}</div>
    ${data ? `<p class="small muted">${data.length} kort${which === 'is:gamechanger' ? '. Game changers påverkar lekens bracket.' : ''}</p>
      <ul class="vgrid">${data.map(c => `<li data-name="${esc(c.name)}"><img loading="lazy" src="${esc(c.thumb)}" alt="${esc(c.name)}" data-img="${esc(c.image)}" data-open style="cursor:pointer"><div class="small">${esc(c.name)}</div></li>`).join('')}</ul>`
      : '<p class="muted">Hämtar från Scryfall…</p>'}</div>`;
  if (!data) api('/api/search?max=175&q=' + encodeURIComponent(which)).then(r => { viewRules.banData[which] = r.cards.sort((a, b) => a.name.localeCompare(b.name)); for (const c of r.cards) S.cards[c.name] = S.cards[c.name] || c; render(); }).catch(e => toast(e.message, 4000));
  rl.onclick = e => {
    const b = e.target.closest('[data-ban]'); if (b) { viewRules.ban = b.dataset.ban; return render(); }
    const o = e.target.closest('[data-open]'); if (o) cardModal(o.closest('li').dataset.name);
  };
}

// ---------- prislarm ----------
// Kort jag äger som stigit mycket (värdeloggen: senaste mätningen mot den närmast en vecka bakåt)
// och önskekort som blivit billigare än det högsta priset sedan senast (sparas i telefonen).
const alarmPct = () => { try { const v = localStorage.getItem('lv-alarm'); return v == null ? 25 : +v || 0; } catch { return 25; } };
const ALARM_MIN_KR = 20;
function priceRises() {
  const pct = alarmPct(), log = S.valueLog;
  if (!pct || !log || log.length < 2) return [];
  const now = log[0], cut = Date.parse(now.day) - 7 * 864e5;
  const then = log.find(x => Date.parse(x.day) <= cut) || log[log.length - 1];
  return Object.keys(now.prices || {}).filter(n => S.collection[n] && then.prices?.[n] > 0)
    .map(n => ({ name: n, from: then.prices[n], to: now.prices[n], since: then.day, day: now.day }))
    .filter(m => m.to >= m.from * (1 + pct / 100) && sek(m.to - m.from) >= ALARM_MIN_KR)
    .sort((a, b) => (b.to - b.from) - (a.to - a.from));
}
const wishBase = () => { try { return JSON.parse(localStorage.getItem('lv-wish-base') || '{}') || {}; } catch { return {}; } };
const saveWishBase = b => { try { localStorage.setItem('lv-wish-base', JSON.stringify(b)); } catch {} };
function wishDrops() {
  const pct = alarmPct(); if (!pct || !S.v3) return [];
  const base = wishBase(), out = []; let changed = false;
  for (const w of S.wishlist) {
    const e = S.cards[w.name]?.eur; if (e == null) continue;
    if (base[w.name] == null || e > base[w.name]) { base[w.name] = e; changed = true; continue; }
    if (e <= base[w.name] * (1 - pct / 100) && sek(base[w.name] - e) >= 5) out.push({ name: w.name, from: base[w.name], to: e });
  }
  for (const n of Object.keys(base)) if (!S.wishlist.some(w => w.name === n)) { delete base[n]; changed = true; }
  if (changed) saveWishBase(base);
  return out;
}
const riseSeen = () => { try { return localStorage.getItem('lv-rise-seen') || ''; } catch { return ''; } };
function markAlarmsSeen() {
  try { if (S.valueLog?.[0]) localStorage.setItem('lv-rise-seen', S.valueLog[0].day); } catch {}
  const base = wishBase();
  for (const d of wishDrops()) base[d.name] = d.to; // nästa larm räknas från dagens pris
  saveWishBase(base);
}
function alarmNotes() {
  const out = [], rises = priceRises();
  if (rises.length) {
    const m = rises[0], isNew = riseSeen() < m.day, up = x => Math.round((x.to / x.from - 1) * 100);
    out.push(rises.length === 1
      ? { at: Date.parse(m.day) || 0, href: '#/samling', isNew, text: `${m.name} har stigit i värde`, sub: `${krE(m.from)} → ${krE(m.to)} (+${up(m)} %) sedan ${m.since}` }
      : { at: Date.parse(m.day) || 0, href: '#/samling', isNew, text: `${rises.length} av dina kort har stigit i värde`, sub: rises.slice(0, 3).map(x => `${x.name} +${up(x)} %`).join(', ') + ` sedan ${m.since}` });
  }
  for (const d of wishDrops())
    out.push({ at: Date.now(), href: '#/onskelista', isNew: true, text: `${d.name} har blivit billigare`, sub: `${krE(d.from)} → ${krE(d.to)} · önskelistan` });
  return out;
}

// ---------- säkerhetskopia ----------
// Allt eget som en fil. Inläsning lägger bara till det som saknas, inget tas bort eller skrivs över.
function backupData() {
  return {
    app: 'lekverkstan', version: 1, exported: new Date().toISOString(),
    decks: S.decks.map(d => ({ id: d.id, name: d.name, format: d.format, notes: d.notes || '', cards: d.cards, versions: d.versions || [], built: !!d.built })),
    collection: S.collection, trade: S.trade || {},
    prints: Object.fromEntries(Object.entries(S.colmeta || {}).filter(([, m]) => m?.prints?.length).map(([n, m]) => [n, m.prints])),
    wishlist: S.wishlist.map(w => ({ name: w.name, qty: w.qty, max_price: w.max_price ?? null })),
    loans: S.loans.map(l => ({ name: l.name, qty: l.qty, borrower: l.borrower, lent_on: l.lent_on, note: l.note || '' })),
    games: S.games.map(g => ({ deck_id: g.deck_id, deck_name: g.deck_name, played_on: g.played_on, result: g.result, players: g.players, opponents: g.opponents || '', notes: g.notes || '' })),
  };
}
function downloadBackup() {
  const blob = new Blob([JSON.stringify(backupData(), null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `lekverkstan-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  try { localStorage.setItem('lv-backup-at', String(Date.now())); } catch {}
}
function restorePlan(b) {
  if (!b || b.app !== 'lekverkstan' || !Array.isArray(b.decks)) throw new Error('Filen är ingen säkerhetskopia från Lekverkstan');
  const str = (v, n) => String(v ?? '').slice(0, n);
  const sig = d => str(d.name, 80) + '|' + JSON.stringify((d.cards || []).map(c => [String(c?.name), c?.qty | 0, c?.board]).sort());
  const have = new Set(S.decks.map(sig)), ids = new Set(S.decks.map(d => d.id));
  const decks = b.decks.filter(d => d && typeof d.name === 'string' && Array.isArray(d.cards) && !ids.has(d.id) && !have.has(sig(d))).slice(0, 200);
  const col = Object.fromEntries(Object.entries(b.collection && typeof b.collection === 'object' ? b.collection : {})
    .map(([n, q]) => [str(n, 150), Math.max(0, Math.min(999, q | 0))]).filter(([n, q]) => n && q > (S.collection[n] || 0)));
  const after = n => Math.max(S.collection[n] || 0, col[n] || 0);
  const prints = S.v4 ? Object.entries(b.prints || {}).filter(([n, p]) => Array.isArray(p) && p.length && !S.colmeta?.[n]?.prints?.length && after(n)) : [];
  const trade = Object.entries(b.trade || {}).map(([n, q]) => [n, Math.min(q | 0, after(n))]).filter(([n, q]) => q > (S.trade?.[n] || 0));
  const wish = S.v3 ? (Array.isArray(b.wishlist) ? b.wishlist : []).filter(w => w?.name && !S.wishlist.some(x => x.name === w.name)) : [];
  const gk = g => [g.played_on, g.deck_name, g.result, g.opponents || '', g.notes || ''].join('|');
  const gHave = new Set(S.games.map(gk));
  const games = (Array.isArray(b.games) ? b.games : []).filter(g => g?.deck_name && ['win', 'loss', 'draw'].includes(g.result) && !gHave.has(gk(g)));
  const lk = l => [l.name, l.borrower, l.lent_on].join('|');
  const loans = S.v3 ? (Array.isArray(b.loans) ? b.loans : []).filter(l => l?.name && l.borrower && !S.loans.some(x => lk(x) === lk(l))) : [];
  return { decks, col, prints, trade, wish, games, loans, exported: str(b.exported, 30) };
}
async function runRestore(plan, step) {
  const idMap = {};
  for (const d of plan.decks) {
    const nd = await api('/api/decks', { method: 'POST', body: { name: d.name, format: d.format } });
    idMap[d.id] = nd.id;
    await api('/api/decks/' + nd.id, { method: 'PUT', body: { name: d.name, format: d.format === 'modern' ? 'modern' : 'commander', notes: String(d.notes || ''), cards: d.cards, versions: Array.isArray(d.versions) ? d.versions : [], ...(S.v6 ? { built: !!d.built } : {}) } });
    step();
  }
  if (Object.keys(plan.col).length) { await api('/api/collection', { method: 'PUT', body: plan.col }); step(); }
  for (const [name, prints] of plan.prints) await api('/api/prints', { method: 'PUT', body: { name, prints } }).catch(() => {});
  if (plan.trade.length) await api('/api/trade', { method: 'PUT', body: Object.fromEntries(plan.trade) }).catch(() => {});
  for (const w of plan.wish) { await api('/api/wishlist', { method: 'PUT', body: { name: String(w.name), qty: Math.max(1, w.qty | 0), ...(w.max_price != null ? { max_price: +w.max_price } : {}) } }); step(); }
  for (const g of plan.games) { await api('/api/games', { method: 'POST', body: { ...g, deck_id: idMap[g.deck_id] || (S.decks.some(d => d.id === g.deck_id) ? g.deck_id : null) } }); step(); }
  for (const l of plan.loans) { await api('/api/loans', { method: 'POST', body: l }); step(); }
}
async function restoreFile(file) {
  let plan;
  try { plan = restorePlan(JSON.parse(await file.text())); } catch (e) { return toast(e instanceof SyntaxError ? 'Filen gick inte att läsa' : e.message, 4500); }
  const n = plan.decks.length + Object.keys(plan.col).length + plan.prints.length + plan.trade.length + plan.wish.length + plan.games.length + plan.loans.length;
  const li = (k, t) => k ? `<li>${t}</li>` : '';
  openModal(`<div class="row"><h2 style="margin:0">Läs in säkerhetskopia</h2><span class="spacer"></span><button class="icon-btn" data-close aria-label="Stäng">✕</button></div>
    <p class="small muted">Kopian är från ${esc(plan.exported.slice(0, 10) || 'okänt datum')}. Bara det som saknas läggs till. Inget tas bort och inget du har nu skrivs över.</p>
    ${n ? `<ul class="small">${li(plan.decks.length, `${plan.decks.length} lekar som saknas: ${esc(plan.decks.slice(0, 5).map(d => d.name).join(', '))}${plan.decks.length > 5 ? '…' : ''}`)}
      ${li(Object.keys(plan.col).length, `${Object.keys(plan.col).length} kort i samlingen där kopian har fler ex`)}
      ${li(plan.prints.length, `utgåvor för ${plan.prints.length} kort`)}${li(plan.trade.length, `${plan.trade.length} kort till byte`)}
      ${li(plan.wish.length, `${plan.wish.length} kort på önskelistan`)}${li(plan.games.length, `${plan.games.length} matcher`)}${li(plan.loans.length, `${plan.loans.length} utlånade kort`)}</ul>
      <div class="progress" id="rsProg" hidden><div style="width:0"></div></div>
      <div class="row"><span class="spacer"></span><button class="btn primary" id="rsGo">Lägg till</button></div>`
      : '<p><b>Allt i kopian finns redan.</b> Det finns inget att lägga till.</p>'}`, box => {
    if (!$('#rsGo', box)) return;
    $('#rsGo', box).onclick = async () => {
      $('#rsGo', box).disabled = true; $('#rsProg', box).hidden = false;
      const total = plan.decks.length + (Object.keys(plan.col).length ? 1 : 0) + plan.wish.length + plan.games.length + plan.loans.length || 1;
      let done = 0;
      try {
        await runRestore(plan, () => { done++; $('div', $('#rsProg', box)).style.width = Math.min(100, done / total * 100) + '%'; });
        toast('Säkerhetskopian är inläst', 3000);
        setTimeout(() => location.reload(), 800);
      } catch (e) { toast('Avbröts: ' + e.message + '. Det som hann läggas till ligger kvar, läs in filen igen för resten.', 6000); $('#rsGo', box).disabled = false; }
    };
  });
}

// ---------- notisklockan ----------
// Samlar det som hänt: önskekort i lager, bokningar på mina kort, svar på mina bokningar och pågående delad match.
const seenAt = () => { try { return +localStorage.getItem('lv-book-seen') || 0; } catch { return 0; } };
// sedd = nu, eller senaste bokningens tid om serverns klocka ligger före telefonens
function markBookingsSeen() {
  const t = Math.max(Date.now(), ...(S.bookings || []).map(b => Date.parse(b.updated) || 0));
  try { localStorage.setItem('lv-book-seen', String(t)); } catch {}
}
function notifications() {
  const out = [], seen = seenAt();
  for (const w of S.wishlist.filter(x => x.alert))
    out.push({ at: Date.parse(w.checked_at) || 0, href: '#/onskelista', isNew: true, text: `${w.name} finns i lager hos Alara`, sub: w.last_price != null ? `${kr(w.last_price)}${w.max_price != null ? ` · ditt maxpris ${kr(w.max_price)}` : ''}` : 'Önskelista' });
  for (const b of S.bookings || []) {
    const at = Date.parse(b.updated) || 0;
    if (!b.mine && b.status === 'requested') out.push({ at, href: '#/utforska/bokningar', isNew: true, text: `${b.other} vill boka ${b.qty} × ${b.name}`, sub: b.note ? `”${b.note}”` : 'Svara under Bokningar' });
    else if (b.mine && ['accepted', 'declined', 'done'].includes(b.status)) out.push({ at, href: '#/utforska/bokningar', isNew: at > seen, text: `${b.other} ${b.status === 'accepted' ? 'godkände' : b.status === 'declined' ? 'nekade' : 'har lämnat över'} ${b.name}`, sub: [b.moved && b.status !== 'done' ? 'Kortet ligger nu i din samling' : '', b.reply ? `”${b.reply}”` : ''].filter(Boolean).join(' · ') || BOOK_SV[b.status] });
  }
  const evSeen = eventsSeenAt();
  for (const e of (S.events || []).filter(x => !x.mine && eventActive(x))) {
    const at = Date.parse(e.updated) || 0;
    if (e.chosen) out.push({ at, href: '#/matcher/spelkvall', isNew: at > evSeen, text: `${e.title}: ${evDate(e.chosen)}`, sub: e.place || `${e.ownerName} har bestämt tiden` });
    else if (at > evSeen) out.push({ at, href: '#/matcher/spelkvall', isNew: true, text: `${e.ownerName} bjuder in: ${e.title}`, sub: 'Säg vilka tider du kan' });
  }
  out.push(...alarmNotes());
  const ls = lifeState();
  if (ls?.room && ls.players) out.push({ at: Date.now(), href: '#/liv/' + ls.room, isNew: false, text: 'Pågående delad match', sub: `Kod ${ls.room} · tryck för att gå tillbaka` });
  return out.sort((a, b) => b.isNew - a.isNew || b.at - a.at);
}
function updateBell() {
  const b = $('#bell'); if (!b) return;
  const n = notifications().filter(x => x.isNew).length;
  b.innerHTML = `🔔${n ? `<span class="badge">${n}</span>` : ''}`;
  b.title = n ? `${n} nya notiser` : 'Notiser';
  if ($('#notes')) drawNotes();
}
function drawNotes() {
  let el = $('#notes');
  if (!el) { el = document.createElement('div'); el.id = 'notes'; el.className = 'notes'; document.body.appendChild(el); }
  const list = notifications(), anyNew = list.some(x => x.isNew);
  el.innerHTML = `<div class="row" style="padding:.6rem .8rem;border-bottom:1px solid var(--border)"><b>Notiser</b><span class="spacer"></span>${anyNew ? '<button class="btn small" id="notesSeen">Markera som lästa</button>' : ''}</div>
    ${list.length ? list.map(x => `<a class="note ${x.isNew ? 'new' : ''}" href="${esc(x.href)}">${esc(x.text)}<small>${esc(x.sub || '')}</small></a>`).join('')
      : `<p class="muted small" style="padding:.8rem">Inget nytt. Här hamnar önskekort som kommer i lager eller blir billigare, kort du äger som stiger i värde${S.cloud ? ', bokningar i bytesbörsen, svar på dina bokningar och spelkvällar' : ''}.</p>`}`;
  if ($('#notesSeen')) $('#notesSeen').onclick = async e => {
    e.stopPropagation();
    markBookingsSeen(); markEventsSeen(); markAlarmsSeen();
    for (const w of S.wishlist.filter(x => x.alert)) await saveWish({ name: w.name, alert: false }).catch(() => {});
    updateWishBadge(); updateBookBadge(); updateBell();
  };
}
$('#bell').onclick = e => {
  e.stopPropagation();
  if ($('#notes')) return $('#notes').remove();
  drawNotes();
  syncNotes();
};
document.addEventListener('click', e => { const n = $('#notes'); if (n && (!n.contains(e.target) || e.target.closest('a.note'))) setTimeout(() => n.remove(), 0); });
// håll klockan aktuell: hämta bokningar varannan minut och när appen kommer tillbaka i förgrunden
function syncNotes() {
  if (!S.cloud || S.offline) return;
  if (S.v4) loadBookings(true).then(updateBell);
  if (S.v7) loadEvents(true).then(updateBell);
}
setInterval(() => { if (document.visibilityState === 'visible') syncNotes(); }, 120000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncNotes(); });

// ---------- tema ----------
function setTheme(t) {
  try { if (t === 'auto') localStorage.removeItem('lv-theme'); else localStorage.setItem('lv-theme', t); } catch {}
  if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  const dark = t === 'dark' || (t === 'auto' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  $('meta[name=theme-color]')?.setAttribute('content', dark ? '#1f1a2e' : '#ffffff');
}
const themeNow = () => document.documentElement.dataset.theme || 'auto';
setTheme(themeNow());

// ---------- installera som app ----------
let installEvt = null;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; if (location.hash.startsWith('#/installningar')) render(); });
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
async function loadRate() {
  try { const c = JSON.parse(localStorage.getItem('lv-rate')); if (c && Date.now() - c.at < 24 * 3600e3) { S.rate = c.sek; return; } } catch {}
  try {
    const r = await fetch('https://api.frankfurter.dev/v1/latest?from=EUR&to=SEK');
    const j = await r.json();
    if (j.rates?.SEK) { S.rate = j.rates.SEK; try { localStorage.setItem('lv-rate', JSON.stringify({ at: Date.now(), sek: S.rate })); } catch {} }
  } catch {}
}

// ---------- router ----------
// ---------- färgkällor ----------
const WUBRG = ['W', 'U', 'B', 'R', 'G'];
const LAND_COLOR = { Plains: 'W', Island: 'U', Swamp: 'B', Mountain: 'R', Forest: 'G' };
// färger ett kort kan ge, inom lekens färgidentitet
function manaColors(info, identity = WUBRG) {
  const out = new Set(), text = info?.oracle_text || '';
  for (const m of text.matchAll(/\badd\b[^.\n]*/gi)) {
    for (const s of m[0].match(/\{[WUBRG]\}/g) || []) out.add(s[1]);
    if (/any (one )?(color|type)/i.test(m[0])) identity.forEach(c => out.add(c));
  }
  if (mainType(info) === 'Land') {
    const type = info.type_line || '', search = text.match(/search your library for [^.]*/i)?.[0] || '';
    let hit = false;
    for (const [w, c] of Object.entries(LAND_COLOR)) {
      if (type.includes(w)) out.add(c);
      if (search.includes(w)) { out.add(c); hit = true; }
    }
    if (search && !hit && /basic land/i.test(search)) identity.forEach(c => out.add(c));
  }
  return [...out].filter(c => identity.includes(c));
}
// källor per färg jämfört med hur mycket färgen används
function colorCheck(deck, pips) {
  const play = deck.cards.filter(c => c.board === 'main' || c.board === 'commander');
  const cmd = play.filter(c => c.board === 'commander');
  const identity = cmd.length ? WUBRG.filter(c => cmd.some(x => S.cards[x.name]?.color_identity?.includes(c))) : WUBRG.filter(c => pips[c]);
  const rows = identity.map(c => ({ c, pips: pips[c] || 0, lands: 0, other: 0 }));
  let lands = 0;
  for (const c of play) {
    if (c.board === 'commander') continue;
    const info = S.cards[c.name], isLand = mainType(info) === 'Land';
    if (isLand) lands += c.qty;
    else if ((info?.cmc ?? 9) > 3) continue;
    const colors = manaColors(info, identity);
    for (const r of rows) if (colors.includes(r.c)) r[isLand ? 'lands' : 'other'] += c.qty;
  }
  const total = rows.reduce((a, r) => a + r.pips, 0) || 1;
  for (const r of rows) {
    r.want = r.pips ? Math.min(lands, Math.max(Math.round(lands * .3), Math.round(lands * (r.pips / total) * 1.25))) : 0;
    r.low = r.lands < r.want - 2;
  }
  return rows;
}

// ---------- budget ----------
// välj de viktigaste saknade korten inom taket: befälhavare, sedan roller under mallen, sedan populära kort och lågt pris
function budgetPlan(deck, miss, max, priceOf) {
  const commander = deck.format === 'commander';
  const need = { Länder: 0, ...Object.fromEntries(ROLE_ORDER.map(k => [k, 0])) };
  if (commander) {
    const have = { cards: deck.cards.filter(c => !miss.some(m => m.name === c.name)) };
    const now = roleCounts(have);
    for (const [k, t] of Object.entries(ROLE_TARGET)) need[k] = Math.max(0, t[0] - (now[k] || 0));
  }
  const incl = {};
  for (const e of Object.values(S.edhrec)) for (const l of e.lists) for (const c of l.cards) if (c.incl != null) incl[c.name] = Math.max(incl[c.name] || 0, c.incl);
  const left = miss.flatMap(m => Array(m.missing).fill(m.name)).map(name => ({ name, price: priceOf(name), card: deck.cards.find(c => c.name === name) }));
  const noPrice = left.filter(x => x.price == null).length;
  const pool = left.filter(x => x.price != null);
  const picks = [];
  let rest = max;
  const score = x => {
    if (x.card?.board === 'commander') return 100;
    const land = mainType(S.cards[x.name]) === 'Land';
    return (land && need.Länder > 0 ? 3 : 0) + rolesOf(x.card || { name: x.name }).reduce((a, r) => a + (need[r] > 0 ? 3 : 0), 0) + (incl[x.name] || 0) * 3;
  };
  while (pool.length) {
    let best = -1, top = -Infinity;
    pool.forEach((x, i) => {
      if (x.price > rest) return;
      const v = score(x) - x.price / Math.max(1, max) * 2;
      if (v > top) { top = v; best = i; }
    });
    if (best < 0) break;
    const [x] = pool.splice(best, 1);
    picks.push(x); rest -= x.price;
    if (mainType(S.cards[x.name]) === 'Land') need.Länder--;
    for (const r of rolesOf(x.card || { name: x.name })) need[r]--;
  }
  return { picks, cost: max - rest, skipped: pool.length, noPrice };
}

// ---------- plockguide ----------
function pickGuide(deck) {
  const need = {};
  for (const c of deck.cards) if (c.board !== 'maybe') need[c.name] = (need[c.name] || 0) + c.qty;
  const out = { bin: [], from: {}, miss: [], basics: 0 };
  for (const [name, qty] of Object.entries(need).sort((a, b) => a[0].localeCompare(b[0]))) {
    if (S.basicsOwned && BASICS.has(name)) { out.basics += qty; continue; }
    const fromBin = Math.min(qty, free(name, deck));
    if (fromBin) out.bin.push({ name, qty: fromBin });
    let rest = qty - fromBin, phys = owned(name) - fromBin;
    if (!deck.built) for (const x of builtIn(name)) {
      const take = Math.min(rest, x.qty, Math.max(0, phys));
      if (!take) continue;
      (out.from[x.id] = out.from[x.id] || { name: x.name, cards: [] }).cards.push({ name, qty: take });
      rest -= take; phys -= take;
    }
    if (rest > 0) out.miss.push({ name, qty: rest });
  }
  return out;
}
function pickModal(deck) {
  const key = 'lv-pick-' + deck.id;
  let done = {};
  try { done = JSON.parse(localStorage.getItem(key)) || {}; } catch {}
  const g = pickGuide(deck), from = Object.entries(g.from);
  const row = (c, src) => { const k = src + '|' + c.name; return `<li><label class="row small"><input type="checkbox" data-pick="${esc(k)}" ${done[k] ? 'checked' : ''}> ${c.qty} × ${esc(c.name)}</label></li>`; };
  const list = (cards, src) => `<ul class="picks">${cards.map(c => row(c, src)).join('')}</ul>`;
  openModal(`<div class="row"><h2 style="margin:0">Plockguide: ${esc(deck.name)}</h2><span class="spacer"></span><button class="icon-btn" data-close aria-label="Stäng">✕</button></div>
    ${g.bin.length ? `<h3>Ur samlingen (${g.bin.reduce((a, c) => a + c.qty, 0)})</h3>${list(g.bin, 'bin')}` : ''}
    ${from.map(([id, x]) => `<h3>Ta ur ${esc(x.name)} (${x.cards.reduce((a, c) => a + c.qty, 0)})</h3>${list(x.cards, id)}`).join('')}
    ${g.basics ? `<p class="small muted">Dessutom ${g.basics} basländer.</p>` : ''}
    ${g.miss.length ? `<h3>Saknas (${g.miss.reduce((a, c) => a + c.qty, 0)})</h3><p class="small">${g.miss.map(c => `${c.qty} × ${esc(c.name)}`).join(', ')}</p>` : ''}
    ${from.length ? `<h3>Byt tillbaka efteråt</h3><ul class="small" style="margin:.2rem 0;padding-left:1.1rem">${from.map(([, x]) => `<li><b>${esc(x.name)}</b>: ${x.cards.map(c => esc(c.name)).join(', ')}</li>`).join('')}</ul>
      <p class="muted small">Du behåller listan här så länge korten är kvar i ${esc(from.map(([, x]) => x.name).join(', '))}.</p>` : ''}
    <div class="row" style="margin-top:.8rem"><button class="btn small" id="pickClear">Börja om</button><span class="spacer"></span>${S.v6 && !deck.built ? '<button class="btn primary small" id="pickBuilt">Leken är ihopbyggd</button>' : ''}</div>`, box => {
    box.addEventListener('change', e => {
      if (!e.target.matches('[data-pick]')) return;
      done[e.target.dataset.pick] = e.target.checked;
      try { localStorage.setItem(key, JSON.stringify(done)); } catch {}
    });
    $('#pickClear', box).onclick = () => { try { localStorage.removeItem(key); } catch {} pickModal(deck); };
    if ($('#pickBuilt', box)) $('#pickBuilt', box).onclick = async () => {
      deck.built = true;
      try { await api('/api/decks/' + deck.id, { method: 'PUT', body: { built: true } }); toast('Leken är markerad som ihopbyggd'); }
      catch (err) { deck.built = false; toast('Kunde inte spara: ' + err.message); }
      closeModal(); render();
    };
  });
}

// ---------- bygg från samlingen ----------
// en Commander-lek av lediga kort: mallens roller först, bäst EDHREC-värde, sedan länder och basländer. Tomma platser fylls med populära kort du saknar.
function buildPlan(cmd, edh) {
  const info = S.cards[cmd], identity = info.color_identity || [];
  const fits = c => c && c.legalities?.commander === 'legal' && (c.color_identity || []).every(x => identity.includes(x));
  const score = {};
  for (const l of edh?.lists || []) for (const c of l.cards) score[c.name] = Math.max(score[c.name] || 0, (c.incl || 0) + Math.max(0, c.synergy || 0));
  const val = n => score[n] || score[n.split(' // ')[0]] || 0;
  const cand = Object.keys(S.collection).filter(n => n !== cmd && !BASICS.has(n) && free(n) > 0 && fits(S.cards[n]))
    .sort((a, b) => val(b) - val(a) || (S.cards[a].cmc || 0) - (S.cards[b].cmc || 0) || a.localeCompare(b));
  const land = n => mainType(S.cards[n]) === 'Land';
  const chosen = new Set();
  for (const [role, t] of Object.entries(ROLE_TARGET)) {
    if (role === 'Länder') continue;
    let n = 0;
    for (const c of cand) {
      if (n >= t[0]) break;
      if (land(c) || !rolesOf({ name: c }).includes(role)) continue;
      if (!chosen.has(c)) chosen.add(c);
      n++;
    }
  }
  const rest = cand.filter(c => !land(c) && !chosen.has(c));
  const good = rest.filter(c => val(c) > 0 || rolesOf({ name: c }).length);
  for (const c of [...good, ...rest.filter(x => !good.includes(x))]) { if (chosen.size >= 62) break; chosen.add(c); }
  const spells = [...chosen];
  const lands = cand.filter(c => land(c) && (manaColors(S.cards[c], identity).length || val(c) > 0)).slice(0, 37);
  // tomma platser bland icke-länder: populära kort som inte är lediga
  const missing = [];
  const known = new Set([cmd, ...spells, ...lands]);
  const pop = [];
  for (const l of edh?.lists || []) {
    if (/land/i.test(l.header)) continue;
    for (const c of l.cards) pop.push(c);
  }
  pop.sort((a, b) => (b.incl || 0) - (a.incl || 0));
  for (const c of pop) {
    if (spells.length + missing.length >= 62) break;
    if (!known.has(c.name) && !BASICS.has(c.name)) { known.add(c.name); missing.push(c.name); }
  }
  // resten är basländer efter hur mycket färgerna används
  const pips = Object.fromEntries(WUBRG.map(c => [c, 0]));
  for (const n of spells) for (const s of (S.cards[n].mana_cost || '').match(/\{[^}]+\}/g) || []) for (const ch of s.slice(1, -1).split('/')) if (pips[ch] !== undefined) pips[ch]++;
  const free99 = 99 - spells.length - missing.length - lands.length;
  const nb = Math.max(0, Math.min(free99, 37 - lands.length));
  const colors = identity.length ? identity : [];
  const BASIC_OF = { W: 'Plains', U: 'Island', B: 'Swamp', R: 'Mountain', G: 'Forest' };
  const total = colors.reduce((a, c) => a + pips[c] + 1, 0) || 1;
  const basics = {};
  let placed = 0;
  colors.forEach((c, i) => {
    const n = i === colors.length - 1 ? nb - placed : Math.round(nb * (pips[c] + 1) / total);
    if (n > 0) { basics[BASIC_OF[c]] = n; placed += n; }
  });
  if (!colors.length && nb) basics.Wastes = nb;
  return { cmd, spells, lands, missing, basics, nb, gap: Math.max(0, free99 - nb), usedEdh: !!edh };
}
function planDeckCards(p) {
  return [{ name: p.cmd, qty: 1, board: 'commander' },
    ...[...p.spells, ...p.lands, ...p.missing].map(name => ({ name, qty: 1, board: 'main' })),
    ...Object.entries(p.basics).map(([name, qty]) => ({ name, qty, board: 'main' }))];
}
function viewBuild() {
  setNav('lekar');
  const st = viewBuild.st || (viewBuild.st = {});
  const names = Object.keys(S.collection);
  if (names.some(n => !S.cards[n] && !S.notFound.has(n)) && !viewBuild.loading) {
    viewBuild.loading = true;
    $('#app').innerHTML = '<div class="card empty">Läser in din samling…</div>';
    ensureCards(names).catch(e => toast(e.message)).finally(() => { viewBuild.loading = false; render(); });
    return;
  }
  const options = names.filter(n => S.cards[n]?.commander_ok && free(n) > 0).sort((a, b) => a.localeCompare(b));
  const p = st.plan;
  const counts = p ? roleCounts({ cards: planDeckCards(p) }) : null;
  const missVal = p ? p.missing.reduce((a, n) => a + (S.cards[n]?.eur || 0), 0) : 0;
  $('#app').innerHTML = `<div class="row"><a href="#/" class="icon-btn" aria-label="Tillbaka">←</a><h1>Bygg från samlingen</h1></div>
    <div class="grid cols-2" style="margin-top:1rem">
      <div class="card"><h2>Välj befälhavare</h2>
        <div class="add-bar" id="bdCmd"></div>
        ${options.length ? `<p class="small muted" style="margin-bottom:.3rem">Befälhavare du har lediga:</p><div class="row small">${options.slice(0, 60).map(n => `<button class="btn small ${st.cmd === n ? 'primary' : ''}" data-bcmd="${esc(n)}">${esc(n)}</button>`).join('')}</div>` : ''}
        <p class="muted small">Kort i ihopbyggda lekar räknas inte som lediga. Bara Commander just nu.</p>
        ${st.busy ? '<p class="muted">Bygger…</p>' : ''}
      </div>
      <div class="card"><h2>Förslag</h2>${p ? `
        <p><b>${esc(p.cmd)}</b>: ${p.spells.length + p.lands.length + 1} kort från din samling, ${p.nb} basländer och ${p.missing.length} att skaffa${p.missing.length ? ` (ca ${krE(missVal)})` : ''}.</p>
        ${p.gap ? `<p class="warn small">${p.gap} platser är tomma. Du väljer själv vad som ska in där.</p>` : ''}
        ${p.usedEdh ? '' : '<p class="warn small">EDHREC har ingen sida för den här befälhavaren, så valet bygger bara på rollerna.</p>'}
        <table class="small"><tbody>${Object.entries(ROLE_TARGET).map(([k, t]) => `<tr><td>${k}</td><td class="num ${counts[k] < t[0] ? 'warn' : 'good'}"><b>${counts[k]}</b></td><td class="muted">mål ${t[0]}–${t[1]}</td></tr>`).join('')}</tbody></table>
        <div class="row" style="margin-top:.6rem"><input type="text" id="bdName" maxlength="80" style="flex:1" value="${esc(p.cmd)}"><button class="btn primary" id="bdMake">Skapa leken</button></div>
        <details class="small"><summary>Visa korten</summary>
          <p><b>Från samlingen:</b> ${[...p.spells, ...p.lands].map(esc).join(', ') || '–'}</p>
          ${p.missing.length ? `<p><b>Att skaffa:</b> ${p.missing.map(esc).join(', ')}</p>` : ''}
          <p><b>Basländer:</b> ${Object.entries(p.basics).map(([n, q]) => `${q} ${esc(n)}`).join(', ') || '–'}</p></details>` : '<p class="muted">Välj en befälhavare så föreslår jag en lek av kort du har lediga.</p>'}</div>
    </div>`;
  const choose = async name => {
    st.cmd = name; st.busy = true; st.plan = null; render();
    try {
      await ensureCards([name]);
      if (!S.cards[name]) throw new Error('Hittar inte kortet');
      const edh = await edhrecFor([name]).catch(() => null);
      const pop = (edh?.lists || []).flatMap(l => l.cards.map(c => c.name));
      await ensureCards(pop.filter(n => !BASICS.has(n))).catch(() => {});
      st.plan = buildPlan(name, edh);
    } catch (e) { toast(e.message, 4000); }
    st.busy = false; render();
  };
  addCardUI($('#bdCmd'), choose, 'Sök befälhavare…');
  $$('[data-bcmd]').forEach(b => b.onclick = () => choose(b.dataset.bcmd));
  if ($('#bdMake')) $('#bdMake').onclick = async () => {
    $('#bdMake').disabled = true;
    try {
      const d = await api('/api/decks', { method: 'POST', body: { name: $('#bdName').value.trim() || p.cmd, format: 'commander' } });
      d.cards = planDeckCards(p);
      await api('/api/decks/' + d.id, { method: 'PUT', body: d });
      S.decks.unshift(d); viewBuild.st = null;
      location.hash = '#/lek/' + d.id;
    } catch (e) { $('#bdMake').disabled = false; toast('Kunde inte skapa: ' + e.message, 4000); }
  };
}

// ---------- samlingens värde över tid ----------
const todayStr = () => new Date().toISOString().slice(0, 10);
async function valueSnapshot() {
  if (!S.v7 || S.offline || valueSnapshot.busy || valueSnapshot.done === todayStr()) return;
  valueSnapshot.busy = true;
  try {
    if (!S.valueLog) { S.valueLog = await api('/api/value-log'); if (location.hash.startsWith('#/samling')) render(); }
    const names = Object.keys(S.collection);
    if (names.length && !S.valueLog.some(x => x.day === todayStr())) {
      await ensureCards(names, true); // färska priser en gång per dygn
      const eurOf = Object.fromEntries(names.filter(n => S.cards[n]?.eur != null).map(n => [n, S.cards[n].eur]));
      const prices = Object.fromEntries(Object.entries(eurOf).filter(([, v]) => v >= .5).sort((a, b) => b[1] - a[1]).slice(0, 300));
      const row = await api('/api/value-log', { method: 'PUT', body: { value_eur: names.reduce((a, n) => a + colValue(n), 0), cards: names.reduce((a, n) => a + S.collection[n], 0), prices } });
      S.valueLog.unshift(row);
      if (location.hash.startsWith('#/samling')) render();
    }
    valueSnapshot.done = todayStr();
  } catch { valueSnapshot.done = todayStr(); } finally { valueSnapshot.busy = false; }
}
function lineChart(pts, title) {
  const W = 420, H = 170, pad = 8, base = H - 20;
  const vals = pts.map(p => p.v), lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
  const X = i => pad + (W - pad * 2) * (pts.length > 1 ? i / (pts.length - 1) : .5), Y = v => 22 + (base - 30) * (1 - (v - lo) / span);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p.v).toFixed(1)}`).join('');
  const step = (W - pad * 2) / Math.max(1, pts.length - 1), last = pts[pts.length - 1];
  return `<div class="chart-wrap"><svg viewBox="0 0 ${W} ${H}" role="img"><line class="axis" x1="0" x2="${W}" y1="${base}" y2="${base}"></line>
    <path class="line" d="${line}"></path><circle class="dot" cx="${X(pts.length - 1)}" cy="${Y(last.v)}" r="4"></circle>
    ${pts.map((p, i) => `<g data-tip="${esc(title(p))}"><rect class="hit" x="${X(i) - step / 2}" y="0" width="${step}" height="${base}"></rect></g>`).join('')}
    <text x="0" y="${H - 5}">${esc(pts[0].day)}</text><text x="${W}" y="${H - 5}" text-anchor="end">${esc(last.day)}</text></svg><div class="tip" hidden></div></div>`;
}
// störst prisändring per kort mellan senaste mätningen och den som ligger närmast 30 dagar bakåt
function priceMoves(log) {
  if (!log || log.length < 2) return [];
  const now = log[0], cut = Date.parse(now.day) - 30 * 864e5;
  const then = log.find(x => Date.parse(x.day) <= cut) || log[log.length - 1];
  return Object.keys(now.prices || {}).filter(n => then.prices?.[n] != null && then.prices[n] !== now.prices[n])
    .map(n => ({ name: n, from: then.prices[n], to: now.prices[n], diff: now.prices[n] - then.prices[n], since: then.day }));
}
function valueCard() {
  if (!S.v7) return '';
  const log = S.valueLog;
  if (!log) return '<div class="card"><h2>Värdeutveckling</h2><p class="muted small">Hämtar…</p></div>';
  if (log.length < 2) return '<div class="card"><h2>Värdeutveckling</h2><p class="muted small">Värdet sparas en gång per dygn när du öppnar samlingen. Kurvan visas när det finns två mätningar.</p></div>';
  const asc = log.slice(0, 365).reverse(), pts = asc.map(x => ({ day: x.day, v: x.value_eur, cards: x.cards }));
  const diff = pts[pts.length - 1].v - pts[0].v, moves = priceMoves(log);
  const up = moves.filter(m => m.diff > 0).sort((a, b) => b.diff - a.diff).slice(0, 5), down = moves.filter(m => m.diff < 0).sort((a, b) => a.diff - b.diff).slice(0, 5);
  const row = m => `<tr><td>${esc(m.name)}</td><td class="num ${m.diff > 0 ? 'good' : 'warn'}">${m.diff > 0 ? '+' : '−'}${krE(Math.abs(m.diff))}</td></tr>`;
  return `<div class="card"><h2>Värdeutveckling</h2>
    <p class="small"><b>${diff >= 0 ? '+' : '−'}${krE(Math.abs(diff))}</b> sedan ${esc(pts[0].day)}</p>
    ${lineChart(pts, p => `${p.day}: ${krE(p.v)}, ${p.cards} kort`)}
    <p class="muted small">Kurvan stiger också när du lägger till kort.</p>
    ${up.length ? `<h3>Mest upp sedan ${esc(up[0].since)}</h3><table class="small"><tbody>${up.map(row).join('')}</tbody></table>` : ''}
    ${down.length ? `<h3>Mest ner sedan ${esc(down[0].since)}</h3><table class="small"><tbody>${down.map(row).join('')}</tbody></table>` : ''}
    <details class="small"><summary>Visa som tabell</summary><table><tbody>${asc.slice().reverse().slice(0, 60).map(x => `<tr><td>${esc(x.day)}</td><td class="num">${krE(x.value_eur)}</td><td class="num muted">${x.cards} kort</td></tr>`).join('')}</tbody></table></details></div>`;
}

// ---------- topplista ----------
function leaderboard(rows) {
  const people = {}, decks = {};
  const add = (o, g) => { o.n++; if (g.result === 'win') o.win++; };
  for (const g of rows) {
    const p = people[g.player] = people[g.player] || { name: g.player, n: 0, win: 0, decks: {} };
    add(p, g);
    add(p.decks[g.deck_name] = p.decks[g.deck_name] || { name: g.deck_name, n: 0, win: 0 }, g);
    add(decks[g.player + '|' + g.deck_name] = decks[g.player + '|' + g.deck_name] || { player: g.player, name: g.deck_name, n: 0, win: 0 }, g);
  }
  const pct = x => x.n ? x.win / x.n : 0;
  const list = Object.values(people).map(p => ({ ...p, pct: pct(p), best: Object.values(p.decks).sort((a, b) => b.win - a.win || pct(b) - pct(a))[0] })).sort((a, b) => b.win - a.win || b.pct - a.pct);
  // vem mot vem: matcher där motståndarens namn står i Mot-fältet
  const names = list.map(p => p.name), vs = [];
  const has = (text, name) => (text || '').toLowerCase().split(/[,;&]| och | mot /).some(t => t.trim() === name.toLowerCase() || t.trim().startsWith(name.toLowerCase() + ' '));
  for (const a of names) for (const b of names) {
    if (a >= b) continue;
    const r = { a, b, n: 0, wa: 0, wb: 0 };
    for (const g of rows) {
      if (g.player === a && has(g.opponents, b)) { r.n++; if (g.result === 'win') r.wa++; }
      if (g.player === b && has(g.opponents, a) && g.result === 'win') r.wb++;
    }
    if (r.n) vs.push(r);
  }
  return { list, decks: Object.values(decks).map(d => ({ ...d, pct: pct(d) })).sort((a, b) => b.pct - a.pct || b.n - a.n), vs };
}
function tabLeader(el) {
  const shareBox = `<label class="small row"><input type="checkbox" id="shareGames" ${S.profile.share ? 'checked' : ''}> Visa mina matcher i topplistan</label>
    <p class="muted small">Andra ser resultat, lek, datum och vilka du mötte, men inte dina anteckningar. ${S.profile.name ? '' : 'Sätt ditt namn under <a href="#/installningar">Inställningar</a> först.'}</p>`;
  const draw = rows => {
    const t = leaderboard(rows);
    el.innerHTML = `<div class="grid cols-2"><div class="grid" style="align-content:start">
      <div class="card"><h2>Topplista</h2>${t.list.length ? `<div class="table-scroll"><table><thead><tr><th>#</th><th>Spelare</th><th class="num">Vinster</th><th class="num">Matcher</th><th class="num">Andel</th><th>Bästa lek</th></tr></thead><tbody>
        ${t.list.map((p, i) => `<tr><td>${i + 1}</td><td><b>${esc(p.name)}</b></td><td class="num">${p.win}</td><td class="num">${p.n}</td><td class="num">${Math.round(p.pct * 100)} %</td><td class="small">${esc(p.best?.name || '')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Ingen delar sina matcher än.</p>'}
        ${shareBox}</div>
      ${t.vs.length ? `<div class="card"><h2>Vem mot vem</h2><table class="small"><tbody>${t.vs.map(v => `<tr><td>${esc(v.a)}</td><td class="num"><b>${v.wa}–${v.wb}</b></td><td>${esc(v.b)}</td></tr>`).join('')}</tbody></table>
        <p class="muted small">Räknas när namnet står i Mot-fältet, som i delade matcher.</p></div>` : ''}</div>
      <div class="card" style="align-self:start"><h2>Bästa lekar</h2>${t.decks.length ? `<div class="table-scroll"><table><thead><tr><th>Lek</th><th>Spelare</th><th class="num">V/M</th><th class="num">Andel</th></tr></thead><tbody>
        ${t.decks.slice(0, 15).map(d => `<tr><td>${esc(d.name)}</td><td class="small">${esc(d.player)}</td><td class="num">${d.win}/${d.n}</td><td class="num">${Math.round(d.pct * 100)} %</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Inga matcher än.</p>'}</div></div>`;
    $('#shareGames').onchange = async e => {
      if (!S.profile.name) { e.target.checked = false; return toast('Sätt ditt namn under Inställningar först', 3500); }
      try { await api('/api/profile', { method: 'PUT', body: { name: S.profile.name, share: e.target.checked } }); S.profile.share = e.target.checked; render(); }
      catch (err) { e.target.checked = !e.target.checked; toast('Kunde inte spara: ' + err.message, 4000); }
    };
  };
  el.innerHTML = '<p class="muted">Hämtar…</p>';
  api('/api/leaderboard').then(rows => { if (el.isConnected) draw(rows); }).catch(e => { if (el.isConnected) el.innerHTML = `<div class="card empty">Kunde inte hämta: ${esc(e.message)}</div>`; });
}

// ---------- spelkväll ----------
const evDate = o => new Date(o).toLocaleString('sv-SE', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
async function loadEvents(force) {
  if (!S.cloud || !S.v7) { S.events = []; return; }
  if (S.events && !force) return;
  S.events = await api('/api/events').catch(() => S.events || []);
}
const eventsSeenAt = () => { try { return +localStorage.getItem('lv-event-seen') || 0; } catch { return 0; } };
function markEventsSeen() {
  const t = Math.max(Date.now(), ...(S.events || []).map(e => Date.parse(e.updated) || 0));
  try { localStorage.setItem('lv-event-seen', String(t)); } catch {}
}
const eventActive = e => [...e.options, e.chosen].filter(Boolean).some(o => Date.parse(o) > Date.now() - 864e5);
// bord med 3–4 spelare (5 om det bara är fem), lekar med närmast samma bracket tillsammans
function podsOf(list) {
  const n = list.length;
  const threes = n <= 5 ? 0 : (4 - n % 4) % 4;
  const sizes = n <= 5 ? (n ? [n] : []) : [...Array((n - 3 * threes) / 4).fill(4), ...Array(threes).fill(3)];
  const sorted = list.slice().sort((a, b) => (a.bracket ?? 2.5) - (b.bracket ?? 2.5) || a.name.localeCompare(b.name));
  return sizes.map(k => sorted.splice(0, k));
}
function eventHtml(e) {
  const mine = e.replies.find(r => r.mine), goers = o => e.replies.filter(r => r.dates.includes(o));
  const replies = e.chosen ? goers(e.chosen) : e.replies.filter(r => r.dates.length);
  return `<div class="card" data-ev="${esc(e.id)}"><div class="row"><h2 style="margin:0">${esc(e.title)}</h2><span class="spacer"></span>${e.mine ? '<button class="icon-btn" data-evdel title="Ta bort">✕</button>' : ''}</div>
    <p class="muted small">${esc(e.ownerName)} bjuder in${e.place ? ` · ${esc(e.place)}` : ''}</p>
    ${e.note ? `<p class="small">${esc(e.note)}</p>` : ''}
    ${e.chosen ? `<p><span class="pill good">Bestämt</span> <b>${esc(evDate(e.chosen))}</b></p>` : ''}
    <table class="small"><tbody>${e.options.map(o => `<tr><td style="width:1.6rem"><input type="checkbox" data-evdate="${esc(o)}" aria-label="Jag kan ${esc(evDate(o))}" ${mine?.dates.includes(o) ? 'checked' : ''}></td>
      <td><b>${esc(evDate(o))}</b><div class="muted">${goers(o).map(r => esc(r.name)).join(', ') || 'Ingen än'}</div></td>
      <td class="num">${goers(o).length}</td>${e.mine ? `<td class="num"><button class="btn small" data-evpick="${esc(o)}">${e.chosen === o ? 'Valt' : 'Välj'}</button></td>` : ''}</tr>`).join('')}</tbody></table>
    <p><label class="small">Min lek<br><select data-evdeck style="width:100%"><option value="">Vet inte än</option>${S.decks.map(d => `<option value="${d.id}" ${mine?.deck_name === d.name ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></label></p>
    ${replies.some(r => r.deck_name) ? `<p class="small muted">${replies.filter(r => r.deck_name).map(r => `${esc(r.name)}: ${esc(r.deck_name)}${r.bracket ? ` (bracket ${r.bracket})` : ''}`).join(' · ')}</p>` : ''}
    ${e.mine && e.chosen ? `<button class="btn small" data-evpods>${e.pods.length ? 'Dela in borden igen' : 'Dela in bord'}</button>` : ''}
    ${e.pods.length ? `<h3>Bord</h3><div class="grid cols-2">${e.pods.map((p, i) => `<div><b>Bord ${i + 1}</b><ul class="small" style="margin:.2rem 0;padding-left:1.1rem">${p.map(x => `<li>${esc(x.name)}${x.deck ? ` – ${esc(x.deck)}` : ''}${x.bracket ? ` (${x.bracket})` : ''}</li>`).join('')}</ul></div>`).join('')}</div>` : ''}</div>`;
}
function tabEvents(el) {
  if (!S.events) { el.innerHTML = '<p class="muted">Hämtar…</p>'; loadEvents(true).then(() => el.isConnected && render()); return; }
  markEventsSeen(); updateBell();
  const list = S.events.filter(eventActive);
  el.innerHTML = `<div class="grid cols-2"><div class="grid" style="align-content:start">${list.map(eventHtml).join('') || '<div class="card empty">Inga spelkvällar planerade.</div>'}</div>
    <div class="card" style="align-self:start"><h2>Ny spelkväll</h2>
      <p><input type="text" id="evTitle" maxlength="80" placeholder="T.ex. Commander hos Jonte" style="width:100%"></p>
      <p><input type="text" id="evPlace" maxlength="120" placeholder="Plats (valfritt)" style="width:100%"></p>
      <p class="small muted" style="margin-bottom:.2rem">Föreslå upp till tre tider:</p>
      ${[0, 1, 2].map(() => '<p style="margin:.2rem 0"><input type="datetime-local" data-evopt style="width:100%"></p>').join('')}
      <p><input type="text" id="evNote" maxlength="500" placeholder="Meddelande (valfritt)" style="width:100%"></p>
      <p class="row"><span class="spacer"></span><button class="btn primary" id="evNew">Bjud in</button></p>
      <p class="muted small">Alla inloggade ser spelkvällen. Klockan visar den för dem.</p></div></div>`;
  const reload = async () => { await loadEvents(true); render(); };
  const reply = async (e, patch) => {
    const mine = e.replies.find(r => r.mine);
    try {
      await api(`/api/events/${e.id}/reply`, { method: 'PUT', body: { dates: mine?.dates || [], deck_name: mine?.deck_name || '', bracket: mine?.bracket ?? null, ...patch } });
    } catch (err) { toast('Kunde inte spara: ' + err.message, 4000); }
    reload();
  };
  const evOf = t => S.events.find(x => x.id === t.closest('[data-ev]')?.dataset.ev);
  el.addEventListener('change', async ev => {
    const e = evOf(ev.target); if (!e) return;
    if (ev.target.matches('[data-evdate]')) {
      const mine = e.replies.find(r => r.mine), o = ev.target.dataset.evdate;
      const dates = (mine?.dates || []).filter(x => x !== o);
      if (ev.target.checked) dates.push(o);
      reply(e, { dates });
    }
    if (ev.target.matches('[data-evdeck]')) {
      const d = S.decks.find(x => x.id === ev.target.value);
      if (!d) return reply(e, { deck_name: '', bracket: null });
      await ensureCards(d.cards.map(c => c.name)).catch(() => {});
      reply(e, { deck_name: d.name, bracket: d.format === 'commander' ? bracketInfo(d).b : null });
    }
  });
  el.addEventListener('click', async ev => {
    const t = ev.target;
    if (t.id === 'evNew') {
      const title = $('#evTitle').value.trim(), options = $$('[data-evopt]').map(i => i.value).filter(Boolean);
      if (!title) return toast('Skriv en rubrik');
      if (!options.length) return toast('Föreslå minst en tid');
      if (!S.profile.name) return toast('Sätt ditt namn under Inställningar först', 3500);
      try { await api('/api/events', { method: 'POST', body: { title, place: $('#evPlace').value.trim(), note: $('#evNote').value.trim(), options: [...new Set(options)] } }); toast('Spelkvällen är skapad'); reload(); }
      catch (err) { toast('Kunde inte skapa: ' + err.message, 4000); }
      return;
    }
    const e = evOf(t); if (!e) return;
    const put = async body => { try { await api('/api/events/' + e.id, { method: 'PUT', body }); } catch (err) { toast('Kunde inte spara: ' + err.message, 4000); } reload(); };
    if (t.closest('[data-evdel]')) { if (confirm('Ta bort spelkvällen?')) { await api('/api/events/' + e.id, { method: 'DELETE' }).catch(err => toast(err.message)); reload(); } return; }
    const p = t.closest('[data-evpick]');
    if (p) return put({ chosen: e.chosen === p.dataset.evpick ? '' : p.dataset.evpick, pods: [] });
    if (t.closest('[data-evpods]')) {
      const list = e.replies.filter(r => r.dates.includes(e.chosen));
      if (!list.length) return toast('Ingen har svarat ja på den tiden');
      put({ pods: podsOf(list).map(p => p.map(r => ({ name: r.name, deck: r.deck_name, bracket: r.bracket }))) });
    }
  });
}
function viewGroup(sub) {
  setNav('matcher');
  $('#app').innerHTML = `<div class="row"><h1>Matcher</h1></div>${gameTabs(sub)}<div id="grp"></div>`;
  (sub === 'topplista' ? tabLeader : tabEvents)($('#grp'));
}
const gameTabs = sub => `<div class="tabs">${[['', 'Mina matcher'], ['analys', 'Analys'], ...(S.cloud && S.v7 ? [['topplista', 'Topplista'], ['spelkvall', 'Spelkväll']] : [])].map(([k, l]) => `<a class="${k === sub ? 'on' : ''}" href="#/matcher${k ? '/' + k : ''}">${l}</a>`).join('')}</div>`;

function render() {
  const h = location.hash.slice(1) || '/';
  const scroll = scrollY;
  let m;
  if (!h.startsWith('/liv')) { document.body.classList.remove('life-on'); wakeLock(false); }
  if (h.startsWith('/liv')) viewLife((h.match(/^\/liv\/([A-Z0-9]{6})$/) || [])[1]);
  else if (h.startsWith('/onskelista')) viewWishlist();
  else if ((m = h.match(/^\/lek\/([\w-]+)/))) { if (render.deck !== m[1]) { render.deck = m[1]; S.tab = 'lista'; tabBuy.sel = null; } viewDeck(m[1]); }
  else if ((m = h.match(/^\/publik\/([\w-]+)/))) viewPublicDeck(m[1]);
  else if ((m = h.match(/^\/jamfor\/([\w-]+)\/([\w-]+)/))) viewCompare(m[1], m[2]);
  else if (h.startsWith('/utforska')) viewExplore(h.split('/')[2]);
  else if (h.startsWith('/matcher')) viewGames(h.split('/')[2], h.split('/')[3]);
  else if (h.startsWith('/bygg')) viewBuild();
  else if (h.startsWith('/regler')) viewRules(h.split('/')[2]);
  else if (h.startsWith('/draft') && typeof viewDraft === 'function') viewDraft(h.split('/')[2]);
  else if (h.startsWith('/samling')) viewCollection();
  else if (h.startsWith('/installningar')) viewSettings();
  else viewDecks();
  if (render.last === h) scrollTo(0, scroll); else scrollTo(0, 0);
  render.last = h;
}
addEventListener('hashchange', () => { $('#preview').hidden = true; render(); });

(async () => {
  loadRate().then(() => S.decks.length && render());
  if (window.LV_READY) await window.LV_READY.catch(() => {}); // väntar på inloggning i molnläge
  let st;
  try {
    st = await api('/api/state');
    // senaste läget sparas så att lekarna går att titta på utan nät
    try { localStorage.setItem('lv-state', JSON.stringify({ ...st, decks: st.decks.map(({ versions, ...d }) => d) })); } catch {}
  } catch (e) {
    try { st = JSON.parse(localStorage.getItem('lv-state')); } catch {}
    if (!st) { $('#app').innerHTML = `<div class="card empty">Kunde inte ladda: ${esc(e.message)}</div>`; return; }
    S.offline = true;
    const b = document.createElement('div'); b.className = 'offline'; b.textContent = 'Ingen anslutning – du ser det senast sparade läget. Ändringar sparas inte.';
    document.body.insertBefore(b, $('#app'));
  }
  Object.assign(S, st);
  if (!S.cloud) $$('[data-nav=utforska]').forEach(a => a.remove());
  if (S.cloud && lifeState()?.room) roomJoin(lifeState().room);
  if (S.cloud && S.v4 && !S.offline) loadBookings().then(() => location.hash.startsWith('#/utforska') && render());
  if (S.cloud && S.v7 && !S.offline) loadEvents().then(updateBell);
  if (S.cloud && !S.offline && !S.profile?.name) setTimeout(askName, 600);
  if (!S.v3) $$('[data-nav=onskelista]').forEach(a => a.remove());
  updateWishBadge();
  const names = new Set([...S.decks.flatMap(d => d.cards.map(c => c.name)), ...Object.keys(S.collection), ...S.wishlist.map(w => w.name)]);
  render();
  if (names.size) { await ensureCards([...names]).catch(() => {}); render(); }
  if (!S.offline) checkWishlist();
  if (!S.offline && S.v7) valueSnapshot().then(updateBell); // värdeloggen behövs för prislarmen
})();
