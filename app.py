"""
КормиКота — домашний учёт продуктов, бытовой химии и кормлений Тигры.

Без внешних зависимостей: только стандартная библиотека Python 3.8+.
Это WSGI-приложение (переменная `app`), поэтому оно работает:
  * локально:            python app.py         (см. start.bat)
  * на PythonAnywhere:   from app import app as application
"""
import base64
import gzip
import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import socket
import sqlite3
import sys
import threading
import time
from email.utils import formatdate, parsedate_to_datetime
from http.cookies import SimpleCookie
from urllib.parse import parse_qs

BASE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(BASE, "static")
DATA = os.environ.get("KORMIKOTA_DATA") or os.environ.get("KLADOVKA_DATA") or os.path.join(BASE, "data")
PHOTOS = os.path.join(DATA, "photos")
DB_PATH = os.path.join(DATA, "kormikota.db")
OLD_DB_PATH = os.path.join(DATA, "kladovka.db")   # имя базы до переименования в КормиКота
ADMIN_FILE = os.path.join(DATA, "ADMIN_PASSWORD.txt")

SESSION_TTL = 365 * 24 * 3600   # вход «навсегда» — раз в год
MAX_BODY = 8 * 1024 * 1024
STATUSES = {"have": "есть", "low": "заканчивается", "out": "нет"}
STATUS_ICON = {"have": "🟢", "low": "🟡", "out": "🔴"}
COLORS = ["#e8590c", "#1c7ed6", "#2f9e44", "#ae3ec9", "#f08c00", "#0c8599", "#e03131", "#5f3dc4"]

DEFAULT_CATEGORIES = [
    ("🥛", "Молочное"), ("🥩", "Мясо и рыба"), ("🥦", "Овощи и фрукты"),
    ("🍞", "Хлеб и выпечка"), ("🍝", "Бакалея"), ("🧊", "Заморозка"),
    ("🍫", "Сладкое и снеки"), ("🧃", "Напитки"), ("🧴", "Бытовая химия"),
    ("🧼", "Гигиена"), ("🐯", "Для Тигры"), ("💊", "Аптечка"), ("📦", "Прочее"),
]

_init_lock = threading.Lock()
_initialized = False
_login_fails = {}


# ───────────────────────────── база ─────────────────────────────

def connect():
    db = sqlite3.connect(DB_PATH, timeout=15)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA foreign_keys=ON")
    return db


SCHEMA = """
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, login TEXT UNIQUE NOT NULL COLLATE NOCASE, name TEXT NOT NULL,
  salt TEXT NOT NULL, pw TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user',
  active INTEGER NOT NULL DEFAULT 1, color TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL, seen_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS categories(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, emoji TEXT NOT NULL DEFAULT '📦',
  sort INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS items(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, category_id INTEGER REFERENCES categories(id),
  status TEXT NOT NULL DEFAULT 'have', note TEXT NOT NULL DEFAULT '', photo TEXT,
  created_by INTEGER, created_at INTEGER NOT NULL,
  updated_by INTEGER, updated_at INTEGER NOT NULL,
  bought_by INTEGER, bought_at INTEGER, prev_status TEXT,
  deleted INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS feedings(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, at INTEGER NOT NULL,
  what TEXT NOT NULL DEFAULT '', deleted INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS log(
  id INTEGER PRIMARY KEY, user_id INTEGER, at INTEGER NOT NULL, icon TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL, item_id INTEGER);
CREATE INDEX IF NOT EXISTS log_item ON log(item_id);
CREATE INDEX IF NOT EXISTS log_user ON log(user_id);
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
"""


