// Shared storage for forms and responses, backed by the D1 binding `DB`.
// Routes: GET/PUT/DELETE /api/forms/:id, GET/POST /api/forms/:id/responses, GET /api/forms,
//         POST /api/forms/:id/files (raw body), GET /api/files/:fileId

const json = (data, status = 200) => Response.json(data, { status });
// Uploaded files (answers and form images) live in D1.
// ponytail: D1 caps a row near 2 MB, so files stop at 1.5 MB; move to an R2 bucket for bigger ones.
const FILES = 'CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, form_id TEXT NOT NULL, name TEXT NOT NULL, type TEXT NOT NULL, data BLOB NOT NULL)';
const MAX_FILE = 1.5 * 1024 * 1024;

export async function onRequest({ request, env, params }) {
  const [kind, id, sub] = [].concat(params.route || []);
  const db = env.DB;
  const method = request.method;

  if (kind === 'files' && id && method === 'GET') {
    await db.prepare(FILES).run();
    const file = await db.prepare('SELECT name, type, data FROM files WHERE id = ?').bind(id).first();
    if (!file) return json({ error: 'Not found' }, 404);
    // Images show inline; anything else downloads, so an uploaded page can't run on this site.
    const inline = /^image\/(png|jpeg|gif|webp)$/.test(file.type);
    return new Response(new Uint8Array(file.data), {
      headers: {
        'Content-Type': inline ? file.type : 'application/octet-stream',
        'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }
  if (kind !== 'forms') return json({ error: 'Not found' }, 404);

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
      const form = await db.prepare('SELECT data FROM forms WHERE id = ?').bind(id).first();
      if (!form) return json({ error: 'Form not found' }, 404);
      if (JSON.parse(form.data).accepting === false) return json({ error: 'Form is not accepting responses' }, 403);
      const at = new Date().toISOString();
      const rid = crypto.randomUUID();
      await db.prepare('INSERT INTO responses (id, form_id, submitted_at, answers) VALUES (?, ?, ?, ?)')
        .bind(rid, id, at, JSON.stringify(body.answers ?? {})).run();
      return json({ id: rid, at }, 201);
    }
    return json({ error: 'Method not allowed' }, 405);
  }

  if (sub === 'files' && method === 'POST') {
    const form = await db.prepare('SELECT id FROM forms WHERE id = ?').bind(id).first();
    if (!form) return json({ error: 'Form not found' }, 404);
    const data = await request.arrayBuffer();
    if (data.byteLength > MAX_FILE) return json({ error: 'File too large' }, 413);
    const fid = crypto.randomUUID();
    const name = decodeURIComponent(request.headers.get('X-File-Name') || 'file').slice(0, 200);
    await db.prepare(FILES).run();
    await db.prepare('INSERT INTO files (id, form_id, name, type, data) VALUES (?, ?, ?, ?, ?)')
      .bind(fid, id, name, request.headers.get('Content-Type') || 'application/octet-stream', data).run();
    return json({ id: fid, url: `/api/files/${fid}` }, 201);
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
    await db.prepare(FILES).run();
    await db.batch([
      db.prepare('DELETE FROM files WHERE form_id = ?').bind(id),
      db.prepare('DELETE FROM responses WHERE form_id = ?').bind(id),
      db.prepare('DELETE FROM forms WHERE id = ?').bind(id),
    ]);
    return json({ ok: true });
  }

  return json({ error: 'Method not allowed' }, 405);
}
