import type { Router } from '../router.ts';
import { requireRole } from '../router.ts';
import { conflict, json, notFound, qInt, reqInt, reqKey } from '../http.ts';
import { changed, insertTx, TX_SELECT } from '../ledger.ts';

export function studentRoutes(r: Router) {
  const student = requireRole('student');

  r.get('/api/me/transactions', student, async (c) => {
    const limit = qInt(c.url, 'limit', 30, 1, 100);
    const before = qInt(c.url, 'before', Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER);
    const { results } = await c.env.DB
      .prepare(`${TX_SELECT} WHERE t.student_id = ?1 AND t.id < ?2 ORDER BY t.id DESC LIMIT ?3`)
      .bind(c.user!.id, before, limit)
      .all();
    return json({ transactions: results });
  });

  r.get('/api/rewards', student, async (c) => {
    const { results } = await c.env.DB
      .prepare('SELECT id, name, description, cost FROM rewards WHERE is_active = 1 ORDER BY cost, id')
      .all();
    return json({ rewards: results });
  });

  r.get('/api/me/redemptions', student, async (c) => {
    const { results } = await c.env.DB
      .prepare(
        `SELECT r.id, r.status, r.cost_at_request, r.created_at, r.updated_at, w.name AS reward_name
         FROM redemptions r JOIN rewards w ON w.id = r.reward_id
         WHERE r.student_id = ?1 ORDER BY r.id DESC LIMIT 50`,
      )
      .bind(c.user!.id)
      .all();
    return json({ redemptions: results });
  });

  r.post('/api/me/redemptions', student, async (c) => {
    const body = await c.body();
    const rewardId = reqInt(body.reward_id, 'reward_id', 1, Number.MAX_SAFE_INTEGER);
    const key = reqKey(body.key);
    const db = c.env.DB;

    // A repeated submission returns the original result instead of redeeming twice.
    const dup = await db.prepare('SELECT id FROM redemptions WHERE idempotency_key = ?1').bind(key).first<{ id: number }>();
    if (dup) return json({ ok: true, duplicate: true, redemption_id: dup.id });

    const reward = await db
      .prepare('SELECT id, name, cost FROM rewards WHERE id = ?1 AND is_active = 1')
      .bind(rewardId)
      .first<{ id: number; name: string; cost: number }>();
    if (!reward) throw notFound('That reward is not available.');

    const txKey = `redeem:${key}`;
    const results = await db.batch([
      insertTx(db, {
        studentId: c.user!.id, amount: -reward.cost, type: 'redeem',
        reason: `Redeemed: ${reward.name}`, operatorId: c.user!.id, key: txKey,
      }),
      // Only created if the ledger row above exists (i.e. the student had enough points).
      db
        .prepare(
          `INSERT INTO redemptions (student_id, reward_id, cost_at_request, transaction_id, idempotency_key)
           SELECT ?1, ?2, ?3, t.id, ?4 FROM point_transactions t
           WHERE t.idempotency_key = ?5
             AND NOT EXISTS (SELECT 1 FROM redemptions WHERE idempotency_key = ?4)`,
        )
        .bind(c.user!.id, reward.id, reward.cost, key, txKey),
    ]);
    if (!changed(results[0]) || !changed(results[1])) {
      throw conflict('insufficient_points', 'You do not have enough points for this reward.');
    }
    return json({ ok: true }, 201);
  });
}
