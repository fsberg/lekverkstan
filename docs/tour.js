// Lekverkstan – turnering under Spela: Swiss, bäst av tre. Sparas på enheten (localStorage lv-tour).
'use strict';
const TOUR_KEY = 'lv-tour';
function tourState() {
  if (tourState.s !== undefined) return tourState.s;
  let t = null;
  try { t = JSON.parse(localStorage.getItem(TOUR_KEY)); } catch {}
  // en turnering som startades under den gamla Draft-fliken flyttas hit
  if (!t) { try { t = JSON.parse(localStorage.getItem('lv-draft'))?.tour || null; } catch {} }
  tourState.s = cleanTour(t);
  return tourState.s;
}
function tourSave() { try { localStorage.setItem(TOUR_KEY, JSON.stringify(tourState.s)); } catch {} }
const tClip = (v, n) => String(v ?? '').replace(/[<>]/g, '').slice(0, n);

// tour = { players: [namn], rounds, pairs: [[{ a, b, res: '2-1' | null }]] }  b = -1 betyder bye
function cleanTour(t) {
  if (!t || !Array.isArray(t.players) || t.players.length < 2) return null;
  const players = t.players.slice(0, 16).map(x => tClip(x, 20));
  const n = players.length;
  const pairs = (Array.isArray(t.pairs) ? t.pairs : []).slice(0, 8).map(r => (Array.isArray(r) ? r : []).slice(0, 8).map(p => ({ a: num(p?.a, 0, n - 1), b: p?.b === -1 ? -1 : num(p?.b, 0, n - 1), res: /^[0-3]-[0-3](-[0-3])?$/.test(p?.res) ? p.res : null })));
  if (!pairs.length) return null;
  return { players, rounds: num(t.rounds, 1, 8, 3), pairs };
}
function newTour(names) {
  const n = names.length, t = { players: names.slice(), rounds: n <= 2 ? 1 : n <= 4 ? 2 : n <= 8 ? 3 : 4, pairs: [] };
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

function tabTour(el) {
  const t = tourState();
  if (!t) {
    const known = (S.users || []).map(u => u.name).filter(Boolean);
    el.innerHTML = `<div class="card" style="max-width:560px"><h2 style="margin-top:0">Ny turnering</h2>
      <p class="small">Swiss, bäst av tre. Vinst = 3 poäng, oavgjort = 1. Ingen möter samma person två gånger, och bye går till den längst ner som inte haft det.</p>
      <label class="small">Spelare, en per rad<br><textarea id="tNames" rows="8" style="width:100%"></textarea></label>
      ${known.length ? `<div class="row small" style="flex-wrap:wrap;gap:.3rem">Lägg till: ${known.map(n => `<button class="btn small" data-tadd="${esc(n)}">${esc(n)}</button>`).join('')}</div>` : ''}
      <p class="row"><span class="spacer"></span><button class="btn primary" id="tMake">Para runda 1</button></p></div>`;
    el.onclick = e => {
      const b = e.target.closest('[data-tadd]'); if (!b) return;
      const ta = $('#tNames'), have = ta.value.split('\n').map(x => x.trim()).filter(Boolean);
      if (!have.includes(b.dataset.tadd)) ta.value = [...have, b.dataset.tadd].join('\n');
    };
    $('#tMake').onclick = () => {
      const names = [...new Set($('#tNames').value.split('\n').map(x => tClip(x.trim(), 20)).filter(Boolean))];
      if (names.length < 2) return toast('Minst två spelare');
      if (names.length > 16) return toast('Högst 16 spelare');
      tourState.s = newTour(names); tourSave(); render();
    };
    return;
  }
  const cur = t.pairs.length - 1, done = t.pairs[cur].every(p => p.res), last = cur + 1 >= t.rounds, table = standings(t);
  const resBtns = (r, i, p) => ['2-0', '2-1', '1-1', '1-2', '0-2'].map(x => `<button class="btn small ${p.res === x ? 'primary' : ''}" data-r="${r}" data-i="${i}" data-res="${x}">${x.replace('-', '–')}</button>`).join('');
  el.innerHTML = `<div class="card"><div class="row"><h2 style="margin:0">Runda ${cur + 1} av ${t.rounds}</h2><span class="spacer"></span><button class="btn small" id="tRounds">Antal rundor</button></div>
      <ul class="dlist dpairs">${t.pairs[cur].map((p, i) => p.b === -1 ? `<li class="row"><b>${esc(t.players[p.a])}</b><span class="muted">har bye (räknas som 2–0)</span></li>`
        : `<li><div class="row"><b>${esc(t.players[p.a])}</b><span class="muted">mot</span><b>${esc(t.players[p.b])}</b><span class="spacer"></span><button class="btn small" data-life="${i}" title="Livräknare med 20 liv">❤ Liv</button></div>
          <div class="row" style="margin-top:.3rem">${resBtns(cur, i, p)}${p.res ? `<button class="btn small" data-r="${cur}" data-i="${i}" data-res="">Ångra</button>` : ''}</div></li>`).join('')}</ul>
      ${done ? (last ? '<p><b>Turneringen är klar! 🏆</b></p><p class="row"><button class="btn small" id="tExtra">Spela en runda till</button></p>' : `<p class="row"><span class="spacer"></span><button class="btn primary" id="tNextR">Para runda ${cur + 2}</button></p>`) : '<p class="muted small">Tryck resultatet ur den förstas perspektiv, t.ex. 2–1 = den första vann två partier mot ett.</p>'}</div>
    <div class="card" style="margin-top:1rem"><h2 style="margin-top:0">Tabell</h2>
      <table class="dstand"><thead><tr><th>#</th><th>Spelare</th><th>P</th><th>V-F-O</th><th title="Motståndarnas matchvinst-%">OMW</th><th title="Egen partivinst-%">GW</th><th title="Motståndarnas partivinst-%">OGW</th></tr></thead>
      <tbody>${table.map((p, k) => `<tr class="${k === 0 && done && last ? 'win' : ''}"><td>${k + 1}</td><td>${esc(p.name)}</td><td><b>${p.mp}</b></td><td>${p.w}-${p.l}-${p.d}</td><td>${(p.omw * 100).toFixed(0)}%</td><td>${(p.gw * 100).toFixed(0)}%</td><td>${(p.ogw * 100).toFixed(0)}%</td></tr>`).join('')}</tbody></table>
      <p class="muted small">Delas lika: OMW, sedan GW, sedan OGW (som i riktiga turneringar, golv 33 %).</p>
      <p class="row"><span class="spacer"></span><button class="btn small danger" id="tEnd">Ta bort turneringen</button></p></div>`;
  el.onclick = e => {
    const b = e.target.closest('[data-res],[data-life]'); if (!b) return;
    if (b.dataset.life != null) {
      const p = t.pairs[cur][+b.dataset.life], ls = lifeState();
      if (ls?.players && !confirm('En match pågår redan i livräknaren. Starta en ny?')) return;
      if (ls?.room) roomLeave();
      lifeState.s = { setup: { n: 2, life: 20, names: [t.players[p.a], t.players[p.b], '', '', '', ''], deck: '', share: false } }; saveLife();
      location.hash = '#/liv'; return;
    }
    if (setResult(t, +b.dataset.r, +b.dataset.i, b.dataset.res || null)) { tourSave(); render(); }
  };
  const next = () => { t.pairs.push(pairUp(t, standings(t).map(p => p.i))); tourSave(); render(); };
  if ($('#tNextR')) $('#tNextR').onclick = next;
  if ($('#tExtra')) $('#tExtra').onclick = () => { t.rounds++; next(); };
  $('#tRounds').onclick = () => { const v = prompt('Antal rundor', t.rounds); if (v && +v >= t.pairs.length && +v <= 8) { t.rounds = +v; tourSave(); render(); } };
  $('#tEnd').onclick = () => { if (!confirm('Ta bort turneringen och alla resultat?')) return; tourState.s = null; tourSave(); render(); };
}
