// Lekverkstan – Draft: kortbetyg (17lands), plock, 40-kortslek, delat draftbord med timer och Swiss-turnering.
// Allt sparas i telefonen (localStorage). Bordet delas med Supabase Realtime (samma som livräknaren), ingen databas.
'use strict';

const DR_KEY = 'lv-draft';
const DR = { st: null, sets: null, data: {}, loading: {}, ch: null, code: '', peers: new Map(), off: 0, tick: null, lastBeep: -1 };
const COLORS = ['W', 'U', 'B', 'R', 'G'];
const COLOR_SV = { W: 'Vit', U: 'Blå', B: 'Svart', R: 'Röd', G: 'Grön' };
const BASIC_OF = { W: 'Plains', U: 'Island', B: 'Swamp', R: 'Mountain', G: 'Forest' };
const PAIR_SV = c => c.split('').map(x => COLOR_SV[x]).join('/');
const pip = c => `<span class="dpip dp-${c}">${c}</span>`;
const pips = cs => cs ? cs.split('').map(pip).join('') : '<span class="dpip dp-C">◇</span>';

function drState() {
  if (!DR.st) {
    try { DR.st = JSON.parse(localStorage.getItem(DR_KEY)); } catch {}
    DR.st = Object.assign({ set: '', fmt: 'PremierDraft', size: 14, pack: [], picks: [], main: {}, basics: null, tour: null, table: null }, DR.st || {});
  }
  return DR.st;
}
function drSave() { try { localStorage.setItem(DR_KEY, JSON.stringify(DR.st)); } catch {} }

// ---------- data: setlista (Scryfall), kort (Scryfall) och betyg (17lands) ----------
async function drSets() {
  if (DR.sets) return DR.sets;
  try { const c = JSON.parse(localStorage.getItem('lv-draft-sets')); if (c && Date.now() - c.at < 864e5) return (DR.sets = c.sets); } catch {}
  const r = await fetch('https://api.scryfall.com/sets'); if (!r.ok) throw new Error('Scryfall svarar inte');
  const soon = new Date(Date.now() + 14 * 864e5).toISOString().slice(0, 10);
  DR.sets = (await r.json()).data.filter(s => ['expansion', 'core', 'draft_innovation', 'masters'].includes(s.set_type) && !s.digital && s.released_at <= soon && s.card_count > 60)
    .sort((a, b) => b.released_at.localeCompare(a.released_at)).slice(0, 40).map(s => ({ code: s.code, name: s.name, at: s.released_at }));
  try { localStorage.setItem('lv-draft-sets', JSON.stringify({ at: Date.now(), sets: DR.sets })); } catch {}
  return DR.sets;
}
const dKey = (code, fmt) => `lv-draft-d-${code}-${fmt}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function scryAll(q) {
  let url = 'https://api.scryfall.com/cards/search?unique=cards&order=set&q=' + encodeURIComponent(q), out = [];
  while (url) {
    const r = await fetch(url);
    if (r.status === 404) return out;
    if (!r.ok) throw new Error('Scryfall ' + r.status);
    const j = await r.json(); out.push(...j.data); url = j.has_more ? j.next_page : null;
    if (url) await sleep(120);
  }
  return out;
}
function scryCard(c) {
  const f = c.card_faces?.[0] || c;
  const cost = c.mana_cost ?? f.mana_cost ?? '';
  return { cmc: c.cmc ?? 0, cost: c.card_faces ? (c.card_faces[0].mana_cost || '') : cost, type: c.type_line || '', colors: (c.colors || f.colors || []).join(''), ci: (c.color_identity || []).join(''), rar: c.rarity, img: c.image_uris?.normal || f.image_uris?.normal || '' };
}
// 17lands GIH WR -> z-värde inom setet -> bokstavsbetyg (samma idé som 17lands egna betyg)
const GRADES = [[2, 'A+'], [1.5, 'A'], [1.17, 'A-'], [.83, 'B+'], [.5, 'B'], [.17, 'B-'], [-.17, 'C+'], [-.5, 'C'], [-.83, 'C-'], [-1.17, 'D+'], [-1.5, 'D'], [-1.83, 'D-']];
const grade = z => z == null ? '?' : (GRADES.find(([g]) => z >= g) || [0, 'F'])[1];
const gradeCls = g => g[0] === 'A' ? 'ga' : g[0] === 'B' ? 'gb' : g[0] === 'C' ? 'gc' : g === '?' ? 'gq' : 'gd';
function score(rows) {
  const ok = rows.filter(c => c.gihN >= 200 && c.gih != null);
  const st = xs => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; return [m, Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length) || 1]; };
  const [m, sd] = ok.length >= 20 ? st(ok.map(c => c.gih)) : [0, 1];
  const al = rows.filter(c => c.alsa != null), [ma, sa] = al.length >= 20 ? st(al.map(c => c.alsa)) : [0, 1];
  for (const c of rows) {
    if (ok.length >= 20 && c.gihN >= 200 && c.gih != null) { c.z = (c.gih - m) / sd; c.by = 'gih'; }
    else if (al.length >= 20 && c.alsa != null) { c.z = -(c.alsa - ma) / sa * .8; c.by = 'alsa'; } // för få matcher: hur tidigt kortet plockas
    else c.z = null;
    c.g = grade(c.z);
  }
  return { mean: ok.length >= 20 ? m : null, games: rows.reduce((a, c) => Math.max(a, c.gihN || 0), 0) };
}
async function drLoad(code, fmt, force) {
  const k = dKey(code, fmt);
  if (!force && DR.data[k]) return DR.data[k];
  if (!force) { try { const c = JSON.parse(localStorage.getItem(k)); if (c?.cards) { DR.data[k] = c; if (Date.now() - c.at > 12 * 36e5) drLoad(code, fmt, true).then(() => location.hash.startsWith('#/draft') && render()).catch(() => {}); return c; } } catch {} }
  if (DR.loading[k]) return DR.loading[k];
  return (DR.loading[k] = (async () => {
    let lands = [], usedFmt = fmt;
    try {
      const get = f => fetch(`https://www.17lands.com/card_ratings/data?expansion=${code.toUpperCase()}&format=${f}&start_date=2020-01-01`).then(r => r.ok ? r.json() : []);
      lands = await get(fmt);
      if (!lands.some(x => x.game_count) && fmt === 'PremierDraft') { const q = await get('QuickDraft'); if (q.some(x => x.game_count)) { lands = q; usedFmt = 'QuickDraft'; } }
    } catch { lands = []; }
    let sc = await scryAll(`e:${code} is:booster`).catch(() => []);
    if (!sc.length) sc = await scryAll(`e:${code}`).catch(() => []);
    const cards = {};
    for (const c of sc) cards[c.name] = { name: c.name, ...scryCard(c) };
    // kort i 17lands som inte finns i setets egen lista (bonusark, specialkort)
    const miss = lands.map(x => x.name).filter(n => n && !cards[n]);
    for (let i = 0; i < miss.length; i += 75) {
      try {
        const r = await fetch('https://api.scryfall.com/cards/collection', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifiers: miss.slice(i, i + 75).map(name => ({ name: name.split(' // ')[0] })) }) });
        if (r.ok) for (const c of (await r.json()).data) cards[lands.find(x => x.name === c.name || x.name.split(' // ')[0] === c.name.split(' // ')[0])?.name || c.name] = { name: c.name, ...scryCard(c) };
        await sleep(120);
      } catch {}
    }
    for (const x of lands) {
      const c = cards[x.name] = cards[x.name] || { name: x.name, cmc: 0, cost: '', type: (x.types || []).join(' '), colors: x.color || '', rar: x.rarity, img: x.url || '' };
      Object.assign(c, { gih: x.ever_drawn_win_rate, gihN: x.ever_drawn_game_count || 0, alsa: x.avg_seen, ata: x.avg_pick, colors: c.colors || x.color || '' });
      if (!c.img) c.img = x.url || '';
    }
    const rows = Object.values(cards);
    if (!rows.length) throw new Error('Hittade inga kort för ' + code.toUpperCase());
    const info = score(rows);
    const d = { at: Date.now(), code, fmt: usedFmt, cards, rated: lands.some(x => x.game_count), ...info };
    DR.data[k] = d;
    try { localStorage.setItem(k, JSON.stringify(d)); } catch {}
    return d;
  })().finally(() => delete DR.loading[k]));
}
const drData = () => { const st = drState(); return DR.data[dKey(st.set, st.fmt)]; };
const drCard = name => drData()?.cards[name] || { name, colors: '', cmc: 0, cost: '', type: '', z: null, g: '?' };
const norm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// ---------- färger och passform ----------
function myColors(picks = drState().picks) {
  const w = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  for (const n of picks) { const c = drCard(n), cs = c.colors.split('').filter(x => w[x] != null); for (const x of cs) w[x] += Math.max(0, (c.z ?? 0) + 1) / cs.length; }
  const order = COLORS.slice().sort((a, b) => w[b] - w[a]);
  return { w, top: order.slice(0, 2).filter(x => w[x] > 0), order };
}
function fit(c, top, n) {
  if (n < 6 || top.length < 2) return 0;              // tidigt i draften: ta bästa kortet
  const cs = c.colors.split('').filter(Boolean);
  if (!cs.length) return .15;
  const inn = cs.filter(x => top.includes(x)).length;
  return inn === cs.length ? .45 : inn ? -.35 : -.8;
}
const packScore = (c, top, n) => (c.z ?? -1) + fit(c, top, n);

