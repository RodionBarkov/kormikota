'use strict';

/* ═════════════ утилиты ═════════════ */

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nowSec = () => Math.floor(Date.now() / 1000);
const store = {
  get(k, d) { try { const v = localStorage.getItem('kl_' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('kl_' + k, JSON.stringify(v)); } catch (e) { /* приватный режим */ } },
};

const STATUS = { have: 'Есть', low: 'Мало', out: 'Нет' };
const STATUS_LONG = { have: 'есть', low: 'заканчивается', out: 'нет' };
const BOUGHT_VISIBLE = 12 * 3600; // сколько часов купленное висит зачёркнутым в списке
const FEED_WHAT = ['Сухой корм', 'Влажный корм', 'Лакомство'];
const FEED_DAYS = 35; // столько дней истории кормлений видно сразу (столько же отдаёт сервер в /api/state)
const FEED_MORE_DAYS = 30; // «Показать ещё» добавляет столько дней
const TABS = [
  { id: 'buy', ic: '🛒', name: 'Купить' },
  { id: 'home', ic: '🏠', name: 'Дома' },
  { id: 'tigra', ic: '🐯', name: 'Тигра' },
  { id: 'log', ic: '🕓', name: 'История' },
  { id: 'more', ic: '⚙️', name: 'Ещё' },
];

const S = {
  me: null, users: [], cats: [], items: [], feedings: [], feedOldest: null, feedFrom: null, rev: 0, tigraPhoto: null,
  tab: store.get('tab', 'buy'), cat: 'all', q: '', addQ: '', feedWhat: '',
  log: [], logUser: '', logMore: true, logLoading: false,
  sheetOpen: false, pendingRender: false, installEvt: null,
};

const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MONTHS_FULL = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];

const hhmm = (d) => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const daysAgoStart = (n) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - n); return d.getTime() / 1000; };
const tz = () => new Date().getTimezoneOffset();

function when(ts) {
  const d = new Date(ts * 1000);
  const diff = Math.round((dayStart(new Date()) - dayStart(d)) / 86400000);
  if (diff === 0) return 'сегодня в ' + hhmm(d);
  if (diff === 1) return 'вчера в ' + hhmm(d);
  const y = d.getFullYear() !== new Date().getFullYear() ? ' ' + d.getFullYear() : '';
  return d.getDate() + ' ' + MONTHS[d.getMonth()] + y + ' в ' + hhmm(d);
}

function ago(ts) {
  const s = nowSec() - ts;
  if (s < 60) return 'только что';
  if (s < 3600) return Math.floor(s / 60) + ' мин назад';
  if (s < 12 * 3600) {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h + ' ч' + (m && h < 6 ? ' ' + m + ' мин' : '') + ' назад';
  }
  return when(ts);
}

function dayLabel(ts) {
  const d = new Date(ts * 1000);
  const diff = Math.round((dayStart(new Date()) - dayStart(d)) / 86400000);
  if (diff === 0) return 'Сегодня';
  if (diff === 1) return 'Вчера';
  const y = d.getFullYear() !== new Date().getFullYear() ? ' ' + d.getFullYear() : '';
  return WEEKDAYS[d.getDay()] + ', ' + d.getDate() + ' ' + MONTHS_FULL[d.getMonth()] + y;
}

function groupByDay(list) {
  const out = [];
  let cur = null;
  for (const x of list) {
    const lbl = dayLabel(x.at);
    if (!cur || cur.label !== lbl) { cur = { label: lbl, items: [] }; out.push(cur); }
    cur.items.push(x);
  }
  return out;
}

function plural(n, one, few, many) {
  const a = n % 10, b = n % 100;
  if (a === 1 && b !== 11) return one;
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few;
  return many;
}

/* ═════════════ картинки-заглушки по названию ═════════════ */

const EMOJI_RULES = [
  [/зубн|щётк|щетк/, '🪥'], [/туалетн|бумаг|салфет|полотенц/, '🧻'], [/мыл/, '🧼'],
  [/шампун|бальзам|гель|дезодор|крем|лосьон/, '🧴'], [/порош|стирк|кондиционер|капсул/, '🧺'],
  [/губк/, '🧽'], [/посуд|фейри|fairy/, '🫧'], [/чистящ|хлор|белизн|доместос|отбел|средств/, '🧪'],
  [/мусор|пакет/, '🗑️'], [/лампоч/, '💡'], [/батаре/, '🔋'], [/фольг|плёнк|пленк|пергамент/, '🎞️'],
  [/наполнит|лоток/, '🪣'], [/корм|пауч|whiskas|felix|вискас|феликс|purina|пурина/, '🐱'],
  [/таблет|лекарств|витамин|капли/, '💊'], [/пласт|бинт/, '🩹'], [/прокладк|тампон/, '🌸'], [/бритв/, '🪒'],
  [/подгуз/, '👶'], [/свеч/, '🕯️'], [/спичк|зажигал/, '🔥'],
  [/сливочн|масло слив/, '🧈'], [/молок|кефир|ряженк|сливк/, '🥛'], [/сыр/, '🧀'],
  [/йогурт|творог|сметан|простокваш/, '🥣'], [/яйц/, '🥚'], [/хлеб|батон|багет|лаваш|булк/, '🍞'],
  [/курин|куриц|окороч|индейк|крыл/, '🍗'], [/колбас|сосис|сардел|ветчин|бекон/, '🌭'],
  [/мяс|фарш|говяд|свин|баран|стейк/, '🥩'], [/кревет/, '🦐'], [/рыб|лосос|сёмг|семг|форел|тунец|селёд|селед|скумбр/, '🐟'],
  [/картоф|картош/, '🥔'], [/морков/, '🥕'], [/чеснок/, '🧄'], [/^лук|\sлук/, '🧅'],
  [/помидор|томат|черри/, '🍅'], [/огур/, '🥒'], [/перец|перц/, '🫑'], [/капуст|брокк/, '🥦'],
  [/салат|зелен|укроп|петрушк|шпинат/, '🥬'], [/гриб|шампиньон/, '🍄'], [/кукуруз/, '🌽'], [/баклаж/, '🍆'],
  [/яблок/, '🍎'], [/банан/, '🍌'], [/апельс|мандар/, '🍊'], [/лимон/, '🍋'], [/груш/, '🍐'],
  [/виноград/, '🍇'], [/клубник|ягод|малин/, '🍓'], [/авокадо/, '🥑'], [/арбуз/, '🍉'], [/персик/, '🍑'],
  [/рис/, '🍚'], [/макарон|спагет|лапш|паст[аы]/, '🍝'], [/греч|круп|овсян|хлопь|мюсли|каш/, '🥣'],
  [/мук/, '🌾'], [/сахар/, '🍬'], [/соль/, '🧂'], [/мёд|мед$/, '🍯'], [/масло/, '🫒'],
  [/кетчуп|соус|майонез|горчиц|консерв|тушёнк|тушенк|фасол|горош/, '🥫'],
  [/чай/, '🍵'], [/кофе/, '☕'], [/сок/, '🧃'], [/вод[аы]|минерал/, '💧'], [/пив/, '🍺'], [/вин[оа]/, '🍷'],
  [/шокол|конфет/, '🍫'], [/печень|крекер/, '🍪'], [/торт|пирож|выпечк/, '🍰'], [/морожен/, '🍦'],
  [/пицц/, '🍕'], [/пельмен|вареник/, '🥟'], [/чипс|сухар|снек/, '🥨'], [/орех|арахис/, '🥜'],
];

function guessEmoji(name) {
  const n = ' ' + String(name || '').toLowerCase();
  for (const [re, em] of EMOJI_RULES) if (re.test(n.trim()) || re.test(n)) return em;
  return null;
}

