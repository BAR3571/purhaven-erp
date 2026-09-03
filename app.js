// Shared shell: auth check, top nav with global search, logout.
// Each page sets <body data-page="...">.

const NAV = [
  { key: 'warehouse', href: '/',                       label: '🏭 Warehouse' },
  { key: 'customers', href: '/customers',              label: '👥 Customers' },
  { key: 'suppliers', href: '/suppliers',              label: '🏷️ Suppliers' },
  { key: 'orders',    href: '/orders/sales-orders',    label: '📦 Orders' },
  { key: 'products',  href: '/products',               label: '🧰 Products & Stock' },
  { key: 'accounts',  href: '/accounts',               label: '💷 Accounts' },
  { key: 'reports',   href: '/reports',                label: '📋 Reports' }
];

const ORDERS_TABS = [
  { key: 'sales-orders',    href: '/orders/sales-orders',    label: '📦 Sales Orders' },
  { key: 'purchase-orders', href: '/orders/purchase-orders', label: '📋 Purchase Orders' },
  { key: 'goods-in',        href: '/orders/goods-in',        label: '🛒 Goods In' },
  { key: 'despatch',        href: '/orders/despatch',        label: '🚚 Despatch' },
  { key: 'scan',            href: '/orders/scan',            label: '🧷 Scan' }
];

const TYPE_LABEL = {
  customer: '👥 Customer',
  supplier: '🏷️ Supplier',
  product:  '🧰 Product',
  sales_order:    '📦 Sales order',
  purchase_order: '📋 Purchase order',
  despatch: '🚚 Despatch'
};

export function renderOrdersTabs(activeTab) {
  return ORDERS_TABS.map(t =>
    `<a class="orders-tab ${t.key === activeTab ? 'active' : ''}" href="${t.href}">${t.label}</a>`
  ).join('');
}

function renderTopbar(active) {
  const navLinks = NAV.map(item =>
    `<a href="${item.href}" class="${item.key === active ? 'active' : ''}">${item.label}</a>`
  ).join('');
  return `
    <header class="topbar">
      <a href="/" class="brand"><span class="dot"></span>PurHaven</a>
      <div class="global-search">
        <input type="search" id="global-q" placeholder="🔍 Search customers, suppliers, products… (⌘K)" autocomplete="off">
        <div id="global-results" class="global-results"></div>
      </div>
      <nav>${navLinks}</nav>
      <div class="right">
        <a href="https://www.purhaven.co.uk" target="_blank" rel="noopener" class="back-link">← purhaven.co.uk</a>
        <span class="user" id="user">…</span>
        <button class="btn btn-ghost" id="logout-btn">Sign out</button>
      </div>
    </header>
  `;
}

function wireGlobalSearch() {
  const input = document.getElementById('global-q');
  const results = document.getElementById('global-results');
  let timer;
  let cur = -1;
  let items = [];

  function close() { results.classList.remove('open'); results.innerHTML = ''; cur = -1; items = []; }

  function render(d) {
    if (!d.results || d.results.length === 0) {
      results.innerHTML = '<div class="global-empty">No matches</div>';
      results.classList.add('open');
      items = [];
      cur = -1;
      return;
    }
    items = d.results;
    cur = -1;
    results.innerHTML = items.map((r, i) => `
      <a class="global-hit" data-i="${i}" href="${r.href}">
        <span class="global-type">${TYPE_LABEL[r.type] || r.type}</span>
        <span class="global-label">${(r.label || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')}</span>
        <span class="global-sub">${(r.sub || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')}</span>
      </a>
    `).join('');
    results.classList.add('open');
  }

  async function run() {
    const q = input.value.trim();
    if (q.length < 2) { close(); return; }
    try {
      const r = await fetch('/api/search?q=' + encodeURIComponent(q));
      const d = await r.json();
      if (!d.ok) { close(); return; }
      render(d);
    } catch { close(); }
  }

  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 150); });
  input.addEventListener('focus', () => { if (input.value.trim().length >= 2) run(); });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { close(); input.blur(); return; }
    if (!items.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      cur = (cur + 1) % items.length;
      Array.from(results.querySelectorAll('.global-hit')).forEach((el, i) =>
        el.classList.toggle('active', i === cur));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      cur = (cur - 1 + items.length) % items.length;
      Array.from(results.querySelectorAll('.global-hit')).forEach((el, i) =>
        el.classList.toggle('active', i === cur));
    } else if (e.key === 'Enter' && cur >= 0) {
      e.preventDefault();
      window.location.href = items[cur].href;
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.global-search')) close();
  });

  document.addEventListener('keydown', (e) => {
    const cmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k';
    if (cmdK) { e.preventDefault(); input.focus(); input.select(); }
  });
}

