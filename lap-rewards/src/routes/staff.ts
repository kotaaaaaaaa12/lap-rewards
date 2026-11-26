import type { Router } from '../router.ts';
import { requireRole } from '../router.ts';
import {
  HttpError, bad, chunk, conflict, forbidden, isUniqueError, json, notFound, qInt, reqIdList, reqInt,
  reqKey, reqStr,
} from '../http.ts';
import { auditStmt } from '../audit.ts';
import { changed, insertCancel, insertTx, TX_SELECT } from '../ledger.ts';

const MAX_AWARD = 100_000;
const MAX_STUDENTS = 200;
const BATCH = 50; // keep each D1 batch / IN list small

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

export function staffRoutes(r: Router) {
  const staff = requireRole('teacher', 'admin');

  // ---------------- classes ----------------
  r.get('/api/classes', staff, async (c) => {
    const { results } = await c.env.DB
      .prepare(
        `SELECT c.id, c.name, COUNT(u.id) AS student_count
         FROM classes c LEFT JOIN users u ON u.class_id = c.id AND u.role = 'student'
         GROUP BY c.id ORDER BY c.name`,
      )
      .all();
    const un = await c.env.DB
      .prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'student' AND class_id IS NULL AND is_active = 1`)
      .first<{ n: number }>();
    return json({ classes: results, unassigned_count: un?.n ?? 0 });
  });

  r.post('/api/classes', staff, async (c) => {
    const body = await c.body();
    const name = reqStr(body.name, 'Class name', 1, 40);
    try {
      const res = await c.env.DB.prepare('INSERT INTO classes (name) VALUES (?1)').bind(name).run();
      const id = res.meta.last_row_id as number;
      await auditStmt(c.env.DB, c.user!.id, 'class.create', 'class', id, { name }).run();
      return json({ id, name }, 201);
    } catch (e) {
      if (isUniqueError(e)) throw conflict('class_exists', 'A class with that name already exists.');
      throw e;
    }
  });

  r.patch('/api/classes/:id', staff, async (c) => {
    const id = Number(c.params.id);
    const name = reqStr((await c.body()).name, 'Class name', 1, 40);
    try {
      const res = await c.env.DB.prepare('UPDATE classes SET name = ?1 WHERE id = ?2').bind(name, id).run();
      if (!res.meta.changes) throw notFound('Class not found.');
    } catch (e) {
      if (isUniqueError(e)) throw conflict('class_exists', 'A class with that name already exists.');
      throw e;
    }
    await auditStmt(c.env.DB, c.user!.id, 'class.rename', 'class', id, { name }).run();
    return json({ ok: true });
  });

  r.delete('/api/classes/:id', staff, async (c) => {
    const id = Number(c.params.id);
    const n = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM users WHERE class_id = ?1').bind(id).first<{ n: number }>();
    if ((n?.n ?? 0) > 0) throw conflict('class_not_empty', 'Move all students out of this class before deleting it.');
    const res = await c.env.DB.prepare('DELETE FROM classes WHERE id = ?1').bind(id).run();
    if (!res.meta.changes) throw notFound('Class not found.');
    await auditStmt(c.env.DB, c.user!.id, 'class.delete', 'class', id).run();
    return json({ ok: true });
  });

  // ---------------- students ----------------
  r.get('/api/students', staff, async (c) => {
    const q = (c.url.searchParams.get('q') ?? '').trim().slice(0, 50);
    const classParam = c.url.searchParams.get('class_id') ?? '';
    const limit = qInt(c.url, 'limit', 50, 1, 200);
    const offset = qInt(c.url, 'offset', 0, 0, 100000);
    const where: string[] = [`u.role = 'student'`];
    const binds: unknown[] = [];
    if (c.url.searchParams.get('include_inactive') !== '1') where.push('u.is_active = 1');
    if (q) {
      where.push(`(u.nickname LIKE ? ESCAPE '\\' OR u.login_id LIKE ? ESCAPE '\\')`);
      const like = `%${escapeLike(q)}%`;
      binds.push(like, like);
    }
    if (classParam === 'none') where.push('u.class_id IS NULL');
    else if (classParam) {
      const cid = Number(classParam);
      if (!Number.isInteger(cid)) throw bad('class_id is invalid.');
      where.push('u.class_id = ?');
      binds.push(cid);
    }
    const w = where.join(' AND ');
    const { results } = await c.env.DB
      .prepare(
        `SELECT u.id, u.login_id, u.nickname, u.balance, u.is_active, u.class_id, c.name AS class_name
         FROM users u LEFT JOIN classes c ON c.id = u.class_id
         WHERE ${w}
         ORDER BY c.name IS NULL, c.name, u.nickname, u.id LIMIT ? OFFSET ?`,
      )
      .bind(...binds, limit, offset)
      .all();
    const total = await c.env.DB
      .prepare(`SELECT COUNT(*) AS n FROM users u WHERE ${w}`)
      .bind(...binds)
      .first<{ n: number }>();
    return json({ students: results, total: total?.n ?? 0 });
  });

  r.get('/api/students/:id', staff, async (c) => {
    const row = await c.env.DB
      .prepare(
        `SELECT u.id, u.login_id, u.nickname, u.balance, u.is_active, u.class_id, c.name AS class_name
         FROM users u LEFT JOIN classes c ON c.id = u.class_id WHERE u.id = ?1 AND u.role = 'student'`,
      )
      .bind(Number(c.params.id))
      .first();
    if (!row) throw notFound('Student not found.');
    return json({ student: row });
  });

  // Assign one or many students to a class (class_id = null removes them from their class).
  r.post('/api/students/assign', staff, async (c) => {
    const body = await c.body();
    const ids = reqIdList(body.student_ids, 'student_ids', MAX_STUDENTS);
    const classId = body.class_id === null ? null : reqInt(body.class_id, 'class_id', 1, Number.MAX_SAFE_INTEGER);
    if (classId !== null) {
      const cls = await c.env.DB.prepare('SELECT id FROM classes WHERE id = ?1').bind(classId).first();
      if (!cls) throw notFound('Class not found.');
    }
    const db = c.env.DB;
    const stmts = chunk(ids, BATCH).map((part) =>
      db
        .prepare(
          `UPDATE users SET class_id = ?1 WHERE role = 'student' AND id IN (${part.map(() => '?').join(',')})`,
        )
        .bind(classId, ...part),
    );
    stmts.push(auditStmt(db, c.user!.id, 'class.assign', 'class', classId, { student_ids: ids }));
    await db.batch(stmts);
    return json({ ok: true, count: ids.length });
  });

  // ---------------- points ----------------
  // Award points to one or many students. Selected students and amount are confirmed client-side;
  // the submission key makes retries and double clicks harmless.
  r.post('/api/points/award', staff, async (c) => {
    const body = await c.body();
    const ids = reqIdList(body.student_ids, 'student_ids', MAX_STUDENTS);
    const amount = reqInt(body.amount, 'Amount', 1, MAX_AWARD);
    const reason = reqStr(body.reason, 'Reason', 1, 200);
    const key = reqKey(body.key);
    const db = c.env.DB;

    const eligible = new Set<number>();
    for (const part of chunk(ids, BATCH)) {
      const { results } = await db
        .prepare(
          `SELECT id FROM users WHERE role = 'student' AND is_active = 1 AND id IN (${part.map(() => '?').join(',')})`,
        )
        .bind(...part)
        .all<{ id: number }>();
      results.forEach((x) => eligible.add(x.id));
    }
    if (eligible.size !== ids.length) throw bad('Some selected students do not exist or are inactive.');

    let awarded = 0;
    let duplicates = 0;
    for (const part of chunk(ids, BATCH)) {
      const res = await db.batch(
        part.map((sid) =>
          insertTx(db, {
            studentId: sid, amount, type: 'award', reason, operatorId: c.user!.id, key: `${key}:${sid}`,
          }),
        ),
      );
      res.forEach((x) => (changed(x) ? awarded++ : duplicates++));
    }
    if (awarded > 0) {
      await auditStmt(db, c.user!.id, 'points.award', 'student', null, {
        student_ids: ids, amount, reason, key,
      }).run();
    }
    return json({ ok: true, awarded, duplicates }, awarded > 0 ? 201 : 200);
  });

  r.get('/api/points/transactions', staff, async (c) => {
    const limit = qInt(c.url, 'limit', 50, 1, 100);
    const before = qInt(c.url, 'before', Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER);
    const where = ['t.id < ?'];
    const binds: unknown[] = [before];
    const sid = c.url.searchParams.get('student_id');
    if (sid) {
      const n = Number(sid);
      if (!Number.isInteger(n)) throw bad('student_id is invalid.');
      where.push('t.student_id = ?');
      binds.push(n);
    }
    if (c.url.searchParams.get('mine') === '1') {
      where.push('t.operator_id = ?');
      binds.push(c.user!.id);
    }
    const type = c.url.searchParams.get('type');
    if (type) {
      where.push('t.type = ?');
      binds.push(type);
    }
    const { results } = await c.env.DB
      .prepare(`${TX_SELECT} WHERE ${where.join(' AND ')} ORDER BY t.id DESC LIMIT ?`)
      .bind(...binds, limit)
      .all();
    return json({ transactions: results });
  });

  // Cancelling appends a new row that references the original; nothing is edited or deleted.
  r.post('/api/points/:id/cancel', staff, async (c) => {
    const id = Number(c.params.id);
    const reason = reqStr((await c.body()).reason, 'Reason', 1, 200);
    const db = c.env.DB;
    const orig = await db
      .prepare('SELECT id, student_id, amount, type, operator_id FROM point_transactions WHERE id = ?1')
      .bind(id)
      .first<{ id: number; student_id: number; amount: number; type: string; operator_id: number }>();
    if (!orig) throw notFound('Transaction not found.');
    const isAdmin = c.user!.role === 'admin';
    if (orig.type !== 'award' && !(orig.type === 'deduction' && isAdmin)) {
      throw bad('This transaction cannot be cancelled.', 'not_cancellable');
    }
    if (!isAdmin && orig.operator_id !== c.user!.id) {
      throw forbidden('Teachers can only cancel awards they made themselves.');
    }
    const done = await db.prepare('SELECT 1 AS x FROM point_transactions WHERE ref_transaction_id = ?1').bind(id).first();
    if (done) throw conflict('already_cancelled', 'This transaction has already been cancelled.');
    const bal = await db.prepare('SELECT balance FROM users WHERE id = ?1').bind(orig.student_id).first<{ balance: number }>();
    if ((bal?.balance ?? 0) - orig.amount < 0) {
      throw conflict('insufficient_balance', 'The student has already spent these points, so the award cannot be cancelled.');
    }
    const res = await db.batch([
      insertCancel(db, {
        originalId: id, reason, operatorId: c.user!.id, onlyOperatorId: isAdmin ? undefined : c.user!.id,
      }),
      auditStmt(db, c.user!.id, 'points.cancel', 'transaction', id, { reason }, `cancel:${id}`),
    ]);
    if (!changed(res[0])) throw new HttpError(409, 'conflict', 'The transaction changed. Please reload and try again.');
    return json({ ok: true }, 201);
  });
}
