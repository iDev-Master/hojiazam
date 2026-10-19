/*
 * ТЕСТОВЫЙ СЕРВЕР — для проверки на ноутбуке без интернета, GitHub и Apps Script.
 *
 * Включается сам, когда index.html открыт с диска (двойной клик) или с localhost.
 * На GitHub Pages не загружается. Повторяет логику Code.gs: роли, продажи, закупы,
 * долги, историю цен, удаление, отчёт. Данные лежат в localStorage этого браузера
 * и в настоящую Google Таблицу не попадают.
 *
 * Тестовые PIN: Админ 1111 · Менеджер 2222 · Продавец 3333
 */
(function () {
  'use strict';

  const KEY = 'mini-kassa-mock';
  const DEV = { offline: false, delay: 300 };
  const LV = { seller: 1, manager: 2, admin: 3 };
  const TOKEN_HOURS = { seller: 720, manager: 720, admin: 720 };
  const DEBT = 'В долг';

  // ───────── Тестовые данные ─────────
  function seed() {
    return {
      settings: { shop: 'Тестовый магазин', currency: 'С', sellerMaxDiscount: 10 },
      payMethods: [{ name: 'Наличные', active: true }, { name: 'Алиф', active: true }, { name: 'ДС', active: true }],
      money: [],
      staff: [
        { id: 'U1', name: 'Админ', role: 'admin', pin: '1111', active: true },
        { id: 'U2', name: 'Менеджер', role: 'manager', pin: '2222', active: true },
        { id: 'U3', name: 'Продавец', role: 'seller', pin: '3333', active: true },
      ],
      groups: [
        { id: 'G01', name: 'Гвозди', order: 10 },
        { id: 'G02', name: 'Шурупы', order: 20 },
        { id: 'G03', name: 'Краски', order: 30 },
      ],
      products: [
        { article: '10025', name: 'Гвоздь 100 мм', group: 'G01', barcode: '4601234567890', unit: 'кг', price: 25, cost: 18, active: true },
        { article: '10026', name: 'Гвоздь 50 мм', group: 'G01', barcode: '4601234567891', unit: 'кг', price: 22, cost: 16, active: true },
        { article: '10027', name: 'Гвоздь кровельный', group: 'G01', barcode: '', unit: 'кг', price: 30, cost: 21, active: true },
        { article: '20001', name: 'Шуруп по дереву 4×40', group: 'G02', barcode: '4609876543210', unit: 'упак', price: 15, cost: 9, active: true },
        { article: '20002', name: 'Саморез по металлу 4,2×19', group: 'G02', barcode: '', unit: 'упак', price: 12, cost: 7.5, active: true },
        { article: '30001', name: 'Краска белая 2,5 л', group: 'G03', barcode: '4600000000017', unit: 'шт', price: 95, cost: 70, active: true },
        { article: '30002', name: 'Эмаль ПФ-115 синяя', group: 'G03', barcode: '', unit: 'шт', price: 60, cost: 42, active: true },
        { article: '99999', name: 'Скрытый товар (неактивен)', group: 'G03', barcode: '', unit: 'шт', price: 10, cost: 5, active: false },
      ],
      prices: [], purchases: [], debts: [], sales: [],
    };
  }
  let db = load();
  function load() {
    try {
      const v = JSON.parse(localStorage.getItem(KEY));
      if (v && v.products && v.payMethods) return v;   // старые тестовые данные без способов оплаты — пересоздаём
    } catch (e) { /* пусто */ }
    const s = seed();
    localStorage.setItem(KEY, JSON.stringify(s));
    return s;
  }
  function save() { localStorage.setItem(KEY, JSON.stringify(db)); }

  // ───────── Помощники ─────────
  const err = (m, code) => Object.assign(new Error(m), { code: code || 'ERR' });
  const r2 = (n, d = 2) => { const k = Math.pow(10, d); return Math.round((Number(n) || 0) * k) / k; };
  const uniq = (a) => [...new Set(a.filter(Boolean))].sort((x, y) => x.localeCompare(y, 'ru'));
  const photoName = (k) => String(k).trim().replace(/[\\/:*?"<>|\s]+/g, '_') + '.jpg';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function makeToken(u) {
    const payload = btoa(JSON.stringify({ id: u.id, role: u.role, exp: Date.now() + TOKEN_HOURS[u.role] * 3600e3 }));
    return payload + '.mock';
  }
  function verify(token, at) {
    if (!token) throw err('Нужно войти заново', 'AUTH');
    const [p, sig] = String(token).split('.');
    if (sig !== 'mock') throw err('Недействительная сессия', 'AUTH');
    let t;
    try { t = JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/'))); } catch (e) { throw err('Недействительная сессия', 'AUTH'); }
    if ((at || Date.now()) > t.exp) throw err('Сессия истекла, войдите заново', 'AUTH');
    const u = db.staff.find((x) => x.id === t.id);
    if (!u || !u.active) throw err('Сотрудник отключён', 'AUTH');
    return u;
  }

  // ───────── Действия (как в Code.gs) ─────────
  const ACTIONS = {
    login: { level: 0, fn: (d) => {
      const pin = String(d.pin || '').trim();
      if (!/^\d{4,8}$/.test(pin)) throw err('PIN должен состоять из 4–8 цифр', 'AUTH');
      const u = db.staff.find((x) => x.active && x.pin === pin);
      if (!u) throw err('Неверный PIN', 'AUTH');
      return { user: { id: u.id, name: u.name, role: u.role }, token: makeToken(u) };
    } },

    catalog: { level: 1, fn: (d, user) => {
      const isManager = LV[user.role] >= 2;
      const res = {
        shop: db.settings.shop, currency: db.settings.currency, version: String(Date.now()),
        sellerMaxDiscount: db.settings.sellerMaxDiscount ?? 10,
        payMethods: db.payMethods.filter((m) => m.active).map((m) => m.name),
        groups: db.groups.map((g) => ({ id: g.id, name: g.name, photo: photoName(g.id), order: g.order }))
          .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'ru')),
        products: db.products.filter((p) => isManager || p.active).map((p) => {
          const o = { article: p.article, name: p.name, group: p.group, barcode: p.barcode, unit: p.unit, price: p.price, active: p.active };
          if (isManager) o.cost = p.cost;
          return o;
        }),
        clients: uniq(db.debts.filter((r) => r.kind === 'Клиент').map((r) => r.party)),
      };
      if (isManager) res.payMethodsAll = db.payMethods.map((m) => Object.assign({}, m));
      if (isManager) res.suppliers = uniq(db.purchases.map((r) => r.supplier).concat(db.debts.filter((r) => r.kind === 'Поставщик').map((r) => r.party)));
      return res;
    } },

    sync: { level: 0, fn: (d) => ({
      results: (d.ops || []).slice(0, 30).map((op) => {
        try {
          if (!op || !/^[\w-]{6,64}$/.test(String(op.id))) throw err('Неверный ID операции', 'BAD');
          if (!op.ts || op.ts > Date.now() + 600000) throw err('Время операции в будущем — проверьте часы на компьютере', 'BAD');
          const user = verify(op.token, op.ts);
          const h = OPS[op.type];
          if (!h) throw err('Неизвестный тип операции', 'BAD');
          if (LV[user.role] < h.level) throw err('Недостаточно прав', 'FORBIDDEN');
          return { id: op.id, ok: true, dup: h.fn(op, user) === 'dup' };
        } catch (x) {
          const code = x.code || 'ERR';
          return { id: op && op.id, ok: false, error: x.message, code, fatal: ['AUTH', 'BAD', 'FORBIDDEN'].includes(code) };
        }
      }),
    }) },

    saveProduct: { level: 2, fn: (d, user) => {
      const p = d.product || {};
      const article = String(p.article || '').trim();
      if (!article) throw err('Укажите артикул', 'BAD');
      if (!String(p.name || '').trim()) throw err('Укажите наименование', 'BAD');
      const idx = db.products.findIndex((x) => x.article === article);
      if (d.isNew && idx >= 0) throw err('Товар с артикулом ' + article + ' уже есть', 'BAD');
      const barcode = String(p.barcode || '').trim();
      const other = barcode && db.products.find((x) => x.barcode === barcode && x.article !== article);
      if (other) throw err('Этот штрих-код уже записан у товара ' + other.article, 'BAD');
      const row = { article, name: String(p.name).trim(), group: String(p.group || ''), barcode, unit: p.unit || 'шт', price: r2(p.price), cost: r2(p.cost), active: p.active !== false };
      const now = Date.now();
      if (idx >= 0) {
        if (db.products[idx].price !== row.price) db.prices.push({ date: now, article, name: row.name, old: db.products[idx].price, new: row.price, by: user.name });
        db.products[idx] = row;
      } else {
        db.products.push(row);
        db.prices.push({ date: now, article, name: row.name, old: '', new: row.price, by: user.name });
      }
      return { saved: article };
    } },

    deleteProduct: { level: 2, fn: (d, user) => {
      const i = db.products.findIndex((x) => x.article === String(d.article || '').trim());
      if (i < 0) throw err('Товар ' + d.article + ' не найден', 'BAD');
      const p = db.products[i];
      db.prices.push({ date: Date.now(), article: p.article, name: p.name, old: p.price, new: '', by: user.name + ' (товар удалён)' });
      db.products.splice(i, 1);
      return { deleted: p.article };
    } },

    saveGroup: { level: 2, fn: (d) => {
      const g = d.group || {};
      const id = String(g.id || '').trim(), name = String(g.name || '').trim();
      if (!id || !name) throw err('Укажите ID и название группы', 'BAD');
      const row = { id, name, order: Number(g.order) || 0 };
      const i = db.groups.findIndex((x) => x.id === id);
      if (i >= 0) db.groups[i] = row; else db.groups.push(row);
      return { saved: id };
    } },

    savePayMethods: { level: 2, fn: (d) => {
      const list = (d.methods || []).map((m) => ({ name: String(m.name || '').trim().slice(0, 40), active: m.active !== false }))
        .filter((m) => m.name && m.name !== DEBT);
      const seen = new Set();
      list.forEach((m) => { const k = m.name.toLowerCase(); if (seen.has(k)) throw err('Способ «' + m.name + '» указан дважды', 'BAD'); seen.add(k); });
      if (!list.some((m) => m.active)) throw err('Нужен хотя бы один активный способ оплаты', 'BAD');
      db.payMethods = list;
      return { saved: list.length };
    } },

    deleteGroup: { level: 2, fn: (d) => {
      const id = String(d.id || '').trim();
      const n = db.products.filter((p) => p.group === id).length;
      if (n) throw err('В группе ' + n + ' тов. Сначала перенесите их в другую группу или удалите.', 'BAD');
      const i = db.groups.findIndex((x) => x.id === id);
      if (i < 0) throw err('Группа ' + id + ' не найдена', 'BAD');
      db.groups.splice(i, 1);
      return { deleted: id };
    } },

    debts: { level: 2, fn: (d) => {
      const map = {};
      db.debts.forEach((r) => {
        const k = r.kind + '|' + r.party;
        if (!map[k]) map[k] = { kind: r.kind, party: r.party, balance: 0, last: 0 };
        map[k].balance += r.operation === 'Погашение' ? -r.amount : r.amount;
        map[k].last = Math.max(map[k].last, r.date);
      });
      const list = Object.values(map).map((m) => Object.assign(m, { balance: r2(m.balance) }))
        .sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));
      const history = d.party
        ? db.debts.filter((r) => r.party === d.party && r.kind === d.kind)
          .map((r) => ({ date: r.date, operation: r.operation, amount: r.amount, doc: r.doc, comment: r.comment, by: r.by })).reverse()
        : null;
      return { list, history };
    } },

    report: { level: 2, fn: (d) => {
      const from = new Date(d.from + 'T00:00:00').getTime();
      const to = new Date(d.to + 'T00:00:00').getTime() + 864e5;
      if (!(to > from)) throw err('Неверный период', 'BAD');
      const costs = {};
      db.products.forEach((p) => { costs[p.article] = p.cost || 0; });
      let total = 0, cost = 0, discount = 0;
      const byPay = {}, bySeller = {}, byProd = {}, checks = {}, discBySeller = {}, cashflow = {}, flowByType = {};
      const moneyReceipts = {};
      db.money.filter((r) => r.date >= from && r.date < to).forEach((r) => {
        cashflow[r.method] = (cashflow[r.method] || 0) + r.amount;
        flowByType[r.type] = flowByType[r.type] || {};
        flowByType[r.type][r.method] = (flowByType[r.type][r.method] || 0) + r.amount;
        if (r.type === 'Продажа' || r.type === 'Сдача') { byPay[r.method] = (byPay[r.method] || 0) + r.amount; moneyReceipts[r.doc.replace(/^Чек /, '')] = true; }
      });
      db.debts.filter((r) => r.date >= from && r.date < to && String(r.doc).startsWith('Чек ') && moneyReceipts[r.doc.slice(4)])
        .forEach((r) => { byPay[DEBT] = (byPay[DEBT] || 0) + r.amount; });
      db.sales.filter((r) => r.date >= from && r.date < to).forEach((r) => {
        const disc = r.discount || 0;
        total += r.sum;
        discount += disc;
        if (disc) discBySeller[r.seller] = (discBySeller[r.seller] || 0) + disc;
        cost += r.qty * (costs[r.article] || 0);
        if (!moneyReceipts[r.receipt]) byPay[r.payment] = (byPay[r.payment] || 0) + r.sum;
        bySeller[r.seller] = (bySeller[r.seller] || 0) + r.sum;
        if (!byProd[r.article]) byProd[r.article] = { article: r.article, name: r.name, unit: r.unit, qty: 0, sum: 0 };
        byProd[r.article].qty += r.qty;
        byProd[r.article].sum += r.sum;
        if (!checks[r.receipt]) checks[r.receipt] = { receipt: r.receipt, time: r.date, seller: r.seller, payment: r.payment, client: r.client, sum: 0, lines: 0, discount: 0 };
        checks[r.receipt].sum += r.sum;
        checks[r.receipt].discount += disc;
        checks[r.receipt].lines += 1;
      });
      const list = Object.values(checks).sort((a, b) => b.time - a.time);
      return {
        total: r2(total), profit: r2(total - cost), discount: r2(discount), discBySeller, cashflow, flowByType, checksCount: list.length, byPay, bySeller,
        top: Object.values(byProd).sort((a, b) => b.sum - a.sum).slice(0, 30), checks: list.slice(0, 300),
      };
    } },
  };

  const OPS = {
    sale: { level: 1, fn: (op, user) => {
      const d = op.data || {};
      const items = (d.items || []).filter((i) => Number(i.qty) > 0);
      if (!items.length) throw err('Пустой чек', 'BAD');
      if (db.sales.some((r) => r.id === op.id + '-1')) return 'dup';
      const client = String(d.client || '').trim();
      const receipt = d.receipt || op.id;
      let total = 0;
      const lines = items.map((it) => {
        const qty = r2(it.qty, 3), price = r2(it.price);
        const base = it.basePrice === undefined ? price : r2(it.basePrice);
        let sum = it.sum === undefined ? r2(qty * price) : r2(it.sum);
        if (!(sum >= 0)) sum = 0;
        total += sum;
        return { it, qty, price, base, sum };
      });
      total = r2(total);
      let payments, debt, change = null;
      if (Array.isArray(d.payments)) {
        payments = d.payments; debt = r2(d.debt || 0);
        if (d.change && Number(d.change.amount) > 0) change = { method: String(d.change.method || 'Наличные'), amount: r2(d.change.amount) };
      } else if (d.payment === DEBT) { payments = []; debt = total; }
      else { payments = [{ method: d.payment || 'Наличные', amount: total }]; debt = 0; }
      payments = payments.filter((x) => Number(x.amount) > 0).map((x) => ({ method: String(x.method), amount: r2(x.amount) }));
      const paid = payments.reduce((acc, x) => acc + x.amount, 0);
      if (Math.abs(paid + debt - (change ? change.amount : 0) - total) > 0.011) throw err('Оплата не сходится с суммой чека', 'BAD');
      if (debt > 0 && !client) throw err('Для продажи в долг нужен клиент', 'BAD');
      const payLabel = payments.map((x) => x.method).concat(debt > 0 ? [DEBT] : []).join(' + ');
      lines.forEach((l, i) => db.sales.push({ id: op.id + '-' + (i + 1), receipt, date: op.ts, seller: user.name, article: String(l.it.article), name: l.it.name, qty: l.qty, unit: l.it.unit || '', price: l.price, sum: l.sum, payment: payLabel, client, basePrice: l.base, discount: r2(l.qty * l.base - l.sum) }));
      payments.forEach((x, i) => db.money.push({ id: op.id + '-P' + (i + 1), date: op.ts, type: 'Продажа', doc: 'Чек ' + receipt, method: x.method, amount: x.amount, party: client, by: user.name }));
      if (change) db.money.push({ id: op.id + '-C', date: op.ts, type: 'Сдача', doc: 'Чек ' + receipt, method: change.method, amount: -change.amount, party: client, by: user.name });
      if (debt > 0) db.debts.push({ id: op.id + '-D', date: op.ts, party: client, kind: 'Клиент', operation: 'Долг', amount: debt, doc: 'Чек ' + receipt, comment: '', by: user.name });
    } },
    purchase: { level: 2, fn: (op, user) => {
      const d = op.data || {};
      const supplier = String(d.supplier || '').trim();
      const items = (d.items || []).filter((i) => Number(i.qty) > 0);
      if (!supplier) throw err('Не указан поставщик', 'BAD');
      if (!items.length) throw err('Пустой закуп', 'BAD');
      if (db.purchases.some((r) => r.doc === op.id)) return 'dup';
      let total = 0;
      items.forEach((it, i) => {
        const qty = r2(it.qty, 3), price = r2(it.price), sum = r2(qty * price);
        total += sum;
        db.purchases.push({ id: op.id + '-' + (i + 1), doc: op.id, date: op.ts, supplier, article: String(it.article), name: it.name, qty, price, sum, by: user.name });
        const p = db.products.find((x) => x.article === String(it.article));
        if (p && price > 0) p.cost = price;
      });
      const paid = Math.min(r2(total), Math.max(0, r2(d.paid || 0)));
      if (paid > 0) db.money.push({ id: op.id + '-P', date: op.ts, type: 'Оплата поставщику', doc: 'Закуп ' + op.id, method: d.method || 'Наличные', amount: -paid, party: supplier, by: user.name });
      const debt = r2(total - paid);
      if (debt > 0) db.debts.push({ id: op.id + '-D', date: op.ts, party: supplier, kind: 'Поставщик', operation: 'Долг', amount: debt, doc: 'Закуп ' + op.id, comment: '', by: user.name });
    } },
    debt: { level: 2, fn: (op, user) => {
      const d = op.data || {};
      const party = String(d.party || '').trim(), amount = r2(d.amount);
      if (!party || !(amount > 0)) throw err('Укажите контрагента и сумму', 'BAD');
      if (db.debts.some((r) => r.id === op.id)) return 'dup';
      const kind = d.kind === 'Поставщик' ? 'Поставщик' : 'Клиент', operation = d.operation === 'Долг' ? 'Долг' : 'Погашение';
      db.debts.push({ id: op.id, date: op.ts, party, kind, operation, amount, doc: operation === 'Погашение' ? (d.method || '') : '', comment: String(d.comment || ''), by: user.name });
      if (operation === 'Погашение') db.money.push({ id: op.id + '-M', date: op.ts, type: kind === 'Клиент' ? 'Погашение долга клиентом' : 'Погашение долга поставщику', doc: 'Долг', method: d.method || 'Наличные', amount: kind === 'Клиент' ? amount : -amount, party, by: user.name });
    } },
  };

  // ───────── Точка входа для app.js ─────────
  window.MockServer = {
    async request(body) {
      await sleep(DEV.delay);
      if (DEV.offline) throw Object.assign(new Error('Нет связи с сервером'), { code: 'NET' });
      try {
        const a = ACTIONS[body.action];
        if (!a) throw err('Неизвестное действие: ' + body.action, 'BAD');
        let user = null;
        if (a.level > 0) {
          user = verify(body.token);
          if (LV[user.role] < a.level) throw err('Недостаточно прав', 'FORBIDDEN');
        }
        const data = a.fn(body.data || {}, user);
        save();
        return { ok: true, data: JSON.parse(JSON.stringify(data)) };
      } catch (x) {
        db = load();   // откат несохранённых изменений, как при ошибке на сервере
        return { ok: false, error: x.message, code: x.code || 'ERR' };
      }
    },
  };

  // «Нет интернета» для всего приложения
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => !DEV.offline });

  // ───────── Панель тестирования ─────────
  const css = `
    #mk-dev-btn{position:fixed;left:12px;bottom:12px;z-index:200;background:#7a2e9e;color:#fff;border:0;border-radius:20px;padding:8px 14px;font:600 13px system-ui;box-shadow:0 4px 14px rgba(0,0,0,.25);cursor:pointer}
    #mk-dev-btn.off{background:#b23b2b}
    #mk-dev{position:fixed;left:12px;bottom:56px;z-index:200;width:300px;background:#fff;border:2px solid #7a2e9e;border-radius:12px;padding:14px;font:14px system-ui;color:#1d2523;box-shadow:0 8px 30px rgba(0,0,0,.25)}
    #mk-dev h4{margin:0 0 8px;font-size:15px;color:#7a2e9e}
    #mk-dev p{margin:6px 0;font-size:13px;color:#555}
    #mk-dev label{display:flex;align-items:center;gap:8px;margin:8px 0}
    #mk-dev .row{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
    #mk-dev button{border:1px solid #ccc;background:#f7f7f7;border-radius:8px;padding:6px 10px;cursor:pointer;font:13px system-ui}
    #mk-dev button.red{color:#b23b2b}
    #mk-view{position:fixed;inset:0;z-index:300;background:rgba(0,0,0,.5);display:grid;place-items:center;padding:16px}
    #mk-view .box{background:#fff;border-radius:12px;padding:16px;width:min(1100px,100%);max-height:90vh;overflow:auto;font:13px system-ui}
    #mk-view .tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}
    #mk-view .tabs button{border:1px solid #ccc;background:#f7f7f7;border-radius:8px;padding:5px 10px;cursor:pointer}
    #mk-view .tabs button.on{background:#7a2e9e;color:#fff;border-color:#7a2e9e}
    #mk-view table{border-collapse:collapse;width:100%}
    #mk-view th,#mk-view td{border:1px solid #e3e3e3;padding:4px 6px;text-align:left;white-space:nowrap}
    #mk-view th{background:#f4f0f7}
    @media (max-width:760px){
      #mk-dev-btn{left:auto;right:0;bottom:auto;top:42%;border-radius:10px 0 0 10px;padding:10px 5px;font-size:11px;writing-mode:vertical-rl;opacity:.85}
      #mk-dev{left:10px;right:10px;width:auto;bottom:auto;top:20%}
    }`;
  const SHEETS = [
    ['Товары', () => db.products], ['Группы', () => db.groups], ['История цен', () => db.prices],
    ['Продажи', () => db.sales], ['Касса', () => db.money], ['Закупы', () => db.purchases], ['Долги', () => db.debts],
    ['Способы оплаты', () => db.payMethods], ['Сотрудники', () => db.staff],
  ];
  const e = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const cell = (v, k) => (k === 'date' && typeof v === 'number' ? new Date(v).toLocaleString('ru-RU') : v);

  function viewSheets(i = 0) {
    db = load();
    let v = document.getElementById('mk-view');
    if (!v) { v = document.createElement('div'); v.id = 'mk-view'; document.body.appendChild(v); }
    const rows = SHEETS[i][1]();
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    v.innerHTML = `<div class="box">
      <div class="tabs">${SHEETS.map((s, j) => `<button data-i="${j}" class="${j === i ? 'on' : ''}">${s[0]} (${s[1]().length})</button>`).join('')}
        <span style="flex:1"></span><button data-close>Закрыть</button></div>
      ${rows.length ? `<table><tr>${cols.map((c) => `<th>${e(c)}</th>`).join('')}</tr>
        ${rows.slice().reverse().map((r) => `<tr>${cols.map((c) => `<td>${e(cell(r[c], c))}</td>`).join('')}</tr>`).join('')}</table>` : '<p>Пусто</p>'}
    </div>`;
    v.onclick = (ev) => {
      const b = ev.target.closest('button');
      if (ev.target === v || (b && b.hasAttribute('data-close'))) v.remove();
      else if (b && b.dataset.i) viewSheets(+b.dataset.i);
    };
  }

  function resetAll() {
    if (!confirm('Стереть ВСЕ тестовые данные (товары, продажи, очередь, вход) и начать заново?\nНастоящая Google Таблица не затрагивается.')) return;
    localStorage.removeItem(KEY);
    sessionStorage.clear();
    const req = indexedDB.deleteDatabase('mini-kassa');
    const go = () => location.reload();
    req.onsuccess = go; req.onerror = go; req.onblocked = () => setTimeout(go, 300);
  }

  function panel() {
    const st = document.createElement('style');
    st.textContent = css;
    document.head.appendChild(st);
    const btn = document.createElement('button');
    btn.id = 'mk-dev-btn';
    document.body.appendChild(btn);
    const p = document.createElement('div');
    p.id = 'mk-dev';
    p.hidden = true;
    p.innerHTML = `
      <h4>🧪 Тестовый режим</h4>
      <p>Данные хранятся только в этом браузере и в Google не отправляются.</p>
      <p><b>PIN:</b> Админ 1111 · Менеджер 2222 · Продавец 3333</p>
      <label><input type="checkbox" id="mk-off"> Нет интернета</label>
      <label>Ответ сервера <select id="mk-delay"><option value="0">сразу</option><option value="300" selected>0,3 с</option><option value="2000">2 с (медленный)</option></select></label>
      <div class="row"><button id="mk-view-btn">Таблицы</button><button id="mk-reset" class="red">Сбросить всё</button></div>`;
    document.body.appendChild(p);
    const draw = () => {
      btn.textContent = DEV.offline ? '🧪 ТЕСТ · нет интернета' : '🧪 ТЕСТ';
      btn.className = DEV.offline ? 'off' : '';
    };
    btn.onclick = () => { p.hidden = !p.hidden; };
    p.querySelector('#mk-off').onchange = (ev) => {
      DEV.offline = ev.target.checked;
      window.dispatchEvent(new Event(DEV.offline ? 'offline' : 'online'));
      draw();
    };
    p.querySelector('#mk-delay').onchange = (ev) => { DEV.delay = +ev.target.value; };
    p.querySelector('#mk-view-btn').onclick = () => viewSheets(0);
    p.querySelector('#mk-reset').onclick = resetAll;
    draw();
    document.title = 'ТЕСТ · ' + document.title;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', panel); else panel();
})();
