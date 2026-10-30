// Hämtningar från tjänster som inte tillåter anrop direkt från webbläsaren:
// kombos från Commander Spellbook, lekar från Archidekt och regelboken från Wizards. Kräver inloggad användare (verify_jwt).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const UA = 'Lekverkstan/1.0 (privat lekbyggare)';
const PER_MINUTE = 120;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

type Combo = { id: string; uses: { card: { name: string } }[]; produces: { feature: { name: string } }[]; description?: string; easyPrerequisites?: string; notablePrerequisites?: string; popularity?: number };
const slimCombo = (c: Combo) => ({
  id: c.id,
  uses: (c.uses || []).map(u => u.card?.name).filter(Boolean),
  produces: (c.produces || []).map(p => p.feature?.name).filter(Boolean),
  steps: String(c.description || '').slice(0, 1500),
  prereq: [c.easyPrerequisites, c.notablePrerequisites].filter(Boolean).join('\n').slice(0, 600),
  popularity: c.popularity || 0,
});

async function combos(body: { commanders?: string[]; main?: string[] }) {
  const list = (a?: string[]) => (Array.isArray(a) ? a : []).slice(0, 250).map(n => ({ card: String(n).slice(0, 150) }));
  const r = await fetch('https://backend.commanderspellbook.com/find-my-combos', {
    method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ commanders: list(body.commanders), main: list(body.main) }),
  });
  if (!r.ok) throw new Error(`${r.status} från Commander Spellbook`);
  const res = (await r.json()).results || {};
  const top = (a: Combo[] = [], n: number) => a.slice().sort((x, y) => (y.popularity || 0) - (x.popularity || 0)).slice(0, n).map(slimCombo);
  return { included: top(res.included, 60), almost: top(res.almostIncluded, 40) };
}

const BOARD: Record<string, string> = { commander: 'commander', sideboard: 'side', maybeboard: 'maybe', considering: 'maybe' };
async function archidekt(id: string) {
  if (!/^\d{1,10}$/.test(id)) throw new Error('Ogiltigt lek-id');
  const r = await fetch(`https://archidekt.com/api/decks/${id}/`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (r.status === 404) throw new Error('Leken finns inte eller är privat');
  if (!r.ok) throw new Error(`${r.status} från Archidekt`);
  const d = await r.json();
  const outside = new Set((d.categories || []).filter((c: { includedInDeck: boolean }) => !c.includedInDeck).map((c: { name: string }) => c.name));
  const cards = (d.cards || []).map((c: { quantity: number; categories?: string[]; card?: { oracleCard?: { name?: string } } }) => {
    const cats: string[] = c.categories || [];
    let board = 'main';
    for (const k of cats) { const b = BOARD[k.toLowerCase()]; if (b) { board = b; break; } }
    if (board === 'main' && cats.length && cats.every(k => outside.has(k))) board = 'maybe';
    return { name: c.card?.oracleCard?.name, qty: c.quantity || 1, board };
  }).filter((c: { name?: string }) => c.name);
  return { name: String(d.name || 'Importerad lek').slice(0, 80), format: d.deckFormat === 2 ? 'modern' : 'commander', cards };
}

// Comprehensive Rules som text. Länken byter namn vid varje ny version, så den letas upp på regelsidan.
let rulesCache: { at: number; url: string; text: string } | null = null;
async function rules() {
  if (rulesCache && Date.now() - rulesCache.at < 24 * 3600e3) return { url: rulesCache.url, text: rulesCache.text };
  const page = await fetch('https://magic.wizards.com/en/rules', { headers: { 'User-Agent': UA } });
  if (!page.ok) throw new Error(`${page.status} från Wizards`);
  const m = (await page.text()).match(/https:\/\/media\.wizards\.com\/[^"']+?\.txt/);
  if (!m) throw new Error('Hittade ingen regeltext hos Wizards');
  const url = m[0].replace(/ /g, '%20');
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`${r.status} från Wizards`);
  const text = (await r.text()).slice(0, 3_000_000);
  rulesCache = { at: Date.now(), url, text };
  return { url, text };
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST krävs' }, 405);

  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const { data: u, error: ue } = await admin.auth.getUser(token);
  if (ue || !u?.user) return json({ error: 'Logga in först' }, 401);

  // samma minutgräns som Alara-funktionen (delad räknare)
  const minute = new Date(Math.floor(Date.now() / 60000) * 60000).toISOString();
  const { data: use } = await admin.from('lv_alara_usage').select('calls').eq('user_id', u.user.id).eq('minute', minute).maybeSingle();
  if ((use?.calls || 0) >= PER_MINUTE) return json({ error: 'För många anrop, vänta en minut' }, 429);
  await admin.from('lv_alara_usage').upsert({ user_id: u.user.id, minute, calls: (use?.calls || 0) + 1 });

  let body: { action?: string; id?: string; commanders?: string[]; main?: string[] } = {};
  try { body = await req.json(); } catch { /* tomt */ }
  try {
    if (body.action === 'combos') return json(await combos(body));
    if (body.action === 'archidekt') return json(await archidekt(String(body.id || '')));
    if (body.action === 'rules') return json(await rules());
    return json({ error: 'okänd action' }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
});