const CAT_GUESS = [
  [/зубн|мыл|шампун|бальзам|гель|дезодор|крем|бритв|прокладк|тампон|туалетн|ватн/, 'Гигиена'],
  [/порош|стирк|кондиционер|губк|посуд|чистящ|хлор|белизн|мусор|фольг|пленк|плёнк|салфет|средств/, 'Бытовая химия'],
  [/корм|наполнит|лоток|пауч|кошач/, 'Для Тигры'],
  [/таблет|лекарств|витамин|пласт|бинт|капли/, 'Аптечка'],
  [/молок|кефир|сыр|творог|сметан|йогурт|ряженк|сливк|масло слив|сливочн/, 'Молочное'],
  [/мяс|фарш|кур|рыб|колбас|сосис|ветчин|индейк|лосос|кревет|говяд|свин/, 'Мясо и рыба'],
  [/картоф|картош|морков|лук|чеснок|помидор|томат|огур|перец|капуст|яблок|банан|апельс|мандар|лимон|груш|виноград|ягод|зелен|салат|авокадо|гриб/, 'Овощи и фрукты'],
  [/хлеб|батон|багет|лаваш|булк|выпечк/, 'Хлеб и выпечка'],
  [/пельмен|вареник|морожен|заморож/, 'Заморозка'],
  [/шокол|конфет|печень|чипс|снек|орех|торт/, 'Сладкое и снеки'],
  [/чай|кофе|сок|вод[аы]|пив|вин[оа]|лимонад|газиров/, 'Напитки'],
  [/рис|макарон|спагет|греч|круп|овсян|мук|сахар|соль|масло|соус|кетчуп|майонез|консерв|специ|лапш|хлопь/, 'Бакалея'],
];

function guessCategory(name) {
  const n = String(name || '').toLowerCase();
  for (const [re, catName] of CAT_GUESS) {
    if (re.test(n)) {
      const c = S.cats.find((x) => x.name.toLowerCase() === catName.toLowerCase());
      if (c) return c.id;
    }
  }
  const other = S.cats.find((x) => x.name === 'Прочее');
  return other ? other.id : (S.cats[0] ? S.cats[0].id : null);
}

/* ═════════════ данные ═════════════ */

const catById = (id) => S.cats.find((c) => c.id === id);
const itemById = (id) => S.items.find((i) => i.id === id);
const userById = (id) => S.users.find((u) => u.id === id);
const userName = (id) => (userById(id) || { name: '—' }).name;
const thumbUrl = (p) => '/photos/' + p.split('|')[1];
const fullUrl = (p) => '/photos/' + p.split('|')[0];

function itemEmoji(it) {
  const c = catById(it.category_id);
  return guessEmoji(it.name) || (c ? c.emoji : '📦');
}

function thumbHtml(it, act) {
  const inner = it.photo
    ? `<img src="${thumbUrl(it.photo)}" alt="" loading="lazy">`
    : esc(itemEmoji(it));
  return act
    ? `<button class="thumb" data-a="${act}" data-id="${it.id}" aria-label="Фото">${inner}</button>`
    : `<span class="thumb">${inner}</span>`;
}

function avatarHtml(u, big) {
  u = u || { name: '?', color: '#888' };
  return `<span class="avatar${big ? ' big' : ''}" style="background:${esc(u.color || '#888')}">${esc((u.name || '?').trim()[0] || '?').toUpperCase()}</span>`;
}

function sortedCats() {
  return [...S.cats].sort((a, b) => a.sort - b.sort || a.id - b.id);
}

function groupItems(items) {
  const groups = sortedCats().map((c) => ({ cat: c, items: [] }));
  const none = { cat: { id: null, name: 'Без категории', emoji: '📦' }, items: [] };
  const map = new Map(groups.map((g) => [g.cat.id, g]));
  for (const it of items) (map.get(it.category_id) || none).items.push(it);
  if (none.items.length) groups.push(none);
  return groups.filter((g) => g.items.length);
}

const needItems = () => S.items.filter((i) => i.status !== 'have');
const boughtItems = () => S.items
  .filter((i) => i.status === 'have' && i.bought_at && nowSec() - i.bought_at < BOUGHT_VISIBLE)
  .sort((a, b) => b.bought_at - a.bought_at);

/* ═════════════ сеть ═════════════ */

async function api(path, body) {
  const opt = { credentials: 'same-origin' };
  if (body !== undefined) {
    opt.method = 'POST';
    opt.headers = { 'Content-Type': 'application/json' };
    opt.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, opt);
  } catch (e) {
    throw new Error('Нет связи с сервером');
  }
  let data = {};
  try { data = await res.json(); } catch (e) { /* пустой ответ */ }
  if (res.status === 401 && path !== '/api/login') {
    S.me = null;
    hideSheetNow();
    renderLogin();
    throw new Error('Нужно войти заново');
  }
  if (!res.ok) throw new Error(data.error || 'Ошибка ' + res.status);
  return data;
}

async function refresh() {
  const d = await api('/api/state');
  S.me = d.me; S.users = d.users; S.cats = d.categories; S.items = d.items;
  S.feedings = d.feedings; S.feedOldest = d.feed_oldest; S.rev = d.rev; S.tigraPhoto = d.tigra_photo;
  if (S.feedFrom) S.feedings = (await api('/api/feedings?since=' + S.feedFrom)).feedings;
  if (S.tab === 'log') loadLog(true);
  render();
}

async function run(fn, optimistic) {
  if (optimistic) { optimistic(); render(true); }
  try {
    const r = await fn();
    await refresh();
    return r;
  } catch (e) {
    toast(e.message, null, true);
    if (S.me) refresh().catch(() => {});
    throw e;
  }
}

async function poll() {
  if (!S.me || document.visibilityState !== 'visible') return;
  try {
    const d = await api('/api/rev');
    if (d.rev !== S.rev) await refresh();
  } catch (e) { /* молча, попробуем позже */ }
}

/* ═════════════ отрисовка ═════════════ */

function inputFocused() {
  const a = document.activeElement;
  return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && $('#app').contains(a);
}

function render(force) {
  if (!S.me) return;
  if (!force && inputFocused()) { S.pendingRender = true; return; }
  S.pendingRender = false;
  const scroll = window.scrollY;
  const tab = TABS.find((t) => t.id === S.tab) || TABS[0];
  const view = { buy: viewBuy, home: viewHome, tigra: viewTigra, log: viewLog, more: viewMore }[tab.id];
  const need = needItems().length;
  $('#app').innerHTML = `
    <header class="top"><h1>${esc(tab.name)}</h1>${headerRight(tab.id)}</header>
    <main>${view()}</main>
    ${tab.id === 'home' ? '<button class="fab" data-a="new-item" aria-label="Добавить">+</button>' : ''}
    <nav class="tabs">${TABS.map((t) => `
      <button class="${t.id === tab.id ? 'on' : ''}" data-a="tab" data-tab="${t.id}">
        <span class="ic">${t.ic}</span>${t.name}
        ${t.id === 'buy' && need ? `<span class="badge">${need}</span>` : ''}
      </button>`).join('')}
    </nav>`;
  window.scrollTo(0, scroll);
}

function headerRight(tab) {
  if (tab === 'buy') {
    const n = needItems().length;
    return n ? `<span class="sub">${n} ${plural(n, 'позиция', 'позиции', 'позиций')}</span>` : '';
  }
  if (tab === 'home') return `<span class="sub">${S.items.length} всего</span>`;
  return '';
}

/* ── вкладка «Купить» ── */

function viewBuy() {
  const need = needItems();
  const bought = boughtItems();
  let html = installBanner();
  html += `
    <div class="addbox">
      <span class="plus">＋</span>
      <input id="addq" type="text" placeholder="Что купить? Начните вводить…" autocomplete="off"
        enterkeyhint="done" value="${esc(S.addQ)}">
    </div>
    <div class="suggest list" id="suggest">${suggestHtml()}</div>`;

  if (!need.length && !bought.length) {
    return html + `<div class="empty"><div class="big">🎉</div>Всё есть, покупать ничего не нужно.<br>
      Отметьте «Мало» или «Нет» во вкладке «Дома» — и позиция появится здесь.</div>`;
  }
  for (const g of groupItems(need)) {
    g.items.sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name, 'ru') : a.status === 'out' ? -1 : 1));
    html += `<div class="group-title">${esc(g.cat.emoji)} ${esc(g.cat.name)} <span class="n">${g.items.length}</span></div>
      <div class="list">${g.items.map(buyRow).join('')}</div>`;
  }
  if (!need.length) {
    html += `<div class="empty" style="padding:28px 20px 8px"><div class="big">✅</div>Всё купили!</div>`;
  }
  if (bought.length) {
    html += `<div class="group-title">✅ В корзине <span class="n">${bought.length}</span></div>
      <div class="list">${bought.map(buyRow).join('')}</div>
      <p class="muted" style="font-size:13px;margin:8px 4px">Купленное само уйдёт из списка через 12 часов. Нажмите ещё раз, если отметили по ошибке.</p>`;
  }
  return html;
}

