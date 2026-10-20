// Shared storage for forms and responses, backed by the D1 binding `DB`.
// Routes: GET/PUT/DELETE /api/forms/:id, GET/POST /api/forms/:id/responses, GET /api/forms

const json = (data, status = 200) => Response.json(data, { status });

export async function onRequest({ request, env, params }) {
  const [kind, id, sub] = [].concat(params.route || []);
  if (kind !== 'forms') return json({ error: 'Not found' }, 404);
  const db = env.DB;
  const method = request.method;

  if (!id) {
    if (method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    const { results } = await db.prepare(
      `SELECT f.data, COUNT(r.id) AS responses
         FROM forms f LEFT JOIN responses r ON r.form_id = f.id
         GROUP BY f.id ORDER BY f.created_at DESC`
    ).all();
    return json(results.map(r => ({ ...JSON.parse(r.data), responseCount: r.responses })));
  }

  if (sub === 'responses') {
    if (method === 'GET') {
      const { results } = await db.prepare(
        'SELECT id, submitted_at AS at, answers FROM responses WHERE form_id = ? ORDER BY submitted_at'
      ).bind(id).all();
      return json(results.map(r => ({ id: r.id, at: r.at, answers: JSON.parse(r.answers) })));
    }
    if (method === 'POST') {
      const body = await request.json();
      const form = await db.prepare('SELECT id FROM forms WHERE id = ?').bind(id).first();
      if (!form) return json({ error: 'Form not found' }, 404);
      const at = new Date().toISOString();
      const rid = crypto.randomUUID();
      await db.prepare('INSERT INTO responses (id, form_id, submitted_at, answers) VALUES (?, ?, ?, ?)')
        .bind(rid, id, at, JSON.stringify(body.answers ?? {})).run();
      return json({ id: rid, at }, 201);
    }
    return json({ error: 'Method not allowed' }, 405);
  }

  if (sub) return json({ error: 'Not found' }, 404);

  if (method === 'GET') {
    const row = await db.prepare(
      'SELECT f.data, COUNT(r.id) AS responses FROM forms f LEFT JOIN responses r ON r.form_id = f.id WHERE f.id = ? GROUP BY f.id'
    ).bind(id).first();
    if (!row) return json({ error: 'Form not found' }, 404);
    return json({ ...JSON.parse(row.data), responseCount: row.responses });
  }

  if (method === 'PUT') {
    const { responses, responseCount, ...form } = await request.json();
    const now = new Date().toISOString();
    await db.prepare(
      `INSERT INTO forms (id, data, created_at, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
    ).bind(id, JSON.stringify({ ...form, id }), now, now).run();
    return json({ ok: true });
  }

  if (method === 'DELETE') {
    await db.batch([
      db.prepare('DELETE FROM responses WHERE form_id = ?').bind(id),
      db.prepare('DELETE FROM forms WHERE id = ?').bind(id),
    ]);
    return json({ ok: true });
  }

  return json({ error: 'Method not allowed' }, 405);
}
