'use strict';
/* Мини-касса — фронтенд. Настройки — в config.js. */

const CFG = Object.assign({
  API_URL: '',
  IDLE_LOGOUT_MIN: { seller: 30, manager: 10, admin: 10 },
  SYNC_INTERVAL_SEC: 30,
  CATALOG_REFRESH_MIN: 5,
  PHOTO_MAX_PX: 600,
  PHOTO_QUALITY: 0.8,
}, window.APP_CONFIG || {});

const ROLE_LEVEL = { seller: 1, manager: 2, admin: 3 };
const ROLE_RU = { seller: 'Продавец', manager: 'Менеджер', admin: 'Админ' };
const TABS = [
  ['kassa', 'Касса', 1],
  ['products', 'Товары', 2],
  ['purchases', 'Закупы', 2],
  ['debts', 'Долги', 2],
  ['report', 'Отчёт', 2],
  ['settings', 'Настройки', 2],
];

const S = {
  user: null, token: null, cat: null, index: [],
  view: 'kassa', group: null, query: '',
  cart: [], payment: 'Наличные', client: '', received: '',
  purchase: { supplier: '', lines: [], paid: '', paidTouched: false },
  debts: null, debtKind: 'Клиент',
  report: null, reportFrom: '', reportTo: '',
  prodQuery: '', prodGroup: '',
  queue: 0, failed: 0, syncing: false, photoSyncing: false,
  lastActivity: Date.now(),
};

