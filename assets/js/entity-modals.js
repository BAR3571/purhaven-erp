// Shared modal forms for editing addresses + contacts on customer / supplier pages.
// Both modals pre-populate every field when an existing record is passed in,
// and the address modal includes a postcode lookup (postcodes.io — free, no key).
//
// Usage:
//   PurhavenModals.openContactModal({ contact, onSubmit: async (payload) => {...} })
//   PurhavenModals.openAddressModal({ address, onSubmit: async (payload) => {...} })
// Pass `contact`/`address` as null (or omit) to open a fresh "New …" form.

(function () {
  const esc = (s) => {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  function openModal(html) {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = html;
    document.body.appendChild(backdrop);
    // Close on backdrop click (but not on card click)
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop || e.target.dataset.close != null) closeModal(backdrop);
    });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') { closeModal(backdrop); document.removeEventListener('keydown', esc); }
    });
    return backdrop;
  }

  function closeModal(backdrop) {
    if (backdrop && backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
  }

  function openContactModal({ contact = null, onSubmit }) {
    const editing = !!contact;
    const c = contact || {};
    const backdrop = openModal(`
      <div class="modal-card" style="max-width: 520px;" onclick="event.stopPropagation()">
        <button type="button" class="x" data-close>×</button>
        <h2 style="margin:0 0 4px;">${editing ? 'Edit contact' : 'New contact'}</h2>
        <p style="margin:0 0 14px;color:var(--ink-soft);font-size:0.85rem;">${editing ? 'Update contact details. Leave a field blank to clear it.' : 'Add a new contact to this record.'}</p>

        <form id="pm-contact-form">
          <div class="field">
            <label for="pm-c-name">Name *</label>
            <input type="text" id="pm-c-name" required value="${esc(c.name)}" autocomplete="off">
          </div>
          <div class="field-row">
            <div class="field">
              <label for="pm-c-email">Email</label>
              <input type="email" id="pm-c-email" value="${esc(c.email)}" autocomplete="off">
            </div>
            <div class="field">
              <label for="pm-c-phone">Phone</label>
              <input type="tel" id="pm-c-phone" value="${esc(c.phone)}" autocomplete="off">
            </div>
          </div>
          <div class="field">
            <label for="pm-c-position">Position / role</label>
            <input type="text" id="pm-c-position" value="${esc(c.position)}" placeholder="e.g. Purchasing Manager" autocomplete="off">
          </div>
          <div class="field">
            <label style="display:flex;align-items:center;gap:8px;font-weight:500;">
              <input type="checkbox" id="pm-c-primary" ${c.is_primary ? 'checked' : ''}>
              Primary contact
            </label>
          </div>

          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">
            <button type="button" class="btn btn-ghost" data-close>Cancel</button>
            <button type="submit" class="btn btn-primary" id="pm-c-save">${editing ? 'Save changes' : 'Add contact'}</button>
          </div>
        </form>
      </div>
    `);

    const form = backdrop.querySelector('#pm-contact-form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const saveBtn = backdrop.querySelector('#pm-c-save');
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      try {
        const payload = {
          name:       backdrop.querySelector('#pm-c-name').value.trim(),
          email:      backdrop.querySelector('#pm-c-email').value.trim(),
          phone:      backdrop.querySelector('#pm-c-phone').value.trim(),
          position:   backdrop.querySelector('#pm-c-position').value.trim(),
          is_primary: backdrop.querySelector('#pm-c-primary').checked
        };
        await onSubmit(payload);
        closeModal(backdrop);
      } catch (err) {
        alert('Save failed: ' + (err.message || err));
        saveBtn.disabled = false;
        saveBtn.textContent = editing ? 'Save changes' : 'Add contact';
      }
    });

    setTimeout(() => backdrop.querySelector('#pm-c-name').focus(), 30);
  }

  function openAddressModal({ address = null, onSubmit }) {
    const editing = !!address;
    const a = address || { type: 'both', country: 'GB' };
    const backdrop = openModal(`
      <div class="modal-card" style="max-width: 560px;" onclick="event.stopPropagation()">
        <button type="button" class="x" data-close>×</button>
        <h2 style="margin:0 0 4px;">${editing ? 'Edit address' : 'New address'}</h2>
        <p style="margin:0 0 14px;color:var(--ink-soft);font-size:0.85rem;">Enter a UK postcode and click <strong>Look up</strong> to auto-fill city and county.</p>

        <form id="pm-address-form">
          <div class="field-row">
            <div class="field">
              <label for="pm-a-label">Label</label>
              <input type="text" id="pm-a-label" value="${esc(a.label)}" placeholder="e.g. Head Office, Warehouse" autocomplete="off">
            </div>
            <div class="field">
              <label for="pm-a-type">Type</label>
              <select id="pm-a-type">
                <option value="both" ${a.type === 'both' ? 'selected' : ''}>Billing + shipping</option>
                <option value="billing" ${a.type === 'billing' ? 'selected' : ''}>Billing only</option>
                <option value="shipping" ${a.type === 'shipping' ? 'selected' : ''}>Shipping only</option>
              </select>
            </div>
          </div>

          <div class="field-row" style="grid-template-columns: 1fr auto;">
            <div class="field">
              <label for="pm-a-postcode">Postcode</label>
              <input type="text" id="pm-a-postcode" value="${esc(a.postcode)}" placeholder="e.g. CM5 9NL" autocomplete="postal-code" style="text-transform:uppercase;">
            </div>
            <div class="field" style="display:flex;align-items:flex-end;">
              <button type="button" class="btn btn-ghost" id="pm-a-lookup" style="height:36px;">🔍 Look up</button>
            </div>
          </div>
          <p id="pm-a-lookup-msg" style="margin:-6px 0 10px;font-size:0.8rem;min-height:1em;"></p>

          <div class="field">
            <label for="pm-a-line1">Line 1 *</label>
            <input type="text" id="pm-a-line1" required value="${esc(a.line1)}" placeholder="Building / street" autocomplete="address-line1">
          </div>
          <div class="field">
            <label for="pm-a-line2">Line 2</label>
            <input type="text" id="pm-a-line2" value="${esc(a.line2)}" placeholder="Optional" autocomplete="address-line2">
          </div>

          <div class="field-row">
            <div class="field">
              <label for="pm-a-city">City / town *</label>
              <input type="text" id="pm-a-city" required value="${esc(a.city)}" autocomplete="address-level2">
            </div>
            <div class="field">
              <label for="pm-a-county">County</label>
              <input type="text" id="pm-a-county" value="${esc(a.county)}" autocomplete="address-level1">
            </div>
          </div>

          <div class="field">
            <label for="pm-a-country">Country (ISO code)</label>
            <input type="text" id="pm-a-country" value="${esc(a.country || 'GB')}" maxlength="2" style="text-transform:uppercase;width:80px;">
          </div>

          <div class="field">
            <label style="display:flex;align-items:center;gap:8px;font-weight:500;">
              <input type="checkbox" id="pm-a-default" ${a.is_default ? 'checked' : ''}>
              Default address
            </label>
          </div>

          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">
            <button type="button" class="btn btn-ghost" data-close>Cancel</button>
            <button type="submit" class="btn btn-primary" id="pm-a-save">${editing ? 'Save changes' : 'Add address'}</button>
          </div>
        </form>
      </div>
    `);

    // Postcode lookup — postcodes.io is free + no API key. Only accepts UK postcodes.
    const lookupBtn = backdrop.querySelector('#pm-a-lookup');
    const lookupMsg = backdrop.querySelector('#pm-a-lookup-msg');
    lookupBtn.addEventListener('click', async () => {
      const postcode = backdrop.querySelector('#pm-a-postcode').value.trim();
      if (!postcode) {
        lookupMsg.textContent = 'Enter a postcode first.';
        lookupMsg.style.color = 'var(--ink-soft)';
        return;
      }
      const country = backdrop.querySelector('#pm-a-country').value.trim().toUpperCase();
      if (country && country !== 'GB') {
        lookupMsg.textContent = 'Postcode lookup only works for UK (GB) addresses.';
        lookupMsg.style.color = '#fca5a5';
        return;
      }
      lookupBtn.disabled = true;
      lookupBtn.textContent = 'Looking up…';
      lookupMsg.textContent = '';
      try {
        const r = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(postcode)}`);
        const d = await r.json();
        if (!r.ok || d.status !== 200 || !d.result) {
          lookupMsg.textContent = 'Postcode not recognised. Check the format and try again.';
          lookupMsg.style.color = '#fca5a5';
          return;
        }
        const res = d.result;
        // Normalise + autofill
        backdrop.querySelector('#pm-a-postcode').value = res.postcode || postcode.toUpperCase();
        backdrop.querySelector('#pm-a-city').value    = res.admin_district || res.parish || res.admin_ward || '';
        backdrop.querySelector('#pm-a-county').value  = res.admin_county || res.region || '';
        backdrop.querySelector('#pm-a-country').value = 'GB';
        lookupMsg.textContent = `✓ Found: ${res.admin_district || ''}${res.admin_county ? ', ' + res.admin_county : ''}. Fill in Line 1 with the street address.`;
        lookupMsg.style.color = '#4ade80';
        backdrop.querySelector('#pm-a-line1').focus();
      } catch (err) {
        lookupMsg.textContent = 'Lookup failed: ' + err.message;
        lookupMsg.style.color = '#fca5a5';
      } finally {
        lookupBtn.disabled = false;
        lookupBtn.textContent = '🔍 Look up';
      }
    });

    // Enter key in the postcode field also fires lookup
    backdrop.querySelector('#pm-a-postcode').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); lookupBtn.click(); }
    });

    const form = backdrop.querySelector('#pm-address-form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const saveBtn = backdrop.querySelector('#pm-a-save');
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      try {
        const payload = {
          label:      backdrop.querySelector('#pm-a-label').value.trim(),
          type:       backdrop.querySelector('#pm-a-type').value,
          line1:      backdrop.querySelector('#pm-a-line1').value.trim(),
          line2:      backdrop.querySelector('#pm-a-line2').value.trim(),
          city:       backdrop.querySelector('#pm-a-city').value.trim(),
          county:     backdrop.querySelector('#pm-a-county').value.trim(),
          postcode:   backdrop.querySelector('#pm-a-postcode').value.trim().toUpperCase(),
          country:    (backdrop.querySelector('#pm-a-country').value.trim() || 'GB').toUpperCase(),
          is_default: backdrop.querySelector('#pm-a-default').checked
        };
        await onSubmit(payload);
        closeModal(backdrop);
      } catch (err) {
        alert('Save failed: ' + (err.message || err));
        saveBtn.disabled = false;
        saveBtn.textContent = editing ? 'Save changes' : 'Add address';
      }
    });

    setTimeout(() => {
      const el = editing ? backdrop.querySelector('#pm-a-line1') : backdrop.querySelector('#pm-a-postcode');
      el && el.focus();
    }, 30);
  }

  window.PurhavenModals = { openContactModal, openAddressModal };
})();