// ---------- vy ----------
function viewDraft(tab) {
  setNav('draft');
  const st = drState();
  tab = ['plock', 'lek', 'bord', 'turnering'].includes(tab) ? tab : 'plocka';
  const tabs = [['plocka', 'Plocka'], ['plock', `Mina plock (${st.picks.length})`], ['lek', 'Lek 40'], ['bord', 'Draftbord' + (DR.code ? ' ●' : '')], ['turnering', 'Turnering']];
  $('#app').innerHTML = `<div class="row"><h1>Draft</h1><span class="spacer"></span>
      <select id="dSet" style="max-width:15rem"><option value="">Välj set…</option></select>
      <select id="dFmt" title="Vilken sorts 17lands-draft betygen kommer från"><option value="PremierDraft">Premier</option><option value="QuickDraft">Quick</option><option value="TradDraft">Trad (Bo3)</option></select></div>
    <div id="dInfo" class="muted small"></div>
    <div class="tabs">${tabs.map(([k, l]) => `<a class="${k === tab ? 'on' : ''}" href="#/draft/${k}">${l}</a>`).join('')}</div><div id="dx"></div>`;
  $('#dFmt').value = st.fmt;
  drSets().then(sets => {
    const sel = $('#dSet'); if (!sel) return;
    if (!st.set && sets[0]) { st.set = sets.find(s => s.at <= new Date().toISOString().slice(0, 10))?.code || sets[0].code; drSave(); }
    sel.innerHTML += sets.map(s => `<option value="${s.code}">${esc(s.name)} (${s.code.toUpperCase()})</option>`).join('');
    sel.value = st.set;
    if (!drData()) drLoadUI();
  }).catch(e => { $('#dInfo').textContent = 'Kunde inte hämta setlistan: ' + e.message; });
  $('#dSet').onchange = e => { st.set = e.target.value; drSave(); drLoadUI(); };
  $('#dFmt').onchange = e => { st.fmt = e.target.value; drSave(); drLoadUI(); };
  drInfo();
  const fn = { plocka: dPick, plock: dPicks, lek: dDeck, bord: dTable, turnering: dTour }[tab];
  fn($('#dx'));
  if (tab === 'bord' && DR.code) wakeLock(true);
}
function drInfo() {
  const d = drData(), el = $('#dInfo'); if (!el) return;
  const st = drState();
  if (!st.set) { el.textContent = ''; return; }
  if (!d) { el.textContent = DR.loading[dKey(st.set, st.fmt)] ? `Hämtar kort och betyg för ${st.set.toUpperCase()}…` : ''; return; }
  const age = Math.round((Date.now() - d.at) / 36e5);
  el.innerHTML = d.rated
    ? `Betyg från 17lands (${d.fmt === 'QuickDraft' ? 'Quick Draft' : d.fmt === 'TradDraft' ? 'Trad' : 'Premier Draft'}) · vinstprocent när kortet dragits (GIH WR) jämfört med setets andra kort · uppdaterat ${age < 1 ? 'nyss' : age + ' h sedan'} · <a href="#" id="dRe">hämta om</a>`
    : `17lands har inga matcher för ${st.set.toUpperCase()} än – betygen visas som ? (kort och färger finns ändå) · <a href="#" id="dRe">hämta om</a>`;
  $('#dRe').onclick = e => { e.preventDefault(); drLoadUI(true); };
}
function drLoadUI(force) {
  const st = drState(); if (!st.set) return;
  drInfo();
  drLoad(st.set, st.fmt, force).then(() => location.hash.startsWith('#/draft') && render()).catch(e => { const el = $('#dInfo'); if (el) el.textContent = 'Kunde inte hämta: ' + e.message; });
  setTimeout(drInfo, 50);
}
const gPill = c => `<span class="dgrade ${gradeCls(c.g)}" title="${c.by === 'alsa' ? 'För få matcher – betyget bygger på hur tidigt kortet plockas' : c.gih != null ? 'GIH WR ' + (c.gih * 100).toFixed(1) + ' %' : 'Inget betyg än'}">${c.g}${c.by === 'alsa' ? '*' : ''}</span>`;
const stat = c => [c.gih != null && c.gihN >= 200 ? `GIH ${(c.gih * 100).toFixed(1)} %` : '', c.alsa != null ? `ALSA ${c.alsa.toFixed(1)}` : ''].filter(Boolean).join(' · ');
function dCardModal(name) {
  const c = drCard(name);
  openModal(`<div class="row"><h2 style="margin:0">${esc(c.name)}</h2><span class="spacer"></span><button class="icon-btn" data-close>✕</button></div>
    <div class="card-detail" style="margin-top:.8rem">${c.img ? `<img src="${esc(c.img)}" alt="">` : '<div></div>'}<div>
      <p>${gPill(c)} ${pips(c.colors)} <span class="muted small">${esc(c.type)}</span></p>
      <p class="small">${stat(c) || 'Ingen statistik än.'}</p>
      ${c.ata != null ? `<p class="small muted">Plockas i snitt som nummer ${c.ata.toFixed(1)} (ATA). ALSA = hur sent kortet i snitt senast syns i en booster; lågt = folk tar det tidigt.</p>` : ''}
    </div></div>`);
}

