// Molnläge för Lekverkstan (GitHub Pages + Supabase).
// Körs appen från den lokala servern (port 8793 eller tunneln) används server.js som förut.
// Annars ersätts appens api()-anrop med Supabase och Scryfall direkt från webbläsaren.
'use strict';
(function () {
  const C = window.LV_CONFIG || {};
  const local = location.port === '8793' || location.hostname.endsWith('trycloudflare.com');
  if (local || !C.SUPABASE_URL) return;

  let sb, user;
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
    };
  }
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
    const missing = want.filter(n => !cardCache[n.toLowerCase()]);
    const notFound = [];
    for (let i = 0; i < missing.length; i += 75) {
      const { body } = await scry('https://api.scryfall.com/cards/collection', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifiers: missing.slice(i, i + 75).map(name => ({ name })) }),
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
      return {
        decks: d.data.map(deckOut),
        collection: Object.fromEntries(c.data.map(r => [r.name, r.qty])),
        settings: { svenskaMagicUrl: ls.get('lv-sm-url', SM_DEFAULT) },
      };
    }
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
      if (Array.isArray(body.cards)) patch.cards = body.cards.filter(c => c && c.name).map(c => ({
        name: String(c.name).slice(0, 150), qty: Math.max(1, Math.min(99, c.qty | 0 || 1)),
        board: ['main', 'side', 'maybe', 'commander'].includes(c.board) ? c.board : 'main',
      }));
      const { data, error } = await sb.from('lv_decks').update(patch).eq('id', dm[1]).select().single();
      fail(error); return deckOut(data);
    }
    if (dm && m === 'DELETE') { const { error } = await sb.from('lv_decks').delete().eq('id', dm[1]); fail(error); return { ok: true }; }

    if (p === '/api/collection' && m === 'PUT') {
      const up = [], del = [];
      for (const [name, qty] of Object.entries(body)) {
        const n = Math.max(0, Math.min(999, qty | 0));
        if (n) up.push({ owner: user.id, name: name.slice(0, 150), qty: n }); else del.push(name);
      }
      if (up.length) fail((await sb.from('lv_collection').upsert(up)).error);
      if (del.length) fail((await sb.from('lv_collection').delete().eq('owner', user.id).in('name', del)).error);
      return {};
    }
    if (p === '/api/settings' && m === 'PUT') {
      if (typeof body.svenskaMagicUrl === 'string') ls.set('lv-sm-url', body.svenskaMagicUrl.slice(0, 300) || SM_DEFAULT);
      return { svenskaMagicUrl: ls.get('lv-sm-url', SM_DEFAULT) };
    }

    if (p === '/api/cards') return lookupCards(Array.isArray(body.names) ? body.names.slice(0, 400) : []);
    if (p === '/api/search') {
      const { status, body: b } = await scry('https://api.scryfall.com/cards/search?order=edhrec&q=' + encodeURIComponent(url.searchParams.get('q') || ''));
      if (status === 404) return { cards: [], total: 0 };
      const cards = (b.data || []).slice(0, 60).map(slimCard);
      cards.forEach(remember); persistCards();
      return { cards, total: b.total_cards || cards.length };
    }
    if (p === '/api/autocomplete') {
      const { body: b } = await scry('https://api.scryfall.com/cards/autocomplete?q=' + encodeURIComponent(url.searchParams.get('q') || ''));
      return b.data || [];
    }
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
