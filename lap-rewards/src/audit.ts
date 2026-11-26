/** Builds an audit-log INSERT so it can be committed in the same batch as the action. */
export function auditStmt(
  db: D1Database,
  actorId: number,
  action: string,
  targetType: string | null,
  targetId: number | null,
  detail: Record<string, unknown> | null = null,
  /** Only write the entry if a ledger row with this key exists (i.e. the action took effect). */
  onlyIfTxKey?: string,
): D1PreparedStatement {
  const d = detail ? JSON.stringify(detail) : null;
  if (onlyIfTxKey) {
    return db
      .prepare(
        `INSERT INTO audit_logs (actor_id, action, target_type, target_id, detail)
         SELECT ?1, ?2, ?3, ?4, ?5
         WHERE EXISTS (SELECT 1 FROM point_transactions WHERE idempotency_key = ?6)`,
      )
      .bind(actorId, action, targetType, targetId, d, onlyIfTxKey);
  }
  return db
    .prepare(
      `INSERT INTO audit_logs (actor_id, action, target_type, target_id, detail)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
    .bind(actorId, action, targetType, targetId, d);
}