// ---- Plocka: lägg in korten du funderar på, få bästa plock ----
function dPick(el) {
  const st = drState(), d = drData();
  if (!d) { el.innerHTML = `<div class="card empty">${st.set ? 'Hämtar setet…' : 'Välj ett set uppe till höger.'}</div>`; return; }
  const { top } = myColors(), n = st.picks.length, size = st.size || 14;
  const packNo = Math.floor(n / size) + 1, pickNo = n % size + 1;
  const rows = st.pack.map(name => ({ c: drCard(name), s: packScore(drCard(name), top, n) })).sort((a, b) => b.s - a.s);
  const raw = rows.slice().sort((a, b) => (b.c.z ?? -9) - (a.c.z ?? -9))[0];
  el.innerHTML = `<div class="card">
      ${tb() && tb().phase !== 'lobby' && tb().phase !== 'done' ? `<a class="dmini" href="#/draft/bord"><span id="dTime">–</span><span>Bord ${esc(tb().code)} · booster ${tb().pack} · plock ${tb().pick} · skicka åt ${tb().pack === 2 ? 'höger →' : '← vänster'}</span></a>` : ''}
      <div class="row"><b>Booster ${Math.min(3, packNo)} · plock ${pickNo}</b><span class="muted small">${top.length === 2 && n >= 6 ? `Dina färger just nu: ${pips(top.join(''))} ${PAIR_SV(top.join(''))}` : n ? 'Tidigt – ta det starkaste kortet' : 'Första plocket'}</span></div>
      <div class="dsearch"><input type="search" id="dQ" placeholder="Skriv kortnamn i boostern…" autocomplete="off" enterkeyhint="done"><div id="dSug" class="dsug"></div></div>
      <p class="muted small" style="margin:.4rem 0 0">Lägg in korten du funderar på (behöver inte vara alla). Det bästa hamnar överst${n >= 6 ? ', med hänsyn till dina färger' : ''}.</p>
    </div>
    ${rows.length ? `<div class="dpack">${rows.map((r, i) => `<div class="card drow ${i === 0 ? 'best' : ''}">
        ${r.c.img ? `<img src="${esc(r.c.img)}" alt="" data-dc="${esc(r.c.name)}" loading="lazy">` : ''}
        <div class="dmeta"><div>${i === 0 ? '<span class="pill good">⭐ Bästa plock</span> ' : ''}${gPill(r.c)} <b>${esc(r.c.name)}</b></div>
          <div class="small muted">${pips(r.c.colors)} ${esc(r.c.type)}${stat(r.c) ? ' · ' + stat(r.c) : ''}</div>
          ${i === 0 && raw && raw.c.name !== r.c.name ? `<div class="small">Starkast rent: <b>${esc(raw.c.name)}</b> (${raw.c.g}) – men det passar inte dina färger lika bra</div>` : ''}
          ${fit(r.c, top, n) < 0 ? '<div class="small warn-t">Utanför dina färger</div>' : ''}</div>
        <div class="dact"><button class="btn primary small" data-take="${esc(r.c.name)}">Plocka</button><button class="btn small" data-rm="${esc(r.c.name)}" aria-label="Ta bort">✕</button></div></div>`).join('')}</div>
      <p class="row"><button class="btn small" id="dClr">Töm boostern</button></p>` : ''}`;
  const q = $('#dQ'), sug = $('#dSug');
  const show = () => {
    const v = norm(q.value.trim());
    if (v.length < 2) { sug.innerHTML = ''; return; }
    const hit = Object.values(d.cards).filter(c => norm(c.name).includes(v) && !st.pack.includes(c.name))
      .sort((a, b) => (norm(a.name).startsWith(v) ? 0 : 1) - (norm(b.name).startsWith(v) ? 0 : 1) || a.name.localeCompare(b.name)).slice(0, 8);
    sug.innerHTML = hit.map(c => `<button data-add="${esc(c.name)}">${gPill(c)} ${esc(c.name)} ${pips(c.colors)}</button>`).join('') || '<div class="muted small" style="padding:.5rem">Inget kort med det namnet i setet</div>';
  };
  q.oninput = show;
  q.onkeydown = e => { if (e.key === 'Enter') { const b = $('[data-add]', sug); if (b) b.click(); } };
  sug.onclick = e => { const b = e.target.closest('[data-add]'); if (!b) return; st.pack.push(b.dataset.add); drSave(); render(); setTimeout(() => $('#dQ')?.focus(), 0); };
  el.onclick = e => {
    const t = e.target.closest('[data-take],[data-rm],[data-dc]'); if (!t) return;
    if (t.dataset.dc) return dCardModal(t.dataset.dc);
    if (t.dataset.rm) { st.pack = st.pack.filter(x => x !== t.dataset.rm); drSave(); return render(); }
    st.picks.push(t.dataset.take); st.pack = []; st.main = {}; drSave();
    if (tb()?.phase === 'pick' && tb().players.some(p => p.cid === CID) && !tb().ready.includes(CID)) tbReady(true);
    toast(`Plockat: ${t.dataset.take} (${st.picks.length})`); render(); setTimeout(() => $('#dQ')?.focus(), 0);
  };
  if ($('#dClr')) $('#dClr').onclick = () => { st.pack = []; drSave(); render(); };
  if (!rows.length) q.focus();
}

// ---- Mina plock ----
function dPicks(el) {
  const st = drState();
  if (!st.picks.length) { el.innerHTML = '<div class="card empty">Inga plock än. Plocka under <a href="#/draft/plocka">Plocka</a>.</div>'; return; }
  const { w, top, order } = myColors(), max = Math.max(...Object.values(w), 1), size = st.size || 14;
  const play = st.picks.filter(n => { const c = drCard(n), cs = c.colors.split('').filter(Boolean); return (c.z ?? -1) > -.5 && cs.every(x => top.includes(x)); }).length;
  el.innerHTML = `<div class="card"><h3 style="margin-top:0">Färger</h3>
      ${order.map(c => `<div class="dbar"><span>${pip(c)} ${COLOR_SV[c]}</span><div><i style="width:${Math.round(w[c] / max * 100)}%" class="db-${c}"></i></div></div>`).join('')}
      <p class="small">${top.length === 2 ? `Starkast just nu: <b>${PAIR_SV(top.join(''))}</b> – ${play} spelbara kort (betyg C eller bättre) i de färgerna. Ett bra mål är 22–23.` : 'För tidigt att säga.'}</p></div>
    <div class="card" style="margin-top:1rem"><div class="row"><h3 style="margin:0">Plock</h3><span class="spacer"></span><button class="btn small danger" id="dNew">Ny draft</button></div>
      <ol class="dpicks">${st.picks.map((n, i) => { const c = drCard(n); return `<li>${i % size === 0 ? `<div class="muted small">Booster ${Math.floor(i / size) + 1}</div>` : ''}<span class="row">${gPill(c)} <a href="#" data-dc="${esc(n)}">${esc(n)}</a> ${pips(c.colors)}<span class="spacer"></span><button class="icon-btn" data-del="${i}" aria-label="Ta bort">✕</button></span></li>`; }).join('')}</ol></div>`;
  el.onclick = e => {
    const t = e.target.closest('[data-dc],[data-del]'); if (!t) return;
    e.preventDefault();
    if (t.dataset.dc) return dCardModal(t.dataset.dc);
    st.picks.splice(+t.dataset.del, 1); st.main = {}; drSave(); render();
  };
  $('#dNew').onclick = () => { if (!confirm('Börja om med en ny draft? Plocken och leken töms.')) return; Object.assign(st, { pack: [], picks: [], main: {}, basics: null }); drSave(); location.hash = '#/draft/plocka'; };
}

