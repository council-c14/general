// Storage for the billing app (public/billing), backed by the same D1 binding `DB`.
// Routes: GET /api/billing (everything), PUT/DELETE /api/billing/:kind/:id
// kind is customer, doc (quotation or invoice) or settings (id "main").

const json = (data, status = 200) => Response.json(data, { status });
const TABLE = `CREATE TABLE IF NOT EXISTS billing (
  kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (kind, id))`;
const KINDS = ['customer', 'doc', 'settings'];
const MAX_BODY = 1024 * 1024; // settings carry the logo as a data URL

export async function onRequest({ request, env, params }) {
  const [kind, id, extra] = [].concat(params.route || []);
  const db = env.DB;
  const method = request.method;
  await db.prepare(TABLE).run();

  if (!kind) {
    if (method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    // ponytail: loads every record in one go; page by customer once there are tens of thousands.
    const { results } = await db.prepare('SELECT kind, data FROM billing').all();
    const out = { customers: [], docs: [], settings: null };
    for (const r of results) {
      const d = JSON.parse(r.data);
      if (r.kind === 'settings') out.settings = d;
      else out[r.kind === 'doc' ? 'docs' : 'customers'].push(d);
    }
    return json(out);
  }

  if (!KINDS.includes(kind) || !id || extra || id.length > 64) return json({ error: 'Not found' }, 404);

  if (method === 'PUT') {
    const text = await request.text();
    if (text.length > MAX_BODY) return json({ error: 'Too large' }, 413);
    let data;
    try { data = JSON.parse(text); } catch { return json({ error: 'Invalid JSON' }, 400); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) return json({ error: 'Invalid record' }, 400);
    await db.prepare(
      `INSERT INTO billing (kind, id, data, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(kind, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
    ).bind(kind, id, JSON.stringify({ ...data, id }), new Date().toISOString()).run();
    return json({ ok: true });
  }

  if (method === 'DELETE') {
    await db.prepare('DELETE FROM billing WHERE kind = ? AND id = ?').bind(kind, id).run();
    return json({ ok: true });
  }

  return json({ error: 'Method not allowed' }, 405);
}
