// Alara Games-lager för ett kortnamn. Kräver inloggad användare (verify_jwt).
// Butikens sökning tillåter inte anrop direkt från webbläsaren, därför går det via här.
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const ALARA = 'https://www.alaragames.se';
const UA = 'Lekverkstan/1.0 (privat lekbyggare)';
const TTL_MS = 6 * 3600 * 1000;
const PER_MINUTE = 120;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

// "Sol Ring (Showcase) [Avatar ...]" matchar "Sol Ring", men inte art cards eller tokens
function titleMatches(title: string, name: string) {
  const t = title.toLowerCase(), n = name.toLowerCase();
  for (const cand of [n, n.split(' // ')[0]]) {
    if (!t.startsWith(cand)) continue;
    const rest = t.slice(cand.length).trimStart();
    if (rest === '' || rest.startsWith('[') || rest.startsWith('(') || rest.startsWith('//')) {
      return !/\bart card\b|\btoken\b|\bcheck(list)? card\b|\bsubstitute card\b/i.test(t.slice(cand.length));
    }
  }
  return false;
}

async function lookup(name: string) {
  const url = `${ALARA}/search?type=product&filter.v.availability=1&sort_by=price-ascending&q=` +
    encodeURIComponent(`title:"${name.split(' // ')[0]}"`);
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`${r.status} från Alara`);
  const html = await r.text();
  const handles = [...new Set([...html.matchAll(/"handle":"([^"]+)"/g)].map(m => m[1]))];
  const offers: Record<string, unknown>[] = [];
  for (const h of handles.slice(0, 8)) {
    const pr = await fetch(`${ALARA}/products/${h}.js`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!pr.ok) continue;
    const p = await pr.json();
    if (!p.title || !titleMatches(decode(p.title), name)) continue;
    for (const v of p.variants || []) {
      if (!v.available) continue;
      offers.push({
        title: p.title, condition: v.title,
        foil: /foil/i.test(v.title) || /foil/i.test(p.title),
        price: v.price / 100, url: `${ALARA}/products/${h}?variant=${v.id}`,
      });
    }
    if (offers.length >= 6) break;
  }
  offers.sort((a, b) => (a.price as number) - (b.price as number));
  return { name, offers: offers.slice(0, 6), searchUrl: `${ALARA}/search?q=${encodeURIComponent(name)}` };
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST krävs' }, 405);

  // vem anropar? (JWT är redan verifierad av plattformen, men vi behöver användar-id)
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const { data: u, error: ue } = await admin.auth.getUser(token);
  if (ue || !u?.user) return json({ error: 'Logga in först' }, 401);

  let body: { name?: string; fresh?: boolean } = {};
  try { body = await req.json(); } catch { /* tomt */ }
  const name = String(body.name || '').trim().slice(0, 150);
  if (!name) return json({ error: 'name saknas' }, 400);
  const key = name.toLowerCase();

  if (!body.fresh) {
    const { data: hit } = await admin.from('alara_cache').select('result, fetched_at').eq('name', key).maybeSingle();
    if (hit && Date.now() - new Date(hit.fetched_at).getTime() < TTL_MS) return json({ ...hit.result, cached: true });
  }

  // enkel gräns per användare och minut, så att ingen råkar hamra på butiken
  const minute = new Date(Math.floor(Date.now() / 60000) * 60000).toISOString();
  const { data: use } = await admin.from('alara_usage').select('calls').eq('user_id', u.user.id).eq('minute', minute).maybeSingle();
  if ((use?.calls || 0) >= PER_MINUTE) return json({ error: 'För många sökningar, vänta en minut' }, 429);
  await admin.from('alara_usage').upsert({ user_id: u.user.id, minute, calls: (use?.calls || 0) + 1 });

  try {
    const result = await lookup(name);
    await admin.from('alara_cache').upsert({ name: key, result, fetched_at: new Date().toISOString() });
    return json(result);
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
});