// ---- Lek 40 ----
const poolCount = () => st0().picks.reduce((m, n) => (m[n] = (m[n] || 0) + 1, m), {});
const st0 = () => drState();
const isLand = c => /\bLand\b/.test(c.type);
const isCreature = c => /\bCreature\b/.test(c.type);
function pipCount(cards) {
  const p = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  for (const [n, q] of cards) {
    const c = drCard(n); if (isLand(c)) continue;
    const m = (c.cost || '').match(/\{[^}]+\}/g) || [];
    let any = false;
    for (const s of m) for (const x of COLORS) if (s.includes(x)) { p[x] += q; any = true; }
    if (!any) for (const x of c.colors.split('')) if (p[x] != null) p[x] += q;
  }
  return p;
}
function suggestBasics(main) {
  const nonb = Object.entries(main).filter(([n]) => isLand(drCard(n))).reduce((a, [, q]) => a + q, 0);
  const spells = Object.entries(main).filter(([n]) => !isLand(drCard(n))).reduce((a, [, q]) => a + q, 0);
  const want = Math.max(0, Math.min(18, 40 - spells) - nonb);
  const p = pipCount(Object.entries(main)), tot = COLORS.reduce((a, c) => a + p[c], 0);
  const b = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  if (!tot) return b;
  const used = COLORS.filter(c => p[c]);
  let left = want;
  for (const c of used) { b[c] = Math.max(used.length > 1 ? 3 : 0, Math.floor(want * p[c] / tot)); left -= b[c]; }
  while (left > 0) { const c = used.slice().sort((x, y) => p[y] / (b[y] + 1) - p[x] / (b[x] + 1))[0]; b[c]++; left--; }
  while (left < 0) { const c = used.slice().sort((x, y) => b[y] - b[x])[0]; b[c]--; left++; }
  return b;
}
function autoBuild() {
  const pool = poolCount(), names = Object.keys(pool);
  let best = null;
  for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) {
    const pair = [COLORS[i], COLORS[j]];
    const ok = names.filter(n => drCard(n).colors.split('').filter(Boolean).every(x => pair.includes(x)));
    const list = ok.flatMap(n => Array(pool[n]).fill(n)).filter(n => !isLand(drCard(n)) || drCard(n).colors).sort((a, b) => (drCard(b).z ?? -1) - (drCard(a).z ?? -1));
    const take = list.slice(0, 23), sc = take.reduce((a, n) => a + (drCard(n).z ?? -1) + 2, 0);
    if (!best || sc > best.sc) best = { pair, list, take, sc };
  }
  if (!best) return {};
  // för få kort i två färger: stänk in den starkaste tredje färgen
  let take = best.take.slice(), rest = best.list.slice(take.length);
  if (take.length < 22) {
    const used = new Set(take), off = names.filter(n => { const cs = drCard(n).colors.split('').filter(Boolean), o = cs.filter(x => !best.pair.includes(x)); return o.length === 1 && cs.length <= 2 && !isLand(drCard(n)); });
    const by = {}; for (const n of off) { const o = drCard(n).colors.split('').find(x => !best.pair.includes(x)); (by[o] = by[o] || []).push(...Array(pool[n]).fill(n)); }
    const third = Object.keys(by).sort((a, b) => by[b].reduce((s, n) => s + (drCard(n).z ?? -1) + 2, 0) - by[a].reduce((s, n) => s + (drCard(n).z ?? -1) + 2, 0))[0];
    if (third) for (const n of by[third].sort((a, b) => (drCard(b).z ?? -1) - (drCard(a).z ?? -1))) { if (take.length >= 22) break; if (!used.has(n) || take.filter(x => x === n).length < pool[n]) take.push(n); }
  }
  const cre = () => take.filter(n => isCreature(drCard(n))).length;
  while (cre() < 13) {
    const add = rest.find(n => isCreature(drCard(n))); if (!add) break;
    const out = take.slice().reverse().find(n => !isCreature(drCard(n)) && !isLand(drCard(n))); if (!out) break;
    take[take.lastIndexOf(out)] = add; rest.splice(rest.indexOf(add), 1); rest.push(out);
  }
  const main = {}; for (const n of take) main[n] = (main[n] || 0) + 1;
  return main;
}
function dDeck(el) {
  const st = drState();
  if (!st.picks.length) { el.innerHTML = '<div class="card empty">Leken byggs av dina plock. Plocka först.</div>'; return; }
  const pool = poolCount();
  for (const n of Object.keys(st.main)) { st.main[n] = Math.min(st.main[n], pool[n] || 0); if (!st.main[n]) delete st.main[n]; }
  const basics = st.basics || suggestBasics(st.main);
  const mainN = Object.values(st.main).reduce((a, b) => a + b, 0), basN = COLORS.reduce((a, c) => a + basics[c], 0), total = mainN + basN;
  const ents = Object.entries(st.main), curve = [0, 0, 0, 0, 0, 0, 0];
  let cre = 0, cmcSum = 0, spells = 0;
  for (const [n, q] of ents) { const c = drCard(n); if (isLand(c)) continue; curve[Math.min(6, Math.max(0, Math.round(c.cmc || 0)))] += q; cmcSum += (c.cmc || 0) * q; spells += q; if (isCreature(c)) cre += q; }
  const cmax = Math.max(...curve, 1), cols = [...new Set(ents.flatMap(([n]) => drCard(n).colors.split('')).filter(Boolean))];
  const side = Object.entries(pool).map(([n, q]) => [n, q - (st.main[n] || 0)]).filter(([, q]) => q > 0).sort((a, b) => (drCard(b[0]).z ?? -9) - (drCard(a[0]).z ?? -9));
  const row = (n, q, inMain) => { const c = drCard(n); return `<li class="row">${gPill(c)} <span>${q > 1 ? q + '× ' : ''}<a href="#" data-dc="${esc(n)}">${esc(n)}</a></span> ${pips(c.colors)}<span class="muted small">${isLand(c) ? 'land' : c.cmc}</span><span class="spacer"></span><button class="btn small" data-${inMain ? 'out' : 'in'}="${esc(n)}">${inMain ? '→ Sidan' : '+ Leken'}</button></li>`; };
  el.innerHTML = `<div class="card"><div class="row"><h3 style="margin:0">${total} / 40 kort</h3><span class="pill ${total === 40 ? 'good' : 'warn'}">${total < 40 ? 40 - total + ' kvar' : total > 40 ? total - 40 + ' för många' : 'Klar'}</span><span class="spacer"></span><button class="btn primary small" id="dAuto">Bygg åt mig</button><button class="btn small" id="dCopy">Kopiera lista</button></div>
      <p class="small muted">${spells} spells · ${cre} varelser · snitt-MV ${spells ? (cmcSum / spells).toFixed(2) : '–'} ${cols.length ? '· ' + pips(cols.sort((a, b) => COLORS.indexOf(a) - COLORS.indexOf(b)).join('')) : ''}</p>
      <div class="dcurve">${curve.map((v, i) => `<div><i style="height:${Math.round(v / cmax * 100)}%"></i><b>${v || ''}</b><span>${i === 6 ? '6+' : i}</span></div>`).join('')}</div>
      <h3>Basic lands <span class="muted small">${st.basics ? '(egna)' : '(föreslagna efter färgsymbolerna)'}</span></h3>
      <div class="row dbasics">${COLORS.map(c => `<span class="dbas">${pip(c)}<button class="btn small" data-b="${c}" data-d="-1">−</button><b>${basics[c]}</b><button class="btn small" data-b="${c}" data-d="1">+</button></span>`).join('')}${st.basics ? '<button class="btn small" id="dBasAuto">Föreslå igen</button>' : ''}</div>
      <p class="muted small">Tumregel: 17 länder (16 med en låg kurva), 15–17 varelser, ingen kortkostnad över 6 utan bra skäl.</p></div>
    <div class="grid dcols" style="margin-top:1rem"><div class="card"><h3 style="margin-top:0">Leken (${mainN})</h3><ul class="dlist">${ents.sort((a, b) => (drCard(a[0]).cmc || 0) - (drCard(b[0]).cmc || 0)).map(([n, q]) => row(n, q, true)).join('') || '<li class="muted small">Tom – tryck Bygg åt mig eller lägg till från sidan.</li>'}</ul></div>
      <div class="card"><h3 style="margin-top:0">Sidan (${side.reduce((a, [, q]) => a + q, 0)})</h3><ul class="dlist">${side.map(([n, q]) => row(n, q, false)).join('')}</ul></div></div>`;
  el.onclick = e => {
    const t = e.target.closest('[data-dc],[data-in],[data-out],[data-b]'); if (!t) return;
    e.preventDefault();
    if (t.dataset.dc) return dCardModal(t.dataset.dc);
    if (t.dataset.b) { const b = st.basics = { ...basics }; b[t.dataset.b] = Math.max(0, b[t.dataset.b] + +t.dataset.d); }
    else if (t.dataset.in) st.main[t.dataset.in] = (st.main[t.dataset.in] || 0) + 1;
    else { const n = t.dataset.out; if (--st.main[n] <= 0) delete st.main[n]; }
    drSave(); render();
  };
  $('#dAuto').onclick = () => { st.main = autoBuild(); st.basics = null; drSave(); render(); toast('Byggde den starkaste färgkombinationen'); };
  if ($('#dBasAuto')) $('#dBasAuto').onclick = () => { st.basics = null; drSave(); render(); };
  $('#dCopy').onclick = async () => {
    const txt = [...ents.map(([n, q]) => `${q} ${n}`), ...COLORS.filter(c => basics[c]).map(c => `${basics[c]} ${BASIC_OF[c]}`), '', 'Sideboard', ...side.map(([n, q]) => `${q} ${n}`)].join('\n');
    try { await navigator.clipboard.writeText(txt); toast('Listan är kopierad'); } catch { openModal(`<h2>Lista</h2><textarea style="width:100%;height:50vh">${esc(txt)}</textarea><p><button class="btn" data-close>Stäng</button></p>`); }
  };
}