function buyRow(it) {
  const done = it.status === 'have';
  const meta = done
    ? `${esc(userName(it.bought_by))} · ${esc(when(it.bought_at))}`
    : `<span class="pill ${it.status}">${STATUS[it.status]}</span>${esc(userName(it.updated_by))} · ${esc(ago(it.updated_at))}`;
  return `<div class="row${done ? ' done' : ''}" data-a="${done ? 'unbuy' : 'buy'}" data-id="${it.id}" role="button">
    <span class="check">${done ? '✓' : ''}</span>
    ${thumbHtml(it, it.photo ? 'view' : null)}
    <span class="txt"><b>${esc(it.name)}</b><small>${meta}</small>
      ${it.note && !done ? `<small class="note-line">📝 ${esc(it.note)}</small>` : ''}</span>
  </div>`;
}

function suggestHtml() {
  const q = S.addQ.trim().toLowerCase();
  if (!q) return '';
  const matches = S.items
    .filter((i) => i.name.toLowerCase().includes(q))
    .sort((a, b) => (a.name.toLowerCase().startsWith(q) ? -1 : 0) - (b.name.toLowerCase().startsWith(q) ? -1 : 0))
    .slice(0, 6);
  const exact = S.items.some((i) => i.name.toLowerCase() === q);
  let html = matches.map((it) => {
    const inList = it.status !== 'have';
    return `<button class="row" data-a="sugg-pick" data-id="${it.id}">
      ${thumbHtml(it)}
      <span class="txt"><b>${esc(it.name)}</b><small>${inList ? 'уже в списке' : 'сейчас дома: ' + STATUS_LONG[it.status]}</small></span>
      <span style="color:var(--accent);font-weight:700">${inList ? '✓' : '＋'}</span>
    </button>`;
  }).join('');
  if (!exact) {
    html += `<button class="row" data-a="sugg-new">
      <span class="thumb">${esc(guessEmoji(q) || '🆕')}</span>
      <span class="txt"><b>Новое: «${esc(S.addQ.trim())}»</b><small>добавить в список и в учёт</small></span>
      <span style="color:var(--accent);font-weight:700">＋</span>
    </button>`;
  }
  return html;
}

function installBanner() {
  if (isStandalone() || store.get('hideInstall', false)) return '';
  return `<div class="banner" data-a="tab" data-tab="more" role="button">📲 <span>Добавьте КормиКота на экран телефона — будет как обычное приложение</span>
    <span class="x" data-a="hide-install">✕</span></div>`;
}

/* ── вкладка «Дома» ── */

function viewHome() {
  const counts = {};
  for (const it of S.items) counts[it.category_id] = (counts[it.category_id] || 0) + 1;
  const cats = sortedCats().filter((c) => counts[c.id]);
  if (S.cat !== 'all' && S.cat !== 'need' && !cats.some((c) => c.id === S.cat)) S.cat = 'all';
  const need = needItems().length;
  return `
    <div class="search"><input id="q" type="search" placeholder="Поиск" value="${esc(S.q)}" autocomplete="off"></div>
    <div class="chips">
      <button class="chip ${S.cat === 'all' ? 'on' : ''}" data-a="cat" data-cat="all">Все<span class="n"> ${S.items.length}</span></button>
      ${need ? `<button class="chip ${S.cat === 'need' ? 'on' : ''}" data-a="cat" data-cat="need">🟡 Мало/нет<span class="n"> ${need}</span></button>` : ''}
      ${cats.map((c) => `<button class="chip ${S.cat === c.id ? 'on' : ''}" data-a="cat" data-cat="${c.id}">${esc(c.emoji)} ${esc(c.name)}<span class="n"> ${counts[c.id]}</span></button>`).join('')}
    </div>
    <div id="homelist">${homeList()}</div>`;
}

function homeList() {
  const q = S.q.trim().toLowerCase();
  let items = S.items;
  if (S.cat === 'need') items = items.filter((i) => i.status !== 'have');
  else if (S.cat !== 'all') items = items.filter((i) => i.category_id === S.cat);
  if (q) items = items.filter((i) => i.name.toLowerCase().includes(q) || (i.note || '').toLowerCase().includes(q));
  if (!S.items.length) {
    return `<div class="empty"><div class="big">🧺</div>Пока пусто.<br>Нажмите <b>＋</b> внизу, чтобы добавить первую позицию:<br>молоко, порошок, корм для Тигры…</div>`;
  }
  if (!items.length) {
    return `<div class="empty"><div class="big">🔍</div>Ничего не нашлось${q ? `<br><br><button class="btn small" data-a="new-item" data-name="${esc(S.q.trim())}">＋ Добавить «${esc(S.q.trim())}»</button>` : ''}</div>`;
  }
  return groupItems(items).map((g) => `
    <div class="group-title">${esc(g.cat.emoji)} ${esc(g.cat.name)} <span class="n">${g.items.length}</span></div>
    <div class="list">${g.items.map(homeRow).join('')}</div>`).join('');
}

function homeRow(it) {
  return `<div class="row item-row">
    <button class="open" data-a="edit" data-id="${it.id}">
      ${thumbHtml(it)}
      <span class="txt"><b>${esc(it.name)}</b><small>${esc(userName(it.updated_by))} · ${esc(ago(it.updated_at))}</small></span>
    </button>
    <div class="seg">${['have', 'low', 'out'].map((st) =>
      `<button class="${st}${it.status === st ? ' on' : ''}" data-a="status" data-id="${it.id}" data-st="${st}">${STATUS[st]}</button>`).join('')}
    </div>
  </div>`;
}

/* ── вкладка «Тигра» ── */

function viewTigra() {
  const last = S.feedings[0];
  const hours = last ? (nowSec() - last.at) / 3600 : null;
  const photo = S.tigraPhoto
    ? `<img src="${thumbUrl(S.tigraPhoto)}" alt="Тигра">`
    : '🐯';
  const today = S.feedings.filter((f) => dayLabel(f.at) === 'Сегодня').length;
  let html = `
    <div class="card tigra">
      <button class="tigra-photo" data-a="tigra-photo" aria-label="Фото Тигры">${photo}</button>
      <h2>Тигра</h2>
      ${last ? `
        <div class="last${hours >= 10 ? ' warn' : ''}">Кормили <b>${esc(ago(last.at))}</b></div>
        <div class="muted">${esc(userName(last.user_id))} · ${esc(when(last.at))}${last.what ? ' · ' + esc(last.what.toLowerCase()) : ''}</div>`
      : '<div class="last muted">Ещё ни разу не отмечали</div>'}
      <div class="muted" style="margin-top:6px">Сегодня: ${today} ${plural(today, 'раз', 'раза', 'раз')}</div>
    </div>
    <div class="what-label">Что дали? (можно не выбирать)</div>
    <div class="chips wrap">${FEED_WHAT.map((w) =>
      `<button class="chip ${S.feedWhat === w ? 'on' : ''}" data-a="feed-what" data-w="${esc(w)}">${esc(w)}</button>`).join('')}
    </div>
    <button class="feed-btn" data-a="feed">🍽 Тигра покормлена<small>нажмите сразу после кормления</small></button>
    <button class="link-btn" data-a="feed-manual">🕐 Забыли отметить? Указать время</button>`;
  const from = feedFrom();
  const days = feedDays(from);
  if (days.length) html += '<h3 class="section-title">История кормлений</h3>';
  for (const d of days) {
    if (!d.items.length) {
      html += `<div class="group-title">${esc(d.until ? dayRange(d.ts, d.until) : dayLabel(d.ts / 1000))} <span class="miss">не отмечали</span></div>`;
      continue;
    }
    const n = d.items.length;
    html += `<div class="group-title">${esc(dayLabel(d.ts / 1000))} <span class="n">· ${n} ${plural(n, 'раз', 'раза', 'раз')}</span>${feedSummary(d.items)}</div>
      <div class="list">${d.items.map(feedRow).join('')}</div>`;
  }
  if (S.feedOldest && S.feedOldest < from) {
    html += `<div style="margin-top:14px"><button class="btn ghost" data-a="feed-more">Показать ещё ${FEED_MORE_DAYS} дней</button></div>`;
  }
  return html;
}

