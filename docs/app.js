// Lekverkstan – gränssnitt (vanilla JS, ingen byggprocess)
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const kr = n => n == null ? '–' : n.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' kr';
const eur = n => n == null ? '–' : '€' + n.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const S = { decks: [], collection: {}, settings: {}, cards: {}, alara: {}, tab: 'lista', basicsOwned: true, notFound: new Set(), alaraRun: null };
try { S.basicsOwned = localStorage.getItem('basicsOwned') !== '0'; } catch {}

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
  if (qty) S.collection[name] = qty; else delete S.collection[name];
  await api('/api/collection', { method: 'PUT', body: { [name]: qty } });
}

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
  const m = $('#modal'); $('.modal-box', m).innerHTML = html; m.hidden = false; $('#preview').hidden = true;
  onMount && onMount($('.modal-box', m));
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
        <p class="small">Commander: <b>${esc(c?.legalities.commander || '?')}</b> · Modern: <b>${esc(c?.legalities.modern || '?')}</b> · Cardmarket-trend ca ${eur(c?.eur)}</p>
        <div class="row small">
          <label class="own">Jag äger <input type="number" min="0" max="999" value="${S.collection[name] || 0}" id="ownQty" style="width:5rem"> ex</label>
        </div>
        ${entry ? `<h3>I leken</h3><div class="row">
          <select id="boardSel">${['main', 'commander', 'side', 'maybe'].map(b => `<option value="${b}" ${entry.board === b ? 'selected' : ''}>${b === 'main' ? 'Huvudlek' : TYPE_SV[b] || 'Befälhavare'}</option>`).join('')}</select>
          <input type="number" id="deckQty" min="1" max="99" value="${entry.qty}" style="width:5rem"> ex
        </div>` : ''}
        <div class="links" style="margin-top:1rem">${buyLinks(name)}${c?.scryfall ? `<a href="${esc(c.scryfall)}" target="_blank" rel="noopener">Scryfall</a>` : ''}</div>
      </div>
    </div>`, box => {
    $('#ownQty', box).addEventListener('change', async e => { await setOwned(name, +e.target.value); render(); });
    if (entry) {
      $('#boardSel', box).addEventListener('change', e => { entry.board = e.target.value; saveDeckSoon(deck); render(); });
      $('#deckQty', box).addEventListener('change', e => { entry.qty = Math.max(1, +e.target.value || 1); saveDeckSoon(deck); render(); });
    }
  });
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
  const tiles = S.decks.slice().sort((a, b) => b.updated - a.updated).map(d => {
    const cmd = d.cards.find(c => c.board === 'commander') || d.cards.find(c => c.board === 'main' && mainType(S.cards[c.name]) !== 'Land');
    const art = cmd && S.cards[cmd.name]?.image;
    const total = d.cards.filter(c => c.board === 'main' || c.board === 'commander').reduce((a, c) => a + c.qty, 0);
    const miss = missingCards(d).reduce((a, c) => a + c.missing, 0);
    return `<a class="card deck-tile" href="#/lek/${d.id}">
      <div class="art" style="${art ? `background-image:url('${esc(art).replace(/'/g, '%27')}')` : ''}"></div>
      <div class="body"><b>${esc(d.name)}</b>
        <div class="row small" style="margin-top:.3rem"><span class="pill">${FORMAT_SV[d.format]}</span><span class="pill">${total} kort</span>
        <span class="pill ${miss ? 'warn' : 'good'}">${miss ? `saknar ${miss}` : 'komplett'}</span></div></div></a>`;
  }).join('');
  app.innerHTML = `
    <div class="row"><h1>Mina lekar</h1><span class="spacer"></span><button class="btn primary" id="newDeck">+ Ny lek</button></div>
    ${S.decks.length ? `<div class="deck-grid">${tiles}</div>` : `<div class="card empty" style="margin-top:1rem">Inga lekar än. Skapa en ny, eller klistra in en lista från Moxfield/Archidekt.</div>`}`;
  $('#newDeck').onclick = () => openModal(`
    <div class="row"><h2 style="margin:0">Ny lek</h2><span class="spacer"></span><button class="icon-btn" data-close>✕</button></div>
    <p><input type="text" id="nd-name" placeholder="Namn, t.ex. Atraxa-superfriends" style="width:100%"></p>
    <p class="row"><label><input type="radio" name="nd-f" value="commander" checked> Commander</label><label><input type="radio" name="nd-f" value="modern"> Modern</label></p>
    <h3>Klistra in lista (valfritt)</h3>
    <textarea id="nd-list" placeholder="1 Sol Ring&#10;1 Arcane Signet&#10;...&#10;&#10;Rubriker som Commander / Deck / Sideboard fungerar, liksom export från Moxfield, Archidekt och MTG Arena."></textarea>
    <p class="row"><span class="spacer"></span><button class="btn primary" id="nd-ok">Skapa</button></p>`, box => {
    $('#nd-name', box).focus();
    $('#nd-ok', box).onclick = async () => {
      const format = $('input[name=nd-f]:checked', box).value;
      const d = await api('/api/decks', { method: 'POST', body: { name: $('#nd-name', box).value.trim() || 'Ny lek', format } });
      const list = parseList($('#nd-list', box).value, format);
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
  const tabs = [['lista', 'Lista'], ['statistik', 'Statistik'], ['kop', 'Köpa'], ['sok', 'Hitta kort'], ['text', 'Import/Export']];
  $('#app').innerHTML = `
    <div class="row">
      <a href="#/" class="icon-btn" aria-label="Tillbaka">←</a>
      <input type="text" id="deckName" value="${esc(deck.name)}" style="font-size:1.3rem;font-weight:700;flex:1;min-width:180px;border-color:transparent;background:transparent">
      <select id="deckFormat"><option value="commander" ${deck.format === 'commander' ? 'selected' : ''}>Commander</option><option value="modern" ${deck.format === 'modern' ? 'selected' : ''}>Modern</option></select>
      <button class="btn danger small" id="delDeck">Radera</button>
    </div>
    <div class="tabs">${tabs.map(([k, l]) => `<button data-tab="${k}" class="${S.tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div id="tab"></div>`;
  $('#deckName').onchange = e => { deck.name = e.target.value.trim() || deck.name; saveDeckSoon(deck); };
  $('#deckFormat').onchange = e => { deck.format = e.target.value; saveDeckSoon(deck); render(); };
  $('#delDeck').onclick = () => openModal(`<h2>Radera "${esc(deck.name)}"?</h2><p class="muted">Din samling påverkas inte.</p>
    <p class="row"><span class="spacer"></span><button class="btn" data-close>Avbryt</button><button class="btn primary" id="delOk">Radera</button></p>`, box => {
    $('#delOk', box).onclick = async () => { await api('/api/decks/' + deck.id, { method: 'DELETE' }); S.decks = S.decks.filter(d => d !== deck); closeModal(); location.hash = '#/'; };
  });
  $$('.tabs button').forEach(b => b.onclick = () => { S.tab = b.dataset.tab; render(); });
  const tab = $('#tab');
  ({ lista: tabList, statistik: tabStats, kop: tabBuy, sok: tabSearch, text: tabText })[S.tab](deck, tab);
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
    <span class="nm ${info ? '' : 'missing'}" data-open data-img="${esc(info?.image || '')}">${esc(c.name)}</span>
    <span class="mana">${info ? manaHtml(info.mana_cost) : ''}</span>
    <span class="acts">
      ${deck.format === 'commander' && c.board !== 'commander' && info?.commander_ok ? '<button class="icon-btn" data-act="cmd" title="Gör till befälhavare">★</button>' : ''}
      <button class="icon-btn" data-act="plus" title="En till">+</button>
      <button class="icon-btn" data-act="minus" title="En mindre">−</button>
      ${c.board === 'main' ? `<button class="icon-btn" data-act="${deck.format === 'modern' ? 'side' : 'maybe'}" title="Flytta till ${deck.format === 'modern' ? 'sidolek' : 'kanske'}">⇢</button>` : '<button class="icon-btn" data-act="main" title="Flytta till huvudleken">⇠</button>'}
    </span></li>`;
}

function tabList(deck, tab) {
  const groups = {};
  for (const c of deck.cards) {
    const k = c.board === 'main' ? mainType(S.cards[c.name]) : c.board === 'commander' ? 'Commander' : c.board;
    (groups[k] = groups[k] || []).push(c);
  }
  const order = ['Commander', ...TYPE_ORDER, 'Other', 'side', 'maybe'];
  const sections = order.filter(k => groups[k]).map(k => {
    const list = groups[k].sort((a, b) => (S.cards[a.name]?.cmc ?? 99) - (S.cards[b.name]?.cmc ?? 99) || a.name.localeCompare(b.name));
    return `<section><div class="section-head"><h3>${TYPE_SV[k]}</h3><span class="muted small">${list.reduce((a, c) => a + c.qty, 0)}</span></div>
      <ul class="clist">${list.map(c => cardRow(deck, c)).join('')}</ul></section>`;
  }).join('');
  const issues = deckIssues(deck);
  const miss = missingCards(deck);
  tab.innerHTML = `
    <div class="grid cols-2">
      <div class="card">
        <div class="row" style="margin-bottom:.6rem"><div class="add-bar" id="addBar"></div>
          <select id="addBoard"><option value="main">Huvudlek</option>${deck.format === 'commander' ? '<option value="commander">Befälhavare</option>' : '<option value="side">Sidolek</option>'}<option value="maybe">Kanske</option></select></div>
        ${deck.cards.length ? `<div class="cols-cards">${sections}</div>` : '<div class="empty">Leken är tom. Sök ett kort ovan, eller klistra in en lista under Import/Export.</div>'}
      </div>
      <div class="grid" style="align-content:start">
        <div class="card"><h2>Kontroll</h2><ul class="issues">${issues.map(([k, t]) => `<li class="${k}">${esc(t)}</li>`).join('')}</ul></div>
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
  // roller via enkla textmönster
  const roles = { 'Ramp': /add \{|search your library for (a|up to \w+) (basic )?land|put .* land .* onto the battlefield/i, 'Kortdragning': /draw (a|two|three|\w+) cards?|draws? a card/i, 'Removal': /destroy target|exile target|deals? \d+ damage to (any|target)|counter target|return target .* to (its|their) owner'?s hand/i, 'Massborttagning': /destroy all|exile all|each creature|all creatures get -/i, 'Tutors': /search your library for a (?!basic|land)/i };
  const roleCount = Object.fromEntries(Object.keys(roles).map(k => [k, 0]));
  for (const c of nonLand) {
    const t = S.cards[c.name]?.oracle_text || '';
    for (const [k, re] of Object.entries(roles)) if (re.test(t)) roleCount[k] += c.qty;
  }
  const pipNames = { W: 'Vit', U: 'Blå', B: 'Svart', R: 'Röd', G: 'Grön', C: 'Färglös' };
  const pipMax = Math.max(1, ...Object.values(pips));
  const hbars = (obj, names = {}) => `<div class="hbars">${Object.entries(obj).map(([k, v]) => `<span>${names[k] || TYPE_SV[k] || k}</span><div class="track"><div class="fill" style="width:${(v / Math.max(1, ...Object.values(obj))) * 100}%"></div></div><span class="n">${v}</span>`).join('')}</div>`;
  tab.innerHTML = `
    <div class="stats">
      <div class="stat"><b>${total}</b><span>kort i leken</span></div>
      <div class="stat"><b>${lands}</b><span>länder</span></div>
      <div class="stat"><b>${cmcN ? (cmcSum / cmcN).toFixed(2) : '–'}</b><span>snitt-manavärde</span></div>
      <div class="stat"><b>${eur(value)}</b><span>ungefärligt värde</span></div>
      <div class="stat"><b>${eur(missVal)}</b><span>för det du saknar</span></div>
    </div>
    <div class="grid cols-2" style="margin-top:1rem">
      <div class="card"><h2>Manakurva <span class="muted small">(icke-länder)</span></h2>${barChart(curve, ['0', '1', '2', '3', '4', '5', '6', '7+'], (l, v) => `${v} kort med manavärde ${l}`)}</div>
      <div class="card"><h2>Färgsymboler</h2>${Object.values(pips).some(Boolean) ? `<div class="hbars">${Object.entries(pips).filter(([, v]) => v).map(([k, v]) => `<span><span class="sym ${k}">${k}</span> ${pipNames[k]}</span><div class="track"><div class="fill" style="width:${(v / pipMax) * 100}%"></div></div><span class="n">${v}</span>`).join('')}</div>` : '<p class="muted">Inga färgade kort än.</p>'}</div>
      <div class="card"><h2>Korttyper</h2>${hbars(types)}</div>
      <div class="card"><h2>Roller <span class="muted small">(gissning från korttexten)</span></h2>${hbars(roleCount)}
        ${deck.format === 'commander' ? '<p class="muted small">Tumregel för Commander: ca 36–38 länder, 10 ramp, 10 kortdragning, 8–10 removal och 2–3 massborttagningar.</p>' : ''}</div>
    </div>
    <p class="muted small">Värdet bygger på Scryfalls Cardmarket-trendpris i euro och ger en fingervisning. Riktiga priser i kronor finns under Köpa.</p>`;
  hookTips(tab);
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
  tab.innerHTML = miss.length ? `
    <div class="grid cols-2">
      <div class="card">
        <div class="row"><h2 style="margin:0">Det här saknar du (${miss.reduce((a, m) => a + m.missing, 0)} kort)</h2><span class="spacer"></span>
          <button class="btn primary" id="runAlara">${checked ? 'Kolla Alara igen' : 'Kolla lagret hos Alara'}</button></div>
        <div class="progress" id="prog" hidden style="margin:.6rem 0"><div style="width:0"></div></div>
        <div class="table-scroll"><table>
          <thead><tr><th>Kort</th><th class="num">Antal</th><th>Alara Games</th><th>Andra butiker</th><th></th></tr></thead>
          <tbody>${miss.map(m => {
            const r = S.alara[m.name], o = pickOffer(r), info = S.cards[m.name];
            const cell = !r ? '<span class="muted small">ej kollat</span>'
              : o ? `<div class="offer"><a href="${esc(o.url)}" target="_blank" rel="noopener"><span class="price">${kr(o.price)}</span></a> <span class="muted">${esc(o.condition)}</span>
                  ${r.offers.length > 1 ? `<details class="small"><summary class="muted">${r.offers.length - 1} till</summary>${r.offers.slice(1).map(x => `<div><a href="${esc(x.url)}" target="_blank" rel="noopener">${kr(x.price)}</a> ${esc(x.condition)} – <span class="muted">${esc(x.title)}</span></div>`).join('')}</details>` : ''}</div>`
              : '<span class="pill warn">ej i lager</span>';
            return `<tr data-name="${esc(m.name)}"><td><span data-img="${esc(info?.image || '')}">${esc(m.name)}</span><div class="muted small">ca ${eur(info?.eur)}</div></td>
              <td class="num">${m.missing}</td><td>${cell}</td><td><div class="links">${buyLinks(m.name).replace(/<a href="https:\/\/www\.alaragames[^>]*>Alara<\/a>/, '')}</div></td>
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
      </div>
    </div>` : '<div class="card empty"><b>Du har alla kort i den här leken!</b><br>Inget att köpa.</div>';
  if (!miss.length) return;
  $('#copyWants').onclick = () => navigator.clipboard.writeText($('#wants').value).then(() => toast('Kopierat'));
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
      <p class="muted small">Fungerar med export från Moxfield, Archidekt, MTG Arena och vanliga listor. Rubriker som Commander, Deck, Sideboard och Maybe styr vart korten hamnar.</p></div>
    <div class="card"><h2>Exportera</h2><textarea readonly id="exp">${esc(exportText(deck))}</textarea>
      <div class="row"><button class="btn small" id="copyExp">Kopiera</button></div>
      <h3>Anteckningar</h3><textarea id="notes" style="min-height:100px;font-family:inherit">${esc(deck.notes || '')}</textarea></div></div>`;
  $('#copyExp').onclick = () => navigator.clipboard.writeText($('#exp').value).then(() => toast('Kopierat'));
  $('#notes').onchange = e => { deck.notes = e.target.value; saveDeckSoon(deck); };
  $('#impGo').onclick = async () => {
    const list = parseList($('#imp').value, deck.format);
    if (!list.length) return toast('Hittade inga kort i texten');
    $('#impGo').disabled = true; $('#impGo').textContent = 'Hämtar kort…';
    if ($('#replace').checked) deck.cards = [];
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
  const value = names.reduce((a, n) => a + (S.cards[n]?.eur || 0) * S.collection[n], 0);
  const used = {};
  for (const d of S.decks) for (const c of d.cards) if (c.board !== 'maybe') (used[c.name] = used[c.name] || new Set()).add(d.name);
  $('#app').innerHTML = `<div id="col">
    <div class="row"><h1>Min samling</h1><span class="spacer"></span><span class="muted">${names.length} olika · ${total} kort · ca ${eur(value)}</span></div>
    <div class="grid cols-2" style="margin-top:1rem">
      <div class="card">
        <div class="row" style="margin-bottom:.6rem"><div class="add-bar" id="colAdd"></div><input type="search" id="colFilter" placeholder="Filtrera…" style="width:160px"></div>
        ${names.length ? `<div class="table-scroll"><table><thead><tr><th>Kort</th><th>Typ</th><th>I lekar</th><th class="num">Antal</th></tr></thead><tbody>
          ${names.map(n => `<tr data-name="${esc(n)}"><td><span data-img="${esc(S.cards[n]?.image || '')}" data-open style="cursor:pointer">${esc(n)}</span></td>
            <td class="muted small">${esc((S.cards[n]?.type_line || '').split(' — ')[0])}</td>
            <td class="small muted">${used[n] ? esc([...used[n]].join(', ')) : ''}</td>
            <td class="num"><input type="number" min="0" max="999" value="${S.collection[n]}" style="width:4.5rem" data-qty></td></tr>`).join('')}
          </tbody></table></div>` : '<div class="empty">Samlingen är tom. Bocka i kort i dina lekar, sök ovan, eller klistra in en lista till höger.</div>'}
      </div>
      <div class="card" style="align-self:start"><h2>Lägg till många</h2>
        <textarea id="colImp" placeholder="4 Lightning Bolt&#10;1 Sol Ring" style="min-height:160px"></textarea>
        <div class="row"><span class="spacer"></span><button class="btn primary" id="colImpGo">Lägg till i samlingen</button></div>
        <p class="muted small">Antalen läggs ovanpå det du redan har.</p></div>
    </div></div>`;
  addCardUI($('#colAdd'), async name => { await ensureCards([name]).catch(() => {}); await setOwned(name, (S.collection[name] || 0) + 1); toast(`+1 ${name}`); render(); }, 'Lägg till kort i samlingen…');
  $('#colFilter').oninput = e => { const q = e.target.value.toLowerCase(); $$('tbody tr').forEach(tr => tr.hidden = !tr.dataset.name.toLowerCase().includes(q)); };
  $('#col').addEventListener('change', async e => {
    if (!e.target.matches('[data-qty]')) return;
    await setOwned(e.target.closest('tr').dataset.name, +e.target.value);
    if (!+e.target.value) render();
  });
  $('#col').addEventListener('click', e => { const o = e.target.closest('[data-open]'); if (o) cardModal(o.closest('tr').dataset.name); });
  $('#colImpGo').onclick = async () => {
    const list = parseList($('#colImp').value, 'commander');
    if (!list.length) return;
    await ensureCards(list.map(c => c.name)).catch(() => {});
    const body = {};
    for (const c of list) {
      const hit = S.cards[c.name] || Object.values(S.cards).find(x => x.name.toLowerCase() === c.name.toLowerCase());
      const n = hit ? hit.name : c.name;
      body[n] = (body[n] ?? (S.collection[n] || 0)) + c.qty;
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
    <h3>Svenska Magic-länk</h3>
    <p class="small muted">Svenska Magic blockerar automatiska anrop, så appen öppnar sajten och kopierar kortnamnet åt dig. Om du söker där och kopierar adressen, och ersätter kortnamnet med <code>{q}</code>, går länken direkt till rätt sökning.</p>
    <input type="url" id="smUrl" style="width:100%" value="${esc(S.settings.svenskaMagicUrl || '')}">
    <p class="row"><span class="spacer"></span><button class="btn primary" id="saveSet">Spara</button></p>
    <h3>Om priser</h3>
    <p class="small muted">Alara-priser hämtas från butikens öppna sidor, cachas i 6 timmar och visar bara varianter som finns i lager. Cardmarket har inget öppet API för privatpersoner, därför används en önskelista plus deras egen Shopping Wizard.</p>
  </div>`;
  $('#saveSet').onclick = async () => { S.settings = await api('/api/settings', { method: 'PUT', body: { svenskaMagicUrl: $('#smUrl').value.trim() } }); toast('Sparat'); };
}

// ---------- router ----------
function render() {
  const h = location.hash.slice(1) || '/';
  const scroll = scrollY;
  let m;
  if ((m = h.match(/^\/lek\/([\w-]+)/))) { if (render.deck !== m[1]) { render.deck = m[1]; S.tab = 'lista'; } viewDeck(m[1]); }
  else if (h.startsWith('/samling')) viewCollection();
  else if (h.startsWith('/installningar')) viewSettings();
  else viewDecks();
  if (render.last === h) scrollTo(0, scroll); else scrollTo(0, 0);
  render.last = h;
}
addEventListener('hashchange', () => { $('#preview').hidden = true; render(); });

(async () => {
  if (window.LV_READY) await window.LV_READY; // väntar på inloggning i molnläge
  const st = await api('/api/state');
  Object.assign(S, st);
  const names = new Set([...S.decks.flatMap(d => d.cards.map(c => c.name)), ...Object.keys(S.collection)]);
  render();
  if (names.size) { await ensureCards([...names]).catch(() => {}); render(); }
})();