def init():
    global _initialized
    if _initialized:
        return
    with _init_lock:
        if _initialized:
            return
        os.makedirs(PHOTOS, exist_ok=True)
        if not os.path.exists(DB_PATH) and os.path.exists(OLD_DB_PATH):
            os.rename(OLD_DB_PATH, DB_PATH)
        db = connect()
        db.executescript(SCHEMA)
        if not db.execute("SELECT 1 FROM categories LIMIT 1").fetchone():
            for i, (emoji, name) in enumerate(DEFAULT_CATEGORIES):
                db.execute("INSERT INTO categories(name,emoji,sort) VALUES(?,?,?)", (name, emoji, i))
        if not db.execute("SELECT 1 FROM users LIMIT 1").fetchone():
            pw = os.environ.get("ADMIN_PASSWORD") or gen_password()
            salt, h = hash_pw(pw)
            db.execute(
                "INSERT INTO users(login,name,salt,pw,role,color,created_at) VALUES(?,?,?,?,?,?,?)",
                ("admin", "Админ", salt, h, "admin", COLORS[0], now()))
            with open(ADMIN_FILE, "w", encoding="utf-8") as f:
                f.write("Первый вход в КормиКота\n\nЛогин:  admin\nПароль: %s\n\n"
                        "Смените пароль в разделе «Ещё» — после этого файл удалится сам.\n" % pw)
            print("\n  Создан суперадмин.  Логин: admin   Пароль: %s\n" % pw, flush=True)
        db.execute("INSERT OR IGNORE INTO meta(key,value) VALUES('rev','1')")
        db.commit()
        db.close()
        _initialized = True


def now():
    return int(time.time())


def gen_password():
    alphabet = "abcdefghjkmnpqrstuvwxyz23456789"
    return "".join(secrets.choice(alphabet) for _ in range(10))


def hash_pw(pw, salt=None):
    salt = salt or secrets.token_hex(16)
    h = hashlib.pbkdf2_hmac("sha256", pw.encode("utf-8"), bytes.fromhex(salt), 120000).hex()
    return salt, h


def bump(db):
    db.execute("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='rev'")


def get_meta(db, key, default=None):
    r = db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return r["value"] if r else default


def set_meta(db, key, value):
    db.execute("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
               (key, value))


def log(db, user, icon, text, item_id=None):
    db.execute("INSERT INTO log(user_id,at,icon,text,item_id) VALUES(?,?,?,?,?)",
               (user["id"], now(), icon, text, item_id))
    bump(db)


def rows(cur):
    return [dict(r) for r in cur.fetchall()]


# ───────────────────────────── HTTP-обвязка ─────────────────────────────

class HttpError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


class Request:
    def __init__(self, environ):
        self.environ = environ
        self.method = environ.get("REQUEST_METHOD", "GET").upper()
        self.path = environ.get("PATH_INFO", "/") or "/"
        self.query = {k: v[0] for k, v in parse_qs(environ.get("QUERY_STRING", "")).items()}
        self.cookies = SimpleCookie()
        try:
            self.cookies.load(environ.get("HTTP_COOKIE", ""))
        except Exception:
            pass
        self._json = None

    @property
    def https(self):
        return (self.environ.get("wsgi.url_scheme") == "https"
                or self.environ.get("HTTP_X_FORWARDED_PROTO", "").startswith("https"))

    @property
    def ip(self):
        fwd = self.environ.get("HTTP_X_FORWARDED_FOR", "")
        return (self.environ.get("HTTP_X_REAL_IP") or fwd.split(",")[0].strip()
                or self.environ.get("REMOTE_ADDR", "?"))

    def json(self):
        if self._json is None:
            try:
                length = int(self.environ.get("CONTENT_LENGTH") or 0)
            except ValueError:
                length = 0
            if length > MAX_BODY:
                raise HttpError(413, "Слишком большой запрос")
            raw = self.environ["wsgi.input"].read(length) if length else b""
            try:
                self._json = json.loads(raw.decode("utf-8")) if raw else {}
            except ValueError:
                raise HttpError(400, "Неверный JSON")
            if not isinstance(self._json, dict):
                raise HttpError(400, "Неверный JSON")
        return self._json


class Response:
    def __init__(self, body=b"", status=200, ctype="application/json; charset=utf-8", headers=None):
        self.body = body
        self.status = status
        self.headers = [("Content-Type", ctype)] + (headers or [])


def ok(data=None, headers=None):
    return Response(json.dumps(data if data is not None else {"ok": True}, ensure_ascii=False).encode("utf-8"),
                    headers=(headers or []) + [("Cache-Control", "no-store")])


STATUS_TEXT = {200: "200 OK", 304: "304 Not Modified", 400: "400 Bad Request", 401: "401 Unauthorized",
               403: "403 Forbidden", 404: "404 Not Found", 405: "405 Method Not Allowed",
               413: "413 Payload Too Large", 429: "429 Too Many Requests", 500: "500 Internal Server Error"}


