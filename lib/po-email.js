import { sql } from './db.js';
import { sendMail } from './email.js';
import { uploadFile, ensureFolder, isConfigured as onedriveConfigured } from './onedrive.js';
import { renderPoBuffer } from './po-pdf.js';

/** Render the PO PDF, look up the supplier email, send it via SMTP,
 *  archive the PDF to OneDrive/SharePoint, and stamp po_email_sent_at.
 *  opts.to overrides the recipient. */
export async function sendPoEmail(poId, opts = {}) {
  const { buffer, po } = await renderPoBuffer(poId);
  if (!buffer || !po) throw new Error('Purchase order not found');

  // Resolve recipient: opts.to > primary contact > any contact with an email
  let to = (opts.to || '').trim();
  let contactName = null;
  if (!to) {
    const rows = await sql`
      SELECT name, email FROM erp_supplier_contacts
      WHERE supplier_id = ${po.supplier_id} AND email IS NOT NULL AND email <> ''
      ORDER BY is_primary DESC, id ASC LIMIT 1
    `;
    to = rows[0]?.email?.trim() || '';
    contactName = rows[0]?.name || null;
  }
  if (!to) throw new Error('No email found for this supplier — add a contact with an email on the supplier record or pass `to`.');

  const firstName = (contactName || po.supplier_name || 'there').split(' ')[0];
  const symbol = po.currency === 'GBP' ? '£' : po.currency === 'EUR' ? '€' : po.currency === 'USD' ? '$' : (po.currency + ' ');
  const totalStr = symbol + ((po.total_pence || 0) / 100).toFixed(2);

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 620px; color: #0a1f2e; line-height: 1.55;">
      <h2 style="font-family: Georgia, serif; color: #0a1f2e; margin: 0 0 4px;">PurHaven</h2>
      <p style="font-style: italic; color: #2c6e85; margin: 0 0 18px;">Your Happy, Healthy, Home.</p>

      <p>Hi ${escapeHtml(firstName)},</p>
      <p>Please find attached our purchase order <strong>${escapeHtml(po.po_number)}</strong>.</p>

      <table cellpadding="6" style="border-collapse: collapse; background: #f4f9fb; border: 1px solid #c8dde6; border-radius: 8px; margin: 14px 0;">
        <tr><td style="color: #5a7280;">PO number</td><td><strong>${escapeHtml(po.po_number)}</strong></td></tr>
        <tr><td style="color: #5a7280;">Order date</td><td>${po.order_date ? new Date(po.order_date).toLocaleDateString('en-GB') : '—'}</td></tr>
        <tr><td style="color: #5a7280;">Expected</td><td>${po.expected_date ? new Date(po.expected_date).toLocaleDateString('en-GB') : '—'}</td></tr>
        <tr><td style="color: #5a7280;">Line items</td><td>${po.lines.length}</td></tr>
        <tr><td style="color: #5a7280;">Total</td><td><strong>${escapeHtml(totalStr)}</strong> inc VAT</td></tr>
      </table>

      <p>Please confirm receipt and let us know the expected despatch date. Quote our PO number on your invoice and delivery paperwork.</p>

      <p style="margin-top: 28px; color: #5a7280; font-size: 13px;">
        Thank you,<br>
        The PurHaven team<br>
        UVCVTM Limited · 0800 138 7043 · <a href="mailto:sales@uvcvtm.com">sales@uvcvtm.com</a>
      </p>
    </div>
  `;

  const subject = `Purhaven Purchase Order · ${po.po_number}`;
  const text = `Hi ${firstName},

Please find attached our purchase order ${po.po_number}.

Order date: ${po.order_date ? new Date(po.order_date).toLocaleDateString('en-GB') : '—'}
Expected:   ${po.expected_date ? new Date(po.expected_date).toLocaleDateString('en-GB') : '—'}
Line items: ${po.lines.length}
Total:      ${totalStr} inc VAT

Please confirm receipt and let us know the expected despatch date.
Quote our PO number on your invoice and delivery paperwork.

Thanks,
PurHaven (UVCVTM Limited)
sales@uvcvtm.com`;

  await sendMail({
    to,
    subject,
    text,
    html,
    attachments: [{
      filename: `${po.po_number}.pdf`,
      content: buffer,
      contentType: 'application/pdf'
    }]
  });

  // Archive the PDF alongside the send (best-effort — email is authoritative)
  let archived = null;
  let archiveError = null;
  if (onedriveConfigured()) {
    try {
      const folderPath = `Purchase Orders/${po.po_number}`;
      const folder = await ensureFolder(folderPath);
      const uploaded = await uploadFile({
        folderPath,
        filename: `${po.po_number}.pdf`,
        buffer,
        contentType: 'application/pdf'
      });
      await sql`
        INSERT INTO erp_archived_documents (
          entity_type, entity_id, doc_type, filename,
          onedrive_id, onedrive_web_url, onedrive_path, size_bytes, archived_by
        ) VALUES (
          'purchase_order', ${poId}, 'purchase-order', ${uploaded.name},
          ${uploaded.id}, ${uploaded.webUrl}, ${uploaded.fullPath}, ${uploaded.size}, ${opts.userId || null}
        )
      `;
      archived = { folder_url: folder.webUrl, file_url: uploaded.webUrl };
    } catch (err) {
      archiveError = err.message;
    }
  }

  await sql`
    UPDATE erp_purchase_orders
    SET po_email_sent_at = NOW(),
        po_email_to = ${to},
        onedrive_folder_url = COALESCE(${archived?.folder_url || null}, onedrive_folder_url),
        updated_at = NOW()
    WHERE id = ${poId}
  `;

  return {
    sent_to: to,
    po_number: po.po_number,
    archived,
    archive_error: archiveError
  };
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
