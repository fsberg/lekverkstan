// Molnläge för Lekverkstan (GitHub Pages + Supabase).
// Körs appen från den lokala servern (port 8793 eller tunneln) används server.js som förut.
// Annars ersätts appens api()-anrop med Supabase och Scryfall direkt från webbläsaren.
'use strict';
(function () {
  const C = window.LV_CONFIG || {};
  const local = location.port === '8793' || location.hostname.endsWith('trycloudflare.com');
  if (local || !C.SUPABASE_URL) return;

  let sb, user;
  let v2 = false, v4 = false;
  const colQty = {}; // egna antal, för att veta när ett kort läggs till (sortering på senast inlagt)
  let tradeMap = {}; // egna bytesantal, så att antal aldrig sänks under det som är till byte
  const SM_DEFAULT = 'https://www.svenskamagic.com/kortparmen/index.php?action=search&s_name={q}&tokens=1&special=1&basicland=1&order=name&group=1&n=1';
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };

  // ---------- Scryfall direkt (tillåter anrop från webbläsare) ----------
  let lastScry = 0;
  async function scry(url, opts) {
    const wait = lastScry + 110 - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastScry = Date.now();
    const r = await fetch(url, { ...opts, headers: { Accept: 'application/json', ...(opts?.headers || {}) } });
    if (!r.ok && r.status !== 404) throw new Error(`${r.status} från Scryfall`);
    return { status: r.status, body: await r.json() };
  }
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
      image: img.normal || '', thumb: img.small || '',
      eur: c.prices?.eur ? Number(c.prices.eur) : (c.prices?.eur_foil ? Number(c.prices.eur_foil) : null),
      scryfall: c.scryfall_uri,
      any_number: /A deck can have any number of cards named/i.test(c.oracle_text || ''),
      commander_ok: /Legendary.*Creature/i.test(c.type_line || '') || /can be your commander/i.test(c.oracle_text || ''),
      eur_foil: c.prices?.eur_foil ? Number(c.prices.eur_foil) : null,
      id: c.id, set: c.set,
      game_changer: !!c.game_changer,
      v: 3,
    };
  }
  const slimPrint = c => ({
    id: c.id, set: c.set, set_name: c.set_name, cn: c.collector_number, released: c.released_at,
    eur: c.prices?.eur ? Number(c.prices.eur) : null, eur_foil: c.prices?.eur_foil ? Number(c.prices.eur_foil) : null,
    foil: (c.finishes || []).includes('foil') || (c.finishes || []).includes('etched'), nonfoil: (c.finishes || []).includes('nonfoil'),
    thumb: (c.image_uris || c.card_faces?.[0]?.image_uris || {}).small || '',
    extra: [c.border_color === 'borderless' && 'borderless', c.full_art && 'full art', ...(c.frame_effects || []).filter(f => ['showcase', 'extendedart', 'etched', 'inverted'].includes(f))].filter(Boolean),
  });
  const cleanPrints = a => (Array.isArray(a) ? a : []).slice(0, 30).filter(p => p && p.qty > 0).map(p => ({
    id: /^[0-9a-f-]{36}$/.test(p.id) ? p.id : null, set: String(p.set || '').slice(0, 10), cn: String(p.cn || '').slice(0, 12),
    foil: !!p.foil, qty: Math.min(999, p.qty | 0), eur: typeof p.eur === 'number' ? p.eur : null,
  }));
  const cardCache = ls.get('lv-cards', {});
  function remember(s) {
    cardCache[s.name.toLowerCase()] = s;
    if (s.name.includes(' // ')) cardCache[s.name.split(' // ')[0].toLowerCase()] = s;
  }
  function persistCards() {
    const keys = Object.keys(cardCache);
    if (keys.length > 4000) for (const k of keys.slice(0, keys.length - 4000)) delete cardCache[k];
    ls.set('lv-cards', cardCache);
  }
  async function lookupCards(names) {
    const want = [...new Set(names.map(n => n.trim()).filter(Boolean))];
    // v3: billigaste utgåvan (prefer:eur-low), så att dyra specialutgåvor inte blåser upp värdet
    const missing = want.filter(n => cardCache[n.toLowerCase()]?.v !== 3);
    const notFound = [], rest = [];
    for (let i = 0; i < missing.length; i += 25) {
      const part = missing.slice(i, i + 25);
      const q = '(' + part.map(n => '!"' + n.replace(/"/g, '') + '"').join(' or ') + ') prefer:eur-low';
      const { status, body } = await scry('https://api.scryfall.com/cards/search?q=' + encodeURIComponent(q));
      const got = new Set();
      if (status !== 404) for (const c of body.data || []) {
        const hit = part.find(n => n.toLowerCase() === c.name.toLowerCase() || n.toLowerCase() === c.name.split(' // ')[0].toLowerCase());
        if (hit) { remember(slimCard(c)); got.add(hit); }
      }
      rest.push(...part.filter(n => !got.has(n)));
    }
    for (let i = 0; i < rest.length; i += 75) {
      const { body } = await scry('https://api.scryfall.com/cards/collection', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifiers: rest.slice(i, i + 75).map(name => ({ name })) }),
      });
      for (const c of body.data || []) remember(slimCard(c));
      for (const nf of body.not_found || []) notFound.push(nf.name);
    }
    if (missing.length) persistCards();
    const cards = {};
    for (const n of want) if (cardCache[n.toLowerCase()]) cards[n] = cardCache[n.toLowerCase()];
    return { cards, notFound };
  }

  // ---------- inloggning ----------
  function authScreen() {
    const el = document.createElement('div');
    el.className = 'auth';
    el.innerHTML = `
      <div class="card auth-box">
        <div class="brand" style="justify-content:center;font-size:1.3rem;margin-bottom:.8rem"><img src="icon.svg" alt=""> Lekverkstan</div>
        <div class="tabs" style="margin-top:0"><button data-m="in" class="on">Logga in</button><button data-m="up">Skapa konto</button></div>
        <form>
          <p><input type="email" name="email" placeholder="E-post" autocomplete="email" required style="width:100%"></p>
          <p><input type="password" name="pw" placeholder="Lösenord" autocomplete="current-password" required minlength="8" style="width:100%"></p>
          <p class="up-only" hidden><input type="text" name="invite" placeholder="Inbjudningskod, t.ex. A1B2-C3D4-E5F6" style="width:100%;text-transform:uppercase"></p>
          <p class="msg small" hidden></p>
          <p><button class="btn primary" style="width:100%" type="submit">Logga in</button></p>
          <p class="small" style="text-align:center"><a href="#" data-forgot>Glömt lösenordet?</a></p>
        </form>
      </div>`;
    document.body.appendChild(el);
    let mode = 'in';
    const f = el.querySelector('form'), msg = el.querySelector('.msg');
    const say = (t, bad) => { msg.textContent = t; msg.hidden = !t; msg.style.color = bad ? 'var(--bad)' : 'var(--good)'; };
    el.querySelectorAll('[data-m]').forEach(b => b.onclick = () => {
      mode = b.dataset.m;
      el.querySelectorAll('[data-m]').forEach(x => x.classList.toggle('on', x === b));
      el.querySelector('.up-only').hidden = mode !== 'up';
      f.invite.required = mode === 'up';
      f.pw.autocomplete = mode === 'up' ? 'new-password' : 'current-password';
      f.querySelector('[type=submit]').textContent = mode === 'up' ? 'Skapa konto' : 'Logga in';
      say('');
    });
    el.querySelector('[data-forgot]').onclick = async e => {
      e.preventDefault();
      if (!f.email.value) return say('Skriv din e-post först', true);
      const { error } = await sb.auth.resetPasswordForEmail(f.email.value, { redirectTo: location.origin + location.pathname });
      say(error ? error.message : 'Kolla mejlen efter en återställningslänk.', !!error);
    };
    return new Promise(resolve => {
      f.onsubmit = async e => {
        e.preventDefault();
        const btn = f.querySelector('[type=submit]'); btn.disabled = true; say('');
        try {
          const email = f.email.value.trim(), password = f.pw.value;
          let res;
          if (mode === 'up') {
            res = await sb.auth.signUp({ email, password, options: { data: { invite: f.invite.value.trim().toUpperCase() } } });
            if (res.error) throw res.error;
            if (!res.data.session) { say('Kontot är skapat. Bekräfta via mejlet och logga sedan in.'); return; }
          } else {
            res = await sb.auth.signInWithPassword({ email, password });
            if (res.error) throw res.error;
          }
          el.remove(); resolve(res.data.session.user);
        } catch (err) {
          const m = String(err.message || err);
          say(/invite|inbjudning|Database error/i.test(m) ? 'Ogiltig eller redan använd inbjudningskod.'
            : /Invalid login/i.test(m) ? 'Fel e-post eller lösenord.'
            : /already registered/i.test(m) ? 'Det finns redan ett konto med den e-posten.' : m, true);
        } finally { btn.disabled = false; }
      };
    });
  }

  async function newPasswordScreen() {
    const pw = prompt('Välj ett nytt lösenord (minst 8 tecken):');
    if (pw && pw.length >= 8) {
      const { error } = await sb.auth.updateUser({ password: pw });
      alert(error ? error.message : 'Lösenordet är bytt.');
    }
  }

  window.LV_READY = (async () => {
    const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm');
    sb = createClient(C.SUPABASE_URL, C.SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true } });
    sb.auth.onAuthStateChange(ev => { if (ev === 'PASSWORD_RECOVERY') newPasswordScreen(); });
    const { data } = await sb.auth.getSession();
    user = data.session?.user || await authScreen();
    // utloggningsknapp i menyn
    const nav = document.querySelector('.top nav');
    const a = document.createElement('a');
    a.href = '#'; a.textContent = 'Logga ut'; a.title = user.email;
    a.onclick = async e => { e.preventDefault(); await sb.auth.signOut(); location.reload(); };
    nav.appendChild(a);
  })();

  // ---------- appens api()-vägar mot Supabase ----------
  const fail = error => { if (error) throw new Error(error.message); };
  const deckOut = d => ({ ...d, created: Date.parse(d.created), updated: Date.parse(d.updated) });

  window.LV_BACKEND = async (path, opts = {}) => {
    const m = (opts.method || 'GET').toUpperCase();
    const body = opts.body || {};
    const url = new URL(path, location.origin);
    const p = url.pathname;

    if (p === '/api/state') {
      const [d, c] = await Promise.all([
        // bara egna rader – RLS släpper också igenom andras publika lekar och bytesrader
        sb.from('lv_decks').select('*').eq('owner', user.id).order('updated', { ascending: false }),
        sb.from('lv_collection').select('name, qty').eq('owner', user.id),
      ]);
      fail(d.error); fail(c.error);
      // v2-tabeller: saknas de (gammal databas) blir det bara tomt
      const [t, g, pr, w, l, cm] = await Promise.all([
        sb.from('lv_collection').select('name, for_trade').eq('owner', user.id).gt('for_trade', 0),
        sb.from('lv_games').select('*').order('played_on', { ascending: false }).order('created', { ascending: false }),
        sb.from('lv_profiles').select('display_name').eq('user_id', user.id).maybeSingle(),
        // v3-tabeller
        sb.from('lv_wishlist').select('*').order('created'),
        sb.from('lv_loans').select('*').order('lent_on', { ascending: false }),
        // v4: datum och utgåvor
        sb.from('lv_collection').select('name, added, prints').eq('owner', user.id),
      ]);
      v4 = !cm.error;
      for (const k of Object.keys(colQty)) delete colQty[k];
      for (const r of c.data) colQty[r.name] = r.qty;
      return {
        decks: d.data.map(deckOut),
        collection: Object.fromEntries(c.data.map(r => [r.name, r.qty])),
        trade: (v2 = !t.error, tradeMap = t.error ? {} : Object.fromEntries(t.data.map(r => [r.name, r.for_trade]))),
        games: g.error ? [] : g.data,
        wishlist: w.error ? [] : w.data.map(x => ({ ...x, max_price: x.max_price == null ? null : Number(x.max_price), last_price: x.last_price == null ? null : Number(x.last_price) })),
        loans: l.error ? [] : l.data,
        v3: !w.error, v4,
        colmeta: v4 ? Object.fromEntries(cm.data.map(r => [r.name, { added: Date.parse(r.added), prints: r.prints || [] }])) : {},
        profile: { name: pr.data?.display_name || '', email: user.email },
        cloud: true,
        settings: { svenskaMagicUrl: ls.get('lv-sm-url', SM_DEFAULT) },
      };
    }
    if (p === '/api/profile' && m === 'PUT') {
      const name = String(body.name || '').trim().slice(0, 40);
      fail((await sb.from('lv_profiles').upsert({ user_id: user.id, display_name: name })).error);
      return { name };
    }
    if (p === '/api/trade' && m === 'PUT') {
      for (const [name, n] of Object.entries(body)) {
        fail((await sb.from('lv_collection').update({ for_trade: Math.max(0, n | 0) }).eq('owner', user.id).eq('name', name)).error);
        if (n > 0) tradeMap[name] = n | 0; else delete tradeMap[name];
      }
      return {};
    }
    // andras publika lekar och bytesrader, med visningsnamn
    async function names(ids) {
      if (!ids.length) return {};
      const { data } = await sb.from('lv_profiles').select('user_id, display_name').in('user_id', [...new Set(ids)]);
      return Object.fromEntries((data || []).map(r => [r.user_id, r.display_name]));
    }
    if (p === '/api/public-decks') {
      const { data, error } = await sb.from('lv_decks').select('id, owner, name, format, cards, notes, updated').eq('public', true).neq('owner', user.id).order('updated', { ascending: false }).limit(200);
      fail(error);
      const nm = await names(data.map(x => x.owner));
      return data.map(x => ({ ...deckOut(x), ownerName: nm[x.owner] || 'Okänd' }));
    }
    if (p === '/api/trades') {
      const { data, error } = await sb.from('lv_collection').select('owner, name, for_trade' + (v4 ? ', prints' : '')).gt('for_trade', 0).neq('owner', user.id).limit(2000);
      fail(error);
      const nm = await names(data.map(x => x.owner));
      return data.map(x => ({ name: x.name, qty: x.for_trade, owner: x.owner, ownerName: nm[x.owner] || 'Okänd', prints: x.prints || [] }));
    }
    // bokningar i bytesbörsen (v4): mina förfrågningar och förfrågningar på mina kort
    if (p === '/api/bookings' && m === 'GET') {
      if (!v4) return [];
      const { data, error } = await sb.from('lv_bookings').select('*').order('created', { ascending: false }).limit(300);
      fail(error);
      const nm = await names(data.map(x => (x.seller === user.id ? x.requester : x.seller)));
      return data.map(x => ({ ...x, mine: x.requester === user.id, other: nm[x.seller === user.id ? x.requester : x.seller] || 'Okänd' }));
    }
    if (p === '/api/bookings' && m === 'POST') {
      const { data, error } = await sb.from('lv_bookings').insert({
        seller: body.seller, name: String(body.name || '').slice(0, 150), qty: Math.max(1, Math.min(99, body.qty | 0 || 1)), note: String(body.note || '').slice(0, 300),
      }).select().single();
      if (error && /row-level security/i.test(error.message)) throw new Error('Kortet finns inte längre till byte');
      fail(error); return { ...data, mine: true };
    }
    const bm = p.match(/^\/api\/bookings\/([\w-]+)$/);
    if (bm && m === 'PUT') {
      const patch = { updated: new Date().toISOString() };
      if (['requested', 'accepted', 'declined', 'done', 'cancelled'].includes(body.status)) patch.status = body.status;
      if (typeof body.reply === 'string') patch.reply = body.reply.slice(0, 300);
      const { data, error } = await sb.from('lv_bookings').update(patch).eq('id', bm[1]).select().single();
      fail(error); return data;
    }
    if (bm && m === 'DELETE') { fail((await sb.from('lv_bookings').delete().eq('id', bm[1])).error); return { ok: true }; }
    if (p === '/api/games' && m === 'POST') {
      const row = {
        deck_id: body.deck_id || null, deck_name: String(body.deck_name || 'Okänd lek').slice(0, 80),
        played_on: body.played_on || undefined, result: ['win', 'loss', 'draw'].includes(body.result) ? body.result : 'loss',
        players: Math.max(2, Math.min(10, body.players | 0 || 2)), opponents: String(body.opponents || '').slice(0, 300), notes: String(body.notes || '').slice(0, 1000),
      };
      const { data, error } = await sb.from('lv_games').insert(row).select().single();
      fail(error); return data;
    }
    const gm = p.match(/^\/api\/games\/([\w-]+)$/);
    if (gm && m === 'DELETE') { fail((await sb.from('lv_games').delete().eq('id', gm[1])).error); return { ok: true }; }
    if (p === '/api/wishlist' && m === 'PUT') {
      const row = { owner: user.id, name: String(body.name || '').slice(0, 150) };
      for (const k of ['qty', 'max_price', 'last_price', 'in_stock', 'checked_at', 'alert', 'note']) if (k in body) row[k] = body[k];
      const { data, error } = await sb.from('lv_wishlist').upsert(row).select().single();
      fail(error); return data;
    }
    if (p === '/api/wishlist' && m === 'DELETE') { fail((await sb.from('lv_wishlist').delete().eq('owner', user.id).eq('name', url.searchParams.get('name'))).error); return { ok: true }; }
    if (p === '/api/loans' && m === 'POST') {
      const { data, error } = await sb.from('lv_loans').insert({
        name: String(body.name || '').slice(0, 150), qty: Math.max(1, Math.min(99, body.qty | 0 || 1)), borrower: String(body.borrower || '').trim().slice(0, 60),
        lent_on: body.lent_on || undefined, note: String(body.note || '').slice(0, 200),
      }).select().single();
      fail(error); return data;
    }
    const lm = p.match(/^\/api\/loans\/([\w-]+)$/);
    if (lm && m === 'DELETE') { fail((await sb.from('lv_loans').delete().eq('id', lm[1])).error); return { ok: true }; }
    if (p === '/api/decks' && m === 'POST') {
      const { data, error } = await sb.from('lv_decks').insert({
        name: String(body.name || 'Ny lek').slice(0, 80), format: body.format === 'modern' ? 'modern' : 'commander',
      }).select().single();
      fail(error); return deckOut(data);
    }
    const dm = p.match(/^\/api\/decks\/([\w-]+)$/);
    if (dm && m === 'PUT') {
      const patch = {};
      if (typeof body.name === 'string') patch.name = body.name.slice(0, 80) || 'Ny lek';
      if (body.format === 'modern' || body.format === 'commander') patch.format = body.format;
      if (typeof body.notes === 'string') patch.notes = body.notes.slice(0, 5000);
      if (typeof body.public === 'boolean') patch.public = body.public;
      if (Array.isArray(body.versions)) patch.versions = body.versions.slice(0, 20);
      if (Array.isArray(body.cards)) patch.cards = body.cards.filter(c => c && c.name).map(c => ({
        name: String(c.name).slice(0, 150), qty: Math.max(1, Math.min(99, c.qty | 0 || 1)),
        board: ['main', 'side', 'maybe', 'commander'].includes(c.board) ? c.board : 'main',
        ...(typeof c.cat === 'string' && c.cat ? { cat: c.cat.slice(0, 30) } : {}),
      }));
      const { data, error } = await sb.from('lv_decks').update(patch).eq('id', dm[1]).select().single();
      fail(error); return deckOut(data);
    }
    if (dm && m === 'DELETE') { const { error } = await sb.from('lv_decks').delete().eq('id', dm[1]); fail(error); return { ok: true }; }

    if (p === '/api/collection' && m === 'PUT') {
      const up = [], del = [];
      for (const [name, qty] of Object.entries(body)) {
        const n = Math.max(0, Math.min(999, qty | 0));
        if (n) up.push({ owner: user.id, name: name.slice(0, 150), qty: n, ...(v2 ? { for_trade: Math.min(tradeMap[name] || 0, n) } : {}), ...(v4 && n > (colQty[name] || 0) ? { added: new Date().toISOString() } : {}) });
        else del.push(name);
        if (n) colQty[name] = n; else delete colQty[name];
        if (tradeMap[name]) { if (n) tradeMap[name] = Math.min(tradeMap[name], n); else delete tradeMap[name]; }
      }
      if (up.length) fail((await sb.from('lv_collection').upsert(up)).error);
      if (del.length) fail((await sb.from('lv_collection').delete().eq('owner', user.id).in('name', del)).error);
      return {};
    }
    if (p === '/api/prints' && m === 'PUT') {
      if (!v4) throw new Error('Utgåvor kräver databasuppdateringen v4');
      const prints = cleanPrints(body.prints);
      fail((await sb.from('lv_collection').update({ prints }).eq('owner', user.id).eq('name', String(body.name || ''))).error);
      return { prints };
    }
    if (p === '/api/prints' && m === 'GET') {
      const name = url.searchParams.get('name') || '';
      const { status, body: b } = await scry('https://api.scryfall.com/cards/search?unique=prints&order=released&q=' + encodeURIComponent('!"' + name.replace(/"/g, '') + '"'));
      if (status === 404) return [];
      return (b.data || []).filter(c => c.name.toLowerCase() === name.toLowerCase() || c.name.split(' // ')[0].toLowerCase() === name.toLowerCase()).map(slimPrint);
    }
    if (p === '/api/prices' && m === 'POST') {
      const out = {}, ids = [...new Set(body.ids || [])].filter(x => /^[0-9a-f-]{36}$/.test(x)).slice(0, 600);
      for (let i = 0; i < ids.length; i += 75) {
        const { body: b } = await scry('https://api.scryfall.com/cards/collection', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifiers: ids.slice(i, i + 75).map(id => ({ id })) }),
        });
        for (const c of b.data || []) out[c.id] = { eur: c.prices?.eur ? Number(c.prices.eur) : null, eur_foil: c.prices?.eur_foil ? Number(c.prices.eur_foil) : null };
      }
      return out;
    }
    if (p === '/api/settings' && m === 'PUT') {
      if (typeof body.svenskaMagicUrl === 'string') ls.set('lv-sm-url', body.svenskaMagicUrl.slice(0, 300) || SM_DEFAULT);
      return { svenskaMagicUrl: ls.get('lv-sm-url', SM_DEFAULT) };
    }

    if (p === '/api/cards') return lookupCards(Array.isArray(body.names) ? body.names.slice(0, 400) : []);
    if (p === '/api/search') {
      const { status, body: b } = await scry('https://api.scryfall.com/cards/search?order=edhrec&q=' + encodeURIComponent((url.searchParams.get('q') || '') + ' prefer:eur-low'));
      if (status === 404) return { cards: [], total: 0 };
      const cards = (b.data || []).slice(0, 60).map(slimCard);
      cards.forEach(remember); persistCards();
      return { cards, total: b.total_cards || cards.length };
    }
    if (p === '/api/autocomplete') {
      const { body: b } = await scry('https://api.scryfall.com/cards/autocomplete?q=' + encodeURIComponent(url.searchParams.get('q') || ''));
      return b.data || [];
    }
    if (p === '/api/fuzzy') {
      const { status, body: b } = await scry('https://api.scryfall.com/cards/named?fuzzy=' + encodeURIComponent(url.searchParams.get('q') || ''));
      if (status === 404) return { notFound: true };
      const { cards } = await lookupCards([b.name]);
      return { ...(cards[b.name] || slimCard(b)), print: slimPrint(b) };
    }
    async function extern(payload) {
      const { data, error } = await sb.functions.invoke('extern', { body: payload });
      if (error) {
        let msg = error.message;
        try { msg = (await error.context.json()).error || msg; } catch {}
        throw new Error(msg);
      }
      return data;
    }
    if (p === '/api/combos') return extern({ action: 'combos', commanders: body.commanders, main: body.main });
    if (p === '/api/archidekt') return extern({ action: 'archidekt', id: url.searchParams.get('id') });
    if (p === '/api/alara') {
      const { data, error } = await sb.functions.invoke('alara', { body: { name: url.searchParams.get('name'), fresh: url.searchParams.get('fresh') === '1' } });
      if (error) {
        let msg = error.message;
        try { msg = (await error.context.json()).error || msg; } catch {}
        throw new Error(msg);
      }
      return data;
    }
    throw new Error('okänd väg ' + p);
  };
})();
