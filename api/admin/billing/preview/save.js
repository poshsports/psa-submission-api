// api/admin/billing/preview/save.js
import express from 'express';
import { Pool } from 'pg';

const router = express.Router();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// optional: centralize settings if you store them in DB
async function getSettings(client) {
  // Replace with your real settings store; hard-coded fallback:
  return { grade_fee_cents: 2000, shipping_cents: 500 };
}

router.post('/api/admin/billing/preview/save', async (req, res) => {
  // TODO: your admin auth here
  const { customer_email, items, invoice_id: incomingInvoiceId } = req.body || {};
  if (!customer_email || !Array.isArray(items)) {
    return res.status(400).json({ error: 'Bad payload' });
  }

  // Filter + coerce payload
  const cardIds = [];
  const upCents = [];
  for (const it of items) {
    if (!it || !it.card_id) continue;
    const cents = Math.max(0, Math.round(Number(it.upcharge_cents || 0)));
    cardIds.push(it.card_id);
    upCents.push(cents);
  }
  if (!cardIds.length) return res.json({ saved: 0 });

  const client = await pool.connect();
  try {
    await client.query('begin');

    const settings = await getSettings(client); // {grade_fee_cents, shipping_cents}

    // 1) Ensure a draft invoice
    let invoiceId = incomingInvoiceId || null;
    if (!invoiceId) {
      // Try existing draft (unique by customer via the partial index)
      const got = await client.query(
        `select id from billing_invoices
         where customer_email = $1 and status = 'draft'
         limit 1`,
        [customer_email]
      );
      if (got.rowCount) {
        invoiceId = got.rows[0].id;
      } else {
        const ins = await client.query(
          `insert into billing_invoices (customer_email, status, currency, shipping_cents, subtotal_cents, total_cents)
           values ($1, 'draft', 'USD', $2, 0, $2)
           returning id`,
          [customer_email, settings.shipping_cents]
        );
        invoiceId = ins.rows[0].id;
      }
    }

    // 2) Ensure there's a grading item per card
    await client.query(
      `
      insert into billing_invoice_items
        (invoice_id, submission_code, submission_card_id, kind, title, qty, unit_cents, amount_cents, meta)
      select
        $1 as invoice_id,
        sc.submission_id,
        sc.id,
        'grading' as kind,
        coalesce(nullif(sc.card_description,''), 'Grading Fee'),
        1 as qty,
        $2 as unit_cents,
        $2 as amount_cents,
        jsonb_build_object('break_number', sc.break_number, 'break_channel', sc.break_channel)
      from submission_cards sc
      where sc.id = any($3::uuid[])
      on conflict (invoice_id, submission_card_id, kind)
      do update set unit_cents = excluded.unit_cents,
                    amount_cents = excluded.amount_cents
      `,
      [invoiceId, settings.grade_fee_cents, cardIds]
    );

    // 3) Upsert upcharge item per card
    await client.query(
      `
      with up(card_id, upcharge_cents) as (
        select * from unnest($2::uuid[], $3::int[])
      )
      insert into billing_invoice_items
        (invoice_id, submission_code, submission_card_id, kind, title, qty, unit_cents, amount_cents, meta)
      select
        $1 as invoice_id,
        sc.submission_id,
        sc.id,
        'upcharge' as kind,
        coalesce(nullif(sc.card_description,''), 'Upcharge'),
        1,
        up.upcharge_cents,
        up.upcharge_cents,
        jsonb_build_object('source','preview')
      from up
      join submission_cards sc on sc.id = up.card_id
      on conflict (invoice_id, submission_card_id, kind)
      do update set unit_cents = excluded.unit_cents,
                    amount_cents = excluded.amount_cents;
      `,
      [invoiceId, cardIds, upCents]
    );

    // 4) Link submissions to invoice (safe if repeated)
    await client.query(
      `
      insert into billing_invoice_submissions (invoice_id, submission_code)
      select distinct $1, sc.submission_id
      from submission_cards sc
      where sc.id = any($2::uuid[])
      on conflict do nothing;
      `,
      [invoiceId, cardIds]
    );

    // 5) Recompute invoice totals
    await client.query(
      `
      update billing_invoices i
      set subtotal_cents = coalesce((
            select sum(amount_cents)
            from billing_invoice_items x
            where x.invoice_id = i.id
          ), 0),
          shipping_cents = $2,
          total_cents = coalesce((
            select sum(amount_cents)
            from billing_invoice_items x
            where x.invoice_id = i.id
          ), 0) + $2,
          updated_at = now()
      where i.id = $1;
      `,
      [invoiceId, settings.shipping_cents]
    );

    await client.query('commit');
    return res.json({ saved: cardIds.length, invoice_id: invoiceId });
  } catch (err) {
    await client.query('rollback');
    console.error(err);
    return res.status(500).json({ error: 'server_error' });
  } finally {
    client.release();
  }
});

export default router;
