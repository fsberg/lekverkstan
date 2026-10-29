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
Object.assign(S, { colmeta: {}, v4: false, bookings: null });
try { S.group = localStorage.getItem('lv-group') || 'typ'; } catch {}
// ungefärligt värde i kronor från Scryfalls europris
const krE = e => e == null ? '–' : Math.round(e * S.rate).toLocaleString('sv-SE') + ' kr';
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

async function ensureCards(names) {
  const need = [...new Set(names)].filter(n => !S.cards[n] && !S.notFound.has(n));
  if (!need.length) return [];
  const { cards, notFound } = await api('/api/cards', { method: 'POST', body: { names: need } });
  Object.assign(S.cards, cards);
  for (const n of need) if (!cards[n]) S.notFound.add(n);
  return notFound;
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
const foilQty = name => printsOf(name).filter(p => p.foil).reduce((a, p) => a + p.qty, 0);
// värde för det man äger: angivna utgåvor med sina priser, resten till billigaste utgåvan
function colValue(name) {
  const c = S.cards[name], q = S.collection[name] || 0;
  let v = 0, n = 0;
  for (const p of printsOf(name)) { v += (p.eur ?? (p.foil ? c?.eur_foil : null) ?? c?.eur ?? 0) * p.qty; n += p.qty; }
  return v + Math.max(0, q - n) * (c?.eur || 0);
}
const printLabel = p => `${p.foil ? '✦ foil ' : ''}${(p.set || '').toUpperCase()}${p.cn ? ' #' + p.cn : ''}`;

// ---------- regler ----------
const owned = name => S.collection[name] || (S.basicsOwned && BASICS.has(name) ? 999 : 0);
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
  return Object.entries(need).map(([name, qty]) => ({ name, qty, missing: Math.max(0, qty - owned(name)) })).filter(x => x.missing > 0);
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
      ${c?.image ? `<img src="${esc(c.image)}" alt="${esc(name)}">` : '<div class="empty">Ingen bild</div>'}
      <div>
        <div class="row"><h2 style="margin:0">${esc(name)}</h2><span class="spacer"></span><button class="icon-btn" data-close aria-label="Stäng">✕</button></div>
        <p class="muted small">${esc(c?.type_line || '')} ${c ? manaHtml(c.mana_cost) : ''}</p>
        <p class="oracle">${esc(c?.oracle_text || '')}</p>
        <p class="small">Commander: <b>${esc(c?.legalities.commander || '?')}</b> · Modern: <b>${esc(c?.legalities.modern || '?')}</b> · värde ca ${krE(c?.eur)} <span class="muted">(${eur(c?.eur)})</span>
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
    }
    if ($('#toWish', box)) $('#toWish', box).onclick = async () => { await addToWishlist(name); closeModal(); render(); };
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
      ${list.length ? `<table><tbody>${list.map((p, i) => `<tr><td>${esc(printLabel(p))}<div class="muted small">${esc(byId[p.id]?.set_name || '')}${byId[p.id]?.extra?.length ? ' · ' + esc(byId[p.id].extra.join(', ')) : ''}</div></td>
        <td class="num small">${krE(p.eur)}/st</td><td class="num"><input type="number" min="0" max="${total}" value="${p.qty}" data-pq="${i}" style="width:4rem"></td></tr>`).join('')}</tbody></table>` : ''}
      <p class="small">${used < total ? `${total - used} ex utan angiven utgåva.` : '<span class="good">Alla ex har en utgåva.</span>'}</p>
      ${used < total ? `<h3>Lägg till</h3>
        ${all.length > 12 ? '<p><input type="search" id="prFind" placeholder="Filtrera utgåvor, t.ex. MH2 eller borderless…" style="width:100%"></p>' : ''}
        <p><select id="prSet" style="width:100%">${all.map(p => `<option value="${p.id}">${esc(p.set.toUpperCase())} #${esc(p.cn)} – ${esc(p.set_name)}${p.extra.length ? ' (' + esc(p.extra.join(', ')) + ')' : ''} · ${p.eur != null ? krE(p.eur) : '–'}${p.eur_foil != null ? ' / foil ' + krE(p.eur_foil) : ''}</option>`).join('')}</select></p>
        <div class="row"><label class="small"><input type="checkbox" id="prFoil"> Foil</label><input type="number" id="prQty" min="1" max="${total - used}" value="1" style="width:4rem"> ex
          <span class="spacer"></span><button class="btn primary small" id="prAdd" ${all.length ? '' : 'disabled'}>Lägg till</button></div>` : ''}
      <div class="row" style="margin-top:1rem">${back ? '<button class="btn small" id="prBack">← Tillbaka</button>' : ''}<span class="spacer"></span><button class="btn primary" id="prSave">Spara</button></div>`, box => {
      const sel = $('#prSet', box);
      const syncFoil = () => { const p = byId[sel.value]; if (!p) return; const f = $('#prFoil', box); f.disabled = !(p.foil && p.nonfoil); f.checked = p.foil && !p.nonfoil ? true : p.nonfoil && !p.foil ? false : f.checked; };
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
function setNav(which) { $$('.top nav a').forEach(a => a.classList.toggle('on', a.dataset.nav === which)); }

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
        <span class="pill ${miss ? 'warn' : 'good'}">${miss ? `saknar ${miss}` : 'komplett'}</span>${rec.n ? `<span class="pill" title="Vinster i spelloggen">${rec.win}/${rec.n} vinster</span>` : ''}
        <span class="pill" title="Ungefärligt värde enligt Cardmarket-trend">${krE(deckValue(d))}</span></div>
        <div class="ownbar" title="Du äger ${Math.round(share * 100)} % av korten"><div style="width:${share * 100}%"></div></div>
        <div class="muted small">Du äger ${Math.round(share * 100)} %</div></div></a>`;
  }).join('');
  app.innerHTML = `
    <div class="row"><h1>Mina lekar</h1><span class="spacer"></span>
      <label class="small">Sortera <select id="deckSort"><option value="updated">Senast ändrad</option><option value="owned">Mest komplett</option><option value="name">Namn</option></select></label>
      <button class="btn primary" id="newDeck">+ Ny lek</button></div>
    ${S.decks.length ? `<div class="deck-grid">${tiles}</div>` : `<div class="card empty" style="margin-top:1rem">Inga lekar än. Skapa en ny, eller klistra in en lista från Moxfield/Archidekt.</div>`}`;
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

function viewDeck(id) {
  setNav('lekar');
  const deck = S.decks.find(d => d.id === id);
  if (!deck) { $('#app').innerHTML = '<div class="empty">Leken finns inte. <a href="#/">Tillbaka</a></div>'; return; }
  const missingInfo = deck.cards.filter(c => !S.cards[c.name] && !S.notFound.has(c.name)).map(c => c.name);
  if (missingInfo.length && !viewDeck.loading) {
    viewDeck.loading = true;
    ensureCards(missingInfo).catch(e => toast(e.message)).finally(() => { viewDeck.loading = false; render(); });
  }
  const tabs = [['lista', 'Lista'], ['statistik', 'Statistik'], ['provhand', 'Provhand'], ['kop', 'Köpa'], ['sok', 'Hitta kort'],
    ...(deck.format === 'commander' ? [['forslag', 'Förslag'], ['kombos', 'Kombos']] : []), ['versioner', 'Versioner'], ['text', 'Import/Export']];
  if (!tabs.some(t => t[0] === S.tab)) S.tab = 'lista';
  $('#app').innerHTML = `
    <div class="row">
      <a href="#/" class="icon-btn" aria-label="Tillbaka">←</a>
      <input type="text" id="deckName" value="${esc(deck.name)}" style="font-size:1.3rem;font-weight:700;flex:1;min-width:180px;border-color:transparent;background:transparent">
      <select id="deckFormat"><option value="commander" ${deck.format === 'commander' ? 'selected' : ''}>Commander</option><option value="modern" ${deck.format === 'modern' ? 'selected' : ''}>Modern</option></select>
      ${S.cloud ? `<label class="small row" title="Publika lekar syns för alla inloggade under Utforska. Bara du kan ändra dem."><input type="checkbox" id="deckPublic" ${deck.public ? 'checked' : ''}> Publik</label>` : ''}
      <button class="btn danger small" id="delDeck">Radera</button>
    </div>
    <div class="tabs">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${S.tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div id="tab"></div>`;
  $('#deckName').onchange = e => { deck.name = e.target.value.trim() || deck.name; saveDeckSoon(deck); };
  $('#deckFormat').onchange = e => { deck.format = e.target.value; saveDeckSoon(deck); render(); };
  if ($('#deckPublic')) $('#deckPublic').onchange = e => {
    deck.public = e.target.checked; saveDeckSoon(deck);
    toast(deck.public ? (S.profile?.name ? 'Leken är publik under Utforska' : 'Publik! Sätt ditt namn under Inställningar så syns vem den är från') : 'Leken är privat igen', 3500);
  };
  $('#delDeck').onclick = () => openModal(`<h2>Radera "${esc(deck.name)}"?</h2><p class="muted">Din samling påverkas inte.</p>
    <p class="row"><span class="spacer"></span><button class="btn" data-close>Avbryt</button><button class="btn primary" id="delOk">Radera</button></p>`, box => {
    $('#delOk', box).onclick = async () => { await api('/api/decks/' + deck.id, { method: 'DELETE' }); S.decks = S.decks.filter(d => d !== deck); closeModal(); location.hash = '#/'; };
  });
  $$('.tabs button').forEach(b => b.onclick = () => { S.tab = b.dataset.tab; render(); });
  const tab = $('#tab');
  ({ lista: tabList, statistik: tabStats, provhand: tabHand, kop: tabBuy, sok: tabSearch, forslag: tabSuggest, kombos: tabCombos, versioner: tabVersions, text: tabText })[S.tab](deck, tab);
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
  const have = owned(c.name);
  const full = have >= c.qty;
  const part = !full && have > 0;
  const showOwn = !(S.basicsOwned && BASICS.has(c.name));
  return `<li class="${full ? 'owned' : ''}" data-name="${esc(c.name)}" data-board="${c.board}">
    ${showOwn ? `<label class="own" title="Jag har detta kort"><input type="checkbox" data-own ${full ? 'checked' : ''}>${part ? `<span class="part">${have}/${c.qty}</span>` : ''}</label>` : '<span style="width:1.05rem"></span>'}
    <span class="q">${c.qty}</span>
    <span class="nm ${info ? '' : 'missing'}" data-open data-img="${esc(info?.image || '')}">${esc(c.name)}${info?.game_changer ? ' <span class="gc" title="Game changer">GC</span>' : ''}${lentQty(c.name) ? ` <span class="lent" title="Utlånat: ${esc(S.loans.filter(l => l.name === c.name).map(l => l.borrower).join(', '))}">↗</span>` : ''}</span>
    <span class="mana">${info ? manaHtml(info.mana_cost) : ''}</span>
    <span class="acts">
      ${deck.format === 'commander' && c.board !== 'commander' && info?.commander_ok ? '<button class="icon-btn" data-act="cmd" title="Gör till befälhavare">★</button>' : ''}
      <button class="icon-btn" data-act="plus" title="En till">+</button>
      <button class="icon-btn" data-act="minus" title="En mindre">−</button>
      ${c.board === 'main' ? `<button class="icon-btn" data-act="${deck.format === 'modern' ? 'side' : 'maybe'}" title="Flytta till ${deck.format === 'modern' ? 'sidolek' : 'kanske'}">⇢</button>` : '<button class="icon-btn" data-act="main" title="Flytta till huvudleken">⇠</button>'}
    </span></li>`;
}

// bildläge: samma li-struktur som listan, så att samma klick- och bock-hantering fungerar
function cardTile(c) {
  const info = S.cards[c.name];
  const have = owned(c.name), full = have >= c.qty;
  const showOwn = !(S.basicsOwned && BASICS.has(c.name));
  return `<li class="${full ? 'owned' : 'lack'}" data-name="${esc(c.name)}" data-board="${c.board}">
    ${info?.thumb ? `<img loading="lazy" src="${esc(info.thumb)}" alt="${esc(c.name)}" data-open data-img="${esc(info.image)}">` : `<div class="noimg" data-open>${esc(c.name)}</div>`}
    ${c.qty > 1 ? `<span class="qbadge">${c.qty}×</span>` : ''}
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
  const sections = order.filter(k => groups[k]).map(k => {
    const list = groups[k].sort((a, b) => (S.cards[a.name]?.cmc ?? 99) - (S.cards[b.name]?.cmc ?? 99) || a.name.localeCompare(b.name));
    return `<section><div class="section-head"><h3>${TYPE_SV[k] || k}</h3><span class="muted small">${list.reduce((a, c) => a + c.qty, 0)}</span></div>
      ${visual ? `<ul class="vgrid">${list.map(c => cardTile(c)).join('')}</ul>` : `<ul class="clist">${list.map(c => cardRow(deck, c)).join('')}</ul>`}</section>`;
  }).join('');
  const issues = deckIssues(deck);
  const miss = missingCards(deck);
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
        <div class="card"><h2>Kontroll</h2><ul class="issues">${issues.map(([k, t]) => `<li class="${k}">${esc(t)}</li>`).join('')}</ul>
          ${br ? `<h3>Bracket</h3><p style="margin:.2rem 0"><b>Ungefär ${br.b} – ${BRACKET_SV[br.b]}</b></p>
            <p class="small muted" style="margin:0">${br.why.length ? esc(br.why.join(', ')) + '.' : 'Inga game changers, kombos med två kort eller massförstörelse av länder.'}
            ${br.gc.length ? `<br>Game changers: ${esc(br.gc.join(', '))}` : ''}${br.two === null ? `<br><a href="#" id="chkCombos">Kolla kombos</a> för en säkrare bedömning.` : ''}</p>` : ''}</div>
        <div class="card"><h2>Roller</h2>
          <table class="small"><tbody>${Object.entries(rc).map(([k, v]) => {
            const t = deck.format === 'commander' && ROLE_TARGET[k];
            const cls = !t ? '' : v < t[0] ? 'warn' : v > t[1] + 4 ? 'warn' : 'good';
            return `<tr><td>${k}</td><td class="num ${cls}"><b>${v}</b></td><td class="muted">${t ? `mål ${t[0]}–${t[1]}` : ''}</td></tr>`;
          }).join('')}</tbody></table>
          <p class="muted small">Rollerna gissas från korttexten. Klicka på ett kort och välj Roll om gissningen är fel.</p></div>
        <div class="card"><h2>Samling</h2>
          <p>${miss.length ? `Du saknar <b>${miss.reduce((a, c) => a + c.missing, 0)}</b> kort (${miss.length} olika).` : '<b>Du har alla kort!</b>'}</p>
          <label class="small row"><input type="checkbox" id="basics" ${S.basicsOwned ? 'checked' : ''}> Räkna basländer som ägda</label>
          <div class="row" style="margin-top:.6rem"><button class="btn small" id="ownAll">Bocka i alla</button><button class="btn small" id="toBuy">Till köplistan →</button></div>
          <p class="muted small">Bocka i rutan framför ett kort när du har det. Det sparas i din samling och gäller alla lekar.</p>
        </div>
      </div>
    </div>`;
  addCardUI($('#addBar'), name => addToDeck(deck, name, $('#addBoard').value));
  $('#basics').onchange = e => { S.basicsOwned = e.target.checked; try { localStorage.setItem('basicsOwned', S.basicsOwned ? '1' : '0'); } catch {} render(); };
  $('#toBuy').onclick = () => { S.tab = 'kop'; render(); };
  $('#ownAll').onclick = async () => {
    const body = {};
    for (const m of missingCards(deck)) body[m.name] = m.qty;
    Object.assign(S.collection, body);
    await api('/api/collection', { method: 'PUT', body }); render();
  };
  tab.addEventListener('change', async e => {
    if (!e.target.matches('[data-own]')) return;
    const li = e.target.closest('li'), name = li.dataset.name;
    const need = deck.cards.filter(c => c.name === name && c.board !== 'maybe').reduce((a, c) => a + c.qty, 0) || 1;
    await setOwned(name, e.target.checked ? Math.max(S.collection[name] || 0, need) : 0);
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
  const value = play.reduce((a, c) => a + (S.cards[c.name]?.eur || 0) * c.qty, 0);
  const missVal = missingCards(deck).reduce((a, m) => a + (S.cards[m.name]?.eur || 0) * m.missing, 0);
  const { Länder: _l, ...roleCount } = roleCounts(deck);
  const pipNames = { W: 'Vit', U: 'Blå', B: 'Svart', R: 'Röd', G: 'Grön', C: 'Färglös' };
  const pipMax = Math.max(1, ...Object.values(pips));
  const hbars = (obj, names = {}) => `<div class="hbars">${Object.entries(obj).map(([k, v]) => `<span>${names[k] || TYPE_SV[k] || k}</span><div class="track"><div class="fill" style="width:${(v / Math.max(1, ...Object.values(obj))) * 100}%"></div></div><span class="n">${v}</span>`).join('')}</div>`;
  tab.innerHTML = `
    <div class="stats">
      <div class="stat"><b>${total}</b><span>kort i leken</span></div>
      <div class="stat"><b>${lands}</b><span>länder</span></div>
      <div class="stat"><b>${cmcN ? (cmcSum / cmcN).toFixed(2) : '–'}</b><span>snitt-manavärde</span></div>
      <div class="stat"><b>${krE(value)}</b><span>ungefärligt värde (${eur(value)})</span></div>
      <div class="stat"><b>${krE(missVal)}</b><span>för det du saknar</span></div>
      ${(r => r.n ? `<div class="stat"><b>${r.pct} %</b><span>vinster (${r.win} av ${r.n} matcher)</span></div>` : '')(deckRecord(S.games.filter(g => g.deck_id === deck.id)))}
    </div>
    <div class="grid cols-2" style="margin-top:1rem">
      <div class="card"><h2>Manakurva <span class="muted small">(icke-länder)</span></h2>${barChart(curve, ['0', '1', '2', '3', '4', '5', '6', '7+'], (l, v) => `${v} kort med manavärde ${l}`)}</div>
      <div class="card"><h2>Färgsymboler</h2>${Object.values(pips).some(Boolean) ? `<div class="hbars">${Object.entries(pips).filter(([, v]) => v).map(([k, v]) => `<span><span class="sym ${k}">${k}</span> ${pipNames[k]}</span><div class="track"><div class="fill" style="width:${(v / pipMax) * 100}%"></div></div><span class="n">${v}</span>`).join('')}</div>` : '<p class="muted">Inga färgade kort än.</p>'}</div>
      <div class="card"><h2>Korttyper</h2>${hbars(types)}</div>
      <div class="card"><h2>Roller <span class="muted small">(gissning från korttexten)</span></h2>${hbars(roleCount)}
        ${deck.format === 'commander' ? '<p class="muted small">Tumregel för Commander: ca 36–38 länder, 10 ramp, 10 kortdragning, 8–10 removal och 2–3 massborttagningar.</p>' : ''}</div>
    </div>
    <p class="muted small">Värdet bygger på Scryfalls Cardmarket-trendpris i euro, omräknat med dagens kurs (1 € = ${S.rate.toLocaleString('sv-SE')} kr). Det är en fingervisning. Butikspriser finns under Köpa.</p>`;
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
    </div>`;
  if (N < 7) return;
  $('#hNew').onclick = () => { fresh(0); render(); };
  $('#hMull').onclick = () => { fresh(Math.min(6, st.mull + 1)); render(); };
  $('#hDraw').onclick = () => { if (st.lib.length) { st.hand.push(st.lib.shift()); st.drawn++; } render(); };
  tab.querySelector('.hand').addEventListener('click', e => {
    const f = e.target.closest('figure[data-i]'); if (!f || !st.bottom) return;
    st.lib.push(...st.hand.splice(+f.dataset.i, 1)); st.bottom--; render();
  });
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
  tab.innerHTML = `<div class="card"><p class="muted">Hämtar förslag från EDHREC för ${esc(cmd.join(' + '))}…</p></div>`;
  edhrecFor(cmd).then(data => {
    if (!tab.isConnected) return;
    if (!data) { tab.innerHTML = '<div class="card empty">EDHREC har ingen sida för den här befälhavaren än.</div>'; return; }
    const inDeck = new Set(deck.cards.map(c => c.name.toLowerCase()));
    const show = c => !(opt.hideIn && inDeck.has(c.name.toLowerCase())) && !(opt.onlyOwned && !owned(c.name));
    tab.innerHTML = `<div class="card">
      <div class="row"><h2 style="margin:0">Populärt med ${esc(cmd.join(' + '))}</h2><span class="spacer"></span>
        <label class="small"><input type="checkbox" id="sgHide" ${opt.hideIn ? 'checked' : ''}> Dölj kort i leken</label>
        <label class="small"><input type="checkbox" id="sgOwned" ${opt.onlyOwned ? 'checked' : ''}> Bara kort jag äger</label></div>
      <p class="muted small">${data.decks ? `Bygger på ${data.decks.toLocaleString('sv-SE')} lekar på EDHREC. ` : ''}Andel = hur stor del av lekarna med den här befälhavaren som spelar kortet. Synergi = hur mycket vanligare kortet är här än i andra lekar.
        <a href="https://edhrec.com/commanders/${esc(data.slug)}" target="_blank" rel="noopener">Öppna på EDHREC</a></p>
      ${data.lists.map(l => {
        const cards = l.cards.filter(show);
        if (!cards.length) return '';
        return `<h3>${esc(EDH_SV[l.header] || l.header)}</h3><div class="table-scroll"><table class="small"><tbody>${cards.map(c => `<tr>
          <td style="width:1.4rem">${owned(c.name) ? '<span title="Du äger kortet" class="good">✓</span>' : ''}</td>
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
  if (S.cloud && !S.trades) loadTrades().then(() => S.tab === 'kop' && tab.isConnected && render());
  const offers = tradeIndex();
  const sel = tabBuy.sel || (tabBuy.sel = new Set());
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
            return `<tr data-name="${esc(m.name)}"><td><input type="checkbox" data-sel ${sel.has(m.name) ? 'checked' : ''}></td><td><span data-img="${esc(info?.image || '')}">${esc(m.name)}</span><div class="muted small">ca ${eur(info?.eur)}</div></td>
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
    for (const m of miss) if (sel.has(m.name)) body[m.name] = (S.collection[m.name] || 0) + m.missing;
    Object.assign(S.collection, body);
    await api('/api/collection', { method: 'PUT', body });
    toast(`${Object.keys(body).length} kort lagda i samlingen`); sel.clear(); render();
  };
  tab.addEventListener('click', async e => {
    const b = e.target.closest('[data-got]'); if (!b) return;
    const name = b.closest('tr').dataset.name;
    const need = deck.cards.filter(c => c.name === name && c.board !== 'maybe').reduce((a, c) => a + c.qty, 0);
    await setOwned(name, Math.max(S.collection[name] || 0, need)); render();
  });
  // körningen fortsätter även om sidan ritas om; knappen visar bara läget
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
  const used = {};
  for (const d of S.decks) for (const c of d.cards) if (c.board !== 'maybe') (used[c.name] = used[c.name] || new Set()).add(d.name);
  let show = viewCollection.show || 'alla';
  if (show === 'lan' && !S.v3) show = 'alla';
  const unused = names.filter(n => !used[n]).length;
  const sortBy = viewCollection.sort || 'namn';
  const shown = (show === 'oanvanda' ? names.filter(n => !used[n]) : show === 'byte' ? names.filter(n => S.trade[n]) : names.slice())
    .sort({
      varde: (a, b) => colValue(b) - colValue(a),
      senast: (a, b) => (S.colmeta[b]?.added || 0) - (S.colmeta[a]?.added || 0) || a.localeCompare(b),
      antal: (a, b) => S.collection[b] - S.collection[a] || a.localeCompare(b),
    }[sortBy] || (() => 0));
  const day = t => t ? new Date(t).toLocaleDateString('sv-SE') : '';
  const loanRows = S.loans.map(l => `<tr data-loan="${esc(l.id)}"><td><span data-img="${esc(S.cards[l.name]?.image || scryImg(l.name))}">${esc(l.name)}</span></td><td class="num">${l.qty}</td>
    <td>${esc(l.borrower)}</td><td class="small">${esc(l.lent_on)}</td><td><button class="btn small" data-back="${esc(l.id)}">Tillbaka ✓</button></td></tr>`).join('');
  $('#app').innerHTML = `<div id="col">
    <div class="row"><h1>Min samling</h1><span class="spacer"></span><span class="muted">${names.length} olika · ${total} kort · ca <b>${krE(value)}</b></span></div>
    <div class="grid cols-2" style="margin-top:1rem">
      <div class="card">
        <div class="row" style="margin-bottom:.6rem"><div class="add-bar" id="colAdd"></div><input type="search" id="colFilter" placeholder="Filtrera…" style="width:160px"></div>
        <div class="row small" style="margin-bottom:.6rem">
          <div class="seg" id="colShow"><button data-show="alla" class="${show === 'alla' ? 'on' : ''}">Alla</button><button data-show="oanvanda" class="${show === 'oanvanda' ? 'on' : ''}">Används inte i någon lek (${unused})</button>${S.cloud ? `<button data-show="byte" class="${show === 'byte' ? 'on' : ''}">Till byte (${Object.keys(S.trade).length})</button>` : ''}${S.v3 ? `<button data-show="lan" class="${show === 'lan' ? 'on' : ''}">Utlånat (${S.loans.length})</button>` : ''}</div>
          ${show !== 'lan' ? `<label>Sortera <select id="colSort">${[['namn', 'Namn'], ['varde', 'Värde'], ...(S.v4 ? [['senast', 'Senast inlagt']] : []), ['antal', 'Antal']].map(([v, l]) => `<option value="${v}" ${sortBy === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>` : ''}</div>
        ${show === 'lan' ? `${S.loans.length ? `<div class="table-scroll"><table><thead><tr><th>Kort</th><th class="num">Antal</th><th>Hos</th><th>Sedan</th><th></th></tr></thead><tbody>${loanRows}</tbody></table></div>` : '<p class="muted">Inga utlånade kort.</p>'}
          <h3>Låna ut ett kort</h3><div class="row"><div class="add-bar" id="loanCard"></div><input type="text" id="loanTo" placeholder="Till vem?" maxlength="60" style="width:140px"><input type="number" id="loanQty" min="1" max="99" value="1" style="width:4rem"></div>
          <p class="muted small">Välj kortet i listan så sparas lånet. Utlånade kort markeras med ↗ i dina lekar.</p>`
        : shown.length ? `<div class="table-scroll"><table><thead><tr><th>Kort</th><th>Typ</th><th>I lekar</th><th class="num">Värde</th><th class="num">Antal</th>${S.cloud ? '<th class="num" title="Hur många du kan tänka dig att byta bort. Syns för andra i bytesbörsen.">Till byte</th>' : ''}</tr></thead><tbody>
          ${shown.map(n => `<tr data-name="${esc(n)}"><td><span data-img="${esc(S.cards[n]?.image || '')}" data-open style="cursor:pointer">${esc(n)}</span>${lentQty(n) ? ' <span class="lent" title="Utlånat">↗</span>' : ''}${foilQty(n) ? ` <span class="foil" title="${foilQty(n)} foil">✦${foilQty(n) > 1 ? foilQty(n) : ''}</span>` : ''}${sortBy === 'senast' && S.colmeta[n]?.added ? `<div class="muted small">${day(S.colmeta[n].added)}</div>` : ''}</td>
            <td class="muted small">${esc((S.cards[n]?.type_line || '').split(' — ')[0])}</td>
            <td class="small muted">${used[n] ? esc([...used[n]].join(', ')) : ''}</td>
            <td class="num small">${S.cards[n]?.eur || printsOf(n).length ? krE(colValue(n)) : ''}</td>
            <td class="num"><input type="number" min="0" max="999" value="${S.collection[n]}" style="width:4.5rem" data-qty></td>
            ${S.cloud ? `<td class="num"><input type="number" min="0" max="${S.collection[n]}" value="${S.trade[n] || 0}" style="width:4.5rem" data-trade></td>` : ''}</tr>`).join('')}
          </tbody></table></div>` : `<div class="empty">${names.length ? 'Inga kort med det filtret.' : 'Samlingen är tom. Bocka i kort i dina lekar, sök ovan, eller klistra in en lista till höger.'}</div>`}
      </div>
      <div class="grid" style="align-content:start">
        <div class="card"><h2>Skanna kort</h2>
          <p class="small muted">Håll upp korten framför kameran ett i taget. Appen läser namnet och lägger till kortet.</p>
          <button class="btn primary" id="scanGo">📷 Starta kameran</button></div>
        <div class="card"><h2>Lägg till många</h2>
        <textarea id="colImp" placeholder="4 Lightning Bolt&#10;1 Sol Ring" style="min-height:160px"></textarea>
        <div class="row"><span class="spacer"></span><button class="btn primary" id="colImpGo">Lägg till i samlingen</button></div>
        <p class="muted small">Antalen läggs ovanpå det du redan har.</p></div></div>
    </div></div>`;
  $('#scanGo').onclick = () => scanModal();
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
    ${S.cloud ? `<h3>Ditt namn</h3>
    <p class="small muted">Syns för andra inloggade på dina publika lekar och i bytesbörsen. Inloggad som ${esc(S.profile.email || '')}.</p>
    <div class="row"><input type="text" id="dispName" maxlength="40" placeholder="T.ex. Jonte" style="flex:1" value="${esc(S.profile.name || '')}"><button class="btn primary" id="saveName">Spara namn</button></div>` : ''}
    <h3>Installera som app</h3>
    ${window.matchMedia?.('(display-mode: standalone)').matches ? '<p class="small good">Lekverkstan körs redan som installerad app.</p>'
      : installEvt ? '<p class="small muted">Lägg Lekverkstan på hemskärmen. Den startar då som en vanlig app och lekarna går att titta på utan nät.</p><button class="btn primary" id="install">Installera</button>'
      : '<p class="small muted">På iPhone: tryck på Dela-knappen i Safari och välj <b>Lägg till på hemskärmen</b>. På Android: öppna menyn i Chrome och välj <b>Installera app</b> eller <b>Lägg till på startskärmen</b>.</p>'}
    <h3>Om priser</h3>
    <p class="small muted">Värden i kronor räknas om från Scryfalls europriser med dagens kurs, 1 € = ${S.rate.toLocaleString('sv-SE')} kr.</p>
    <p class="small muted">Alara-priser hämtas från butikens öppna sidor, cachas i 6 timmar och visar bara varianter som finns i lager. Cardmarket har inget öppet API för privatpersoner, därför används en önskelista plus deras egen Shopping Wizard.</p>
  </div>`;
  if ($('#install')) $('#install').onclick = async () => { installEvt.prompt(); await installEvt.userChoice.catch(() => {}); installEvt = null; render(); };
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
const deckValue = d => d.cards.filter(c => c.board !== 'maybe').reduce((a, c) => a + (S.cards[c.name]?.eur || 0) * c.qty, 0);
// andel av lekens kort (exkl. kanske) som finns i samlingen
function ownedShare(d) {
  let need = 0, have = 0;
  for (const c of d.cards) if (c.board !== 'maybe') { need += c.qty; have += Math.min(c.qty, owned(c.name)); }
  return need ? have / need : 1;
}
function deckArt(d) {
  const c = d.cards.find(x => x.board === 'commander') || d.cards.find(x => x.board === 'main' && mainType(S.cards[x.name]) !== 'Land');
  return c && S.cards[c.name]?.image;
}

function viewExplore(sub) {
  setNav('utforska');
  const tabs = [['lekar', 'Publika lekar'], ['byte', 'Bytesbörs'], ...(S.v4 ? [['bokningar', 'Bokningar' + (bookingAlerts() ? ` <span class="badge">${bookingAlerts()}</span>` : '')]] : [])];
  sub = ['byte', 'bokningar'].includes(sub) ? sub : 'lekar';
  $('#app').innerHTML = `<div class="row"><h1>Utforska</h1><span class="spacer"></span><button class="btn small" id="reload">↻ Uppdatera</button></div>
    <div class="tabs">${tabs.map(([k, l]) => `<a class="${k === sub ? 'on' : ''}" href="#/utforska/${k}">${l}</a>`).join('')}</div><div id="ex"></div>`;
  $('#reload').onclick = async () => { await Promise.all([loadPublic(true), loadTrades(true), loadBookings(true)]); render(); };
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
    ${rows.length ? `<div class="table-scroll"><table><thead><tr><th>Kort</th><th>Har till byte</th><th class="num">Antal</th><th class="num" title="Billigaste utgåvan enligt Cardmarket-trend">Pris ca</th><th>Behövs i</th>${S.v4 ? '<th></th>' : ''}</tr></thead><tbody>
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

// ---------- bokningar i bytesbörsen ----------
const BOOK_SV = { requested: 'Väntar på svar', accepted: 'Godkänd', declined: 'Nekad', done: 'Klar', cancelled: 'Ångrad' };
async function loadBookings(force) {
  if (!S.cloud || !S.v4) { S.bookings = []; return; }
  if (S.bookings && !force && Date.now() - loadBookings.at < 60000) return;
  S.bookings = await api('/api/bookings').catch(() => S.bookings || []);
  loadBookings.at = Date.now();
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
  try { localStorage.setItem('lv-book-seen', String(Date.now())); } catch {}
  const open = b => ['requested', 'accepted'].includes(b.status);
  const inc = S.bookings.filter(b => !b.mine), out = S.bookings.filter(b => b.mine);
  const sortB = a => a.slice().sort((x, y) => open(y) - open(x) || Date.parse(y.updated) - Date.parse(x.updated));
  const row = b => `<tr data-id="${esc(b.id)}" class="${!b.mine && b.status === 'requested' ? 'alert' : ''}">
    <td><span data-img="${esc(S.cards[b.name]?.image || scryImg(b.name))}">${esc(b.name)}</span> <span class="muted">× ${b.qty}</span>
      ${b.note ? `<div class="small">”${esc(b.note)}”</div>` : ''}${b.reply ? `<div class="small muted">Svar: ”${esc(b.reply)}”</div>` : ''}</td>
    <td>${esc(b.other)}</td><td><span class="pill ${b.status === 'accepted' || b.status === 'done' ? 'good' : ''}">${BOOK_SV[b.status]}</span><div class="muted small">${new Date(b.updated).toLocaleDateString('sv-SE')}</div></td>
    <td class="num">${b.mine
      ? (open(b) ? '<button class="btn small" data-bs="cancelled">Ångra</button>' : `${b.status === 'done' ? '<button class="btn small" data-bown>+ Samlingen</button> ' : ''}<button class="icon-btn" data-bdel title="Ta bort">✕</button>`)
      : b.status === 'requested' ? '<button class="btn small primary" data-bs="accepted">Godkänn</button> <button class="btn small" data-bs="declined">Neka</button>'
      : b.status === 'accepted' ? '<button class="btn small primary" data-bs="done">Överlämnat ✓</button> <button class="btn small" data-bs="declined">Neka</button>'
      : '<button class="icon-btn" data-bdel title="Ta bort">✕</button>'}</td></tr>`;
  const table = (list, who) => list.length ? `<div class="table-scroll"><table><thead><tr><th>Kort</th><th>${who}</th><th>Status</th><th></th></tr></thead><tbody>${sortB(list).map(row).join('')}</tbody></table></div>` : '';
  ex.innerHTML = `<div class="card"><h2>Förfrågningar på mina kort</h2>${table(inc, 'Från') || '<p class="muted">Ingen har bokat dina kort än.</p>'}</div>
    <div class="card"><h2>Mina bokningar</h2>${table(out, 'Hos') || '<p class="muted">Du har inte bokat något. Boka kort under <a href="#/utforska/byte">Bytesbörs</a>.</p>'}</div>
    <p class="muted small">Bara du och den andra ser en bokning. När du markerar ett kort som överlämnat kan du ta bort det ur din samling.</p>`;
  updateBookBadge();
  ex.addEventListener('click', async e => {
    const tr = e.target.closest('tr[data-id]'); if (!tr) return;
    const b = S.bookings.find(x => x.id === tr.dataset.id);
    try {
      const s = e.target.closest('[data-bs]');
      if (s) {
        const status = s.dataset.bs;
        let reply;
        if (!b.mine && (status === 'accepted' || status === 'declined')) { reply = prompt(status === 'accepted' ? 'Svar till ' + b.other + ' (valfritt), t.ex. när ni kan ses:' : 'Varför? (valfritt)', b.reply || ''); if (reply === null) return; }
        if (status === 'cancelled' && !confirm(`Ångra bokningen av ${b.name}?`)) return;
        Object.assign(b, await api('/api/bookings/' + b.id, { method: 'PUT', body: { status, ...(reply != null ? { reply } : {}) } }));
        if (status === 'done' && S.collection[b.name] && confirm(`Ta bort ${b.qty} ex ${b.name} ur din samling?`)) {
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
      <button class="btn primary" id="copyDeck">Kopiera till mina lekar</button></div>
    <div class="grid cols-2" style="margin-top:1rem">
      <div class="card"><div class="cols-cards">${order.filter(k => groups[k]).map(k => `<section><div class="section-head"><h3>${TYPE_SV[k]}</h3><span class="muted small">${groups[k].reduce((a, c) => a + c.qty, 0)}</span></div>
        <ul class="clist">${groups[k].sort((a, b) => (S.cards[a.name]?.cmc ?? 99) - (S.cards[b.name]?.cmc ?? 99) || a.name.localeCompare(b.name)).map(c => {
          const have = owned(c.name) >= c.qty;
          return `<li class="${have ? 'owned' : ''}"><span style="width:1.05rem" class="good">${have ? '✓' : ''}</span><span class="q">${c.qty}</span><span class="nm" data-img="${esc(S.cards[c.name]?.image || '')}">${esc(c.name)}</span><span class="mana">${S.cards[c.name] ? manaHtml(S.cards[c.name].mana_cost) : ''}</span></li>`;
        }).join('')}</ul></section>`).join('')}</div></div>
      <div class="grid" style="align-content:start">
        <div class="card"><h2>Du och leken</h2><p>Du äger <b>${Math.round(ownedShare(d) * 100)} %</b> av korten. ${miss.length ? `Det saknas <b>${miss.reduce((a, m) => a + m.missing, 0)}</b> kort.` : 'Du kan bygga den direkt!'}</p>
          <p class="muted small">✓ = du har kortet i din samling.</p></div>
        ${d.notes ? `<div class="card"><h2>Anteckningar</h2><p style="white-space:pre-wrap">${esc(d.notes)}</p></div>` : ''}
      </div></div>`;
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
function viewGames() {
  setNav('matcher');
  const today = new Date().toISOString().slice(0, 10);
  const byDeck = {};
  for (const g of S.games) (byDeck[g.deck_id || 'x:' + g.deck_name] = byDeck[g.deck_id || 'x:' + g.deck_name] || { name: g.deck_name, games: [] }).games.push(g);
  const stats = Object.values(byDeck).map(x => ({ ...x, ...deckRecord(x.games) })).sort((a, b) => b.n - a.n);
  const total = deckRecord(S.games);
  $('#app').innerHTML = `<div id="gm"><div class="row"><h1>Matcher</h1><span class="spacer"></span><span class="muted">${total.n} matcher · ${total.pct} % vinster</span>
      <a class="btn primary" href="#/liv">▶ Livräknare${lifeState()?.players ? ' (pågår)' : ''}</a></div>
    <div class="grid cols-2" style="margin-top:1rem">
      <div class="grid" style="align-content:start">
        <div class="card"><h2>Per lek</h2>${stats.length ? `<table><thead><tr><th>Lek</th><th class="num">Matcher</th><th class="num">V–F–O</th><th class="num">Vinst</th></tr></thead><tbody>
          ${stats.map(s => `<tr><td>${esc(s.name)}</td><td class="num">${s.n}</td><td class="num">${s.win}–${s.loss}–${s.draw}</td><td class="num"><b>${s.pct} %</b></td></tr>`).join('')}</tbody></table>` : '<p class="muted">Inga matcher loggade än.</p>'}</div>
        <div class="card"><h2>Senaste matcherna</h2>${S.games.length ? `<div class="table-scroll"><table><thead><tr><th>Datum</th><th>Lek</th><th>Resultat</th><th>Mot</th><th></th></tr></thead><tbody>
          ${S.games.slice(0, 100).map(g => `<tr><td class="small">${esc(g.played_on)}</td><td>${esc(g.deck_name)}</td>
            <td><span class="pill ${g.result === 'win' ? 'good' : g.result === 'loss' ? 'bad' : ''}">${RES_SV[g.result]}</span> <span class="muted small">${g.players} sp.</span></td>
            <td class="small">${esc(g.opponents)}${g.notes ? `<div class="muted">${esc(g.notes)}</div>` : ''}</td>
            <td><button class="icon-btn" data-delg="${esc(g.id)}" title="Ta bort">✕</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Här hamnar dina matcher.</p>'}</div>
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
        <p class="muted small">Spelloggen är privat, ingen annan ser den.</p></div>
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
    const b = e.target.closest('[data-delg]'); if (!b) return;
    if (!confirm('Ta bort matchen?')) return;
    await api('/api/games/' + b.dataset.delg, { method: 'DELETE' });
    S.games = S.games.filter(g => g.id !== b.dataset.delg); render();
  });
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
}
function viewWishlist() {
  setNav('onskelista');
  if (!S.v3) { $('#app').innerHTML = '<div class="card empty">Önskelistan kräver en uppdatering av databasen.</div>'; return; }
  const unknown = S.wishlist.map(w => w.name).filter(n => !S.cards[n] && !S.notFound.has(n));
  if (unknown.length && !viewWishlist.loading) { viewWishlist.loading = true; ensureCards(unknown).catch(() => {}).finally(() => { viewWishlist.loading = false; render(); }); }
  const list = S.wishlist.slice().sort((a, b) => (b.alert - a.alert) || a.name.localeCompare(b.name));
  const alerts = list.filter(w => w.alert).length;
  $('#app').innerHTML = `<div id="wl"><div class="row"><h1>Önskelista</h1><span class="spacer"></span>
      ${alerts ? `<button class="btn small" id="wSeen">Markera ${alerts} nyheter som sedda</button>` : ''}<button class="btn small" id="wCheck" ${checkWishlist.busy ? 'disabled' : ''}>${checkWishlist.busy ? 'Kollar…' : '↻ Kolla Alara nu'}</button></div>
    <div class="grid cols-2" style="margin-top:1rem">
      <div class="card">
        <div class="row" style="margin-bottom:.6rem"><div class="add-bar" id="wAdd"></div></div>
        ${list.length ? `<div class="table-scroll"><table><thead><tr><th>Kort</th><th class="num">Antal</th><th class="num" title="Larma när priset hos Alara är högst så här mycket">Maxpris</th><th>Alara</th><th>Kollad</th><th></th></tr></thead><tbody>
        ${list.map(w => `<tr data-name="${esc(w.name)}" class="${w.alert ? 'alert' : ''}"><td>${w.alert ? '<span class="badge">Nytt</span> ' : ''}<span data-img="${esc(S.cards[w.name]?.image || scryImg(w.name))}">${esc(w.name)}</span><div class="muted small">trend ca ${krE(S.cards[w.name]?.eur)}</div></td>
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
const LIFE_KEY = 'lv-life';
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
function viewLife() {
  setNav('matcher');
  const s = lifeState();
  if (!s || !s.players) {
    document.body.classList.remove('life-on');
    const last = s?.setup || { n: 4, life: 40, names: ['Jag', '', '', '', '', ''], deck: S.decks[0]?.id || '' };
    $('#app').innerHTML = `<div class="card" style="max-width:520px;margin:0 auto"><div class="row"><a href="#/matcher" class="icon-btn" aria-label="Tillbaka">←</a><h1 style="margin:0">Livräknare</h1></div>
      <p class="row"><label class="small">Spelare<br><select id="lN">${[2, 3, 4, 5, 6].map(n => `<option ${n === last.n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <label class="small">Startliv<br><select id="lL">${[40, 30, 25, 20].map(n => `<option ${n === last.life ? 'selected' : ''}>${n}</option>`).join('')}</select></label></p>
      <div id="lNames"></div>
      <p><label class="small">Min lek (för spelloggen)<br><select id="lDeck" style="width:100%"><option value="">Logga inte matchen</option>${S.decks.map(d => `<option value="${d.id}" ${d.id === last.deck ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></label></p>
      <p class="row"><span class="spacer"></span><button class="btn primary" id="lGo">Starta</button></p>
      <p class="muted small">Skärmen hålls tänd medan räknaren är öppen. Liv, gift och befälhavarskada sparas i telefonen om sidan laddas om.</p></div>`;
    const names = () => { const n = +$('#lN').value; $('#lNames').innerHTML = Array.from({ length: n }, (_, i) => `<p><input type="text" data-pn="${i}" maxlength="20" placeholder="Spelare ${i + 1}" value="${esc(last.names[i] || '')}" style="width:100%"></p>`).join(''); };
    names(); $('#lN').onchange = names;
    $('#lDeck').onchange = e => { const d = S.decks.find(x => x.id === e.target.value); if (d) $('#lL').value = d.format === 'modern' ? '20' : '40'; };
    $('#lGo').onclick = () => {
      const n = +$('#lN').value, life = +$('#lL').value;
      const nm = $$('[data-pn]').map((i, k) => i.value.trim() || `Spelare ${k + 1}`);
      lifeState.s = { setup: { n, life, names: nm, deck: $('#lDeck').value }, start: Date.now(), players: nm.map(name => ({ name, life, poison: 0, cmd: {} })) };
      saveLife(); render();
    };
    return;
  }
  document.body.classList.add('life-on');
  wakeLock(true);
  const n = s.players.length;
  const top = n === 2 ? 1 : Math.floor(n / 2);
  $('#app').innerHTML = `<div class="life n${n}">${s.players.map((p, i) => `
    <div class="pl ${i < top ? 'flip' : ''} ${isOut(p, s) ? 'out' : ''}" data-p="${i}">
      <div class="pname">${esc(p.name)}</div>
      <button class="hit minus" data-d="-1" aria-label="Minus ett liv"></button><button class="hit plus" data-d="1" aria-label="Plus ett liv"></button>
      <div class="lifeval">${p.life}</div>
      <div class="extra">${p.poison ? `<span title="Gift">☠ ${p.poison}</span>` : ''}${s.players.map((_, j) => p.cmd[j] ? `<span title="Befälhavarskada från ${esc(s.players[j].name)}">⚔ ${esc(s.players[j].name.slice(0, 8))} ${p.cmd[j]}</span>` : '').join('')}</div>
      <button class="more" data-more aria-label="Gift och befälhavarskada">⋯</button>
    </div>`).join('')}
    <div class="lbar"><button class="btn small" id="lEnd">Avsluta</button><button class="btn small" id="lReset">Börja om</button><button class="btn small" id="lExit">Stäng</button></div></div>`;
  const life = $('.life');
  // håll inne = ±10 i taget
  let hold, held;
  const change = (i, d) => { const p = s.players[i]; p.life += d; saveLife(); const pl = $(`.pl[data-p="${i}"]`); $('.lifeval', pl).textContent = p.life; pl.classList.toggle('out', isOut(p, s)); };
  life.addEventListener('pointerdown', e => {
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
  $('#lReset').onclick = () => { if (!confirm('Börja om med samma spelare?')) return; for (const p of s.players) Object.assign(p, { life: s.setup.life, poison: 0, cmd: {} }); s.start = Date.now(); saveLife(); render(); };
  $('#lExit').onclick = () => { wakeLock(false); document.body.classList.remove('life-on'); location.hash = '#/matcher'; };
  $('#lEnd').onclick = () => lifeEnd();
}
function lifeMore(i) {
  const s = lifeState(), p = s.players[i];
  const row = (label, key, j) => `<div class="row" style="justify-content:space-between"><span>${label}</span><span class="row"><button class="btn small" data-k="${key}" data-j="${j ?? ''}" data-d="-1">−</button><b style="min-width:2rem;text-align:center">${key === 'poison' ? p.poison : p.cmd[j] || 0}</b><button class="btn small" data-k="${key}" data-j="${j ?? ''}" data-d="1">+</button></span></div>`;
  openModal(`<div class="row"><h2 style="margin:0">${esc(p.name)}</h2><span class="spacer"></span><button class="icon-btn" data-close aria-label="Stäng">✕</button></div>
    <h3>Gift</h3>${row('☠ Giftmarkörer (10 = ute)', 'poison')}
    <h3>Befälhavarskada (21 = ute)</h3>${s.players.map((o, j) => j === i ? '' : row('⚔ från ' + esc(o.name), 'cmd', j)).join('')}
    <p class="muted small">Befälhavarskada drar också av liv.</p>`, box => {
    box.onclick = e => {
      const b = e.target.closest('[data-k]'); if (!b) return;
      const d = +b.dataset.d;
      if (b.dataset.k === 'poison') p.poison = Math.max(0, p.poison + d);
      else { const j = +b.dataset.j, before = p.cmd[j] || 0, after = Math.max(0, before + d); p.cmd[j] = after; p.life -= after - before; }
      saveLife(); lifeMore(i); render();
    };
  });
}
function lifeEnd() {
  const s = lifeState();
  const alive = s.players.map((p, i) => ({ p, i })).filter(x => !isOut(x.p, s));
  openModal(`<div class="row"><h2 style="margin:0">Vem vann?</h2><span class="spacer"></span><button class="icon-btn" data-close aria-label="Stäng">✕</button></div>
    <div class="grid" style="margin-top:.6rem">${s.players.map((p, i) => `<button class="btn ${alive.length === 1 && alive[0].i === i ? 'primary' : ''}" data-win="${i}">${esc(p.name)}</button>`).join('')}<button class="btn" data-win="draw">Oavgjort</button></div>
    <p class="muted small">${s.setup.deck ? 'Matchen sparas i spelloggen med din lek.' : 'Ingen lek vald, matchen sparas inte i spelloggen.'}</p>
    <div class="row" style="margin-top:.8rem"><span class="spacer"></span><button class="btn small" id="lAbort">Avbryt matchen utan resultat</button></div>`, box => {
    $('#lAbort', box).onclick = () => {
      if (!confirm('Avbryta matchen? Den sparas inte i spelloggen.')) return;
      lifeState.s = { setup: s.setup }; saveLife(); closeModal(); wakeLock(false); document.body.classList.remove('life-on'); location.hash = '#/matcher';
      toast('Matchen avbröts');
    };
    box.onclick = async e => {
      const b = e.target.closest('[data-win]'); if (!b) return;
      const w = b.dataset.win, d = S.decks.find(x => x.id === s.setup.deck);
      if (d) {
        const result = w === 'draw' ? 'draw' : +w === 0 ? 'win' : 'loss';
        const mins = Math.round((Date.now() - s.start) / 60000);
        try {
          const g = await api('/api/games', { method: 'POST', body: { deck_id: d.id, deck_name: d.name, result, players: s.players.length,
            opponents: s.players.slice(1).map(p => p.name).join(', '), notes: `Livräknare: ${w === 'draw' ? 'oavgjort' : s.players[+w].name + ' vann'}, ${mins} min` } });
          S.games.unshift(g); toast('Matchen är sparad');
        } catch (err) { toast('Kunde inte spara: ' + err.message, 4000); }
      }
      lifeState.s = { setup: s.setup }; saveLife(); closeModal(); wakeLock(false); document.body.classList.remove('life-on'); location.hash = '#/matcher';
    };
  });
}

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
function render() {
  const h = location.hash.slice(1) || '/';
  const scroll = scrollY;
  let m;
  if (!h.startsWith('/liv')) { document.body.classList.remove('life-on'); wakeLock(false); }
  if (h.startsWith('/liv')) viewLife();
  else if (h.startsWith('/onskelista')) viewWishlist();
  else if ((m = h.match(/^\/lek\/([\w-]+)/))) { if (render.deck !== m[1]) { render.deck = m[1]; S.tab = 'lista'; tabBuy.sel = null; } viewDeck(m[1]); }
  else if ((m = h.match(/^\/publik\/([\w-]+)/))) viewPublicDeck(m[1]);
  else if (h.startsWith('/utforska')) viewExplore(h.split('/')[2]);
  else if (h.startsWith('/matcher')) viewGames();
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
  else if (S.v4 && !S.offline) loadBookings().then(() => location.hash.startsWith('#/utforska') && render());
  if (!S.v3) $$('[data-nav=onskelista]').forEach(a => a.remove());
  updateWishBadge();
  const names = new Set([...S.decks.flatMap(d => d.cards.map(c => c.name)), ...Object.keys(S.collection), ...S.wishlist.map(w => w.name)]);
  render();
  if (names.size) { await ensureCards([...names]).catch(() => {}); render(); }
  if (!S.offline) checkWishlist();
})();
