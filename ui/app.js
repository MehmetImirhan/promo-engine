// Promo Engine UI. Money stays a string end to end: prices are displayed as the API returns them.

const $ = (selector, root = document) => root.querySelector(selector);
const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

class ApiError extends Error {
  constructor(status, error) {
    super(error?.message ?? `Request failed (${status})`);
    this.status = status;
    this.details = error?.details;
  }
}

async function request(url, options = {}) {
  let res;
  try {
    res = await fetch(url, options);
  } catch {
    throw new ApiError(0, { message: 'The UI server is not reachable' });
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error);
  return data;
}

const api = (path, { method = 'GET', json, form } = {}) =>
  request(`/api${path}`, {
    method,
    headers: json ? { 'content-type': 'application/json' } : undefined,
    body: json ? JSON.stringify(json) : form,
  });

const lookup = (path) => request(`/lookup/${path}`);

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const fmtDiscount = (type, value) =>
  type === 'PERCENTAGE' ? `−${String(value).replace(/\.00$/, '')}%` : `−${value}`;
const fmtDate = (iso) =>
  new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtCount = (n) => Number(n).toLocaleString();
const shortId = (id) => String(id).slice(0, 8);
const titleCase = (s) => s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');
const toLocalInput = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
const toIso = (value) => {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
};

const TONES = {
  ACTIVE: 'success', COMPLETED: 'success',
  SCHEDULED: 'info', SPLITTING: 'info', SPLIT_DONE: 'info',
  PARTIAL: 'warn', FAILED: 'danger',
};
const STATUS_LABELS = { SPLIT_DONE: 'Processing' };
const statusBadge = (status) =>
  `<span class="badge pip ${TONES[status] ?? ''}">${esc(STATUS_LABELS[status] ?? titleCase(status))}</span>`;

// `columns` holds each cell's class, so placeholders hide on small screens exactly like the real cells.
const skeletonRows = (rows, columns) =>
  Array.from({ length: rows }, () =>
    `<tr>${columns.map((c) => `<td class="${c}"><div class="skeleton"></div><div class="skeleton short"></div></td>`).join('')}</tr>`,
  ).join('');

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

function detailLines(details) {
  if (Array.isArray(details)) return details.map((d) => (d.path ? `${d.path}: ${d.message}` : d.message));
  if (details?.constraint) return [`Blocked by ${details.constraint}`];
  return [];
}

