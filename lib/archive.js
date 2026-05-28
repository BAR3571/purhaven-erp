import { sql } from './db.js';
import { uploadFile, ensureFolder, isConfigured } from './onedrive.js';
import { getDespatchWithRelations } from './despatch.js';

import { renderPickingNoteBuffer }       from '../api/despatches/[id]/paperwork/picking-note.js';
import { renderPackingListBuffer }       from '../api/despatches/[id]/paperwork/packing-list.js';
import { renderDespatchNoteBuffer }      from '../api/despatches/[id]/paperwork/despatch-note.js';
import { renderCommercialInvoiceBuffer } from '../api/despatches/[id]/paperwork/commercial-invoice.js';
import { renderCiPerBoxBuffer }          from '../api/despatches/[id]/paperwork/ci-per-box.js';
import { renderParcelLabelsBuffer }      from '../api/despatches/[id]/paperwork/parcel-labels.js';

const DOC_RENDERERS = [
  { key: 'picking-note',       label: 'Picking note',       fn: renderPickingNoteBuffer },
  { key: 'packing-list',       label: 'Packing list',       fn: renderPackingListBuffer },
  { key: 'commercial-invoice', label: 'Commercial invoice', fn: renderCommercialInvoiceBuffer },
  { key: 'ci-per-box',         label: 'CI per box',         fn: renderCiPerBoxBuffer },
  { key: 'parcel-labels',      label: 'Parcel labels',      fn: renderParcelLabelsBuffer },
  { key: 'despatch-note',      label: 'Despatch note',      fn: renderDespatchNoteBuffer }
];

function folderPathForDespatch(dn) {
  const d = dn.created_at ? new Date(dn.created_at) : new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `Despatches/${yyyy}/${mm}/${dn.despatch_number}`;
}

/** Archives all available paperwork PDFs for a despatch to OneDrive.
 *  Returns { folder_url, files: [...], errors: [...] }. */
export async function archiveDespatchToOneDrive(despatchId, opts = {}) {
  if (!isConfigured()) {
    throw new Error('OneDrive is not configured — set MS_GRAPH_* and ONEDRIVE_* env vars in Vercel.');
  }

  const dn = await getDespatchWithRelations(despatchId);
  if (!dn) throw new Error('Despatch not found');

  const folderPath = folderPathForDespatch(dn);
  const folder = await ensureFolder(folderPath);

  const files = [];
  const errors = [];

  for (const renderer of DOC_RENDERERS) {
    try {
      const { buffer } = await renderer.fn(despatchId);
      if (!buffer) continue;
      const filename = `${renderer.key}-${dn.despatch_number}.pdf`;
      const uploaded = await uploadFile({
        folderPath, filename, buffer, contentType: 'application/pdf'
      });
      files.push({ doc_type: renderer.key, label: renderer.label, ...uploaded });
      await sql`
        INSERT INTO erp_archived_documents (
          entity_type, entity_id, doc_type, filename,
          onedrive_id, onedrive_web_url, onedrive_path, size_bytes, archived_by
        ) VALUES (
          'despatch', ${despatchId}, ${renderer.key}, ${filename},
          ${uploaded.id}, ${uploaded.webUrl}, ${uploaded.fullPath}, ${uploaded.size}, ${opts.userId || null}
        )
      `;
    } catch (err) {
      errors.push({ doc_type: renderer.key, error: err.message });
    }
  }

  // Stamp the despatch header
  await sql`
    UPDATE erp_despatches
    SET onedrive_folder_url = ${folder.webUrl},
        documents_archived_at = NOW()
    WHERE id = ${despatchId}
  `;

  return { folder_url: folder.webUrl, folder_path: folder.fullPath, files, errors };
}
