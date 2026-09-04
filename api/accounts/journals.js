import { sql } from '../../lib/db.js';
import { requireUser } from '../../lib/session.js';

// GET  /api/accounts/journals?from=YYYY-MM-DD&to=YYYY-MM-DD  — list journal entries
// POST /api/accounts/journals { entry_date, reference?, narrative?, lines: [{code, debit?, credit?, description?}, ...] }
//     Lines are enforced to balance (SUM debits = SUM credits). At least 2 lines required.
//     Each line has debit_pence OR credit_pence (not both), amount in pence.
//     `code` refers to erp_nominal_accounts.code.
// GET  /api/accounts/journals?id=N  — single entry with lines
// POST /api/accounts/journals { action: 'reverse', id }  — creates a reversing entry
export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;

  if (req.method === 'GET') {
    const id = req.query.id ? parseInt(req.query.id, 10) : null;
    if (id) {
      const [entry] = await sql`
        SELECT je.*, u.name AS posted_by_name
        FROM erp_journal_entries je
        LEFT JOIN erp_users u ON u.id = je.posted_by
        WHERE je.id = ${id}
      `;
      if (!entry) return res.status(404).json({ error: 'Journal entry not found' });
      const lines = await sql`
        SELECT jl.*, na.code, na.name AS account_name, na.type AS account_type
        FROM erp_journal_lines jl
        JOIN erp_nominal_accounts na ON na.id = jl.nominal_account_id
        WHERE jl.entry_id = ${id}
        ORDER BY jl.id ASC
      `;
      return res.status(200).json({ ok: true, entry: { ...entry, lines } });
    }

    const from = req.query.from || '1900-01-01';
    const to   = req.query.to   || '2999-12-31';
    const entries = await sql`
      SELECT je.id, je.entry_date, je.reference, je.narrative, je.posted_at, je.reversal_of,
             u.name AS posted_by_name,
             COUNT(jl.id)::int AS line_count,
             COALESCE(SUM(jl.debit_pence), 0)::int AS total_debits,
             COALESCE(SUM(jl.credit_pence), 0)::int AS total_credits
      FROM erp_journal_entries je
      LEFT JOIN erp_users u ON u.id = je.posted_by
      LEFT JOIN erp_journal_lines jl ON jl.entry_id = je.id
      WHERE je.entry_date >= ${from}::date AND je.entry_date <= ${to}::date
      GROUP BY je.id, u.name
      ORDER BY je.entry_date DESC, je.id DESC
    `;
    return res.status(200).json({ ok: true, entries });
  }

  if (req.method === 'POST') {
    const b = req.body || {};

    // === Reverse an existing entry ===
    if (b.action === 'reverse') {
      const origId = parseInt(b.id, 10);
      if (!Number.isFinite(origId)) return res.status(400).json({ error: 'id required for reversal' });
      const [orig] = await sql`SELECT * FROM erp_journal_entries WHERE id = ${origId}`;
      if (!orig) return res.status(404).json({ error: 'Journal entry not found' });
      const origLines = await sql`SELECT * FROM erp_journal_lines WHERE entry_id = ${origId}`;
      if (origLines.length === 0) return res.status(400).json({ error: 'Original entry has no lines to reverse' });

      const today = new Date().toISOString().slice(0,10);
      const [newEntry] = await sql`
        INSERT INTO erp_journal_entries (entry_date, reference, narrative, posted_by, reversal_of)
        VALUES (${today}, ${'REV-' + (orig.reference || orig.id)},
                ${'Reversal of #' + orig.id + (orig.narrative ? ' — ' + orig.narrative : '')},
                ${user.id}, ${origId})
        RETURNING id
      `;
      for (const line of origLines) {
        await sql`
          INSERT INTO erp_journal_lines (entry_id, nominal_account_id, debit_pence, credit_pence, description)
          VALUES (${newEntry.id}, ${line.nominal_account_id},
                  ${line.credit_pence}, ${line.debit_pence},
                  ${(line.description ? 'REV: ' + line.description : 'Reversal')})
        `;
      }
      return res.status(201).json({ ok: true, id: newEntry.id, reversal_of: origId });
    }

    // === New entry ===
    const entryDate = b.entry_date;
    if (!entryDate) return res.status(400).json({ error: 'entry_date required' });
    const lines = Array.isArray(b.lines) ? b.lines : [];
    if (lines.length < 2) return res.status(400).json({ error: 'At least 2 lines required' });

    // Look up nominal account IDs by code
    const codes = [...new Set(lines.map(l => (l.code || '').trim()))].filter(Boolean);
    const accts = await sql`SELECT id, code FROM erp_nominal_accounts WHERE code = ANY(${codes})`;
    const codeToId = {};
    for (const a of accts) codeToId[a.code] = a.id;

    // Validate + collect
    const cleaned = [];
    let totalDr = 0, totalCr = 0;
    for (const l of lines) {
      const code = (l.code || '').trim();
      if (!code || !codeToId[code]) {
        return res.status(400).json({ error: `Unknown nominal code: ${code || '(blank)'}` });
      }
      const dr = Math.max(0, parseInt(l.debit_pence, 10) || 0);
      const cr = Math.max(0, parseInt(l.credit_pence, 10) || 0);
      if (dr > 0 && cr > 0) return res.status(400).json({ error: `Line for ${code}: cannot have both debit and credit` });
      if (dr === 0 && cr === 0) return res.status(400).json({ error: `Line for ${code}: must have either a debit or credit` });
      cleaned.push({
        nominal_account_id: codeToId[code],
        debit_pence: dr, credit_pence: cr,
        description: (l.description || '').trim() || null
      });
      totalDr += dr; totalCr += cr;
    }

    if (totalDr !== totalCr) {
      return res.status(400).json({
        error: `Journal does not balance: debits ${(totalDr/100).toFixed(2)} vs credits ${(totalCr/100).toFixed(2)}. Difference ${((totalDr-totalCr)/100).toFixed(2)}.`
      });
    }

    const [entry] = await sql`
      INSERT INTO erp_journal_entries (entry_date, reference, narrative, posted_by)
      VALUES (${entryDate}, ${(b.reference || '').trim() || null},
              ${(b.narrative || '').trim() || null}, ${user.id})
      RETURNING id
    `;
    for (const l of cleaned) {
      await sql`
        INSERT INTO erp_journal_lines (entry_id, nominal_account_id, debit_pence, credit_pence, description)
        VALUES (${entry.id}, ${l.nominal_account_id}, ${l.debit_pence}, ${l.credit_pence}, ${l.description})
      `;
    }
    return res.status(201).json({ ok: true, id: entry.id, total_debits: totalDr, total_credits: totalCr });
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