function toast(message, { error = false, details = [] } = {}) {
  const el = document.createElement('div');
  el.className = `toast${error ? ' error' : ''}`;
  el.innerHTML = `<div class="title">${esc(message)}</div>${
    details.length ? `<ul>${details.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : ''
  }`;
  $('#toasts').append(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 200);
  }, error ? 6000 : 3000);
}

const fail = (err) => toast(err.message, { error: true, details: detailLines(err.details) });

// ---------------------------------------------------------------------------
// Categories (names come from the UI server; the API only knows ids)
// ---------------------------------------------------------------------------

const categories = new Map();

async function loadCategories() {
  try {
    const rows = await lookup('categories');
    categories.clear();
    for (const c of rows) categories.set(c.id, c.name);
    $('#category-filter').innerHTML = categoryOptions(products.category, { all: true });
  } catch (err) {
    fail(err);
  }
}

const categoryOptions = (selected = '', { all = false } = {}) =>
  (all ? '<option value="">All categories</option>' : '') +
  [...categories]
    .map(([id, name]) => `<option value="${esc(id)}"${id === selected ? ' selected' : ''}>${esc(name)}</option>`)
    .join('');

const categoryName = (id) => categories.get(id) ?? shortId(id);

// ---------------------------------------------------------------------------
// Modal forms
// ---------------------------------------------------------------------------

const segmented = (name, options, selected) =>
  `<div class="segmented">${options
    .map(([value, label]) =>
      `<label><input type="radio" name="${name}" value="${value}"${value === selected ? ' checked' : ''}><span>${label}</span></label>`)
    .join('')}</div>`;

function openModal({ title, body, submitLabel, onSubmit }) {
  const modal = $('#modal');
  modal.innerHTML = `
    <form class="modal-card" novalidate>
      <div class="modal-head">
        <h2>${esc(title)}</h2>
        <button type="button" class="icon-btn" data-close aria-label="Close">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="modal-body">${body}<div class="form-error" hidden></div></div>
      <div class="modal-foot">
        <button type="button" class="btn ghost" data-close>Cancel</button>
        <button type="submit" class="btn primary">${esc(submitLabel)}</button>
      </div>
    </form>`;

  const form = $('form', modal);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = $('[type="submit"]', form);
    clearFormErrors(form);
    submit.disabled = true;
    try {
      await onSubmit(new FormData(form), form);
      modal.close();
    } catch (err) {
      showFormErrors(form, err);
    } finally {
      submit.disabled = false;
    }
  });

  modal.showModal();
  $('input:not([type="hidden"]):not([type="radio"]), select', form)?.focus();
  return form;
}

function clearFormErrors(form) {
  form.querySelectorAll('.field.invalid').forEach((f) => f.classList.remove('invalid'));
  form.querySelectorAll('.field-error').forEach((e) => e.remove());
  $('.form-error', form).hidden = true;
}

function showFormErrors(form, err) {
  const unplaced = [];
  for (const { path, message } of Array.isArray(err.details) ? err.details : []) {
    const field = form.querySelector(`[name="${CSS.escape(path)}"]`)?.closest('.field');
    if (!field) {
      unplaced.push(message);
      continue;
    }
    field.classList.add('invalid');
    const text = /^Too small: expected string|^Invalid input/.test(message) ? 'Required' : message;
    field.insertAdjacentHTML('beforeend', `<span class="field-error">${esc(text)}</span>`);
  }
  const banner = $('.form-error', form);
  const placedAny = form.querySelector('.field.invalid') !== null;
  if (!placedAny || unplaced.length > 0) {
    banner.textContent = placedAny ? unplaced.join(' ') : err.message;
    banner.hidden = false;
  }
}

// Product search used by the promotion and assign forms.
const pickerHtml = (selected) => `
  <div class="field" data-picker>
    <span>Product</span>
    <input type="hidden" name="product_id" value="${esc(selected?.id ?? '')}">
    <div class="picker-selected"${selected ? '' : ' hidden'}>
      <div><div class="title" data-picked-name>${esc(selected?.name)}</div><div class="sub mono" data-picked-sub>${esc(selected ? `${selected.sku} · ${selected.base_price}` : '')}</div></div>
      <button type="button" class="link" data-picker-change>Change</button>
    </div>
    <div data-picker-search${selected ? ' hidden' : ''}>
      <input type="search" placeholder="Search by name or SKU" autocomplete="off">
      <ul class="picker-results" hidden></ul>
    </div>
  </div>`;

function bindPicker(form) {
  const root = $('[data-picker]', form);
  const hidden = $('input[name="product_id"]', root);
  const selectedBox = $('.picker-selected', root);
  const searchBox = $('[data-picker-search]', root);
  const input = $('input[type="search"]', root);
  const list = $('.picker-results', root);
  let results = [];
  let timer;
  let seq = 0;

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') e.preventDefault();
  });
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = input.value.trim();
      if (!q) {
        list.hidden = true;
        return;
      }
      const mine = ++seq;
      try {
        results = await lookup(`products?q=${encodeURIComponent(q)}`);
      } catch (err) {
        fail(err);
        return;
      }
      if (mine !== seq) return;
      list.innerHTML = results.length
        ? results
            .map((r, i) => `<li><button type="button" data-index="${i}"><span><span class="title">${esc(r.name)}</span><br><span class="sub mono">${esc(r.sku)}</span></span><span class="price">${esc(r.base_price)}</span></button></li>`)
            .join('')
        : '<li class="none">No matching products</li>';
      list.hidden = false;
    }, 200);
  });
  list.addEventListener('click', (e) => {
    const button = e.target.closest('button[data-index]');
    if (!button) return;
    const r = results[Number(button.dataset.index)];
    hidden.value = r.id;
    $('[data-picked-name]', root).textContent = r.name;
    $('[data-picked-sub]', root).textContent = `${r.sku} · ${r.base_price}`;
    selectedBox.hidden = false;
    searchBox.hidden = true;
  });
  $('[data-picker-change]', root).addEventListener('click', () => {
    hidden.value = '';
    selectedBox.hidden = true;
    searchBox.hidden = false;
    input.value = '';
    list.hidden = true;
    input.focus();
  });
}

// "Applies to" toggle shared by the create and assign forms.
function bindScope(form) {
  const sync = () => {
    const scope = new FormData(form).get('scope');
    $('[data-picker]', form).hidden = scope !== 'product';
    $('[data-scope-category]', form).hidden = scope !== 'category';
  };
  form.querySelectorAll('input[name="scope"]').forEach((r) => r.addEventListener('change', sync));
  sync();
}

const scopeFields = (scope, product, categoryId) => `
  <div class="field"><span>Applies to</span>${segmented('scope', [['product', 'Product'], ['category', 'Category']], scope)}</div>
  ${pickerHtml(product)}
  <label class="field" data-scope-category><span>Category</span><select name="category_id">${categoryOptions(categoryId)}</select></label>`;

const scopeBody = (data) =>
  data.get('scope') === 'product' ? { product_id: data.get('product_id') } : { category_id: data.get('category_id') };

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

const products = { order: 'asc', category: '', cursor: null, seq: 0, stale: true };

function productRow(p) {
  const price = p.promotion
    ? `<span class="price-cell"><span class="badge success">${esc(fmtDiscount(p.promotion.type, p.promotion.value))}</span><s class="was">${esc(p.base_price)}</s><span class="price">${esc(p.effective_price)}</span></span>`
    : `<span class="price">${esc(p.effective_price)}</span>`;
  return `
    <tr data-product="${esc(p.id)}" tabindex="0">
      <td><div class="title">${esc(p.name)}</div><div class="sub mono">${esc(p.sku)}</div></td>
      <td class="hide-sm"><span class="chip">${esc(categoryName(p.category_id))}</span></td>
      <td class="num hide-sm">${fmtCount(p.stock_quantity)}</td>
      <td class="num">${price}</td>
    </tr>`;
}

async function loadProducts({ reset }) {
  const body = $('#products-body');
  const more = $('#load-more');
  const seq = reset ? ++products.seq : products.seq;
  if (reset) {
    products.cursor = null;
    body.innerHTML = skeletonRows(8, ['', 'hide-sm', 'hide-sm', '']);
    $('#products-empty').hidden = true;
    more.hidden = true;
    $('#products-meta').textContent = '';
  }
  more.disabled = true;

  const params = new URLSearchParams({ order: products.order, limit: '25' });
  if (products.category) params.set('category_id', products.category);
  if (!reset && products.cursor) params.set('cursor', products.cursor);

  const started = performance.now();
  try {
    const page = await api(`/products?${params}`);
    if (seq !== products.seq) return;
    const html = page.items.map(productRow).join('');
    if (reset) body.innerHTML = html;
    else body.insertAdjacentHTML('beforeend', html);
    products.cursor = page.next_cursor;
    products.stale = false;
    more.hidden = !page.next_cursor;
    $('#products-empty').hidden = body.children.length > 0;
    $('#products-meta').textContent = `${fmtCount(body.children.length)} shown · last page in ${Math.round(performance.now() - started)} ms`;
  } catch (err) {
    if (seq !== products.seq) return;
    if (reset) body.innerHTML = '';
    fail(err);
  } finally {
    more.disabled = false;
  }
}

async function openProduct(id) {
  const drawer = $('#drawer');
  const body = $('#drawer-body');
  body.innerHTML = '<div class="skeleton" style="height:28px;width:60%"></div><div class="skeleton" style="height:44px;width:40%"></div><div class="skeleton" style="height:120px"></div>';
  if (!drawer.open) drawer.showModal();
  try {
    const p = await api(`/products/${id}`);
    const promo = p.promotion;
    body.innerHTML = `
      <div class="detail-head">
        <span class="chip">${esc(categoryName(p.category_id))}</span>
        <h2>${esc(p.name)}</h2>
        <div class="sub mono">${esc(p.sku)}</div>
      </div>
      <div class="price-hero">
        <span class="price-big">${esc(p.effective_price)}</span>
        ${promo ? `<s class="was">${esc(p.base_price)}</s><span class="badge success">${esc(fmtDiscount(promo.type, promo.value))}</span>` : '<span class="sub">Base price, no active promotion</span>'}
      </div>
      ${promo ? `<div class="callout"><div class="label">Applied promotion</div><div class="title">${esc(promo.name)}</div><div class="sub">${promo.type === 'PERCENTAGE' ? 'Percentage' : 'Fixed amount'} · ${esc(fmtDiscount(promo.type, promo.value))}</div></div>` : ''}
      <dl class="facts">
        <div><dt>Base price</dt><dd>${esc(p.base_price)}</dd></div>
        <div><dt>Stock</dt><dd>${fmtCount(p.stock_quantity)}</dd></div>
        <div><dt>Created</dt><dd>${esc(fmtDate(p.created_at))}</dd></div>
        <div><dt>Updated</dt><dd>${esc(fmtDate(p.updated_at))}</dd></div>
        <div class="wide"><dt>ID</dt><dd class="mono">${esc(p.id)}</dd></div>
      </dl>
      <div><button class="btn primary" type="button" data-promote>Add promotion</button></div>`;
    $('[data-promote]', body).addEventListener('click', () => {
      drawer.close();
      openPromotionForm({ product: p });
    });
  } catch (err) {
    drawer.close();
    fail(err);
  }
}

function openProductForm() {
  openModal({
    title: 'New product',
    submitLabel: 'Create product',
    body: `
      <label class="field"><span>Name</span><input name="name" maxlength="200" placeholder="Leather card holder"></label>
      <div class="grid-2">
        <label class="field"><span>SKU</span><input name="sku" maxlength="64" class="mono" placeholder="ACC-0001"></label>
        <label class="field"><span>Category</span><select name="category_id">${categoryOptions(products.category)}</select></label>
        <label class="field"><span>Base price</span><input name="base_price" inputmode="decimal" placeholder="49.99"></label>
        <label class="field"><span>Stock</span><input name="stock_quantity" type="number" min="0" step="1" value="0"></label>
      </div>`,
    onSubmit: async (data) => {
      const created = await api('/products', {
        method: 'POST',
        json: {
          name: data.get('name'),
          sku: data.get('sku'),
          category_id: data.get('category_id'),
          base_price: String(data.get('base_price')).trim(),
          stock_quantity: Number.parseInt(String(data.get('stock_quantity')), 10) || 0,
        },
      });
      toast(`Created ${created.name} at ${created.effective_price}`);
      products.stale = true;
      loadProducts({ reset: true });
    },
  });
}

$('#new-product').addEventListener('click', openProductForm);
$('#load-more').addEventListener('click', () => loadProducts({ reset: false }));
$('#category-filter').addEventListener('change', (e) => {
  products.category = e.target.value;
  loadProducts({ reset: true });
});
document.querySelectorAll('input[name="order"]').forEach((radio) =>
  radio.addEventListener('change', (e) => {
    products.order = e.target.value;
    loadProducts({ reset: true });
  }),
);
$('#products-body').addEventListener('click', (e) => {
  const row = e.target.closest('tr[data-product]');
  if (row) openProduct(row.dataset.product);
});
$('#products-body').addEventListener('keydown', (e) => {
  const row = e.target.closest('tr[data-product]');
  if (row && e.key === 'Enter') openProduct(row.dataset.product);
});

// ---------------------------------------------------------------------------
// Promotions
// ---------------------------------------------------------------------------

const promotions = new Map();

function promotionRow(pr) {
  const target = pr.product_id
    ? `<div class="title">${esc(pr.product_name)}</div><div class="sub mono">${esc(pr.product_sku)}</div>`
    : `<div class="title">${esc(pr.category_name)}</div><div class="sub">Entire category</div>`;
  const live = pr.state === 'ACTIVE' || pr.state === 'SCHEDULED';
  return `
    <tr>
      <td><div class="title">${esc(pr.name)}</div><div class="sub">${pr.product_id ? 'Product' : 'Category'} scope</div></td>
      <td>${target}</td>
      <td><span class="badge success">${esc(fmtDiscount(pr.discount_type, pr.value))}</span></td>
      <td class="hide-sm"><div class="sub nowrap">${esc(fmtDate(pr.starts_at))} – ${esc(fmtDate(pr.ends_at))}</div></td>
      <td>${statusBadge(pr.state)}</td>
      <td class="actions">${live ? `<button class="btn ghost sm" type="button" data-assign="${esc(pr.id)}">Assign</button><button class="btn ghost sm danger" type="button" data-cancel="${esc(pr.id)}">Cancel</button>` : ''}</td>
    </tr>`;
}

async function loadPromotions() {
  const body = $('#promotions-body');
  if (promotions.size === 0) body.innerHTML = skeletonRows(5, ['', '', '', 'hide-sm', '', '']);
  try {
    const rows = await lookup('promotions');
    promotions.clear();
    for (const r of rows) promotions.set(r.id, r);
    body.innerHTML = rows.map(promotionRow).join('');
    $('#promotions-empty').hidden = rows.length > 0;
  } catch (err) {
    body.innerHTML = '';
    fail(err);
  }
}

function openPromotionForm({ product } = {}) {
  const now = new Date();
  const form = openModal({
    title: 'New promotion',
    submitLabel: 'Create promotion',
    body: `
      <label class="field"><span>Name</span><input name="name" maxlength="200" placeholder="Summer flash sale"></label>
      ${scopeFields(product ? 'product' : 'category', product, products.category)}
      <div class="grid-2">
        <div class="field"><span>Discount</span>${segmented('discount_type', [['PERCENTAGE', 'Percentage'], ['FIXED', 'Fixed amount']], 'PERCENTAGE')}</div>
        <label class="field"><span>Value</span><div class="affix"><input name="value" inputmode="decimal" placeholder="15"><span data-affix>%</span></div></label>
        <label class="field"><span>Starts</span><input type="datetime-local" name="starts_at" value="${toLocalInput(now)}"></label>
        <label class="field"><span>Ends</span><input type="datetime-local" name="ends_at" value="${toLocalInput(new Date(now.getTime() + 7 * 86_400_000))}"></label>
      </div>`,
    onSubmit: async (data) => {
      const created = await api('/promotions', {
        method: 'POST',
        json: {
          name: data.get('name'),
          ...scopeBody(data),
          discount_type: data.get('discount_type'),
          value: String(data.get('value')).trim(),
          starts_at: toIso(data.get('starts_at')),
          ends_at: toIso(data.get('ends_at')),
        },
      });
      toast(`Promotion “${created.name}” created`);
      products.stale = true;
      if (currentView() === 'promotions') loadPromotions();
      else if (currentView() === 'products') loadProducts({ reset: true });
    },
  });
  bindPicker(form);
  bindScope(form);
  form.querySelectorAll('input[name="discount_type"]').forEach((r) =>
    r.addEventListener('change', (e) => {
      $('[data-affix]', form).hidden = e.target.value !== 'PERCENTAGE';
    }),
  );
}

function openAssignForm(promotion) {
  const form = openModal({
    title: `Assign “${promotion.name}”`,
    submitLabel: 'Assign',
    body: scopeFields(promotion.product_id ? 'product' : 'category', null, promotion.category_id ?? ''),
    onSubmit: async (data) => {
      await api(`/promotions/${promotion.id}/assign`, { method: 'POST', json: scopeBody(data) });
      toast('Promotion re-assigned');
      products.stale = true;
      loadPromotions();
    },
  });
  bindPicker(form);
  bindScope(form);
}

$('#new-promotion').addEventListener('click', () => openPromotionForm());
$('#promotions-body').addEventListener('click', async (e) => {
  const assign = e.target.closest('[data-assign]');
  if (assign) return openAssignForm(promotions.get(assign.dataset.assign));

  const cancel = e.target.closest('[data-cancel]');
  if (!cancel) return;
  // Two-step: the first click arms the button, the second one cancels.
  if (!cancel.classList.contains('confirm')) {
    cancel.classList.add('confirm');
    cancel.textContent = 'Confirm';
    setTimeout(() => {
      cancel.classList.remove('confirm');
      cancel.textContent = 'Cancel';
    }, 3000);
    return;
  }
  cancel.disabled = true;
  try {
    await api(`/promotions/${cancel.dataset.cancel}/cancel`, { method: 'POST' });
    toast('Promotion cancelled');
    products.stale = true;
    loadPromotions();
  } catch (err) {
    cancel.disabled = false;
    fail(err);
  }
});

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

const TERMINAL = new Set(['COMPLETED', 'PARTIAL', 'FAILED']);
const HOVER_HINT = 'Hover a chunk for its rows';
const ingest = { selected: null, timer: null, run: 0, watching: new Set(), gridJob: null, cells: [], chunks: [], ghost: null };

const fmtBytes = (n) => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const fmtDuration = (ms) =>
  ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.floor((ms % 60_000) / 1000)} s`;
const elapsedMs = (job) => new Date(job.completed_at ?? Date.now()).getTime() - new Date(job.created_at).getTime();
const isSplitting = (job) => job.status === 'PENDING' || job.status === 'SPLITTING';
const progressTone = (job) =>
  job.status === 'COMPLETED' ? 'done' : job.status === 'PARTIAL' || job.status === 'FAILED' ? 'warn' : '';

function jobSummary(job) {
  const { total, DONE: done, FAILED: failed } = job.chunks;
  const processed = job.rows.valid + job.rows.invalid;
  switch (job.status) {
    case 'PENDING':
      return 'Queued. Waiting for a worker to start splitting the file.';
    case 'SPLITTING':
      return `Splitting the file: ${fmtCount(total)} chunks written so far, ${fmtCount(done)} already processed.`;
    case 'SPLIT_DONE':
      return `File split into ${fmtCount(total)} chunks. Processing, ${fmtCount(done)} done.`;
    case 'COMPLETED':
      return `Completed in ${fmtDuration(elapsedMs(job))}, ${fmtCount(Math.round(processed / Math.max(elapsedMs(job) / 1000, 0.001)))} rows per second.`;
    case 'PARTIAL':
      return `Finished with ${fmtCount(failed)} failed chunk${failed === 1 ? '' : 's'} after every retry.`;
    default:
      return job.error ?? 'The file could not be split.';
  }
}

function jobRow(job) {
  const { total, DONE: done } = job.chunks;
  return `
    <tr data-job="${esc(job.id)}"${job.id === ingest.selected ? ' aria-selected="true"' : ''}>
      <td><div class="title">${esc(job.vendor_id)}</div><div class="sub"><span class="mono">${esc(shortId(job.id))}</span> · ${esc(fmtDate(job.created_at))}</div></td>
      <td>${statusBadge(job.status)}</td>
      <td><div class="progress ${progressTone(job)}"><div class="bar" style="width:${total ? (done / total) * 100 : 0}%"></div></div><div class="sub">${fmtCount(done)} of ${fmtCount(total)} chunks</div></td>
      <td class="num hide-sm"><div>${fmtCount(job.rows.applied)} applied</div><div class="sub">${fmtCount(job.rows.invalid)} invalid</div></td>
    </tr>`;
}

function renderJob(job, chunks) {
  const { total, DONE: done } = job.chunks;
  $('#job-card').hidden = false;
  $('#job-vendor').textContent = job.vendor_id;
  $('#job-id').textContent = shortId(job.id);
  $('#job-status').innerHTML = statusBadge(job.status);
  $('#job-summary').textContent = jobSummary(job);
  // Replay also rescues a split that stalled (a lost message or a crashed worker); the API re-enqueues it.
  const stalled = isSplitting(job) && Date.now() - new Date(job.updated_at).getTime() > 30_000;
  $('#job-replay').hidden = !(job.status === 'PARTIAL' || job.chunks.FAILED > 0 || stalled);

  const progress = $('#job-progress');
  progress.className = `progress wide ${progressTone(job)}${TERMINAL.has(job.status) ? '' : ' live'}`;
  $('.bar', progress).style.width = `${total ? (done / total) * 100 : 0}%`;

  $('#job-stats').innerHTML = [
    ['Chunks', `${fmtCount(done)} / ${fmtCount(total)}`],
    ['Rows split', fmtCount(job.rows.total)],
    ['Applied', fmtCount(job.rows.applied)],
    ['Invalid', fmtCount(job.rows.invalid)],
    ['Elapsed', fmtDuration(elapsedMs(job))],
  ].map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`).join('');

  renderChunks(job, chunks);
}

// One square per chunk. Cells are updated in place so colour changes animate instead of redrawing.
function renderChunks(job, chunks) {
  const grid = $('#chunk-grid');
  if (ingest.gridJob !== job.id) {
    ingest.gridJob = job.id;
    ingest.cells = [];
    ingest.ghost = Object.assign(document.createElement('span'), { className: 'chunk ghost' });
    grid.replaceChildren(ingest.ghost);
    $('#chunk-detail').textContent = HOVER_HINT;
  }
  ingest.chunks = chunks;
  for (const chunk of chunks) {
    let cell = ingest.cells[chunk.chunk_index];
    if (!cell) {
      cell = document.createElement('span');
      cell.className = 'chunk';
      cell.dataset.index = String(chunk.chunk_index);
      ingest.cells[chunk.chunk_index] = cell;
      ingest.ghost.before(cell);
    }
    cell.dataset.status = chunk.status.toLowerCase();
  }
  // The pulsing outline is the next chunk the splitter has not written yet.
  ingest.ghost.hidden = !isSplitting(job);
  grid.classList.toggle('roomy', chunks.length <= 120);
  if (chunks.length === 0 && !isSplitting(job)) $('#chunk-detail').textContent = 'No chunks were written';
}

async function refreshIngest() {
  clearTimeout(ingest.timer);
  const run = ++ingest.run;
  const body = $('#jobs-body');
  if (!body.children.length) body.innerHTML = skeletonRows(3, ['', '', '', 'hide-sm']);
  try {
    const ids = await lookup('jobs');
    const jobs = await Promise.all(ids.map(({ id }) => api(`/ingest/jobs/${id}`)));
    ingest.selected ??= jobs[0]?.id ?? null;
    const selected = ingest.selected
      ? jobs.find((j) => j.id === ingest.selected) ?? (await api(`/ingest/jobs/${ingest.selected}`))
      : null;
    const chunks = selected ? await lookup(`chunks?job=${selected.id}`) : [];
    if (run !== ingest.run) return;

    body.innerHTML = jobs.map(jobRow).join('');
    $('#jobs-empty').hidden = jobs.length > 0;
    $('#worker-note').hidden = !jobs.some((j) => j.status === 'PENDING' && Date.now() - new Date(j.created_at).getTime() > 5000);
    if (selected) renderJob(selected, chunks);
    else $('#job-card').hidden = true;

    // A job that finished while we watched it changed the catalog: refresh products and category names.
    const all = selected && !jobs.includes(selected) ? [...jobs, selected] : jobs;
    if (all.some((j) => TERMINAL.has(j.status) && ingest.watching.has(j.id))) {
      products.stale = true;
      loadCategories();
    }
    ingest.watching = new Set(all.filter((j) => !TERMINAL.has(j.status)).map((j) => j.id));
    if (ingest.watching.size > 0 && currentView() === 'ingest') ingest.timer = setTimeout(refreshIngest, 1000);
  } catch (err) {
    if (run === ingest.run) fail(err);
  }
}

// fetch() cannot report upload progress; XMLHttpRequest can.
function uploadWithProgress(form, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/ingest/jobs');
    xhr.responseType = 'json';
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    });
    xhr.addEventListener('load', () =>
      xhr.status < 400 ? resolve(xhr.response) : reject(new ApiError(xhr.status, xhr.response?.error)));
    xhr.addEventListener('error', () => reject(new ApiError(0, { message: 'Upload failed: the UI server is not reachable' })));
    xhr.send(form);
  });
}

const dropzone = $('#dropzone');
const fileInput = $('input[type="file"]', dropzone);
const showFile = () => {
  const file = fileInput.files[0];
  $('#file-label').textContent = file ? `${file.name} · ${fmtBytes(file.size)}` : 'Drop a CSV here or click to browse';
  dropzone.classList.toggle('has-file', Boolean(file));
};
fileInput.addEventListener('change', showFile);
dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('over');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('over'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('over');
  if (e.dataTransfer.files.length) {
    fileInput.files = e.dataTransfer.files;
    showFile();
  }
});

$('#upload-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const file = fileInput.files[0];
  if (!file) return toast('Choose a CSV file first', { error: true });
  const data = new FormData();
  data.append('vendor_id', e.target.vendor_id.value);
  data.append('file', file);

  const submit = $('[type="submit"]', e.target);
  const progress = $('#upload-progress');
  const bar = $('.bar', progress);
  const text = $('#upload-progress-text');
  submit.disabled = true;
  bar.style.width = '0%';
  text.textContent = 'Starting upload';
  progress.hidden = false;
  try {
    const job = await uploadWithProgress(data, (sent, total) => {
      bar.style.width = `${(sent / total) * 100}%`;
      text.textContent = sent < total ? `Uploading ${fmtBytes(sent)} of ${fmtBytes(total)}` : 'Storing the file';
    });
    toast(job.created ? 'Upload accepted, job queued' : 'This file was already ingested for this vendor');
    fileInput.value = '';
    showFile();
    ingest.selected = job.id;
    await refreshIngest();
    $('#job-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    fail(err);
  } finally {
    submit.disabled = false;
    progress.hidden = true;
  }
});

$('#refresh-jobs').addEventListener('click', refreshIngest);
$('#jobs-body').addEventListener('click', (e) => {
  const row = e.target.closest('tr[data-job]');
  if (!row) return;
  ingest.selected = row.dataset.job;
  refreshIngest();
});
$('#job-replay').addEventListener('click', async (e) => {
  const button = e.currentTarget;
  button.disabled = true;
  try {
    const result = await api(`/ingest/jobs/${ingest.selected}/replay-failed`, { method: 'POST' });
    const n = result.replayed_chunks.length;
    toast(result.split_reenqueued && n === 0 ? 'Split re-enqueued' : `Re-enqueued ${n} chunk${n === 1 ? '' : 's'}`);
    refreshIngest();
  } catch (err) {
    fail(err);
  } finally {
    button.disabled = false;
  }
});

const chunkGrid = $('#chunk-grid');
chunkGrid.addEventListener('mouseover', (e) => {
  const cell = e.target.closest('.chunk[data-index]');
  const chunk = cell && ingest.chunks.find((c) => c.chunk_index === Number(cell.dataset.index));
  if (!chunk) return;
  const parts = [`Chunk #${chunk.chunk_index}`, titleCase(chunk.status), `${fmtCount(chunk.row_count)} rows`];
  if (chunk.status === 'DONE') parts.push(`${fmtCount(chunk.rows_applied)} applied`, `${fmtCount(chunk.rows_invalid)} invalid`);
  if (chunk.attempts > 1 || chunk.status === 'FAILED') parts.push(`attempt ${chunk.attempts}`);
  if (chunk.error) parts.push(chunk.error);
  $('#chunk-detail').textContent = parts.join(' · ');
});
chunkGrid.addEventListener('mouseleave', () => {
  if (ingest.chunks.length > 0) $('#chunk-detail').textContent = HOVER_HINT;
});

