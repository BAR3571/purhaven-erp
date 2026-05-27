// Shared shell: auth check, top nav, logout. Each page sets <body data-page="...">.

const NAV = [
  { key: 'warehouse', href: '/',           label: '🏭 Warehouse' },
  { key: 'customers', href: '/customers',  label: '👥 Customers' },
  { key: 'suppliers', href: '/suppliers',  label: '🏷️ Suppliers' },
  { key: 'orders',    href: '/orders',     label: '📦 Orders' },
  { key: 'products',  href: '/products',   label: '🧰 Products & Stock' },
  { key: 'reports',   href: '/reports',    label: '📋 Reports' }
];

function renderTopbar(active) {
  const navLinks = NAV.map(item =>
    `<a href="${item.href}" class="${item.key === active ? 'active' : ''}">${item.label}</a>`
  ).join('');
  return `
    <header class="topbar">
      <a href="/" class="brand"><span class="dot"></span>Purhaven</a>
      <nav>${navLinks}</nav>
      <div class="right">
        <a href="https://www.purhaven.co.uk" target="_blank" rel="noopener" class="back-link">← purhaven.co.uk</a>
        <span class="user" id="user">…</span>
        <button class="btn btn-ghost" id="logout-btn">Sign out</button>
      </div>
    </header>
  `;
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
