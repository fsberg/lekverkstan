// Manakeep – turneringar i molnet (v13). Arrangören bjuder in användare ur sina grupper, de tackar ja och väljer lek.
// Format: 1 mot 1 (Swiss, bäst av tre) eller Commander-bord (3–5 per bord, en match per runda).
// ❤ Liv startar en delad livräknare med matchens spelare; resultatet förs in här och matchen sparas hos alla med deras lek.
'use strict';
const KIND_SV = { duel: '1 mot 1, bäst av tre', pod: 'Commander-bord' };
const TSTAT_SV = { invited: 'Inbjuden', accepted: 'Med', declined: 'Tackat nej' };

async function loadTours(force) {
  if (!S.cloud || !S.v13) { S.tours = []; return; }
  if (S.tours && !force && Date.now() - loadTours.at < 60000) return;
  S.tours = await api('/api/tournaments').catch(() => S.tours || []);
  loadTours.at = Date.now();
}
const findTour = id => (S.tours || []).find(t => t.id === id);
const tourName = (t, uid) => t.players.find(p => p.id === uid)?.name || 'Okänd';
const myTourRow = t => t.players.find(p => p.me);
// notiser: inbjudningar som väntar på svar
function tourNotes() {
  return (S.tours || []).filter(t => t.status === 'invite' && myTourRow(t)?.status === 'invited')
    .map(t => ({ at: Date.parse(t.created) || 0, href: '#/matcher/turnering/' + t.id, isNew: true, text: `${tourName(t, t.owner)} bjuder in till ${t.name}`, sub: `${KIND_SV[t.kind]} · tacka ja och välj lek` }));
}

// ---------- realtid: den som sparar pingar de andra, som hämtar om ----------
const tourLive = { ch: null, id: '' };
function tourListen(id) {
  if (!window.LV_CHANNEL || tourLive.id === id) return;
  tourUnlisten();
  tourLive.id = id; tourLive.ch = window.LV_CHANNEL('lv-tourn-' + id);
  tourLive.ch.on('broadcast', { event: 'm' }, ({ payload }) => {
    if (payload?.t !== 'changed' || payload.from === CID) return;
    loadTours(true).then(() => { if (location.hash.startsWith('#/matcher/turnering')) render(); updateBell(); });
  });
  tourLive.ch.subscribe();
}
function tourUnlisten() { if (tourLive.ch) { try { tourLive.ch.unsubscribe(); } catch {} } tourLive.ch = null; tourLive.id = ''; }
const tourPing = () => tourLive.ch?.send({ type: 'broadcast', event: 'm', payload: { t: 'changed', from: CID } });

// spara en ändring: mutate(state) ändrar en kopia; vid krock hämtas den senaste och ändringen görs om en gång
async function tourSave(t, mutate, opts = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const st = JSON.parse(JSON.stringify(t.state));
    if (mutate(st) === false) return false;
    const done = opts.done ?? t.status === 'done', rounds = opts.rounds || t.rounds;
    try {
      const r = await api('/api/tournaments/' + t.id, { method: 'PUT', body: { state: st, ver: t.ver, done, rounds } });
      Object.assign(t, { state: st, ver: r.ver, status: done ? 'done' : 'running', rounds });
      tourPing(); return true;
    } catch (e) {
      if (attempt === 0 && /ändrats/.test(e.message)) { await loadTours(true); t = findTour(t.id); if (!t) break; continue; }
      toast('Kunde inte spara: ' + e.message, 4500); return false;
    }
  }
  return false;
}
// färdiga matcher i en runda sparas i allas spellogg (servern hoppar över det som redan finns)
async function tourLogRound(t, r) {
  let n = 0;
  for (let i = 0; i < (t.state.rounds[r] || []).length; i++) {
    const m = t.state.rounds[r][i];
    if (t.kind === 'duel' ? m.b === -1 || !m.res : m.w == null) continue;
    try { n += (await api(`/api/tournaments/${t.id}/log`, { method: 'POST', body: { round: r, index: i } })).added || 0; } catch (e) { toast('Kunde inte spara i spelloggen: ' + e.message, 4000); }
  }
  if (n) { const st = await api('/api/state').catch(() => null); if (st) S.games = st.games; }
  return n;
}