// ---------------------------------------------------------------------------
// Dialog chrome, health, routing
// ---------------------------------------------------------------------------

for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog || e.target.closest('[data-close]')) dialog.close();
  });
}

async function checkHealth() {
  const el = $('#status');
  const set = (state, text) => {
    el.dataset.state = state;
    $('.status-text', el).textContent = text;
  };
  try {
    const res = await fetch('/api/ready');
    const body = await res.json();
    if (res.ok) set('ok', 'Connected');
    else if (body.checks) set('warn', `Degraded: ${Object.entries(body.checks).filter(([, s]) => s !== 'ok').map(([k]) => k).join(', ')}`);
    else set('down', 'API offline');
  } catch {
    set('down', 'UI server offline');
  }
}

const VIEWS = ['products', 'promotions', 'ingest'];
const currentView = () => (VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'products');

function route() {
  const view = currentView();
  for (const v of VIEWS) $(`#view-${v}`).hidden = v !== view;
  document.querySelectorAll('[data-tab]').forEach((tab) => {
    if (tab.dataset.tab === view) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  });
  clearTimeout(ingest.timer);
  if (view === 'products' && products.stale) loadProducts({ reset: true });
  if (view === 'promotions') loadPromotions();
  if (view === 'ingest') refreshIngest();
}

window.addEventListener('hashchange', route);
checkHealth();
setInterval(checkHealth, 10_000);
await loadCategories();
route();