const feedFrom = () => S.feedFrom || daysAgoStart(FEED_DAYS - 1);

// Дни от сегодня назад до `from` (но не раньше самого первого кормления).
// Дни без кормлений тоже попадают в список; несколько пустых дней подряд склеиваются в один ({ts, until}).
function feedDays(from) {
  if (!S.feedOldest) return [];
  const byDay = new Map();
  for (const f of S.feedings) {
    if (f.at < from) continue;
    const k = dayStart(new Date(f.at * 1000));
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(f);
  }
  const first = Math.max(from * 1000, dayStart(new Date(S.feedOldest * 1000)));
  const days = [];
  const today = dayStart(new Date());
  for (const d = new Date(today); d.getTime() >= first; d.setDate(d.getDate() - 1)) {
    const ts = d.getTime(), items = byDay.get(ts) || [];
    const prev = days[days.length - 1];
    if (!items.length && prev && !prev.items.length && prev.ts !== today) {
      prev.until = prev.until || prev.ts;
      prev.ts = ts;
    } else {
      days.push({ ts, items });
    }
  }
  return days;
}

// «24–26 сентября», «30 августа – 2 сентября»
function dayRange(fromMs, toMs) {
  const a = new Date(fromMs), b = new Date(toMs);
  const y = b.getFullYear() !== new Date().getFullYear() ? ' ' + b.getFullYear() : '';
  if (a.getMonth() === b.getMonth()) return a.getDate() + '–' + b.getDate() + ' ' + MONTHS_FULL[b.getMonth()] + y;
  return a.getDate() + ' ' + MONTHS_FULL[a.getMonth()] + ' – ' + b.getDate() + ' ' + MONTHS_FULL[b.getMonth()] + y;
}

function feedSummary(list) {
  const counts = new Map();
  for (const f of list) if (f.what) counts.set(f.what, (counts.get(f.what) || 0) + 1);
  if (!counts.size) return '';
  return `<span class="day-sum">${[...counts].map(([w, n]) => esc(w) + (n > 1 ? ' ×' + n : '')).join(' · ')}</span>`;
}

function feedRow(f) {
  const u = userById(f.user_id);
  const mine = f.id > 0 && (f.user_id === S.me.id || S.me.role === 'admin');
  const late = f.added_at && f.added_at - f.at > 600;
  const sub = [f.what ? esc(f.what) : '', late ? '✍️ внесено позже' : ''].filter(Boolean).join(' · ');
  return `<div class="row feed-row" ${mine ? `data-a="feed-edit" data-id="${f.id}" role="button"` : ''}>
    <span class="time">${hhmm(new Date(f.at * 1000))}</span>
    ${avatarHtml(u)}
    <span class="txt"><b>${esc(u ? u.name : '—')}</b>${sub ? `<small>${sub}</small>` : ''}</span>
    ${mine ? `<button class="del" data-a="feed-del" data-id="${f.id}" aria-label="Удалить">✕</button>` : ''}
  </div>`;
}

/* ── вкладка «История» ── */

async function loadLog(reset) {
  if (S.logLoading) return;
  S.logLoading = true;
  try {
    const params = new URLSearchParams();
    if (S.logUser) params.set('user', S.logUser);
    if (!reset && S.log.length) params.set('before', S.log[S.log.length - 1].id);
    const d = await api('/api/log?' + params);
    S.log = reset ? d.log : S.log.concat(d.log);
    S.logMore = d.log.length === 60;
  } catch (e) {
    toast(e.message, null, true);
  } finally {
    S.logLoading = false;
    if (S.tab === 'log') render();
  }
}

function viewLog() {
  let html = `<div class="chips">
    <button class="chip ${!S.logUser ? 'on' : ''}" data-a="log-user" data-u="">Все</button>
    ${S.users.map((u) => `<button class="chip ${String(u.id) === S.logUser ? 'on' : ''}" data-a="log-user" data-u="${u.id}">${esc(u.name)}</button>`).join('')}
  </div>`;
  if (!S.log.length) {
    return html + (S.logLoading ? '<div class="loading"><span class="spin"></span></div>' : '<div class="empty"><div class="big">🕓</div>Пока ничего не происходило</div>');
  }
  for (const g of groupByDay(S.log)) {
    html += `<div class="group-title">${esc(g.label)}</div><div class="list">${g.items.map((l) => {
      const u = userById(l.user_id);
      const it = l.item_id && itemById(l.item_id);
      return `<div class="row log-row" ${it ? `data-a="edit" data-id="${it.id}" role="button"` : ''}>
        ${avatarHtml(u)}
        <span class="txt"><small style="font-weight:700;color:var(--text)">${esc(u ? u.name : '—')}</small><span>${esc(l.icon)} ${esc(l.text)}</span></span>
        <span class="time">${hhmm(new Date(l.at * 1000))}</span>
      </div>`;
    }).join('')}</div>`;
  }
  if (S.logMore) {
    html += `<div style="margin-top:14px"><button class="btn ghost" data-a="log-more">${S.logLoading ? '<span class="spin"></span>' : 'Показать ещё'}</button></div>`;
  }
  return html;
}

/* ── вкладка «Ещё» ── */

const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

function installHtml() {
  if (isStandalone()) return '<p style="margin:0">✅ Приложение уже установлено на этот телефон.</p>';
  if (S.installEvt) {
    return `<p style="margin:0 0 12px">Одна кнопка — и КормиКота появится на главном экране рядом с другими приложениями.</p>
      <button class="btn" data-a="install">📲 Установить приложение</button>`;
  }
  if (isIOS()) {
    return `<ol class="steps">
      <li>Откройте этот сайт в <b>Safari</b></li>
      <li>Нажмите <span class="kbd">Поделиться ⬆︎</span> внизу экрана</li>
      <li>Выберите <span class="kbd">На экран «Домой»</span> → <span class="kbd">Добавить</span></li></ol>`;
  }
  return `<ol class="steps">
    <li>Откройте этот сайт в <b>Chrome</b></li>
    <li>Нажмите <span class="kbd">⋮</span> в правом верхнем углу</li>
    <li>Выберите <span class="kbd">Установить приложение</span> или <span class="kbd">Добавить на гл. экран</span></li></ol>`;
}

