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
        <span class="pill ${miss ? 'warn' : 'good'}">${miss ? `saknar ${miss}` : 'komplett'}</span>${rec.n ? `<span class="pill" title="Vinster i spelloggen">${rec.win}/${rec.n} vinster</span>` : ''}</div>
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
  const tabs = [['lista', 'Lista'], ['statistik', 'Statistik'], ['provhand', 'Provhand'], ['kop', 'Köpa'], ['sok', 'Hitta kort'],
    ...(deck.format === 'commander' ? [['forslag', 'Förslag']] : []), ['versioner', 'Versioner'], ['text', 'Import/Export']];
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
  ({ lista: tabList, statistik: tabStats, provhand: tabHand, kop: tabBuy, sok: tabSearch, forslag: tabSuggest, versioner: tabVersions, text: tabText })[S.tab](deck, tab);
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
  for (const c of deck.cards) {
    const k = c.board === 'main' ? mainType(S.cards[c.name]) : c.board === 'commander' ? 'Commander' : c.board;
    (groups[k] = groups[k] || []).push(c);
  }
  const order = ['Commander', ...TYPE_ORDER, 'Other', 'side', 'maybe'];
  const visual = S.view === 'bilder';
  const sections = order.filter(k => groups[k]).map(k => {
    const list = groups[k].sort((a, b) => (S.cards[a.name]?.cmc ?? 99) - (S.cards[b.name]?.cmc ?? 99) || a.name.localeCompare(b.name));
    return `<section><div class="section-head"><h3>${TYPE_SV[k]}</h3><span class="muted small">${list.reduce((a, c) => a + c.qty, 0)}</span></div>
      ${visual ? `<ul class="vgrid">${list.map(c => cardTile(c)).join('')}</ul>` : `<ul class="clist">${list.map(c => cardRow(deck, c)).join('')}</ul>`}</section>`;
  }).join('');
  const issues = deckIssues(deck);
  const miss = missingCards(deck);
  tab.innerHTML = `
    <div class="grid cols-2">
      <div class="card">
        <div class="row" style="margin-bottom:.6rem"><div class="add-bar" id="addBar"></div>
          <select id="addBoard"><option value="main">Huvudlek</option>${deck.format === 'commander' ? '<option value="commander">Befälhavare</option>' : '<option value="side">Sidolek</option>'}<option value="maybe">Kanske</option></select>
          <div class="seg" role="group" aria-label="Visning"><button data-view="lista" class="${visual ? '' : 'on'}">☰ Lista</button><button data-view="bilder" class="${visual ? 'on' : ''}">▦ Bilder</button></div></div>
        ${deck.cards.length ? `<div class="${visual ? '' : 'cols-cards'}">${sections}</div>` : '<div class="empty">Leken är tom. Sök ett kort ovan, eller klistra in en lista under Import/Export.</div>'}
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
    const vb = e.target.closest('[data-view]');
    if (vb) { S.view = vb.dataset.view; try { localStorage.setItem('lv-view', S.view); } catch {} return render(); }
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
      ${(r => r.n ? `<div class="stat"><b>${r.pct} %</b><span>vinster (${r.win} av ${r.n} matcher)</span></div>` : '')(deckRecord(S.games.filter(g => g.deck_id === deck.id)))}
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
      </div>
    </div>` : '<div class="card empty"><b>Du har alla kort i den här leken!</b><br>Inget att köpa.</div>';
  if (!miss.length) return;
  $('#copyWants').onclick = () => navigator.clipboard.writeText($('#wants').value).then(() => toast('Kopierat'));
  tab.addEventListener('change', e => {
    if (e.target.id === 'selAll') { if (e.target.checked) miss.forEach(m => sel.add(m.name)); else sel.clear(); return render(); }
    if (e.target.matches('[data-sel]')) { const n = e.target.closest('tr').dataset.name; if (e.target.checked) sel.add(n); else sel.delete(n); render(); }
  });
  $('#selAlara').onclick = () => { miss.forEach(m => pickOffer(S.alara[m.name]) && sel.add(m.name)); render(); };
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
  const value = names.reduce((a, n) => a + (S.cards[n]?.eur || 0) * S.collection[n], 0);
  const used = {};
  for (const d of S.decks) for (const c of d.cards) if (c.board !== 'maybe') (used[c.name] = used[c.name] || new Set()).add(d.name);
  const show = viewCollection.show || 'alla';
  const unused = names.filter(n => !used[n]).length;
  const shown = show === 'oanvanda' ? names.filter(n => !used[n]) : show === 'byte' ? names.filter(n => S.trade[n]) : names;
  $('#app').innerHTML = `<div id="col">
    <div class="row"><h1>Min samling</h1><span class="spacer"></span><span class="muted">${names.length} olika · ${total} kort · ca ${eur(value)}</span></div>
    <div class="grid cols-2" style="margin-top:1rem">
      <div class="card">
        <div class="row" style="margin-bottom:.6rem"><div class="add-bar" id="colAdd"></div><input type="search" id="colFilter" placeholder="Filtrera…" style="width:160px"></div>
        <div class="row small" style="margin-bottom:.6rem">
          <div class="seg" id="colShow"><button data-show="alla" class="${show === 'alla' ? 'on' : ''}">Alla</button><button data-show="oanvanda" class="${show === 'oanvanda' ? 'on' : ''}">Används inte i någon lek (${unused})</button>${S.cloud ? `<button data-show="byte" class="${show === 'byte' ? 'on' : ''}">Till byte (${Object.keys(S.trade).length})</button>` : ''}</div></div>
        ${shown.length ? `<div class="table-scroll"><table><thead><tr><th>Kort</th><th>Typ</th><th>I lekar</th><th class="num">Antal</th>${S.cloud ? '<th class="num" title="Hur många du kan tänka dig att byta bort. Syns för andra i bytesbörsen.">Till byte</th>' : ''}</tr></thead><tbody>
          ${shown.map(n => `<tr data-name="${esc(n)}"><td><span data-img="${esc(S.cards[n]?.image || '')}" data-open style="cursor:pointer">${esc(n)}</span></td>
            <td class="muted small">${esc((S.cards[n]?.type_line || '').split(' — ')[0])}</td>
            <td class="small muted">${used[n] ? esc([...used[n]].join(', ')) : ''}</td>
            <td class="num"><input type="number" min="0" max="999" value="${S.collection[n]}" style="width:4.5rem" data-qty></td>
            ${S.cloud ? `<td class="num"><input type="number" min="0" max="${S.collection[n]}" value="${S.trade[n] || 0}" style="width:4.5rem" data-trade></td>` : ''}</tr>`).join('')}
          </tbody></table></div>` : `<div class="empty">${names.length ? 'Inga kort med det filtret.' : 'Samlingen är tom. Bocka i kort i dina lekar, sök ovan, eller klistra in en lista till höger.'}</div>`}
      </div>
      <div class="card" style="align-self:start"><h2>Lägg till många</h2>
        <textarea id="colImp" placeholder="4 Lightning Bolt&#10;1 Sol Ring" style="min-height:160px"></textarea>
        <div class="row"><span class="spacer"></span><button class="btn primary" id="colImpGo">Lägg till i samlingen</button></div>
        <p class="muted small">Antalen läggs ovanpå det du redan har.</p></div>
    </div></div>`;
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
    <h3>Om priser</h3>
    <p class="small muted">Alara-priser hämtas från butikens öppna sidor, cachas i 6 timmar och visar bara varianter som finns i lager. Cardmarket har inget öppet API för privatpersoner, därför används en önskelista plus deras egen Shopping Wizard.</p>
  </div>`;
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
  const tabs = [['lekar', 'Publika lekar'], ['byte', 'Bytesbörs']];
  sub = sub === 'byte' ? 'byte' : 'lekar';
  $('#app').innerHTML = `<div class="row"><h1>Utforska</h1><span class="spacer"></span><button class="btn small" id="reload">↻ Uppdatera</button></div>
    <div class="tabs">${tabs.map(([k, l]) => `<a class="${k === sub ? 'on' : ''}" href="#/utforska/${k}">${l}</a>`).join('')}</div><div id="ex"></div>`;
  $('#reload').onclick = async () => { await Promise.all([loadPublic(true), loadTrades(true)]); render(); };
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
  // bytesbörs
  if (!S.trades) { ex.innerHTML = '<p class="muted">Hämtar…</p>'; loadTrades().then(render); return; }
  const need = {};
  for (const d of S.decks) for (const m of missingCards(d)) (need[m.name.toLowerCase()] = need[m.name.toLowerCase()] || new Set()).add(d.name);
  const opt = viewExplore.opt || (viewExplore.opt = { onlyNeed: true, q: '' });
  const rows = S.trades.filter(t => (!opt.onlyNeed || need[t.name.toLowerCase()]) && (!opt.q || t.name.toLowerCase().includes(opt.q.toLowerCase())))
    .sort((a, b) => a.name.localeCompare(b.name) || a.ownerName.localeCompare(b.ownerName));
  const mine = Object.keys(S.trade).length;
  ex.innerHTML = `<div class="card">
    <div class="row"><label class="small"><input type="checkbox" id="onlyNeed" ${opt.onlyNeed ? 'checked' : ''}> Bara kort som saknas i mina lekar</label>
      <span class="spacer"></span><input type="search" id="tq" placeholder="Sök kort…" value="${esc(opt.q)}" style="width:200px"></div>
    ${rows.length ? `<div class="table-scroll"><table><thead><tr><th>Kort</th><th>Har till byte</th><th class="num">Antal</th><th>Behövs i</th></tr></thead><tbody>
      ${rows.map(t => `<tr><td><span data-img="${esc(S.cards[t.name]?.image || scryImg(t.name))}">${esc(t.name)}</span></td><td>${esc(t.ownerName)}</td><td class="num">${t.qty}</td>
        <td class="small muted">${need[t.name.toLowerCase()] ? esc([...need[t.name.toLowerCase()]].join(', ')) : ''}</td></tr>`).join('')}</tbody></table></div>`
      : `<p class="muted">${S.trades.length ? 'Inga träffar med de filtren.' : 'Ingen har markerat kort till byte än.'}</p>`}
    <p class="muted small">Du har ${mine} olika kort markerade till byte. Markera dina under <a href="#/samling">Samling</a>, och sätt ditt namn under <a href="#/installningar">Inställningar</a> så att andra ser vem du är.</p></div>`;
  $('#onlyNeed').onchange = e => { opt.onlyNeed = e.target.checked; render(); };
  $('#tq').oninput = e => { opt.q = e.target.value; clearTimeout(viewExplore.t); viewExplore.t = setTimeout(() => { render(); const i = $('#tq'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 250); };
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
  $('#app').innerHTML = `<div id="gm"><div class="row"><h1>Matcher</h1><span class="spacer"></span><span class="muted">${total.n} matcher · ${total.pct} % vinster</span></div>
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

// ---------- router ----------
function render() {
  const h = location.hash.slice(1) || '/';
  const scroll = scrollY;
  let m;
  if ((m = h.match(/^\/lek\/([\w-]+)/))) { if (render.deck !== m[1]) { render.deck = m[1]; S.tab = 'lista'; tabBuy.sel = null; } viewDeck(m[1]); }
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
  if (window.LV_READY) await window.LV_READY; // väntar på inloggning i molnläge
  const st = await api('/api/state');
  Object.assign(S, st);
  if (!S.cloud) $$('[data-nav=utforska]').forEach(a => a.remove());
  const names = new Set([...S.decks.flatMap(d => d.cards.map(c => c.name)), ...Object.keys(S.collection)]);
  render();
  if (names.size) { await ensureCards([...names]).catch(() => {}); render(); }
})();
