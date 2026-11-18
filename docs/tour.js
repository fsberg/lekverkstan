// Manakeep – turnering under Spela: Swiss, bäst av tre. Sparas på enheten (localStorage lv-tour),
// kan delas live med de andra vid bordet (Realtime broadcast, inget sparas på servern) och
// färdiga matcher sparas i spelloggen hos spelarna som har konto.
'use strict';
const TOUR_KEY = 'lv-tour', TOUR_LOGGED = 'lv-tour-logged';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function tourState() {
  if (tourState.s !== undefined) return tourState.s;
  let t = null;
  try { t = JSON.parse(localStorage.getItem(TOUR_KEY)); } catch {}
  // en turnering som startades under den gamla Draft-fliken flyttas hit
  if (!t) { try { t = JSON.parse(localStorage.getItem('lv-draft'))?.tour || null; } catch {} }
  tourState.s = cleanTour(t);
  if (tourState.s && t && !t.id) tourSave(); // gammal turnering får ett id
  return tourState.s;
}
function tourSave() { try { localStorage.setItem(TOUR_KEY, JSON.stringify(tourState.s)); } catch {} }
const tClip = (v, n) => String(v ?? '').replace(/[<>]/g, '').slice(0, n);

// tour = { id, ver, players: [namn], uids: [konto-id eller ''], rounds, pairs: [[{ a, b, res: '2-1' | null }]], room }  b = -1 betyder bye
function cleanTour(t) {
  if (!t || !Array.isArray(t.players) || t.players.length < 2) return null;
  const players = t.players.slice(0, 16).map(x => tClip(x, 20));
  const n = players.length;
  const pairs = (Array.isArray(t.pairs) ? t.pairs : []).slice(0, 8).map(r => (Array.isArray(r) ? r : []).slice(0, 8).map(p => ({ a: num(p?.a, 0, n - 1), b: p?.b === -1 ? -1 : num(p?.b, 0, n - 1), res: /^[0-3]-[0-3](-[0-3])?$/.test(p?.res) ? p.res : null })));
  if (!pairs.length) return null;
  return {
    id: /^\d{13}$/.test(String(t.id)) ? String(t.id) : String(Date.now()),
    ver: num(t.ver, 0, 1e9, 0),
    players,
    uids: players.map((_, i) => (UUID_RE.test(t.uids?.[i]) ? t.uids[i] : '')),
    rounds: num(t.rounds, 1, 8, 3), pairs,
    room: /^[A-Z0-9]{6}$/.test(t.room || '') ? t.room : '',
  };
}
// konto för ett namn: bland dem man delar grupp med, eller en själv
const tourUid = name => (S.users || []).find(u => u.name === name)?.id || (S.profile?.name && S.profile.name.trim() === name ? S.profile.id || '' : '');
function newTour(names) {
  const n = names.length, t = { id: String(Date.now()), ver: 0, players: names.slice(), uids: names.map(x => (S.cloud ? tourUid(x) : '')), rounds: n <= 2 ? 1 : n <= 4 ? 2 : n <= 8 ? 3 : 4, pairs: [], room: '' };
  const order = names.map((_, i) => i);
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  t.pairs.push(pairUp(t, order)); return t;
}
function standings(t) {
  const P = t.players.map((name, i) => ({ i, name, mp: 0, m: 0, gp: 0, g: 0, opp: [], bye: 0, w: 0, l: 0, d: 0 }));
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

// ---------- dela live: alla som följer ser parningar och tabell och kan fylla i resultat ----------
const tourRoom = { ch: null, code: '', waiting: false, err: false };
const tourOnPage = () => location.hash === '#/matcher/turnering';
function tourSend(m) { tourRoom.ch?.send({ type: 'broadcast', event: 'm', payload: { ...m, from: CID } }); }
const tourPublic = t => { const { room, ...rest } = t; return rest; };
function tourConnect(code) {
  if (!window.LV_CHANNEL || !/^[A-Z0-9]{6}$/.test(code)) return false;
  if (tourRoom.code === code && tourRoom.ch) return true;
  tourDisconnect();
  tourRoom.code = code; tourRoom.err = false;
  tourRoom.ch = window.LV_CHANNEL('lv-tour-' + code);
  tourRoom.ch.on('broadcast', { event: 'm' }, ({ payload }) => tourMsg(payload));
  tourRoom.ch.subscribe(st => {
    if (st === 'SUBSCRIBED') { tourRoom.err = false; const t = tourState(); if (t) tourSend({ t: 'state', s: tourPublic(t) }); else tourSend({ t: 'hello' }); }
    else if ((st === 'CHANNEL_ERROR' || st === 'TIMED_OUT') && !tourRoom.err) { tourRoom.err = true; toast('Kunde inte ansluta till den delade turneringen – kolla nätet', 4000); }
  });
  return true;
}
function tourDisconnect() { if (tourRoom.ch) { try { tourRoom.ch.unsubscribe(); } catch {} } tourRoom.ch = null; tourRoom.code = ''; tourRoom.waiting = false; }
function tourMsg(m) {
  if (!m || typeof m !== 'object') return;
  const t = tourState();
  if (m.t === 'hello') { if (t) tourSend({ t: 'state', s: tourPublic(t) }); return; }
  if (m.t !== 'state') return;
  const s = cleanTour(m.s); if (!s) return;
  if (t && t.id !== s.id && !tourRoom.waiting) return; // en annan turnering på samma kod
  // nyare version vinner; lika version: den med högst avsändar-id, så att alla hamnar på samma
  if (t && t.id === s.id && (s.ver < t.ver || (s.ver === t.ver && String(m.from) <= CID))) return;
  s.room = tourRoom.code; tourRoom.waiting = false;
  tourState.s = s; tourSave();
  if (tourOnPage()) render();
  tourAutoLog();
}
// en ändring här: ny version, skicka till de andra och rita om
function tourCommit() {
  const t = tourState.s;
  if (t) { t.ver++; if (t.room) tourSend({ t: 'state', s: tourPublic(t) }); }
  tourSave(); render(); tourAutoLog();
}

// ---------- färdiga matcher till spelloggen ----------
function tourLogged() { try { return new Set(JSON.parse(localStorage.getItem(TOUR_LOGGED)) || []); } catch { return new Set(); } }
function tourMarkLogged(set) { try { localStorage.setItem(TOUR_LOGGED, JSON.stringify([...set].slice(-500))); } catch {} }
// en runda räknas som klar när nästa är parad, eller när sista rundan har alla resultat
function tourDoneMatches(t) {
  const cur = t.pairs.length - 1, curDone = t.pairs[cur].every(p => p.res), last = cur + 1 >= t.rounds, out = [];
  t.pairs.forEach((r, ri) => { if (ri === cur && !(curDone && last)) return; r.forEach((p, i) => { if (p.b !== -1 && p.res) out.push({ p, mid: 'tur-' + t.id + ri + i }); }); });
  return out;
}
async function tourAutoLog() {
  const t = tourState();
  if (!t || tourAutoLog.busy || S.offline || (S.cloud && !S.v12)) return;
  const me = S.profile?.id, myName = (S.profile?.name || '').trim();
  const logged = tourLogged();
  const todo = tourDoneMatches(t).filter(x => !logged.has(x.mid)).map(x => ({ ...x, mine: [x.p.a, x.p.b].find(k => (S.cloud ? me && t.uids[k] === me : myName && t.players[k] === myName)) })).filter(x => x.mine != null);
  if (!todo.length) return;
  tourAutoLog.busy = true;
  let ok = 0, theirs = 0, err = '';
  try {
    for (const { p, mid, mine } of todo) {
      const [x, y, dr = 0] = p.res.split('-').map(Number), winner = x > y ? p.a : y > x ? p.b : null, opp = mine === p.a ? p.b : p.a;
      const score = [Math.max(x, y), Math.min(x, y), ...(dr ? [dr] : [])].join('-');
      try {
        const g = await api('/api/games', { method: 'POST', body: { deck_name: 'Ingen lek vald', result: winner == null ? 'draw' : winner === mine ? 'win' : 'loss', players: 2, opponents: t.players[opp],
          notes: `Turnering: ${winner == null ? 'oavgjort' : t.players[winner] + ' vann'} ${score.replace(/-/g, '–')}`, match_id: S.cloud ? mid : undefined } });
        S.games = [g, ...(S.games || []).filter(z => z.id !== g.id)];
        logged.add(mid); ok++;
        if (S.cloud && t.uids[opp]) {
          try { theirs += await api('/api/match-log', { method: 'POST', body: { match: mid, players: [t.uids[p.a], t.uids[p.b]], winner: winner == null ? null : winner === p.a ? 0 : 1, minutes: 0, score } }) || 0; }
          catch (e) { err = e.message; }
        }
      } catch (e) { err = e.message; }
    }
  } finally { tourMarkLogged(logged); tourAutoLog.busy = false; }
  if (ok) toast(`${ok === 1 ? 'Turneringsmatchen' : ok + ' turneringsmatcher'} sparad${ok === 1 ? '' : 'e'} i din spellogg${theirs ? ' och hos motståndaren' : ''}`, 3500);
  if (err) toast('Kunde inte spara allt i spelloggen: ' + err, 4500);
}

function tabTour(el) {
  const t = tourState();
  if (t?.room && !tourRoom.ch) tourConnect(t.room);
  const live = !!window.LV_CHANNEL;
  if (!t && tourRoom.waiting) {
    el.innerHTML = `<div class="card" style="max-width:560px"><h2 style="margin-top:0">Väntar på turneringen…</h2>
      <p class="small">Kod <code>${esc(tourRoom.code)}</code>. Turneringen dyker upp här så fort telefonen som delar den är online.</p>
      <p class="row"><span class="spacer"></span><button class="btn" id="tCancel">Avbryt</button></p></div>`;
    $('#tCancel').onclick = () => { tourDisconnect(); render(); };
    return;
  }
  if (!t) {
    const known = (S.users || []).map(u => u.name).filter(Boolean);
    el.innerHTML = `<div class="card" style="max-width:560px"><h2 style="margin-top:0">Ny turnering</h2>
      <p class="small">Swiss, bäst av tre. Vinst = 3 poäng, oavgjort = 1. Ingen möter samma person två gånger, och bye går till den längst ner som inte haft det.</p>
      <label class="small">Spelare, en per rad<br><textarea id="tNames" rows="8" style="width:100%"></textarea></label>
      ${known.length ? `<div class="row small" style="flex-wrap:wrap;gap:.3rem">Lägg till: ${known.map(n => `<button class="btn small" data-tadd="${esc(n)}">${esc(n)}</button>`).join('')}</div>` : ''}
      <p class="row"><span class="spacer"></span><button class="btn primary" id="tMake">Para runda 1</button></p></div>
      ${live ? `<div class="card" style="max-width:560px;margin-top:1rem"><h2 style="margin-top:0">Följ en delad turnering</h2>
      <div class="row"><input type="text" id="tCode" maxlength="6" placeholder="Kod, t.ex. K7Q2XM" style="text-transform:uppercase;width:9rem"><button class="btn" id="tJoin">Följ</button></div></div>` : ''}`;
    el.onclick = e => {
      const b = e.target.closest('[data-tadd]'); if (!b) return;
      const ta = $('#tNames'), have = ta.value.split('\n').map(x => x.trim()).filter(Boolean);
      if (!have.includes(b.dataset.tadd)) ta.value = [...have, b.dataset.tadd].join('\n');
    };
    $('#tMake').onclick = () => {
      const names = [...new Set($('#tNames').value.split('\n').map(x => tClip(x.trim(), 20)).filter(Boolean))];
      if (names.length < 2) return toast('Minst två spelare');
      if (names.length > 16) return toast('Högst 16 spelare');
      tourState.s = newTour(names); tourCommit();
    };
    if ($('#tJoin')) {
      $('#tJoin').onclick = () => {
        const code = $('#tCode').value.trim().toUpperCase();
        if (!/^[A-Z0-9]{6}$/.test(code)) return toast('Koden har sex tecken');
        tourRoom.waiting = true; tourConnect(code); tourRoom.waiting = true; render();
      };
      $('#tCode').onkeydown = e => { if (e.key === 'Enter') $('#tJoin').click(); };
    }
    return;
  }
  const cur = t.pairs.length - 1, done = t.pairs[cur].every(p => p.res), last = cur + 1 >= t.rounds, table = standings(t);
  const resBtns = (r, i, p) => ['2-0', '2-1', '1-1', '1-2', '0-2'].map(x => `<button class="btn small ${p.res === x ? 'primary' : ''}" data-r="${r}" data-i="${i}" data-res="${x}">${x.replace('-', '–')}</button>`).join('');
  const acct = k => (S.cloud && t.uids[k] ? ' <span class="muted small" title="Har konto – matchen sparas i spelloggen">✓</span>' : '');
  const shareBar = !live ? '' : t.room
    ? `<div class="row small tour-live"><span>📡 Delas live, kod <code style="font-size:1rem;letter-spacing:.05em">${esc(t.room)}</code>. De andra väljer <b>Följ en delad turnering</b> och skriver koden.</span><span class="spacer"></span><button class="btn small" id="tUnshare">Sluta dela</button></div>`
    : `<div class="row small tour-live"><span class="muted">Visa turneringen i allas telefoner – alla kan fylla i resultat.</span><span class="spacer"></span><button class="btn small" id="tShare">📡 Dela live</button></div>`;
  el.innerHTML = `${shareBar}<div class="card"><div class="row"><h2 style="margin:0">Runda ${cur + 1} av ${t.rounds}</h2><span class="spacer"></span><button class="btn small" id="tRounds">Antal rundor</button></div>
      <ul class="dlist dpairs">${t.pairs[cur].map((p, i) => p.b === -1 ? `<li class="row"><b>${esc(t.players[p.a])}</b><span class="muted">har bye (räknas som 2–0)</span></li>`
        : `<li><div class="row"><b>${esc(t.players[p.a])}</b>${acct(p.a)}<span class="muted">mot</span><b>${esc(t.players[p.b])}</b>${acct(p.b)}<span class="spacer"></span><button class="btn small" data-life="${i}" title="Livräknare med 20 liv">❤ Liv</button></div>
          <div class="row" style="margin-top:.3rem">${resBtns(cur, i, p)}${p.res ? `<button class="btn small" data-r="${cur}" data-i="${i}" data-res="">Ångra</button>` : ''}</div></li>`).join('')}</ul>
      ${done ? (last ? '<p><b>Turneringen är klar! 🏆</b></p><p class="row"><button class="btn small" id="tExtra">Spela en runda till</button></p>' : `<p class="row"><span class="spacer"></span><button class="btn primary" id="tNextR">Para runda ${cur + 2}</button></p>`) : '<p class="muted small">Tryck resultatet ur den förstas perspektiv, t.ex. 2–1 = den första vann två partier mot ett.</p>'}
      ${S.cloud && S.v12 ? '<p class="muted small">✓ = har konto. När en runda är klar sparas matcherna i spelloggen och topplistan hos dem.</p>' : ''}</div>
    <div class="card" style="margin-top:1rem"><h2 style="margin-top:0">Tabell</h2>
      <table class="dstand"><thead><tr><th>#</th><th>Spelare</th><th>P</th><th>V-F-O</th><th title="Motståndarnas matchvinst-%">OMW</th><th title="Egen partivinst-%">GW</th><th title="Motståndarnas partivinst-%">OGW</th></tr></thead>
      <tbody>${table.map((p, k) => `<tr class="${k === 0 && done && last ? 'win' : ''}"><td>${k + 1}</td><td>${esc(p.name)}</td><td><b>${p.mp}</b></td><td>${p.w}-${p.l}-${p.d}</td><td>${(p.omw * 100).toFixed(0)}%</td><td>${(p.gw * 100).toFixed(0)}%</td><td>${(p.ogw * 100).toFixed(0)}%</td></tr>`).join('')}</tbody></table>
      <p class="muted small">Delas lika: OMW, sedan GW, sedan OGW (som i riktiga turneringar, golv 33 %).</p>
      <p class="row"><span class="spacer"></span><button class="btn small danger" id="tEnd">${t.room ? 'Ta bort här' : 'Ta bort turneringen'}</button></p></div>`;
  el.onclick = e => {
    const b = e.target.closest('[data-res],[data-life]'); if (!b) return;
    if (b.dataset.life != null) {
      const p = t.pairs[cur][+b.dataset.life], ls = lifeState();
      if (ls?.players && !confirm('En match pågår redan i livräknaren. Starta en ny?')) return;
      if (ls?.room) roomLeave();
      lifeState.s = { setup: { n: 2, life: 20, names: [t.players[p.a], t.players[p.b], '', '', '', ''], deck: '', share: false } }; saveLife();
      location.hash = '#/liv'; return;
    }
    if (setResult(t, +b.dataset.r, +b.dataset.i, b.dataset.res || null)) tourCommit();
  };
  const next = () => { t.pairs.push(pairUp(t, standings(t).map(p => p.i))); tourCommit(); };
  if ($('#tNextR')) $('#tNextR').onclick = next;
  if ($('#tExtra')) $('#tExtra').onclick = () => { t.rounds++; next(); };
  if ($('#tShare')) $('#tShare').onclick = () => { t.room = roomCode(); tourConnect(t.room); tourCommit(); };
  if ($('#tUnshare')) $('#tUnshare').onclick = () => { t.room = ''; tourDisconnect(); tourSave(); render(); };
  $('#tRounds').onclick = () => { const v = prompt('Antal rundor', t.rounds); if (v && +v >= t.pairs.length && +v <= 8) { t.rounds = +v; tourCommit(); } };
  $('#tEnd').onclick = () => {
    if (!confirm(t.room ? 'Ta bort turneringen från den här telefonen? De andra behåller sin.' : 'Ta bort turneringen och alla resultat?')) return;
    tourDisconnect(); tourState.s = null; tourSave(); render();
  };
  tourAutoLog();
}
