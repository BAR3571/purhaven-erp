import { sql } from '../../../lib/db.js';

// Public read-only product catalogue for the purhaven.co.uk website.
// No auth required, but cached at the edge for 30 seconds so spikes don't
// hammer the DB. CORS open to any origin — these prices are public anyway.
// Append ?nocache=1 to bypass the edge cache entirely (use sparingly).

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    setCors(res);
    return res.status(204).end();
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  setCors(res);

  const brand = (req.query.brand || '').trim() || null;
  const category = (req.query.category || '').trim() || null;
  const sku = (req.query.sku || '').trim() || null;

  const rows = await sql`
    SELECT
      p.id, p.sku, p.name, p.brand, p.category,
      p.description, p.image_url, p.parent_id,
      p.sale_price_pence, p.vat_rate_percent, p.currency,
      p.weight_g, p.hs_code, p.country_of_origin,
      p.service_interval_months, p.requires_serial,
      p.promo_price_pence, p.promo_from, p.promo_to, p.promo_label,
      parent.sku AS parent_sku
    FROM erp_products p
    LEFT JOIN erp_products parent ON parent.id = p.parent_id
    WHERE p.active = TRUE
      AND p.sale_price_pence IS NOT NULL
      AND (${sku}::text IS NULL OR p.sku = ${sku})
      AND (${brand}::text IS NULL OR p.brand = ${brand})
      AND (${category}::text IS NULL OR p.category = ${category})
    ORDER BY p.brand ASC, p.name ASC
  `;

  // Add a couple of convenience computed fields so callers don't have to do maths.
  // Also resolves promotional pricing — if the current date (UK) falls between
  // promo_from and promo_to inclusive AND a promo_price is set, effective_* is
  // the promo price; otherwise effective_* equals the standard sale price.
  const todayUK = new Date(new Date().toLocaleString('en-GB', { timeZone: 'Europe/London' }));
  const todayISO = todayUK.toISOString().slice(0, 10);

  const products = rows.map(p => {
    const vatRate = p.vat_rate_percent ?? 20;
    const sale_ex = p.sale_price_pence;
    const sale_inc = Math.round(sale_ex * (1 + vatRate / 100));

    const promoFromISO = p.promo_from ? new Date(p.promo_from).toISOString().slice(0, 10) : null;
    const promoToISO   = p.promo_to   ? new Date(p.promo_to  ).toISOString().slice(0, 10) : null;
    const promoActive = !!(
      p.promo_price_pence &&
      promoFromISO && promoToISO &&
      promoFromISO <= todayISO && todayISO <= promoToISO
    );

    const promo_ex   = promoActive ? p.promo_price_pence : null;
    const promo_inc  = promo_ex != null ? Math.round(promo_ex * (1 + vatRate / 100)) : null;
    const eff_ex     = promo_ex != null ? promo_ex : sale_ex;
    const eff_inc    = Math.round(eff_ex * (1 + vatRate / 100));

    const fmt = pence => '£' + (pence / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    return {
      ...p,
      // Standard sale price (always = catalogue list price, pre-promo)
      sale_price_pence_inc_vat: sale_inc,
      sale_price_display_inc_vat: fmt(sale_inc),
      sale_price_display_ex_vat:  fmt(sale_ex),
      // Promo pricing (null when no promo active)
      promo_active: promoActive,
      promo_price_pence_inc_vat: promo_inc,
      promo_price_display_inc_vat: promo_inc != null ? fmt(promo_inc) : null,
      promo_price_display_ex_vat:  promo_ex  != null ? fmt(promo_ex)  : null,
      // "Effective" = what the customer actually pays today (promo or sale)
      effective_price_pence: eff_ex,
      effective_price_pence_inc_vat: eff_inc,
      effective_price_display_inc_vat: fmt(eff_inc),
      effective_price_display_ex_vat:  fmt(eff_ex)
    };
  });

  // Edge cache for 5 minutes; allow stale-while-revalidate for 1 week.
  // Under burst load this means ~12 DB hits/hour at most instead of one per
  // pageview. ?nocache=1 disables caching entirely (use after ERP edits).
  if (req.query.nocache) {
    res.setHeader('Cache-Control', 'no-store');
  } else {
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=604800');
  }
  return res.status(200).json({ ok: true, products });
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}
