import { sql } from './db.js';
import { uploadFile, ensureFolder, isConfigured, getStorageMode } from './onedrive.js';
import { getDespatchWithRelations } from './despatch.js';

import { renderPickingNoteBuffer }       from '../api/despatches/[id]/paperwork/picking-note.js';
import { renderPackingListBuffer }       from '../api/despatches/[id]/paperwork/packing-list.js';
import { renderDespatchNoteBuffer }      from '../api/despatches/[id]/paperwork/despatch-note.js';
import { renderCommercialInvoiceBuffer } from '../api/despatches/[id]/paperwork/commercial-invoice.js';
import { renderCiPerBoxBuffer }          from '../api/despatches/[id]/paperwork/ci-per-box.js';
import { renderParcelLabelsBuffer }      from '../api/despatches/[id]/paperwork/parcel-labels.js';

// Each renderer specifies which top-level folder its doc belongs in.
// In SharePoint mode these match the user's existing library structure
// (Picking Lists / Delivery Notes / Invoices). In OneDrive fallback mode
// they sit under the configured root folder.
const DOC_RENDERERS = [
  { key: 'picking-note',       label: 'Picking note',       folder: 'Picking Lists',  fn: renderPickingNoteBuffer },
  { key: 'packing-list',       label: 'Packing list',       folder: 'Delivery Notes', fn: renderPackingListBuffer },
  { key: 'despatch-note',      label: 'Despatch note',      folder: 'Delivery Notes', fn: renderDespatchNoteBuffer },
  { key: 'parcel-labels',      label: 'Parcel labels',      folder: 'Delivery Notes', fn: renderParcelLabelsBuffer },
  { key: 'commercial-invoice', label: 'Commercial invoice', folder: 'Invoices',       fn: renderCommercialInvoiceBuffer },
  { key: 'ci-per-box',         label: 'CI per box',         folder: 'Invoices',       fn: renderCiPerBoxBuffer }
];

function folderPathForDoc(dn, topFolder) {
  return `${topFolder}/${dn.despatch_number}`;
}

/** Archives all available paperwork PDFs for a despatch.
 *  Layout: <library>/<top-folder>/<DN-####>/<doc>.pdf
 *  Returns { storage_mode, folder_url, files: [...], errors: [...] }. */
export async function archiveDespatchToOneDrive(despatchId, opts = {}) {
  if (!isConfigured()) {
    throw new Error('Archive storage is not configured — set MS_GRAPH_* and either SHAREPOINT_* or ONEDRIVE_USER_UPN env vars in Vercel.');
  }

  const dn = await getDespatchWithRelations(despatchId);
  if (!dn) throw new Error('Despatch not found');

  const files = [];
  const errors = [];
  const ensuredFolders = new Map(); // top-folder -> folder info, so we ensure each only once
  let primaryFolderUrl = null;

  for (const renderer of DOC_RENDERERS) {
    try {
      const folderPath = folderPathForDoc(dn, renderer.folder);
      let folder = ensuredFolders.get(folderPath);
      if (!folder) {
        folder = await ensureFolder(folderPath);
        ensuredFolders.set(folderPath, folder);
      }
      if (!primaryFolderUrl && renderer.folder === 'Delivery Notes') primaryFolderUrl = folder.webUrl;

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

  // Fall back to any ensured folder URL if Delivery Notes wasn't reached
  if (!primaryFolderUrl) {
    const first = ensuredFolders.values().next();
    if (!first.done) primaryFolderUrl = first.value.webUrl;
  }

  await sql`
    UPDATE erp_despatches
    SET onedrive_folder_url = ${primaryFolderUrl},
        documents_archived_at = NOW()
    WHERE id = ${despatchId}
  `;

  return {
    storage_mode: getStorageMode(),
    folder_url: primaryFolderUrl,
    files,
    errors
  };
}