export async function mountShell() {
  const active = document.body.dataset.page || '';
  const shell = document.createElement('div');
  shell.className = 'app-shell';

  const existing = document.body.innerHTML;
  document.body.innerHTML = '';
  document.body.appendChild(shell);

  shell.innerHTML = renderTopbar(active) + '<main></main>';
  shell.querySelector('main').innerHTML = existing;

  document.getElementById('logout-btn').addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/login';
  });

  wireGlobalSearch();

  try {
    const r = await fetch('/api/auth/me');
    const d = await r.json();
    if (!d.ok) { window.location.href = '/login'; return null; }
    document.getElementById('user').textContent = d.name || d.email;
    return d;
  } catch {
    window.location.href = '/login';
    return null;
  }
}

export function pill(status) {
  const safe = (status || '').toString().toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `<span class="pill pill-${safe}">${status || '—'}</span>`;
}

export function fmt(v) {
  if (v === null || v === undefined || v === '') return '<span style="color:var(--ink-dim)">—</span>';
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function money(pence, currency = 'GBP') {
  if (pence === null || pence === undefined) return '—';
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(pence / 100);
}

export function dateOnly(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB');
}

/**
 * Mount a barcode-scan input panel. Works with USB/Bluetooth scanners (which type
 * a string + Enter) and with manual typing. Returns { destroy, focus, clear }.
 *
 * opts:
 *   container   — DOM element to render into (required)
 *   label       — small heading above the input (default 'Scan')
 *   placeholder — input placeholder (default 'Scan barcode or type and press Enter…')
 *   onScan(value, helpers) — async callback when Enter is hit. value is the trimmed
 *                            barcode string. helpers = { flashOk(msg?), flashErr(msg) }.
 *                            Returning false (or throwing) auto-flashes red.
 */
export function mountScanPanel(container, opts = {}) {
  const label = opts.label || 'Scan';
  const placeholder = opts.placeholder || 'Scan barcode or type and press Enter…';
  const wrap = document.createElement('div');
  wrap.className = 'scan-panel';
  wrap.innerHTML = `
    <div class="scan-row">
      <span class="scan-icon" aria-hidden="true">⌧</span>
      <div class="scan-stack">
        <label>${label}</label>
        <input type="text" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="${placeholder}">
      </div>
      <div class="scan-feedback" role="status" aria-live="polite"></div>
    </div>
  `;
  container.appendChild(wrap);

  const input = wrap.querySelector('input');
  const fb = wrap.querySelector('.scan-feedback');
  let flashTimer = null;

  function setFeedback(text, kind) {
    fb.textContent = text || '';
    fb.dataset.kind = kind || '';
    if (flashTimer) clearTimeout(flashTimer);
    if (text) flashTimer = setTimeout(() => { fb.textContent = ''; fb.dataset.kind = ''; }, 2500);
  }

  const helpers = {
    flashOk: (msg) => setFeedback(msg || 'OK', 'ok'),
    flashErr: (msg) => setFeedback(msg || 'Not recognised', 'err')
  };

  input.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const value = input.value.trim();
    if (!value) return;
    input.value = '';
    try {
      const result = await opts.onScan?.(value, helpers);
      if (result === false) helpers.flashErr();
    } catch (err) {
      helpers.flashErr(err?.message || 'Scan failed');
    } finally {
      input.focus();
    }
  });

  // Auto-focus shortly after mount
  setTimeout(() => input.focus(), 50);

  return {
    destroy: () => wrap.remove(),
    focus: () => input.focus(),
    clear: () => { input.value = ''; setFeedback('', ''); }
  };
}

/**
 * Search-as-you-type product picker modal.
 * Resolves with { product, qty } when the user confirms, or null on cancel/Esc.
 * opts: { title?, confirmLabel?, defaultQty?, askQty? = true }
 */