function viewMore() {
  const me = S.me;
  const counts = {};
  for (const it of S.items) counts[it.category_id] = (counts[it.category_id] || 0) + 1;
  const cats = sortedCats();
  let html = `
    <div class="card section">
      <div class="profile">${avatarHtml(me, true)}
        <div class="txt"><b style="font-size:19px">${esc(me.name)}</b><small>логин: ${esc(me.login)}${me.role === 'admin' ? ' · суперадмин' : ''}</small></div>
      </div>
      <div class="btns" style="margin-top:14px">
        <button class="btn ghost small" data-a="me-edit">✏️ Имя и цвет</button>
        <button class="btn ghost small" data-a="me-pass">🔑 Пароль</button>
      </div>
    </div>

    <div class="group-title">📲 На экран телефона</div>
    <div class="card section">${installHtml()}</div>

    <div class="group-title">🗂 Категории</div>
    <div class="list">${cats.map((c, i) => `
      <div class="row settings-row">
        <button class="open txt" data-a="cat-edit" data-id="${c.id}" style="flex-direction:row;align-items:center;gap:12px">
          <span class="thumb" style="width:40px;height:40px;font-size:22px">${esc(c.emoji)}</span>
          <span class="txt"><b>${esc(c.name)}</b><small>${counts[c.id] || 0} ${plural(counts[c.id] || 0, 'позиция', 'позиции', 'позиций')}</small></span>
        </button>
        <span class="arrows">
          <button data-a="cat-move" data-id="${c.id}" data-d="-1" ${i === 0 ? 'disabled style="opacity:.25"' : ''} aria-label="Выше">▲</button>
          <button data-a="cat-move" data-id="${c.id}" data-d="1" ${i === cats.length - 1 ? 'disabled style="opacity:.25"' : ''} aria-label="Ниже">▼</button>
        </span>
      </div>`).join('')}
      <button class="row" data-a="cat-new" style="color:var(--accent);font-weight:700;justify-content:center">＋ Новая категория</button>
    </div>`;

  if (me.role === 'admin') {
    html += `<div class="group-title">👥 Пользователи</div>
      <div class="list">${S.users.map((u) => `
        <button class="row" data-a="user-edit" data-id="${u.id}" ${u.active ? '' : 'style="opacity:.5"'}>
          ${avatarHtml(u)}
          <span class="txt"><b>${esc(u.name)}</b><small>${esc(u.login)}${u.role === 'admin' ? ' · админ' : ''}${u.active ? '' : ' · отключён'}</small></span>
          <span class="muted">›</span>
        </button>`).join('')}
        <button class="row" data-a="user-new" style="color:var(--accent);font-weight:700;justify-content:center">＋ Добавить человека</button>
      </div>`;
  }
  html += `<div style="margin-top:24px"><button class="btn ghost" data-a="logout">Выйти</button></div>
    <p class="muted" style="text-align:center;font-size:12px;margin-top:18px">КормиКота · все действия подписываются автором и временем</p>`;
  return html;
}

/* ═════════════ шторка (bottom sheet) ═════════════ */

function openSheet(html) {
  const root = $('#sheet');
  root.innerHTML = `<div class="sheet-bg" data-a="close-sheet"></div><div class="sheet" role="dialog">${'<div class="grab"></div>' + html}</div>`;
  root.classList.add('open');
  requestAnimationFrame(() => requestAnimationFrame(() => { if (S.sheetOpen) root.classList.add('show'); }));
  if (!S.sheetOpen) history.pushState({ sheet: true }, '');
  S.sheetOpen = true;
  return $('.sheet', root);
}

function closeSheet() {
  if (!S.sheetOpen) return;
  if (history.state && history.state.sheet) history.back();
  else hideSheetNow();
}

function hideSheetNow() {
  if (!S.sheetOpen) return;
  S.sheetOpen = false;
  const root = $('#sheet');
  root.classList.remove('show');
  if (document.activeElement && root.contains(document.activeElement)) document.activeElement.blur();
  setTimeout(() => { if (!S.sheetOpen) { root.classList.remove('open'); root.innerHTML = ''; } }, 260);
  if (S.pendingRender) render();
}

window.addEventListener('popstate', () => {
  if ($('#viewer').classList.contains('show')) { $('#viewer').classList.remove('show'); return; }
  if (S.sheetOpen) hideSheetNow();
});

const sheetHead = (title) => `<h2>${title}<button class="close" data-a="close-sheet" aria-label="Закрыть">✕</button></h2>`;

/* ── карточка позиции ── */

function itemSheet(id, preset) {
  const it = id ? itemById(id) : null;
  if (id && !it) return toast('Позиция не найдена — возможно, её удалили', null, true);
  const st = {
    id, name: it ? it.name : (preset && preset.name) || '',
    status: it ? it.status : (preset && preset.status) || 'have',
    category_id: it ? it.category_id : null, note: it ? it.note : '',
    photo: it ? it.photo : null, newPhoto: null,
  };
  if (!it) st.category_id = preset && preset.category_id ? preset.category_id : (S.cat !== 'all' && S.cat !== 'need' ? S.cat : guessCategory(st.name));

  const sheet = openSheet(`
    ${sheetHead(it ? 'Позиция' : 'Новая позиция')}
    <div class="photo-box" data-a="pick-photo"></div>
    <div class="photo-actions" id="photo-actions"></div>
    <div class="field"><label>Название</label><input id="f-name" type="text" maxlength="80" value="${esc(st.name)}" placeholder="Например: Молоко" autocomplete="off"></div>
    <div class="field"><label>Сейчас дома</label><div class="seg big" id="f-status"></div></div>
    <div class="field"><label>Категория</label><div class="chips wrap" id="f-cat"></div></div>
    <div class="field"><label>Заметка</label><textarea id="f-note" maxlength="500" placeholder="Например: 3,2%, только «Простоквашино»">${esc(st.note)}</textarea></div>
    <div class="err" id="f-err"></div>
    <button class="btn" id="f-save">${it ? 'Сохранить' : 'Добавить'}</button>
    ${it ? `
      <p class="muted" style="font-size:13px;margin:14px 4px 0">Добавил(а) ${esc(userName(it.created_by))} ${esc(when(it.created_at))}.
        Последнее изменение: ${esc(userName(it.updated_by))} ${esc(when(it.updated_at))}.</p>
      <div class="group-title">🕓 История</div><div class="list" id="f-log"><div class="loading" style="padding:20px"><span class="spin"></span></div></div>
      <div style="margin-top:14px"><button class="btn danger" id="f-del">🗑 Удалить позицию</button></div>` : ''}
  `);

  const drawPhoto = () => {
    const src = st.newPhoto ? st.newPhoto.full : st.photo ? fullUrl(st.photo) : null;
    const em = guessEmoji($('#f-name', sheet).value) || (catById(st.category_id) || {}).emoji || '📦';
    $('.photo-box', sheet).innerHTML = src
      ? `<img src="${src}" alt=""><span class="cam">📷 Заменить</span>`
      : `<span class="em">${esc(em)}</span><span>📷 Нажмите, чтобы добавить фото</span>`;
    $('#photo-actions', sheet).innerHTML = (src ? '<button class="btn ghost" data-a="drop-photo">Убрать фото</button>' : '');
  };
  const drawStatus = () => {
    $('#f-status', sheet).innerHTML = ['have', 'low', 'out'].map((s) =>
      `<button class="${s}${st.status === s ? ' on' : ''}" data-s="${s}">${STATUS[s]}</button>`).join('');
  };
  const drawCats = () => {
    $('#f-cat', sheet).innerHTML = sortedCats().map((c) =>
      `<button class="chip ${st.category_id === c.id ? 'on' : ''}" data-c="${c.id}">${esc(c.emoji)} ${esc(c.name)}</button>`).join('');
  };
  drawPhoto(); drawStatus(); drawCats();

  sheet.onclick = async (e) => {
    const s = e.target.closest('[data-s]');
    if (s) { st.status = s.dataset.s; drawStatus(); return; }
    const c = e.target.closest('[data-c]');
    if (c) { st.category_id = +c.dataset.c; drawCats(); drawPhoto(); return; }
    const a = e.target.closest('[data-a]');
    if (!a) return;
    if (a.dataset.a === 'pick-photo') {
      const p = await pickPhoto();
      if (!p) return;
      if (it) {
        try {
          $('.photo-box', sheet).innerHTML = '<span class="spin"></span><span>Загружаю…</span>';
          const r = await api(`/api/items/${it.id}/photo`, p);
          st.photo = r.photo;
          toast('Фото сохранено');
          refresh();
        } catch (err) { toast(err.message, null, true); }
      } else {
        st.newPhoto = p;
      }
      drawPhoto();
    } else if (a.dataset.a === 'drop-photo') {
      if (it && st.photo) {
        if (!confirm('Удалить фото?')) return;
        try { await api(`/api/items/${it.id}/photo`, { remove: true }); st.photo = null; refresh(); } catch (err) { toast(err.message, null, true); }
      }
      st.newPhoto = null;
      drawPhoto();
    }
  };
  $('#f-name', sheet).addEventListener('input', () => {
    if (!it && !st.userPickedCat) { st.category_id = guessCategory($('#f-name', sheet).value); drawCats(); }
    drawPhoto();
  });
  $('#f-cat', sheet).addEventListener('click', () => { st.userPickedCat = true; });

  $('#f-save', sheet).onclick = async () => {
    const name = $('#f-name', sheet).value.trim();
    const note = $('#f-note', sheet).value.trim();
    if (!name) { $('#f-err', sheet).textContent = 'Введите название'; $('#f-name', sheet).focus(); return; }
    const dup = S.items.find((x) => x.name.toLowerCase() === name.toLowerCase() && x.id !== id);
    if (dup && !confirm(`«${dup.name}» уже есть в учёте. Всё равно добавить ещё одну?`)) return;
    const btn = $('#f-save', sheet);
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
    try {
      if (it) {
        await api(`/api/items/${it.id}`, { name, note, status: st.status, category_id: st.category_id });
      } else {
        const r = await api('/api/items', { name, note, status: st.status, category_id: st.category_id });
        if (st.newPhoto) await api(`/api/items/${r.id}/photo`, st.newPhoto).catch((err) => toast('Фото не загрузилось: ' + err.message, null, true));
      }
      closeSheet();
      toast(it ? 'Сохранено' : `«${name}» добавлено`);
      S.addQ = '';
      refresh();
    } catch (err) {
      $('#f-err', sheet).textContent = err.message;
      btn.disabled = false; btn.textContent = it ? 'Сохранить' : 'Добавить';
    }
  };

  if (it) {
    $('#f-del', sheet).onclick = async () => {
      if (!confirm(`Удалить «${it.name}» из учёта?`)) return;
      try { await api(`/api/items/${it.id}/delete`, {}); closeSheet(); toast(`«${it.name}» удалено`); refresh(); } catch (err) { toast(err.message, null, true); }
    };
    api('/api/log?item=' + it.id).then((d) => {
      const box = $('#f-log', sheet);
      if (!box) return;
      box.innerHTML = d.log.length ? d.log.slice(0, 25).map((l) => {
        const u = userById(l.user_id);
        return `<div class="row log-row">${avatarHtml(u)}
          <span class="txt"><small style="font-weight:700;color:var(--text)">${esc(u ? u.name : '—')}</small><span>${esc(l.icon)} ${esc(l.text)}</span></span>
          <span class="time">${esc(when(l.at))}</span></div>`;
      }).join('') : '<div class="row muted">Пока пусто</div>';
    }).catch(() => {});
  } else if (!st.name) {
    setTimeout(() => $('#f-name', sheet).focus(), 300);
  }
}

