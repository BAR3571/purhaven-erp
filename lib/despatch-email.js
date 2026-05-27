import { sql } from './db.js';
import { sendMail } from './email.js';
import { renderDespatchNoteBuffer } from '../api/despatches/[id]/paperwork/despatch-note.js';

const TRACKING_URLS = {
  'dpd':         t => `https://track.dpd.co.uk/search?reference=${encodeURIComponent(t)}`,
  'royal mail':  t => `https://www.royalmail.com/track-your-item#/tracking-results/${encodeURIComponent(t)}`,
  'ups':         t => `https://www.ups.com/track?tracknum=${encodeURIComponent(t)}`,
  'fedex':       t => `https://www.fedex.com/wtrk/track/?trknbr=${encodeURIComponent(t)}`,
  'parcelforce': t => `https://www.parcelforce.com/track-trace?trackNumber=${encodeURIComponent(t)}`,
  'hermes':      t => `https://www.evri.com/track/parcel/${encodeURIComponent(t)}`,
  'evri':        t => `https://www.evri.com/track/parcel/${encodeURIComponent(t)}`
};

function trackingHref(carrier, tracking) {
  if (!tracking) return null;
  const key = (carrier || '').toLowerCase().trim();
  for (const [k, fn] of Object.entries(TRACKING_URLS)) {
    if (key.includes(k)) return fn(tracking);
  }
  return null;
}

/** Render the despatch-note PDF, look up the customer email, send it via SMTP,
 *  and stamp despatch_email_sent_at. opts.to overrides the recipient. */
export async function sendDespatchEmail(despatchId, opts = {}) {
  // Render the PDF + get the despatch detail in one call
  const { buffer, dn } = await renderDespatchNoteBuffer(despatchId);
  if (!buffer || !dn) throw new Error('Despatch not found');

  // Look up the customer email (or fall back to opts.to)
  let to = (opts.to || dn.customer_email || '').trim();
  if (!to) {
    // Try a primary contact on the customer record
    const rows = await sql`
      SELECT email FROM erp_customer_contacts
      WHERE customer_id = ${dn.customer_id} AND email IS NOT NULL
      ORDER BY is_primary DESC, id ASC LIMIT 1
    `;
    to = rows[0]?.email?.trim() || '';
  }
  if (!to) throw new Error('No email found for this customer — add one on the customer record or pass `to`.');

  const carrier = dn.carrier || 'our courier';
  const tracking = dn.tracking_number || '';
  const trackUrl = trackingHref(carrier, tracking);
  const firstName = (dn.ship_to_name || dn.customer_name || 'there').split(' ')[0];

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 620px; color: #0a1f2e; line-height: 1.55;">
      <h2 style="font-family: Georgia, serif; color: #0a1f2e; margin: 0 0 4px;">PurHaven</h2>
      <p style="font-style: italic; color: #2c6e85; margin: 0 0 18px;">Your Happy, Healthy, Home.</p>

      <p>Hi ${escapeHtml(firstName)},</p>
      <p>Good news — your PurHaven order <strong>${escapeHtml(dn.so_number)}</strong> is on its way.</p>

      <table cellpadding="6" style="border-collapse: collapse; background: #f4f9fb; border: 1px solid #c8dde6; border-radius: 8px; margin: 14px 0;">
        <tr><td style="color: #5a7280;">Despatch no.</td><td><strong>${escapeHtml(dn.despatch_number)}</strong></td></tr>
        <tr><td style="color: #5a7280;">Carrier</td><td>${escapeHtml(carrier)}</td></tr>
        <tr><td style="color: #5a7280;">Tracking</td><td>${tracking ? (trackUrl ? `<a href="${trackUrl}">${escapeHtml(tracking)}</a>` : escapeHtml(tracking)) : '—'}</td></tr>
        <tr><td style="color: #5a7280;">Packages</td><td>${dn.number_of_packages || 1}${dn.weight_kg ? ` · ${dn.weight_kg} kg` : ''}</td></tr>
      </table>

      <p>Your detailed despatch note is attached as a PDF — keep it for warranty and serial-number reference.</p>
      <p>If anything is missing or arrives damaged, please reply to this email within 7 days and we'll sort it.</p>

      <p style="margin-top: 28px; color: #5a7280; font-size: 13px;">
        Thank you,<br>
        The PurHaven team<br>
        UVCVTM Limited · 0800 138 7043 · <a href="mailto:sales@uvcvtm.com">sales@uvcvtm.com</a>
      </p>
    </div>
  `;

  const subject = `Your PurHaven order has been despatched · ${dn.despatch_number}`;
  const text = `Hi ${firstName},

Your PurHaven order ${dn.so_number} is on its way.
Despatch no.: ${dn.despatch_number}
Carrier: ${carrier}
Tracking: ${tracking || 'see attached'}
${trackUrl ? 'Track: ' + trackUrl : ''}

A detailed despatch note PDF is attached. Reply to this email within 7 days if anything's missing or damaged.

Thanks,
PurHaven (UVCVTM Limited)`;

  await sendMail({
    to,
    subject,
    text,
    html,
    attachments: [{
      filename: `despatch-note-${dn.despatch_number}.pdf`,
      content: buffer,
      contentType: 'application/pdf'
    }]
  });

  await sql`
    UPDATE erp_despatches
    SET despatch_email_sent_at = NOW(), despatch_email_to = ${to}
    WHERE id = ${despatchId}
  `;

  return { sent_to: to, despatch_number: dn.despatch_number };
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