// ───────────────────────── Утилиты ─────────────────────────

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => { const n = parseFloat(String(v ?? '').replace(/\s/g, '').replace(',', '.')); return isFinite(n) ? n : 0; };
const round2 = (n) => Math.round(n * 100) / 100;
const nf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
const fmtN = (n) => nf.format(n || 0);
const fmt = (n) => fmtN(n) + (S.cat && S.cat.currency ? ' ' + S.cat.currency : '');
const pad = (n) => String(n).padStart(2, '0');
const dayStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dateTime = (t) => { const d = new Date(t); return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

function uid() {
  const r = crypto.getRandomValues(new Uint8Array(6));
  return Date.now().toString(36) + '-' + Array.from(r, (b) => b.toString(16).padStart(2, '0')).join('');
}
function receiptNo(ts) {
  const d = new Date(ts);
  return `${String(d.getFullYear()).slice(2)}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
/** Имя файла фото — так же, как на сервере: артикул (или ID группы) + .jpg */
function photoName(key) {
  return String(key).trim().replace(/[\\/:*?"<>|\s]+/g, '_') + '.jpg';
}
async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}
function tokenPayload(token) {
  try {
    const p = token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(p));
  } catch (e) { return null; }
}
async function compressImage(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, CFG.PHOTO_MAX_PX / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob(res, 'image/jpeg', CFG.PHOTO_QUALITY));
}

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), type === 'err' ? 6000 : 3000);
}
function modal(html, onMount) {
  $('#modalBox').innerHTML = html;
  $('#modal').classList.remove('hidden');
  $$('[data-close]', $('#modalBox')).forEach((b) => b.addEventListener('click', closeModal));
  if (onMount) onMount($('#modalBox'));
}
function closeModal() {
  $('#modal').classList.add('hidden');
  $('#modalBox').innerHTML = '';
}

// ───────────────────────── Локальная база (IndexedDB) ─────────────────────────

const DB = (() => {
  let dbp = null;
  function open() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const r = indexedDB.open('mini-kassa', 1);
        r.onupgradeneeded = () => {
          const d = r.result;
          if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
          if (!d.objectStoreNames.contains('queue')) d.createObjectStore('queue', { keyPath: 'id' });
          if (!d.objectStoreNames.contains('photos')) d.createObjectStore('photos');
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    }
    return dbp;
  }
  async function run(store, mode, fn) {
    const d = await open();
    return new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      let req;
      try { req = fn(t.objectStore(store)); } catch (e) { reject(e); return; }
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }
  return {
    get: (s, k) => run(s, 'readonly', (st) => st.get(k)),
    put: (s, v, k) => run(s, 'readwrite', (st) => (k === undefined ? st.put(v) : st.put(v, k))),
    del: (s, k) => run(s, 'readwrite', (st) => st.delete(k)),
    all: (s) => run(s, 'readonly', (st) => st.getAll()),
    keys: (s) => run(s, 'readonly', (st) => st.getAllKeys()),
  };
})();

// ───────────────────────── Сервер (Apps Script) ─────────────────────────

async function api(action, data = {}, token = S.token) {
  if (!CFG.API_URL || CFG.API_URL.includes('ВАШ_ID')) {
    throw Object.assign(new Error('Не указан адрес Apps Script в config.js'), { code: 'CONFIG' });
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  let res;
  try {
    res = await fetch(CFG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // text/plain — без CORS-preflight
      body: JSON.stringify({ action, token, data }),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw Object.assign(new Error('Нет связи с сервером'), { code: 'NET' });
  } finally {
    clearTimeout(timer);
  }
  let j;
  try { j = await res.json(); } catch (e) {
    throw Object.assign(new Error('Сервер ответил не так, как ожидалось. Проверьте, что веб-приложение открыто для «Все».'), { code: 'NET' });
  }
  if (!j.ok) {
    const err = Object.assign(new Error(j.error || 'Ошибка сервера'), { code: j.code || 'ERR' });
    if (err.code === 'AUTH' && action !== 'login' && S.user) setTimeout(() => logout('Сессия истекла — войдите снова'), 50);
    throw err;
  }
  return j.data;
}

// ───────────────────────── Фото: локальная папка или память браузера ─────────────────────────

const Photos = {
  supported: 'showDirectoryPicker' in window,
  handle: null,   // сохранённая папка
  dir: null,      // папка с выданным доступом
  urls: new Map(),

  async init() {
    if (!this.supported) return;
    try {
      this.handle = await DB.get('kv', 'photoDir');
      if (this.handle && (await this.handle.queryPermission({ mode: 'readwrite' })) === 'granted') this.dir = this.handle;
    } catch (e) { this.handle = null; }
  },
  state() {
    if (!this.supported) return 'unsupported';
    if (this.dir) return 'ok';
    if (this.handle) return 'need-permission';
    return 'none';
  },
  async pick() {
    const h = await window.showDirectoryPicker({ id: 'kassa-photos', mode: 'readwrite', startIn: 'downloads' });
    await DB.put('kv', h, 'photoDir');
    this.handle = h;
    this.dir = h;
    await this.migrateFromBrowser();
    this.reset();
  },
  /** Фото, сохранённые в памяти браузера до выбора папки, переносятся в папку. */
  async migrateFromBrowser() {
    for (const name of await DB.keys('photos')) {
      const blob = await DB.get('photos', name);
      let exists = true;
      try { await this.dir.getFileHandle(name); } catch (e) { exists = false; }
      if (!exists && blob) await this.writeRaw(name, blob);
      await DB.del('photos', name);
    }
  },
  async reconnect() {
    if (!this.handle) return this.pick();
    if ((await this.handle.requestPermission({ mode: 'readwrite' })) === 'granted') {
      this.dir = this.handle;
      this.reset();
    }
  },
  reset() {
    this.urls.forEach((u) => u && URL.revokeObjectURL(u));
    this.urls.clear();
  },
  async url(name) {
    if (this.urls.has(name)) return this.urls.get(name);
    let blob = null;
    try {
      if (this.dir) blob = await (await this.dir.getFileHandle(name)).getFile();
      else blob = await DB.get('photos', name);
    } catch (e) { blob = null; }
    const u = blob ? URL.createObjectURL(blob) : null;
    this.urls.set(name, u);
    return u;
  },
  async writeRaw(name, blob) {
    if (this.dir) {
      const fh = await this.dir.getFileHandle(name, { create: true });
      const w = await fh.createWritable();   // перезаписывает файл целиком — старое фото не остаётся
      await w.write(blob);
      await w.close();
    } else {
      await DB.put('photos', blob, name);
    }
  },
  /** Сохраняет фото под именем «артикул.jpg», заменяя старое. */
  async write(name, blob) {
    await this.writeRaw(name, blob);
    this.refresh(name);
  },
  /** Удаляет файл фото (если его нет — ничего страшного). */
  async remove(name) {
    try {
      if (this.dir) await this.dir.removeEntry(name);
      else await DB.del('photos', name);
    } catch (e) {
      if (e.name !== 'NotFoundError') throw e;
    }
    this.refresh(name);
  },
  /** Имена всех .jpg в папке (или в памяти браузера). */
  async list() {
    const out = [];
    if (this.dir) {
      for await (const [n, h] of this.dir.entries()) if (h.kind === 'file' && /\.jpg$/i.test(n)) out.push(n);
    } else {
      (await DB.keys('photos')).forEach((n) => out.push(String(n)));
    }
    return out;
  },
  refresh(name) {
    const old = this.urls.get(name);
    if (old) URL.revokeObjectURL(old);
    this.urls.delete(name);
    $$(`[data-photo="${CSS.escape(name)}"]`).forEach((el) => { el.dataset.loaded = ''; loadPhoto(el); });
  },
};

async function loadPhoto(el) {
  if (el.dataset.loaded) return;
  el.dataset.loaded = '1';
  const u = await Photos.url(el.dataset.photo);
  if (u) {
    el.style.backgroundImage = `url("${u}")`;
    el.classList.add('has-img');
  } else {
    el.style.backgroundImage = '';
    el.classList.remove('has-img');
  }
}
const photoObserver = 'IntersectionObserver' in window
  ? new IntersectionObserver((entries) => entries.forEach((e) => {
      if (e.isIntersecting) { photoObserver.unobserve(e.target); loadPhoto(e.target); }
    }), { rootMargin: '200px' })
  : null;
function observePhotos(root) {
  $$('.ph[data-photo]', root).forEach((el) => (photoObserver ? photoObserver.observe(el) : loadPhoto(el)));
}
function phHtml(name, letter, cls = '') {
  return `<div class="ph ${cls}" data-photo="${esc(name)}"><span class="ph-letter">${esc((letter || '?').charAt(0).toUpperCase())}</span></div>`;
}

async function savePhoto(name, blob) {
  await Photos.write(name, blob);
}

/** Фото, которым не соответствует ни один товар или группа (например, строку удалили прямо в таблице). */
async function orphanPhotos() {
  const known = new Set(S.cat.products.map((p) => photoName(p.article)));
  S.cat.groups.forEach((g) => { known.add(photoName(g.id)); if (g.photo) known.add(g.photo); });
  return (await Photos.list()).filter((n) => !known.has(n));
}

// ───────────────────────── Каталог ─────────────────────────

function buildIndex() {
  S.index = (S.cat ? S.cat.products : []).map((p) => ({ p, hay: `${p.name} ${p.article} ${p.barcode}`.toLowerCase() }));
}
/** В память браузера кладём только то, что можно видеть продавцу (без закупочных цен и поставщиков). */
async function saveCatalogLocal() {
  const safe = Object.assign({}, S.cat, { products: S.cat.products.map(({ cost, ...rest }) => rest) });
  delete safe.suppliers;
  await DB.put('kv', safe, 'catalog');
}
async function refreshCatalog(silent = true) {
  if (!navigator.onLine || !S.token) return;
  try {
    S.cat = await api('catalog');
    buildIndex();
    await saveCatalogLocal();
    $('#shopName').textContent = S.cat.shop;
    if (S.view === 'kassa') renderGrid();
    if (!silent) toast('Справочник обновлён');
  } catch (e) {
    if (!silent) toast('Не удалось обновить справочник: ' + e.message, 'err');
  }
}
function searchProducts(q, onlyActive = true) {
  const words = q.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const exact = q.trim();
  return S.index
    .filter((x) => (!onlyActive || x.p.active !== false) && words.every((w) => x.hay.includes(w)))
    .map((x) => x.p)
    .sort((a, b) => {
      const ea = a.barcode === exact || a.article === exact ? 0 : 1;
      const eb = b.barcode === exact || b.article === exact ? 0 : 1;
      return ea - eb || a.name.localeCompare(b.name, 'ru');
    });
}
function findByCode(code) {
  code = String(code).trim();
  if (!code || !S.cat) return null;
  return S.cat.products.find((p) => p.active !== false && (p.barcode === code || p.article === code)) || null;
}
function groupName(id) {
  const g = S.cat && S.cat.groups.find((x) => x.id === id);
  return g ? g.name : '';
}

// ───────────────────────── Офлайн-очередь ─────────────────────────

async function enqueue(type, data) {
  const now = Date.now();
  const op = { id: uid(), type, ts: now, token: S.token, by: S.user.name, data };
  await DB.put('queue', op);
  await updateQueueBadge();
  syncNow();
  return op;
}
async function updateQueueBadge() {
  const ops = await DB.all('queue');
  S.failed = ops.filter((o) => o.failed).length;
  S.queue = ops.length - S.failed;
  const b = $('#syncBadge');
  if (!b) return;
  if (S.failed) { b.className = 'sync-badge error'; b.textContent = `⚠ Ошибки отправки: ${S.failed}`; }
  else if (S.queue && !navigator.onLine) { b.className = 'sync-badge offline'; b.textContent = `Офлайн · не отправлено: ${S.queue}`; }
  else if (S.queue) { b.className = 'sync-badge pending'; b.textContent = `⟳ Не отправлено: ${S.queue}`; }
  else if (!navigator.onLine) { b.className = 'sync-badge offline'; b.textContent = 'Офлайн · всё отправлено'; }
  else { b.className = 'sync-badge ok'; b.textContent = '✓ Всё отправлено'; }
}
async function syncNow() {
  if (S.syncing || !navigator.onLine) return updateQueueBadge();
  S.syncing = true;
  try {
    const ops = (await DB.all('queue')).filter((o) => !o.failed).sort((a, b) => a.ts - b.ts);
    for (let i = 0; i < ops.length; i += 15) {
      const batch = ops.slice(i, i + 15);
      const { results } = await api('sync', { ops: batch }, null);
      for (const r of results) {
        if (r.ok) await DB.del('queue', r.id);
        else if (r.fatal) {
          const op = batch.find((o) => o.id === r.id);
          if (op) await DB.put('queue', Object.assign(op, { failed: true, error: r.error }));
        }
      }
    }
  } catch (e) {
    // нет сети или сервер занят — попробуем в следующий раз
  } finally {
    S.syncing = false;
    await updateQueueBadge();
  }
}

// ───────────────────────── Вход и выход ─────────────────────────

let pin = '';
function renderPin() {
  $('#pinDots').innerHTML = '<span></span>'.repeat(pin.length);
}
function loginKey(k) {
  if (k === 'back') pin = pin.slice(0, -1);
  else if (k === 'ok') { if (pin.length >= 4) doLogin(pin); return; }
  else if (/^\d$/.test(k) && pin.length < 8) pin += k;
  $('#loginError').textContent = '';
  renderPin();
}
async function doLogin(p) {
  $('#loginError').textContent = 'Проверяю…';
  try {
    if (navigator.onLine) {
      try {
        const r = await api('login', { pin: p }, null);
        await rememberOffline(p, r);
        return startSession(r.user, r.token);
      } catch (e) {
        if (e.code !== 'NET') throw e;
      }
    }
    const r = await offlineLogin(p);
    if (r) return startSession(r.user, r.token);
    throw new Error(navigator.onLine
      ? 'Нет связи с сервером'
      : 'Нет интернета. Без интернета могут войти только продавцы, которые уже входили на этом ноутбуке.');
  } catch (e) {
    pin = '';
    renderPin();
    $('#loginError').textContent = e.message;
  }
}
/** Продавцу разрешаем вход без интернета: храним хэш PIN и его подписанную сессию. */
async function rememberOffline(p, r) {
  const users = (await DB.get('kv', 'offlineUsers')) || {};
  delete users[r.user.id];
  if (r.user.role === 'seller') {
    const salt = uid();
    users[r.user.id] = { salt, hash: await sha256(salt + ':' + p), user: r.user, token: r.token };
  }
  await DB.put('kv', users, 'offlineUsers');
}
async function offlineLogin(p) {
  const users = (await DB.get('kv', 'offlineUsers')) || {};
  for (const u of Object.values(users)) {
    if ((await sha256(u.salt + ':' + p)) === u.hash) {
      const tp = tokenPayload(u.token);
      if (tp && tp.exp > Date.now()) return u;
    }
  }
  return null;
}

async function startSession(user, token) {
  S.user = user;
  S.token = token;
  S.lastActivity = Date.now();
  pin = '';
  renderPin();
  $('#loginError').textContent = '';
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#userName').textContent = `${user.name} · ${ROLE_RU[user.role]}`;

  if (!S.cat) {
    S.cat = await DB.get('kv', 'catalog');
    buildIndex();
  }
  if (S.cat) $('#shopName').textContent = S.cat.shop;
  // менеджеру нужен полный справочник (с закупочными ценами) — он приходит только с сервера
  if (navigator.onLine) await refreshCatalog();
  renderTabs();
  go('kassa');
  updateQueueBadge();
  syncNow();
}

function logout(msg) {
  // Перезагрузка страницы гарантированно стирает из памяти всё, что видел сотрудник.
  // Очередь продаж и справочник для кассы остаются в браузере.
  if (msg) sessionStorage.setItem('logoutMsg', msg);
  location.reload();
}

// ───────────────────────── Навигация ─────────────────────────

function renderTabs() {
  const lvl = ROLE_LEVEL[S.user.role];
  const tabs = TABS.filter((t) => lvl >= t[2]);
  $('#tabs').innerHTML = tabs.length > 1
    ? tabs.map(([id, name]) => `<button data-tab="${id}" class="${S.view === id ? 'active' : ''}">${name}</button>`).join('')
    : '';
}
function go(view) {
  const t = TABS.find((x) => x[0] === view);
  if (!t || ROLE_LEVEL[S.user.role] < t[2]) view = 'kassa';
  S.view = view;
  renderTabs();
  renderView();
}
function renderView() {
  ({ kassa: renderKassa, products: renderProducts, purchases: renderPurchases, debts: renderDebts, report: renderReport, settings: renderSettings })[S.view]();
}

// ───────────────────────── Касса ─────────────────────────

function renderKassa() {
  $('#view').innerHTML = `
    <div class="kassa">
      <section class="catalog">
        <div id="photoBanner"></div>
        <div class="searchbar">
          <input id="search" class="input" type="search" autocomplete="off"
                 placeholder="Поиск: название, артикул или штрих-код" value="${esc(S.query)}">
        </div>
        <div class="crumbs" id="crumbs"></div>
        <div class="grid" id="grid"></div>
      </section>
      <aside class="cart" id="cart"></aside>
    </div>`;
  const inp = $('#search');
  inp.addEventListener('input', () => { S.query = inp.value; renderGrid(); });
  inp.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const p = findByCode(inp.value) || (searchProducts(inp.value).length === 1 ? searchProducts(inp.value)[0] : null);
    if (p) { addToCart(p); inp.value = ''; S.query = ''; renderGrid(); }
  });
  $('#grid').addEventListener('click', (e) => {
    const t = e.target.closest('.tile');
    if (!t) return;
    if (t.dataset.group) { S.group = t.dataset.group; renderGrid(); $('.catalog').scrollTop = 0; }
    else if (t.dataset.article) {
      const p = S.cat.products.find((x) => x.article === t.dataset.article);
      if (p) addToCart(p);
    }
  });
  renderPhotoBanner();
  renderGrid();
  renderCart();
  inp.focus();
}

function renderPhotoBanner() {
  const el = $('#photoBanner');
  if (!el) return;
  const st = Photos.state();
  if (st === 'need-permission') {
    el.innerHTML = `<div class="banner"><span>Нужен доступ к папке с фото товаров</span><button class="btn primary small" id="phReconnect">Разрешить</button></div>`;
  } else if (st === 'none') {
    el.innerHTML = `<div class="banner"><span>Папка для фото не выбрана — фото будут храниться в памяти браузера</span><button class="btn small" id="phPick">Выбрать папку</button></div>`;
  } else {
    el.innerHTML = '';
    return;
  }
  const btn = $('#phReconnect') || $('#phPick');
  btn.addEventListener('click', async () => {
    try {
      if (st === 'need-permission') await Photos.reconnect(); else await Photos.pick();
      renderPhotoBanner();
      renderGrid();
    } catch (e) { if (e.name !== 'AbortError') toast(e.message, 'err'); }
  });
}

function productTile(p) {
  return `<button class="tile" data-article="${esc(p.article)}">
    ${phHtml(photoName(p.article), p.name)}
    <div class="t-name">${esc(p.name)}</div>
    <div class="t-sub"><span>${esc(p.article)}</span><span class="t-price">${fmtN(p.price)}</span></div>
  </button>`;
}

function renderGrid() {
  const grid = $('#grid');
  if (!grid) return;
  const crumbs = $('#crumbs');
  if (!S.cat) {
    crumbs.innerHTML = '';
    grid.innerHTML = '<div class="empty">Справочник ещё не загружен. Подключитесь к интернету и войдите заново.</div>';
    return;
  }
  const active = S.cat.products.filter((p) => p.active !== false);
  const groupIds = new Set(S.cat.groups.map((g) => g.id));

  if (S.query.trim()) {
    const res = searchProducts(S.query);
    crumbs.innerHTML = `Найдено: <b>${res.length}</b>${res.length > 120 ? ' (показаны первые 120)' : ''}`;
    grid.innerHTML = res.length ? res.slice(0, 120).map(productTile).join('') : '<div class="empty">Ничего не найдено</div>';
  } else if (S.group) {
    const list = S.group === '__none'
      ? active.filter((p) => !groupIds.has(p.group))
      : active.filter((p) => p.group === S.group);
    list.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    crumbs.innerHTML = `<button class="btn small" id="backGroups">← Все группы</button> <b>${esc(S.group === '__none' ? 'Без группы' : groupName(S.group))}</b>`;
    grid.innerHTML = list.length ? list.map(productTile).join('') : '<div class="empty">В этой группе нет товаров</div>';
    $('#backGroups').addEventListener('click', () => { S.group = null; renderGrid(); $('#search').focus(); });
  } else {
    const counts = {};
    active.forEach((p) => { const k = groupIds.has(p.group) ? p.group : '__none'; counts[k] = (counts[k] || 0) + 1; });
    const groups = S.cat.groups.filter((g) => counts[g.id]);
    if (counts.__none) groups.push({ id: '__none', name: 'Без группы', photo: '' });
    crumbs.innerHTML = 'Группы товаров';
    grid.innerHTML = groups.length
      ? groups.map((g) => `<button class="tile group" data-group="${esc(g.id)}">
          ${phHtml(g.photo || photoName(g.id), g.name)}
          <div class="t-name">${esc(g.name)}</div>
          <div class="t-sub"><span>${counts[g.id]} тов.</span></div>
        </button>`).join('')
      : '<div class="empty">Справочник пуст. Добавьте группы и товары в таблице или во вкладке «Товары».</div>';
  }
  observePhotos(grid);
}

function addToCart(p) {
  const line = S.cart.find((l) => l.article === p.article);
  if (line) line.qty = round2(line.qty + 1);
  else S.cart.push({ article: p.article, name: p.name, unit: p.unit, price: p.price, qty: 1 });
  renderCart();
}
function cartTotal() {
  return round2(S.cart.reduce((s, l) => s + round2(l.qty * l.price), 0));
}

function renderCart() {
  const el = $('#cart');
  if (!el) return;
  const total = cartTotal();
  const clients = (S.cat && S.cat.clients) || [];
  const change = num(S.received) - total;
  el.innerHTML = `
    <div class="cart-head"><span>Чек${S.cart.length ? ` · ${S.cart.length} поз.` : ''}</span>
      ${S.cart.length ? '<button class="btn small" id="clearCart">Очистить</button>' : ''}</div>
    <div class="cart-lines">
      ${S.cart.length ? S.cart.map((l, i) => `
        <div class="cl">
          <div class="cl-top"><span class="cl-name">${esc(l.name)}</span><button class="cl-del" data-del="${i}" title="Убрать">✕</button></div>
          <div class="cl-bottom">
            <div class="qty"><button data-minus="${i}">−</button><input data-qty="${i}" value="${l.qty}" inputmode="decimal"><button data-plus="${i}">+</button></div>
            <span>${esc(l.unit)} × ${fmtN(l.price)}</span>
            <span class="cl-sum">${fmtN(round2(l.qty * l.price))}</span>
          </div>
        </div>`).join('') : '<div class="empty">Нажмите на товар или отсканируйте штрих-код</div>'}
    </div>
    <div class="cart-foot">
      <div class="total"><span>Итого</span><b>${fmt(total)}</b></div>
      <div class="seg">${['Наличные', 'Карта', 'В долг'].map((p) => `<button data-pay="${p}" class="${S.payment === p ? 'active' : ''}">${p}</button>`).join('')}</div>
      ${S.payment === 'Наличные' ? `<div class="change">Получено <input class="input" id="received" inputmode="decimal" value="${esc(S.received)}">
        <b>${S.received && change >= 0 ? 'Сдача: ' + fmt(round2(change)) : ''}</b></div>` : ''}
      ${S.payment === 'В долг' ? `<input class="input" id="client" list="clientsList" placeholder="Клиент: имя или телефон" value="${esc(S.client)}">
        <datalist id="clientsList">${clients.map((c) => `<option value="${esc(c)}">`).join('')}</datalist>` : ''}
      <button class="btn primary big" id="sellBtn" ${S.cart.length ? '' : 'disabled'}>Продать</button>
    </div>`;

  el.onclick = (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.id === 'clearCart') { S.cart = []; S.received = ''; renderCart(); }
    else if (t.dataset.del) { S.cart.splice(+t.dataset.del, 1); renderCart(); }
    else if (t.dataset.plus) { const l = S.cart[+t.dataset.plus]; l.qty = round2(l.qty + 1); renderCart(); }
    else if (t.dataset.minus) {
      const i = +t.dataset.minus;
      S.cart[i].qty = round2(S.cart[i].qty - 1);
      if (S.cart[i].qty <= 0) S.cart.splice(i, 1);
      renderCart();
    }
    else if (t.dataset.pay) { S.payment = t.dataset.pay; renderCart(); if ($('#client')) $('#client').focus(); }
    else if (t.id === 'sellBtn') sell();
  };
  $$('[data-qty]', el).forEach((inp) => inp.addEventListener('change', () => {
    const i = +inp.dataset.qty;
    const q = round2(num(inp.value));
    if (q <= 0) S.cart.splice(i, 1); else S.cart[i].qty = q;
    renderCart();
  }));
  const rec = $('#received');
  if (rec) rec.addEventListener('input', () => {
    S.received = rec.value;
    const ch = num(rec.value) - cartTotal();
    rec.parentElement.querySelector('b').textContent = rec.value && ch >= 0 ? 'Сдача: ' + fmt(round2(ch)) : '';
  });
  const cl = $('#client');
  if (cl) cl.addEventListener('input', () => { S.client = cl.value; });
}

async function sell() {
  if (!S.cart.length) return;
  const client = S.client.trim();
  if (S.payment === 'В долг' && !client) { toast('Укажите клиента для продажи в долг', 'err'); return; }
  const btn = $('#sellBtn');
  btn.disabled = true;
  const total = cartTotal();
  const ts = Date.now();
  try {
    await enqueue('sale', {
      receipt: receiptNo(ts),
      payment: S.payment,
      client: S.payment === 'В долг' ? client : '',
      items: S.cart.map((l) => ({ article: l.article, name: l.name, unit: l.unit, qty: l.qty, price: l.price })),
    });
    if (client && S.cat && !S.cat.clients.includes(client)) S.cat.clients.push(client);
    toast(`Чек ${receiptNo(ts)} на ${fmt(total)} сохранён`);
    S.cart = []; S.payment = 'Наличные'; S.client = ''; S.received = '';
    renderCart();
    const s = $('#search'); if (s) s.focus();
  } catch (e) {
    btn.disabled = false;
    toast('Не удалось сохранить продажу: ' + e.message, 'err');
  }
}

// Сканер штрих-кодов работает как клавиатура: быстрые цифры + Enter.
// Если курсор не в поле ввода, ловим такой ввод глобально.
let scanBuf = '', scanTime = 0;
document.addEventListener('keydown', (e) => {
  if (!S.user || S.view !== 'kassa' || !$('#modal').classList.contains('hidden')) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  const now = Date.now();
  if (now - scanTime > 100) scanBuf = '';
  scanTime = now;
  if (e.key === 'Enter') {
    if (scanBuf.length >= 3) {
      const p = findByCode(scanBuf);
      if (p) addToCart(p); else toast('Товар со штрих-кодом ' + scanBuf + ' не найден', 'err');
      e.preventDefault();
    }
    scanBuf = '';
  } else if (e.key.length === 1) {
    scanBuf += e.key;
  }
});

// ───────────────────────── Товары (менеджер) ─────────────────────────

function renderProducts() {
  if (!S.cat) { $('#view').innerHTML = '<div class="page empty">Справочник не загружен</div>'; return; }
  $('#view').innerHTML = `
    <div class="page">
      <div class="toolbar">
        <input class="input" id="pq" type="search" placeholder="Поиск товара" value="${esc(S.prodQuery)}">
        <select class="input" id="pg"><option value="">Все группы</option>
          ${S.cat.groups.map((g) => `<option value="${esc(g.id)}" ${S.prodGroup === g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select>
        <button class="btn primary" id="newProd">+ Товар</button>
        <button class="btn" id="groupsBtn">Группы</button>
        <label class="btn">Загрузить фото пачкой<input type="file" id="bulkPhotos" accept="image/*" multiple hidden></label>
        <button class="btn" id="reloadCat">Обновить</button>
      </div>
      <div id="ptable"></div>
      <p class="note">Изменение цены не влияет на прошлые продажи: в каждой продаже записана цена на момент продажи. Все изменения цен попадают в лист «История цен».</p>
    </div>`;
  const draw = () => {
    let list = S.prodQuery.trim() ? searchProducts(S.prodQuery, false) : S.cat.products.slice().sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    if (S.prodGroup) list = list.filter((p) => p.group === S.prodGroup);
    const shown = list.slice(0, 300);
    $('#ptable').innerHTML = `
      <table class="tbl"><thead><tr><th></th><th>Артикул</th><th>Наименование</th><th>Группа</th><th>Штрих-код</th><th>Ед.</th>
        <th class="num">Цена</th><th class="num">Закуп</th><th></th></tr></thead><tbody>
      ${shown.map((p) => `<tr class="${p.active === false ? 'off' : ''}">
        <td>${phHtml(photoName(p.article), p.name, 'thumb')}</td>
        <td>${esc(p.article)}</td><td>${esc(p.name)}${p.active === false ? ' (скрыт)' : ''}</td><td>${esc(groupName(p.group))}</td>
        <td>${esc(p.barcode)}</td><td>${esc(p.unit)}</td>
        <td class="num">${fmtN(p.price)}</td><td class="num">${fmtN(p.cost)}</td>
        <td><button class="btn small" data-edit="${esc(p.article)}">Изменить</button></td></tr>`).join('')}
      </tbody></table>
      ${list.length > 300 ? `<p class="note">Показаны первые 300 из ${list.length}. Уточните поиск.</p>` : ''}
      ${!list.length ? '<div class="empty">Товаров не найдено</div>' : ''}`;
    observePhotos($('#ptable'));
  };
  draw();
  $('#pq').addEventListener('input', (e) => { S.prodQuery = e.target.value; draw(); });
  $('#pg').addEventListener('change', (e) => { S.prodGroup = e.target.value; draw(); });
  $('#newProd').addEventListener('click', () => editProduct(null));
  $('#groupsBtn').addEventListener('click', editGroups);
  $('#reloadCat').addEventListener('click', async () => { await refreshCatalog(false); renderProducts(); });
  $('#bulkPhotos').addEventListener('change', (e) => bulkPhotos(Array.from(e.target.files)));
  $('#ptable').addEventListener('click', (e) => {
    const b = e.target.closest('[data-edit]');
    if (b) editProduct(S.cat.products.find((p) => p.article === b.dataset.edit));
  });
}

function editProduct(p) {
  const isNew = !p;
  p = p || { article: '', name: '', group: S.prodGroup || '', barcode: '', unit: 'шт', price: 0, cost: 0, active: true };
  let photoBlob = null;
  modal(`
    <h2>${isNew ? 'Новый товар' : 'Товар ' + esc(p.article)}</h2>
    <form class="form" id="pform">
      <div class="pf-photo">${phHtml(photoName(p.article || '_'), p.name, 'big')}
        <label class="btn">${isNew ? 'Выбрать фото' : 'Заменить фото'}<input type="file" accept="image/*" id="pfFile" hidden></label>
        ${isNew ? '' : '<button type="button" class="btn danger" id="pfDelPhoto">Удалить фото</button>'}
        <span class="note">Сохранится как «артикул.jpg»; старое фото заменится</span></div>
      <label>Артикул<input name="article" value="${esc(p.article)}" ${isNew ? '' : 'readonly'} required></label>
      <label>Штрих-код<input name="barcode" value="${esc(p.barcode)}"></label>
      <label class="wide">Наименование<input name="name" value="${esc(p.name)}" required></label>
      <label>Группа<select name="group"><option value="">— без группы —</option>
        ${S.cat.groups.map((g) => `<option value="${esc(g.id)}" ${g.id === p.group ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></label>
      <label>Ед. изм.<input name="unit" list="unitsList" value="${esc(p.unit)}"></label>
      <label>Цена продажи<input name="price" inputmode="decimal" value="${p.price}"></label>
      <label>Цена закупки<input name="cost" inputmode="decimal" value="${p.cost || 0}"></label>
      <label class="check wide"><input type="checkbox" name="active" ${p.active !== false ? 'checked' : ''}> Показывать на кассе</label>
      <div class="actions">${isNew ? '' : '<button type="button" class="btn danger" id="pfDelete" style="margin-right:auto">Удалить товар</button>'}
        <button type="button" class="btn" data-close>Отмена</button><button class="btn primary" id="pfSave">Сохранить</button></div>
    </form>
    <datalist id="unitsList"><option value="шт"><option value="кг"><option value="м"><option value="л"><option value="упак"></datalist>`, (box) => {
    observePhotos(box);
    $('#pfFile', box).addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      photoBlob = await compressImage(f);
      const ph = $('.ph', box);
      ph.style.backgroundImage = `url("${URL.createObjectURL(photoBlob)}")`;
      ph.classList.add('has-img');
    });
    if (!isNew) {
      $('#pfDelPhoto', box).addEventListener('click', async () => {
        if (!confirm('Удалить фото этого товара с ноутбука?')) return;
        photoBlob = null;
        await Photos.remove(photoName(p.article));
        toast('Фото удалено');
      });
      $('#pfDelete', box).addEventListener('click', () => deleteProduct(p));
    }
    $('#pform', box).addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!navigator.onLine) { toast('Изменять товары можно только при наличии интернета', 'err'); return; }
      const f = new FormData(e.target);
      const prod = {
        article: String(f.get('article')).trim(),
        name: String(f.get('name')).trim(),
        group: String(f.get('group')),
        barcode: String(f.get('barcode')).trim(),
        unit: String(f.get('unit')).trim() || 'шт',
        price: num(f.get('price')),
        cost: num(f.get('cost')),
        active: !!f.get('active'),
      };
      const btn = $('#pfSave', box);
      btn.disabled = true;
      try {
        await api('saveProduct', { product: prod, isNew });
        const i = S.cat.products.findIndex((x) => x.article === prod.article);
        if (i >= 0) S.cat.products[i] = prod; else S.cat.products.push(prod);
        buildIndex();
        await saveCatalogLocal();
        if (photoBlob) await savePhoto(photoName(prod.article), photoBlob);
        closeModal();
        renderView();
        toast('Сохранено');
      } catch (err) {
        btn.disabled = false;
        toast(err.message, 'err');
      }
    });
  });
}

async function deleteProduct(p) {
  if (!confirm(`Удалить товар «${p.name}» (${p.article}) из справочника вместе с фото?\nПрошлые продажи и закупы останутся в таблице.`)) return;
  if (!navigator.onLine) { toast('Удалять товары можно только при наличии интернета', 'err'); return; }
  try {
    await api('deleteProduct', { article: p.article });
    S.cat.products = S.cat.products.filter((x) => x.article !== p.article);
    buildIndex();
    await saveCatalogLocal();
    await Photos.remove(photoName(p.article));
    closeModal();
    renderView();
    toast('Товар удалён');
  } catch (e) { toast(e.message, 'err'); }
}

function editGroups() {
  const draw = () => modal(`
    <h2>Группы товаров</h2>
    <table class="tbl"><thead><tr><th></th><th>ID</th><th>Название</th><th class="num">Порядок</th><th></th></tr></thead><tbody>
      ${S.cat.groups.map((g) => `<tr><td>${phHtml(g.photo || photoName(g.id), g.name, 'thumb')}</td><td>${esc(g.id)}</td><td>${esc(g.name)}</td>
        <td class="num">${g.order}</td><td><button class="btn small" data-g="${esc(g.id)}">Изменить</button></td></tr>`).join('')}
    </tbody></table>
    <div class="actions"><button class="btn" data-close>Закрыть</button><button class="btn primary" id="newGroup">+ Группа</button></div>`, (box) => {
    observePhotos(box);
    $('#newGroup', box).addEventListener('click', () => groupForm(null, draw));
    box.querySelector('tbody').addEventListener('click', (e) => {
      const b = e.target.closest('[data-g]');
      if (b) groupForm(S.cat.groups.find((g) => g.id === b.dataset.g), draw);
    });
  });
  draw();
}

function groupForm(g, back) {
  const isNew = !g;
  const nextId = 'G' + String(S.cat.groups.length + 1).padStart(2, '0');
  g = g || { id: nextId, name: '', order: (S.cat.groups.length + 1) * 10 };
  let photoBlob = null;
  modal(`
    <h2>${isNew ? 'Новая группа' : 'Группа ' + esc(g.name)}</h2>
    <form class="form" id="gform">
      <div class="pf-photo">${phHtml(photoName(g.id), g.name, 'big')}<label class="btn">${isNew ? 'Выбрать фото' : 'Заменить фото'}<input type="file" accept="image/*" id="gfFile" hidden></label>
        ${isNew ? '' : '<button type="button" class="btn danger" id="gfDelPhoto">Удалить фото</button>'}</div>
      <label>ID группы<input name="id" value="${esc(g.id)}" ${isNew ? '' : 'readonly'} required></label>
      <label>Порядок на кассе<input name="order" inputmode="numeric" value="${g.order}"></label>
      <label class="wide">Название<input name="name" value="${esc(g.name)}" required></label>
      <div class="actions">${isNew ? '' : '<button type="button" class="btn danger" id="gDelete" style="margin-right:auto">Удалить группу</button>'}
        <button type="button" class="btn" id="gBack">Назад</button><button class="btn primary">Сохранить</button></div>
    </form>`, (box) => {
    observePhotos(box);
    $('#gBack', box).addEventListener('click', back);
    if (!isNew) {
      $('#gfDelPhoto', box).addEventListener('click', async () => {
        if (!confirm('Удалить фото группы с ноутбука?')) return;
        photoBlob = null;
        await Photos.remove(photoName(g.id));
        if (g.photo && g.photo !== photoName(g.id)) await Photos.remove(g.photo);
        toast('Фото удалено');
      });
      $('#gDelete', box).addEventListener('click', async () => {
        if (!confirm(`Удалить группу «${g.name}» вместе с фото?`)) return;
        if (!navigator.onLine) { toast('Удалять группы можно только при наличии интернета', 'err'); return; }
        try {
          await api('deleteGroup', { id: g.id });
          S.cat.groups = S.cat.groups.filter((x) => x.id !== g.id);
          await saveCatalogLocal();
          await Photos.remove(photoName(g.id));
          if (g.photo && g.photo !== photoName(g.id)) await Photos.remove(g.photo);
          toast('Группа удалена');
          back();
        } catch (e) { toast(e.message, 'err'); }
      });
    }
    $('#gfFile', box).addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      photoBlob = await compressImage(f);
      const ph = $('.ph', box);
      ph.style.backgroundImage = `url("${URL.createObjectURL(photoBlob)}")`;
      ph.classList.add('has-img');
    });
    $('#gform', box).addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const grp = { id: String(f.get('id')).trim(), name: String(f.get('name')).trim(), order: num(f.get('order')) };
      if (isNew && S.cat.groups.some((x) => x.id === grp.id)) { toast('Группа с таким ID уже есть', 'err'); return; }
      try {
        await api('saveGroup', { group: grp });
        grp.photo = photoName(grp.id);
        const i = S.cat.groups.findIndex((x) => x.id === grp.id);
        if (i >= 0) S.cat.groups[i] = grp; else S.cat.groups.push(grp);
        S.cat.groups.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'ru'));
        await saveCatalogLocal();
        if (photoBlob) await savePhoto(photoName(grp.id), photoBlob);
        toast('Группа сохранена');
        back();
      } catch (err) { toast(err.message, 'err'); }
    });
  });
}

/** Пакетная загрузка: имя файла = артикул, штрих-код, название товара, ID или название группы. */
async function bulkPhotos(files) {
  if (!files.length) return;
  let ok = 0;
  const missed = [];
  for (const file of files) {
    const base = file.name.replace(/\.[^.]+$/, '').trim();
    const low = base.toLowerCase();
    const p = S.cat.products.find((x) => x.article === base || (x.barcode && x.barcode === base) || x.name.toLowerCase() === low);
    const g = !p && S.cat.groups.find((x) => x.id === base || x.name.toLowerCase() === low);
    const key = p ? p.article : g ? g.id : null;
    if (!key) { missed.push(file.name); continue; }
    try {
      await savePhoto(photoName(key), await compressImage(file));
      ok++;
    } catch (e) { missed.push(file.name); }
  }
  toast(`Загружено фото: ${ok}`);
  if (missed.length) {
    modal(`<h2>Не удалось сопоставить</h2>
      <p class="note">Назовите файл артикулом, штрих-кодом или точным названием товара (для группы — её ID или названием).</p>
      <ul>${missed.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>
      <div class="actions"><button class="btn primary" data-close>Понятно</button></div>`);
  }
  renderView();
}

// ───────────────────────── Закупы (менеджер) ─────────────────────────

function renderPurchases() {
  const P = S.purchase;
  const total = round2(P.lines.reduce((s, l) => s + round2(l.qty * l.price), 0));
  if (!P.paidTouched) P.paid = String(total);
  const suppliers = (S.cat && S.cat.suppliers) || [];
  $('#view').innerHTML = `
    <div class="page">
      <h2>Новый закуп</h2>
      <div class="box">
        <div class="form">
          <label>Поставщик<input id="supplier" list="supList" value="${esc(P.supplier)}" placeholder="Название поставщика">
            <datalist id="supList">${suppliers.map((s) => `<option value="${esc(s)}">`).join('')}</datalist></label>
          <label>Добавить товар<div class="dropdown"><input id="pSearch" placeholder="Название, артикул или штрих-код" autocomplete="off"><div class="dropdown-list hidden" id="pDrop"></div></div></label>
        </div>
      </div>
      <table class="tbl"><thead><tr><th>Товар</th><th class="num">Кол-во</th><th class="num">Цена закупки</th><th class="num">Сумма</th><th></th></tr></thead><tbody>
        ${P.lines.map((l, i) => `<tr><td>${esc(l.name)} <span class="note">${esc(l.article)}</span></td>
          <td class="num"><input class="n" data-f="qty" data-i="${i}" value="${l.qty}" inputmode="decimal"></td>
          <td class="num"><input class="n" data-f="price" data-i="${i}" value="${l.price}" inputmode="decimal"></td>
          <td class="num">${fmtN(round2(l.qty * l.price))}</td>
          <td><button class="btn small danger" data-rm="${i}">✕</button></td></tr>`).join('')}
        ${!P.lines.length ? '<tr><td colspan="5" class="empty">Добавьте товары через поиск выше</td></tr>' : ''}
      </tbody></table>
      <div class="box" style="margin-top:14px">
        <div class="form">
          <label>Итого<input readonly value="${fmt(total)}"></label>
          <label>Оплачено поставщику сейчас<input id="paid" inputmode="decimal" value="${esc(P.paid)}"></label>
        </div>
        <p class="note">Если оплачено меньше итога, разница автоматически запишется в «Долги» как долг поставщику. Закупочные цены в справочнике обновятся.</p>
        <div class="actions"><button class="btn" id="pClear">Очистить</button><button class="btn primary" id="pSave" ${P.lines.length ? '' : 'disabled'}>Провести закуп</button></div>
      </div>
    </div>`;

  $('#supplier').addEventListener('input', (e) => { P.supplier = e.target.value; });
  $('#paid').addEventListener('input', (e) => { P.paid = e.target.value; P.paidTouched = true; });
  const ps = $('#pSearch'), drop = $('#pDrop');
  ps.addEventListener('input', () => {
    const res = searchProducts(ps.value, false).slice(0, 10);
    drop.classList.toggle('hidden', !res.length);
    drop.innerHTML = res.map((p) => `<button data-a="${esc(p.article)}"><span>${esc(p.name)}</span><span class="note">${esc(p.article)}</span></button>`).join('');
  });
  ps.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const p = findByCode(ps.value) || searchProducts(ps.value, false)[0]; if (p) addPurchaseLine(p); }
  });
  drop.addEventListener('click', (e) => {
    const b = e.target.closest('[data-a]');
    if (b) addPurchaseLine(S.cat.products.find((p) => p.article === b.dataset.a));
  });
  $$('[data-f]').forEach((inp) => inp.addEventListener('change', () => {
    P.lines[+inp.dataset.i][inp.dataset.f] = round2(num(inp.value));
    renderPurchases();
  }));
  $$('[data-rm]').forEach((b) => b.addEventListener('click', () => { P.lines.splice(+b.dataset.rm, 1); renderPurchases(); }));
  $('#pClear').addEventListener('click', () => { S.purchase = { supplier: '', lines: [], paid: '', paidTouched: false }; renderPurchases(); });
  $('#pSave').addEventListener('click', savePurchase);
}

function addPurchaseLine(p) {
  if (!p) return;
  const P = S.purchase;
  const l = P.lines.find((x) => x.article === p.article);
  if (l) l.qty = round2(l.qty + 1);
  else P.lines.push({ article: p.article, name: p.name, qty: 1, price: p.cost || 0 });
  renderPurchases();
  $('#pSearch').focus();
}

async function savePurchase() {
  const P = S.purchase;
  if (!P.supplier.trim()) { toast('Укажите поставщика', 'err'); return; }
  const lines = P.lines.filter((l) => l.qty > 0);
  if (!lines.length) return;
  await enqueue('purchase', { supplier: P.supplier.trim(), paid: num(P.paid), items: lines });
  lines.forEach((l) => {
    const p = S.cat.products.find((x) => x.article === l.article);
    if (p && l.price > 0) p.cost = l.price;
  });
  if (!S.cat.suppliers) S.cat.suppliers = [];
  if (!S.cat.suppliers.includes(P.supplier.trim())) S.cat.suppliers.push(P.supplier.trim());
  S.purchase = { supplier: '', lines: [], paid: '', paidTouched: false };
  toast('Закуп сохранён');
  renderPurchases();
}

// ───────────────────────── Долги (менеджер) ─────────────────────────

async function renderDebts(reload = true) {
  $('#view').innerHTML = `
    <div class="page">
      <div class="toolbar">
        <div class="seg" style="width:340px">
          <button data-k="Клиент" class="${S.debtKind === 'Клиент' ? 'active' : ''}">Нам должны</button>
          <button data-k="Поставщик" class="${S.debtKind === 'Поставщик' ? 'active' : ''}">Мы должны</button>
          <button id="dReload">Обновить</button>
        </div>
        <span style="flex:1"></span>
        <button class="btn primary" id="dNew">+ Запись</button>
      </div>
      <div id="dList"><div class="empty">Загружаю…</div></div>
      ${S.queue ? '<p class="note">Есть неотправленные операции — после отправки суммы изменятся.</p>' : ''}
    </div>`;
  $$('[data-k]').forEach((b) => b.addEventListener('click', () => { S.debtKind = b.dataset.k; renderDebts(false); }));
  $('#dReload').addEventListener('click', () => renderDebts(true));
  $('#dNew').addEventListener('click', () => debtForm({ kind: S.debtKind, party: '', operation: 'Погашение' }));

  if (reload || !S.debts) {
    if (!navigator.onLine) { $('#dList').innerHTML = '<div class="empty">Долги доступны только при наличии интернета</div>'; return; }
    try { S.debts = (await api('debts')).list; }
    catch (e) { $('#dList').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  }
  const list = S.debts.filter((d) => d.kind === S.debtKind && Math.abs(d.balance) > 0.001);
  const sum = round2(list.reduce((s, d) => s + d.balance, 0));
  $('#dList').innerHTML = `
    <div class="cards"><div class="card"><div class="k">${S.debtKind === 'Клиент' ? 'Всего должны нам' : 'Всего должны мы'}</div><div class="v">${fmt(sum)}</div></div></div>
    <table class="tbl"><thead><tr><th>${S.debtKind === 'Клиент' ? 'Клиент' : 'Поставщик'}</th><th class="num">Долг</th><th>Последняя операция</th><th></th></tr></thead><tbody>
      ${list.map((d) => `<tr><td>${esc(d.party)}</td><td class="num ${d.balance > 0 ? 'pos' : 'neg'}">${fmtN(d.balance)}</td><td>${d.last ? dateTime(d.last) : ''}</td>
        <td style="text-align:right"><button class="btn small" data-pay="${esc(d.party)}">Погашение</button> <button class="btn small" data-hist="${esc(d.party)}">История</button></td></tr>`).join('')}
      ${!list.length ? '<tr><td colspan="4" class="empty">Долгов нет</td></tr>' : ''}
    </tbody></table>`;
  $('#dList').addEventListener('click', (e) => {
    const p = e.target.closest('[data-pay]'), h = e.target.closest('[data-hist]');
    if (p) debtForm({ kind: S.debtKind, party: p.dataset.pay, operation: 'Погашение' });
    if (h) debtHistory(S.debtKind, h.dataset.hist);
  });
}

function debtForm(d) {
  const names = S.debts ? S.debts.filter((x) => x.kind === d.kind).map((x) => x.party) : [];
  modal(`
    <h2>Запись в долгах</h2>
    <form class="form" id="dform">
      <label>Тип<select name="kind"><option value="Клиент" ${d.kind === 'Клиент' ? 'selected' : ''}>Клиент (должен нам)</option>
        <option value="Поставщик" ${d.kind === 'Поставщик' ? 'selected' : ''}>Поставщик (мы должны)</option></select></label>
      <label>Операция<select name="operation"><option ${d.operation === 'Погашение' ? 'selected' : ''}>Погашение</option><option ${d.operation === 'Долг' ? 'selected' : ''}>Долг</option></select></label>
      <label class="wide">Контрагент<input name="party" list="dNames" value="${esc(d.party)}" required>
        <datalist id="dNames">${names.map((n) => `<option value="${esc(n)}">`).join('')}</datalist></label>
      <label>Сумма<input name="amount" inputmode="decimal" required></label>
      <label>Комментарий<input name="comment"></label>
      <div class="actions"><button type="button" class="btn" data-close>Отмена</button><button class="btn primary">Сохранить</button></div>
    </form>`, (box) => {
    $('[name=amount]', box).focus();
    $('#dform', box).addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const data = { kind: f.get('kind'), operation: f.get('operation'), party: String(f.get('party')).trim(), amount: num(f.get('amount')), comment: String(f.get('comment')) };
      if (!data.party || !(data.amount > 0)) { toast('Укажите контрагента и сумму', 'err'); return; }
      await enqueue('debt', data);
      if (S.debts) {
        let row = S.debts.find((x) => x.kind === data.kind && x.party === data.party);
        if (!row) { row = { kind: data.kind, party: data.party, balance: 0, last: 0 }; S.debts.push(row); }
        row.balance = round2(row.balance + (data.operation === 'Погашение' ? -data.amount : data.amount));
        row.last = Date.now();
      }
      closeModal();
      toast('Записано');
      renderDebts(false);
    });
  });
}

async function debtHistory(kind, party) {
  modal(`<h2>${esc(party)}</h2><div class="empty">Загружаю…</div>`);
  try {
    const { history } = await api('debts', { kind, party });
    modal(`<h2>${esc(party)}</h2>
      <table class="tbl"><thead><tr><th>Дата</th><th>Операция</th><th class="num">Сумма</th><th>Документ</th><th>Комментарий</th><th>Кто</th></tr></thead><tbody>
      ${history.map((h) => `<tr><td>${h.date ? dateTime(h.date) : ''}</td><td>${esc(h.operation)}</td><td class="num">${fmtN(h.amount)}</td>
        <td>${esc(h.doc)}</td><td>${esc(h.comment)}</td><td>${esc(h.by)}</td></tr>`).join('')}
      </tbody></table>
      <div class="actions"><button class="btn primary" data-close>Закрыть</button></div>`);
  } catch (e) {
    modal(`<h2>${esc(party)}</h2><div class="empty">${esc(e.message)}</div><div class="actions"><button class="btn" data-close>Закрыть</button></div>`);
  }
}

// ───────────────────────── Отчёт (менеджер) ─────────────────────────

function renderReport() {
  const today = dayStr(new Date());
  if (!S.reportFrom) { S.reportFrom = today; S.reportTo = today; }
  $('#view').innerHTML = `
    <div class="page">
      <div class="toolbar">
        <input type="date" class="input" id="rFrom" value="${S.reportFrom}" style="flex:0 0 auto">
        <span>—</span>
        <input type="date" class="input" id="rTo" value="${S.reportTo}" style="flex:0 0 auto">
        <button class="btn" data-q="0">Сегодня</button><button class="btn" data-q="1">Вчера</button>
        <button class="btn" data-q="7">7 дней</button><button class="btn" data-q="30">30 дней</button>
        <button class="btn primary" id="rShow">Показать</button>
      </div>
      <div id="rBody"></div>
    </div>`;
  const show = async () => {
    S.reportFrom = $('#rFrom').value;
    S.reportTo = $('#rTo').value;
    if (!navigator.onLine) { $('#rBody').innerHTML = '<div class="empty">Отчёт доступен только при наличии интернета</div>'; return; }
    $('#rBody').innerHTML = '<div class="empty">Считаю…</div>';
    try { S.report = await api('report', { from: S.reportFrom, to: S.reportTo }); drawReport(); }
    catch (e) { $('#rBody').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  };
  $$('[data-q]').forEach((b) => b.addEventListener('click', () => {
    const q = +b.dataset.q, d = new Date();
    if (q === 1) { d.setDate(d.getDate() - 1); $('#rFrom').value = $('#rTo').value = dayStr(d); }
    else { $('#rTo').value = dayStr(d); d.setDate(d.getDate() - Math.max(0, q - 1)); $('#rFrom').value = dayStr(d); }
    show();
  }));
  $('#rShow').addEventListener('click', show);
  show();
}

function drawReport() {
  const r = S.report;
  const kv = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${fmtN(v)}</td></tr>`).join('') || '<tr><td colspan="2" class="empty">—</td></tr>';
  $('#rBody').innerHTML = `
    ${S.queue ? `<div class="banner">Не отправлено операций: ${S.queue}. Они появятся в отчёте после отправки.</div>` : ''}
    <div class="cards">
      <div class="card"><div class="k">Выручка</div><div class="v">${fmt(r.total)}</div></div>
      <div class="card"><div class="k">Чеков</div><div class="v">${r.checksCount}</div></div>
      <div class="card"><div class="k">Средний чек</div><div class="v">${fmt(r.checksCount ? round2(r.total / r.checksCount) : 0)}</div></div>
      <div class="card"><div class="k">Прибыль (примерно)</div><div class="v">${fmt(r.profit)}</div></div>
    </div>
    <div class="two">
      <div><h3>По способу оплаты</h3><table class="tbl"><tbody>${kv(r.byPay)}</tbody></table></div>
      <div><h3>По продавцам</h3><table class="tbl"><tbody>${kv(r.bySeller)}</tbody></table></div>
    </div>
    <h3>Топ товаров</h3>
    <table class="tbl"><thead><tr><th>Товар</th><th class="num">Кол-во</th><th class="num">Сумма</th></tr></thead><tbody>
      ${r.top.map((p) => `<tr><td>${esc(p.name)} <span class="note">${esc(p.article)}</span></td><td class="num">${fmtN(p.qty)} ${esc(p.unit)}</td><td class="num">${fmtN(p.sum)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">Продаж нет</td></tr>'}
    </tbody></table>
    <h3>Чеки</h3>
    <table class="tbl"><thead><tr><th>Время</th><th>№ чека</th><th>Продавец</th><th>Оплата</th><th>Клиент</th><th class="num">Поз.</th><th class="num">Сумма</th></tr></thead><tbody>
      ${r.checks.map((c) => `<tr><td>${dateTime(c.time)}</td><td>${esc(c.receipt)}</td><td>${esc(c.seller)}</td><td>${esc(c.payment)}</td><td>${esc(c.client)}</td><td class="num">${c.lines}</td><td class="num">${fmtN(c.sum)}</td></tr>`).join('') || '<tr><td colspan="7" class="empty">—</td></tr>'}
    </tbody></table>
    <p class="note">Прибыль считается по текущей закупочной цене из справочника, поэтому она приблизительная.</p>`;
}

// ───────────────────────── Настройки (менеджер) ─────────────────────────

async function renderSettings() {
  const st = Photos.state();
  const stText = {
    ok: `Подключена папка «${esc(Photos.dir && Photos.dir.name)}». Фото открываются с диска.`,
    'need-permission': 'Папка выбрана, но нужен доступ — нажмите «Разрешить доступ».',
    none: 'Папка не выбрана. Фото хранятся в памяти браузера.',
    unsupported: 'Этот браузер не умеет работать с папками. Используйте Chrome или Edge. Пока фото хранятся в памяти браузера.',
  }[st];
  const ops = await DB.all('queue');
  const failed = ops.filter((o) => o.failed);
  $('#view').innerHTML = `
    <div class="page">
      <div class="box">
        <h3 style="margin-top:0">Папка с фото на этом ноутбуке</h3>
        <p>${stText}</p>
        <p class="note">Например: Загрузки\\Фото товаров. Файлы называются по артикулу: 10025.jpg. Фото хранятся только на этом ноутбуке — делайте иногда копию папки.</p>
        <div class="toolbar" style="margin:10px 0 0">
          ${Photos.supported ? '<button class="btn" id="sPick">Выбрать папку</button>' : ''}
          ${st === 'need-permission' ? '<button class="btn primary" id="sPerm">Разрешить доступ</button>' : ''}
          <button class="btn" id="sOrphans">Удалить фото без товаров</button>
        </div>
      </div>
      <div class="box">
        <h3 style="margin-top:0">Отправка в Google Таблицу</h3>
        <p>Ожидают отправки: <b>${S.queue}</b>. С ошибкой: <b>${failed.length}</b>.</p>
        ${failed.length ? `<table class="tbl"><thead><tr><th>Время</th><th>Тип</th><th>Кто</th><th>Ошибка</th><th></th></tr></thead><tbody>
          ${failed.map((o) => `<tr><td>${dateTime(o.ts)}</td><td>${{ sale: 'Продажа', purchase: 'Закуп', debt: 'Долг' }[o.type] || o.type}</td><td>${esc(o.by)}</td><td>${esc(o.error)}</td>
            <td><button class="btn small danger" data-drop="${esc(o.id)}">Удалить</button></td></tr>`).join('')}</tbody></table>` : ''}
        <div class="toolbar" style="margin:10px 0 0">
          <button class="btn primary" id="sSend">Отправить сейчас</button>
          ${failed.length ? '<button class="btn" id="sRetry">Повторить ошибочные</button>' : ''}
          <button class="btn" id="sCat">Обновить справочник</button>
        </div>
        <p class="note">Не очищайте данные браузера для этого сайта, пока здесь есть неотправленные операции.</p>
      </div>
    </div>`;
  const after = async (fn) => { try { await fn(); } catch (e) { if (e.name !== 'AbortError') toast(e.message, 'err'); } renderSettings(); };
  if ($('#sPick')) $('#sPick').addEventListener('click', () => after(async () => { await Photos.pick(); toast('Папка подключена'); }));
  if ($('#sPerm')) $('#sPerm').addEventListener('click', () => after(() => Photos.reconnect()));
  $('#sOrphans').addEventListener('click', () => after(async () => {
    if (navigator.onLine) await refreshCatalog();
    const list = await orphanPhotos();
    if (!list.length) { toast('Лишних фото нет'); return; }
    if (!confirm(`Найдено фото без товара или группы: ${list.length}\n${list.slice(0, 15).join(', ')}${list.length > 15 ? '…' : ''}\n\nУдалить их?`)) return;
    for (const n of list) await Photos.remove(n);
    toast(`Удалено фото: ${list.length}`);
  }));
  $('#sSend').addEventListener('click', () => after(syncNow));
  $('#sCat').addEventListener('click', () => after(() => refreshCatalog(false)));
  if ($('#sRetry')) $('#sRetry').addEventListener('click', () => after(async () => {
    for (const o of failed) { delete o.failed; delete o.error; await DB.put('queue', o); }
    await syncNow();
  }));
  $$('[data-drop]').forEach((b) => b.addEventListener('click', () => {
    if (confirm('Удалить эту операцию без отправки? Её данные пропадут.')) after(async () => { await DB.del('queue', b.dataset.drop); await updateQueueBadge(); });
  }));
}

// ───────────────────────── Запуск ─────────────────────────

async function init() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  await Photos.init();

  const cat = await DB.get('kv', 'catalog').catch(() => null);
  if (cat) $('#loginShop').textContent = cat.shop;
  const msg = sessionStorage.getItem('logoutMsg');
  if (msg) { $('#loginError').textContent = msg; sessionStorage.removeItem('logoutMsg'); }

  const net = () => { $('#loginNet').textContent = navigator.onLine ? 'В сети' : 'Нет интернета — продажи сохраняются и отправятся позже'; };
  net();

  $('#keypad').addEventListener('click', (e) => { const b = e.target.closest('[data-k]'); if (b) loginKey(b.dataset.k); });
  document.addEventListener('keydown', (e) => {
    if (S.user) return;
    if (/^\d$/.test(e.key)) loginKey(e.key);
    else if (e.key === 'Backspace') loginKey('back');
    else if (e.key === 'Enter') loginKey('ok');
  });
  $('#tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) go(b.dataset.tab); });
  $('#logoutBtn').addEventListener('click', () => {
    if (S.cart.length && !confirm('В чеке есть товары. Выйти без продажи?')) return;
    logout();
  });
  $('#syncBadge').addEventListener('click', () => { syncNow(); if (S.failed && ROLE_LEVEL[S.user.role] >= 2) go('settings'); });
  $('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  ['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, () => { S.lastActivity = Date.now(); }, true));
  window.addEventListener('online', () => { net(); updateQueueBadge(); syncNow(); refreshCatalog(); });
  window.addEventListener('offline', () => { net(); updateQueueBadge(); });

  // Автовыход при бездействии
  setInterval(() => {
    if (!S.user) return;
    const lim = (CFG.IDLE_LOGOUT_MIN[S.user.role] || 10) * 60000;
    if (Date.now() - S.lastActivity > lim) logout('Выход по бездействию');
  }, 15000);
  setInterval(() => { if (S.user) syncNow(); }, CFG.SYNC_INTERVAL_SEC * 1000);
  setInterval(() => { if (S.user && S.view !== 'products') refreshCatalog(); }, CFG.CATALOG_REFRESH_MIN * 60000);
}

init();