// ---------- draftbord: sittordning, passningsriktning och plocktimer, delat mellan telefonerna ----------
// Den som skapar bordet bestämmer (värd); de andra skickar "klar" och resultat till värden, som skickar ut läget.
const pickSecs = (pick, size, base) => base ? Math.max(5, Math.round((base - (pick - 1) * (base - 5) / Math.max(1, size - 2)) / 5) * 5) : 0;
const tb = () => drState().table;
const isHost = () => !!tb()?.host;
const nowHost = () => Date.now() + (isHost() ? 0 : DR.off);
function tbSend(m) { DR.ch?.send({ type: 'broadcast', event: 'm', payload: { ...m, from: CID } }); }
function tbShared() { const t = tb(); return t && { code: t.code, phase: t.phase, players: t.players, size: t.size, base: t.base, pack: t.pack, pick: t.pick, endsAt: t.endsAt, paused: t.paused, ready: t.ready, tour: drState().tour }; }
function tbBroadcast() { if (isHost() && DR.ch) tbSend({ t: 'state', s: tbShared(), now: Date.now() }); }
function tbJoin(code) {
  if (!window.LV_CHANNEL) return false;
  if (DR.code === code && DR.ch) return true;
  tbLeave(true);
  DR.code = code; DR.peers = new Map();
  DR.ch = window.LV_CHANNEL('lv-draft-' + code);
  DR.ch.on('broadcast', { event: 'm' }, ({ payload }) => tbMsg(payload));
  DR.ch.subscribe(s => {
    if (s === 'SUBSCRIBED') tbSend({ t: 'hello', name: (S.profile?.name || '').slice(0, 20) });
    else if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') toast('Kunde inte ansluta till draftbordet – kolla nätet', 4000);
  });
  clearInterval(DR.ping); DR.ping = setInterval(() => { tbSend({ t: 'ping' }); if (isHost()) tbBroadcast(); }, 15000);
  tbTimer();
  return true;
}
function tbLeave(keep) { clearInterval(DR.ping); if (DR.ch) { try { DR.ch.unsubscribe(); } catch {} } DR.ch = null; DR.code = ''; if (!keep) { drState().table = null; drSave(); } }
const clip = (v, n) => String(v ?? '').replace(/[<>]/g, '').slice(0, n);
function cleanTable(s) {
  if (!s || typeof s !== 'object' || !/^[A-Z0-9]{6}$/.test(s.code)) return null;
  const players = (Array.isArray(s.players) ? s.players : []).slice(0, 16).map(p => ({ name: clip(p?.name, 20) || 'Spelare', cid: p?.cid ? clip(p.cid, 12) : '' }));
  return { code: s.code, phase: ['lobby', 'pick', 'between', 'done'].includes(s.phase) ? s.phase : 'lobby', players, size: num(s.size, 5, 20, 14), base: num(s.base, 0, 120, 40), pack: num(s.pack, 1, 3, 1), pick: num(s.pick, 1, 20, 1), endsAt: num(s.endsAt, 0, 9e15, 0), paused: s.paused == null ? null : num(s.paused, 0, 3e5, 0), ready: (Array.isArray(s.ready) ? s.ready : []).slice(0, 16).map(x => clip(x, 12)), tour: cleanTour(s.tour) };
}
function tbMsg(m) {
  const t = tb(); if (!t || !m || m.from === CID) return;
  DR.peers.set(clip(m.from, 12), Date.now());
  if (m.t === 'hello' && isHost()) {
    const name = clip(m.name, 20);
    if (t.phase === 'lobby' && !t.players.some(p => p.cid === m.from)) {
      const free = t.players.find(p => !p.cid && p.name.toLowerCase() === name.toLowerCase());
      if (free) free.cid = clip(m.from, 12); else if (t.players.length < 16) t.players.push({ name: name || 'Spelare ' + (t.players.length + 1), cid: clip(m.from, 12) });
      drSave();
    }
    tbBroadcast(); return tbRedraw();
  }
  if (m.t === 'state' && !isHost()) {
    const s = cleanTable(m.s); if (!s || s.code !== t.code) return;
    DR.off = num(m.now, 0, 9e15, Date.now()) - Date.now();
    const was = t.pack * 100 + t.pick, ph = t.phase;
    Object.assign(t, s); drState().tour = s.tour; drSave();
    if (t.pack * 100 + t.pick !== was && t.phase === 'pick') tbNewPick();
    const h = location.hash;
    if (h.startsWith('#/draft/bord') || h.startsWith('#/draft/turnering')) { if (t.pack * 100 + t.pick !== was || ph !== t.phase || h.startsWith('#/draft/turnering') || t.phase === 'lobby') return render(); }
    else if (h.startsWith('#/draft') && ph !== t.phase && !$('#dQ')?.value) return render();
    return tbRedraw();
  }
  if (!isHost()) return;
  if (m.t === 'ready' && t.phase === 'pick') { const c = clip(m.from, 12); t.ready = t.ready.filter(x => x !== c); if (m.on) t.ready.push(c); drSave(); tbBroadcast(); tbRedraw(); }
  if (m.t === 'res' && drState().tour) { if (setResult(drState().tour, num(m.r, 0, 20), num(m.i, 0, 10), m.res)) { drSave(); tbBroadcast(); if (location.hash.startsWith('#/draft')) render(); } }
}
function tbAdvance() {
  const t = tb();
  if (t.pick >= t.size) { if (t.pack >= 3) t.phase = 'done'; else { t.phase = 'between'; t.pack++; t.pick = 1; } t.ready = []; t.endsAt = 0; }
  else { t.pick++; t.ready = []; t.endsAt = t.base ? Date.now() + pickSecs(t.pick, t.size, t.base) * 1000 : 0; tbNewPick(); }
  drSave(); tbBroadcast();
  if (location.hash.startsWith('#/draft/bord')) render();
  else { const m = $('.dmini span:last-child'); if (m) m.textContent = `Bord ${t.code} · booster ${t.pack} · plock ${t.pick} · skicka åt ${t.pack === 2 ? 'höger →' : '← vänster'}`; }
}
function tbReady(on) {
  const t = tb(); if (!t) return;
  t.ready = t.ready.filter(x => x !== CID); if (on) t.ready.push(CID);
  if (isHost()) { drSave(); tbBroadcast(); } else tbSend({ t: 'ready', on });
  tbRedraw();
}
function tbNewPick() { DR.lastBeep = -1; beep(660, .12); try { navigator.vibrate?.(60); } catch {} }
function beep(f, dur) {
  try {
    if (typeof soundOn === 'function' && !soundOn()) return;
    const a = audio(); if (!a) return;
    const o = a.createOscillator(), g = a.createGain(), t0 = a.currentTime;
    o.frequency.value = f; o.type = 'sine'; g.gain.setValueAtTime(.0001, t0); g.gain.exponentialRampToValueAtTime(.25, t0 + .01); g.gain.exponentialRampToValueAtTime(.0001, t0 + dur);
    o.connect(g); g.connect(a.destination); o.start(t0); o.stop(t0 + dur + .05);
  } catch {}
}
function tbTimer() {
  clearInterval(DR.tick);
  DR.tick = setInterval(() => {
    const t = tb(); if (!t) return clearInterval(DR.tick);
    if (t.phase === 'pick' && t.paused == null) {
      const left = t.endsAt ? Math.ceil((t.endsAt - nowHost()) / 1000) : null;
      if (left != null && left <= 5 && left > 0 && left !== DR.lastBeep) { DR.lastBeep = left; beep(440, .07); }
      if (isHost()) {
        const needed = t.players.filter(p => p.cid && (p.cid === CID || Date.now() - (DR.peers.get(p.cid) || 0) < 60000 || !DR.ch)).map(p => p.cid);
        const allReady = needed.length > 0 && needed.every(c => t.ready.includes(c)) && (t.players.every(p => p.cid) || !t.base);
        if ((t.endsAt && Date.now() >= t.endsAt) || allReady) return tbAdvance();
      }
    }
    tbRedraw();
  }, 250);
}
function tbRedraw() {
  const t = tb(), el = $('#dTime'); if (!t || !el) return;
  let left = t.paused != null ? Math.ceil(t.paused / 1000) : t.endsAt ? Math.max(0, Math.ceil((t.endsAt - nowHost()) / 1000)) : null;
  el.textContent = left == null ? '–' : left >= 60 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : left;
  el.classList.toggle('low', left != null && left <= 5 && t.paused == null);
  const tot = pickSecs(t.pick, t.size, t.base), ring = $('#dRing');
  if (ring) ring.style.setProperty('--p', tot && left != null ? Math.max(0, Math.min(1, left / tot)) : 1);
  const rd = $('#dReady'); if (rd) rd.innerHTML = t.players.map(p => `<span class="pill ${t.ready.includes(p.cid) ? 'good' : ''}">${t.ready.includes(p.cid) ? '✓ ' : ''}${esc(p.name)}${p.cid ? '' : ' 📵'}</span>`).join(' ');
  const pl = $('#dPlayers'); if (pl && t.phase === 'lobby') pl.innerHTML = t.players.map((p, i) => `<li class="row"><span>${i + 1}. ${esc(p.name)}</span><span class="muted small">${p.cid === CID ? '(du)' : p.cid ? 'ansluten' : 'utan telefon'}</span><span class="spacer"></span>${isHost() && p.cid !== CID ? `<button class="icon-btn" data-kick="${i}" aria-label="Ta bort">✕</button>` : ''}</li>`).join('');
  const myBtn = $('#dMe'); if (myBtn) { const on = t.ready.includes(CID); myBtn.textContent = on ? '✓ Klar – väntar på de andra' : 'Jag har plockat'; myBtn.classList.toggle('primary', !on); }
}
function dTable(el) {
  const t = tb();
  if (!t) {
    el.innerHTML = `<div class="card" style="max-width:560px"><h3 style="margin-top:0">Starta ett draftbord</h3>
      <p class="small">Alla ser samma timer i sina telefoner. Bordet slumpar sittordningen, visar åt vilket håll boostern ska skickas och vem du får från, och går vidare när tiden är slut eller alla har tryckt <b>Jag har plockat</b>.</p>
      <p class="row"><label class="small">Kort per booster<br><select id="tSize">${[15, 14, 13, 12, 10].map(n => `<option ${n === (drState().size || 14) ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <label class="small">Tid för första plocket<br><select id="tBase"><option value="40">40 s (som Arena)</option><option value="60">60 s (lugnt)</option><option value="75">75 s (nybörjare)</option><option value="0">Ingen timer</option></select></label></p>
      <p class="row"><span class="spacer"></span><button class="btn primary" id="tNew">Skapa bord</button></p>
      ${window.LV_CHANNEL ? `<h3>Gå med vid ett bord</h3><div class="row"><input type="text" id="tCode" maxlength="6" placeholder="Kod" style="text-transform:uppercase;width:9rem"><button class="btn" id="tJoin">Gå med</button></div>` : '<p class="muted small">Utan inloggning (lokalt läge) körs bordet bara på den här telefonen.</p>'}</div>`;
    $('#tNew').onclick = () => {
      const size = +$('#tSize').value; drState().size = size;
      drState().table = { code: roomCode(), host: true, phase: 'lobby', players: [{ name: S.profile?.name || 'Jag', cid: CID }], size, base: +$('#tBase').value, pack: 1, pick: 1, endsAt: 0, paused: null, ready: [] };
      drSave(); tbJoin(drState().table.code) || tbTimer(); render();
    };
    if ($('#tJoin')) $('#tJoin').onclick = () => {
      const c = $('#tCode').value.trim().toUpperCase(); if (!/^[A-Z0-9]{6}$/.test(c)) return toast('Koden är 6 tecken');
      drState().table = { code: c, host: false, phase: 'lobby', players: [], size: 14, base: 40, pack: 1, pick: 1, endsAt: 0, paused: null, ready: [] };
      drSave(); tbJoin(c); render();
    };
    return;
  }
  if (t && !DR.ch && window.LV_CHANNEL) tbJoin(t.code); else if (!DR.tick) tbTimer();
  const n = t.players.length, me = t.players.findIndex(p => p.cid === CID);
  const dir = t.pack === 2 ? 'höger' : 'vänster';
  const to = me >= 0 && n > 1 ? t.players[(me + (t.pack === 2 ? n - 1 : 1)) % n].name : null, from = me >= 0 && n > 1 ? t.players[(me + (t.pack === 2 ? 1 : n - 1)) % n].name : null;
  const head = `<div class="row"><b>Bord ${esc(t.code)}</b><span class="muted small">${isHost() ? 'du är värd' : 'värden styr'} · ${t.base ? 'timer från ' + t.base + ' s' : 'ingen timer'} · ${t.size} kort/booster</span><span class="spacer"></span>
    ${window.LV_CHANNEL ? `<button class="btn small" id="tShare">Dela kod</button>` : ''}<button class="btn small danger" id="tLeave">${isHost() ? 'Avsluta bordet' : 'Lämna'}</button></div>`;
  if (t.phase === 'lobby') {
    el.innerHTML = `<div class="card">${head}
      <p class="small">Be de andra öppna <b>Lekverkstan → Draft → Draftbord</b> och skriva koden <b class="dcode">${esc(t.code)}</b>. Den som inte har telefonen med lägger du till med namn.</p>
      <ol id="dPlayers" class="dlist"></ol>
      ${isHost() ? `<div class="row"><input type="text" id="tName" maxlength="20" placeholder="Namn på spelare utan telefon"><button class="btn small" id="tAdd">Lägg till</button></div>
      <p class="row"><span class="spacer"></span><button class="btn primary" id="tStart" ${n < 2 ? 'disabled' : ''}>Slumpa platser och starta booster 1</button></p>` : '<p class="muted">Väntar på att värden startar…</p>'}</div>`;
    if (isHost()) {
      $('#tAdd').onclick = () => { const v = clip($('#tName').value.trim(), 20); if (!v) return; t.players.push({ name: v, cid: '' }); drSave(); tbBroadcast(); render(); };
      $('#tName').onkeydown = e => { if (e.key === 'Enter') $('#tAdd').click(); };
      $('#tStart').onclick = () => {
        for (let i = t.players.length - 1; i > 0; i--) { const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1); [t.players[i], t.players[j]] = [t.players[j], t.players[i]]; }
        Object.assign(t, { phase: 'pick', pack: 1, pick: 1, ready: [], paused: null, endsAt: t.base ? Date.now() + pickSecs(1, t.size, t.base) * 1000 : 0 });
        drSave(); tbBroadcast(); tbNewPick(); render();
      };
      el.addEventListener('click', e => { const k = e.target.closest('[data-kick]'); if (!k) return; t.players.splice(+k.dataset.kick, 1); drSave(); tbBroadcast(); render(); });
    }
  } else if (t.phase === 'done') {
    el.innerHTML = `<div class="card">${head}<h2>Draften är klar! 🎉</h2><p>Bygg din lek under <a href="#/draft/lek">Lek 40</a>. ${isHost() ? 'Starta turneringen när alla är klara – spelarna från bordet läggs in direkt, och första rundan paras med den som satt mittemot.' : 'Värden startar turneringen.'}</p>
      <p class="row">${isHost() ? `<button class="btn primary" id="tTour">Starta turnering</button>` : ''}<a class="btn" href="#/draft/lek">Bygg leken</a></p></div>`;
    if ($('#tTour')) $('#tTour').onclick = () => { drState().tour = newTour(t.players.map(p => p.name), true); drSave(); tbBroadcast(); location.hash = '#/draft/turnering'; };
  } else {
    el.innerHTML = `<div class="card dtable">${head}
      <div class="dclock"><div class="dring" id="dRing"><div id="dTime">–</div></div>
        <div><div class="dbig">Booster ${t.pack} · plock ${t.pick} / ${t.size}</div>
          ${t.phase === 'between' ? `<p><b>Öppna booster ${t.pack}</b> – den skickas åt <b>${dir}</b>${to ? ` (till ${esc(to)})` : ''}.</p>` : `<p class="ddir">Skicka åt <b>${dir}</b> ${t.pack === 2 ? '→' : '←'}${to ? `<br><span class="small">till <b>${esc(to)}</b> · du får från <b>${esc(from)}</b></span>` : ''}</p>`}
        </div></div>
      ${t.phase === 'pick' && me >= 0 ? `<button class="btn primary dme" id="dMe">Jag har plockat</button>` : ''}
      <div id="dReady" class="row" style="margin-top:.6rem"></div>
      <p class="small muted">Sittordning (medurs): ${t.players.map((p, i) => `${i === me ? '<b>' : ''}${esc(p.name)}${i === me ? '</b>' : ''}`).join(' → ')} → </p>
      ${isHost() ? `<p class="row">${t.phase === 'between' ? `<button class="btn primary" id="tGo">Starta booster ${t.pack}</button>` : `<button class="btn small" id="tPause">${t.paused != null ? '▶ Fortsätt' : '⏸ Pausa'}</button><button class="btn small" id="tNext">Nästa plock ⏭</button>`}</p>` : ''}
      <p class="small"><a href="#/draft/plocka">Öppna Plocka</a> för betyg – timern syns här när du kommer tillbaka.</p></div>`;
    if ($('#dMe')) $('#dMe').onclick = () => tbReady(!t.ready.includes(CID));
    if ($('#tGo')) $('#tGo').onclick = () => { Object.assign(t, { phase: 'pick', pick: 1, ready: [], paused: null, endsAt: t.base ? Date.now() + pickSecs(1, t.size, t.base) * 1000 : 0 }); drSave(); tbBroadcast(); tbNewPick(); render(); };
    if ($('#tNext')) $('#tNext').onclick = () => tbAdvance();
    if ($('#tPause')) $('#tPause').onclick = () => {
      if (t.paused != null) { t.endsAt = t.base ? Date.now() + t.paused : 0; t.paused = null; } else { t.paused = t.endsAt ? Math.max(0, t.endsAt - Date.now()) : 0; }
      drSave(); tbBroadcast(); render();
    };
  }
  $('#tLeave').onclick = () => { if (!confirm(isHost() ? 'Avsluta bordet för alla?' : 'Lämna bordet?')) return; if (isHost()) { tb().phase = 'done'; tbBroadcast(); } tbLeave(); wakeLock(false); render(); };
  if ($('#tShare')) $('#tShare').onclick = async () => { const txt = `Draft i Lekverkstan: Draft → Draftbord → kod ${t.code}`; try { if (navigator.share) await navigator.share({ text: txt }); else { await navigator.clipboard.writeText(t.code); toast('Koden är kopierad'); } } catch {} };
  tbRedraw();
}

// ---------- turnering (Swiss, bäst av tre) ----------
// tour = { players: [namn], rounds, pairs: [[{ a, b, res: '2-1' | null }]] }  b = -1 betyder bye
function cleanTour(t) {
  if (!t || !Array.isArray(t.players)) return null;
  const players = t.players.slice(0, 16).map(x => clip(x, 20));
  const n = players.length;
  const pairs = (Array.isArray(t.pairs) ? t.pairs : []).slice(0, 8).map(r => (Array.isArray(r) ? r : []).slice(0, 8).map(p => ({ a: num(p?.a, 0, n - 1), b: p?.b === -1 ? -1 : num(p?.b, 0, n - 1), res: /^[0-3]-[0-3](-[0-3])?$/.test(p?.res) ? p.res : null })));
  return { players, rounds: num(t.rounds, 1, 8, 3), pairs };
}
function newTour(names, cross) {
  const n = names.length, t = { players: names.slice(), rounds: n <= 2 ? 1 : n <= 4 ? 2 : n <= 8 ? 3 : 4, pairs: [] };
  let order = names.map((_, i) => i);
  if (cross) { const h = Math.ceil(n / 2); const r = []; for (let i = 0; i < Math.floor(n / 2); i++) r.push({ a: i, b: i + h, res: null }); if (n % 2) r.push({ a: h - 1, b: -1, res: '2-0' }); t.pairs.push(r); return t; }
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  t.pairs.push(pairUp(t, order)); return t;
}
function standings(t) {
  const n = t.players.length, P = t.players.map((name, i) => ({ i, name, mp: 0, m: 0, gp: 0, g: 0, opp: [], bye: 0, w: 0, l: 0, d: 0 }));
  for (const r of t.pairs) for (const p of r) {
    if (!p.res) continue;
    if (p.b === -1) { const A = P[p.a]; A.mp += 3; A.m++; A.w++; A.gp += 6; A.g += 2; A.bye++; continue; }
    const [x, y, dr = 0] = p.res.split('-').map(Number), A = P[p.a], B = P[p.b];
    const ma = x > y ? 3 : x === y ? 1 : 0, mb = y > x ? 3 : x === y ? 1 : 0;
    A.mp += ma; B.mp += mb; A.m++; B.m++; A.opp.push(p.b); B.opp.push(p.a);
    if (ma === 3) { A.w++; B.l++; } else if (mb === 3) { B.w++; A.l++; } else { A.d++; B.d++; }
    A.gp += x * 3 + dr; B.gp += y * 3 + dr; A.g += x + y + dr; B.g += x + y + dr;
  }
  const mw = p => Math.max(1 / 3, p.m ? p.mp / (3 * p.m) : 0), gw = p => Math.max(1 / 3, p.g ? p.gp / (3 * p.g) : 0);
  const avg = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  for (const p of P) { p.mw = mw(p); p.gw = gw(p); }
  for (const p of P) { p.omw = avg(p.opp.map(o => P[o].mw)); p.ogw = avg(p.opp.map(o => P[o].gw)); }
  return P.sort((a, b) => b.mp - a.mp || b.omw - a.omw || b.gw - a.gw || b.ogw - a.ogw || a.name.localeCompare(b.name, 'sv'));
}
function pairUp(t, order) {
  const met = new Set(), byes = new Set();
  for (const r of t.pairs) for (const p of r) { if (p.b === -1) byes.add(p.a); else { met.add(p.a + ':' + p.b); met.add(p.b + ':' + p.a); } }
  let list = order.slice(), bye = null;
  if (list.length % 2) { for (let k = list.length - 1; k >= 0; k--) if (!byes.has(list[k])) { bye = list[k]; break; } if (bye == null) bye = list[list.length - 1]; list = list.filter(x => x !== bye); }
  const go = rest => {
    if (!rest.length) return [];
    const [a, ...others] = rest;
    for (let k = 0; k < others.length; k++) { if (met.has(a + ':' + others[k])) continue; const sub = go(others.filter((_, j) => j !== k)); if (sub) return [{ a, b: others[k], res: null }, ...sub]; }
    return null;
  };
  const out = go(list) || list.reduce((acc, x, k) => (k % 2 ? acc : [...acc, { a: x, b: list[k + 1], res: null }]), []); // alla har mött alla: tillåt omspel
  if (bye != null) out.push({ a: bye, b: -1, res: '2-0' });
  return out;
}
function setResult(t, r, i, res) {
  const p = t?.pairs[r]?.[i]; if (!p || p.b === -1) return false;
  if (res !== null && !/^[0-3]-[0-3](-[0-3])?$/.test(res)) return false;
  p.res = res; return true;
}
const tourLocked = () => tb() && !isHost() && DR.ch;
function dTour(el) {
  const st = drState(), t = st.tour;
  if (!t) {
    const fromTable = tb()?.players?.map(p => p.name) || [];
    el.innerHTML = tourLocked() ? '<div class="card empty">Värden för draftbordet startar turneringen – den dyker upp här.</div>' : `<div class="card" style="max-width:560px"><h3 style="margin-top:0">Ny turnering</h3>
      <p class="small">Swiss, bäst av tre. Vinst = 3 poäng, oavgjort = 1. Ingen möter samma person två gånger, och bye går till den längst ner som inte haft det.</p>
      <label class="small">Spelare, en per rad<br><textarea id="tNames" rows="8" style="width:100%">${esc(fromTable.join('\n'))}</textarea></label>
      <p class="row"><label class="small"><input type="checkbox" id="tCross" ${fromTable.length ? 'checked' : ''}> Första rundan: mot den som satt mittemot vid draften (namnen i sittordning)</label></p>
      <p class="row"><span class="spacer"></span><button class="btn primary" id="tMake">Para runda 1</button></p></div>`;
    if ($('#tMake')) $('#tMake').onclick = () => {
      const names = [...new Set($('#tNames').value.split('\n').map(x => clip(x.trim(), 20)).filter(Boolean))];
      if (names.length < 2) return toast('Minst två spelare');
      st.tour = newTour(names, $('#tCross').checked); drSave(); tbBroadcast(); render();
    };
    return;
  }
  const cur = t.pairs.length - 1, done = t.pairs[cur].every(p => p.res), last = cur + 1 >= t.rounds, table = standings(t), lock = tourLocked();
  const resBtns = (r, i, p) => ['2-0', '2-1', '1-1', '1-2', '0-2'].map(x => `<button class="btn small ${p.res === x ? 'primary' : ''}" data-r="${r}" data-i="${i}" data-res="${x}">${x.replace('-', '–')}</button>`).join('');
  el.innerHTML = `<div class="card"><div class="row"><h3 style="margin:0">Runda ${cur + 1} av ${t.rounds}</h3><span class="spacer"></span>${lock ? '' : `<button class="btn small" id="tRounds">Antal rundor</button>`}</div>
      <ul class="dlist dpairs">${t.pairs[cur].map((p, i) => p.b === -1 ? `<li class="row"><b>${esc(t.players[p.a])}</b><span class="muted">har bye (räknas som 2–0)</span></li>`
        : `<li><div class="row"><b>${esc(t.players[p.a])}</b><span class="muted">mot</span><b>${esc(t.players[p.b])}</b><span class="spacer"></span><button class="btn small" data-life="${i}" title="Livräknare med 20 liv">❤ Liv</button></div>
          <div class="row" style="margin-top:.3rem">${resBtns(cur, i, p)}${p.res ? `<button class="btn small" data-r="${cur}" data-i="${i}" data-res="">Ångra</button>` : ''}</div></li>`).join('')}</ul>
      ${lock ? '' : done ? (last ? '<p><b>Turneringen är klar! 🏆</b></p><p class="row"><button class="btn small" id="tExtra">Spela en runda till</button></p>' : `<p class="row"><span class="spacer"></span><button class="btn primary" id="tNextR">Para runda ${cur + 2}</button></p>`) : '<p class="muted small">Tryck resultatet ur den förstes perspektiv (2–1 = första namnet vann två partier mot ett). Alla vid bordet kan rapportera.</p>'}</div>
    <div class="card" style="margin-top:1rem"><h3 style="margin-top:0">Tabell</h3>
      <table class="dstand"><thead><tr><th>#</th><th>Spelare</th><th>P</th><th>V-F-O</th><th title="Motståndarnas matchvinst-%">OMW</th><th title="Egen partivinst-%">GW</th><th title="Motståndarnas partivinst-%">OGW</th></tr></thead>
      <tbody>${table.map((p, k) => `<tr class="${k === 0 && done && last ? 'win' : ''}"><td>${k + 1}</td><td>${esc(p.name)}</td><td><b>${p.mp}</b></td><td>${p.w}-${p.l}-${p.d}</td><td>${(p.omw * 100).toFixed(0)}%</td><td>${(p.gw * 100).toFixed(0)}%</td><td>${(p.ogw * 100).toFixed(0)}%</td></tr>`).join('')}</tbody></table>
      <p class="muted small">Delas lika: OMW, sedan GW, sedan OGW (som i riktiga turneringar, golv 33 %).</p>
      ${lock ? '' : '<p class="row"><span class="spacer"></span><button class="btn small danger" id="tEnd">Ta bort turneringen</button></p>'}</div>`;
  el.onclick = e => {
    const b = e.target.closest('[data-res],[data-life]'); if (!b) return;
    if (b.dataset.life != null) {
      const p = t.pairs[cur][+b.dataset.life], ls = lifeState();
      if (ls?.players && !confirm('En match pågår redan i livräknaren. Starta en ny?')) return;
      if (ls?.room) roomLeave();
      lifeState.s = { setup: { n: 2, life: 20, names: [t.players[p.a], t.players[p.b], '', '', '', ''], deck: '', share: false } }; saveLife();
      location.hash = '#/liv'; return;
    }
    const r = +b.dataset.r, i = +b.dataset.i, res = b.dataset.res || null;
    if (lock) { tbSend({ t: 'res', r, i, res }); setResult(t, r, i, res); drSave(); return render(); }
    if (setResult(t, r, i, res)) { drSave(); tbBroadcast(); render(); }
  };
  const next = () => { t.pairs.push(pairUp(t, standings(t).map(p => p.i))); drSave(); tbBroadcast(); render(); };
  if ($('#tNextR')) $('#tNextR').onclick = next;
  if ($('#tExtra')) $('#tExtra').onclick = () => { t.rounds++; next(); };
  if ($('#tRounds')) $('#tRounds').onclick = () => { const v = prompt('Antal rundor', t.rounds); if (v && +v >= t.pairs.length && +v <= 8) { t.rounds = +v; drSave(); tbBroadcast(); render(); } };
  if ($('#tEnd')) $('#tEnd').onclick = () => { if (!confirm('Ta bort turneringen och alla resultat?')) return; st.tour = null; drSave(); tbBroadcast(); render(); };
}

// återanslut till ett pågående bord när appen startas om
(async () => {
  try {
    const t = drState().table; if (!t || t.phase === 'done') return;
    if (window.LV_READY) await window.LV_READY.catch(() => {});
    setTimeout(() => { if (window.LV_CHANNEL) tbJoin(t.code); else tbTimer(); }, 300);
  } catch {}
})();