// ---------- parning och tabell ----------
function tourStandings(t) {
  const st = t.state, P = st.players.map((uid, i) => ({ i, uid, name: tourName(t, uid), mp: 0, m: 0, gp: 0, g: 0, opp: [], bye: 0, w: 0, l: 0, d: 0 }));
  for (const r of st.rounds) for (const m of r) {
    if (t.kind === 'pod') {
      if (m.w == null) continue;
      for (const k of m.p) { const A = P[k]; A.m++; A.opp.push(...m.p.filter(x => x !== k)); if (m.w === -1) { A.mp += 1; A.d++; } else if (m.w === k) { A.mp += 3; A.w++; } else A.l++; }
      continue;
    }
    if (!m.res) continue;
    if (m.b === -1) { const A = P[m.a]; A.mp += 3; A.m++; A.w++; A.gp += 6; A.g += 2; A.bye++; continue; }
    const [x, y, dr = 0] = m.res.split('-').map(Number), A = P[m.a], B = P[m.b];
    const ma = x > y ? 3 : x === y ? 1 : 0, mb = y > x ? 3 : x === y ? 1 : 0;
    A.mp += ma; B.mp += mb; A.m++; B.m++; A.opp.push(m.b); B.opp.push(m.a);
    if (ma === 3) { A.w++; B.l++; } else if (mb === 3) { B.w++; A.l++; } else { A.d++; B.d++; }
    A.gp += x * 3 + dr; B.gp += y * 3 + dr; A.g += x + y + dr; B.g += x + y + dr;
  }
  const mw = p => Math.max(1 / 3, p.m ? p.mp / (3 * p.m) : 0), gw = p => Math.max(1 / 3, p.g ? p.gp / (3 * p.g) : 0);
  const avg = xs => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  for (const p of P) { p.mw = mw(p); p.gw = gw(p); }
  for (const p of P) { p.omw = avg(p.opp.map(o => P[o].mw)); p.ogw = avg(p.opp.map(o => P[o].gw)); }
  return P.sort((a, b) => b.mp - a.mp || b.omw - a.omw || b.gw - a.gw || b.w - a.w || a.name.localeCompare(b.name, 'sv'));
}
function tourPairDuel(st, order) {
  const met = new Set(), byes = new Set();
  for (const r of st.rounds) for (const m of r) { if (m.b === -1) byes.add(m.a); else { met.add(m.a + ':' + m.b); met.add(m.b + ':' + m.a); } }
  let list = order.slice(), bye = null;
  if (list.length % 2) { for (let k = list.length - 1; k >= 0; k--) if (!byes.has(list[k])) { bye = list[k]; break; } if (bye == null) bye = list[list.length - 1]; list = list.filter(x => x !== bye); }
  const go = rest => {
    if (!rest.length) return [];
    const [a, ...others] = rest;
    for (let k = 0; k < others.length; k++) { if (met.has(a + ':' + others[k])) continue; const sub = go(others.filter((_, j) => j !== k)); if (sub) return [{ a, b: others[k], res: null }, ...sub]; }
    return null;
  };
  const out = go(list) || list.reduce((acc, x, k) => (k % 2 ? acc : [...acc, { a: x, b: list[k + 1], res: null }]), []);
  if (bye != null) out.push({ a: bye, b: -1, res: '2-0' });
  return out;
}
// bord med 3–5 spelare, så jämnt som möjligt (5 → ett bord med 5, 6 → 3+3, 7 → 4+3, 9 → 5+4)
function tourPairPods(order) {
  const n = order.length, tables = Math.max(1, Math.round(n / 4)), out = [];
  let k = 0;
  for (let i = 0; i < tables; i++) { const size = Math.floor(n / tables) + (i < n % tables ? 1 : 0); out.push({ p: order.slice(k, k + size), w: null }); k += size; }
  return out;
}
const shuffled = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
function tourNextRound(t, st) {
  const order = st.rounds.length ? tourStandings({ ...t, state: st }).map(p => p.i) : shuffled(st.players.map((_, i) => i));
  st.rounds.push(t.kind === 'pod' ? tourPairPods(order) : tourPairDuel(st, order));
}
const matchDone = (t, m) => (t.kind === 'pod' ? m.w != null : !!m.res);
const matchPlayers = (t, m) => (t.kind === 'pod' ? m.p : m.b === -1 ? [m.a] : [m.a, m.b]);