/* ── фото: выбор и сжатие прямо на телефоне ── */

function pickPhoto() {
  return new Promise((resolve) => {
    const input = $('#file');
    input.value = '';
    input.onchange = async () => {
      const file = input.files && input.files[0];
      if (!file) return resolve(null);
      try { resolve(await compressImage(file)); } catch (e) { toast(e.message, null, true); resolve(null); }
    };
    input.click();
  });
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Не получилось открыть картинку')); };
    img.src = url;
  });
}

function drawScaled(img, max, square, quality) {
  let w = img.naturalWidth, h = img.naturalHeight, sx = 0, sy = 0, sw = w, sh = h;
  if (square) { const m = Math.min(w, h); sx = (w - m) / 2; sy = (h - m) / 2; sw = sh = w = h = m; }
  const k = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * k); c.height = Math.round(h * k);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', quality);
}

async function compressImage(file) {
  const { img, url } = await loadImage(file);
  try {
    return { full: drawScaled(img, 1080, false, 0.78), thumb: drawScaled(img, 200, true, 0.72) };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function viewPhoto(it) {
  if (!it.photo) return itemSheet(it.id);
  const v = $('#viewer');
  v.innerHTML = `<img src="${fullUrl(it.photo)}" alt=""><div class="cap">${esc(it.name)}</div>
    ${it.note ? `<div class="cap" style="font-size:15px;font-weight:500;opacity:.8">📝 ${esc(it.note)}</div>` : ''}
    <div class="cap" style="font-size:13px;opacity:.6">нажмите, чтобы закрыть</div>`;
  v.classList.add('show');
  history.pushState({ viewer: true }, '');
  v.onclick = () => history.back();
}

/* ── кормление задним числом и исправление записи ── */

function feedSheet(id) {
  const f = id ? S.feedings.find((x) => x.id === id) : null;
  if (id && !f) return toast('Запись не найдена — возможно, её удалили', null, true);
  const st = { what: f ? f.what : S.feedWhat };
  const start = new Date((f ? f.at : nowSec()) * 1000);
  const quick = [[30, '30 мин назад'], [60, '1 ч назад'], [120, '2 ч назад'], [180, '3 ч назад']];
  const sheet = openSheet(`
    ${sheetHead(f ? 'Кормление' : 'Когда кормили?')}
    ${f ? '' : `<div class="field"><div class="chips wrap" id="k-quick">${quick.map(([m, t]) =>
      `<button class="chip" data-m="${m}">${t}</button>`).join('')}</div></div>`}
    <div class="btns">
      <div class="field"><label>День</label><input id="k-date" type="date" max="${ymd(new Date())}" value="${ymd(start)}"></div>
      <div class="field"><label>Время</label><input id="k-time" type="time" value="${hhmm(start)}"></div>
    </div>
    <div class="field"><label>Что дали</label><div class="chips wrap" id="k-what"></div></div>
    <div class="err" id="k-err"></div>
    <button class="btn" id="k-save">${f ? 'Сохранить' : 'Записать кормление'}</button>
    ${f ? `<p class="muted" style="font-size:13px;margin:14px 4px 0">Внес(ла) ${esc(userName(f.user_id))}${f.added_at ? ' ' + esc(when(f.added_at)) : ''}.</p>
      <div style="margin-top:10px"><button class="btn danger" id="k-del">🗑 Удалить запись</button></div>` : ''}`);

  const drawWhat = () => {
    $('#k-what', sheet).innerHTML = FEED_WHAT.map((w) =>
      `<button class="chip ${st.what === w ? 'on' : ''}" data-w="${esc(w)}">${esc(w)}</button>`).join('');
  };
  const clearQuick = (keep) => { for (const b of sheet.querySelectorAll('[data-m]')) b.classList.toggle('on', b === keep); };
  drawWhat();

  sheet.onclick = (e) => {
    const w = e.target.closest('[data-w]');
    if (w) { st.what = st.what === w.dataset.w ? '' : w.dataset.w; drawWhat(); return; }
    const q = e.target.closest('[data-m]');
    if (q) {
      const d = new Date(Date.now() - q.dataset.m * 60000);
      $('#k-date', sheet).value = ymd(d);
      $('#k-time', sheet).value = hhmm(d);
      clearQuick(q);
    }
  };
  for (const inp of sheet.querySelectorAll('#k-date, #k-time')) inp.addEventListener('input', () => clearQuick(null));

  $('#k-save', sheet).onclick = async () => {
    const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec($('#k-date', sheet).value);
    const tm = /^(\d{1,2}):(\d{2})/.exec($('#k-time', sheet).value);
    if (!dm || !tm) { $('#k-err', sheet).textContent = 'Укажите день и время'; return; }
    const at = new Date(+dm[1], dm[2] - 1, +dm[3], +tm[1], +tm[2]).getTime() / 1000;
    if (at > nowSec() + 60) { $('#k-err', sheet).textContent = 'Это время ещё не наступило'; return; }
    const body = { what: st.what, tz: tz() };
    if (!f || Math.floor(f.at / 60) * 60 !== at) body.at = at;
    const btn = $('#k-save', sheet);
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
    try {
      const r = await api(f ? `/api/feed/${f.id}` : '/api/feed', body);
      closeSheet();
      if (!f) S.feedWhat = '';
      // запись старше показанного периода — расширяем историю, чтобы её было видно
      if (at < feedFrom()) S.feedFrom = dayStart(new Date(at * 1000)) / 1000;
      await refresh();
      if (f) toast('Сохранено');
      else toast('🐯 Записано: ' + when(at), () => run(() => api(`/api/feed/${r.id}/delete`, { tz: tz() })).catch(() => {}));
    } catch (err) {
      $('#k-err', sheet).textContent = err.message;
      btn.disabled = false; btn.textContent = f ? 'Сохранить' : 'Записать кормление';
    }
  };

  if (f) {
    $('#k-del', sheet).onclick = async () => {
      if (!confirm('Удалить эту запись о кормлении?')) return;
      try { await api(`/api/feed/${f.id}/delete`, { tz: tz() }); closeSheet(); toast('Запись удалена'); refresh(); } catch (err) { toast(err.message, null, true); }
    };
  }
}

/* ── прочие шторки ── */

function catSheet(id) {
  const c = id ? catById(id) : null;
  const sheet = openSheet(`
    ${sheetHead(c ? 'Категория' : 'Новая категория')}
    <div class="field"><label>Значок (эмодзи)</label><input id="c-emoji" maxlength="8" value="${esc(c ? c.emoji : '📦')}" style="font-size:28px;width:90px;text-align:center"></div>
    <div class="field"><label>Название</label><input id="c-name" maxlength="40" value="${esc(c ? c.name : '')}" placeholder="Например: Для дачи"></div>
    <div class="err" id="c-err"></div>
    <button class="btn" id="c-save">${c ? 'Сохранить' : 'Создать'}</button>
    ${c ? '<div style="margin-top:10px"><button class="btn danger" id="c-del">🗑 Удалить категорию</button></div>' : ''}`);
  if (!c) setTimeout(() => $('#c-name', sheet).focus(), 300);
  $('#c-save', sheet).onclick = async () => {
    const body = { name: $('#c-name', sheet).value.trim(), emoji: $('#c-emoji', sheet).value.trim() || '📦' };
    if (!body.name) { $('#c-err', sheet).textContent = 'Введите название'; return; }
    try { await api(c ? `/api/categories/${c.id}` : '/api/categories', body); closeSheet(); refresh(); } catch (e) { $('#c-err', sheet).textContent = e.message; }
  };
  if (c) $('#c-del', sheet).onclick = async () => {
    if (!confirm(`Удалить категорию «${c.name}»? Позиции из неё останутся, но без категории.`)) return;
    try { await api(`/api/categories/${c.id}/delete`, {}); closeSheet(); refresh(); } catch (e) { toast(e.message, null, true); }
  };
}

const COLORS = ['#e8590c', '#1c7ed6', '#2f9e44', '#ae3ec9', '#f08c00', '#0c8599', '#e03131', '#5f3dc4', '#495057'];

function colorPicker(cur) {
  return `<div class="chips wrap" id="u-colors">${COLORS.map((c) =>
    `<button data-color="${c}" style="width:40px;height:40px;border-radius:50%;background:${c};${c === cur ? 'box-shadow:0 0 0 3px var(--bg),0 0 0 5px ' + c : ''}"></button>`).join('')}</div>`;
}

function bindColors(sheet, st) {
  $('#u-colors', sheet).onclick = (e) => {
    const b = e.target.closest('[data-color]');
    if (!b) return;
    st.color = b.dataset.color;
    $('#u-colors', sheet).outerHTML = colorPicker(st.color);
    bindColors(sheet, st);
  };
}

function meSheet() {
  const st = { color: S.me.color };
  const sheet = openSheet(`
    ${sheetHead('Имя и цвет')}
    <div class="field"><label>Как подписывать мои действия</label><input id="m-name" maxlength="40" value="${esc(S.me.name)}"></div>
    <div class="field"><label>Цвет</label>${colorPicker(st.color)}</div>
    <div class="err" id="m-err"></div>
    <button class="btn" id="m-save">Сохранить</button>`);
  bindColors(sheet, st);
  $('#m-save', sheet).onclick = async () => {
    try { await api('/api/me', { name: $('#m-name', sheet).value.trim(), color: st.color }); closeSheet(); refresh(); } catch (e) { $('#m-err', sheet).textContent = e.message; }
  };
}

function passSheet() {
  const sheet = openSheet(`
    ${sheetHead('Смена пароля')}
    <div class="field"><label>Текущий пароль</label><input id="p-old" type="password" autocomplete="current-password"></div>
    <div class="field"><label>Новый пароль</label><input id="p-new" type="password" autocomplete="new-password"></div>
    <div class="err" id="p-err"></div>
    <button class="btn" id="p-save">Сменить</button>`);
  $('#p-save', sheet).onclick = async () => {
    try {
      await api('/api/me/password', { old: $('#p-old', sheet).value, new: $('#p-new', sheet).value });
      closeSheet(); toast('Пароль изменён');
    } catch (e) { $('#p-err', sheet).textContent = e.message; }
  };
}

function userSheet(id) {
  const u = id ? userById(id) : null;
  const st = { color: u ? u.color : COLORS[S.users.length % COLORS.length] };
  const self = u && u.id === S.me.id;
  const sheet = openSheet(`
    ${sheetHead(u ? esc(u.name) : 'Новый человек')}
    <div class="field"><label>Имя (так будут подписаны действия)</label><input id="u-name" maxlength="40" value="${esc(u ? u.name : '')}" placeholder="Например: Мама"></div>
    ${u ? `<div class="field"><label>Логин</label><input value="${esc(u.login)}" disabled></div>`
      : '<div class="field"><label>Логин для входа</label><input id="u-login" maxlength="40" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="Например: mama"></div>'}
    <div class="field"><label>${u ? 'Новый пароль (если нужно сбросить)' : 'Пароль'}</label><input id="u-pass" type="text" autocapitalize="none" autocorrect="off" spellcheck="false" placeholder="${u ? 'оставьте пустым, чтобы не менять' : 'минимум 4 символа'}"></div>
    <div class="field"><label>Цвет</label>${colorPicker(st.color)}</div>
    ${self ? '' : `
      <label class="check-line"><input type="checkbox" id="u-admin" ${u && u.role === 'admin' ? 'checked' : ''}> Может управлять пользователями (админ)</label>
      ${u ? `<label class="check-line"><input type="checkbox" id="u-active" ${u.active ? 'checked' : ''}> Доступ включён</label>` : ''}`}
    <div class="err" id="u-err"></div>
    <button class="btn" id="u-save">${u ? 'Сохранить' : 'Создать'}</button>
    ${u ? '' : '<p class="muted" style="font-size:13px;margin:10px 4px">Передайте человеку ссылку на сайт, логин и пароль. Входить нужно один раз — дальше телефон запомнит.</p>'}`);
  bindColors(sheet, st);
  if (!u) setTimeout(() => $('#u-name', sheet).focus(), 300);
  $('#u-save', sheet).onclick = async () => {
    const body = { name: $('#u-name', sheet).value.trim(), color: st.color };
    const pw = $('#u-pass', sheet).value;
    if (pw) body.password = pw;
    if (!self) body.role = $('#u-admin', sheet).checked ? 'admin' : 'user';
    if (u && !self) body.active = $('#u-active', sheet).checked;
    if (!u) body.login = $('#u-login', sheet).value.trim();
    try {
      await api(u ? `/api/users/${u.id}` : '/api/users', body);
      closeSheet();
      toast(u ? 'Сохранено' : `${body.name} добавлен(а)`);
      refresh();
    } catch (e) { $('#u-err', sheet).textContent = e.message; }
  };
}

/* ═════════════ тосты ═════════════ */

let toastTimer = null;
function toast(msg, undo, error) {
  const box = $('#toast');
  box.innerHTML = `<div class="toast${error ? ' error' : ''}"><span>${esc(msg)}</span>${undo ? '<button>Отменить</button>' : ''}</div>`;
  if (undo) $('button', box).onclick = () => { box.innerHTML = ''; undo(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.innerHTML = ''; }, undo ? 5000 : 2600);
}

/* ═════════════ действия ═════════════ */

function setStatus(id, status) {
  const it = itemById(id);
  if (!it || it.status === status) return;
  const prev = it.status;
  run(() => api(`/api/items/${id}`, { status }), () => {
    it.status = status; it.updated_by = S.me.id; it.updated_at = nowSec(); it.bought_at = null;
  }).then(() => {
    const msg = status === 'have' ? `«${it.name}» — есть` : `«${it.name}» → в список покупок`;
    toast(msg, () => setStatus(id, prev));
  }).catch(() => {});
}

function buy(id, el) {
  const it = itemById(id);
  if (!it) return;
  if (el) el.classList.add('pop');
  run(() => api(`/api/items/${id}/buy`, {}), () => {
    it.status = 'have'; it.bought_at = nowSec(); it.bought_by = S.me.id;
  }).then(() => toast(`Куплено: ${it.name}`, () => unbuy(id))).catch(() => {});
}

function unbuy(id) {
  const it = itemById(id);
  if (!it) return;
  run(() => api(`/api/items/${id}/unbuy`, {}), () => { it.status = 'out'; it.bought_at = null; }).catch(() => {});
}

function suggestPick(id) {
  const it = itemById(id);
  if (!it) return;
  S.addQ = '';
  if (it.status !== 'have') { toast(`«${it.name}» уже в списке`); render(true); return; }
  run(() => api(`/api/items/${id}`, { status: 'out' }), () => {
    it.status = 'out'; it.updated_by = S.me.id; it.updated_at = nowSec(); it.bought_at = null;
  }).then(() => toast(`«${it.name}» добавлено в список`, () => setStatus(id, 'have'))).catch(() => {});
}

function feed() {
  const what = S.feedWhat;
  S.feedWhat = '';
  run(() => api('/api/feed', { what, tz: tz() }), () => {
    S.feedings.unshift({ id: -1, user_id: S.me.id, at: nowSec(), what, added_at: nowSec() });
    if (!S.feedOldest) S.feedOldest = nowSec();
  }).then((r) => {
    if (navigator.vibrate) navigator.vibrate(30);
    toast('🐯 Записано: Тигра покормлена', () => run(() => api(`/api/feed/${r.id}/delete`, { tz: tz() })).catch(() => {}));
  }).catch(() => {});
}

async function tigraPhoto() {
  if (S.tigraPhoto && !confirm('Заменить фото Тигры?')) return;
  const p = await pickPhoto();
  if (!p) return;
  toast('Загружаю фото…');
  run(() => api('/api/tigra/photo', p)).then(() => toast('Фото Тигры обновлено')).catch(() => {});
}

async function logout() {
  if (!confirm('Выйти из КормиКота на этом устройстве?')) return;
  try { await api('/api/logout', {}); } catch (e) { /* всё равно выходим */ }
  try { if (window.caches) for (const k of await caches.keys()) await caches.delete(k); } catch (e) { /* нет кэша */ }
  S.me = null;
  renderLogin();
}

const ACTIONS = {
  tab(el) {
    S.tab = el.dataset.tab; store.set('tab', S.tab);
    if (S.tab === 'log') loadLog(true);
    render(true); window.scrollTo(0, 0);
  },
  'hide-install'(el, e) { e.stopPropagation(); store.set('hideInstall', true); render(true); },
  install() {
    if (!S.installEvt) return;
    S.installEvt.prompt();
    S.installEvt.userChoice.finally(() => { S.installEvt = null; render(true); });
  },
  buy(el) { buy(+el.dataset.id, el); },
  unbuy(el) { unbuy(+el.dataset.id); },
  view(el, e) { e.stopPropagation(); const it = itemById(+el.dataset.id); if (it) viewPhoto(it); },
  'sugg-pick'(el) { suggestPick(+el.dataset.id); },
  'sugg-new'() {
    const name = S.addQ.trim();
    itemSheet(null, { name, status: 'out', category_id: guessCategory(name) });
  },
  status(el) { setStatus(+el.dataset.id, el.dataset.st); },
  cat(el) {
    const c = el.dataset.cat;
    S.cat = c === 'all' || c === 'need' ? c : +c;
    render(true);
  },
  edit(el) { itemSheet(+el.dataset.id); },
  'new-item'(el) { itemSheet(null, { name: el.dataset.name || '' }); },
  feed() { feed(); },
  'feed-what'(el) { S.feedWhat = S.feedWhat === el.dataset.w ? '' : el.dataset.w; render(true); },
  'feed-del'(el) {
    if (!confirm('Удалить эту запись о кормлении?')) return;
    run(() => api(`/api/feed/${el.dataset.id}/delete`, { tz: tz() })).catch(() => {});
  },
  'feed-edit'(el) { feedSheet(+el.dataset.id); },
  'feed-manual'() { feedSheet(null); },
  'feed-more'(el) {
    const d = new Date(feedFrom() * 1000);
    d.setDate(d.getDate() - FEED_MORE_DAYS);
    S.feedFrom = d.getTime() / 1000;
    el.disabled = true; el.innerHTML = '<span class="spin"></span>';
    refresh().catch((e) => toast(e.message, null, true));
  },
  'tigra-photo'() { tigraPhoto(); },
  'log-user'(el) { S.logUser = el.dataset.u; S.log = []; loadLog(true); render(true); },
  'log-more'() { loadLog(false); render(true); },
  'me-edit'() { meSheet(); },
  'me-pass'() { passSheet(); },
  'cat-edit'(el) { catSheet(+el.dataset.id); },
  'cat-new'() { catSheet(null); },
  'cat-move'(el) { run(() => api(`/api/categories/${el.dataset.id}`, { move: +el.dataset.d })).catch(() => {}); },
  'user-edit'(el) { userSheet(+el.dataset.id); },
  'user-new'() { userSheet(null); },
  'close-sheet'() { closeSheet(); },
  logout() { logout(); },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-a]');
  if (!el || el.disabled) return;
  if ($('#sheet').contains(el) && !['close-sheet'].includes(el.dataset.a)) return; // шторки обрабатывают сами
  const fn = ACTIONS[el.dataset.a];
  if (fn) fn(el, e);
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'addq') {
    S.addQ = e.target.value;
    $('#suggest').innerHTML = suggestHtml();
  } else if (e.target.id === 'q') {
    S.q = e.target.value;
    $('#homelist').innerHTML = homeList();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.target.id === 'addq' && e.key === 'Enter') {
    e.preventDefault();
    const q = S.addQ.trim().toLowerCase();
    if (!q) return;
    const exact = S.items.find((i) => i.name.toLowerCase() === q);
    if (exact) suggestPick(exact.id); else ACTIONS['sugg-new']();
    e.target.blur();
  }
});

