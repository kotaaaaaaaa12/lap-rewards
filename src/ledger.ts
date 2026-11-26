// All point movements go through these statement builders. Each is a single
// guarded INSERT, so it either takes full effect or does nothing (meta.changes = 0):
//  - duplicate idempotency key  -> nothing happens
//  - balance would go negative  -> nothing happens
// The balance cache in `users` is updated by a database trigger.

export type TxType = 'award' | 'deduction' | 'award_cancel' | 'redeem' | 'redeem_cancel' | 'correction';

const COLS = `student_id, amount, balance_after, type, reason, operator_id, ref_transaction_id, idempotency_key`;

export interface NewTx {
  studentId: number;
  amount: number; // signed
  type: TxType;
  reason: string;
  operatorId: number;
  key: string;
  /** Require the student account to be active (true for awards and redemptions). */
  requireActive?: boolean;
}

export function insertTx(db: D1Database, t: NewTx): D1PreparedStatement {
  const active = t.requireActive === false ? '' : 'AND u.is_active = 1';
  return db
    .prepare(
      `INSERT INTO point_transactions (${COLS})
       SELECT u.id, ?2, u.balance + ?2, ?3, ?4, ?5, NULL, ?6
       FROM users u
       WHERE u.id = ?1 AND u.role = 'student' ${active}
         AND u.balance + ?2 >= 0
         AND NOT EXISTS (SELECT 1 FROM point_transactions WHERE idempotency_key = ?6)`,
    )
    .bind(t.studentId, t.amount, t.type, t.reason, t.operatorId, t.key);
}

/** Reverses an award (or a deduction) by appending a new row that references the original. */
export function insertCancel(
  db: D1Database,
  p: { originalId: number; reason: string; operatorId: number; onlyOperatorId?: number },
): D1PreparedStatement {
  const own = p.onlyOperatorId ? 'AND o.operator_id = ?5' : '';
  const binds: unknown[] = [p.originalId, p.reason, p.operatorId, `cancel:${p.originalId}`];
  if (p.onlyOperatorId) binds.push(p.onlyOperatorId);
  return db
    .prepare(
      `INSERT INTO point_transactions (${COLS})
       SELECT o.student_id, -o.amount, u.balance - o.amount,
              CASE o.type WHEN 'award' THEN 'award_cancel' ELSE 'correction' END,
              ?2, ?3, o.id, ?4
       FROM point_transactions o JOIN users u ON u.id = o.student_id
       WHERE o.id = ?1 AND o.type IN ('award','deduction')
         AND u.balance - o.amount >= 0
         AND NOT EXISTS (SELECT 1 FROM point_transactions c WHERE c.ref_transaction_id = o.id)
         ${own}`,
    )
    .bind(...binds);
}

/** Refunds a pending redemption. */
export function insertRedeemRefund(
  db: D1Database,
  p: { redemptionId: number; reason: string; operatorId: number },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO point_transactions (${COLS})
       SELECT r.student_id, r.cost_at_request, u.balance + r.cost_at_request,
              'redeem_cancel', ?2, ?3, r.transaction_id, ?4
       FROM redemptions r JOIN users u ON u.id = r.student_id
       WHERE r.id = ?1 AND r.status = 'pending'
         AND NOT EXISTS (SELECT 1 FROM point_transactions WHERE idempotency_key = ?4)`,
    )
    .bind(p.redemptionId, p.reason, p.operatorId, `redeem_cancel:${p.redemptionId}`);
}

export const changed = (r: D1Result) => (r.meta?.changes ?? 0) > 0;

/** Shared SELECT for ledger listings (callers append WHERE / ORDER / LIMIT). */
export const TX_SELECT = `
  SELECT t.id, t.created_at, t.student_id, s.nickname AS student_nickname, s.login_id AS student_login_id,
         t.amount, t.balance_after, t.type, t.reason, t.operator_id, o.nickname AS operator_nickname,
         t.ref_transaction_id, c.id AS cancelled_by
  FROM point_transactions t
  JOIN users s ON s.id = t.student_id
  JOIN users o ON o.id = t.operator_id
  LEFT JOIN point_transactions c ON c.ref_transaction_id = t.id`;