// ---------- livräknaren ----------
// ett parti är klart i livräknaren: winner = spelarens konto-id eller 'draw'
async function tourGameDone(ref, winner) {
  await loadTours(true);
  const t = findTour(ref.id);
  if (!t || t.status === 'invite') return toast('Turneringen finns inte längre – resultatet sparades inte', 4000);
  let msg = '';
  const ok = await tourSave(t, st => {
    const m = st.rounds[ref.r]?.[ref.i]; if (!m || matchDone(t, m)) { msg = 'Matchen hade redan ett resultat'; return false; }
    const idx = winner === 'draw' ? -1 : st.players.indexOf(winner);
    delete m.room;
    if (t.kind === 'pod') { m.w = idx; msg = idx < 0 ? 'Bordet slutade utan vinnare' : `${tourName(t, st.players[idx])} vann bordet`; return; }
    const g = m.g = m.g || [0, 0, 0];
    if (idx < 0) g[2]++; else if (idx === m.a) g[0]++; else if (idx === m.b) g[1]++; else return false;
    const score = `${g[0]}–${g[1]}${g[2] ? `–${g[2]}` : ''}`, A = tourName(t, st.players[m.a]), B = tourName(t, st.players[m.b]);
    if (g[0] >= 2 || g[1] >= 2 || g[0] + g[1] + g[2] >= 3) { m.res = `${g[0]}-${g[1]}${g[2] ? `-${g[2]}` : ''}`; msg = g[0] === g[1] ? `Oavgjort ${score}` : `${g[0] > g[1] ? A : B} vann matchen ${score}`; }
    else msg = `${idx < 0 ? 'Oavgjort parti' : tourName(t, winner) + ' vann partiet'}. Ställning ${score} – spela nästa parti`;
  });
  if (msg) toast(msg, 4500);
  return ok;
}
// starta (eller gå med i) matchens delade livräknare
async function tourLife(t, r, i, fresh) {
  const m = t.state.rounds[r][i], idx = matchPlayers(t, m), uids = idx.map(k => t.state.players[k]);
  if (!uids.includes(S.profile?.id)) return toast('Bara de som spelar matchen kan starta livräknaren');
  const ls = lifeState(), ref = { id: t.id, r, i };
  const same = ls?.tour?.id === t.id && ls.tour.r === r && ls.tour.i === i;
  if (ls?.players && !same && !confirm('En match pågår redan i livräknaren. Avsluta den och starta det här partiet?')) return;
  if (m.room && !fresh) { // någon har redan startat räknaren: gå med
    if (same && ls.room === m.room) { location.hash = '#/liv/' + m.room; return; }
    if (ls?.room) roomLeave();
    lifeState.s = { room: m.room, synced: false, me: null, myDeck: '', tour: ref }; saveLife();
    location.hash = '#/liv/' + m.room; return;
  }
  if (ls?.room) roomLeave();
  const code = roomCode();
  const ok = await tourSave(t, st => { const x = st.rounds[r]?.[i]; if (!x || matchDone(t, x)) return false; x.room = code; });
  if (!ok) return render();
  const names = uids.map(u => tourName(t, u)), me = uids.indexOf(S.profile.id);
  lifeState.s = { setup: { n: uids.length, life: t.life, names, uids, deck: '', share: true, tour: ref }, start: Date.now(),
    players: names.map((name, k) => ({ name, uid: uids[k], life: t.life, poison: 0, cmd: {}, ctr: {}, tok: {} })), applied: [], marks: {},
    room: code, me, myDeck: '', synced: true, seats: { [me]: CID }, tour: ref };
  saveLife(); roomJoin(code); location.hash = '#/liv/' + code;
}

// ---------- vyer ----------
function viewTourPage(id) {
  setNav('matcher');
  $('#app').innerHTML = `<div class="row"><h1>Spela</h1></div>${gameTabs('turnering')}<div id="grp" style="margin-top:1rem"></div>`;
  const el = $('#grp');
  if (!S.cloud) { el.innerHTML = '<div class="card empty">Turneringar finns i molnversionen, där spelarna bjuds in med sina konton.</div>'; return; }
  if (!S.v13) { el.innerHTML = '<div class="card empty">Turneringar är inte påslagna i databasen än (v13).</div>'; return; }
  if (!S.tours) { el.innerHTML = '<p class="muted">Hämtar turneringar…</p>'; loadTours().then(() => location.hash.startsWith('#/matcher/turnering') && render()); return; }
  if (id) {
    const t = findTour(id);
    if (t) { tourListen(t.id); return tourDetail(el, t); }
    el.innerHTML = '<div class="card empty">Turneringen finns inte, eller så är du inte med i den. <a href="#/matcher/turnering">Alla turneringar</a></div>'; return;
  }
  tourUnlisten();
  tourList(el);
}

