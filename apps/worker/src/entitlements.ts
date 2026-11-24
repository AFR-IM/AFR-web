import type { Db } from './db.ts';

/** True if this eligible ledger order has a grant for its subject, including on replay. */
export async function syncEntitlementFromBilling(db: Db, merchantOrderId: string): Promise<boolean> {
  // Check eligibility and derive the subject in the write itself, not in a prior read.
  const { changes } = await db.prepare(`INSERT INTO pro_entitlements
      (source_merchant_order_id, subject_id, granted_at)
    SELECT merchant_order_id, subject_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM billing_orders
    WHERE merchant_order_id = ? AND status = 'confirmed' AND purpose = 'pro' AND trim(subject_id) <> ''
    ON CONFLICT(source_merchant_order_id) DO NOTHING`).run(merchantOrderId);
  if (changes > 0) return true;

  // A replay succeeds only while the same order is eligible for the original subject.
  const grant = await db.prepare(`SELECT 1 FROM billing_orders b
    JOIN pro_entitlements e ON e.source_merchant_order_id = b.merchant_order_id AND e.subject_id = b.subject_id
    WHERE b.merchant_order_id = ? AND b.status = 'confirmed' AND b.purpose = 'pro'`).get(merchantOrderId);
  return grant !== undefined;
}

/** Authorization reads only the grant table; later ledger changes do not revoke Pro. */
export async function hasProEntitlement(db: Db, subjectId: string): Promise<boolean> {
  const grant = await db.prepare('SELECT 1 FROM pro_entitlements WHERE subject_id = ? LIMIT 1').get(subjectId);
  return grant !== undefined;
}