def s(body, key, maxlen=200, required=False):
    v = body.get(key)
    if v is None:
        if required:
            raise HttpError(400, "Не заполнено поле: %s" % key)
        return None
    v = str(v).strip()[:maxlen]
    if required and not v:
        raise HttpError(400, "Не заполнено поле: %s" % key)
    return v


# ───────────────────────────── авторизация ─────────────────────────────

def current_user(req, db):
    c = req.cookies.get("sid")
    if not c:
        return None
    r = db.execute("SELECT u.*, s.seen_at FROM sessions s JOIN users u ON u.id=s.user_id "
                   "WHERE s.token=? AND u.active=1", (c.value,)).fetchone()
    if not r:
        return None
    if now() - r["seen_at"] > SESSION_TTL:
        db.execute("DELETE FROM sessions WHERE token=?", (c.value,))
        db.commit()
        return None
    if now() - r["seen_at"] > 3600:
        db.execute("UPDATE sessions SET seen_at=? WHERE token=?", (now(), c.value))
        db.commit()
    return dict(r)


def session_cookie(req, token, max_age):
    parts = ["sid=%s" % token, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=%d" % max_age]
    if req.https:
        parts.append("Secure")
    return ("Set-Cookie", "; ".join(parts))


def public_user(u):
    return {"id": u["id"], "name": u["name"], "login": u["login"], "role": u["role"],
            "color": u["color"], "active": u["active"]}


def api_login(req, db, _user):
    body = req.json()
    login = s(body, "login", 60, True)
    pw = body.get("password") or ""
    key = req.ip
    fails, until = _login_fails.get(key, (0, 0))
    if until > time.time():
        raise HttpError(429, "Слишком много попыток. Подождите минуту.")
    u = db.execute("SELECT * FROM users WHERE login=? AND active=1", (login,)).fetchone()
    if not u or not hmac.compare_digest(hash_pw(pw, u["salt"])[1], u["pw"]):
        fails += 1
        _login_fails[key] = (fails, time.time() + 60 if fails >= 5 else 0)
        raise HttpError(401, "Неверный логин или пароль")
    _login_fails.pop(key, None)
    token = secrets.token_urlsafe(32)
    db.execute("INSERT INTO sessions(token,user_id,created_at,seen_at) VALUES(?,?,?,?)",
               (token, u["id"], now(), now()))
    db.commit()
    return ok({"me": public_user(u)}, [session_cookie(req, token, SESSION_TTL)])


def api_logout(req, db, user):
    c = req.cookies.get("sid")
    if c:
        db.execute("DELETE FROM sessions WHERE token=?", (c.value,))
        db.commit()
    return ok(headers=[session_cookie(req, "", 0)])


def api_password(req, db, user):
    body = req.json()
    old, new = body.get("old") or "", body.get("new") or ""
    if not hmac.compare_digest(hash_pw(old, user["salt"])[1], user["pw"]):
        raise HttpError(400, "Текущий пароль неверный")
    if len(new) < 4:
        raise HttpError(400, "Новый пароль — минимум 4 символа")
    salt, h = hash_pw(new)
    db.execute("UPDATE users SET salt=?, pw=? WHERE id=?", (salt, h, user["id"]))
    db.commit()
    if user["login"].lower() == "admin" and os.path.exists(ADMIN_FILE):
        try:
            os.remove(ADMIN_FILE)
        except OSError:
            pass
    return ok()


# ───────────────────────────── данные ─────────────────────────────

def api_rev(req, db, user):
    return ok({"rev": int(get_meta(db, "rev", "1"))})


def api_state(req, db, user):
    return ok({
        "rev": int(get_meta(db, "rev", "1")),
        "me": public_user(user),
        "users": [public_user(u) for u in db.execute("SELECT * FROM users ORDER BY id")],
        "categories": rows(db.execute("SELECT id,name,emoji,sort FROM categories WHERE deleted=0 ORDER BY sort,id")),
        "items": rows(db.execute(
            "SELECT id,name,category_id,status,note,photo,created_by,created_at,updated_by,updated_at,"
            "bought_by,bought_at FROM items WHERE deleted=0 ORDER BY name COLLATE NOCASE")),
        "feedings": rows(db.execute(
            "SELECT id,user_id,at,what FROM feedings WHERE deleted=0 ORDER BY at DESC LIMIT 100")),
        "tigra_photo": get_meta(db, "tigra_photo"),
    })


def get_item(db, item_id):
    it = db.execute("SELECT * FROM items WHERE id=? AND deleted=0", (item_id,)).fetchone()
    if not it:
        raise HttpError(404, "Позиция не найдена (возможно, её удалили)")
    return dict(it)


def check_category(db, cat_id):
    if cat_id in (None, "", 0):
        return None
    if not db.execute("SELECT 1 FROM categories WHERE id=? AND deleted=0", (cat_id,)).fetchone():
        raise HttpError(400, "Нет такой категории")
    return int(cat_id)


def api_item_create(req, db, user):
    body = req.json()
    name = s(body, "name", 80, True)
    status = body.get("status") or "have"
    if status not in STATUSES:
        raise HttpError(400, "Неверный статус")
    cat = check_category(db, body.get("category_id"))
    note = s(body, "note", 500) or ""
    t = now()
    cur = db.execute(
        "INSERT INTO items(name,category_id,status,note,created_by,created_at,updated_by,updated_at) "
        "VALUES(?,?,?,?,?,?,?,?)", (name, cat, status, note, user["id"], t, user["id"], t))
    extra = "" if status == "have" else " — " + STATUSES[status]
    log(db, user, "➕", "Добавлено: «%s»%s" % (name, extra), cur.lastrowid)
    db.commit()
    return ok({"id": cur.lastrowid})


def api_item_update(req, db, user, item_id):
    body = req.json()
    it = get_item(db, item_id)
    t = now()
    changes = []
    if "status" in body and body["status"] != it["status"]:
        st = body["status"]
        if st not in STATUSES:
            raise HttpError(400, "Неверный статус")
        db.execute("UPDATE items SET status=?, bought_at=NULL, bought_by=NULL, prev_status=NULL WHERE id=?",
                   (st, item_id))
        log(db, user, STATUS_ICON[st], "«%s» — %s" % (it["name"], STATUSES[st]), item_id)
        changes.append("status")
    edits = []
    if "name" in body:
        name = s(body, "name", 80, True)
        if name != it["name"]:
            db.execute("UPDATE items SET name=? WHERE id=?", (name, item_id))
            edits.append("название: «%s» → «%s»" % (it["name"], name))
    if "category_id" in body:
        cat = check_category(db, body.get("category_id"))
        if cat != it["category_id"]:
            db.execute("UPDATE items SET category_id=? WHERE id=?", (cat, item_id))
            r = db.execute("SELECT name FROM categories WHERE id=?", (cat,)).fetchone() if cat else None
            edits.append("категория: %s" % (r["name"] if r else "без категории"))
    if "note" in body:
        note = s(body, "note", 500) or ""
        if note != it["note"]:
            db.execute("UPDATE items SET note=? WHERE id=?", (note, item_id))
            edits.append("заметка" if note else "заметка удалена")
    if edits:
        name = s(body, "name", 80) or it["name"]
        log(db, user, "✏️", "«%s»: %s" % (name, ", ".join(edits)), item_id)
    if changes or edits:
        db.execute("UPDATE items SET updated_by=?, updated_at=? WHERE id=?", (user["id"], t, item_id))
        db.commit()
    return ok()


def api_item_buy(req, db, user, item_id):
    it = get_item(db, item_id)
    if it["bought_at"]:
        return ok()
    t = now()
    db.execute("UPDATE items SET prev_status=?, status='have', bought_by=?, bought_at=?, updated_by=?, updated_at=? "
               "WHERE id=?", (it["status"], user["id"], t, user["id"], t, item_id))
    log(db, user, "🛒", "Куплено: «%s»" % it["name"], item_id)
    db.commit()
    return ok()


def api_item_unbuy(req, db, user, item_id):
    it = get_item(db, item_id)
    if not it["bought_at"]:
        return ok()
    prev = it["prev_status"] if it["prev_status"] in ("low", "out") else "out"
    t = now()
    db.execute("UPDATE items SET status=?, prev_status=NULL, bought_by=NULL, bought_at=NULL, updated_by=?, "
               "updated_at=? WHERE id=?", (prev, user["id"], t, item_id))
    log(db, user, "↩️", "Отмена покупки: «%s» — снова в списке" % it["name"], item_id)
    db.commit()
    return ok()


def api_item_delete(req, db, user, item_id):
    it = get_item(db, item_id)
    db.execute("UPDATE items SET deleted=1, updated_by=?, updated_at=? WHERE id=?", (user["id"], now(), item_id))
    log(db, user, "🗑", "Удалено: «%s»" % it["name"], item_id)
    db.commit()
    return ok()


# ───────────────────────────── фото ─────────────────────────────

DATAURL = re.compile(r"^data:image/(jpeg|png|webp);base64,(.+)$", re.S)


def decode_image(dataurl, limit):
    m = DATAURL.match(dataurl or "")
    if not m:
        raise HttpError(400, "Неверный формат картинки")
    try:
        raw = base64.b64decode(m.group(2), validate=False)
    except Exception:
        raise HttpError(400, "Картинка повреждена")
    if len(raw) > limit:
        raise HttpError(413, "Картинка слишком большая")
    return raw, ("jpg" if m.group(1) == "jpeg" else m.group(1))


def save_photo(body):
    full, ext = decode_image(body.get("full"), 2_500_000)
    thumb, text = decode_image(body.get("thumb"), 400_000)
    token = secrets.token_hex(12)
    with open(os.path.join(PHOTOS, "%s.%s" % (token, ext)), "wb") as f:
        f.write(full)
    with open(os.path.join(PHOTOS, "%s_t.%s" % (token, text)), "wb") as f:
        f.write(thumb)
    return "%s.%s|%s_t.%s" % (token, ext, token, text)


def remove_photo(photo):
    if not photo:
        return
    for name in photo.split("|"):
        p = os.path.join(PHOTOS, os.path.basename(name))
        try:
            os.remove(p)
        except OSError:
            pass


def api_item_photo(req, db, user, item_id):
    body = req.json()
    it = get_item(db, item_id)
    if body.get("remove"):
        photo = None
        text = "Фото удалено: «%s»" % it["name"]
    else:
        photo = save_photo(body)
        text = "Новое фото: «%s»" % it["name"]
    db.execute("UPDATE items SET photo=?, updated_by=?, updated_at=? WHERE id=?",
               (photo, user["id"], now(), item_id))
    log(db, user, "📷", text, item_id)
    db.commit()
    remove_photo(it["photo"])
    return ok({"photo": photo})


def api_tigra_photo(req, db, user):
    body = req.json()
    old = get_meta(db, "tigra_photo")
    photo = None if body.get("remove") else save_photo(body)
    set_meta(db, "tigra_photo", photo)
    log(db, user, "📷", "Новое фото Тигры" if photo else "Фото Тигры удалено")
    db.commit()
    remove_photo(old)
    return ok({"photo": photo})


def serve_photo(req, name):
    name = os.path.basename(name)
    if not re.match(r"^[0-9a-f]{24}(_t)?\.(jpg|png|webp)$", name):
        raise HttpError(404, "Нет файла")
    return serve_file(req, os.path.join(PHOTOS, name), "private, max-age=31536000, immutable")


# ───────────────────────────── Тигра ─────────────────────────────

def api_feed(req, db, user):
    body = req.json()
    what = s(body, "what", 60) or ""
    cur = db.execute("INSERT INTO feedings(user_id,at,what) VALUES(?,?,?)", (user["id"], now(), what))
    log(db, user, "🐯", "Покормлена Тигра" + (" (%s)" % what.lower() if what else ""))
    db.commit()
    return ok({"id": cur.lastrowid})


def api_feed_delete(req, db, user, feed_id):
    f = db.execute("SELECT * FROM feedings WHERE id=? AND deleted=0", (feed_id,)).fetchone()
    if not f:
        raise HttpError(404, "Запись не найдена")
    if f["user_id"] != user["id"] and user["role"] != "admin":
        raise HttpError(403, "Удалить можно только свою запись")
    db.execute("UPDATE feedings SET deleted=1 WHERE id=?", (feed_id,))
    when = time.strftime("%d.%m %H:%M UTC", time.gmtime(f["at"]))
    log(db, user, "↩️", "Отменено кормление Тигры от %s" % when)
    db.commit()
    return ok()


# ───────────────────────────── категории ─────────────────────────────

def api_cat_create(req, db, user):
    body = req.json()
    name = s(body, "name", 40, True)
    emoji = s(body, "emoji", 16) or "📦"
    mx = db.execute("SELECT COALESCE(MAX(sort),0)+1 FROM categories").fetchone()[0]
    cur = db.execute("INSERT INTO categories(name,emoji,sort) VALUES(?,?,?)", (name, emoji, mx))
    log(db, user, "🗂", "Новая категория: %s %s" % (emoji, name))
    db.commit()
    return ok({"id": cur.lastrowid})


def api_cat_update(req, db, user, cat_id):
    body = req.json()
    c = db.execute("SELECT * FROM categories WHERE id=? AND deleted=0", (cat_id,)).fetchone()
    if not c:
        raise HttpError(404, "Категория не найдена")
    name = s(body, "name", 40) or c["name"]
    emoji = s(body, "emoji", 16) or c["emoji"]
    db.execute("UPDATE categories SET name=?, emoji=? WHERE id=?", (name, emoji, cat_id))
    if "move" in body:
        cats = rows(db.execute("SELECT id FROM categories WHERE deleted=0 ORDER BY sort,id"))
        ids = [x["id"] for x in cats]
        i = ids.index(cat_id)
        j = i + (1 if body["move"] > 0 else -1)
        if 0 <= j < len(ids):
            ids[i], ids[j] = ids[j], ids[i]
            for n, cid in enumerate(ids):
                db.execute("UPDATE categories SET sort=? WHERE id=?", (n, cid))
        bump(db)
    elif (name, emoji) != (c["name"], c["emoji"]):
        log(db, user, "🗂", "Категория: %s %s → %s %s" % (c["emoji"], c["name"], emoji, name))
    db.commit()
    return ok()


def api_cat_delete(req, db, user, cat_id):
    c = db.execute("SELECT * FROM categories WHERE id=? AND deleted=0", (cat_id,)).fetchone()
    if not c:
        raise HttpError(404, "Категория не найдена")
    db.execute("UPDATE categories SET deleted=1 WHERE id=?", (cat_id,))
    db.execute("UPDATE items SET category_id=NULL WHERE category_id=?", (cat_id,))
    log(db, user, "🗑", "Удалена категория: %s %s" % (c["emoji"], c["name"]))
    db.commit()
    return ok()


# ───────────────────────────── история ─────────────────────────────

def api_log(req, db, user):
    sql = "SELECT id,user_id,at,icon,text,item_id FROM log WHERE 1=1"
    args = []
    for key, col in (("before", "id<"), ("item", "item_id="), ("user", "user_id=")):
        if req.query.get(key, "").isdigit():
            sql += " AND " + col + "?"
            args.append(int(req.query[key]))
    sql += " ORDER BY id DESC LIMIT 60"
    return ok({"log": rows(db.execute(sql, args))})


# ───────────────────────────── пользователи (админ) ─────────────────────────────

def api_user_create(req, db, user):
    body = req.json()
    name = s(body, "name", 40, True)
    login = s(body, "login", 40, True).lower()
    if not re.match(r"^[a-z0-9а-яё._-]{2,40}$", login):
        raise HttpError(400, "Логин: от 2 символов, буквы/цифры без пробелов")
    pw = body.get("password") or ""
    if len(pw) < 4:
        raise HttpError(400, "Пароль — минимум 4 символа")
    if db.execute("SELECT 1 FROM users WHERE login=?", (login,)).fetchone():
        raise HttpError(400, "Такой логин уже есть")
    role = "admin" if body.get("role") == "admin" else "user"
    n = db.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    salt, h = hash_pw(pw)
    db.execute("INSERT INTO users(login,name,salt,pw,role,color,created_at) VALUES(?,?,?,?,?,?,?)",
               (login, name, salt, h, role, COLORS[n % len(COLORS)], now()))
    log(db, user, "👤", "Новый пользователь: %s" % name)
    db.commit()
    return ok()


def api_user_update(req, db, user, uid):
    body = req.json()
    u = db.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    if not u:
        raise HttpError(404, "Пользователь не найден")
    changes = []
    if body.get("name") and s(body, "name", 40) != u["name"]:
        db.execute("UPDATE users SET name=? WHERE id=?", (s(body, "name", 40), uid))
        changes.append("имя → %s" % s(body, "name", 40))
    if body.get("color") and re.match(r"^#[0-9a-fA-F]{6}$", body["color"]):
        db.execute("UPDATE users SET color=? WHERE id=?", (body["color"], uid))
    if body.get("password"):
        if len(body["password"]) < 4:
            raise HttpError(400, "Пароль — минимум 4 символа")
        salt, h = hash_pw(body["password"])
        db.execute("UPDATE users SET salt=?, pw=? WHERE id=?", (salt, h, uid))
        db.execute("DELETE FROM sessions WHERE user_id=?", (uid,))
        changes.append("новый пароль")
    if "role" in body and body["role"] in ("admin", "user") and body["role"] != u["role"]:
        if uid == user["id"]:
            raise HttpError(400, "Нельзя снять админку с самого себя")
        db.execute("UPDATE users SET role=? WHERE id=?", (body["role"], uid))
        changes.append("админ" if body["role"] == "admin" else "обычный пользователь")
    if "active" in body and bool(body["active"]) != bool(u["active"]):
        if uid == user["id"]:
            raise HttpError(400, "Нельзя отключить самого себя")
        db.execute("UPDATE users SET active=? WHERE id=?", (1 if body["active"] else 0, uid))
        if not body["active"]:
            db.execute("DELETE FROM sessions WHERE user_id=?", (uid,))
        changes.append("включён" if body["active"] else "отключён")
    if changes:
        log(db, user, "👤", "Пользователь %s: %s" % (u["name"], ", ".join(changes)))
    else:
        bump(db)
    db.commit()
    return ok()


def api_me_update(req, db, user):
    body = req.json()
    name = s(body, "name", 40)
    if name and name != user["name"]:
        db.execute("UPDATE users SET name=? WHERE id=?", (name, user["id"]))
        log(db, user, "👤", "Теперь меня зовут: %s" % name)
    if body.get("color") and re.match(r"^#[0-9a-fA-F]{6}$", body["color"]):
        db.execute("UPDATE users SET color=? WHERE id=?", (body["color"], user["id"]))
        bump(db)
    db.commit()
    return ok()


# ───────────────────────────── статика ─────────────────────────────

COMPRESSIBLE = (".html", ".js", ".css", ".json", ".webmanifest", ".svg")


def serve_file(req, path, cache="no-cache"):
    if not os.path.isfile(path):
        raise HttpError(404, "Нет файла")
    st = os.stat(path)
    lm = formatdate(st.st_mtime, usegmt=True)
    ims = req.environ.get("HTTP_IF_MODIFIED_SINCE")
    if ims:
        try:
            if int(parsedate_to_datetime(ims).timestamp()) >= int(st.st_mtime):
                return Response(b"", 304, headers=[("Cache-Control", cache), ("Last-Modified", lm)])
        except Exception:
            pass
    with open(path, "rb") as f:
        data = f.read()
    ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
    if path.endswith(".webmanifest"):
        ctype = "application/manifest+json"
    if ctype.startswith("text/") or ctype in ("application/javascript", "application/json", "application/manifest+json"):
        ctype += "; charset=utf-8"
    headers = [("Cache-Control", cache), ("Last-Modified", lm)]
    if path.endswith(COMPRESSIBLE) and "gzip" in req.environ.get("HTTP_ACCEPT_ENCODING", ""):
        data = gzip.compress(data, 6)
        headers += [("Content-Encoding", "gzip"), ("Vary", "Accept-Encoding")]
    return Response(data, 200, ctype, headers)


ROOT_FILES = {"/": "index.html", "/index.html": "index.html", "/sw.js": "sw.js",
              "/manifest.webmanifest": "manifest.webmanifest",
              "/apple-touch-icon.png": "icons/apple-touch-icon.png",
              "/favicon.ico": "icons/favicon.png"}


# ───────────────────────────── маршруты ─────────────────────────────

PUBLIC, USER, ADMIN = 0, 1, 2
ROUTES = [
    ("POST", r"/api/login", api_login, PUBLIC),
    ("POST", r"/api/logout", api_logout, USER),
    ("GET", r"/api/rev", api_rev, USER),
    ("GET", r"/api/state", api_state, USER),
    ("GET", r"/api/log", api_log, USER),
    ("POST", r"/api/me", api_me_update, USER),
    ("POST", r"/api/me/password", api_password, USER),
    ("POST", r"/api/items", api_item_create, USER),
    ("POST", r"/api/items/(\d+)", api_item_update, USER),
    ("POST", r"/api/items/(\d+)/buy", api_item_buy, USER),
    ("POST", r"/api/items/(\d+)/unbuy", api_item_unbuy, USER),
    ("POST", r"/api/items/(\d+)/delete", api_item_delete, USER),
    ("POST", r"/api/items/(\d+)/photo", api_item_photo, USER),
    ("POST", r"/api/feed", api_feed, USER),
    ("POST", r"/api/feed/(\d+)/delete", api_feed_delete, USER),
    ("POST", r"/api/tigra/photo", api_tigra_photo, USER),
    ("POST", r"/api/categories", api_cat_create, USER),
    ("POST", r"/api/categories/(\d+)", api_cat_update, USER),
    ("POST", r"/api/categories/(\d+)/delete", api_cat_delete, USER),
    ("POST", r"/api/users", api_user_create, ADMIN),
    ("POST", r"/api/users/(\d+)", api_user_update, ADMIN),
]
ROUTES = [(m, re.compile("^" + p + "$"), f, lvl) for m, p, f, lvl in ROUTES]


def handle(req):
    path = req.path
    if path.startswith("/api/"):
        for method, rx, fn, level in ROUTES:
            m = rx.match(path)
            if not m:
                continue
            if method != req.method:
                continue
            if req.method == "POST" and "application/json" not in req.environ.get("CONTENT_TYPE", ""):
                raise HttpError(400, "Ожидается JSON")
            db = connect()
            try:
                user = current_user(req, db)
                if level >= USER and not user:
                    raise HttpError(401, "Нужно войти")
                if level >= ADMIN and user["role"] != "admin":
                    raise HttpError(403, "Только для админа")
                return fn(req, db, user, *[int(g) for g in m.groups()])
            finally:
                db.close()
        raise HttpError(404, "Нет такого метода")
    if path.startswith("/photos/"):
        db = connect()
        try:
            if not current_user(req, db):
                raise HttpError(401, "Нужно войти")
        finally:
            db.close()
        return serve_photo(req, path[len("/photos/"):])
    if path in ROOT_FILES:
        return serve_file(req, os.path.join(STATIC, ROOT_FILES[path]))
    if path.startswith("/static/"):
        rel = os.path.normpath(path[len("/static/"):]).replace("\\", "/")
        if rel.startswith("..") or rel.startswith("/"):
            raise HttpError(404, "Нет файла")
        return serve_file(req, os.path.join(STATIC, rel))
    raise HttpError(404, "Нет такой страницы")


def app(environ, start_response):
    init()
    req = Request(environ)
    try:
        resp = handle(req)
    except HttpError as e:
        resp = Response(json.dumps({"error": e.message}, ensure_ascii=False).encode("utf-8"), e.status)
    except Exception:
        import traceback
        traceback.print_exc()
        resp = Response(json.dumps({"error": "Ошибка сервера"}, ensure_ascii=False).encode("utf-8"), 500)
    headers = resp.headers + [("Content-Length", str(len(resp.body))),
                              ("X-Content-Type-Options", "nosniff"),
                              ("Referrer-Policy", "same-origin")]
    start_response(STATUS_TEXT.get(resp.status, "%d Status" % resp.status), headers)
    return [resp.body] if req.method != "HEAD" else [b""]


# ───────────────────────────── локальный запуск ─────────────────────────────

def lan_ips():
    ips = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    home = sorted(ip for ip in ips if ip.startswith("192.168."))
    return home or sorted(ip for ip in ips if not ip.startswith(("127.", "169.254.")))


if __name__ == "__main__":
    from socketserver import ThreadingMixIn
    from wsgiref.simple_server import WSGIRequestHandler, WSGIServer, make_server

    class ThreadingServer(ThreadingMixIn, WSGIServer):
        daemon_threads = True

    class QuietHandler(WSGIRequestHandler):
        def log_message(self, *args):
            pass

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    port = int(os.environ.get("PORT", "8000"))
    init()
    if os.path.exists(ADMIN_FILE):
        with open(ADMIN_FILE, encoding="utf-8") as f:
            print("\n" + f.read())
    print("  КормиКота запущена.")
    print("  На этом компьютере:   http://localhost:%d" % port)
    for ip in lan_ips():
        print("  С телефона (та же Wi-Fi сеть):  http://%s:%d" % (ip, port))
    print("\n  Закройте это окно, чтобы остановить.\n")
    make_server("0.0.0.0", port, app, server_class=ThreadingServer,
                handler_class=QuietHandler).serve_forever()