function tourList(el) {
  const list = S.tours, open = !!viewTourPage.create;
  const row = t => {
    const me = myTourRow(t), acc = t.players.filter(p => p.status === 'accepted').length;
    return `<a class="card deck-tile tour-tile" href="#/matcher/turnering/${t.id}"><div class="body"><b>${esc(t.name)}</b>
      <div class="muted small">${esc(KIND_SV[t.kind])} · ${t.mine ? 'du arrangerar' : 'av ' + esc(tourName(t, t.owner))}</div>
      <div class="row small" style="margin-top:.4rem"><span class="pill ${t.status === 'running' ? 'good' : ''}">${t.status === 'invite' ? 'Inbjudan' : t.status === 'running' ? `Runda ${t.state.rounds?.length || 1} av ${t.rounds}` : 'Klar'}</span>
      <span class="pill">${acc} med</span>${me?.status === 'invited' ? '<span class="pill warn">Svara!</span>' : ''}</div></div></a>`;
  };
  const users = (S.users || []).filter(u => u.id !== S.profile?.id).sort((a, b) => a.name.localeCompare(b.name, 'sv'));
  el.innerHTML = `<div class="row"><h2 style="margin:0">Turneringar</h2><span class="spacer"></span><button class="btn ${open ? '' : 'primary'}" id="tNew">${open ? 'Stäng' : '+ Ny turnering'}</button></div>
    ${open ? `<div class="card" style="max-width:620px;margin-top:.8rem"><h2>Ny turnering</h2>
      <p><input type="text" id="tnName" maxlength="60" style="width:100%" value="Turnering ${new Date().toLocaleDateString('sv-SE')}"></p>
      <div class="seg" id="tnKind">${Object.entries(KIND_SV).map(([k, l]) => `<button data-k="${k}" class="${k === 'duel' ? 'on' : ''}">${l}</button>`).join('')}</div>
      <p class="row" style="margin-top:.7rem"><label class="small">Startliv<br><select id="tnLife">${[20, 25, 30, 40].map(n => `<option>${n}</option>`).join('')}</select></label>
        <label class="small" style="flex:1">Min lek<br><select id="tnDeck" style="width:100%"><option value="">Välj senare</option>${S.decks.map(d => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></label></p>
      <h3>Bjud in</h3>
      ${users.length ? `<div class="tour-pick">${users.map(u => `<label class="chk"><input type="checkbox" value="${u.id}"> ${esc(u.name)}</label>`).join('')}</div>`
        : '<p class="small muted">Ingen att bjuda in än. Bara de i dina grupper som har ett namn syns här – bjud in under <a href="#/installningar">Inställningar → Grupper</a>.</p>'}
      <p class="small muted">De inbjudna får en notis, tackar ja och väljer lek. Du startar när alla har svarat.</p>
      <p class="row"><span class="spacer"></span><button class="btn primary" id="tnGo">Skicka inbjudningar</button></p></div>` : ''}
    ${list.length ? `<div class="deck-grid">${list.map(row).join('')}</div>` : open ? '' : '<div class="card empty" style="margin-top:1rem">Inga turneringar än. Skapa en och bjud in kompisarna.</div>'}`;
  $('#tNew').onclick = () => { viewTourPage.create = !open; render(); };
  if (!open) return;
  let kind = 'duel';
  $('#tnKind').onclick = e => { const b = e.target.closest('[data-k]'); if (!b) return; kind = b.dataset.k; $$('#tnKind button').forEach(x => x.classList.toggle('on', x === b)); $('#tnLife').value = kind === 'pod' ? '40' : '20'; };
  $('#tnDeck').onchange = e => { const d = S.decks.find(x => x.id === e.target.value); if (d && kind === 'duel') $('#tnLife').value = d.format === 'commander' ? '40' : '20'; };
  $('#tnGo').onclick = async () => {
    const players = $$('.tour-pick input:checked').map(x => x.value);
    if (!players.length) return toast('Bjud in minst en spelare');
    $('#tnGo').disabled = true;
    try {
      const { id } = await api('/api/tournaments', { method: 'POST', body: { name: $('#tnName').value, kind, life: +$('#tnLife').value, players, deck: $('#tnDeck').value || null } });
      viewTourPage.create = false; await loadTours(true); toast('Inbjudningarna är skickade'); location.hash = '#/matcher/turnering/' + id;
    } catch (e) { toast(e.message, 4500); $('#tnGo').disabled = false; }
  };
}

function tourDetail(el, t) {
  const me = myTourRow(t), st = t.state;
  const head = `<div class="row"><a href="#/matcher/turnering" class="btn small" aria-label="Alla turneringar">←</a><h2 style="margin:0;flex:1">${esc(t.name)}</h2>
    <span class="pill">${esc(KIND_SV[t.kind])}</span><span class="pill">❤ ${t.life}</span></div>`;
  const deckSel = (cur, idAttr) => `<select id="${idAttr}" style="min-width:10rem;flex:1"><option value="">Ingen lek vald</option>${S.decks.map(d => `<option value="${d.id}" ${d.id === cur ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>`;

  if (t.status === 'invite') {
    const acc = t.players.filter(p => p.status === 'accepted');
    el.innerHTML = `${head}<div class="card" style="margin-top:.8rem;max-width:720px">
      <table><thead><tr><th>Spelare</th><th>Svar</th><th>Lek</th></tr></thead><tbody>
      ${t.players.map(p => `<tr><td>${esc(p.name)}${p.owner ? ' ★' : ''}${p.me ? ' (du)' : ''}</td><td><span class="pill ${p.status === 'accepted' ? 'good' : p.status === 'declined' ? 'bad' : 'warn'}">${TSTAT_SV[p.status]}</span></td><td class="small">${esc(p.deck_name || '–')}</td></tr>`).join('')}</tbody></table>
      ${me ? `<h3>Ditt svar</h3><div class="row">${deckSel(me.deck_id, 'tDeck')}<button class="btn primary" id="tYes">${me.status === 'accepted' ? 'Spara lek' : 'Tacka ja'}</button>${me.owner ? '' : '<button class="btn" id="tNo">Tacka nej</button>'}</div>` : ''}
      ${t.mine ? `<h3>Arrangör</h3><p class="small muted">${acc.length} har tackat ja${t.players.some(p => p.status === 'invited') ? ', några har inte svarat än' : ''}. När du startar paras första rundan bland dem som tackat ja.</p>
        <p class="row"><button class="btn danger small" id="tDel">Ta bort turneringen</button><span class="spacer"></span><button class="btn primary" id="tStart" ${acc.length < 2 ? 'disabled' : ''}>Starta turneringen</button></p>` : ''}</div>`;
    const respond = async accept => {
      try { await api(`/api/tournaments/${t.id}/respond`, { method: 'POST', body: { accept, deck: accept ? $('#tDeck').value || null : null } }); tourPing(); await loadTours(true); updateBell(); toast(accept ? 'Du är med!' : 'Du har tackat nej'); render(); }
      catch (e) { toast(e.message, 4500); }
    };
    if ($('#tYes')) $('#tYes').onclick = () => respond(true);
    if ($('#tNo')) $('#tNo').onclick = () => { if (confirm('Tacka nej till turneringen?')) respond(false); };
    if ($('#tStart')) $('#tStart').onclick = async () => {
      const waiting = t.players.filter(p => p.status === 'invited');
      if (waiting.length && !confirm(`${waiting.map(p => p.name).join(', ')} har inte svarat och blir inte med. Starta ändå?`)) return;
      const players = acc.map(p => p.id), n = players.length;
      const s2 = { players, rounds: [] }, rounds = t.kind === 'pod' ? 3 : n <= 2 ? 1 : n <= 4 ? 2 : n <= 8 ? 3 : 4;
      tourNextRound(t, s2);
      try { const r = await api(`/api/tournaments/${t.id}/start`, { method: 'POST', body: { state: s2, rounds } }); Object.assign(t, { state: s2, ver: r.ver, status: 'running', rounds }); tourPing(); render(); }
      catch (e) { toast(e.message, 4500); }
    };
    if ($('#tDel')) $('#tDel').onclick = () => tourDelete(t);
    return;
  }

  // pågår eller klar
  const cur = st.rounds.length - 1, round = st.rounds[cur], done = round.every(m => matchDone(t, m)), last = cur + 1 >= t.rounds, table = tourStandings(t);
  const nm = k => esc(tourName(t, st.players[k])), deckOf = k => t.players.find(p => p.id === st.players[k])?.deck_name || '';
  const who = k => `<b>${nm(k)}</b>${deckOf(k) ? ` <span class="muted small">${esc(deckOf(k))}</span>` : ''}`;
  const iPlay = m => matchPlayers(t, m).some(k => st.players[k] === S.profile?.id);
  const lifeBtns = (m, i) => t.status === 'done' || matchDone(t, m) || !iPlay(m) || (t.kind === 'duel' && m.b === -1) ? ''
    : m.room ? `<button class="btn small primary" data-tlife="${i}">❤ Gå med</button><button class="btn small" data-tlife="${i}" data-fresh title="Starta en ny räknare om den gamla inte svarar">Ny räknare</button>`
    : `<button class="btn small" data-tlife="${i}">❤ ${m.g ? 'Nästa parti' : 'Liv'}</button>`;
  const editable = t.status !== 'done' && (me?.status === 'accepted' || t.mine);
  const duelRow = (m, i) => m.b === -1 ? `<li class="row">${who(m.a)}<span class="muted">har bye (räknas som 2–0)</span></li>`
    : `<li><div class="row">${who(m.a)}<span class="muted">mot</span>${who(m.b)}${m.g && !m.res ? `<span class="pill">Partier ${m.g[0]}–${m.g[1]}${m.g[2] ? `–${m.g[2]}` : ''}</span>` : ''}<span class="spacer"></span>${lifeBtns(m, i)}</div>
      ${editable ? `<div class="row" style="margin-top:.3rem">${['2-0', '2-1', '1-1', '1-2', '0-2'].map(x => `<button class="btn small ${m.res === x ? 'primary' : ''}" data-i="${i}" data-res="${x}">${x.replace('-', '–')}</button>`).join('')}${m.res ? `<button class="btn small" data-i="${i}" data-res="">Ångra</button>` : ''}</div>`
        : m.res ? `<p class="small">Resultat ${m.res.replace(/-/g, '–')}</p>` : ''}</li>`;
  const podRow = (m, i) => `<li><div class="row"><b>Bord ${i + 1}</b><span class="spacer"></span>${lifeBtns(m, i)}</div>
      <div class="small" style="margin:.3rem 0">${m.p.map(k => `${who(k)}${m.w === k ? ' 🏆' : ''}`).join(' · ')}</div>
      ${editable ? `<div class="row small">Vinnare: ${m.p.map(k => `<button class="btn small ${m.w === k ? 'primary' : ''}" data-i="${i}" data-w="${k}">${nm(k)}</button>`).join('')}<button class="btn small ${m.w === -1 ? 'primary' : ''}" data-i="${i}" data-w="-1">Ingen</button>${m.w != null ? `<button class="btn small" data-i="${i}" data-w="">Ångra</button>` : ''}</div>`
        : m.w != null ? `<p class="small">${m.w === -1 ? 'Ingen vann' : nm(m.w) + ' vann'}</p>` : ''}</li>`;
  el.innerHTML = `${head}
    <div class="card" style="margin-top:.8rem"><div class="row"><h2 style="margin:0">${t.status === 'done' ? 'Slutställning' : `Runda ${cur + 1} av ${t.rounds}`}</h2><span class="spacer"></span>${editable ? '<button class="btn small" id="tRounds">Antal rundor</button>' : ''}</div>
      ${t.status === 'done' ? `<p><b>${esc(table[0]?.name || '')} vann turneringen! 🏆</b></p>` : `<ul class="dlist dpairs">${round.map((m, i) => (t.kind === 'pod' ? podRow(m, i) : duelRow(m, i))).join('')}</ul>
      ${done && editable ? (last ? '<p class="row"><button class="btn small" id="tExtra">Spela en runda till</button><span class="spacer"></span><button class="btn primary" id="tFinish">Avsluta turneringen</button></p>' : `<p class="row"><span class="spacer"></span><button class="btn primary" id="tNextR">Para runda ${cur + 2}</button></p>`) : ''}
      <p class="muted small">❤ Liv startar en delad livräknare med matchens spelare – var och en ändrar sitt liv i sin telefon och resultatet förs in här. ${t.kind === 'duel' ? 'Du kan också trycka resultatet direkt (2–1 = den första vann två partier mot ett).' : 'Du kan också välja vinnaren direkt.'} Matcherna sparas i allas spellogg med deras lek när rundan är klar.</p>`}</div>
    <div class="card" style="margin-top:1rem"><h2 style="margin-top:0">Tabell</h2>
      <table class="dstand"><thead><tr><th>#</th><th>Spelare</th><th>P</th><th>V-F-O</th>${t.kind === 'duel' ? '<th title="Motståndarnas matchvinst-%">OMW</th><th title="Egen partivinst-%">GW</th>' : ''}</tr></thead>
      <tbody>${table.map((p, k) => `<tr class="${k === 0 && t.status === 'done' ? 'win' : ''}"><td>${k + 1}</td><td>${esc(p.name)}${p.bye ? ' <span class="pill" title="Stod över en runda – räknas som vinst 2–0">bye</span>' : ''}</td><td><b>${p.mp}</b></td><td>${p.w}-${p.l}-${p.d}</td>${t.kind === 'duel' ? `<td>${(p.omw * 100).toFixed(0)}%</td><td>${(p.gw * 100).toFixed(0)}%</td>` : ''}</tr>`).join('')}</tbody></table>
      <p class="muted small">${t.kind === 'duel' ? 'Vinst 3 poäng, oavgjort 1. Bye = stod över en runda och fick en vinst. Delas lika: OMW, sedan GW.' : 'Vinst 3 poäng, bord utan vinnare 1 poäng till alla vid bordet.'}</p>
      ${t.mine ? '<p class="row"><span class="spacer"></span><button class="btn small danger" id="tDel">Ta bort turneringen</button></p>' : ''}</div>`;
  el.onclick = async e => {
    const lb = e.target.closest('[data-tlife]');
    if (lb) return tourLife(t, cur, +lb.dataset.tlife, 'fresh' in lb.dataset);
    const b = e.target.closest('[data-res],[data-w]'); if (!b || !editable) return;
    const i = +b.dataset.i;
    const ok = await tourSave(t, s2 => {
      const m = s2.rounds[cur][i]; if (!m) return false;
      delete m.g; delete m.room;
      if ('w' in b.dataset) m.w = b.dataset.w === '' ? null : +b.dataset.w; else m.res = b.dataset.res || null;
    });
    if (ok) render();
  };
  const next = async extra => {
    const ok = await tourSave(t, s2 => { tourNextRound(t, s2); }, extra ? { rounds: t.rounds + 1 } : {});
    if (ok) { render(); const n = await tourLogRound(t, cur); if (n) toast(`Runda ${cur + 1} är sparad i spelloggen`); }
  };
  if ($('#tNextR')) $('#tNextR').onclick = () => next(false);
  if ($('#tExtra')) $('#tExtra').onclick = () => next(true);
  if ($('#tFinish')) $('#tFinish').onclick = async () => {
    if (!confirm('Avsluta turneringen? Matcherna sparas i allas spellogg.')) return;
    const ok = await tourSave(t, () => {}, { done: true });
    if (ok) { render(); await tourLogRound(t, cur); toast('Turneringen är avslutad och sparad i spelloggen', 4000); }
  };
  if ($('#tRounds')) $('#tRounds').onclick = async () => { const v = prompt('Antal rundor', t.rounds); if (v && +v >= st.rounds.length && +v <= 8 && await tourSave(t, () => {}, { rounds: +v })) render(); };
  if ($('#tDel')) $('#tDel').onclick = () => tourDelete(t);
}
async function tourDelete(t) {
  if (!confirm(`Ta bort ${t.name} för alla? Matcher som redan sparats i spelloggen finns kvar.`)) return;
  try { await api('/api/tournaments/' + t.id, { method: 'DELETE' }); tourPing(); S.tours = S.tours.filter(x => x.id !== t.id); updateBell(); location.hash = '#/matcher/turnering'; }
  catch (e) { toast(e.message, 4500); }
}
