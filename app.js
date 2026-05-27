// Shared shell: auth check, top nav with global search, logout.
// Each page sets <body data-page="...">.

const NAV = [
  { key: 'warehouse', href: '/',                       label: '🏭 Warehouse' },
  { key: 'customers', href: '/customers',              label: '👥 Customers' },
  { key: 'suppliers', href: '/suppliers',              label: '🏷️ Suppliers' },
  { key: 'orders',    href: '/orders/sales-orders',    label: '📦 Orders' },
  { key: 'products',  href: '/products',               label: '🧰 Products & Stock' },
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