export function openProductPicker(opts = {}) {
  return new Promise((resolve) => {
    const title = opts.title || 'Pick a product';
    const askQty = opts.askQty !== false;
    const defaultQty = opts.defaultQty ?? 1;

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal-card" style="max-width:580px;" onclick="event.stopPropagation()">
        <button type="button" class="x" data-close>×</button>
        <h2 style="margin:0 0 4px;">${title.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</h2>
        <p style="margin:0 0 12px;color:var(--ink-soft);font-size:0.85rem;">Type a SKU, barcode, or product name. ↑↓ to navigate, Enter to pick.</p>
        <input id="pp-q" type="search" placeholder="🔍 Search products…" autocomplete="off"
               style="width:100%;padding:9px 12px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--ink);font-size:0.95rem;margin-bottom:6px;">
        <div id="pp-results" class="alloc-list" style="max-height:280px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--surface-2);"></div>
        <div id="pp-selected" style="margin-top:12px;padding:10px;background:var(--surface-2);border-radius:8px;display:none;">
          <div style="font-size:0.78rem;color:var(--ink-dim);text-transform:uppercase;letter-spacing:0.05em;">Selected</div>
          <div id="pp-sel-text"></div>
          ${askQty ? `<div style="margin-top:8px;display:flex;gap:10px;align-items:center;">
            <label style="font-size:0.85rem;color:var(--ink-soft);">Qty</label>
            <input id="pp-qty" type="number" min="1" value="${defaultQty}" style="width:90px;text-align:right;padding:6px 10px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);">
          </div>` : ''}
        </div>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;">
          <button type="button" class="btn btn-ghost" data-close>Cancel</button>
          <button type="button" class="btn btn-primary" id="pp-confirm" disabled>${opts.confirmLabel || 'Add'}</button>
        </div>
      </div>
    `;

    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop || e.target.dataset.close !== undefined) close(null);
    });
    document.body.appendChild(backdrop);

    const qInput = backdrop.querySelector('#pp-q');
    const resultsEl = backdrop.querySelector('#pp-results');
    const selectedEl = backdrop.querySelector('#pp-selected');
    const selTextEl = backdrop.querySelector('#pp-sel-text');
    const qtyEl = backdrop.querySelector('#pp-qty');
    const confirmBtn = backdrop.querySelector('#pp-confirm');

    let items = [];
    let cur = -1;
    let selected = null;
    let timer;

    function close(value) {
      backdrop.remove();
      resolve(value);
    }

    function render() {
      if (items.length === 0) {
        resultsEl.innerHTML = '<div style="padding:14px;color:var(--ink-dim);text-align:center;">Type to search products</div>';
        return;
      }
      resultsEl.innerHTML = items.map((p, i) => {
        const thumb = p.image_url
          ? `<img src="${p.image_url}" style="width:36px;height:36px;object-fit:contain;border-radius:6px;background:var(--bg);">`
          : `<div style="width:36px;height:36px;border-radius:6px;background:var(--bg);border:1px dashed var(--border);"></div>`;
        const onHand = parseInt(p.qty_on_hand_total || 0, 10);
        const allocated = parseInt(p.qty_allocated_total || 0, 10);
        const available = onHand - allocated;
        const price = p.sale_price_pence != null
          ? new Intl.NumberFormat('en-GB',{style:'currency',currency:p.currency||'GBP'}).format(p.sale_price_pence/100)
          : '—';
        return `
          <div class="pp-item ${i === cur ? 'active' : ''}" data-i="${i}"
               style="display:grid;grid-template-columns:auto 1fr auto;gap:10px;padding:8px 10px;cursor:pointer;border-bottom:1px solid var(--border-soft);">
            ${thumb}
            <div>
              <strong style="font-family:ui-monospace,Menlo,monospace;">${(p.sku||'').replace(/&/g,'&amp;').replace(/</g,'&lt;')}</strong> · ${(p.name||'').replace(/&/g,'&amp;').replace(/</g,'&lt;')}
              <div style="color:var(--ink-dim);font-size:0.78rem;">on hand: ${onHand}${allocated ? ` (alloc ${allocated}, avail ${available})` : ''} · ${price}</div>
            </div>
            ${p.requires_serial ? '<span class="pill pill-confirmed" style="font-size:0.62rem;align-self:start;">SN</span>' : ''}
          </div>
        `;
      }).join('');
      resultsEl.querySelectorAll('.pp-item.active').forEach(el => el.scrollIntoView({ block: 'nearest' }));
    }

    function select(idx) {
      selected = items[idx] || null;
      if (!selected) { selectedEl.style.display = 'none'; confirmBtn.disabled = true; return; }
      selectedEl.style.display = 'block';
      selTextEl.innerHTML = `<strong style="font-family:ui-monospace,Menlo,monospace;">${(selected.sku||'').replace(/&/g,'&amp;').replace(/</g,'&lt;')}</strong> — ${(selected.name||'').replace(/&/g,'&amp;').replace(/</g,'&lt;')}`;
      confirmBtn.disabled = false;
      if (qtyEl) qtyEl.focus();
    }

    async function runSearch() {
      const q = qInput.value.trim();
      if (q.length < 1) { items = []; cur = -1; render(); return; }
      const r = await fetch('/api/products?q=' + encodeURIComponent(q));
      const d = await r.json();
      if (!d.ok) { items = []; render(); return; }
      items = d.products;
      cur = items.length > 0 ? 0 : -1;
      render();
    }

    qInput.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(runSearch, 150); });
    qInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(null); return; }
      if (!items.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); cur = (cur + 1) % items.length; render(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); cur = (cur - 1 + items.length) % items.length; render(); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        if (cur >= 0) { select(cur); }
      }
    });

    resultsEl.addEventListener('click', (e) => {
      const item = e.target.closest('[data-i]');
      if (!item) return;
      cur = parseInt(item.dataset.i, 10);
      render();
      select(cur);
    });

    confirmBtn.addEventListener('click', () => {
      if (!selected) return;
      const qty = qtyEl ? parseInt(qtyEl.value, 10) || 1 : 1;
      close({ product: selected, qty });
    });

    qInput.focus();
    render();
  });
}