document.addEventListener('focusout', () => {
  setTimeout(() => { if (S.pendingRender && !inputFocused()) render(); }, 200);
});

/* ═════════════ вход ═════════════ */

function renderLogin() {
  $('#app').innerHTML = `
    <form class="login" id="login-form">
      <div class="logo">🐯</div>
      <h1>КормиКота</h1>
      <p>Что есть дома, что купить и кто кормил Тигру</p>
      <input id="l-login" type="text" placeholder="Логин" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required>
      <input id="l-pass" type="password" placeholder="Пароль" autocomplete="current-password" required>
      <div class="err" id="l-err"></div>
      <button class="btn" type="submit" style="margin-top:6px">Войти</button>
    </form>`;
  $('#login-form').onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('#login-form button');
    btn.disabled = true; btn.innerHTML = '<span class="spin"></span>';
    try {
      await api('/api/login', { login: $('#l-login').value.trim(), password: $('#l-pass').value });
      if (document.activeElement) document.activeElement.blur();
      await refresh();
      render(true);
    } catch (err) {
      $('#l-err').textContent = err.message;
      btn.disabled = false; btn.textContent = 'Войти';
    }
  };
}

/* ═════════════ старт ═════════════ */

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  S.installEvt = e;
  if (S.tab === 'more') render();
});

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') poll(); });
setInterval(poll, 15000);
setInterval(() => { if (S.me && !S.sheetOpen && ['tigra', 'buy', 'home'].includes(S.tab)) render(); }, 60000);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

(async function start() {
  try {
    await refresh();
  } catch (e) {
    if (!S.me) {
      if (/войти/.test(e.message)) return; // уже показан экран входа
      $('#app').innerHTML = `<div class="empty" style="padding-top:30vh"><div class="big">📡</div>${esc(e.message)}<br><br>
        <button class="btn small" onclick="location.reload()">Попробовать ещё раз</button></div>`;
    }
  }
})();
