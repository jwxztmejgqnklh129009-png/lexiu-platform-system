# -*- coding: utf-8 -*-
"""
乐秀内部管理平台
数据全部存放在 data/ 目录（一个数据库文件 + 一个附件目录），搬家时整体拷走即可。
"""
import os
import io
import json
import re
import hashlib
import shutil
import sqlite3
import secrets
import datetime
import threading
import stat
import uuid
import warnings
from functools import wraps

from flask import (Flask, request, session, jsonify, render_template,
                   redirect, url_for, send_from_directory, g, abort,
                   make_response)
from werkzeug.exceptions import RequestEntityTooLarge
from werkzeug.security import generate_password_hash, check_password_hash
from werkzeug.utils import secure_filename
from werkzeug.middleware.proxy_fix import ProxyFix

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, 'data')
UPLOAD_DIR = os.path.join(DATA_DIR, 'uploads')
BACKUP_DIR = os.path.join(DATA_DIR, 'backups')
DB_PATH = os.path.join(DATA_DIR, 'app.db')
INIT_PWD_FILE = os.path.join(DATA_DIR, '初始密码.txt')
# 消防照片允许在安全上限内先解码再生成压缩图；原图仍按上传字节保留。
FIRE_SOURCE_MAX_PIXELS = 60 * 1000 * 1000

os.makedirs(UPLOAD_DIR, exist_ok=True)

# 图片处理库是否可用（决定"生成缩略图失败"是否算上传失败）
try:
    from PIL import Image, ImageOps
    HAS_PIL = True
except Exception:
    HAS_PIL = False


def load_secret_key():
    """登录票据的密钥。固定存放，避免每次重启把所有人踢下线。
    优先级：环境变量 SECRET_KEY > data/secret.key > 自动生成并保存。"""
    env = os.environ.get('SECRET_KEY')
    if env:
        return env
    p = os.path.join(DATA_DIR, 'secret.key')
    try:
        if os.path.exists(p):
            v = open(p, encoding='utf-8').read().strip()
            if v:
                return v
            # 文件在、内容却是空的：多半是被误清空或写坏了。
            # 这种情况绝不能顺手换一把新钥匙——换完所有人的登录票据立刻作废，
            # 表现就是全员掉线，而数据其实还在，故障看着像"系统自己坏了"，很难查。
            # 只有确实是全新安装（连数据库都还没有）时才允许生成新密钥。
            if os.path.exists(DB_PATH):
                raise SystemExit(
                    '登录票据密钥文件是空的（%s），但数据库已经存在（%s）。\n'
                    '为免把所有人的登录状态一次性清空，这里停住不启动。\n'
                    '请从最近一次备份里把 secret.key 取回来；确认这台是全新安装、'
                    '里面没有任何数据时，再删掉这个空文件重新启动。' % (p, DB_PATH))
        v = secrets.token_hex(32)
        with open(p, 'w', encoding='utf-8') as f:
            f.write(v)
        return v
    except Exception as e:
        # 读不出来又存不下时不能拿随机密钥凑合：两个进程拿到不同密钥会表现为随机掉线，
        # 故障被藏起来更难查。宁可起不来，也要让问题摆在明面上。
        raise SystemExit(
            '登录票据密钥既读不出来也存不进去（%s: %s）。\n'
            '请检查 %s 这个文件能否读写，修好后再启动。' % (type(e).__name__, e, p))


app = Flask(__name__)
# 网站前面挡着 nginx，后台收到的请求都是 nginx 转过来的，直接看过去每个来访者
# 都像"本机"。这里按 nginx 附带的头把真实来访 IP 还原出来，登录日志和防猜密码
# 都靠它。只认最后一跳（也就是 nginx 自己写的那一份），更前面的不敢信，
# 否则谁都能伪造一个 IP 混进来。
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=0)
app.secret_key = load_secret_key()
# 单次上传的上限。以前给到 50MB：证照附件和酒单页其实几 MB 就够，
# 放宽只是给"恶意传超大文件拖慢服务器"留了门（审计 S-09）。
app.config['MAX_CONTENT_LENGTH'] = 20 * 1024 * 1024  # 20MB
# 登录票（cookie）的名字。改名字 = 之前发出去的旧票全部作废，
# 所有人下次打开必须重新输一次密码。只在需要"强制全部下线"时才改。
app.config['SESSION_COOKIE_NAME'] = 'lexiu_session'
# 公网走 HTTPS 时，登录票只允许在加密连接里传输，免得被不可信网络截走。
# 只有服务器（设了 LEXIU_HTTPS=1）才开；本机 HTTP 自测不开，否则登不进去。
app.config['SESSION_COOKIE_SECURE'] = (os.environ.get('LEXIU_HTTPS') == '1')
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'
# 多久没操作就自动登出（分钟）。手机上切后台不算关浏览器，靠这个兜底。
IDLE_MINUTES = 30

ALLOWED_EXT = {'pdf', 'jpg', 'jpeg', 'png', 'doc', 'docx', 'xls', 'xlsx'}
CATEGORIES = ['消防', '文旅', '公安', '健康证', '其他']
INVENTORY_CATEGORIES = ['酒水', '耗材', '其它']   # 仓库物品分类，北於 2026-09-30 确认三档
# 到期提醒只分两档：已经过期、15 天内到期。不做更多档位，避免看板被切得太碎。
DEFAULT_REMIND_DAYS = 15
REMIND_LIMIT = 15
EXPIRY_LEVELS = [
    (0, 'expired', '已过期'),
    (REMIND_LIMIT, 'warn', '15天内到期'),
]

TODAY = datetime.date.today

# 版本号：每次发布新版本前 +1，页面底部会显示，方便确认服务器上跑的是哪一版
VERSION = '1.14.8'

# 认哪些域名才算"本站"。
# 浏览器每次发写请求都会自带一个"来源域名"，但那个值是对方想填什么就填什么的，
# 光拿它跟自己比，遇到网关放行别的域名就绕过去了。所以这里固定一份名单对照。
# 换域名或加新地址时，在服务器上设环境变量 LEXIU_TRUSTED_HOSTS（多个用逗号隔开）。
CANONICAL_HOST = os.environ.get('LEXIU_CANONICAL_HOST', 'lxktv.cn').strip().lower()


def _trusted_hosts():
    """本站认的域名名单（不带端口）。"""
    hosts = {CANONICAL_HOST, 'www.' + CANONICAL_HOST,
             '127.0.0.1', 'localhost'}       # 后两个留着给服务器本机自测
    for h in os.environ.get('LEXIU_TRUSTED_HOSTS', '').split(','):
        h = h.strip().lower()
        if h:
            hosts.add(h)
    return hosts

# 北於 2026-10-06 裁定：按账号锁 24 小时；IP 只做 5 分钟轻量限流。
# IP 限流只挡错误尝试，正确密码可登录；已锁账号仍须等待或命令行解锁。
LOGIN_FAIL_LIMIT = 5
ACCOUNT_LOCK_MINUTES = 24 * 60
IP_RATE_LIMIT = 20
IP_RATE_WINDOW = 300
# login_guard 现有结构不变。非 IP 标记记住第 5 次失败时刻，防止早先
# 失败记录过期把 24 小时的锁缩短；标记不参与 IP 计数。
LOGIN_ACCOUNT_LOCK_IP = '@account-lock'


def lock_hint(minutes=None):
    """被挡住时提示等多久。不到一小时说分钟，超过就说大约几小时，
    免得看到一长串分钟数不知道要等到什么时候。"""
    m = ACCOUNT_LOCK_MINUTES if minutes is None else max(1, minutes)
    if m < 60:
        return '%d 分钟' % m
    return '约 %.0f 小时' % (m / 60)

# 酒水单公开页底部的说明文字（管理员可在后台改，改完存 settings 表）
DEFAULT_DRINK_NOTE = '以上价格含厢座服务费，如需保留存酒请咨询前台'

# 「手机预览」入口开关：只在用 python app.py 直接启动（本机自测）时打开。
# 服务器用 gunicorn 跑 app:app，不执行文件末尾的 __main__ 块，这里保持 False，
# 所以正式版页面上不会出现「手机预览」按钮，直接访问 /preview 也会被送回首页。
SHOW_PREVIEW = False


@app.errorhandler(RequestEntityTooLarge)
def handle_request_too_large(error):
    """让 API 上传超限返回可读 JSON，页面请求仍保持普通错误页。"""
    if request.path.startswith('/api/') or request.is_json:
        return jsonify({'error': '上传内容超过 20MB 限制，请压缩照片后重试'}), 413
    return error


@app.errorhandler(500)
def handle_internal_error(error):
    """API 异常不把 HTML 错误页交给前端 JSON 解析。"""
    if request.path.startswith('/api/') or request.is_json:
        return jsonify({'error': '服务器暂时无法完成请求，请稍后重试'}), 500
    return error


# ---------- 数据库 ----------
def get_db():
    if 'db' not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute('PRAGMA foreign_keys = ON')
    return g.db


@app.teardown_appcontext
def close_db(e=None):
    db = g.pop('db', None)
    if db is not None:
        db.close()


def _begin_write(db):
    """开始一次"要改数据"的动作：一上来先把写锁抢到手。

    服务器上是两个进程同时接活的（技术名词叫多进程），两个人同时做同一件事时，
    两个进程可能都先读到"现在还剩两个管理员""这件东西还在库里"，
    然后各自照着旧情况去改——结果管理员被删到 0、同一件资产被两个人同时领走
    （审计 10/02 M-02、S-02 都实测过）。

    这里一开始就抢锁：谁先进来谁先改，另一个等对方办完再读，读到的就是新情况。
    ⚠️ 所以**"查"和"改"必须放在同一个 _begin_write 里**，
    隔着两次去看等于没锁住——这是这类改法唯一有效的写法。
    返回 True 表示锁拿到了；已经在事务里或者实在拿不到返回 False，
    调用方还有一道"只在我看到的情况下才改"的条件 UPDATE 兜底（见各处 rowcount 判断）。
    """
    if db.in_transaction:
        return True          # 这次请求里已经开过事务了，沿用原来的，不再套一层
    try:
        db.execute('BEGIN IMMEDIATE')
        return True
    except sqlite3.Error:
        return False


def _end_write(db, ok=True):
    """结束一次 _begin_write：成了就落定，不成就把刚才那几笔全部撤回来。

    **看返回值，别看心情**：返回 True 才是真的落到库里了，False = 这次改动没成功。

    以前这里把"提交失败"悄悄吞掉，调用方照旧回一个"成功"。结果页面显示
    "领用登记完成"，库里其实一件没动——用户以为办妥了，回头实物还是没人认领
    （审计 10/03 第二轮 S-01，注入一次提交失败即可复现）。
    所以调用.**写**的地方一律要接住返回值：没落库就给用户报错，不许报喜不报忧。
    """
    try:
        if ok:
            db.commit()
            return True
        db.rollback()
        return False
    except sqlite3.Error:
        try:
            db.rollback()
        except Exception:
            pass
        return False


# 后来才加的表。老库升级时要新建它们，属于"改结构"，必须和加列一样先备份再建，
# 不能借"初始化"的名义偷偷建掉。（见 migrate() 中的缺表检测）
# 全新安装要建的整套表。以前这套 SQL 只写在 init_db() 里，
# 老库升级要补的表另写一份 NEW_TABLE_SQL，两边各写各的：
# 只在左边出现过的表，任何比它更老的备份恢复回来都永远补不上，
# 而启动时的历史整理第一件事就翻这些表，缺一张网站就卡在维护页。
# 现在合成一份，新装和升级共用（升级那边还会先备份再动结构）。
BASE_TABLE_SQL = {
    'users': '''
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'staff',
        active INTEGER NOT NULL DEFAULT 1,
        last_login TEXT,
        pwd_changed_at TEXT,
        created_at TEXT NOT NULL
    );''',
    'employees': '''
    CREATE TABLE IF NOT EXISTS employees (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        position TEXT,
        phone TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
    );''',
    'certificates': '''
    CREATE TABLE IF NOT EXISTS certificates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL DEFAULT 'company',
        category TEXT NOT NULL DEFAULT '其他',
        name TEXT NOT NULL,
        cert_type TEXT,
        cert_no TEXT,
        issuer TEXT,
        holder TEXT,
        keeper TEXT,
        employee_id INTEGER,
        issue_date TEXT,
        expiry_mode TEXT NOT NULL DEFAULT 'date',
        expiry_date TEXT,
        remind_days INTEGER NOT NULL DEFAULT 30,
        flow_status TEXT NOT NULL DEFAULT 'draft',
        paper_location TEXT,
        note TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_by TEXT,
        created_at TEXT NOT NULL
    );''',
    'versions': '''
    CREATE TABLE IF NOT EXISTS versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cert_id INTEGER NOT NULL,
        version_no INTEGER NOT NULL,
        original_name TEXT,
        stored_name TEXT NOT NULL,
        web_name TEXT,
        thumb_name TEXT,
        size INTEGER,
        change_note TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        reject_reason TEXT,
        uploaded_by TEXT,
        uploaded_at TEXT NOT NULL,
        reviewed_by TEXT,
        reviewed_at TEXT
    );''',
    'assets': '''
    CREATE TABLE IF NOT EXISTS assets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT,
        name TEXT NOT NULL,
        category TEXT,
        location TEXT,
        status TEXT NOT NULL DEFAULT 'in_stock',
        holder TEXT,
        taken_at TEXT,
        note TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        -- 这里单独用一列记审核状态：上面那个 status 是"在库 / 已借出"的业务状态，
        -- 两件事不能挤在一格里，不然一退回就把资产当成借出了
        review_status TEXT NOT NULL DEFAULT 'approved',
        created_by TEXT,
        reviewed_by TEXT,
        reviewed_at TEXT,
        reject_reason TEXT
    );''',
    'asset_logs': '''
    CREATE TABLE IF NOT EXISTS asset_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_id INTEGER NOT NULL,
        action TEXT NOT NULL,
        person TEXT,
        at TEXT NOT NULL,
        note TEXT
    );''',
    'logs': '''
    CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user TEXT,
        action TEXT NOT NULL,
        target_type TEXT,
        target_id INTEGER,
        detail TEXT,
        at TEXT NOT NULL
    );''',
}
NEW_TABLE_SQL = {
    'fire_photos': '''
    CREATE TABLE IF NOT EXISTS fire_photos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        directory_code TEXT NOT NULL,
        stored_name TEXT NOT NULL UNIQUE,
        web_name TEXT NOT NULL UNIQUE,
        thumb_name TEXT NOT NULL UNIQUE,
        original_name TEXT NOT NULL,
        mime_type TEXT NOT NULL CHECK(mime_type IN ('image/jpeg','image/png')),
        file_size INTEGER NOT NULL CHECK(file_size > 0 AND file_size <= 15728640),
        width INTEGER NOT NULL CHECK(width > 0),
        height INTEGER NOT NULL CHECK(height > 0),
        sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
        client_token TEXT NOT NULL UNIQUE,
        batch_token TEXT CHECK(batch_token IS NULL OR length(batch_token) = 36),
        batch_index INTEGER CHECK(batch_index IS NULL OR batch_index >= 1),
        sort_order INTEGER,
        status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','replaced')),
        replaces_photo_id INTEGER REFERENCES fire_photos(id) ON DELETE SET NULL,
        uploaded_user_id INTEGER NOT NULL,
        uploaded_by TEXT NOT NULL,
        uploaded_at TEXT NOT NULL,
        reviewed_by TEXT,
        reviewed_at TEXT,
        reject_reason TEXT NOT NULL DEFAULT '',
        UNIQUE(batch_token, batch_index),
        CHECK((batch_token IS NULL AND batch_index IS NULL)
              OR (batch_token IS NOT NULL AND batch_index IS NOT NULL AND batch_index >= 1)),
        CHECK(width * height <= 60000000),
        CHECK((status = 'approved' AND sort_order IS NOT NULL AND sort_order >= 1)
              OR (status <> 'approved' AND sort_order IS NULL))
    );''',
    'fire_photo_order_requests': '''
    CREATE TABLE IF NOT EXISTS fire_photo_order_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        directory_code TEXT NOT NULL,
        requested_user_id INTEGER NOT NULL,
        requested_by TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        base_photo_ids_json TEXT NOT NULL,
        photo_ids_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')),
        reviewed_by TEXT,
        reviewed_at TEXT,
        reject_reason TEXT NOT NULL DEFAULT ''
    );''',
    'drink_pages': '''
    CREATE TABLE IF NOT EXISTS drink_pages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sort_no INTEGER NOT NULL DEFAULT 0,
        title TEXT NOT NULL DEFAULT '',
        original_name TEXT,
        stored_name TEXT NOT NULL,
        web_name TEXT,
        thumb_name TEXT,
        size INTEGER,
        uploaded_by TEXT,
        uploaded_at TEXT NOT NULL
    );''',
    'settings': '''
    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
    );''',
    # 只记"登录输错"这件事，服务于防猜密码。不存密码本身，成功登录后就清掉。
    'login_guard': '''
    CREATE TABLE IF NOT EXISTS login_guard (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ip TEXT NOT NULL,
        username TEXT,
        at TEXT NOT NULL
    );''',
    # 仓库物品档案：酒水 / 耗材 / 其它，记库存数量、过期、安全库存
    'inventory_items': '''
    CREATE TABLE IF NOT EXISTS inventory_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT '其它',
        spec TEXT,
        unit TEXT NOT NULL DEFAULT '个',
        quantity INTEGER NOT NULL DEFAULT 0,
        safety_stock INTEGER NOT NULL DEFAULT 0,
        expiry_mode TEXT NOT NULL DEFAULT 'date',
        expiry_date TEXT,
        warn_days INTEGER NOT NULL DEFAULT 15,
        location TEXT,
        note TEXT,
        image_web TEXT,
        image_thumb TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        -- 审核状态：approved 已通过 / pending 待审核 / rejected 已退回
        -- 员工录的物品先停在 pending，管理员通过后才在列表里生效
        status TEXT NOT NULL DEFAULT 'approved',
        created_by TEXT,
        reviewed_by TEXT,
        reviewed_at TEXT,
        reject_reason TEXT,
        created_at TEXT NOT NULL
    );''',
    # 出入库流水：采购入库 / 消耗出库 / 盘点调整 / 期初建账，只增不删
    'inventory_logs': '''
    CREATE TABLE IF NOT EXISTS inventory_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL,
        action TEXT NOT NULL,
        change_qty INTEGER NOT NULL,
        after_qty INTEGER NOT NULL,
        supplier TEXT,
        operator TEXT,
        at TEXT NOT NULL,
        note TEXT
    );''',
    # 仓库图片与证照附件一样：员工上传待审，管理员通过后成为当前图。
    # 新表由 migrate() 先完成数据库+整目录两份备份，再为已有库补建。
    'inventory_image_versions': '''
    CREATE TABLE IF NOT EXISTS inventory_image_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL,
        version_no INTEGER NOT NULL,
        original_name TEXT,
        file_size INTEGER,
        web_name TEXT NOT NULL,
        thumb_name TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        uploaded_by TEXT,
        uploaded_at TEXT NOT NULL,
        reviewed_by TEXT,
        reviewed_at TEXT,
        reject_reason TEXT,
        UNIQUE(item_id, version_no)
    );''',
    # 员工修改只登记申请；审核前不动当前资料和提醒。
    'certificate_edit_requests': '''
    CREATE TABLE IF NOT EXISTS certificate_edit_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cert_id INTEGER NOT NULL,
        patch_json TEXT NOT NULL,
        base_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        submitted_by TEXT NOT NULL,
        submitted_at TEXT NOT NULL,
        reviewed_by TEXT,
        reviewed_at TEXT,
        reject_reason TEXT
    );''',
    # 防重复提交用的登记本：记住"谁、在哪个接口、提交过什么内容、什么时候"。
    # 页面上的按钮锁只能挡住"同一个页面连点"，挡不住网络慢时的重试、
    # 手机和电脑同时点、或者绕开页面直接发请求。这一层放在服务器，所有模块都沾光。
    # state：0 = 正在处理（还没办完），1 = 已经办完。
    # 两个 worker 同时到达时，"有没有人在办"必须在数据库里一次判定，
    # 分开查再插是拦不住并发的（审计 M-02）。
    'submit_guard': '''
    CREATE TABLE IF NOT EXISTS submit_guard (
        fp TEXT PRIMARY KEY,
        who TEXT,
        path TEXT,
        at TEXT NOT NULL,
        state INTEGER NOT NULL DEFAULT 1
    );''',
}

# 一张现在的库该有的全部表：先全新安装那套，再接后来加的那套。
# 老库升级照这份清单补——缺哪张建哪张（migrate 会先备份再动手）。
ALL_TABLE_SQL = dict(BASE_TABLE_SQL, **NEW_TABLE_SQL)
REBUILD_FIRE_PHOTOS_FOR_PIXEL_LIMIT = '__rebuild_fire_photos_for_pixel_limit__'


def _existing_tables(db):
    return {r[0] for r in db.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}


def _ensure_first_admin():
    """库里一个账号都没有时补一个管理员，否则谁都登不进去。已有账号则什么都不做。"""
    db = sqlite3.connect(DB_PATH)
    c = db.cursor()
    try:
        if c.execute('SELECT COUNT(*) FROM users').fetchone()[0]:
            return
        pwd = os.environ.get('INIT_ADMIN_PASSWORD') or secrets.token_urlsafe(6)
        # 顺序很重要：先把密码落到文件里，再建账号。
        # 反过来做的话，万一文件没写成（权限问题、磁盘满了），账号已经建好却没人知道
        # 密码，等于把自己锁在门外。先写文件，写不出来就干脆不建账号，下次启动还能重试。
        with open(INIT_PWD_FILE, 'w', encoding='utf-8') as f:
            f.write('管理员账号：admin\n初始密码：%s\n\n'
                    '登录后请立即在「设置」里修改密码，然后删掉这个文件。\n' % pwd)
        try:
            c.execute('INSERT INTO users (username, password_hash, name, role, active, created_at)'
                      ' VALUES (?,?,?,?,1,?)',
                      ('admin', generate_password_hash(pwd), '管理员', 'admin', now()))
            db.commit()
        except Exception:
            # 账号没建成，密码文件也不能留着骗人：下次启动会重新生成一个对得上的
            try:
                os.remove(INIT_PWD_FILE)
            except OSError:
                pass
            raise
    finally:
        db.close()


def init_db():
    """全新空库才在这建表；已有库一律交给 migrate()，保证任何结构变更都先备份。
    （以前这里会顺手把新表建掉，导致老库被改了结构却没有升级前的备份。）"""
    os.makedirs(DATA_DIR, exist_ok=True)
    # 「是不是全新安装」必须赶在连库之前判定：sqlite3.connect 会顺手造出一个空文件，
    # 等连上再问文件存不存在，答案永远是真的，全新安装就永远进不来了。
    fresh = not os.path.exists(DB_PATH)
    db = sqlite3.connect(DB_PATH)
    tables = _existing_tables(db)
    db.close()
    if tables:
        # 迁移不成功（多半是没备份成）必须就地停住，不能让新代码接着访问旧结构，
        # 否则页面会一片 500，而且没有可靠的回退点。
        if not migrate():
            raise SystemExit('数据库需要升级，但没能先备份成功，已停止启动。'
                             '请手动把 data 整个目录复制一份留底后，再重新启动。')
        _ensure_first_admin()
        return

    # 数据库文件在、里面却一张表都没有：多半是被截断、清空或换成了空库。
    # 这时候"贴心地"重建一套空表最危险——页面会显示空台账，
    # 运维一看"系统正常了"就不再追查，真正的数据窗口就这么错过了。
    # 只有确认是全新安装（连文件都还没有）才往下建库。
    if not fresh:
        raise SystemExit(
            '数据库文件存在，但里面一张表都没有，看起来是被清空或损坏了：%s\n'
            '为避免把现场盖掉，这里停住不启动。\n'
            '请先从最近一次备份恢复 data/ 目录；确认这就是一台全新机器、'
            '不需要任何旧数据时，把这个文件移走再启动。' % DB_PATH)

    db = sqlite3.connect(DB_PATH)
    c = db.cursor()
    c.executescript('\n'.join(BASE_TABLE_SQL.values()))
    for sql in NEW_TABLE_SQL.values():
        c.execute(sql)
    # 建完再按统一口径核一遍，缺的列当场补上。
    # 上面那段手写建表 SQL 和标准结构各写各的，迟早会漂——
    # versions 表就漏过 web_name / thumb_name 两列，全新部署第一次传图直接 500。
    for sql in pending_schema_sql(db):
        c.execute(sql)
    db.commit()
    db.close()
    _ensure_first_admin()


def backup_db_file(tag):
    """把数据库整份留底到 data/backups/。成功返回备份路径，失败返回 None。

    用 SQLite 自带的备份接口，而不是直接复制文件：直接复制时如果正好有人在写
    （登录、提交表单），拿到的可能是半个新半个旧的库，看着拷成功了其实恢复不了。
    备份完还会真的打开读一眼，确认能读才返回成功。
    """
    if not os.path.exists(DB_PATH):
        return None
    dst = None
    try:
        os.makedirs(BACKUP_DIR, exist_ok=True)
        dst = os.path.join(BACKUP_DIR, 'app_%s_%s.db'
                           % (tag, datetime.datetime.now().strftime('%Y%m%d-%H%M%S')))
        src = sqlite3.connect(DB_PATH)
        out = sqlite3.connect(dst)
        try:
            src.backup(out)          # 一致性快照，不受并发写入影响
        finally:
            out.close()
            src.close()
        chk = sqlite3.connect(dst)
        chk.execute('SELECT COUNT(*) FROM sqlite_master').fetchone()
        chk.close()
        return dst
    except Exception:
        try:
            if dst and os.path.exists(dst):
                os.remove(dst)       # 没做成的半成品不要留在那儿冒充备份
        except Exception:
            pass
        return None


# 正在写着、还没写完的备份目录清单（本进程内）。
# 清理旧备份时必须跳过它们：备份整目录要拷一堆附件，耗时比一次网页请求长得多，
# 两个人（或者同一个人多点了一下）同时在备份是完全可能的，
# 先做完的那个要是把后做完那个正在写的目录当"最旧的"删掉，两边都白干。
_BACKUP_IN_PROGRESS = set()
_BACKUP_IP_LOCK = threading.Lock()


def _backup_busy_add(p):
    with _BACKUP_IP_LOCK:
        _BACKUP_IN_PROGRESS.add(os.path.abspath(p))


def _backup_busy_del(p):
    with _BACKUP_IP_LOCK:
        _BACKUP_IN_PROGRESS.discard(os.path.abspath(p))


def _backup_busy_has(p):
    with _BACKUP_IP_LOCK:
        return os.path.abspath(p) in _BACKUP_IN_PROGRESS


def _natural_key(name):
    """把名字里的数字当成数字来排（`-2` 排在 `-10` 前面）。

    纯字典序会把 `-10` 排到 `-2` 前面，于是同一秒内连着备份时，
    可能把刚做成的那一份当成"更早的"删掉。
    """
    out, num = [], ''
    for ch in name:
        if ch.isdigit():
            num += ch
        else:
            if num:
                out.append((1, int(num)))
                num = ''
            out.append((0, ch))
    if num:
        out.append((1, int(num)))
    return tuple(out)


def _backup_birth_key(name):
    """按目录真正出生的时间排序。

    注意不能按目录名的字典序排：同一秒撞名排出来的 `data_xxx-2` 在字典序里
    排在 `data_xxx` 后面，看起来像"更晚的一份"，于是清理时反而会把先做成
    的那份当最旧的删掉。更糟的是这条路正是刚要返回给调用方的那一份——
    前端显示"备份成功，路径是 xxx"，用户转头去找，目录已经没了
    （审计 10/03 全站验收 M-02）。
    """
    try:
        t = os.path.getctime(os.path.join(BACKUP_DIR, name))
    except Exception:
        t = 0.0
    # 同一秒内建出来的目录时间一样，就得靠名字里那个排队号分先后
    return (t, _natural_key(name))


def _keep_last_full_backups(keep, protect=None):
    """只清理结构升级前的整目录备份，周期及发布前备份独立保留。
    周期快照/目录由周期脚本验证整套成功后按 3 套清理。

    protect：本次刚做好的目录。返回给调用方的路径必须真的还在，所以这份
    无论如何都不能被清理掉——它也要占掉一个名额，否则连着备份时，
    每次清理都"留下 5 份旧的 + 本次这一份"，总数会一节一节涨过约定。
    """
    try:
        root = os.path.abspath(BACKUP_DIR)
        if os.path.normcase(os.path.realpath(root)) != os.path.normcase(root):
            return  # 备份目录本身或上级经链接跳转时，不做自动清理。

        def plain_migration_dir(name):
            full = os.path.join(root, name)
            info = os.lstat(full)
            return (name.startswith('data_结构升级前_')
                    and stat.S_ISDIR(info.st_mode)
                    and not stat.S_ISLNK(info.st_mode)
                    and not getattr(info, 'st_file_attributes', 0) & 0x400)

        olds = [d for d in os.listdir(BACKUP_DIR)
                if d.startswith('data_结构升级前_') and plain_migration_dir(d)]
        olds.sort(key=_backup_birth_key)
        keep_path = os.path.abspath(protect) if protect else None
        victims = []
        for d in olds:
            full = os.path.join(BACKUP_DIR, d)
            if keep_path and os.path.abspath(full) == keep_path:
                continue                    # 本次的成果，留着
            if _backup_busy_has(full):
                continue                    # 别人还在往里拷，别动
            victims.append(d)
        # 只有 protect 真在本类清单中才占一个名额。未传 protect、或正在
        # 做发布/周期备份时，不能无端少留一份迁移备份。
        protected = bool(keep_path and any(os.path.abspath(os.path.join(BACKUP_DIR, d)) == keep_path for d in olds))
        cap = max(0, keep - int(protected))
        victims = victims[:len(victims) - cap] if len(victims) > cap else []
        for d in victims:
            full = os.path.join(root, d)
            target = os.path.realpath(full)
            if (not plain_migration_dir(d)
                    or os.path.normcase(target) != os.path.normcase(full)
                    or os.path.dirname(target) != root):
                continue
            shutil.rmtree(full, ignore_errors=True)
    except Exception:
        pass      # 清理失败不影响本次备份成功，不值得为此停下来


def backup_data_dir(tag, db_snapshot=None, keep=5, payload_only=False):
    """把整个 data/ 目录（附件、登录票据密钥等）整份留底到 data/backups/。
    成功返回备份目录，失败返回 None（并把半成品清掉，不让它冒充备份）。

    数据库那份用上面的 SQLite 接口拿一致性快照，这里补的是它管不到的部分：
    uploads/ 里的附件、secret.key 这类文件。两样凑齐才是能恢复的一套——
    只备份数据库的话，附件或密钥出问题时回滚会缺一半。

    db_snapshot：数据库一致性快照的路径。给了的话，目录里的那份裸数据库
    会被换成这个快照。以前目录里躺的是复制瞬间的裸库，和单独那份快照
    可能不是一个时间点，恢复时不知道该信哪个（审计 S-05）。
    keep=None：交给周期脚本在整套核验完成后清理，失败时不淘汰旧备份。
    payload_only=True：周期备份只复制数据库、uploads、secret.key；迁移留底
    默认仍复制整个 data（排除 backups），不改变原有恢复范围。
    """
    dst = None
    built = False       # 目标目录是不是本次亲手抢到的（决定了失败时能不能删）
    try:
        os.makedirs(BACKUP_DIR, exist_ok=True)
        stamp = datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
        base = os.path.join(BACKUP_DIR, 'data_%s_%s' % (tag, stamp))
        # 目录名只能精确到秒，同一秒内再来一次就会撞名。撞了就往后排（-2、-3…），
        # 绝不许直接往既有目录上盖。
        #
        # 关键是"怎么看这个位置有没有人"：不能先 os.path.exists 看一眼空着、
        # 再动手往里拷——两个人可能同时看到同一个空位子，一起往里写，最后
        # 其中一个出错清理时，会把另一个人刚做好的备份连锅端了（第二轮 M-04）。
        # 改成"抢座位"：os.mkdir 同一时刻只允许一个人成功，谁建成谁是主人，
        # 后来的人拿到 FileExistsError 自己去排下一个号。
        dst = base
        n = 1
        while True:
            try:
                os.mkdir(dst)
                built = True        # 只有真的是这次抢到的，后面出错才有资格删
                break
            except FileExistsError:
                n += 1
                if n > 500:
                    raise OSError('同一秒内排了 500 个备份目录，先清理一下 data/backups')
                dst = '%s-%d' % (base, n)
        db_base = os.path.basename(DB_PATH)

        def _ignore(d, names):
            # 备份目录自己就在 data/ 里，不再套一层，否则会越备份越大
            if os.path.abspath(d) != os.path.abspath(DATA_DIR):
                return set()
            ig = {'backups'}
            if payload_only:
                ig.update(set(names) - {db_base, 'uploads', 'secret.key'})
            if db_snapshot:
                ig.add(db_base)      # 裸库不要，稍后放快照进去
            return ig

        # 登记"这个目录我正写着"，清理旧备份的时候好跳过它
        _backup_busy_add(dst)
        try:
            # dirs_exist_ok=True 不是图省事：目录是上面用独占的方式抢下来的，
            # 这里必须允许它已经存在，否则 copytree 自己会再造一次目录然后报错。
            shutil.copytree(DATA_DIR, dst, ignore=_ignore, dirs_exist_ok=True)
            if db_snapshot:
                shutil.copyfile(db_snapshot, os.path.join(dst, db_base))
            # 留一句话说明这份备份里数据库是哪个时间点的，免得恢复时靠猜
            with open(os.path.join(dst, '备份说明.txt'), 'w', encoding='utf-8') as f:
                f.write('备份时间：%s\n' % stamp)
                f.write('备份原因：%s\n' % tag)
                f.write('里面的 %s 是这一刻的一致性快照（不是直接复制的裸库），'
                        '其余文件是同一时间复制的原件。\n' % db_base)
                f.write('恢复方法：停掉网站，把本目录里的东西整体盖回 data/ 目录，再启动。\n')
        finally:
            _backup_busy_del(dst)
        # 复制完真数一遍文件：拷出个空目录也"没报错"，那等于没备份
        how_many = sum(len(fs) for _, _, fs in os.walk(dst))
        if how_many == 0:
            raise OSError('备份目录里一个文件都没有')
        if keep is not None:
            _keep_last_full_backups(keep, protect=dst)
        # 返回之前再确认一次这个目录还在：清理环节或别人并发操作时可能把它弄没，
        # 不能让调用方拿到一个"成功了"但已经不存在的路径。
        if not os.path.isdir(dst):
            return None
        return dst
    except Exception:
        # 半成品要清掉，但**只能清本次亲手建出来的**。撞名的情况下
        # dst 里面可能已经是别人做好了的备份，删它等于毁掉最后的退路。
        try:
            if built and dst and os.path.exists(dst):
                shutil.rmtree(dst)
        except Exception:
            pass
        return None


def pending_schema_sql(db):
    """算出这个库还差哪些建表 / 补列语句。只算不改，谁都能安全地调用。

    全新库和老库共用这一份判断：以前两处的建表 SQL 各写各的，
    新库建出来的 versions 少了两列，只有等线上第一次传图报错才被发现。
    """
    todo = []
    tables = _existing_tables(db)
    for name, sql in ALL_TABLE_SQL.items():
        if name not in tables:
            todo.append(sql)                 # 缺表也算改结构，一起先备份再建
    # 只有表已经存在，才谈得上"给它补列"——versions 也一样。
    # 缺表时上面的 CREATE TABLE 语句本身就把新列一并建好了；而 PRAGMA table_info
    # 对不存在的表返回的是空列表、又不报错，如果不先确认表在不在，
    # 就会对着空气 ALTER，SQLite 直接报 "no such table"，网站整个起不来。
    if 'versions' in tables:
        cols = [r[1] for r in db.execute('PRAGMA table_info(versions)')]
        if 'web_name' not in cols:
            todo.append('ALTER TABLE versions ADD COLUMN web_name TEXT')
        if 'thumb_name' not in cols:
            todo.append('ALTER TABLE versions ADD COLUMN thumb_name TEXT')
    if 'users' in tables:
        ucols = [r[1] for r in db.execute('PRAGMA table_info(users)')]
        if 'pwd_changed_at' not in ucols:
            todo.append('ALTER TABLE users ADD COLUMN pwd_changed_at TEXT')
    # 下面的两张仓库/资产表同理：
    # 缺表时上面的 CREATE TABLE 语句本身已经把这些列一并建好了；
    # 而 PRAGMA table_info 对不存在的表返回的是空列表、又不报错，
    # 结果就会稀里糊涂再 ALTER 一次同名列，SQLite 报 duplicate column name，
    # 整个网站起不来（从旧的 1.4.4 生产库升级过来正好会撞上，仓库表那时还没有）。
    if 'inventory_items' in tables:
        icols = [r[1] for r in db.execute('PRAGMA table_info(inventory_items)')]
        if 'image_web' not in icols:
            todo.append('ALTER TABLE inventory_items ADD COLUMN image_web TEXT')
        if 'image_thumb' not in icols:
            todo.append('ALTER TABLE inventory_items ADD COLUMN image_thumb TEXT')
        # 仓库物品也要走审核：员工可以录入，但要管理员点头才算数。
        # 老数据默认"已通过"，不让以前录的东西突然消失。
        if 'status' not in icols:
            todo.append("ALTER TABLE inventory_items ADD COLUMN status"
                        " TEXT NOT NULL DEFAULT 'approved'")
        if 'created_by' not in icols:
            todo.append('ALTER TABLE inventory_items ADD COLUMN created_by TEXT')
        if 'reviewed_by' not in icols:
            todo.append('ALTER TABLE inventory_items ADD COLUMN reviewed_by TEXT')
        if 'reviewed_at' not in icols:
            todo.append('ALTER TABLE inventory_items ADD COLUMN reviewed_at TEXT')
        if 'reject_reason' not in icols:
            todo.append('ALTER TABLE inventory_items ADD COLUMN reject_reason TEXT')
    # 固定资产也走同一套审核：员工能登记新资产，管理员点头才算数。
    if 'assets' in tables:
        acols = [r[1] for r in db.execute('PRAGMA table_info(assets)')]
        if 'review_status' not in acols:
            todo.append("ALTER TABLE assets ADD COLUMN review_status"
                        " TEXT NOT NULL DEFAULT 'approved'")
        if 'created_by' not in acols:
            todo.append('ALTER TABLE assets ADD COLUMN created_by TEXT')
        if 'reviewed_by' not in acols:
            todo.append('ALTER TABLE assets ADD COLUMN reviewed_by TEXT')
        if 'reviewed_at' not in acols:
            todo.append('ALTER TABLE assets ADD COLUMN reviewed_at TEXT')
        if 'reject_reason' not in acols:
            todo.append('ALTER TABLE assets ADD COLUMN reject_reason TEXT')
    # 防重复登记本要给已有库补一列"办没办完"。
    # 线上 1.10.5 建的那批记录没有这一列，默认按"已办完"处理，不会卡住谁。
    if 'submit_guard' in tables:
        gcols = [r[1] for r in db.execute('PRAGMA table_info(submit_guard)')]
        if 'state' not in gcols:
            todo.append('ALTER TABLE submit_guard ADD COLUMN state INTEGER NOT NULL DEFAULT 1')
    if 'fire_photos' in tables:
        schema = db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='fire_photos'").fetchone()
        normalized = re.sub(r'\s+', '', (schema[0] or '').lower()) if schema else ''
        old_limit = 'check(width*height<=30000000)'
        new_limit = 'check(width*height<=%d)' % FIRE_SOURCE_MAX_PIXELS
        if old_limit in normalized and new_limit not in normalized:
            todo.append(REBUILD_FIRE_PHOTOS_FOR_PIXEL_LIMIT)
    return todo


def rebuild_fire_photos_for_pixel_limit(db):
    """重建消防照片表约束，保留全部行、ID、自引用与唯一约束。"""
    current = db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='fire_photos'").fetchone()
    normalized = re.sub(r'\s+', '', (current[0] or '').lower()) if current else ''
    if 'check(width*height<=%d)' % FIRE_SOURCE_MAX_PIXELS in normalized:
        return
    if 'check(width*height<=30000000)' not in normalized:
        raise RuntimeError('消防照片结构版本无法识别，已停止启动')
    old_name = 'fire_photos__pixel_upgrade_old'
    new_name = 'fire_photos__pixel_upgrade_new'
    if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (old_name,)).fetchone():
        raise RuntimeError('消防照片结构升级残留旧表，已停止启动')
    if db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (new_name,)).fetchone():
        raise RuntimeError('消防照片结构升级残留新表，已停止启动')
    try:
        db.execute('ALTER TABLE fire_photos RENAME TO ' + old_name)
        create_sql = NEW_TABLE_SQL['fire_photos'].replace(
            'CREATE TABLE IF NOT EXISTS fire_photos', 'CREATE TABLE ' + new_name, 1)
        db.execute(create_sql)
        old_cols = [r[1] for r in db.execute('PRAGMA table_info(' + old_name + ')')]
        new_cols = [r[1] for r in db.execute('PRAGMA table_info(' + new_name + ')')]
        if old_cols != new_cols:
            raise RuntimeError('消防照片结构升级列不一致，已停止启动')
        cols = ','.join('"' + col.replace('"', '""') + '"' for col in new_cols)
        db.execute('INSERT INTO ' + new_name + ' (' + cols + ') SELECT ' + cols + ' FROM ' + old_name)
        db.execute('DROP TABLE ' + old_name)
        db.execute('ALTER TABLE ' + new_name + ' RENAME TO fire_photos')
    except Exception:
        try:
            db.execute('DROP TABLE IF EXISTS ' + new_name)
        except sqlite3.Error:
            pass
        raise


def migrate():
    """老库补齐新列，保证升级后历史数据不丢。
    改结构前一定先自动备份：数据库一份一致性快照 + 整个 data/ 一份整目录留底；
    任何一份没做成，就一个字都不改。
    返回 True 表示正常，False 表示因为没能备份而放弃改动。"""
    db = sqlite3.connect(DB_PATH)
    todo = pending_schema_sql(db)
    db.close()
    if not todo:
        return True
    dst = backup_db_file('结构升级前')
    # 先拿数据库的一致性快照，再复制其余文件，并把快照放进那份目录里，
    # 保证这份备份里只有"一个"数据库，且和附件来自同一次备份（审计 S-05）。
    ddir = backup_data_dir('结构升级前', db_snapshot=dst) if dst else None
    if not dst or not ddir:
        print('!! 数据库需要升级，但自动备份没做成，已停止改动，数据保持原样。')
        print('!! 请手动把 data 整个目录复制一份留底后，再重新启动网站。')
        return False
    print('数据库结构需要升级，已先备份到：%s' % dst)
    print('同一时间点的整目录留底：%s' % ddir)
    db = sqlite3.connect(DB_PATH)
    # 多个 gunicorn worker 同时启动时只允许一个升级者改表；后到者重新看到新约束后直接跳过。
    db.execute('BEGIN IMMEDIATE')
    for sql in todo:
        try:
            if sql == REBUILD_FIRE_PHOTOS_FOR_PIXEL_LIMIT:
                rebuild_fire_photos_for_pixel_limit(db)
            else:
                db.execute(sql)
        except sqlite3.OperationalError as e:
            # 线上是 2 个 worker 一起起来的，可能抢着给同一张表补同一列。
            # 谁先谁赢；后来那句"列已存在"恰恰说明结构已经是对的，不算失败。
            msg = str(e).lower()
            if 'duplicate column' in msg or 'already exists' in msg:
                print('（跳过一句已经生效的结构改动：%s）' % msg)
                continue
            db.close()
            raise
    db.commit()
    db.close()
    return True


def _save_jpeg_fit(im, out_path, max_bytes, side, q0=82, progressive=False):
    """存成 JPG，并尽量压到不超过 max_bytes：先降画质，画质降到 60 还超就缩小尺寸再来。
    本来就不大的图一次就通过，不会被白白降质量。"""
    cur = im.copy()
    cur.thumbnail((side, side), Image.LANCZOS)
    q = q0
    while True:
        cur.save(out_path, 'JPEG', quality=q, optimize=True, progressive=progressive)
        if not max_bytes or os.path.getsize(out_path) <= max_bytes:
            return
        if q > 60:
            q -= 6
        elif side > 800:
            side = int(side * 0.8)
            cur = im.copy()
            cur.thumbnail((side, side), Image.LANCZOS)
            q = q0
        else:
            return


# 单张图片允许的最大像素数与字节数。
# 手机上拍一张证照约 1200 万像素、几 MB；这里给到约 5500×5500（3000 万像素）、
# 单文件 15MB，远超实际所需，只为挡住"体积不大但尺寸巨大"的图——
# 那种图解码时会同时占着好几份像素数据，能把服务拖垮（审计 S-09）。
MAX_IMAGE_PIXELS = 30 * 1000 * 1000
MAX_IMAGE_BYTES = 15 * 1024 * 1024

# 存进来的图一律再压一道，各模块用同一套档位，不再各写各的。
# 以前证照那一路没给体积上限，一张能有好几 MB，手机上打开要转半天圈。
# 原则是"够看就停"：证照要能看清上面的字，所以留得大一些；
# 酒单和仓库图只是让人认出是哪件东西，压得更狠。
CERT_WEB_MAX_SIDE = 1600          # 证照要能看清字，尺寸留大
CERT_WEB_MAX_BYTES = 400 * 1024   # 但体积封顶 400KB
INV_WEB_MAX_SIDE = 1400
INV_WEB_MAX_BYTES = 150 * 1024
THUMB_MAX_SIDE = 480              # 列表里的小图，统一这个尺寸


def make_web_and_thumb(src_path, ext, base, progressive=False,
                       max_side=1600, max_bytes=None, max_pixels=MAX_IMAGE_PIXELS):
    """生成网页用的压缩图和列表缩略图；非图片（PDF/Word 等）不处理。
    只做等比缩放，不裁剪原图内容。
    progressive=True 存成渐进式：手机上边下边显示，不用等整张图下完才出画面。
    max_bytes 给了就会自动往下压到这个体积以内（酒水单用它控流量）。
    中途失败会把这一轮已经生成的文件删掉，不留没有数据库记录的孤儿文件。"""
    if ext not in ('jpg', 'jpeg', 'png'):
        return None, None
    # 服务器上没装图片库时，绝不能悄悄返回"没有图"让调用方继续跑：
    # 数据库会被改成空、旧图随后被清掉，页面拿到空路径直接 500——图就这么没了。
    # 在这里硬失败，调用方会回滚，旧图原样留着（审计 M-06）。
    if not HAS_PIL:
        raise ValueError('服务器缺少图片处理组件，暂时传不了图片，请联系管理员处理')
    web_name = base + '_web.jpg'
    thumb_name = base + '_thumb.jpg'
    web_path = os.path.join(UPLOAD_DIR, web_name)
    thumb_path = os.path.join(UPLOAD_DIR, thumb_name)
    made = []
    try:
        from PIL import Image, ImageOps
        # 先按字节数挡一道：后面的处理会同时占着原图、旋转后的图、压缩中的图
        # 好几份像素数据，越大的图内存翻得越狠，能在开读之前就拒掉最省事。
        if os.path.getsize(src_path) > MAX_IMAGE_BYTES:
            raise ValueError('这张图片有 %d MB，太大了（最多 15MB），'
                             '请压缩后再上传' % (os.path.getsize(src_path) // 1024 // 1024))
        # Pillow 的默认 3000 万像素警告不等于消防的 6000 万安全上限；
        # 这里用显式面积检查决定是否接受，并只在消防放宽范围内忽略预期警告。
        with warnings.catch_warnings():
            if max_pixels > MAX_IMAGE_PIXELS:
                from PIL.Image import DecompressionBombWarning
                warnings.simplefilter('ignore', DecompressionBombWarning)
            im = Image.open(src_path)
            if im.width and im.height and im.width * im.height > max_pixels:
                raise ValueError('图片尺寸过大')
            im = ImageOps.exif_transpose(im)          # 修正手机拍照的方向
            if im.mode not in ('RGB',):
                im = im.convert('RGB')
            # 先登记、再动笔：这两个路径在真正开写之前就进清理清单。
            # 反过来的话（写完了才登记），万一写到一半硬盘满了、权限变了，
            # 磁盘上已经留下半个文件，清理名单里却没有它 —— 就成了没人认领的死文件，
            # 既不在数据库里也删不掉，天长日久白白占地方。
            made.append(web_path)
            _save_jpeg_fit(im, web_path, max_bytes, max_side, progressive=progressive)
            made.append(thumb_path)
            im.thumbnail((THUMB_MAX_SIDE, THUMB_MAX_SIDE), Image.LANCZOS)   # 列表小图，打开列表不卡
            im.save(thumb_path, 'JPEG', quality=75, optimize=True)
            return web_name, thumb_name
    except Exception:
        for p in made:                            # 只删这一轮自己经手的文件（含写了一半的）
            try:
                os.remove(p)
            except Exception:
                pass
        return None, None


def now():
    return datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')


# ---------- 入参校验 ----------
# 前端提交的是 JSON，里面什么类型都可能出现：手滑、脚本、或者改过的旧页面。
# 以前各接口直接拿过来就 .strip()，撞上数字或数组就抛 AttributeError，返回 500；
# 有的还会在报错前先提交一半，留下"有人没证"这类半截数据。
# 现在统一从这里过一道：不是字符串一律 400，顺手去掉控制字符并限长。
MAX_TEXT_LEN = 200


def clean_text(v, maxlen=MAX_TEXT_LEN):
    """整理成干净的字符串。不是字符串返回 None，由调用方决定是报错还是留空。"""
    if v is None:
        return ''
    if not isinstance(v, str):
        return None
    # 换行、退格这类控制字符进库不会报错，却会让导出的台账和日志错位，直接去掉
    s = ''.join(ch for ch in v.strip() if ch == ' ' or ch.isprintable())
    return s[:maxlen]


def text_in(data, key, label, required=False, maxlen=MAX_TEXT_LEN):
    """取一个文字字段，返回 (值, 错误提示)。有错误时值为 None。"""
    v = clean_text(data.get(key), maxlen)
    if v is None:
        return None, '%s格式不对，请重新输入' % label
    if required and not v:
        return None, '请填写%s' % label
    return v, None


def now_ms():
    """精确到毫秒的时间（写法和 now() 一样，可以直接比大小）。

    只用在"登录时刻"和"改密码时刻"这两个地方：如果只记到秒，同一秒内
    "先登录、后改密码"就分不出先后，改完密码那个还开着的浏览器不会被踢下线。
    记到毫秒，谁先谁后一目了然。
    """
    return datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]


def time_ago(seconds):
    """seconds 秒之前的时间，写法和 now() 一致，可以直接比大小"""
    return (datetime.datetime.now()
            - datetime.timedelta(seconds=seconds)).strftime('%Y-%m-%d %H:%M:%S')


def client_ip():
    """来访者 IP。网页前面是 nginx，真实 IP 由 ProxyFix 从它转发的头里还原好了，
    这里直接读就行。取不到就记 'unknown'，不让程序因为空值出错。"""
    return request.remote_addr or 'unknown'


def clear_initial_password_file():
    """密码已经改过了，就把记着初始密码的文件删掉，别把明文密码留在服务器上。

    返回 (是否已清掉, 说明)。以前删不掉就悄悄过去了，接口照样报成功——
    结果明文初始密码可能一直躺在服务器上，谁拿到备份谁就能直接登录（审计 S-03）。
    现在删不掉要留下痕迹：写一条日志、记一行待清理清单，下次启动还会再试一次。
    """
    if not os.path.exists(INIT_PWD_FILE):
        return True, None
    try:
        os.remove(INIT_PWD_FILE)
        _drop_pending_cleanup(INIT_PWD_FILE)
        return True, None
    except OSError as e:
        reason = '初始密码文件没能删掉：%s（%s）。请手动删除，别让明文密码留在服务器上。' % (
            INIT_PWD_FILE, e)
        _add_pending_cleanup(INIT_PWD_FILE, reason)   # 里面会顺手写一条日志
        return False, reason


def _pending_cleanup_path():
    return os.path.join(DATA_DIR, '待清理.txt')


def _add_pending_cleanup(path, reason):
    """把"该文件没能删掉"登记下来，运维打开 data/待清理.txt 一眼能看到。"""
    try:
        # 这里 commit=True：登记清理失败时数据库那边的活已经干完了（提交过或回滚过），
        # 不会再有后续操作带着这条日志一起提交，不主动提交的话它就被回滚没了。
        write_log('清理失败', 'file', None, reason, commit=True)
    except Exception:
        pass      # 写不了日志（比如在请求之外被调用）也不能耽误登记本身
    try:
        with open(_pending_cleanup_path(), 'a', encoding='utf-8') as f:
            f.write('%s | %s | %s\n' % (now(), path, reason))
    except OSError:
        pass


def _drop_pending_cleanup(path):
    """文件已经删掉了，就把待清理清单里关于它的记录去掉。"""
    p = _pending_cleanup_path()
    if not os.path.exists(p):
        return
    try:
        lines = [ln for ln in open(p, encoding='utf-8').read().splitlines()
                 if ln.strip() and (' | %s |' % path) not in ln]
        if lines:
            open(p, 'w', encoding='utf-8').writelines(ln + '\n' for ln in lines)
        else:
            os.remove(p)
    except OSError:
        pass


def retry_pending_cleanups():
    """启动时把以前没删掉的文件再试一次；删掉了就从清单里划掉。

    这样"上次没删成"不会变成永久遗留，也不需要人工去翻日志。
    """
    p = _pending_cleanup_path()
    if not os.path.exists(p):
        return
    for ln in list(open(p, encoding='utf-8').read().splitlines()):
        parts = [x.strip() for x in ln.split('|')]
        if len(parts) < 2:
            continue
        target = parts[1]
        if os.path.exists(target):
            try:
                os.remove(target)
            except OSError:
                continue
        _drop_pending_cleanup(target)


def write_log(action, target_type=None, target_id=None, detail=None, commit=False):
    """记一条操作日志。

    默认不提交——大多数接口写完日志后面还有别的数据库操作，一起提交才是一个整体。
    commit=True 只给"写完之后不会再有别的数据库操作"的场合用（比如已经提交过、
    正在做收尾清理），否则日志会随着连接关闭被一起回滚掉。
    """
    user = session.get('name') or session.get('username') or '系统'
    db = get_db()
    db.execute('INSERT INTO logs (user, action, target_type, target_id, detail, at)'
               ' VALUES (?,?,?,?,?,?)',
               (user, action, target_type, target_id, detail, now()))
    if commit:
        db.commit()


# ---------- 请求校验 ----------
def json_body():
    """取请求里的 JSON；不是合法 JSON 就返回 None，由调用方报 400，不让脏数据进数据库"""
    d = request.get_json(silent=True)
    return d if isinstance(d, dict) else None


# 证照只有两种归属：公司自己的证、某个员工的证
CERT_SCOPES = ['company', 'employee']
CERT_EDIT_FIELDS = ['scope', 'category', 'name', 'cert_type', 'cert_no', 'issuer', 'holder',
                    'keeper', 'employee_id', 'issue_date', 'expiry_mode', 'expiry_date',
                    'remind_days', 'paper_location', 'note']
EXPIRY_MODES = ('date', 'longterm', 'unknown')
CERT_FIELD_LABELS = {
    'scope': '归属', 'category': '分类', 'name': '资料名称', 'cert_type': '资料类型',
    'cert_no': '证号', 'issuer': '发证单位', 'holder': '持有人', 'keeper': '保管人',
    'employee_id': '关联员工', 'issue_date': '发证日期', 'expiry_mode': '有效期类型',
    'expiry_date': '到期日期', 'remind_days': '提前提醒天数',
    'paper_location': '纸质存放位置', 'note': '备注',
}


def clean_cert_fields(data, partial=True):
    """整理并校验证照字段。
    partial=True：只处理本次提交上来的字段，没提交的一律保持数据库里的原值（不会清空）。
    返回 (整理后的字段, 错误提示)；错误提示不为 None 时说明数据不合规。"""
    out = {}
    keys = [k for k in CERT_EDIT_FIELDS if k in data] if partial else list(CERT_EDIT_FIELDS)
    for k in keys:
        v = data.get(k)
        if k in ('issue_date', 'expiry_date'):
            v = (v or '').strip() if isinstance(v, str) else (v or None)
            if v:
                try:
                    datetime.date.fromisoformat(v)
                except (TypeError, ValueError):
                    return None, '日期格式不对：%s' % v
            else:
                v = None
        elif k == 'remind_days':
            try:
                v = int(v or DEFAULT_REMIND_DAYS)
            except (TypeError, ValueError):
                return None, '提前提醒天数必须是数字'
            if v < 0 or v > 3650:
                return None, '提前提醒天数要在 0 到 3650 天之间'
        elif k == 'scope':
            # 范围只能是"公司的证"或"员工的证"两种：以前传什么就存什么，
            # 存进一个看板不认的值，统计和筛选就会对不上（审计 S-10）
            v = (v or '').strip() if isinstance(v, str) else v
            if v not in CERT_SCOPES:
                return None, '证照范围只能是「公司」或「员工」'
        elif k == 'employee_id':
            if v in (None, '', 'null'):
                v = None
            else:
                try:
                    v = int(v)
                except (TypeError, ValueError):
                    return None, '关联的员工不对'
                # 编号必须真对应到一个还在用的员工。以前只转成整数就存了，
                # 结果可能出现"挂在某个已经删掉的人名下"的健康证，
                # 看板和员工表里都查不到它（审计 S-10）。
                ok = get_db().execute(
                    'SELECT id FROM employees WHERE id=? AND active=1', (v,)).fetchone()
                if not ok:
                    return None, '关联的员工不存在，或已经删掉了'
        elif k == 'category':
            v = (v or '').strip() if isinstance(v, str) else v
            if v and v not in CATEGORIES:
                return None, '分类不在可选范围内'
            v = v or '其他'
        elif k == 'expiry_mode':
            v = v or 'date'
            if v not in EXPIRY_MODES:
                return None, '有效期类型不对'
        elif isinstance(v, str):
            v = v.strip()
        out[k] = v
    return out, None


def clean_cert_edit(data, current):
    """部分修改先检查类型，再按最新资料合并校验，未提交字段保持原值。"""
    for key in CERT_EDIT_FIELDS:
        if key not in data:
            continue
        value = data[key]
        if key not in ('employee_id', 'remind_days') and value is not None and not isinstance(value, str):
            return None, '%s格式不对' % CERT_FIELD_LABELS[key]
        if key in ('employee_id', 'remind_days') and isinstance(value, (bool, list, dict)):
            return None, '%s必须是数字' % CERT_FIELD_LABELS[key]
    fields, err = clean_cert_fields(data, partial=True)
    if err:
        return None, err
    merged = {key: current[key] for key in CERT_EDIT_FIELDS}
    merged.update(fields)
    if not isinstance(merged['name'], str) or not merged['name'].strip():
        return None, '资料名称不能为空'
    _, err = clean_cert_fields(merged, partial=False)
    return (None, err) if err else (fields, None)


def cert_edit_request_dict(row, current):
    patch = json.loads(row['patch_json'])
    base = json.loads(row['base_json'])
    return {
        'id': row['id'], 'cert_id': row['cert_id'], 'status': row['status'],
        'by': row['submitted_by'], 'at': row['submitted_at'],
        'reviewed_by': row['reviewed_by'], 'reviewed_at': row['reviewed_at'],
        'reject_reason': row['reject_reason'],
        'changes': [{'field': key, 'label': CERT_FIELD_LABELS[key],
                     'before': base[key], 'current': current[key], 'after': value}
                    for key, value in patch.items()],
    }


def review_certificate_edit(rid, data):
    """在同一写事务内核对申请、原值和最新字段，防止旧申请覆盖新内容。"""
    db = get_db()
    if not _begin_write(db):
        return jsonify({'error': '资料正在处理，请稍后重试'}), 409
    try:
        row = db.execute('SELECT * FROM certificate_edit_requests WHERE id=?', (rid,)).fetchone()
        parent = db.execute('SELECT * FROM certificates WHERE id=? AND active=1',
                            (row['cert_id'],)).fetchone() if row else None
        if not row or not parent:
            db.rollback()
            abort(404)
        if row['status'] != 'pending':
            db.rollback()
            return jsonify({'error': '这项修改申请已处理，请刷新审核列表'}), 409
        if data['action'] == 'reject':
            reason, err = text_in(data, 'reason', '退回原因', maxlen=200)
            if err or not reason:
                db.rollback()
                return jsonify({'error': err or '请填写退回原因'}), 400
            db.execute("UPDATE certificate_edit_requests SET status='rejected', reject_reason=?,"
                       " reviewed_by=?, reviewed_at=? WHERE id=?",
                       (reason, _owner_tag(), now(), rid))
            write_log('退回资料修改', 'certificate', parent['id'],
                      '%s · 申请 #%d：%s' % (parent['name'], rid, reason))
        else:
            patch = json.loads(row['patch_json'])
            base = json.loads(row['base_json'])
            if not isinstance(patch, dict) or not patch or set(patch) != set(base) or any(k not in CERT_EDIT_FIELDS for k in patch):
                db.rollback()
                return jsonify({'error': '修改申请内容不完整，请退回后重新提交'}), 400
            changed = [CERT_FIELD_LABELS[k] for k in patch if parent[k] != base[k]]
            if changed:
                db.rollback()
                return jsonify({'error': '资料的%s已变更，原申请不能覆盖最新内容。请核对后退回并重新提交。'
                                        % '、'.join(changed)}), 409
            fields, err = clean_cert_edit(patch, parent)
            if err:
                db.rollback()
                return jsonify({'error': err}), 400
            db.execute('UPDATE certificates SET %s WHERE id=?' % ', '.join('%s=?' % k for k in fields),
                       list(fields.values()) + [parent['id']])
            db.execute("UPDATE certificate_edit_requests SET status='approved', reviewed_by=?,"
                       " reviewed_at=?, reject_reason=NULL WHERE id=?", (_owner_tag(), now(), rid))
            write_log('审核通过资料修改', 'certificate', parent['id'],
                      '%s · 申请 #%d · %s' % (parent['name'], rid,
                          json.dumps({'before': base, 'after': fields}, ensure_ascii=False)))
        db.commit()
    except (sqlite3.Error, ValueError, TypeError, KeyError) as exc:
        db.rollback()
        app.logger.warning('资料修改审核失败：%s', exc)
        return jsonify({'error': '修改申请审核失败，数据未改动，请刷新后重试'}), 400
    return jsonify({'ok': True})


_BOOT = {'done': False, 'ok': False, 'why': '启动检查还没跑完'}
# 开机这几件事只允许一个线程做。以前没有这把锁：同时进来两个人，
# 两个线程都看见"还没做"，于是一起动手——互相干扰之下容易有一边报错，
# 一旦报错就整个进程进入维护状态，谁也用不了（本机多线程、以及将来换多线程
# 部署时都会踩）。现在后来者排队等，等前人做完了直接接着办事。
_BOOT_LOCK = threading.Lock()


@app.before_request
def boot_once():
    """每个进程收到第一个请求时，把"开机该做的事"做掉。

    ⚠️ 这里必须先说清楚为什么不能只写在文件末尾的 __main__ 里：
    线上是用 gunicorn 拉起来的（`app:app`），那是"把 app 当模块导入"，
    文件末尾的 `if __name__ == '__main__'` 那段**根本不会执行**。
    结果就是：本机直跑一切正常，一上线，数据库初始化、结构升级、
    历史数据整理全都悄悄没做——2026-10-02 就是这么发现线上 32 条证照
    还停在旧状态的。

    放在第一次请求里做，还有两个好处：
    1. 每个进程只做一次，多 worker 也不会重复干重活；
    2. 测试里先把数据目录改好再发请求，不会误伤真实数据。

    这里最关键的一点是"失败了要一直失败"：
    以前只在出错那一次返回维护页，_BOOT.done 已经打上，第二个请求就直接放行，
    于是一个没备份成功、也没升级成功的库照样被人读改写。那比停机还危险。
    所以现在：只要没跑通，每一个后续请求都返回 503，直到重启。
    """
    # 注意：先拿锁、再看标记。不然开机那几十毫秒里进来的其它请求会看到
    # "已经开始了但还没成功"，于是被当成维护状态挡回去——自己白挨一刀。
    with _BOOT_LOCK:
        # 排队等到自己之后再确认一遍：前面那位可能已经把活干完了
        if not _BOOT['done']:
            _BOOT['done'] = True
            _BOOT['ok'] = False          # 先记"没准备好"，跑通了才翻过来
            _BOOT['ok'] = _do_boot()
            if _BOOT['ok']:
                _BOOT['why'] = '启动检查还没跑完'
    if not _BOOT['ok']:
        return jsonify({'error': '系统正在维护：%s，请联系管理员' % _BOOT['why']}), 503
    return None


def _do_boot():
    """真正去做开机这几件事，成了返回 True、没成返回 False。
    没成的时候必须往 _BOOT['why'] 里写一句人看得懂的原因，
    页面上那句"系统正在维护"要跟在一起显示，别让人对着一句空话猜。"""
    try:
        init_db()
    except SystemExit as e:
        print('!! 数据库初始化没通过：%s' % e)
        _BOOT['why'] = '数据库没能准备好'
        return False
    try:
        if not migrate():
            _BOOT['why'] = '数据库需要升级但没成功'
            return False
    except SystemExit as e:
        print('!! 结构升级没通过：%s' % e)
        _BOOT['why'] = '数据库结构升级没成功'
        return False
    # 历史整理以前被当成"失败也无妨"的小事，结果失败时没人知道，下次重试
    # 又会把故障后新提交的资料一并批成通过（审计 10/03 M-03）。
    # 现在它的成败按硬指标算：做不成就不放行业务。
    for step in (one_off_migrations, oneoff_fix_draft_items):
        try:
            if not step():
                _BOOT['why'] = '历史数据整理没做成'
                return False
        except Exception as e:
            print('（启动整理 %s 出错：%s）' % (step.__name__, e))
            _BOOT['why'] = '历史数据整理出错'
            return False
    # 这几件是收尾的小事，失败也不该影响网站能用
    for step in (retry_pending_cleanups, backfill_missing_thumbs):
        try:
            step()
        except Exception as e:
            print('（启动收尾任务 %s 出错：%s）' % (step.__name__, e))
    return True


@app.before_request
def idle_logout():
    """多久没动就自动登出。

    手机上"关掉网页"往往只是切到后台，浏览器并没有真关，登录票就一直有效。
    所以除了"关浏览器失效"，再加一道时间闸门：超过 IDLE_MINUTES 分钟没有任何操作，
    就把登录状态清掉，下次必须重新输密码。
    """
    if request.path.startswith('/static/') or request.path == '/favicon.ico':
        return
    last = session.get('last_seen')
    if last:
        try:
            gap = (datetime.datetime.now()
                   - datetime.datetime.strptime(last, '%Y-%m-%d %H:%M:%S')).total_seconds()
            if gap > IDLE_MINUTES * 60:
                session.clear()
                return
        except Exception:
            pass
    if session.get('uid'):
        # 每次操作都刷新一下时间，只有真的闲置才会被踢
        session['last_seen'] = now()
        session.permanent = False


@app.before_request
def guard_request():
    """挡住别的网站偷偷发来的操作请求：写操作必须带只有本站页面才会加的头，
    而且来源地址必须是本站。登录接口例外（那时候还没有登录身份）。"""
    if request.method in ('GET', 'HEAD', 'OPTIONS'):
        return
    if not request.path.startswith('/api/') or request.path == '/api/login':
        return
    if request.headers.get('X-Requested-With') != 'lexiu':
        return jsonify({'error': '请求校验失败，请刷新页面后重试'}), 403
    # 来源是"必须有"，不能因为没有就放行：浏览器发写请求时一定会带上它，
    # 缺了多半是别的程序在直接调接口。真有需要的内部调用另外单独确认，不在这里开口子。
    origin = request.headers.get('Origin')
    if not origin:
        return jsonify({'error': '请求校验失败，请刷新页面后重试'}), 403
    ohost = origin.split('://', 1)[-1].split('/')[0].lower()
    if ohost != (request.host or '').lower():
        return jsonify({'error': '请求来源不对，已拒绝'}), 403
    # 只跟 request.host 比还不够：那个值是浏览器想填什么就填什么的。
    # 万一前面的网关放行了别的域名，两边一起被伪造就绕过去了。
    # 所以再加一道：域名必须落在"我们认的名单"里（审计 S-02）。
    if ohost.split(':', 1)[0] not in _trusted_hosts():
        return jsonify({'error': '请求来源不对，已拒绝'}), 403
    # 最后一关：防重复提交。同一个人、同一个接口、同样的内容，
    # 没过多久又来一次，只认第一次——手抖连点、网络慢重试、两台设备一起点都算。
    r = reject_repeat_submit()
    if r:
        return r
    return


# ---------- 统一防重复提交 ----------
# 页面上把按钮锁住，只能管住"同一个页面连点两下"这一种情况：
# 网络慢的时候按钮看着像没反应、手机和电脑同时点、或者干脆绕开页面直接发请求，
# 前端那层都拦不住，结果就是一份资料存两份、两张一样的图都进了待审核。
# 所以在服务器再放一层：谁、在哪个接口、提交了什么，记一笔；
# 同样的提交在很短时间内再来，直接挡回去。
# 放在这里的好处是"新加的模块自动就有"，不用每个按钮再写一遍。
SUBMIT_GUARD_SECONDS = 6
# 打印校验只读，每次都须核验当前快照，不参加业务提交去重。
SUBMIT_GUARD_SKIP = ('/api/login', '/api/logout', '/api/fire/print-check')
# 一条登记如果"正在办"的时间超过这个数（5 分钟），就认为负责它的 worker 已经没了，
# 自动放行，免得一次崩溃把某个操作永久锁死。
SUBMIT_STUCK_MS = 5 * 60 * 1000


def epoch_ms():
    """当前时间的毫秒数（整数，可以直接比大小）。"""
    return int(datetime.datetime.now().timestamp() * 1000)


def _submit_fingerprint():
    """把一次提交压成一串指纹：谁 + 哪个接口 + 提交了什么。
    返回 None 表示这次算不出指纹（比如上传的文件读不了），那就别拦，正常走业务。"""
    who = session.get('username') or session.get('name') or ('uid:%s' % session.get('uid'))
    try:
        if request.is_json:
            raw = request.get_data(as_text=True) or ''
            sig = hashlib.sha256(raw.encode('utf-8', 'replace')).hexdigest()[:24]
        else:
            parts = []
            for k in sorted(request.form.keys()):
                parts.append('%s=%s' % (k, (request.form.get(k) or '')[:200]))
            for k in sorted(request.files.keys()):
                f = request.files.get(k)
                data = f.read()
                # 读过必须倒回去，不然后面存下来的是空文件
                f.seek(0)
                parts.append('%s|%s|%s|%s' % (k, f.filename, len(data),
                                              hashlib.md5(data).hexdigest()[:16]))
            sig = hashlib.sha256('&'.join(parts).encode('utf-8', 'replace')).hexdigest()[:24]
    except Exception as e:
        print('（算不出提交指纹，本次不拦：%s）' % e)
        return None
    raw = '%s|%s|%s' % (who, request.path, sig)
    return hashlib.sha256(raw.encode('utf-8', 'replace')).hexdigest()[:32]


def reject_repeat_submit():
    """写请求进来先过这一关。挡住了返回 (响应, 状态码)，没挡住返回 None。

    ⚠️ 判定必须在数据库里一次做完，不能"先查有没有、再决定插不插"：
    两台设备同时点、或者第二个请求趁着第一个还在传大图的时候进来，
    分开的两步中间隔着时间差，两个请求都会查到"没有"，然后都放行——
    照样存两份（审计 M-02）。所以这里用 BEGIN IMMEDIATE 把"看"和"占"锁在一起。

    登记分成两种状态：
      0 = 正在办（还没办完）：一律挡回去，不看 6 秒窗口；
         万一 worker 崩了留下没清的记录，超过 5 分钟就当没人管了，自动放行。
      1 = 办完了：6 秒内的重复才挡（防止手抖再来一次）。
    """
    if not request.path.startswith('/api/') or request.path in SUBMIT_GUARD_SKIP:
        return None
    fp = _submit_fingerprint()
    if not fp:
        return None
    ms = epoch_ms()
    db = get_db()
    try:
        try:
            db.execute('BEGIN IMMEDIATE')
        except Exception:
            try:
                db.execute('ROLLBACK')
            except Exception:
                pass
            db.execute('BEGIN IMMEDIATE')
        row = db.execute('SELECT at, state FROM submit_guard WHERE fp=?', (fp,)).fetchone()
        blocked = False
        if row:
            try:
                old = int(row['at'])
            except Exception:
                old = 0
            try:
                state = int(row['state'])
            except Exception:
                state = 1
            age = ms - old
            if state == 0:
                blocked = age < SUBMIT_STUCK_MS          # 还在办，或者卡死了太久
            else:
                blocked = age < SUBMIT_GUARD_SECONDS * 1000
            if blocked:
                db.execute('ROLLBACK')
                return jsonify({'error': '刚才已经提交过了，请不要重复点击'}), 409
        db.execute('INSERT OR REPLACE INTO submit_guard (fp, who, path, at, state)'
                   ' VALUES (?,?,?,?,0)',
                   (fp, session.get('username') or '', request.path, str(ms)))
        # 顺手清掉一小时前的旧记录：这张表只记"刚刚"的事
        db.execute('DELETE FROM submit_guard WHERE at < ?', (str(ms - 3600 * 1000),))
        db.commit()
    except Exception as e:
        # 登记失败最多是这次没挡住，不能反过来让正常业务做不了
        try:
            db.execute('ROLLBACK')
        except Exception:
            pass
        print('（防重复提交登记失败，本次不拦：%s）' % e)
        return None
    g.submit_fp = fp
    return None


def _sweep_open_business_tx():
    """响应要发出去了，业务那条连接要是还挂着一桩没结束的事，先把它撤回来。

    为什么必须抢在这一步做：业务干到一半出错时（比如写台账那一步报错），
    那条连接上的写事务还没结束，写锁也就还攥在它手里。接着 after_request
    里那条"单独连接"想去撤掉防重复提交的登记，就会被这把锁挡住——
    默认要等到 5 秒超时，异常还被吞了，登记就留在"正在办"的状态。
    结果用户明明看到报错、想立刻改一下重来，却被"刚才已经提交过了"挡住，
    最长得等 5 分钟才自动放行（审计 10/03 全站验收 S-07）。

    先把这桩没结束的事收了尾，锁当场就松了，后面的清理顺顺当当能做完。
    走到这里（响应已经生成完）还开着事务，只可能是"该提交/该撤回却没做"，
    所以一律撤回：留着它既是一把锁，也是一批没人认账的半成品。
    """
    try:
        db = g.get('db')
        if db is not None and db.in_transaction:
            db.rollback()
    except Exception:
        pass


@app.after_request
def touch_submit_guard(resp):
    """一次提交办完了，把"上次提交时间"改到这一刻。

    这样 6 秒的窗口是按"上次办完之后"算的：传一张大图要五六秒，
    期间和刚结束那会儿的连点都还在保护里。

    没办成的（填错了、东西还没审）要把登记撤掉：那种情况人家本来就该马上重试，
    占着位置只会让人以为网站坏了——比如"入库被拒 → 等管理员审过 → 再入库"，
    两次请求长得一模一样，撤掉才能立刻重来。

    办成了就标记成"办完了"，6 秒窗口从这一刻才开始算。"""
    fp = getattr(g, 'submit_fp', None)
    if not fp:
        return resp
    # 第一件事：把业务那条连接上没收尾的事结束掉，先把写锁松开。
    # 不然下面这条单独连接会被它堵住整整 5 秒，慢不说，最后还可能一句异常
    # 悄悄跳过，把"正在办"的登记留在库里挡着用户重试（审计 S-07）。
    _sweep_open_business_tx()
    try:
        # 这条记录是防重复自己的小账本，**一定要单独开一条连接**去写：
        # 业务那边的活儿可能刚干了一半就出错（还没提交），这里要是顺手用业务那条连接
        # 去 commit，等于把没干完的半成品一块儿提交入库——页面明明报了错，
        # 库里却多出一个人、还记着"新增成功"（审计 10/03 第二轮 M-01）。
        db = sqlite3.connect(DB_PATH)
        try:
            # 别人正正经经也在写的时候，宁可等一小会儿也不要硬报错，
            # 但不能像默认那样干等 5 秒——那 5 秒全压在用户这一下点击上。
            db.execute('PRAGMA busy_timeout = 1500')
            if 200 <= resp.status_code < 300:
                db.execute('UPDATE submit_guard SET at=?, state=1 WHERE fp=?',
                           (str(epoch_ms()), fp))
            else:
                db.execute('DELETE FROM submit_guard WHERE fp=?', (fp,))
            db.commit()
        finally:
            db.close()
    except Exception as e:
        # 以前这里的异常被一句 pass 咽了，出问题连句话都看不到
        print('（防重复提交的收尾没做成：%s）' % e)
    return resp


@app.after_request
def add_security_headers(resp):
    """统一补上浏览器安全基线；不改变现有内联脚本策略。"""
    resp.headers.setdefault('X-Content-Type-Options', 'nosniff')
    # /preview 是本机验收用的同源手机/平板外框：首页会被它的 iframe 加载。
    # 预览打开后会带一个短时本地标记，确保 iframe 内继续跳转到消防档案、打印预览等页面时，
    # 仍能保持同源嵌入；服务器模式不开放 /preview，其它普通请求仍保持 DENY。
    preview_embed = SHOW_PREVIEW and (
        request.args.get('preview_frame') == '1' or
        request.cookies.get('lexiu_preview_mode') == '1')
    if preview_embed:
        resp.headers.setdefault('X-Frame-Options', 'SAMEORIGIN')
    else:
        resp.headers.setdefault('X-Frame-Options', 'DENY')
    resp.headers.setdefault('Referrer-Policy', 'strict-origin-when-cross-origin')
    resp.headers.setdefault('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()')
    return resp


# ---------- 权限 ----------
def current_user():
    uid = session.get('uid')
    if not uid:
        return None
    u = get_db().execute('SELECT * FROM users WHERE id=? AND active=1', (uid,)).fetchone()
    if not u:
        return None
    # 改过密码之后，其它还开着的浏览器一律要求重新登录
    changed = u['pwd_changed_at'] if 'pwd_changed_at' in u.keys() else None
    login_at = session.get('login_at')
    if changed and (not login_at or str(login_at) < str(changed)):
        session.clear()
        return None
    return u


def _db_role():
    """当前登录人的角色，每次都从数据库读。

    以前有的地方图省事读 session 里那份（登录时存下来的）。管理员被降成
    普通员工之后，那个还开着的浏览器里 session 仍是 admin，于是还能自动
    审核附件、还能看到没遮挡的手机号——同一件事两套标准（审计 S-08）。
    """
    u = current_user()
    return u['role'] if u else None


def _me_name():
    """当前登录人的姓名（库里的为准，用来判断"是不是我提交的"）。"""
    u = current_user()
    return (u['name'] if u else None) or session.get('name') or ''


def _owner_tag():
    """记录"这是谁提交的"时，往库里写什么。

    以前写的是姓名。姓名不唯一，店里有两个同名的人（或两个同名账号）时，
    系统分不清是谁交的，于是互相能看到对方还没审过的东西（审计 M-06）。
    账号是唯一的，所以从这里开始一律记**账号**；姓名只用来显示。

    老数据里写的还是姓名，判断归属时两边都认（见 review_filter），
    不会让人一升级就看不到自己以前录的东西。
    """
    return session.get('username') or session.get('name') or '系统'


def owned_by_me(val):
    """这条记录是不是"我"提交的。列表、详情、附件、下载全都走这一处，
    口径必须完全一致——各写一套必然漏（审计 M-05 / 第二轮 M-02）。

    认领只有两步，顺序不能颠倒：
      1. **先只认账号**：现在新增的记录一律写账号（见 _owner_tag），账号天生唯一。
      2. **确认这个值不是任何人的登录名之后**，才允许按姓名兜底（照顾很早以前的老数据）。

    为什么不许"账号也认、姓名也认"混着来？举个真实例子：我的账号叫 alpha_account，
    另一个同事把自己的**姓名**改成了 alpha_account。混着认的话，他那套账就能对我的号，
    于是我刚交上来还没审的东西他能看见（审计 10/03 第二轮 M-03 实测复现）。
    第二步那个"是不是别人的登录名"的判断，就是专门堵这个口子的。
    """
    if not val:
        return False
    acct = _my_account()
    if acct and val == acct:
        return True
    if val in _account_names():
        return False          # 是某个账号的登录名 —— 绝不能当成我的姓名来认
    name = _me_name()
    return bool(name) and val == name


def owned_by_me_sql(col, tag):
    """给列表查询用的同一套规矩（SQL 版本），参数名不能和 approved 那些重。"""
    if _my_account() and tag == 'acct':
        return '%s=?' % col, [_my_account()]
    return ('%s=? AND %s NOT IN (SELECT username FROM users'
            ' WHERE username IS NOT NULL)' % (col, col), [_me_name()])


def _account_names():
    """库里所有正在用的登录名。一次取齐放在这次请求里反复用，不多查库。"""
    if 'acct_names' not in g:
        try:
            g.acct_names = set(r[0] for r in get_db().execute(
                'SELECT username FROM users WHERE username IS NOT NULL'))
        except Exception:
            g.acct_names = set()
    return g.acct_names


def _my_account():
    """当前登录人的账号（新提交的记录记的就是它）。"""
    return session.get('username') or ''


def _void_sessions(db, uid):
    """把这个账号身上所有还开着的页面统统踢下线。

    为什么删号以后还要多做这一步？因为这里的删除只是"停用"，账号那一行
    还在库里、id 也没变。以后用同一个账号名重新建（员工离职又回来最常见），
    系统会直接接着用原来那一行，id 一模一样。这时候别人电脑上那个早就被删掉的
    旧页面手里的 Cookie，就摇身变成新账号的通行证：以前那个是普通员工，
    重建时要是给了管理员，旧页面一刷新就成了管理员
    （审计 10/02 M-01 实测：/api/me、/api/users、/api/reviews 全是 200）。

    做法是更新 pwd_changed_at——那个时间比这一刻的登录更早的，一律要求重新登录。
    所以只要在"账号的身份有可能换人"的每一处都调一下它，旧 Cookie 就永远作废。
    """
    db.execute('UPDATE users SET pwd_changed_at=? WHERE id=?', (now_ms(), uid))


def review_filter(col_status, col_owner, prefix=' AND '):
    """列表查询里"这一条该不该给你看"的条件。

    规矩就一条：**审过的一起看，没审的只给管理员和提交人自己看**。
    以前不管审没审都往列表里塞，谁都能看到刚交上来、还没核实的资料。

    判断"是不是我交的"：**一律先按账号认**（owned_by_me）。
    只有确定记录的不是任何人的登录名时，才按姓名兜底认领老数据——
    否则别人把姓名改成我的账号名，就能看到我还没审的东西。

    返回 (SQL 片段, 参数)，管理员返回空条件——他要审这些东西，得看得见。
    """
    if _db_role() == 'admin':
        return '', []
    parts, args = [], []
    if _my_account():
        parts.append('%s=?' % col_owner)
        args.append(_my_account())
    if _me_name():
        # 同上第二步：只在记的不是任何人的登录名时，才拿姓名比对
        parts.append('(%s=? AND %s NOT IN (SELECT username FROM users'
                     ' WHERE username IS NOT NULL))' % (col_owner, col_owner))
        args.append(_me_name())
    owner = ' OR '.join(parts) if parts else '1=0'
    # history 要算在"大家都能看"的这一边：它是当年审过、后来换版才退下来的旧附件，
    # 性质跟 approved 一样，跟 pending/rejected 完全不同（见 can_see_cert 的说明）。
    return ("%s(%s IN ('approved','history') OR (%s IN ('pending','rejected') AND (%s)))"
            % (prefix, col_status, col_status, owner), args)


def can_see_cert(c, v=None):
    """一份资料（连同它的某个附件）当前这个人能不能看。

    规矩跟列表一模一样：审过的大家看，没审的只给管理员和提交人；
    附件再单独判一次——被退回的附件就算挂在已通过的资料下也不往外发。
    列表、详情、下载这几个口子必须用一个口径，只拦住列表等于没拦（审计 M-05）。
    """
    if _db_role() == 'admin':
        return True
    status = (c['flow_status'] if 'flow_status' in c.keys() else None) or ''
    if status != 'approved':
        owner = c['created_by'] if 'created_by' in c.keys() else None
        if status not in ('pending', 'rejected') or not owned_by_me(owner):
            return False
    if v is not None:
        vst = (v['status'] if 'status' in v.keys() else '') or ''
        if vst == 'rejected':
            return False
        if vst in ('approved', 'history'):
            # history = 换过版、但当时是审过的旧附件。它跟"没审过"是两码事：
            # 以前一换版，旧图在员工那儿就从"能查"变成 404，等于历史资料凭空消失，
            # 换了谁经手都查不到从前交的是什么（审计 10/03 S-05）。
            # 现在按北於的意思：只要曾经审过，大家就能一直看能下载。
            return True
        # 附件要再单独判一次：**父资料通过不代表新挂上来的附件也通过**。
        # 以前只看父资料的脸面，于是别人往一份老资料里传的新附件，
        # 只要猜到文件名就能直接下载（审计 10/03 第二轮 M-02 实测三个地址全 200）。
        vowner = v['uploaded_by'] if 'uploaded_by' in v.keys() else None
        if vst != 'pending' or not owned_by_me(vowner):
            return False
    return True


def can_see_item(it):
    """仓库物品能不能看：审核状态和"是不是我录的"一起判。"""
    if _db_role() == 'admin':
        return True
    st = (it['status'] if 'status' in it.keys() else '') or 'approved'
    if st == 'approved':
        return True
    owner = it['created_by'] if 'created_by' in it.keys() else None
    return st in ('pending', 'rejected') and owned_by_me(owner)


def can_see_inventory_image(it, version):
    """父物品和图片版本必须同时可见；退回图只有管理员能打开。"""
    if not it or not it['active'] or not can_see_item(it):
        return False
    if _db_role() == 'admin':
        return True
    if version['status'] in ('approved', 'history'):
        return True
    return version['status'] == 'pending' and owned_by_me(version['uploaded_by'])


def can_see_asset(a):
    """这件资产这个人能不能看。口径跟列表完全一致（列表用的是 review_filter）：
    审过的大家看，没审的只给管理员和提交人。

    以前只有列表守规矩，流水那条路（/api/assets/<id>/logs）只认编号不看人，
    于是列表里根本看不见的东西，它的持有人、备注却能从流水里读出来
    （审计 10/03 第二轮 M-02）。现在两处共用这一把尺子。
    """
    if _db_role() == 'admin':
        return True
    st = (a['review_status'] if 'review_status' in a.keys() else '') or ''
    if st == 'approved':
        return True
    owner = a['created_by'] if 'created_by' in a.keys() else None
    return st in ('pending', 'rejected') and owned_by_me(owner)


def can_review():
    """能不能审核（只有管理员能点头）。"""
    return _db_role() == 'admin'


def login_required(f):
    @wraps(f)
    def wrapper(*a, **kw):
        if not current_user():
            return jsonify({'error': '请先登录'}), 401
        return f(*a, **kw)
    return wrapper


def admin_required(f):
    @wraps(f)
    def wrapper(*a, **kw):
        u = current_user()
        if not u:
            return jsonify({'error': '请先登录'}), 401
        if u['role'] != 'admin':
            return jsonify({'error': '没有权限'}), 403
        return f(*a, **kw)
    return wrapper


# ---------- 到期计算 ----------
def expiry_info(row):
    mode = row['expiry_mode'] if 'expiry_mode' in row.keys() else 'date'
    if mode == 'longterm':
        return {'level': 'longterm', 'label': '长期有效', 'days': None}
    d = row['expiry_date'] if 'expiry_date' in row.keys() else None
    if mode == 'unknown' or not d:
        return {'level': 'unknown', 'label': '有效期待确认', 'days': None}
    try:
        exp = datetime.date.fromisoformat(d)
    except ValueError:
        return {'level': 'unknown', 'label': '有效期待确认', 'days': None}
    days = (exp - TODAY()).days
    if days < 0:
        return {'level': 'expired', 'label': '已过期 %d 天' % (-days), 'days': days}
    if days == 0:
        return {'level': 'expired', 'label': '今天到期', 'days': 0}
    for limit, level, label in EXPIRY_LEVELS:
        if level == 'expired':
            continue
        if days <= limit:
            return {'level': level, 'label': label, 'days': days}
    return {'level': 'ok', 'label': '正常有效', 'days': days}


def _version_urls(cv):
    """给一个附件版本算出它到底能给出哪些"点得开的链接"。

    一个口径管三处（详情大图、版本表、文件下载），以前各算各的：
    详情已经学会"被退回就不给预览"，版本表却照旧拼一个 /files/xxx 的链接，
    于是页面上边写着"这张图不能看"，右边还挂着一个点开必 404 的下载
    （审计 10/03 全站验收 S-06）。

    这里的判断跟下载入口 can_see_cert 保持一致：退回的只给管理员，
    待审的只给本人和管理员，审过的和历史上审过的大家都能看。
    """
    st = (cv.get('status') or '')
    openable = True
    if st == 'rejected':
        openable = _db_role() == 'admin'
    elif st == 'pending':
        openable = _db_role() == 'admin' or owned_by_me(cv.get('uploaded_by'))
    cv['openable'] = openable
    cv['thumb_url'] = ('/files/' + cv['thumb_name']) if (openable and cv.get('thumb_name')) else None
    cv['web_url'] = ('/files/' + cv['web_name']) if (openable and cv.get('web_name')) else None
    # 原图下载也要同口径：打不开的版本连"下载原图"的链接都不给
    cv['raw_url'] = ('/files/' + cv['stored_name']) if (openable and cv.get('stored_name')) else None
    cv['is_image'] = bool(cv.get('web_name'))
    return cv


def cert_row_to_dict(row, with_versions=False, db=None):
    d = dict(row)
    d['expiry'] = expiry_info(row)
    v = None
    if db:
        # 附件也按审核状态筛：审过的优先，没审的只有管理员和上传者本人看得到。
        # 以前这里"找不到审过的就退回显示最新一张"，等于没审的图谁都能看。
        cond, vargs = review_filter('status', 'uploaded_by', prefix=' AND ')
        v = db.execute('SELECT * FROM versions WHERE cert_id=?%s'
                       ' ORDER BY (status="approved") DESC, version_no DESC LIMIT 1'
                       % cond, [row['id']] + vargs).fetchone()
    d['current_version'] = (_version_urls(dict(v)) if v else None)
    if with_versions and db:
        cond, vargs = review_filter('status', 'uploaded_by', prefix=' AND ')
        d['versions'] = [_version_urls(dict(x)) for x in db.execute(
            'SELECT * FROM versions WHERE cert_id=?%s'
            ' ORDER BY version_no DESC' % cond, [row['id']] + vargs)]
    return d


# ---------- 页面 ----------
@app.route('/favicon.ico')
def favicon():
    """浏览器默认会来根路径要图标，指到静态文件，免得控制台报 404。"""
    return send_from_directory(
        os.path.join(os.path.dirname(os.path.abspath(__file__)), 'static'),
        'favicon.ico', mimetype='image/vnd.microsoft.icon')


@app.route('/')
def index():
    if not current_user():
        return render_template('login.html', v=VERSION)
    return render_template('index.html', v=VERSION, show_preview=SHOW_PREVIEW)


@app.route('/preview')
def preview():
    """多尺寸预览：在同一页面里切换手机 / 平板 / 电脑，方便不用真机也能看效果。
    这是本机自测用的辅助页，正式版（服务器）不开放。"""
    if not SHOW_PREVIEW:
        return redirect(url_for('index'))
    if not current_user():
        return redirect(url_for('index'))
    resp = make_response(render_template('preview.html', v=VERSION))
    # 只用于本机预览 iframe 的同源页面跳转，关闭浏览器后自然失效。
    resp.set_cookie('lexiu_preview_mode', '1', httponly=True, samesite='Lax')
    return resp


@app.route('/mobile-prototype')
def mobile_prototype():
    """三套手机版可点击原型，仅本机直跑时开放，不连接生产数据。"""
    if not SHOW_PREVIEW:
        return redirect(url_for('index'))
    return send_from_directory(
        os.path.join(BASE_DIR, 'docs', 'mobile_ui_prototype'),
        'index.html',
        mimetype='text/html')


# ---------- 登录 ----------
@app.route('/api/login', methods=['POST'])
def api_login():
    data = json_body()
    if data is None:
        return jsonify({'error': '提交的数据格式不对，请刷新页面重试'}), 400
    # 先卡住格式和长度：这个口子谁都能敲，不能让超长或乱七八糟的内容
    # 直接进数据库查询和登录失败记录里。
    username = data.get('username')
    password = data.get('password')
    if not isinstance(username, str) or not isinstance(password, str):
        return jsonify({'error': '账号或密码格式不对'}), 400
    username = username.strip()
    if (not username or len(username) > 64
            or not password or len(password) > 256):
        return jsonify({'error': '账号或密码长度不对'}), 400
    db = get_db()
    ip = client_ip()
    # 计数与落盘在同一写事务里，两个 worker 不会同时放过第 5 次失败。
    if not _begin_write(db):
        return jsonify({'error': '登录正在处理，请稍后重试'}), 409
    stamp = now_ms()
    current = datetime.datetime.fromisoformat(stamp)
    cutoff = (current - datetime.timedelta(minutes=ACCOUNT_LOCK_MINUTES)).isoformat(' ', timespec='milliseconds')
    ip_cutoff = (current - datetime.timedelta(seconds=IP_RATE_WINDOW)).isoformat(' ', timespec='milliseconds')
    db.execute('DELETE FROM login_guard WHERE at <= ?', (cutoff,))
    u = db.execute('SELECT * FROM users WHERE username=? AND active=1', (username,)).fetchone()
    locked = db.execute('SELECT MAX(at) FROM login_guard WHERE username=? AND ip=?',
                        (username, LOGIN_ACCOUNT_LOCK_IP)).fetchone()[0]
    fails, last_fail = db.execute('SELECT COUNT(*), MAX(at) FROM login_guard '
                                 'WHERE username=? AND ip<>? AND at>?',
                                 (username, LOGIN_ACCOUNT_LOCK_IP, cutoff)).fetchone()
    if u and (locked or fails >= LOGIN_FAIL_LIMIT):
        # 兼容升级前已有的失败记录，不必迁移表或清掉旧 IP 记录。
        if not locked:
            locked = last_fail
            db.execute('INSERT INTO login_guard (ip, username, at) VALUES (?,?,?)',
                       (LOGIN_ACCOUNT_LOCK_IP, username, locked))
        until = datetime.datetime.fromisoformat(locked) + datetime.timedelta(minutes=ACCOUNT_LOCK_MINUTES)
        minutes = max(1, int(((until - current).total_seconds() + 59) // 60))
        db.commit()
        return jsonify({'error': '账号登录暂受限制，请 %s后再试' % lock_hint(minutes)}), 429
    ip_count = db.execute('SELECT COUNT(*) FROM login_guard WHERE ip=? AND at>?',
                          (ip, ip_cutoff)).fetchone()[0]
    if not u or not check_password_hash(u['password_hash'], password):
        # 北於选择 3B：必须先验证密码，限流不挡正确凭据；未知账号统一错误。
        if ip_count >= IP_RATE_LIMIT:
            db.commit()
            return jsonify({'error': '操作太频繁，请稍后再试'}), 429
        db.execute('INSERT INTO login_guard (ip, username, at) VALUES (?,?,?)',
                   (ip, username if u else None, stamp))
        account_locked = bool(u and fails + 1 >= LOGIN_FAIL_LIMIT)
        if account_locked:
            db.execute('INSERT INTO login_guard (ip, username, at) VALUES (?,?,?)',
                       (LOGIN_ACCOUNT_LOCK_IP, username, stamp))
        write_log('登录失败', 'user', None, '%s（IP %s）' % (username, ip))
        get_db().commit()
        left = LOGIN_FAIL_LIMIT - (fails + 1)
        if account_locked:
            return jsonify({'error': '账号登录暂受限制，请 %s后再试' % lock_hint()}), 429
        if ip_count + 1 >= IP_RATE_LIMIT:
            return jsonify({'error': '操作太频繁，请稍后再试'}), 429
        msg = '账号或密码错误'
        if u and left <= 2:
            msg += '（还能试 %d 次，用完要等%s）' % (left, lock_hint())
        return jsonify({'error': msg}), 401
    # 清账号计数但保留 IP/时间。删整行会让成功登录顺带冲掉 IP 的限流历史。
    db.execute('UPDATE login_guard SET username=NULL WHERE username=?', (username,))
    db.execute('INSERT INTO login_guard (ip, username, at) VALUES (?,NULL,?)', (ip, stamp))
    ts = now()
    session.clear()
    session['uid'] = u['id']
    session['username'] = u['username']
    session['name'] = u['name']
    session['role'] = u['role']
    session['login_at'] = now_ms()      # 要精确到毫秒，见 now_ms() 的说明
    # 不做"记住我"：登录凭证只在浏览器开着的时候有效，浏览器整个关掉就失效，
    # 下次打开必须重新输密码。共用电脑时更安全。
    session.permanent = False
    db.execute('UPDATE users SET last_login=? WHERE id=?', (ts, u['id']))
    write_log('登录', 'user', u['id'])
    db.commit()
    return jsonify({'ok': True, 'name': u['name'], 'role': u['role']})


@app.route('/api/logout', methods=['POST'])
@login_required          # 这个口子以前谁都能敲，没登录也会写一条"退出"日志，
def api_logout():        # 等于任何人都能往系统日志里灌水（审计 S-01）。现在没登录直接 401，不写日志。
    write_log('退出')
    get_db().commit()
    session.clear()
    return jsonify({'ok': True})


@app.route('/api/me')
@login_required
def api_me():
    u = current_user()
    return jsonify({'id': u['id'], 'username': u['username'], 'name': u['name'],
                    'role': u['role'], 'version': VERSION})


# ---------- 看板 ----------
@app.route('/api/dashboard')
@login_required
def api_dashboard():
    db = get_db()
    # 看板上的统计也按"审没审"过滤：不然列表里藏住了、概览上还数着，
    # 连名字和余量都能从这块看走（审计 M-05）
    cfrag, cargs = review_filter('flow_status', 'created_by')
    rows = db.execute('SELECT * FROM certificates WHERE active=1' + cfrag, cargs).fetchall()
    stats = {'total': 0, 'ok': 0, 'warn': 0, 'expired': 0, 'unknown': 0, 'longterm': 0}
    for r in rows:
        lv = expiry_info(r)['level']
        stats['total'] += 1
        stats[lv] = stats.get(lv, 0) + 1
    # 待审核：附件 + 员工新建的资料 + 员工新录的仓库物品。
    # 普通员工不用看这个数（他审不了），给 0 免得他以为有什么事等着自己。
    if can_review():
        pending = db.execute('SELECT COUNT(*) FROM versions WHERE status="pending"').fetchone()[0]
        pending_certs = db.execute("SELECT COUNT(*) FROM certificates WHERE active=1"
                                   " AND flow_status='pending'").fetchone()[0]
        pending_items = db.execute("SELECT COUNT(*) FROM inventory_items WHERE active=1"
                                   " AND status='pending'").fetchone()[0]
        pending_images = db.execute("SELECT COUNT(*) FROM inventory_image_versions v"
                                    " JOIN inventory_items i ON i.id=v.item_id"
                                    " WHERE v.status='pending' AND i.active=1").fetchone()[0]
        pending_assets = db.execute("SELECT COUNT(*) FROM assets WHERE active=1"
                                    " AND review_status='pending'").fetchone()[0]
        pending_edits = db.execute("SELECT COUNT(*) FROM certificate_edit_requests e"
                                   " JOIN certificates c ON c.id=e.cert_id"
                                   " WHERE e.status='pending' AND c.active=1").fetchone()[0]
    else:
        pending_edits = 0
        pending_images = 0
        pending = pending_certs = pending_items = pending_assets = 0
    # 资产的条数也按"审没审"过滤，跟列表里看到的对得上
    afrag, afargs = review_filter('review_status', 'created_by')
    assets_out = db.execute('SELECT COUNT(*) FROM assets WHERE status="taken" AND active=1'
                            + afrag, afargs).fetchone()[0]
    assets_total = db.execute('SELECT COUNT(*) FROM assets WHERE active=1' + afrag,
                              afargs).fetchone()[0]
    ifrag, iargs = review_filter('status', 'created_by')
    # 仓库预警：过期（沿用两档）/ 库存不足。只算 active=1 的物品。
    inv_rows = db.execute('SELECT * FROM inventory_items WHERE active=1'
                          + ifrag, iargs).fetchall()
    inv_total = len(inv_rows)
    wh_expired = wh_warn = wh_low = 0
    warehouse_items = []
    for r in inv_rows:
        info = expiry_info(r)
        is_low = r['safety_stock'] > 0 and r['quantity'] < r['safety_stock']
        if info['level'] == 'expired':
            wh_expired += 1
        elif info['level'] == 'warn':
            wh_warn += 1
        if is_low:
            wh_low += 1
        if info['level'] in ('expired', 'warn') or is_low:
            warehouse_items.append({
                'id': r['id'], 'name': r['name'], 'category': r['category'],
                'quantity': r['quantity'], 'unit': r['unit'],
                'level': info['level'], 'label': info['label'], 'days': info['days'],
                'low_stock': is_low,
            })
    warehouse_items.sort(
        key=lambda x: 0 if x['level'] == 'expired' else 1 if x['level'] == 'warn' else 2)
    soon = []
    for r in rows:
        info = expiry_info(r)
        if info['level'] in ('expired', 'danger', 'warn', 'notice'):
            soon.append({'id': r['id'], 'name': r['name'], 'scope': r['scope'],
                         'holder': r['holder'], 'expiry_date': r['expiry_date'],
                         'days': info['days'], 'label': info['label'], 'level': info['level']})
    soon.sort(key=lambda x: (x['days'] is None, x['days'] or 0))
    # 每个"看了<｜hy_place▁holder▁no▁288｜>要数什么"都得按**自己那一页能看到的范围**来数。
    # 以前所有板块共用全站那一个数：企业模块拿全站的「已过期」却写着「即将过期」，
    # 员工模块更把企业资料也算进「几人即将过期」（审计 10/03 S-03）。
    # 现在按归属分开数，交给页面自己挑文案，口径跟各自列表完全一致。
    scope_levels = {}
    for r in rows:
        lv = expiry_info(r)['level']
        sc = (r['scope'] if 'scope' in r.keys() else 'company') or 'company'
        box = scope_levels.setdefault(sc, {'expired': 0, 'warn': 0})
        if lv == 'expired':
            box['expired'] += 1
        elif lv == 'warn':
            box['warn'] += 1
    counts = {
        'company': sum(1 for r in rows if r['scope'] == 'company'),
        # 员工页按北於的意思显示他名下的全部资料，不再只挑健康证，这里跟着一起对齐
        'employee': sum(1 for r in rows if r['scope'] == 'employee'),
        'staff': db.execute('SELECT COUNT(*) FROM employees WHERE active=1').fetchone()[0],
        'assets': assets_total,
        'users': db.execute('SELECT COUNT(*) FROM users WHERE active=1').fetchone()[0],
        'drinks': db.execute('SELECT COUNT(*) FROM drink_pages').fetchone()[0],
        'inventory': inv_total,
    }
    return jsonify({'stats': stats, 'pending': pending,
                    'pending_total': pending + pending_certs + pending_items + pending_assets + pending_images + pending_edits,
                    'pending_detail': {'version': pending, 'cert': pending_certs,
                                       'item': pending_items, 'asset': pending_assets,
                                       'item_image': pending_images, 'cert_edit': pending_edits},
                    'assets_out': assets_out, 'assets_total': assets_total,
                    'counts': counts,
                    # 各模块自己那一页的到期数（ key 是归属，值是 expired / warn 两档）
                    'cert_scope': scope_levels,
                    'warehouse': {'total': inv_total, 'expired': wh_expired,
                                  'warn': wh_warn, 'low_stock': wh_low,
                                  'items': warehouse_items[:15]},
                    'soon': soon[:15]})


# ---------- 证照 ----------
@app.route('/api/certificates')
@login_required
def api_list_certificates():
    db = get_db()
    scope = request.args.get('scope')
    q = (request.args.get('q') or '').strip()
    category = request.args.get('category')
    sql = 'SELECT * FROM certificates WHERE active=1'
    args = []
    if scope:
        sql += ' AND scope=?'
        args.append(scope)
    if category:
        sql += ' AND category=?'
        args.append(category)
    if q:
        sql += ' AND (name LIKE ? OR cert_no LIKE ? OR issuer LIKE ? OR holder LIKE ?)'
        args += ['%%%s%%' % q] * 4
    # 没审核过的资料不给不相干的人看（管理员例外，他得审）
    extra, extra_args = review_filter('flow_status', 'created_by')
    sql += extra
    args += extra_args
    sql += ' ORDER BY expiry_date IS NULL, expiry_date'
    rows = db.execute(sql, args).fetchall()
    return jsonify([cert_row_to_dict(r, db=db) for r in rows])


@app.route('/api/certificates/<int:cid>')
@login_required
def api_get_certificate(cid):
    db = get_db()
    cond, args = review_filter('flow_status', 'created_by')
    r = db.execute('SELECT * FROM certificates WHERE id=? AND active=1%s' % cond,
                   [cid] + args).fetchone()
    if not r:
        abort(404)          # 没审过的资料，翻到详情也看不到
    out = cert_row_to_dict(r, with_versions=True, db=db)
    sql = 'SELECT * FROM certificate_edit_requests WHERE cert_id=?'
    params = [cid]
    if not can_review():
        sql += ' AND submitted_by=?'
        params.append(_my_account())
    out['edit_requests'] = [cert_edit_request_dict(e, r) for e in
                            db.execute(sql + ' ORDER BY id DESC', params).fetchall()]
    return jsonify(out)


@app.route('/api/certificates', methods=['POST'])
@login_required
def api_create_certificate():
    data = json_body()
    if data is None:
        return jsonify({'error': '提交的数据格式不对，请刷新页面重试'}), 400
    f, err = clean_cert_fields(data, partial=False)
    if err:
        return jsonify({'error': err}), 400
    f['scope'] = f.get('scope') or 'company'
    f['category'] = f.get('category') or '其他'
    f['name'] = f.get('name') or '未命名资料'
    # 管理员建的直接生效；员工建的先进"待审核"，管理员核过才给大家看
    flow = 'approved' if can_review() else 'pending'
    db = get_db()
    cur = db.execute('''INSERT INTO certificates
        (scope, category, name, cert_type, cert_no, issuer, holder, keeper, employee_id,
         issue_date, expiry_mode, expiry_date, remind_days, flow_status, paper_location,
         note, created_by, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''', (
        f['scope'], f['category'], f['name'], f['cert_type'], f['cert_no'], f['issuer'],
        f['holder'], f['keeper'], f['employee_id'], f['issue_date'], f['expiry_mode'],
        f['expiry_date'], f['remind_days'],
        flow,
        f['paper_location'], f['note'],
        _owner_tag(), now()))
    cid = cur.lastrowid
    write_log('新增资料', 'certificate', cid, '%s（%s）' % (data.get('name'), flow))
    db.commit()
    return jsonify({'ok': True, 'id': cid, 'status': flow})


@app.route('/api/certificates/<int:cid>', methods=['PUT'])
@login_required
def api_update_certificate(cid):
    data = json_body()
    if data is None:
        return jsonify({'error': '提交的数据格式不对，请刷新页面重试'}), 400
    db = get_db()
    if not _begin_write(db):
        return jsonify({'error': '资料正在处理，请稍后重试'}), 409
    try:
        r = db.execute('SELECT * FROM certificates WHERE id=? AND active=1', (cid,)).fetchone()
        if not r or not can_see_cert(r):
            db.rollback()
            abort(404)
        f, err = clean_cert_edit(data, r)
        if err or not f:
            db.rollback()
            return jsonify({'error': err or '没有要修改的内容'}), 400
        # 表单把尚未填写的 NULL 文本提交为空串，两者都表示空白，不算实际修改。
        patch = {k: value for k, value in f.items() if r[k] != value
                 and not (r[k] in (None, '') and value in (None, ''))}
        if not patch:
            db.rollback()
            return jsonify({'ok': True, 'unchanged': True, 'pending': False})
        if can_review():
            db.execute('UPDATE certificates SET %s WHERE id=?' % ', '.join('%s=?' % k for k in patch),
                       list(patch.values()) + [cid])
            write_log('修改资料', 'certificate', cid,
                      '%s · %s' % (r['name'], json.dumps({'before': {k: r[k] for k in patch},
                                                       'after': patch}, ensure_ascii=False)))
            result = {'ok': True, 'pending': False}
        else:
            base = {k: r[k] for k in patch}
            cur = db.execute('INSERT INTO certificate_edit_requests'
                             ' (cert_id,patch_json,base_json,status,submitted_by,submitted_at)'
                             ' VALUES (?,?,?,\'pending\',?,?)',
                             (cid, json.dumps(patch, ensure_ascii=False),
                              json.dumps(base, ensure_ascii=False), _my_account(), now()))
            write_log('提交资料修改', 'certificate', cid,
                      '%s · 申请 #%d · %s' % (r['name'], cur.lastrowid,
                          json.dumps({'before': base, 'after': patch}, ensure_ascii=False)))
            result = {'ok': True, 'pending': True, 'status': 'pending', 'request_id': cur.lastrowid}
        db.commit()
    except sqlite3.Error as exc:
        db.rollback()
        app.logger.warning('资料修改提交失败：%s', exc)
        return jsonify({'error': '修改提交失败，原资料未改动，请刷新后重试'}), 400
    return jsonify(result)


# 「停用资料」这个口子已经按北於的确认去掉了（不用了的资料直接删除，不留隐藏记录）。
# 这里不再注册任何地址，避免有人拿着老地址直接发请求把资料在"在用 / 停用"之间来回切。


@app.route('/api/certificates/<int:cid>', methods=['DELETE'])
@admin_required
def api_delete_certificate(cid):
    """彻底删除资料与附件；仅管理员，按北於裁定免手输资料全名。"""
    db = get_db()
    # 先拿写锁再核对记录、收集附件，避免上传在读完清单后插进一份新文件。
    if not _begin_write(db):
        return jsonify({'error': '资料正在处理，请稍后重试'}), 409
    r = db.execute('SELECT * FROM certificates WHERE id=?', (cid,)).fetchone()
    if not r:
        db.rollback()
        abort(404)
    name = r['name']
    vs = db.execute('SELECT * FROM versions WHERE cert_id=?', (cid,)).fetchall()
    files = []
    for v in vs:
        for k in ('stored_name', 'web_name', 'thumb_name'):
            if v[k]:
                files.append(v[k])
    try:
        db.execute('DELETE FROM versions WHERE cert_id=?', (cid,))
        db.execute('DELETE FROM certificate_edit_requests WHERE cert_id=?', (cid,))
        db.execute('DELETE FROM certificates WHERE id=?', (cid,))
        write_log('彻底删除资料', 'certificate', cid, '%s（含 %d 个附件）' % (name, len(files)))
        db.commit()
    except Exception as e:
        db.rollback()
        return jsonify({'error': '删除失败，数据未改动：%s' % e}), 400
    # 数据库删成功后再删文件：宁可留下没记录的文件，也不能出现"记录还在、文件没了"
    removed = 0
    for f in files:
        p = os.path.join(UPLOAD_DIR, f)
        if not os.path.exists(p):
            continue
        try:
            os.remove(p)
            removed += 1
        except OSError as e:
            # 记录已经删了，文件却没删掉：登记下来，下次启动会再试一次（审计 S-07）
            _add_pending_cleanup(p, '附件记录删除后文件没删掉：%s' % e)
    return jsonify({'ok': True, 'removed_files': removed})


# ---------- 附件 / 版本 ----------
@app.route('/api/certificates/<int:cid>/versions', methods=['POST'])
@login_required
def api_upload_version(cid):
    if 'file' not in request.files:
        return jsonify({'error': '没有选择文件'}), 400
    f = request.files['file']
    if not f.filename:
        return jsonify({'error': '没有选择文件'}), 400
    ext = f.filename.rsplit('.', 1)[-1].lower() if '.' in f.filename else ''
    if ext not in ALLOWED_EXT:
        return jsonify({'error': '不支持的文件类型：%s' % ext}), 400
    db = get_db()
    cert = db.execute('SELECT * FROM certificates WHERE id=? AND active=1', (cid,)).fetchone()
    if not cert or not can_see_cert(cert):
        abort(404)
    # 系统生成随机文件名，不直接用用户文件名，避免路径穿越和猜址
    # 文件处理不占写锁；版本号等文件处理完成后在写事务里分配。
    base = '%d_%s' % (cid, secrets.token_hex(8))
    stored = base + '.' + ext
    path = os.path.join(UPLOAD_DIR, stored)
    web_name = thumb_name = None
    error_status = 400
    try:
        f.save(path)
        size = os.path.getsize(path)
        # 空文件不算上传成功：否则会留下一条"传上去了但下载下来是 0 字节"的附件，
        # 管理员传的还会直接顶掉原本能用的当前版本。
        if size == 0:
            raise ValueError('这个文件是空的（0 字节），请重新选择')
        web_name, thumb_name = make_web_and_thumb(
            path, ext, base, progressive=True,
            max_side=CERT_WEB_MAX_SIDE, max_bytes=CERT_WEB_MAX_BYTES)
        # 图片读不出来（损坏 / 假图片）就当没传成功，不留坏数据
        if ext in ('jpg', 'jpeg', 'png') and HAS_PIL and web_name is None:
            raise ValueError('这张图片读不出来，可能已经损坏，请重新拍一张或换个文件')
        # 父资料可能在图片处理期间被删除、停用或改为不可见，必须拿锁后重新查。
        if not _begin_write(db):
            error_status = 409
            raise ValueError('资料正在处理，请稍后重试')
        cert = db.execute('SELECT * FROM certificates WHERE id=? AND active=1', (cid,)).fetchone()
        if not cert or not can_see_cert(cert):
            error_status = 404
            raise ValueError('资料不存在或当前不可查看')
        last = db.execute('SELECT MAX(version_no) FROM versions WHERE cert_id=?', (cid,)).fetchone()[0]
        version_no = (last or 0) + 1
        cur = db.execute('''INSERT INTO versions (cert_id, version_no, original_name, stored_name,
            web_name, thumb_name, size, change_note, status, uploaded_by, uploaded_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)''',
                         (cid, version_no, f.filename, stored, web_name, thumb_name, size,
                          request.form.get('change_note') or '', 'pending',
                          _owner_tag(), now()))
        vid = cur.lastrowid
        # 管理员自己传的不用再审核一次（老板不需要审老板），直接成为当前有效版本；
        # 员工传的仍进入待审核。
        if _db_role() == 'admin':
            db.execute('UPDATE versions SET status="history" WHERE cert_id=? AND id!=?'
                       ' AND status="approved"', (cid, vid))
            db.execute('UPDATE versions SET status="approved", reviewed_by=?, reviewed_at=?'
                       ' WHERE id=?', (session.get('name'), now(), vid))
            db.execute('UPDATE certificates SET flow_status="approved" WHERE id=?', (cid,))
        write_log('上传附件', 'certificate', cid, 'v%d %s' % (version_no, f.filename))
        db.commit()
    except Exception as e:
        # 出错了就把已经落到硬盘上的文件删掉，避免留下没人认领的孤附件
        db.rollback()
        for n in (stored, web_name, thumb_name):
            if not n:
                continue
            try:
                os.remove(os.path.join(UPLOAD_DIR, n))
            except OSError:
                pass
        msg = str(e) if isinstance(e, ValueError) else '上传失败，请重试'
        return jsonify({'error': msg}), error_status
    return jsonify({'ok': True, 'version_no': version_no,
                    'auto_approved': _db_role() == 'admin'})


@app.route('/api/versions/<int:vid>/review', methods=['POST'])
@admin_required
def api_review_version(vid):
    data = json_body()
    if data is None:
        return jsonify({'error': '提交的数据格式不对，请刷新页面重试'}), 400
    return review_pending_object('version', vid, data)


def review_pending_object(kind, rid, data):
    """旧附件与统一审核共用最终状态检查；结果、连带更新和日志一起提交。"""
    action = data.get('action')
    if action not in ('approve', 'reject'):
        return jsonify({'error': '未知操作'}), 400
    reason = None
    if action == 'reject':
        reason, err = text_in(data, 'reason', '退回原因', maxlen=200)
        if err:
            return jsonify({'error': err}), 400
    definitions = {
        'cert': ('certificates', 'flow_status', 'certificate'),
        'item': ('inventory_items', 'status', 'inventory'),
        'asset': ('assets', 'review_status', 'asset'),
    }
    if kind != 'version' and kind not in definitions:
        return jsonify({'error': '没有这类待审事项'}), 400
    db = get_db()
    if not _begin_write(db):
        return jsonify({'error': '该项正在处理，请稍后重试'}), 409
    try:
        if kind == 'version':
            row = db.execute('SELECT * FROM versions WHERE id=?', (rid,)).fetchone()
            parent = db.execute('SELECT * FROM certificates WHERE id=? AND active=1',
                                (row['cert_id'],)).fetchone() if row else None
            if not row or not parent:
                db.rollback()
                abort(404)
            status = row['status']
        else:
            table, field, target = definitions[kind]
            row = db.execute('SELECT * FROM %s WHERE id=? AND active=1' % table,
                             (rid,)).fetchone()
            if not row:
                db.rollback()
                abort(404)
            status = row[field]
        if status != 'pending':
            db.rollback()
            return jsonify({'error': '该项已处理，请刷新待审列表'}), 409
        result = 'approved' if action == 'approve' else 'rejected'
        if kind == 'version':
            cur = db.execute('UPDATE versions SET status=?, reject_reason=?, reviewed_by=?, reviewed_at=?'
                             ' WHERE id=? AND status="pending" AND EXISTS'
                             ' (SELECT 1 FROM certificates c WHERE c.id=versions.cert_id AND c.active=1)',
                             (result, reason, _me_name(), now(), rid))
        elif kind == 'cert':
            cur = db.execute('UPDATE certificates SET flow_status=?'
                             ' WHERE id=? AND active=1 AND flow_status="pending"', (result, rid))
        else:
            cur = db.execute('UPDATE %s SET %s=?, reject_reason=?, reviewed_by=?, reviewed_at=?'
                             ' WHERE id=? AND active=1 AND %s="pending"' % (table, field, field),
                             (result, reason, _me_name(), now(), rid))
        if cur.rowcount != 1:
            db.rollback()
            return jsonify({'error': '该项已处理，请刷新待审列表'}), 409
        if kind == 'version':
            if action == 'approve':
                db.execute('UPDATE versions SET status="history" WHERE cert_id=?'
                           ' AND id!=? AND status="approved"', (row['cert_id'], rid))
                cur = db.execute('UPDATE certificates SET flow_status="approved" WHERE id=? AND active=1',
                                 (row['cert_id'],))
                if cur.rowcount != 1:
                    db.rollback()
                    abort(404)
            write_log('审核通过' if action == 'approve' else '退回', 'certificate', row['cert_id'],
                      'v%d' % row['version_no'] if action == 'approve' else reason)
        else:
            write_log('审核通过' if action == 'approve' else '退回', target, rid,
                      row['name'] if action == 'approve' else '%s：%s' % (row['name'], reason))
        db.commit()
    except Exception:
        db.rollback()
        raise
    return jsonify({'ok': True})


# ---------- 消防照片册（独立于旧证照分类） ----------
FIRE_DIRECTORIES = (
    ('A01', '单位基本情况'),
    ('A02', '建筑物基本情况'),
    ('A03', '单位概貌与地理位置图 共两页'),
    ('A04', '消防平面与疏散路线图'),
    ('A05', '消防安全重点部位情况'),
    ('A06', '消防行政许可与备案文件目录'),
    ('A07', '消防管理组织及任命登记'),
    ('A08', '管理人员与重点工种人员'),
    ('A09', '消防队站人员与装备'),
    ('A10', '消防安全制度与规程目录'),
    ('A11', '消防安全责任及签认'),
    ('A12', '消防安全管理制度参考文本 共五页'),
    ('A13', '消防安全操作规程编制页'),
    ('A14', '消防设施设备明细'),
    ('A15', '灭火器材配置与维修台账'),
    ('A16', '新增消防产品与防火材料资料'),
    ('A17', '灭火和应急疏散预案 共两页'),
    ('A18', '年度消防工作计划与经费'),
    ('B01', '消防法律文书登记'),
    ('B02', '每日防火巡查记录'),
    ('B03', '防火检查记录'),
    ('B04', '火灾隐患整改台账'),
    ('B05', '隐患整改与复查确认单'),
    ('B06', '消防设施故障处理记录'),
    ('B07', '消防控制室交接记录'),
    ('B08', '消防控制室值班运行记录'),
    ('B09', '消防设施检查与维护保养记录 共两页'),
    ('B10', '消防设施检测报告登记'),
    ('B11', '燃气电气防雷防静电检查记录'),
    ('B12', '消防安全教育培训记录'),
    ('B13', '培训及演练签到表'),
    ('B14', '灭火和应急疏散演练记录'),
    ('B15', '培训演练及整改照片资料'),
    ('B16', '消防安全会议记录'),
    ('B17', '四个能力自查评估'),
    ('B18', '火灾情况记录'),
    ('B19', '消防工作考评与奖惩记录'),
    ('B20', '三项报告及受理凭证存档 共两页'),
    ('B21', '标准化管理自查自评'),
    ('B22', '消防安全自查承诺及公开记录'),
)
FIRE_DIRECTORY_NAMES = dict(FIRE_DIRECTORIES)


def fire_directory(code):
    if code not in FIRE_DIRECTORY_NAMES:
        raise ValueError('消防目录不存在')
    return {'code': code, 'name': FIRE_DIRECTORY_NAMES[code]}


def fire_current_rows(db, code):
    return db.execute("SELECT * FROM fire_photos WHERE directory_code=?"
                      " AND status='approved' ORDER BY sort_order,id", (code,)).fetchall()


def fire_order_ids(db, code):
    return [r['id'] for r in fire_current_rows(db, code)]


def fire_can_view_photo(user, row, file_access=False):
    if not user or not row:
        return False
    if user['role'] == 'admin' or row['status'] == 'approved':
        return True
    return (row['uploaded_user_id'] == user['id']
            and row['status'] in (('pending',) if file_access else ('pending', 'rejected')))


def fire_photo_dict(row, user=None):
    user = current_user() if user is None else user
    fields = ('id', 'directory_code', 'status', 'sort_order', 'replaces_photo_id',
              'uploaded_by', 'uploaded_at', 'reviewed_by', 'reviewed_at', 'reject_reason',
              'original_name', 'file_size', 'width', 'height')
    out = {key: row[key] for key in fields}
    visible = fire_can_view_photo(user, row, file_access=True)
    for variant in ('web', 'thumb', 'original'):
        out[variant + '_url'] = '/fire-files/%d/%s' % (row['id'], variant) if visible else None
    return out


def fire_order_request_dict(db, row):
    fields = ('id', 'directory_code', 'status', 'requested_by', 'requested_at',
              'reviewed_by', 'reviewed_at', 'reject_reason')
    out = {key: row[key] for key in fields}
    out['base_photo_ids'] = json.loads(row['base_photo_ids_json'])
    out['photo_ids'] = json.loads(row['photo_ids_json'])
    out['conflict'] = (row['status'] == 'pending'
                       and out['base_photo_ids'] != fire_order_ids(db, row['directory_code']))
    return out


def fire_approve_new_photo(db, row, reviewer):
    """批内已确认选择顺序决定页序；保留其它照片的相对位置。"""
    if row['status'] != 'pending' or not row['batch_token'] or row['batch_index'] is None:
        raise ValueError('不是可通过的新增照片')
    current = fire_current_rows(db, row['directory_code'])
    siblings = [p for p in current if p['batch_token'] == row['batch_token']
                and p['uploaded_user_id'] == row['uploaded_user_id']]
    indexes = [p['batch_index'] for p in siblings]
    if any(a >= b for a, b in zip(indexes, indexes[1:])):
        raise RuntimeError('该批照片页序已变化，请先确认或调整页序')
    ids = [p['id'] for p in current]
    upper = next((p for p in siblings if p['batch_index'] > row['batch_index']), None)
    lower = next((p for p in reversed(siblings) if p['batch_index'] < row['batch_index']), None)
    insert_at = ids.index(upper['id']) if upper is not None else (
        ids.index(lower['id']) + 1 if lower is not None else len(ids))
    ids.insert(insert_at, row['id'])
    for position, photo_id in enumerate(ids, 1):
        if photo_id == row['id']:
            changed = db.execute("UPDATE fire_photos SET status='approved',sort_order=?,"
                                 "reviewed_by=?,reviewed_at=? WHERE id=? AND status='pending'",
                                 (position, reviewer, now(), photo_id))
        else:
            changed = db.execute("UPDATE fire_photos SET sort_order=? WHERE id=?"
                                 " AND directory_code=? AND status='approved'",
                                 (position, photo_id, row['directory_code']))
        if changed.rowcount != 1:
            raise RuntimeError('照片已变化，请重新确认')


def fire_approve_replacement(db, row, reviewer):
    parent = db.execute('SELECT * FROM fire_photos WHERE id=?',
                        (row['replaces_photo_id'],)).fetchone()
    if not parent or parent['status'] != 'approved' or parent['directory_code'] != row['directory_code']:
        raise RuntimeError('原照片已变化，请刷新并重新选择')
    db.execute("UPDATE fire_photos SET status='replaced',sort_order=NULL WHERE id=?",
               (parent['id'],))
    db.execute("UPDATE fire_photos SET status='approved',sort_order=?,reviewed_by=?,"
               "reviewed_at=? WHERE id=? AND status='pending'",
               (parent['sort_order'], reviewer, now(), row['id']))


def fire_validate_ids(ids):
    if not isinstance(ids, list) or any(type(x) is not int or not 1 <= x <= 9223372036854775807 for x in ids):
        raise ValueError('照片序号必须是正整数列表')
    if len(set(ids)) != len(ids):
        raise ValueError('照片序号不能重复')


def fire_apply_order(db, code, base_ids, target_ids):
    fire_validate_ids(base_ids)
    fire_validate_ids(target_ids)
    if set(base_ids) != set(target_ids):
        raise ValueError('排序必须包含原目录的全部照片')
    # 基准中伪造/跨目录 ID 属入参错误；正常照片被删/替换则是失效基准。
    for photo_id in base_ids:
        row = db.execute('SELECT directory_code FROM fire_photos WHERE id=?', (photo_id,)).fetchone()
        if row and row['directory_code'] != code:
            raise ValueError('照片不属于该目录')
    if base_ids != fire_order_ids(db, code):
        raise RuntimeError('照片或页序已变化，请刷新后重新排序')
    for position, photo_id in enumerate(target_ids, 1):
        db.execute("UPDATE fire_photos SET sort_order=? WHERE id=? AND status='approved'",
                   (position, photo_id))


def fire_write_error(db, exc):
    db.rollback()
    if isinstance(exc, PermissionError):
        code = 403
    elif isinstance(exc, LookupError):
        code = 404
    elif isinstance(exc, ValueError):
        code = 400
    elif isinstance(exc, RuntimeError):
        code = 409
    else:
        code = 500
        app.logger.exception('消防照片册操作失败')
    return jsonify({'error': str(exc) if code != 500 else '保存失败，请稍后重试'}), code


def fire_commit(db):
    if not _end_write(db):
        db.rollback()
        raise sqlite3.OperationalError('消防操作提交失败')


def fire_uuid(value):
    try:
        if not isinstance(value, str):
            raise ValueError
        return str(uuid.UUID(value))
    except (ValueError, AttributeError):
        raise ValueError('上传标识必须是有效 UUID')


def fire_image_info(file):
    """验证真实格式、尺寸与完整解码；保留原始字节，不重写原件。"""
    if not HAS_PIL:
        raise ValueError('缺少图片处理组件，暂时无法上传')
    ext = (file.filename or '').rsplit('.', 1)[-1].lower()
    if ext not in ('jpg', 'jpeg', 'png'):
        raise ValueError('只允许 JPEG 或 PNG 照片')
    content = file.read(MAX_IMAGE_BYTES + 1)
    if not content or len(content) > MAX_IMAGE_BYTES:
        raise ValueError('照片不能为空，且不能超过 15MB')
    try:
        with warnings.catch_warnings():
            from PIL.Image import DecompressionBombWarning
            warnings.simplefilter('ignore', DecompressionBombWarning)
            with Image.open(io.BytesIO(content)) as im:
                expected = 'PNG' if ext == 'png' else 'JPEG'
                if im.format != expected:
                    raise ValueError('照片扩展名与实际格式不符')
                width, height = im.size
                if width <= 0 or height <= 0 or width * height > FIRE_SOURCE_MAX_PIXELS:
                    raise ValueError('照片尺寸超过安全上限')
                im.verify()
            with Image.open(io.BytesIO(content)) as im:
                im.load()
    except Exception as exc:
        raise ValueError('照片损坏、格式不符或尺寸过大') from exc
    return content, ext, width, height, 'image/png' if ext == 'png' else 'image/jpeg'


def fire_upload(code=None, parent_id=None):
    db, made = get_db(), []
    try:
        token = fire_uuid(request.form.get('client_token'))
        allowed = {'client_token'} if parent_id is not None else {'client_token', 'batch_token', 'batch_index'}
        if set(request.form) != allowed or set(request.files) != {'file'} or len(request.files.getlist('file')) != 1:
            raise ValueError('每次只上传一张照片及规定的标识字段')
        if any(len(request.form.getlist(k)) != 1 for k in allowed):
            raise ValueError('上传字段不能重复')
        batch, index = None, None
        if parent_id is None:
            fire_directory(code)
            batch = fire_uuid(request.form.get('batch_token'))
            value = request.form.get('batch_index', '')
            if not re.fullmatch(r'[0-9]+', value) or len(value) > 19:
                raise ValueError('批次序号必须是正整数')
            index = int(value)
            if not 1 <= index <= 9223372036854775807:
                raise ValueError('批次序号超出范围')
        file = request.files['file']
        content, ext, width, height, mime = fire_image_info(file)
        sha = hashlib.sha256(content).hexdigest()
        user = current_user()
        if not _begin_write(db):
            raise sqlite3.OperationalError('消防写锁获取失败')
        old = db.execute('SELECT * FROM fire_photos WHERE client_token=?', (token,)).fetchone()
        if old:
            matches = (old['uploaded_user_id'] == user['id']
                       and (code is None or old['directory_code'] == code)
                       and old['replaces_photo_id'] == parent_id
                       and old['batch_token'] == batch and old['batch_index'] == index
                       and old['sha256'] == sha and old['file_size'] == len(content))
            if not matches or not fire_can_view_photo(user, old):
                raise RuntimeError('上传标识已使用或照片已变化，请刷新后重试')
            db.rollback()
            return jsonify({'ok': True, 'photo': fire_photo_dict(old, user), 'replayed': True})
        if parent_id is not None:
            parent = db.execute('SELECT * FROM fire_photos WHERE id=?', (parent_id,)).fetchone()
            if not parent:
                raise LookupError('原照片不存在')
            if parent['status'] != 'approved':
                raise RuntimeError('原照片已变化，请刷新后重新选择')
            code = parent['directory_code']
        else:
            bindings = db.execute('SELECT uploaded_user_id,directory_code,batch_index FROM fire_photos'
                                  ' WHERE batch_token=?', (batch,)).fetchall()
            if any(r['uploaded_user_id'] != user['id'] for r in bindings):
                raise PermissionError('该上传批次不可使用')
            if any(r['directory_code'] != code for r in bindings):
                raise ValueError('上传批次不能跨目录')
            if any(r['batch_index'] == index for r in bindings):
                raise RuntimeError('该批次序号已使用，请刷新后重试')
        base = 'fire_' + secrets.token_hex(16)
        stored = base + '.' + ext
        candidates = [os.path.join(UPLOAD_DIR, name) for name in
                      (stored, base + '_web.jpg', base + '_thumb.jpg')]
        if any(os.path.lexists(path) for path in candidates):
            raise RuntimeError('照片存储名称冲突，请重试')
        with open(candidates[0], 'xb') as out:
            made.append(candidates[0])
            out.write(content)
        # 独占预留本轮的派生路径，处理函数只会改写本轮创建的文件。
        # 即使核查后碰到文件竞争，未成功创建的旧文件也不进入清理清单。
        for path in candidates[1:]:
            with open(path, 'xb'):
                made.append(path)
        web, thumb = make_web_and_thumb(candidates[0], ext, base,
                                        max_side=CERT_WEB_MAX_SIDE, max_bytes=CERT_WEB_MAX_BYTES,
                                        max_pixels=FIRE_SOURCE_MAX_PIXELS)
        if not web or not thumb:
            raise ValueError('照片处理失败，请重新选择完整照片')
        cur = db.execute('INSERT INTO fire_photos (directory_code,stored_name,web_name,thumb_name,'
                         'original_name,mime_type,file_size,width,height,sha256,client_token,batch_token,'
                         'batch_index,status,replaces_photo_id,uploaded_user_id,uploaded_by,uploaded_at)'
                         ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,\'pending\',?,?,?,?)',
                         (code, stored, web, thumb, os.path.basename(file.filename.replace('\\', '/')),
                          mime, len(content), width, height, sha, token, batch, index,
                          parent_id, user['id'], user['name'], now()))
        row = db.execute('SELECT * FROM fire_photos WHERE id=?', (cur.lastrowid,)).fetchone()
        if user['role'] == 'admin':
            if parent_id is None:
                fire_approve_new_photo(db, row, user['name'])
            else:
                fire_approve_replacement(db, row, user['name'])
        write_log('更换消防照片' if parent_id is not None else '上传消防照片', 'fire_photo', row['id'],
                  '%s · %s' % (code, '直接生效' if user['role'] == 'admin' else '待审核'))
        row = db.execute('SELECT * FROM fire_photos WHERE id=?', (row['id'],)).fetchone()
        response = jsonify({'ok': True, 'photo': fire_photo_dict(row, user), 'replayed': False})
        fire_commit(db)
        made = []
        return response
    except Exception as exc:
        response = fire_write_error(db, exc)
        for path in made:
            try:
                if os.path.exists(path):
                    os.remove(path)
            except OSError:
                _add_pending_cleanup(path, '消防上传失败，未引用文件清理失败')
        return response


@app.route('/fire')
@login_required
def fire_page():
    return render_template('fire.html', directories=FIRE_DIRECTORIES, v=VERSION)


@app.route('/api/fire/directories')
@login_required
def api_fire_directories():
    db, user = get_db(), current_user()
    counts = db.execute("SELECT directory_code,status,uploaded_user_id,COUNT(*) AS n FROM fire_photos"
                        " WHERE status IN ('approved','pending')"
                        " GROUP BY directory_code,status,uploaded_user_id").fetchall()
    items = []
    for code, name in FIRE_DIRECTORIES:
        items.append({'code': code, 'name': name,
                      'approved_count': sum(r['n'] for r in counts if r['directory_code'] == code and r['status'] == 'approved'),
                      'pending_count': sum(r['n'] for r in counts if r['directory_code'] == code and r['status'] == 'pending'
                                           and (user['role'] == 'admin' or r['uploaded_user_id'] == user['id']))})
    return jsonify({'items': items})


@app.route('/api/fire/directories/<code>/photos')
@login_required
def api_fire_photos(code):
    db, user = get_db(), current_user()
    try:
        directory = fire_directory(code)
    except ValueError as exc:
        return jsonify({'error': str(exc)}), 400
    rows = db.execute('SELECT * FROM fire_photos WHERE directory_code=?'
                      ' ORDER BY CASE WHEN sort_order IS NULL THEN 1 ELSE 0 END,sort_order,id', (code,)).fetchall()
    requests = db.execute('SELECT * FROM fire_photo_order_requests WHERE directory_code=? ORDER BY id DESC', (code,)).fetchall()
    return jsonify({'directory': directory,
                    'photos': [fire_photo_dict(r, user) for r in rows if fire_can_view_photo(user, r)],
                    'current_photo_ids': fire_order_ids(db, code),
                    'order_requests': [fire_order_request_dict(db, r) for r in requests
                                       if user['role'] == 'admin' or r['requested_user_id'] == user['id']]})


@app.route('/api/fire/directories/<code>/photos', methods=['POST'])
@login_required
def api_fire_upload(code):
    return fire_upload(code=code)


@app.route('/api/fire/photos/<int:pid>/replacement', methods=['POST'])
@login_required
def api_fire_replacement(pid):
    return fire_upload(parent_id=pid)


@app.route('/api/fire/directories/<code>/order', methods=['POST'])
@login_required
def api_fire_order(code):
    db = get_db()
    try:
        fire_directory(code)
        data = json_body()
        if data is None or set(data) != {'base_photo_ids', 'photo_ids'}:
            raise ValueError('排序字段格式不对')
        base, target = data['base_photo_ids'], data['photo_ids']
        fire_validate_ids(base)
        fire_validate_ids(target)
        if set(base) != set(target):
            raise ValueError('排序必须包含原目录的全部照片')
        if not _begin_write(db):
            raise sqlite3.OperationalError('消防写锁获取失败')
        user = current_user()
        # 先区分跨目录入参；同目录已删/已换/顺序过期仍按失效基准处理。
        for photo_id in base:
            row = db.execute('SELECT directory_code FROM fire_photos WHERE id=?', (photo_id,)).fetchone()
            if row and row['directory_code'] != code:
                raise ValueError('照片不属于该目录')
        if base != fire_order_ids(db, code):
            raise RuntimeError('照片或页序已变化，请刷新后重新排序')
        if user['role'] == 'admin':
            fire_apply_order(db, code, base, target)
            write_log('调整消防页序', 'fire_order', None, code)
            fire_commit(db)
            return jsonify({'ok': True, 'status': 'approved', 'photo_ids': target})
        base_json, target_json = json.dumps(base), json.dumps(target)
        old = db.execute("SELECT id FROM fire_photo_order_requests WHERE directory_code=?"
                         " AND requested_user_id=? AND base_photo_ids_json=? AND photo_ids_json=?"
                         " AND status='pending'", (code, user['id'], base_json, target_json)).fetchone()
        if old:
            db.rollback()
            return jsonify({'ok': True, 'status': 'pending', 'request_id': old['id'], 'photo_ids': target})
        cur = db.execute('INSERT INTO fire_photo_order_requests (directory_code,requested_user_id,requested_by,'
                         'requested_at,base_photo_ids_json,photo_ids_json,status) VALUES (?,?,?,?,?,?,\'pending\')',
                         (code, user['id'], user['name'], now(), base_json, target_json))
        write_log('申请消防页序调整', 'fire_order', cur.lastrowid, code)
        fire_commit(db)
        return jsonify({'ok': True, 'status': 'pending', 'request_id': cur.lastrowid, 'photo_ids': target})
    except Exception as exc:
        return fire_write_error(db, exc)


def fire_review_data(data):
    if set(data) - {'action', 'reason'} or data.get('action') not in ('approve', 'reject'):
        raise ValueError('审核字段格式不对')
    reason = data.get('reason', '')
    if data['action'] == 'reject' and (not isinstance(reason, str) or not reason.strip() or len(reason) > 1000):
        raise ValueError('请填写 1000 字以内的退回原因')
    return reason.strip() if data['action'] == 'reject' else ''


def review_fire_photo(pid, data):
    db = get_db()
    try:
        reason = fire_review_data(data)
        if not _begin_write(db):
            raise sqlite3.OperationalError('消防写锁获取失败')
        row = db.execute('SELECT * FROM fire_photos WHERE id=?', (pid,)).fetchone()
        if not row:
            raise LookupError('照片不存在')
        if row['status'] != 'pending':
            raise RuntimeError('照片已处理，请刷新后查看')
        reviewer = _me_name()
        if data['action'] == 'reject':
            db.execute("UPDATE fire_photos SET status='rejected',sort_order=NULL,reject_reason=?,"
                       "reviewed_by=?,reviewed_at=? WHERE id=?", (reason, reviewer, now(), pid))
        elif row['replaces_photo_id'] is not None:
            fire_approve_replacement(db, row, reviewer)
        else:
            fire_approve_new_photo(db, row, reviewer)
        write_log('审核消防照片', 'fire_photo', pid, data['action'] + (' · ' + reason if reason else ''))
        fire_commit(db)
        row = db.execute('SELECT * FROM fire_photos WHERE id=?', (pid,)).fetchone()
        return jsonify({'ok': True, 'photo': fire_photo_dict(row)})
    except Exception as exc:
        return fire_write_error(db, exc)


def review_fire_order(rid, data):
    db = get_db()
    try:
        reason = fire_review_data(data)
        if not _begin_write(db):
            raise sqlite3.OperationalError('消防写锁获取失败')
        row = db.execute('SELECT * FROM fire_photo_order_requests WHERE id=?', (rid,)).fetchone()
        if not row:
            raise LookupError('排序申请不存在')
        if row['status'] != 'pending':
            raise RuntimeError('排序申请已处理，请刷新后查看')
        ids = json.loads(row['photo_ids_json'])
        if data['action'] == 'approve':
            fire_apply_order(db, row['directory_code'], json.loads(row['base_photo_ids_json']), ids)
        status = 'approved' if data['action'] == 'approve' else 'rejected'
        db.execute('UPDATE fire_photo_order_requests SET status=?,reviewed_by=?,reviewed_at=?,reject_reason=? WHERE id=?',
                   (status, _me_name(), now(), reason, rid))
        write_log('审核消防页序', 'fire_order', rid, data['action'] + (' · ' + reason if reason else ''))
        fire_commit(db)
        out = {'ok': True, 'status': status}
        if status == 'approved':
            out['photo_ids'] = ids
        return jsonify(out)
    except Exception as exc:
        return fire_write_error(db, exc)


def fire_file_referenced(db, name):
    for table, fields in (
            ('fire_photos', ('stored_name', 'web_name', 'thumb_name')),
            ('versions', ('stored_name', 'web_name', 'thumb_name')),
            ('drink_pages', ('stored_name', 'web_name', 'thumb_name')),
            ('inventory_items', ('image_web', 'image_thumb')),
            ('inventory_image_versions', ('web_name', 'thumb_name'))):
        if db.execute('SELECT 1 FROM %s WHERE %s LIMIT 1' %
                      (table, ' OR '.join(field + '=?' for field in fields)), (name,) * len(fields)).fetchone():
            return True
    return False


@app.route('/api/fire/photos/<int:pid>', methods=['DELETE'])
@admin_required
def api_fire_delete(pid):
    db, deleted, rejected = get_db(), False, []
    try:
        data = json_body()
        if data is None or data:
            raise ValueError('删除请求必须提交空 JSON 对象')
        if not _begin_write(db):
            raise sqlite3.OperationalError('消防写锁获取失败')
        row = db.execute('SELECT * FROM fire_photos WHERE id=?', (pid,)).fetchone()
        if not row:
            raise LookupError('照片不存在')
        rejected = [r['id'] for r in db.execute("SELECT id FROM fire_photos WHERE replaces_photo_id=? AND status='pending'", (pid,))]
        db.execute("UPDATE fire_photos SET status='rejected',sort_order=NULL,reviewed_by=?,reviewed_at=?,"
                   "reject_reason='原照片已删除，请重新选择目录上传' WHERE replaces_photo_id=? AND status='pending'",
                   (_me_name(), now(), pid))
        db.execute('DELETE FROM fire_photos WHERE id=?', (pid,))
        for position, item in enumerate(fire_current_rows(db, row['directory_code']), 1):
            db.execute('UPDATE fire_photos SET sort_order=? WHERE id=?', (position, item['id']))
        write_log('删除消防照片', 'fire_photo', pid, '仅删除所选照片 · ' + row['directory_code'])
        fire_commit(db)
        deleted = True
        # 行已提交删除；再持锁核对所有模块引用，才逐文件清理。
        if not _begin_write(db):
            raise sqlite3.OperationalError('文件引用检查写锁获取失败')
        for field in ('stored_name', 'web_name', 'thumb_name'):
            name = row[field]
            if not fire_file_referenced(db, name):
                path = os.path.join(UPLOAD_DIR, name)
                if os.path.exists(path):
                    os.remove(path)
        fire_commit(db)
        return jsonify({'ok': True, 'deleted_id': pid, 'rejected_replacement_ids': rejected})
    except Exception as exc:
        if not deleted:
            return fire_write_error(db, exc)
        db.rollback()
        try:
            write_log('消防照片清理未完成', 'fire_photo', pid, '记录已删除，文件清理未完成', commit=True)
        except Exception:
            app.logger.exception('消防照片删除后清理日志写入失败')
        return jsonify({'error': '照片记录已删除，文件清理未完成，请联系管理员',
                        'deleted': True, 'deleted_id': pid, 'rejected_replacement_ids': rejected}), 500


@app.route('/fire-files/<int:pid>/<variant>')
@login_required
def serve_fire_file(pid, variant):
    if variant not in ('original', 'web', 'thumb'):
        abort(404)
    row = get_db().execute('SELECT * FROM fire_photos WHERE id=?', (pid,)).fetchone()
    if not fire_can_view_photo(current_user(), row, file_access=True):
        abort(404)
    name = row['stored_name'] if variant == 'original' else row[variant + '_name']
    mime = row['mime_type'] if variant == 'original' else 'image/jpeg'
    response = make_response(send_from_directory(UPLOAD_DIR, name, mimetype=mime,
                                                 as_attachment=False, download_name=row['original_name'] if variant == 'original' else name))
    response.headers['Cache-Control'] = 'private, no-store'
    response.headers['X-Content-Type-Options'] = 'nosniff'
    return response


def fire_manifest(db, scope, user):
    if scope != 'all':
        fire_directory(scope)
    owns_snapshot = not db.in_transaction
    if owns_snapshot:
        db.execute('BEGIN')
    try:
        items, snapshot = [], []
        for code, name in FIRE_DIRECTORIES:
            if scope != 'all' and scope != code:
                continue
            rows = fire_current_rows(db, code)
            for number, row in enumerate(rows, 1):
                if not fire_can_view_photo(user, row, file_access=True):
                    raise RuntimeError('照片访问权限已变化，请刷新')
                if not os.path.isfile(os.path.join(UPLOAD_DIR, row['stored_name'])):
                    raise RuntimeError('有照片原件缺失，请联系管理员，刷新后再打印')
                snapshot.append([row[k] for k in ('id', 'directory_code', 'sort_order', 'stored_name', 'width', 'height', 'file_size')])
                items.append({'id': row['id'], 'directory_code': code, 'directory_name': name,
                              'number': number, 'total': len(rows), 'width': row['width'], 'height': row['height'],
                              'url': '/fire-files/%d/original' % row['id']})
        raw = json.dumps(snapshot, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        return {'scope': scope, 'snapshot_hash': hashlib.sha256(raw).hexdigest(), 'total_pages': len(items), 'items': items}
    finally:
        if owns_snapshot:
            db.rollback()


@app.route('/fire/print')
@login_required
def fire_print_page():
    scope = request.args.get('scope', 'all')
    try:
        manifest = fire_manifest(get_db(), scope, current_user())
    except (ValueError, RuntimeError) as exc:
        return jsonify({'error': str(exc)}), 400 if isinstance(exc, ValueError) else 409
    return render_template('fire_print.html', scope=scope, manifest=manifest, v=VERSION)


@app.route('/api/fire/print-manifest')
@login_required
def api_fire_manifest():
    try:
        return jsonify(fire_manifest(get_db(), request.args.get('scope', 'all'), current_user()))
    except (ValueError, RuntimeError) as exc:
        return jsonify({'error': str(exc)}), 400 if isinstance(exc, ValueError) else 409


@app.route('/api/fire/print-check', methods=['POST'])
@login_required
def api_fire_print_check():
    try:
        data = json_body()
        if data is None or set(data) != {'scope', 'snapshot_hash'}:
            raise ValueError('打印校验字段格式不对')
        if not isinstance(data['scope'], str) or not isinstance(data['snapshot_hash'], str) or not re.fullmatch(r'[0-9a-f]{64}', data['snapshot_hash']):
            raise ValueError('打印范围或快照标识不对')
        manifest = fire_manifest(get_db(), data['scope'], current_user())
        if manifest['snapshot_hash'] != data['snapshot_hash']:
            raise RuntimeError('照片或页序已变化，请刷新打印页')
        return jsonify({'ok': True, 'total_pages': manifest['total_pages']})
    except (ValueError, RuntimeError) as exc:
        return jsonify({'error': str(exc)}), 400 if isinstance(exc, ValueError) else 409


# ---------- 统一审核中心 ----------
# 以前要审一样东西，得先找到它在哪儿（点开某份资料 → 翻到附件 → 才有审核按钮），
# 漏一个就一直压着。现在所有等着点头的都汇总到一处，一次处理完。
@app.route('/api/reviews')
@admin_required
def api_reviews():
    """所有待审核的东西：员工新建的资料、新传的附件、新录的仓库物品、新登记的固定资产。"""
    db = get_db()
    out = []

    # 员工修改独立待审；原资料保持有效，审核卡展示最新值与申请差异。
    for e in db.execute("SELECT e.* FROM certificate_edit_requests e"
                        " JOIN certificates c ON c.id=e.cert_id"
                        " WHERE e.status='pending' AND c.active=1 ORDER BY e.id DESC").fetchall():
        parent = db.execute('SELECT * FROM certificates WHERE id=?', (e['cert_id'],)).fetchone()
        item = cert_edit_request_dict(e, parent)
        item.update({'kind': 'cert_edit', 'parent_id': e['cert_id'],
                     'title': parent['name'], 'sub': '资料修改 · 审核前原内容继续生效'})
        out.append(item)

    # 1) 员工新建、还没核过的资料
    for r in db.execute("SELECT * FROM certificates WHERE active=1 AND flow_status='pending'"
                        " ORDER BY created_at DESC").fetchall():
        out.append({
            'kind': 'cert', 'id': r['id'], 'title': r['name'],
            'sub': '新建资料 · %s' % ('员工证照' if r['scope'] == 'employee' else '企业证照'),
            'by': r['created_by'], 'at': r['created_at'], 'thumb_url': None,
        })

    # 2) 传上来还没核过的附件
    for v in db.execute('''SELECT v.*, c.name AS cert_name, c.scope AS cert_scope
                           FROM versions v JOIN certificates c ON c.id = v.cert_id
                           WHERE v.status='pending' AND c.active=1
                           ORDER BY v.uploaded_at DESC''').fetchall():
        out.append({
            'kind': 'version', 'id': v['id'], 'title': v['cert_name'],
            'parent_id': v['cert_id'], 'version_no': v['version_no'],
            'original_name': v['original_name'], 'file_size': v['size'],
            'sub': '第 %d 版附件 · %s' % (v['version_no'], v['original_name'] or '未命名'),
            'by': v['uploaded_by'], 'at': v['uploaded_at'],
            'thumb_url': ('/files/' + v['thumb_name']) if v['thumb_name'] else None,
            'url': ('/files/' + v['web_name']) if v['web_name'] else (
                '/files/' + v['stored_name']) if v['stored_name'] else None,
        })

    # 3) 员工录进来、还没核过的仓库物品
    for it in db.execute("SELECT * FROM inventory_items WHERE active=1 AND status='pending'"
                         " ORDER BY created_at DESC").fetchall():
        d = inv_row_to_dict(it)
        out.append({
            'kind': 'item', 'id': it['id'], 'title': it['name'],
            'sub': '新建物品 · %s · %s%s' % (it['category'], it['quantity'],
                                             (it['unit'] or '个')),
            'by': it['created_by'], 'at': it['created_at'],
            'thumb_url': d.get('thumb_url'),
        })

    # 4) 员工登记进来、还没核过的固定资产
    for a in db.execute("SELECT * FROM assets WHERE active=1 AND review_status='pending'"
                        " ORDER BY created_at DESC").fetchall():
        out.append({
            'kind': 'asset', 'id': a['id'], 'title': a['name'],
            'sub': '新增资产 · %s · %s' % (a['category'] or '未分类', a['location'] or '未填位置'),
            'by': a['created_by'], 'at': a['created_at'],
        })
    # 5) 员工上传的仓库图片：与物品档案分别审核，不能先替换当前图。
    for v in db.execute("SELECT v.*, i.name AS item_name FROM inventory_image_versions v"
                        " JOIN inventory_items i ON i.id=v.item_id"
                        " WHERE v.status='pending' AND i.active=1"
                        " ORDER BY v.uploaded_at DESC").fetchall():
        out.append({
            'kind': 'item_image', 'id': v['id'], 'parent_id': v['item_id'],
            'title': v['item_name'], 'version_no': v['version_no'],
            'sub': '第 %d 版物品图片 · %s' % (v['version_no'], v['original_name'] or '未命名'),
            'original_name': v['original_name'], 'file_size': v['file_size'],
            'by': v['uploaded_by'], 'at': v['uploaded_at'],
            'thumb_url': '/inv-files/' + (v['thumb_name'] or v['web_name']),
            'url': '/inv-files/' + v['web_name'],
        })
    for row in db.execute("SELECT * FROM fire_photos WHERE status='pending' ORDER BY id DESC").fetchall():
        item = fire_photo_dict(row)
        item.update({'kind': 'fire_photo', 'title': row['directory_code'] + ' ' + FIRE_DIRECTORY_NAMES[row['directory_code']],
                     'sub': '消防照片更换' if row['replaces_photo_id'] is not None else '新增消防照片',
                     'by': row['uploaded_by'], 'at': row['uploaded_at'], 'url': item['web_url']})
        out.append(item)
    for row in db.execute("SELECT * FROM fire_photo_order_requests WHERE status='pending' ORDER BY id DESC").fetchall():
        item = fire_order_request_dict(db, row)
        item.update({'kind': 'fire_order', 'title': row['directory_code'] + ' ' + FIRE_DIRECTORY_NAMES[row['directory_code']],
                     'sub': '消防页序调整', 'by': row['requested_by'], 'at': row['requested_at'],
                     'thumb_url': None})
        out.append(item)
    return jsonify({'items': out, 'total': len(out)})


@app.route('/api/reviews/<kind>/<int:rid>', methods=['POST'])
@admin_required
def api_review_one(kind, rid):
    """通过或退回一项。kind：cert 资料 / version 附件 / item 仓库物品 / asset 固定资产。"""
    data = json_body()
    if data is None:
        return jsonify({'error': '提交的数据格式不对，请刷新页面重试'}), 400
    action = data.get('action')
    if action not in ('approve', 'reject'):
        return jsonify({'error': '未知操作'}), 400
    if kind == 'cert_edit':
        return review_certificate_edit(rid, data)

    if kind == 'item_image':
        return review_inventory_image(rid, data)

    if kind == 'fire_photo':
        return review_fire_photo(rid, data)
    if kind == 'fire_order':
        return review_fire_order(rid, data)

    return review_pending_object(kind, rid, data)


@app.route('/files/<name>')
@login_required
def serve_file(name):
    # 附件必须登录后才能取，且不暴露真实路径
    if '/' in name or '\\' in name or '..' in name:
        abort(400)
    db = get_db()
    v = db.execute('SELECT * FROM versions WHERE stored_name=? OR web_name=? OR thumb_name=?',
                   (name, name, name)).fetchone()
    if not v:
        abort(404)
    # 光凭"知道这个随机文件名"就能把图取走是不够规矩的：
    # 图属于哪份资料、资料审没审过，都得跟着一起看（审计 M-05）。
    # 不然列表里藏住了、直链一发照样能拿到。
    c = db.execute('SELECT * FROM certificates WHERE id=?', (v['cert_id'],)).fetchone()
    if not c:
        abort(404)
    if not can_see_cert(c, v):
        abort(404)
    # 按名字判断取的是原图、网页压缩图还是缩略图
    real = v['stored_name']
    inline = (name == v['web_name'] or name == v['thumb_name'])
    if inline:
        response = send_from_directory(UPLOAD_DIR, name)
        response.headers['Cache-Control'] = 'private, no-store'
        return response
    write_log('下载附件', 'certificate', v['cert_id'], v['original_name'])
    db.commit()
    response = send_from_directory(UPLOAD_DIR, real, as_attachment=True,
                                   download_name=v['original_name'])
    response.headers['Cache-Control'] = 'private, no-store'
    return response


# ---------- 酒水单（客人扫码看的公开页 + 管理员维护） ----------
def drink_note():
    """公开页底部的说明文字，管理员改过就用改过的，否则用默认那句。"""
    row = get_db().execute('SELECT value FROM settings WHERE key="drink_note"').fetchone()
    return (row['value'] if row and row['value'] else DEFAULT_DRINK_NOTE)


def _vtag(s):
    """把上传时间变成一串数字，当图片地址的版本号。
    有这个号，图片才能被手机缓存住；换图后号码变了，手机才会重新下载。"""
    return ''.join(ch for ch in (s or '') if ch.isdigit()) or '0'


def drink_page_dict(r):
    d = dict(r)
    v = _vtag(d.get('uploaded_at'))
    d['url'] = '/drink-files/' + (d['web_name'] or d['stored_name']) + '?v=' + v
    d['thumb_url'] = (('/drink-files/' + d['thumb_name'] + '?v=' + v)
                      if d['thumb_name'] else d['url'])
    return d


# 客人侧只需要这几样。上传人、原始文件名、文件大小这些是后台信息，
# 酒水单谁都能打开，不能跟着一起发到客人手机上。
PUBLIC_DRINK_FIELDS = ('id', 'sort_no', 'title', 'url', 'thumb_url')


def public_drink_dict(r):
    d = drink_page_dict(r)
    return {k: d[k] for k in PUBLIC_DRINK_FIELDS}


# 酒水单页图的自动压缩目标：长边像素上限 + 单页体积上限
DRINK_WEB_MAX_SIDE = 1400
DRINK_WEB_MAX_BYTES = 150 * 1024


def save_drink_image(f):
    """存一张酒单图，顺带压出网页版和缩略图。只收 JPG / PNG。
    返回 (stored, web_name, thumb_name, size)；出问题直接抛异常，由调用方回滚。"""
    ext = f.filename.rsplit('.', 1)[-1].lower() if '.' in f.filename else ''
    if ext not in ('jpg', 'jpeg', 'png'):
        raise ValueError('酒单只支持 JPG / PNG 图片')
    base = 'drink_' + secrets.token_hex(8)
    stored = base + '.' + ext
    path = os.path.join(UPLOAD_DIR, stored)
    # 原图的路径先登记进清理名单，再去写盘。
    # 把 f.save 放在自家清理范围之外的话，存到一半断了（磁盘满、权限变了）
    # 磁盘上已经留下半截文件，名单里却没有它 —— 既不在数据库里也删不掉的死角。
    made = [path]
    try:
        f.save(path)
        size = os.path.getsize(path)
        # 空文件直接判失败：不然会留下一条"传上去了但打开是空的"的记录
        if size == 0:
            raise ValueError('这个文件是空的，请重新导出一张再传')
        # 酒单主要在手机上看：宽度 1400 足够清晰，再自动压到 150KB 以内，滑到哪一页都不卡
        web_name, thumb_name = make_web_and_thumb(
            path, ext, base, progressive=True,
            max_side=DRINK_WEB_MAX_SIDE, max_bytes=DRINK_WEB_MAX_BYTES)
        # 图片压不出来说明文件坏了，直接算失败，不留坏数据
        if HAS_PIL and web_name is None:
            raise ValueError('这张图片读不出来，可能已损坏，请重新导出一张')
    except Exception:
        # 自己把落到硬盘上的文件删掉再抛错，别留下没人认领的孤儿文件
        for p in made:
            try:
                os.remove(p)
            except OSError:
                pass
        raise
    return stored, web_name, thumb_name, size


def save_inventory_image(f):
    """存一张仓库物品图：只收 JPG / PNG，压出网页版(大图)和缩略图，
    处理完即删原图省空间。出问题抛异常，由调用方回滚（删已落盘的图）。"""
    ext = f.filename.rsplit('.', 1)[-1].lower() if '.' in f.filename else ''
    if ext not in ('jpg', 'jpeg', 'png'):
        raise ValueError('仓库物品图只支持 JPG / PNG 图片')
    base = 'inv_' + secrets.token_hex(8)
    path = os.path.join(UPLOAD_DIR, base + '.' + ext)
    # 同样先登记再落盘，理由和酒单图那边一样：写在清理范围之外，
    # 中途断了就留下半截没人认领的文件。
    made = [path]
    try:
        f.save(path)
        size = os.path.getsize(path)
        if size == 0:
            raise ValueError('这个文件是空的，请重新选一张')
        # 大图压到 1400 宽、150KB 以内：详情里看得清也不卡流量
        web_name, thumb_name = make_web_and_thumb(
            path, ext, base, progressive=True,
            max_side=INV_WEB_MAX_SIDE, max_bytes=INV_WEB_MAX_BYTES)
        if HAS_PIL and web_name is None:
            raise ValueError('这张图片读不出来，可能已损坏，请重新选一张')
    except Exception:
        for p in made:
            try:
                os.remove(p)
            except OSError:
                pass
        raise
    # 已有压缩的大图，原图没必要留着，删掉省磁盘
    try:
        os.remove(path)
    except OSError:
        pass
    return web_name, thumb_name


def remove_drink_files(*names):
    """删掉硬盘上的图，返回没能删掉的路径列表。

    删不掉的一律登记到 data/待清理.txt 并写一条日志。以前只是悄悄 pass，
    磁盘上慢慢堆起没人认领的旧图，备份越来越大，谁也不知道（审计 S-07）。
    """
    left = []
    for n in names:
        if not n:
            continue
        p = os.path.join(UPLOAD_DIR, n)
        if not os.path.exists(p):
            continue
        try:
            os.remove(p)
        except OSError as e:
            left.append(p)
            _add_pending_cleanup(p, '旧图片没能删掉：%s' % e)
    return left


@app.route('/drinks')
def drinks_page():
    """客人扫码进来的酒水单：不用登录，谁都能看。
    酒单内容直接写进页面里，不再单独请求一次接口——服务器在香港，
    手机上每多一个来回就要多等一两秒。"""
    db = get_db()
    rows = db.execute('SELECT * FROM drink_pages ORDER BY sort_no, id').fetchall()
    pages = [public_drink_dict(r) for r in rows]
    times = [r['uploaded_at'] for r in rows if r['uploaded_at']]
    return render_template('drinks.html', v=VERSION, pages=pages,
                           note=drink_note(),
                           updated_at=(max(times) if times else None))


@app.route('/api/drinks')
def api_drinks():
    """公开接口：只返回酒单图片，不碰证照 / 员工 / 资产任何数据。
    完整信息（存了什么文件名、谁传的、多大）只有管理员能看——
    这几个字段是后台维护用的内部信息，普通员工拿到了没有用，反而漏底。
    """
    db = get_db()
    rows = db.execute('SELECT * FROM drink_pages ORDER BY sort_no, id').fetchall()
    u = current_user()
    pages = [drink_page_dict(r) if (u and u['role'] == 'admin') else public_drink_dict(r)
             for r in rows]
    times = [r['uploaded_at'] for r in rows if r['uploaded_at']]
    return jsonify({'pages': pages, 'note': drink_note(),
                    'updated_at': (max(times) if times else None)})


@app.route('/drink-files/<name>')
def serve_drink_file(name):
    """酒单图片的公开读取口。只认 drink_pages 里登记过的文件名，
    别人拿证照附件的文件名来这里也取不到。

    对外只给网页压缩图和缩略图。原图（上传时存的那一版）不对外：它比压缩图大得多，
    还可能带着相机信息，泄露出去没有好处，客人那边也用不上。
    只有在压不出压缩图的情况下（比如服务器没装图片处理库）才退回到原图，
    否则页面会显示不出来。"""
    if '/' in name or '\\' in name or '..' in name:
        abort(400)
    db = get_db()
    r = db.execute('SELECT id FROM drink_pages'
                   ' WHERE web_name=? OR thumb_name=?', (name, name)).fetchone()
    if not r:
        # 没有压缩图可退的情况才允许取原图，其余一律当作没这个文件
        r = db.execute('SELECT id FROM drink_pages WHERE stored_name=?'
                       ' AND (web_name IS NULL OR web_name="")', (name,)).fetchone()
    if not r:
        abort(404)
    resp = make_response(send_from_directory(UPLOAD_DIR, name))
    # 让手机把图存起来，第二次打开就不用再下一遍。
    # 换图时地址上的版本号会变，手机自然会去取新图，不会一直看到旧的。
    resp.headers['Cache-Control'] = 'public, max-age=86400'
    return resp


@app.route('/inv-files/<name>')
@login_required
def serve_inv_file(name):
    """仓库物品图的读取口，必须登录（仓库图不对外公开）。
    只认登记在 inventory_items 里的压缩图/缩略图文件名，其余一律 404。"""
    if '/' in name or '\\' in name or '..' in name:
        abort(400)
    db = get_db()
    # 必须限 active=1：物品删掉后图片字段仍在，不限的话拿着旧地址还能下载（审计 S-06）
    it = db.execute('SELECT * FROM inventory_items WHERE active=1'
                    ' AND (image_web=? OR image_thumb=?)', (name, name)).fetchone()
    if not it:
        v = db.execute('SELECT * FROM inventory_image_versions'
                       ' WHERE web_name=? OR thumb_name=?', (name, name)).fetchone()
        if not v:
            abort(404)
        it = db.execute('SELECT * FROM inventory_items WHERE id=? AND active=1',
                        (v['item_id'],)).fetchone()
        if not can_see_inventory_image(it, v):
            abort(404)
    # 还得看这物品审没审过：员工刚录进来、还没经管理员点头的，
    # 列表里藏得住，图直链也藏得住才算数（审计 M-05）。
    if not can_see_item(it):
        abort(404)
    resp = make_response(send_from_directory(UPLOAD_DIR, name))
    # 这些图只有登录了才看得到，标成 public 的话，中间的代理可能把它存下来
    # 再发给没登录的人（审计 S-06）。私有内容就按私有内容发。
    resp.headers['Cache-Control'] = 'private, no-store'
    return resp


@app.route('/api/drink-pages', methods=['POST'])
@admin_required
def api_create_drink_page():
    """上传新的一页酒单。只有管理员能传。"""
    if 'file' not in request.files or not request.files['file'].filename:
        return jsonify({'error': '没有选择图片'}), 400
    f = request.files['file']
    db = get_db()
    stored = web_name = thumb_name = None
    try:
        stored, web_name, thumb_name, size = save_drink_image(f)
        last = db.execute('SELECT MAX(sort_no) FROM drink_pages').fetchone()[0]
        db.execute('''INSERT INTO drink_pages (sort_no, title, original_name, stored_name,
            web_name, thumb_name, size, uploaded_by, uploaded_at)
            VALUES (?,?,?,?,?,?,?,?,?)''',
                   ((last or 0) + 1, (request.form.get('title') or '').strip(),
                    f.filename, stored, web_name, thumb_name, size,
                    session.get('name'), now()))
        write_log('上传酒水单图片', 'drink_page', None, f.filename)
        db.commit()
    except Exception as e:
        db.rollback()
        remove_drink_files(stored, web_name, thumb_name)
        msg = str(e) if isinstance(e, ValueError) else '上传失败，请重试'
        return jsonify({'error': msg}), 400
    return jsonify({'ok': True})


@app.route('/api/drink-pages/<int:pid>', methods=['PUT'])
@admin_required
def api_update_drink_page(pid):
    """改标题，或者换掉这一页的图（两个可以只做一个）。"""
    db = get_db()
    p = db.execute('SELECT * FROM drink_pages WHERE id=?', (pid,)).fetchone()
    if not p:
        abort(404)
    title = request.form.get('title')
    f = request.files.get('file')
    new_files = None
    try:
        if f and f.filename:
            new_files = save_drink_image(f)
            stored, web_name, thumb_name, size = new_files
            db.execute('UPDATE drink_pages SET original_name=?, stored_name=?, web_name=?,'
                       ' thumb_name=?, size=?, uploaded_by=?, uploaded_at=? WHERE id=?',
                       (f.filename, stored, web_name, thumb_name, size,
                        session.get('name'), now(), pid))
            write_log('替换酒水单图片', 'drink_page', pid, f.filename)
        if title is not None:
            db.execute('UPDATE drink_pages SET title=? WHERE id=?', (title.strip(), pid))
        db.commit()
        # 新图落库成功，再把旧图文件删掉，避免中途失败导致这一页没图可显示
        if new_files:
            remove_drink_files(p['stored_name'], p['web_name'], p['thumb_name'])
    except Exception as e:
        db.rollback()
        if new_files:
            remove_drink_files(*new_files[:3])
        msg = str(e) if isinstance(e, ValueError) else '保存失败，请重试'
        return jsonify({'error': msg}), 400
    return jsonify({'ok': True})


@app.route('/api/drink-pages/<int:pid>/move', methods=['POST'])
@admin_required
def api_move_drink_page(pid):
    """上一页 / 下一页：跟相邻的那一页交换顺序。"""
    data = json_body()
    if data is None:
        return jsonify({'error': '提交的数据格式不对，请刷新页面重试'}), 400
    direction = data.get('dir')
    if direction not in ('up', 'down'):
        return jsonify({'error': '未知操作'}), 400
    db = get_db()
    rows = db.execute('SELECT id, sort_no FROM drink_pages ORDER BY sort_no, id').fetchall()
    idx = next((i for i, r in enumerate(rows) if r['id'] == pid), None)
    if idx is None:
        abort(404)
    swap = idx - 1 if direction == 'up' else idx + 1
    if swap < 0 or swap >= len(rows):
        return jsonify({'ok': True, 'moved': False})
    db.execute('UPDATE drink_pages SET sort_no=? WHERE id=?', (rows[swap]['sort_no'], rows[idx]['id']))
    db.execute('UPDATE drink_pages SET sort_no=? WHERE id=?', (rows[idx]['sort_no'], rows[swap]['id']))
    db.commit()
    return jsonify({'ok': True, 'moved': True})


@app.route('/api/drink-pages/<int:pid>', methods=['DELETE'])
@admin_required
def api_delete_drink_page(pid):
    db = get_db()
    p = db.execute('SELECT * FROM drink_pages WHERE id=?', (pid,)).fetchone()
    if not p:
        abort(404)
    db.execute('DELETE FROM drink_pages WHERE id=?', (pid,))
    write_log('删除酒水单页面', 'drink_page', pid, p['title'] or p['original_name'])
    db.commit()
    remove_drink_files(p['stored_name'], p['web_name'], p['thumb_name'])
    return jsonify({'ok': True})


@app.route('/api/drink-note', methods=['POST'])
@admin_required
def api_set_drink_note():
    data = json_body()
    if data is None:
        return jsonify({'error': '提交的数据格式不对，请刷新页面重试'}), 400
    note, err = text_in(data, 'note', '底部说明', maxlen=200)
    if err:
        return jsonify({'error': err}), 400
    db = get_db()
    db.execute('INSERT INTO settings (key, value) VALUES ("drink_note", ?)'
               ' ON CONFLICT(key) DO UPDATE SET value=?', (note, note))
    write_log('修改酒水单底部说明', 'drink_page', None, note)
    db.commit()
    return jsonify({'ok': True})


# ---------- 员工 / 健康证 ----------
@app.route('/api/employees')
@login_required
def api_list_employees():
    db = get_db()
    rows = db.execute('SELECT * FROM employees WHERE active=1 ORDER BY name').fetchall()
    out = []
    role = _db_role()
    for r in rows:
        d = dict(r)
        c = db.execute('SELECT * FROM certificates WHERE employee_id=? AND category="健康证"'
                       ' AND active=1 AND flow_status="approved"'
                       ' ORDER BY expiry_date DESC LIMIT 1', (r['id'],)).fetchone()
        # 这份证书本身也得过一遍可见性：不能因为是从"员工档案"这个口子出去，
        # 就把还没审过、或者来源于别人的资料顺带带出来（审计 M-05）。
        if c and can_see_cert(c):
            d['health'] = {'id': c['id'], 'expiry_date': c['expiry_date'], 'cert_no': c['cert_no'],
                           'expiry': expiry_info(c)}
        else:
            d['health'] = None
        # 手机号默认遮挡，仅管理员可见完整（角色以数据库当前值为准，见 _db_role）
        if d.get('phone') and role != 'admin':
            p = d['phone']
            d['phone'] = p[:3] + '****' + p[-4:] if len(p) >= 7 else '****'
        out.append(d)
    return jsonify(out)


@app.route('/api/employees', methods=['POST'])
@admin_required
def api_create_employee():
    data = json_body()
    if data is None:
        return jsonify({'error': '提交的数据格式不对，请刷新页面重试'}), 400
    name, err = text_in(data, 'name', '姓名', required=True)
    if err:
        return jsonify({'error': err}), 400
    position, err = text_in(data, 'position', '职位')
    if err:
        return jsonify({'error': err}), 400
    phone, err = text_in(data, 'phone', '电话', maxlen=30)
    if err:
        return jsonify({'error': err}), 400
    # 员工档案和健康证是"一件事"：以前先提交员工、再写证，中间任何一步出错
    # 就会留下一个没有健康证的空档案。现在放在同一个事务里，要么都成，要么都不落库。
    db = get_db()
    if not _begin_write(db):
        return jsonify({'error': '当前有另一项保存正在进行，请稍后重试'}), 409
    try:
        cur = db.execute('INSERT INTO employees (name, position, phone, created_at) VALUES (?,?,?,?)',
                         (name, position, phone, now()))
        eid = cur.lastrowid
        expiry = data.get('health_expiry')
        if expiry:
            if not isinstance(expiry, str):
                _end_write(db, False)
                return jsonify({'error': '到期日期格式不对'}), 400
            try:
                datetime.date.fromisoformat(expiry.strip())
            except ValueError:
                _end_write(db, False)
                return jsonify({'error': '到期日期格式不对'}), 400
            db.execute('''INSERT INTO certificates (scope, category, name, holder, employee_id,
                expiry_mode, expiry_date, remind_days, flow_status, created_by, created_at)
                VALUES ("employee","健康证",?,?,?, "date", ?, ?, "approved", ?, ?)''',
                       ('%s 的健康证' % name, name, eid,
                        expiry.strip(), DEFAULT_REMIND_DAYS, _owner_tag(), now()))
        write_log('新增员工', 'employee', eid, name)
        if not _end_write(db, True):
            return jsonify({'error': '保存没能完成，请重试一次'}), 500
    except Exception as e:
        _end_write(db, False)
        return jsonify({'error': '保存失败，数据未改动：%s' % e}), 400
    return jsonify({'ok': True, 'id': eid})


# ---------- 健康证（员工只需到期提醒，姓名重复则复用档案） ----------
@app.route('/api/health-certs', methods=['POST'])
@login_required
def api_create_health_cert():
    data = json_body()
    if data is None:
        return jsonify({'error': '提交的数据格式不对，请刷新页面重试'}), 400
    db = get_db()
    u = current_user()
    name, err = text_in(data, 'name', '姓名', required=True)
    if err:
        return jsonify({'error': err}), 400
    position, err = text_in(data, 'position', '职位')
    if err:
        return jsonify({'error': err}), 400
    phone, err = text_in(data, 'phone', '电话', maxlen=30)
    if err:
        return jsonify({'error': err}), 400
    # 日期和提醒天数复用证照那套校验：格式不合规一律返回 400，不让脏数据进库，
    # 也不会因为 int() 抛异常变成 500
    fields, err = clean_cert_fields({
        'expiry_date': data.get('expiry_date'),
        'remind_days': data.get('remind_days') if data.get('remind_days') not in (None, '') else DEFAULT_REMIND_DAYS,
    })
    if err:
        return jsonify({'error': err}), 400
    expiry_date = fields.get('expiry_date')
    remind_days = fields.get('remind_days')
    if not expiry_date:
        return jsonify({'error': '请填写到期日期'}), 400
    # 这几个字段是直接进数据库的，以前没校验：传个 {}（对象）过来 SQLite 不认，
    # 直接抛错变成网页 500。500 本身还没完——出错时前面已经把员工建好了（见审计 M-01）。
    # 所以这里先把类型卡住：不是文字的一律 400 挡回，不让请求走到出错那一步。
    cert_no, err = text_in(data, 'cert_no', '证书编号')
    if err:
        return jsonify({'error': err}), 400
    issuer, err = text_in(data, 'issuer', '发证机构')
    if err:
        return jsonify({'error': err}), 400
    paper_location, err = text_in(data, 'paper_location', '纸质存放位置')
    if err:
        return jsonify({'error': err}), 400
    note, err = text_in(data, 'note', '备注')
    if err:
        return jsonify({'error': err}), 400
    # 姓名查询、员工复用/新建、健康证写入必须在同一把写锁内，
    # 避免两个请求同时查不到员工后各建一份同名档案。
    if not _begin_write(db):
        return jsonify({'error': '当前有另一项保存正在进行，请稍后重试'}), 409
    try:
        emp = db.execute('SELECT * FROM employees WHERE name=? AND active=1', (name,)).fetchone()
        is_admin = bool(u and u['role'] == 'admin')
        if emp:
            eid = emp['id']
            # 补写职位 / 电话属于「改员工档案」，只有管理员能做。
            if is_admin:
                if position and not emp['position']:
                    db.execute('UPDATE employees SET position=? WHERE id=?',
                               (position, eid))
                if phone and not emp['phone']:
                    db.execute('UPDATE employees SET phone=? WHERE id=?',
                               (phone, eid))
        else:
            # 新员工档案和健康证一起落库，写锁保证查与建不可被插入。
            if is_admin:
                cur = db.execute('INSERT INTO employees (name, position, phone, created_at)'
                                 ' VALUES (?,?,?,?)',
                                 (name, position, phone, now()))
            else:
                cur = db.execute('INSERT INTO employees (name, created_at) VALUES (?,?)',
                                 (name, now()))
            eid = cur.lastrowid
            write_log('新增员工', 'employee', eid, name)
        cur = db.execute('''INSERT INTO certificates
            (scope, category, name, cert_no, issuer, holder, employee_id,
             expiry_mode, expiry_date, remind_days, flow_status, paper_location, note, created_by, created_at)
            VALUES ("employee","健康证",?,?,?,?,?, "date", ?, ?, ?, ?, ?, ?, ?)''', (
            name + ' 的健康证', cert_no, issuer, name, eid,
            expiry_date, remind_days,
            'approved' if is_admin else 'pending',
            paper_location, note, _owner_tag(), now()))
        write_log('新增健康证', 'certificate', cur.lastrowid, name)
        if not _end_write(db, True):
            return jsonify({'error': '保存没能完成，请重试一次'}), 500
        return jsonify({'ok': True, 'id': cur.lastrowid, 'employee_id': eid})
    except Exception as exc:
        _end_write(db, False)
        return jsonify({'error': '保存失败，数据未改动：%s' % exc}), 400


# ---------- 资产 ----------
@app.route('/api/assets')
@login_required
def api_list_assets():
    db = get_db()
    status = request.args.get('status')
    q = (request.args.get('q') or '').strip()
    sql = 'SELECT * FROM assets WHERE active=1'
    args = []
    if status:
        sql += ' AND status=?'
        args.append(status)
    if q:
        sql += ' AND (name LIKE ? OR code LIKE ? OR holder LIKE ?)'
        args += ['%%%s%%' % q] * 3
    # 跟资料、仓库一个口径：审过的大家一起看，没审的只给管理员和登记人自己看
    frag, fargs = review_filter('review_status', 'created_by')
    sql += frag
    args += fargs
    sql += ' ORDER BY status DESC, name'
    return jsonify([dict(r) for r in db.execute(sql, args).fetchall()])


@app.route('/api/assets', methods=['POST'])
@login_required
def api_create_asset():
    data = json_body()
    if data is None:
        return jsonify({'error': '提交的数据格式不对，请刷新页面重试'}), 400
    name, err = text_in(data, 'name', '资产名称', required=True)
    if err:
        return jsonify({'error': err}), 400
    code, err = text_in(data, 'code', '资产编号', maxlen=60)
    if err:
        return jsonify({'error': err}), 400
    category, err = text_in(data, 'category', '分类', maxlen=60)
    if err:
        return jsonify({'error': err}), 400
    location, err = text_in(data, 'location', '存放位置', maxlen=120)
    if err:
        return jsonify({'error': err}), 400
    note, err = text_in(data, 'note', '备注')
    if err:
        return jsonify({'error': err}), 400
    db = get_db()
    if not _begin_write(db):
        return jsonify({'error': '当前有另一项保存正在进行，请稍后重试'}), 409
    # 跟仓库一个规矩：员工登记的新资产先挂着等审核，管理员自己登记的直接生效
    try:
        st = 'approved' if can_review() else 'pending'
        cur = db.execute('''INSERT INTO assets (code, name, category, location, status, note,
            created_at, review_status, created_by)
            VALUES (?,?,?,?, "in_stock", ?, ?, ?, ?)''',
                         (code, name, category, location, note, now(), st, _owner_tag()))
        write_log('新增资产', 'asset', cur.lastrowid,
                  name + ('（待审核）' if st == 'pending' else ''))
        if not _end_write(db, True):
            return jsonify({'error': '保存没能完成，请重试一次'}), 500
        return jsonify({'ok': True, 'id': cur.lastrowid, 'review_status': st,
                        'pending': st == 'pending'})
    except Exception as exc:
        _end_write(db, False)
        return jsonify({'error': '保存失败，数据未改动：%s' % exc}), 400


@app.route('/api/assets/<int:aid>/move', methods=['POST'])
@login_required
def api_move_asset(aid):
    data = json_body()
    if data is None:
        return jsonify({'error': '提交的数据格式不对，请刷新页面重试'}), 400
    action = data.get('action')
    person, err = text_in(data, 'person', '领用/归还人', required=True, maxlen=60)
    if err:
        return jsonify({'error': err}), 400
    if action not in ('take', 'return'):
        return jsonify({'error': '未知操作'}), 400
    db = get_db()
    # 先抢写锁再读：两个人同时对同一件东西点"领用"时，另一个必须等第一个办完再读。
    # 否则两个人都读到"这件还在库里"，于是同一件东西被登记给两个人，
    # 页面上只能看到最后一个名字，流水里却躺着两笔"领用"（审计 10/02 S-02 实测过）。
    if not _begin_write(db):
        return jsonify({'error': '当前有另一项资产操作正在进行，请稍后重试'}), 409
    try:
        a = db.execute('SELECT * FROM assets WHERE id=? AND active=1', (aid,)).fetchone()
        if not a:
            _end_write(db, False)
            abort(404)
        # 还没审过的资产不许领用 / 归还：它算不算数还两说，先借出去，回头一退回账就乱了
        if 'review_status' in a.keys() and a['review_status'] != 'approved' and not can_review():
            _end_write(db, False)
            return jsonify({'error': '这件资产还在等管理员审核，审过之后才能领用 / 归还'}), 400
        # 状态和动作对不上就拒绝，避免旧页面把记录改乱
        if action == 'take' and a['status'] == 'taken':
            _end_write(db, False)
            return jsonify({'error': '这件东西已经是领用状态（持有人：%s），不能重复领用'
                            % (a['holder'] or '未知')}), 400
        if action == 'return' and a['status'] != 'taken':
            _end_write(db, False)
            return jsonify({'error': '这件东西现在不在领用状态，不需要归还'}), 400
        ts = now()
        # 最后一道闸：UPDATE 的条件里带上"状态还是我刚才看到的那个"。
        # 锁万一没拦住（以后多机部署、或者请求排得特别挤），晚到的那一笔
        # 一行也改不动——这时候如实告诉人家"被人抢先了"，也不能悄悄记两笔。
        if action == 'take':
            cur = db.execute('UPDATE assets SET status="taken", holder=?, taken_at=?'
                             ' WHERE id=? AND active=1 AND status="in_stock"',
                             (person, ts, aid))
        else:
            cur = db.execute('UPDATE assets SET status="in_stock", holder=NULL, taken_at=NULL'
                             ' WHERE id=? AND active=1 AND status="taken"', (aid,))
        if cur.rowcount != 1:
            _end_write(db, False)
            return jsonify({'error': '这件东西刚刚被别人动了，请刷新看看现在是谁拿着'}), 409
        db.execute('INSERT INTO asset_logs (asset_id, action, person, at, note) VALUES (?,?,?,?,?)',
                   (aid, action, person, ts, data.get('note')))
        write_log('领用' if action == 'take' else '归还', 'asset', aid,
                  '%s %s' % (a['name'], person))
        # 这里的 True/False 必须接住：写进库才算数。提交要是没成功，
        # 再回"成功"就是骗人——页面上写着已领用，库里原封不动（审计第二轮 S-01）。
        if not _end_write(db, True):
            return jsonify({'error': '登记没能保存成功，请重试一次再看看'}), 500
    except Exception:
        _end_write(db, False)
        raise
    return jsonify({'ok': True})


@app.route('/api/assets/<int:aid>/logs')
@login_required
def api_asset_logs(aid):
    db = get_db()
    # 先看这件资产本人能不能看（can_see_asset），看不见的一律 404：
    # 既不留"列表没有、流水却能读"的旁路，也不让人_probe 哪些编号存在。
    a = db.execute('SELECT * FROM assets WHERE id=? AND active=1', (aid,)).fetchone()
    if not a or not can_see_asset(a):
        return jsonify({'error': '这件东西不存在，或者你没有权限查看'}), 404
    return jsonify([dict(r) for r in db.execute(
        'SELECT * FROM asset_logs WHERE asset_id=? ORDER BY id DESC LIMIT 50', (aid,))])


# ---------- 仓库 ----------
INVENTORY_WITH_STOCK_LOG = (
    'SELECT inventory_items.*, (SELECT COALESCE(MAX(id),0) FROM inventory_logs'
    ' WHERE item_id=inventory_items.id) AS stock_log_id FROM inventory_items')


def inv_row_to_dict(row):
    d = dict(row)
    d['expiry'] = expiry_info(row)
    if d.get('image_thumb'):
        d['thumb_url'] = '/inv-files/' + d['image_thumb']
    if d.get('image_web'):
        d['web_url'] = '/inv-files/' + d['image_web']
    return d


def inventory_image_version_dict(row, item):
    d = dict(row)
    d['openable'] = can_see_inventory_image(item, row)
    d['web_url'] = '/inv-files/' + row['web_name'] if d['openable'] else None
    d['thumb_url'] = '/inv-files/' + (row['thumb_name'] or row['web_name']) if d['openable'] else None
    return d


def _register_current_inventory_image(db, item):
    """首次换图时把既有当前图登记成历史基础，不迁移或复制附件。"""
    if not item['image_web']:
        return
    exists = db.execute('SELECT id FROM inventory_image_versions WHERE item_id=?'
                        ' AND web_name=?', (item['id'], item['image_web'])).fetchone()
    if exists:
        return
    number = db.execute('SELECT COALESCE(MAX(version_no),0)+1 FROM inventory_image_versions'
                        ' WHERE item_id=?', (item['id'],)).fetchone()[0]
    db.execute('INSERT INTO inventory_image_versions'
               ' (item_id,version_no,original_name,web_name,thumb_name,status,uploaded_at)'
               ' VALUES (?,?,?,?,?,"approved",?)',
               (item['id'], number, '原有物品图片', item['image_web'], item['image_thumb'], now()))


def review_inventory_image(vid, data):
    """锁内审核具体待审版本，提交成功前不改变当前图或删除任何文件。"""
    db = get_db()
    if not _begin_write(db):
        return jsonify({'error': '图片正在处理，请稍后重试'}), 409
    try:
        v = db.execute('SELECT * FROM inventory_image_versions WHERE id=?', (vid,)).fetchone()
        item = db.execute('SELECT * FROM inventory_items WHERE id=? AND active=1',
                          (v['item_id'],)).fetchone() if v else None
        if not v or not item:
            db.rollback()
            abort(404)
        if v['status'] != 'pending':
            db.rollback()
            return jsonify({'error': '这版图片已处理，请刷新查看结果'}), 409
        action = data['action']
        if action == 'reject':
            reason, err = text_in(data, 'reason', '退回原因', maxlen=200)
            if err or not reason:
                db.rollback()
                return jsonify({'error': err or '请填写退回原因'}), 400
            db.execute('UPDATE inventory_image_versions SET status="rejected", reject_reason=?,'
                       ' reviewed_by=?, reviewed_at=? WHERE id=?',
                       (reason, _me_name(), now(), vid))
            write_log('退回物品图片', 'inventory', item['id'], reason)
        else:
            _register_current_inventory_image(db, item)
            db.execute('UPDATE inventory_image_versions SET status="history"'
                       ' WHERE item_id=? AND status="approved"', (item['id'],))
            db.execute('UPDATE inventory_image_versions SET status="approved", reject_reason=NULL,'
                       ' reviewed_by=?, reviewed_at=? WHERE id=?', (_me_name(), now(), vid))
            db.execute('UPDATE inventory_items SET image_web=?, image_thumb=? WHERE id=?',
                       (v['web_name'], v['thumb_name'], item['id']))
            write_log('审核通过物品图片', 'inventory', item['id'], 'v%d' % v['version_no'])
        db.commit()
    except Exception:
        db.rollback()
        raise
    return jsonify({'ok': True})


def inventory_integer(value):
    """仓库数量只接受整数，不能用 int() 静默截掉小数或把布尔值当数量。"""
    if isinstance(value, bool):
        raise ValueError('数量必须是整数')
    if isinstance(value, int):
        result = value
    elif isinstance(value, float) and value.is_integer():
        result = int(value)
    elif isinstance(value, str) and re.fullmatch(r'[+-]?[0-9]+', value.strip()):
        result = int(value.strip())
    else:
        raise ValueError('数量必须是整数')
    if result < -9223372036854775808 or result > 9223372036854775807:
        raise ValueError('数量超出范围')
    return result


def _stocktake_baseline(data):
    """盘点页面基准必须显式提交 JSON 非负整数，不能改用服务端当前量。"""
    values = []
    for key in ('expected_quantity', 'expected_stock_log_id'):
        value = data.get(key)
        if type(value) is not int or not 0 <= value <= 9223372036854775807:
            raise ValueError('盘点基准缺失或格式不对，请刷新页面后重新清点')
        values.append(value)
    return tuple(values)


def _stocktake_conflict_detail(iid, index, row, baseline):
    return {'id': iid, 'index': index, 'code': 'stocktake_conflict',
            'message': '账面数据已变化，请重新加载账面数据并重新清点',
            'expected_quantity': baseline[0], 'current_quantity': row['quantity'],
            'expected_stock_log_id': baseline[1], 'current_stock_log_id': row['stock_log_id']}


def _inv_validate_common(data, partial):
    """校验物品档案字段（新增/编辑共用）。返回 (整理后的字段 dict, 错误提示)。"""
    out = {}
    known = ('name', 'category', 'spec', 'unit', 'safety_stock', 'expiry_mode',
             'expiry_date', 'warn_days', 'location', 'note')
    keys = [k for k in known if k in data] if partial else list(known)
    for k in keys:
        v = data.get(k)
        if k == 'name':
            v = (v or '').strip() if isinstance(v, str) else v
            if not v:
                return None, '请填写物品名称'
        elif k == 'category':
            v = (v or '').strip() if isinstance(v, str) else v
            if v and v not in INVENTORY_CATEGORIES:
                return None, '分类不在可选范围内'
            v = v or '其它'
        elif k == 'expiry_mode':
            v = v or 'date'
            if v not in EXPIRY_MODES:
                return None, '有效期类型不对'
        elif k == 'expiry_date':
            v = (v or '').strip() if isinstance(v, str) else (v or None)
            if v:
                try:
                    datetime.date.fromisoformat(v)
                except (TypeError, ValueError):
                    return None, '日期格式不对：%s' % v
            else:
                v = None
            if data.get('expiry_mode') == 'date' and not v:
                return None, '有明确到期日时必须填写过期日期'
        elif k == 'safety_stock':
            try:
                v = inventory_integer(0 if v is None or v == '' else v)
            except (TypeError, ValueError):
                return None, '安全库存必须是整数'
            if v < 0:
                return None, '安全库存不能为负数'
        elif k == 'unit':
            # 单位会被页面直接拼进输入框，必须是干净的短文本：
            # 类型不对、太长、带换行控制字符的一律挡回去（见审计 M-05）
            if v is None:
                v = '个'
            if not isinstance(v, str):
                return None, '单位必须是一串文字'
            v = v.strip()
            if len(v) > 10:
                return None, '单位最多 10 个字'
            if any(not (ch == ' ' or ch.isprintable()) for ch in v):
                return None, '单位里不能有换行等特殊字符'
            v = v or '个'
        elif k == 'warn_days':
            try:
                v = int(v or DEFAULT_REMIND_DAYS)
            except (TypeError, ValueError):
                return None, '提前提醒天数必须是数字'
            if v < 0 or v > 3650:
                return None, '提前提醒天数要在 0 到 3650 天之间'
        elif isinstance(v, str):
            v = v.strip()
        out[k] = v
    return out, None


@app.route('/api/inventory/stocktake')
@login_required
def api_inventory_stocktake():
    """按大类一键盘点：返回该类物品当月的期初/采购/领用/结余，供逐行填实盘数。"""
    db = get_db()
    cat = (request.args.get('category') or '').strip()
    if cat and cat not in INVENTORY_CATEGORIES:
        return jsonify({'error': '分类不在可选范围内'}), 400
    sql = INVENTORY_WITH_STOCK_LOG + ' WHERE active=1'
    args = []
    if cat:
        sql += ' AND category=?'
        args.append(cat)
    sql += ' ORDER BY name'
    today = datetime.date.today()
    first = today.strftime('%Y-%m-01')
    if today.month == 12:
        nxt = '%d-01-01' % (today.year + 1)
    else:
        nxt = '%d-%02d-01' % (today.year, today.month + 1)
    rows = []
    for r in db.execute(sql, args).fetchall():
        # 没审过的东西不能进盘点单：藏得住列表藏不住盘点表，等于白藏（审计 M-05）
        if r['status'] != 'approved' or not can_see_item(r):
            continue
        pur = db.execute(
            "SELECT COALESCE(SUM(change_qty),0) FROM inventory_logs WHERE item_id=? AND action='purchase' AND at>=? AND at<?",
            (r['id'], first, nxt)).fetchone()[0]
        con = db.execute(
            "SELECT COALESCE(SUM(ABS(change_qty)),0) FROM inventory_logs WHERE item_id=? AND action='consume' AND at>=? AND at<?",
            (r['id'], first, nxt)).fetchone()[0]
        month_purchase = int(pur)
        month_consume = int(con)
        rows.append({
            'id': r['id'], 'name': r['name'], 'spec': r['spec'], 'unit': r['unit'],
            'month_begin': r['quantity'] - month_purchase + month_consume,
            'month_purchase': month_purchase, 'month_consume': month_consume,
            'quantity': r['quantity'], 'stock_log_id': r['stock_log_id'],
        })
    return jsonify({'month': today.strftime('%Y-%m'), 'rows': rows,
                    'categories': INVENTORY_CATEGORIES})


@app.route('/api/inventory/stocktake', methods=['POST'])
@login_required
def api_inventory_stocktake_post():
    """批量盘点：只把实盘数与账面不同的项写入 adjust 流水，账实相符不重复记。"""
    data = json_body()
    if data is None:
        return jsonify({'error': '提交的数据格式不对，请刷新页面重试'}), 400
    items = data.get('items')
    if not isinstance(items, list) or not items:
        return jsonify({'error': '没有要盘点的项'}), 400
    # 新增基准字段与重复 ID 属于整批错误，在取得业务写锁前全部校验。
    baselines = {}
    seen = set()
    for index, it in enumerate(items):
        if not isinstance(it, dict):
            continue  # 既有的逐项格式错误仍在下面报告
        try:
            baselines[index] = _stocktake_baseline(it)
        except ValueError as e:
            return jsonify({'error': str(e)}), 400
        try:
            iid = inventory_integer(it.get('id'))
        except (TypeError, ValueError):
            continue
        if iid in seen:
            return jsonify({'error': '盘点物品编号重复，请刷新页面后重新清点'}), 400
        seen.add(iid)
    db = get_db()
    done = []
    errors = []
    errors_detail = []
    unchanged = []
    # 一键盘点是一整批货一起改：先把写锁拿到手再开始读，
    # 不然两个人同时盘同一批，各自读到旧数字、互相覆盖，账就乱了。
    if not _begin_inventory_write(db):
        return jsonify({'error': '库存正在处理，请稍后重试'}), 409
    try:
        prepared = []
        conflicts = []
        for index, it in enumerate(items):
            iid = None
            def item_error(message):
                errors.append(message)
                errors_detail.append({'id': iid, 'index': index, 'message': message})
            if not isinstance(it, dict):
                item_error('有一项格式不对')
                continue
            try:
                iid = inventory_integer(it.get('id'))
                actual = inventory_integer(it.get('actual'))
            except (TypeError, ValueError):
                item_error('物品编号和实物数量必须是整数')
                continue
            if actual < 0:
                item_error('实物数量不能为负数')
                continue
            r, msg = _load_item_for_write(db, iid)
            if not r:
                item_error(msg or ('物品不存在或已删除(id=%d)' % iid))
                continue
            baseline = baselines[index]
            if (r['quantity'], r['stock_log_id']) != baseline:
                conflicts.append(_stocktake_conflict_detail(iid, index, r, baseline))
            prepared.append((iid, actual, r))
        # 所有可操作行先比较两个基准，再写任意一笔库存、流水和业务日志。
        if conflicts:
            db.rollback()
            return jsonify({'error': CONCURRENT_HINT, 'code': 'stocktake_conflict',
                            'errors_detail': conflicts}), 409
        for iid, actual, r in prepared:
            diff = actual - r['quantity']
            if diff == 0:
                unchanged.append(iid)
                continue
            # 只在库存还是刚才看到的数字时才写入，被别人抢先改了就整批撤回，
            # 免得盘出一半对、一半错的糊涂账
            if not _save_inventory_quantity(db, iid, actual, r['quantity']):
                db.rollback()
                return jsonify({'error': CONCURRENT_HINT}), 409
            note = '盘盈 %d' % diff if diff > 0 else '盘亏 %d' % (-diff)
            db.execute(
                '''INSERT INTO inventory_logs (item_id, action, change_qty, after_qty, operator, at, note)
                   VALUES (?, 'adjust', ?, ?, ?, ?, ?)''',
                (iid, diff, actual, session.get('name') or '系统', now(), note))
            write_log('盘点', 'inventory', iid, '%s %s' % (r['name'], note))
            done.append({'id': iid, 'name': r['name'], 'diff': diff, 'quantity': actual})
        db.commit()
    except Exception:
        db.rollback()          # 盘到一半出错：整批撤回，不留半截账
        raise
    if not done and errors:
        return jsonify({'error': '；'.join(errors), 'errors': errors,
                        'errors_detail': errors_detail, 'unchanged': unchanged}), 400
    return jsonify({'ok': True, 'done': done, 'errors': errors,
                    'errors_detail': errors_detail, 'unchanged': unchanged})


@app.route('/api/inventory')
@login_required
def api_list_inventory():
    db = get_db()
    q = (request.args.get('q') or '').strip()
    cat = (request.args.get('category') or '').strip()
    sql = INVENTORY_WITH_STOCK_LOG + ' WHERE active=1'
    args = []
    if cat:
        sql += ' AND category=?'
        args.append(cat)
    if q:
        sql += ' AND (name LIKE ? OR spec LIKE ? OR location LIKE ?)'
        args += ['%%%s%%' % q] * 3
    # 员工录进来、还没审的物品，只有他本人和管理员看得到
    extra, extra_args = review_filter('status', 'created_by')
    sql += extra
    args += extra_args
    sql += ' ORDER BY category, name'
    return jsonify([inv_row_to_dict(r) for r in db.execute(sql, args).fetchall()])


@app.route('/api/inventory', methods=['POST'])
@login_required
def api_create_inventory():
    """新增仓库物品。

    以前写死了"只有管理员能录"，员工想加一件酒水只能找管理员，
    管理员又不一定在店里。现在员工也能录，但要管理员点头才算数：
    员工录的先停在"待审核"，管理员录的直接生效。
    """
    data = json_body()
    if data is None:
        return jsonify({'error': '提交的数据格式不对，请刷新页面重试'}), 400
    db = get_db()
    f, err = _inv_validate_common(data, partial=False)
    if err:
        return jsonify({'error': err}), 400
    f['name'] = f.get('name') or '未命名物品'
    try:
        value = data.get('quantity')
        qty0 = inventory_integer(0 if value is None or value == '' else value)
    except (TypeError, ValueError):
        return jsonify({'error': '当前库存必须是整数'}), 400
    if qty0 < 0:
        return jsonify({'error': '当前库存不能为负数'}), 400
    # 管理员录的直接通过；员工录的进"待审核"，等管理员在审核中心点头
    status = 'approved' if can_review() else 'pending'
    who = _owner_tag()
    cur = db.execute(
        '''INSERT INTO inventory_items
           (name, category, spec, unit, quantity, safety_stock, expiry_mode,
            expiry_date, warn_days, location, note, status, created_by, reviewed_by,
            reviewed_at, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)''',
        (f['name'], f['category'], f.get('spec'), f.get('unit') or '个',
         qty0, f.get('safety_stock') or 0, f['expiry_mode'], f.get('expiry_date'),
         f.get('warn_days') or DEFAULT_REMIND_DAYS, f.get('location'), f.get('note'),
         status, who,
         who if status == 'approved' else None,
         now() if status == 'approved' else None,
         now()))
    iid = cur.lastrowid
    if qty0 > 0:
        db.execute(
            '''INSERT INTO inventory_logs (item_id, action, change_qty, after_qty, operator, at, note)
               VALUES (?, 'initial', ?, ?, ?, ?, ?)''',
            (iid, qty0, qty0, session.get('name') or '系统', now(), '期初建账'))
    write_log('新增物品', 'inventory', iid, '%s（%s）' % (f['name'], status))
    db.commit()
    return jsonify({'ok': True, 'id': iid, 'status': status,
                    'msg': None if status == 'approved' else '已提交，等管理员审核后才会出现在大家的列表里'})


@app.route('/api/inventory/<int:iid>')
@login_required
def api_get_inventory(iid):
    db = get_db()
    cond, args = review_filter('status', 'created_by')
    r = db.execute(INVENTORY_WITH_STOCK_LOG + ' WHERE id=? AND active=1%s' % cond,
                   [iid] + args).fetchone()
    if not r:
        abort(404)
    d = inv_row_to_dict(r)
    cond, args = review_filter('status', 'uploaded_by')
    d['image_versions'] = [inventory_image_version_dict(v, r) for v in db.execute(
        'SELECT * FROM inventory_image_versions WHERE item_id=?' + cond +
        ' ORDER BY version_no DESC', [iid] + args)]
    d['logs'] = [dict(x) for x in db.execute(
        'SELECT * FROM inventory_logs WHERE item_id=? ORDER BY id DESC LIMIT 100', (iid,))]
    return jsonify(d)


@app.route('/api/inventory/<int:iid>', methods=['PUT'])
@admin_required
def api_update_inventory(iid):
    data = json_body()
    if data is None:
        return jsonify({'error': '提交的数据格式不对，请刷新页面重试'}), 400
    db = get_db()
    r = db.execute('SELECT * FROM inventory_items WHERE id=? AND active=1', (iid,)).fetchone()
    if not r:
        abort(404)
    # 编辑只改档案字段，不动库存数量（数量变化只能走入库/出库/盘点）
    f, err = _inv_validate_common(data, partial=True)
    if err:
        return jsonify({'error': err}), 400
    sets, args = [], []
    for k in ('name', 'category', 'spec', 'unit', 'safety_stock', 'expiry_mode',
              'expiry_date', 'warn_days', 'location', 'note'):
        if k in f:
            sets.append('%s=?' % k)
            args.append(f[k])
    if not sets:
        return jsonify({'ok': True})
    db.execute('UPDATE inventory_items SET %s WHERE id=?' % ','.join(sets), args + [iid])
    write_log('编辑物品', 'inventory', iid, r['name'])
    db.commit()
    return jsonify({'ok': True})


@app.route('/api/inventory/<int:iid>', methods=['DELETE'])
@admin_required
def api_delete_inventory(iid):
    data = json_body() or {}
    db = get_db()
    if not _begin_write(db):
        return jsonify({'error': '物品正在处理，请稍后重试'}), 409
    r = db.execute('SELECT * FROM inventory_items WHERE id=? AND active=1', (iid,)).fetchone()
    if not r:
        abort(404)
    # 高风险：必须手输名称，后端再核一遍，不能只在前端比对
    typed = (data.get('confirm_name') or '').strip()
    if typed != r['name']:
        return jsonify({'error': '输入的名称不一致，已取消删除'}), 400
    # 先落库、后删文件：删项和上面移除图片是一个道理，
    # 真要在提交成功之前就把图抹了，一旦提交失败，这条记录就成了"有记载没东西"。
    try:
        images = db.execute('SELECT web_name,thumb_name FROM inventory_image_versions'
                            ' WHERE item_id=?', (iid,)).fetchall()
        db.execute('UPDATE inventory_items SET active=0 WHERE id=?', (iid,))
        db.execute('DELETE FROM inventory_image_versions WHERE item_id=?', (iid,))
        write_log('删除物品', 'inventory', iid, r['name'])
        db.commit()
    except Exception:
        db.rollback()
        raise
    remove_drink_files(r['image_web'], r['image_thumb'])   # 删物品一并清掉它的图
    remove_drink_files(*{name for v in images for name in (v['web_name'], v['thumb_name'])
                        if name and name not in (r['image_web'], r['image_thumb'])})
    return jsonify({'ok': True})


def _begin_inventory_write(db):
    """开始一次改库存的动作：立刻把写锁拿到手。

    服务器上是两个进程同时接活的，两个人同时给同一件东西出库时，
    两个进程可能都读到"还剩 10"，各自扣掉后剩 8，流水里却记着两次 -2，
    结果东西实际少了 4、账面只少 2，盘的时候就对不上了。
    这里先抢锁：谁先进来谁改，另一个乖乖等，等完再读到的就是新数字。
    （锁的做法现在是全站通用的 _begin_write，这里只是沿用原来的名字。）
    """
    return _begin_write(db)


def _save_inventory_quantity(db, iid, new_qty, expected_old):
    """只在库存还等于 expected_old 时才写入新数量，成功 True、失败 False。

    光靠 UPDATE 还不够：万一锁没拦住（比如以后换了好几台机器同时跑），
    这条 SQL 里的 AND quantity=? 就是最后一道闸——
    数字已经不是我刚才看到的那个了，这一次就作废，让客人重来一遍，
    总比悄悄记错一笔账强。
    """
    cur = db.execute(
        'UPDATE inventory_items SET quantity=? WHERE id=? AND quantity=? AND active=1',
        (new_qty, iid, expected_old))
    return cur.rowcount == 1


CONCURRENT_HINT = '库存刚被别人改动过，请刷新后重来一次'


@app.route('/api/inventory/<int:iid>/in', methods=['POST'])
@login_required
def api_inventory_in(iid):
    data = json_body()
    if data is None:
        return jsonify({'error': '提交的数据格式不对，请刷新页面重试'}), 400
    try:
        qty = inventory_integer(data.get('qty'))
    except (TypeError, ValueError):
        return jsonify({'error': '入库数量必须是整数'}), 400
    if qty <= 0:
        return jsonify({'error': '入库数量要大于 0'}), 400
    supplier, err = text_in(data, 'supplier', '供应商')
    if err:
        return jsonify({'error': err}), 400
    note, err = text_in(data, 'note', '备注')
    if err:
        return jsonify({'error': err}), 400
    db = get_db()
    _begin_inventory_write(db)
    try:
        r, msg = _load_item_for_write(db, iid)
        if not r:
            db.rollback()
            if msg is None:
                abort(404)
            return jsonify({'error': msg}), 400
        after = r['quantity'] + qty
        if after > 9223372036854775807:
            db.rollback()
            return jsonify({'error': '入库后数量超出范围'}), 400
        if not _save_inventory_quantity(db, iid, after, r['quantity']):
            db.rollback()
            return jsonify({'error': CONCURRENT_HINT}), 409
        db.execute(
            '''INSERT INTO inventory_logs (item_id, action, change_qty, after_qty, supplier, operator, at, note)
               VALUES (?, 'purchase', ?, ?, ?, ?, ?, ?)''',
            (iid, qty, after, supplier,
             session.get('name') or '系统', now(), note))
        write_log('采购入库', 'inventory', iid, '%s +%d' % (r['name'], qty))
        db.commit()
    except Exception:
        db.rollback()
        raise
    return jsonify({'ok': True, 'quantity': after})


@app.route('/api/inventory/<int:iid>/out', methods=['POST'])
@login_required
def api_inventory_out(iid):
    data = json_body()
    if data is None:
        return jsonify({'error': '提交的数据格式不对，请刷新页面重试'}), 400
    try:
        qty = inventory_integer(data.get('qty'))
    except (TypeError, ValueError):
        return jsonify({'error': '出库数量必须是整数'}), 400
    if qty <= 0:
        return jsonify({'error': '出库数量要大于 0'}), 400
    note, err = text_in(data, 'note', '备注')
    if err:
        return jsonify({'error': err}), 400
    db = get_db()
    # 出库前先把锁拿到手再读余量。反过来的话，两个人都读到"还剩 10"、
    # 各自都觉得够扣，结果东西实际少了双倍，账面却只扣一次。
    _begin_inventory_write(db)
    try:
        r, msg = _load_item_for_write(db, iid)
        if not r:
            db.rollback()
            if msg is None:
                abort(404)
            return jsonify({'error': msg}), 400
        if r['quantity'] < qty:
            db.rollback()
            return jsonify({'error': '库存不足：当前只有 %d %s' % (r['quantity'], r['unit'])}), 400
        after = r['quantity'] - qty
        if not _save_inventory_quantity(db, iid, after, r['quantity']):
            db.rollback()
            return jsonify({'error': CONCURRENT_HINT}), 409
        db.execute(
            '''INSERT INTO inventory_logs (item_id, action, change_qty, after_qty, operator, at, note)
               VALUES (?, 'consume', ?, ?, ?, ?, ?)''',
            (iid, -qty, after, session.get('name') or '系统', now(), note))
        write_log('消耗出库', 'inventory', iid, '%s -%d' % (r['name'], qty))
        db.commit()
    except Exception:
        db.rollback()
        raise
    return jsonify({'ok': True, 'quantity': after})


@app.route('/api/inventory/<int:iid>/count', methods=['POST'])
@login_required
def api_inventory_count(iid):
    data = json_body()
    if data is None:
        return jsonify({'error': '提交的数据格式不对，请刷新页面重试'}), 400
    try:
        actual = inventory_integer(data.get('actual'))
    except (TypeError, ValueError):
        return jsonify({'error': '实物数量必须是整数'}), 400
    if actual < 0:
        return jsonify({'error': '实物数量不能为负数'}), 400
    try:
        baseline = _stocktake_baseline(data)
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    db = get_db()
    # 盘点同理：先抢锁再看账上的数，不然两个人同时盘同一件东西会互相覆盖。
    if not _begin_inventory_write(db):
        return jsonify({'error': '库存正在处理，请稍后重试'}), 409
    try:
        r, msg = _load_item_for_write(db, iid)
        if not r:
            db.rollback()
            if msg is None:
                abort(404)
            return jsonify({'error': msg}), 400
        if (r['quantity'], r['stock_log_id']) != baseline:
            db.rollback()
            return jsonify({'error': CONCURRENT_HINT, 'code': 'stocktake_conflict',
                            'errors_detail': [_stocktake_conflict_detail(iid, 0, r, baseline)]}), 409
        diff = actual - r['quantity']
        if not _save_inventory_quantity(db, iid, actual, r['quantity']):
            db.rollback()
            return jsonify({'error': CONCURRENT_HINT}), 409
        note = '账实相符' if diff == 0 else ('盘盈 %d' % diff if diff > 0 else '盘亏 %d' % (-diff))
        db.execute(
            '''INSERT INTO inventory_logs (item_id, action, change_qty, after_qty, operator, at, note)
               VALUES (?, 'adjust', ?, ?, ?, ?, ?)''',
            (iid, diff, actual, session.get('name') or '系统', now(), note))
        write_log('盘点', 'inventory', iid, '%s %s' % (r['name'], note))
        db.commit()
    except Exception:
        db.rollback()
        raise
    return jsonify({'ok': True, 'quantity': actual, 'diff': diff})


@app.route('/api/inventory/<int:iid>/logs')
@login_required
def api_inventory_logs(iid):
    db = get_db()
    # 先看这东西给不给看，再谈它的流水：换成独立的地址就把过滤绕过去了（审计 M-05）
    cond, args = review_filter('status', 'created_by')
    it = db.execute('SELECT * FROM inventory_items WHERE id=? AND active=1%s' % cond,
                    [iid] + args).fetchone()
    if not it:
        abort(404)
    return jsonify([dict(r) for r in db.execute(
        'SELECT * FROM inventory_logs WHERE item_id=? ORDER BY id DESC LIMIT 100', (iid,))])


@app.route('/api/inventory/<int:iid>/image', methods=['POST'])
@login_required
def api_inventory_image(iid):
    db = get_db()
    r = db.execute('SELECT * FROM inventory_items WHERE id=? AND active=1', (iid,)).fetchone()
    if not r or not can_see_item(r):
        abort(404)
    f = request.files.get('file')
    if not f or not f.filename:
        return jsonify({'error': '请先选择一张图片'}), 400
    f.seek(0, os.SEEK_END)
    file_size = f.tell()
    f.seek(0)
    try:
        web_name, thumb_name = save_inventory_image(f)
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    except Exception:
        return jsonify({'error': '图片处理失败，请换一张再试'}), 500
    try:
        if not web_name:
            raise ValueError('无法生成图片预览，请重新选择图片')
        if not _begin_write(db):
            remove_drink_files(web_name, thumb_name)
            return jsonify({'error': '图片正在处理，请稍后重试'}), 409
        # 解码期间可能已删物品或变更归属，拿锁后必须重新确认。
        r = db.execute('SELECT * FROM inventory_items WHERE id=? AND active=1', (iid,)).fetchone()
        if not r or not can_see_item(r):
            db.rollback()
            remove_drink_files(web_name, thumb_name)
            abort(404)
        _register_current_inventory_image(db, r)
        number = db.execute('SELECT COALESCE(MAX(version_no),0)+1 FROM inventory_image_versions'
                            ' WHERE item_id=?', (iid,)).fetchone()[0]
        status = 'approved' if _db_role() == 'admin' else 'pending'
        if status == 'approved':
            db.execute('UPDATE inventory_image_versions SET status="history"'
                       ' WHERE item_id=? AND status="approved"', (iid,))
            db.execute('UPDATE inventory_items SET image_web=?, image_thumb=? WHERE id=?',
                       (web_name, thumb_name, iid))
        ts = now()
        cur = db.execute('INSERT INTO inventory_image_versions'
                         ' (item_id,version_no,original_name,file_size,web_name,thumb_name,status,'
                         'uploaded_by,uploaded_at,reviewed_by,reviewed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
                         (iid, number, f.filename, file_size, web_name, thumb_name, status,
                          _my_account(), ts, _me_name() if status == 'approved' else None,
                          ts if status == 'approved' else None))
        vid = cur.lastrowid
        write_log('上传物品图片', 'inventory', iid, '%s v%d（%s）' % (r['name'], number, status))
        db.commit()
    except Exception:
        # 数据库这一笔没能记下来，刚传的图就成了"查无此主"的孤儿，必须连带删掉，
        # 否则目录里只进不出，久了白白占空间。
        db.rollback()
        remove_drink_files(web_name, thumb_name)
        raise
    v = db.execute('SELECT * FROM inventory_image_versions WHERE id=?', (vid,)).fetchone()
    return jsonify({'ok': True, 'status': status, 'version': inventory_image_version_dict(v, r),
                    'web_url': '/inv-files/' + web_name,
                    'thumb_url': '/inv-files/' + (thumb_name or web_name)})


@app.route('/api/inventory/<int:iid>/image', methods=['DELETE'])
@admin_required
def api_inventory_image_del(iid):
    db = get_db()
    if not _begin_write(db):
        return jsonify({'error': '图片正在处理，请稍后重试'}), 409
    r = db.execute('SELECT * FROM inventory_items WHERE id=? AND active=1', (iid,)).fetchone()
    if not r:
        abort(404)
    # 顺序反了是大麻烦：先删文件再提交数据库的话，万一提交没成，
    # 数据库里还写着这个图，点开却是一片空白 —— 图已经不在了。
    # 正确做法是先把数据库的记录抹掉并确认成功，再去动硬盘上的图。
    try:
        images = db.execute('SELECT web_name,thumb_name FROM inventory_image_versions'
                            ' WHERE item_id=?', (iid,)).fetchall()
        db.execute('UPDATE inventory_items SET image_web=NULL, image_thumb=NULL WHERE id=?',
                   (iid,))
        db.execute('DELETE FROM inventory_image_versions WHERE item_id=?', (iid,))
        write_log('移除物品图片', 'inventory', iid, r['name'])
        db.commit()
    except Exception:
        db.rollback()
        raise
    remove_drink_files(r['image_web'], r['image_thumb'])
    remove_drink_files(*{name for v in images for name in (v['web_name'], v['thumb_name'])
                        if name and name not in (r['image_web'], r['image_thumb'])})
    return jsonify({'ok': True})


# ---------- 设置 ----------
@app.route('/api/password', methods=['POST'])
@login_required
def api_change_password():
    data = json_body()
    if data is None:
        return jsonify({'error': '提交的数据格式不对，请刷新页面重试'}), 400
    # 密码不套 clean_text：它会顺手把首尾空格去掉，而密码首尾带空格是合法的，
    # 一 strip 就等于改了用户的密码。这里只挡"根本不是字符串"这种会炸的情况。
    cur_pwd = data.get('current')
    new = data.get('new')
    if not isinstance(cur_pwd, str) or not isinstance(new, str):
        return jsonify({'error': '密码格式不对，请重新输入'}), 400
    if len(new) > 200:
        return jsonify({'error': '密码太长了'}), 400
    u = current_user()
    db = get_db()
    if not check_password_hash(u['password_hash'], cur_pwd):
        return jsonify({'error': '当前密码不正确'}), 400
    if len(new) < 6:
        return jsonify({'error': '新密码至少 6 位'}), 400
    ts = now()
    db.execute('UPDATE users SET password_hash=?, pwd_changed_at=? WHERE id=?',
               (generate_password_hash(new), now_ms(), u['id']))
    write_log('修改密码', 'user', u['id'])
    db.commit()
    ok, reason = clear_initial_password_file()
    # 改完密码，所有还开着的页面都必须重新登录（包括当前这个）
    session.clear()
    return jsonify({'ok': True, 'relogin': True,
                    'warn': None if ok else reason})


@app.route('/api/users')
@admin_required
def api_list_users():
    db = get_db()
    # 只列还在用的账号：删掉的从这张表里消失，看着就是「删没了」
    return jsonify([{'id': r['id'], 'username': r['username'], 'name': r['name'],
                     'role': r['role'], 'active': r['active'], 'last_login': r['last_login']}
                    for r in db.execute('SELECT * FROM users WHERE active=1 ORDER BY id').fetchall()])


@app.route('/api/users', methods=['POST'])
@admin_required
def api_create_user():
    data = json_body()
    if data is None:
        return jsonify({'error': '提交的数据格式不对，请刷新页面重试'}), 400
    username, err = text_in(data, 'username', '登录账号', required=True, maxlen=60)
    if err:
        return jsonify({'error': err}), 400
    name, err = text_in(data, 'name', '姓名', maxlen=60)
    if err:
        return jsonify({'error': err}), 400
    role = data.get('role') or 'staff'
    if not isinstance(role, str) or role not in ('admin', 'staff'):
        return jsonify({'error': '角色不在可选范围内'}), 400
    pwd_raw = data.get('password')
    if pwd_raw is not None and (not isinstance(pwd_raw, str) or len(pwd_raw) < 6):
        return jsonify({'error': '密码至少 6 位'}), 400
    db = get_db()
    pwd = pwd_raw or secrets.token_urlsafe(6)
    name = name or username
    if not _begin_write(db):
        return jsonify({'error': '当前有另一项账号保存正在进行，请稍后重试'}), 409
    try:
        old = db.execute('SELECT * FROM users WHERE username=?', (username,)).fetchone()
        if old and old['active']:
            _end_write(db, False)
            return jsonify({'error': '账号已存在'}), 400
        if old:
            # 同名的是一个早先删掉的账号（比如员工离职后又回来上班）：
            # 直接重新启用并重设密码，免得明摆着没人用却提示「账号已存在」建不了
            db.execute('UPDATE users SET password_hash=?, name=?, role=?, active=1,'
                       ' pwd_changed_at=? WHERE id=?',
                       (generate_password_hash(pwd), name, role, now_ms(), old['id']))
            write_log('恢复账号', 'user', old['id'], username)
            if not _end_write(db, True):
                return jsonify({'error': '保存没能完成，请重试一次'}), 500
            return jsonify({'ok': True, 'password': pwd, 'reused': True})
        db.execute('INSERT INTO users (username, password_hash, name, role, created_at) VALUES (?,?,?,?,?)',
                   (username, generate_password_hash(pwd), name, role, now()))
        write_log('新建账号', 'user', None, username)
        if not _end_write(db, True):
            return jsonify({'error': '保存没能完成，请重试一次'}), 500
        return jsonify({'ok': True, 'password': pwd})
    except Exception as exc:
        _end_write(db, False)
        return jsonify({'error': '保存失败，数据未改动：%s' % exc}), 400


@app.route('/api/users/<int:uid>', methods=['DELETE'])
@admin_required
def api_delete_user(uid):
    """删（停用）一个账号。

    不是从库里彻底抹掉，而是标成「停用」——这个账号什么时候建的、做过什么，
    台账里还得能查到；真抹干净了以后出问题就查无对证。
    登录和之后的每次请求都只认还启用着的账号，所以这里一停用，
    对方再点任何地方都会被踢回登录页，效果和立刻失效一样。

    两道不能碰的线：一是自己正在用的账号（删完你自己就登不出去了），
    二是最后一个管理员（全删光就没人管后台了）。
    """
    db = get_db()
    me = current_user()
    if me and uid == me['id']:
        return jsonify({'error': '不能删自己正在用的这个账号，删完你就登不出去了'}), 400
    # "还剩几个管理员"和"把这行停用"必须在同一把写锁里做完。
    # 两个管理员互相删对方时，两个进程可能都先读到"还剩两个管理员"，
    # 于是都认为自己不是最后一个，双双通过，最后管理员被删到 0、
    # 后台一个人也进不去（审计 10/02 M-02 实测过）。
    if not _begin_write(db):
        return jsonify({'error': '当前有另一项账号操作正在进行，请稍后重试'}), 409
    try:
        u = db.execute('SELECT * FROM users WHERE id=? AND active=1', (uid,)).fetchone()
        if not u:
            _end_write(db, False)
            return jsonify({'error': '账号不存在，或者已经删掉了'}), 404
        if u['role'] == 'admin':
            left = db.execute('SELECT COUNT(*) AS c FROM users WHERE role=? AND active=1',
                              ('admin',)).fetchone()['c']
            if left <= 1:
                _end_write(db, False)
                return jsonify({'error': '至少要留一个管理员账号，删光了就没人能管后台了'}), 400
        # 条件里带上 active=1：同一秒里被点了两次删除时，第二次一行也改不动
        cur = db.execute('UPDATE users SET active=0 WHERE id=? AND active=1', (uid,))
        if cur.rowcount != 1:
            _end_write(db, False)
            return jsonify({'error': '这个账号刚刚已经被删掉了'}), 409
        # 把这个账号身上所有还开着的页面统统踢下线，见 _void_sessions 的说明
        _void_sessions(db, uid)
        write_log('删除账号', 'user', uid, u['username'])
        # 没真正落库就不能说"删好了"——否则页面上人没了，刷新又回来
        if not _end_write(db, True):
            return jsonify({'error': '删除没能保存成功，请重试一次'}), 500
    except Exception:
        _end_write(db, False)
        raise
    return jsonify({'ok': True})


ONEOFF_REVIEW_KEY = 'oneoff_review_1_10'
ONEOFF_DRAFT_KEY = 'oneoff_draft_1_11'
# 这两笔整理各配一个"只管哪一刻之前的老数据"的记录。以前这个时间点是临时
# 算出来的：顺利时看不出区别，一旦失败就随回滚一起消失，下次重试会把
# 故障后新提交的资料也当成历史数据（详见 _claim_oneoff_cutoff 的说明）。
ONEOFF_REVIEW_CUTOFF_KEY = 'oneoff_review_1_10_cutoff'
ONEOFF_DRAFT_CUTOFF_KEY = 'oneoff_draft_1_11_cutoff'


def _claim_oneoff_cutoff(key):
    """先把"这次整理只管哪一刻之前的老数据"单独落到 settings 里再动手。

    为什么非要先单独落盘：以前这个时间点（cutoff）是当场算出来拿着就去批量改，
    改失败了就回滚，cutoff 也跟着没了。下次开机重试时会重新取一个"当下"，
    于是上次故障之后到这次之间新提交的待审资料，也被算进"老数据"直接批成
    通过——等于替管理员放行了没人审过的东西（审计 10/03 全站验收 M-03）。

    现在先把它写进库：谁先写进去算谁的，之后不管是重试还是另一个进程，都用
    同一个时间点，范围只会保持不变，绝不会一次比一次新。

    成功返回这个时间点，写不进去返回 None——时间点没记下来就绝不能动手改数据。
    """
    cutoff = now()
    db = sqlite3.connect(DB_PATH)
    try:
        # 服务器同时跑着两个进程，开机时它们会一起来抢这张表。等一会儿是应该的：
        # 排不上队就判"整理失败"，会把整个网站卡死在维护页（现在它是硬指标了）。
        db.execute('PRAGMA busy_timeout = 10000')
        db.execute('BEGIN IMMEDIATE')
        # 已经有了就用原来那个，不覆盖（后来者可能是故障后的重试）
        db.execute('INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)', (key, cutoff))
        db.commit()          # 这一步必须单独提交成功，后面的改动才谈得上安全
        got = db.execute('SELECT value FROM settings WHERE key=?', (key,)).fetchone()
        return got[0] if got else None
    except sqlite3.Error as e:
        print('（历史整理的时间点没能记下来：%s）' % e)
        try:
            db.rollback()
        except Exception:
            pass
        return None
    finally:
        db.close()


def one_off_migrations():
    """只跑一次的数据整理（跑没跑过记在 settings 表里，不会重复执行）。

    从 1.10.0 起，没审核过的东西不再给不相干的人看。线上那些老证照、
    老附件按北於的意思一律算"已经审过了"——不然一升级，大家会发现
    好多资料突然看不见了，还以为数据丢了。

    ⚠️ 三个坑都跟"服务器同时开两个进程"（线上就是 gunicorn 2 个 worker）有关：
    1. 标记是在 UPDATE 之前读的。两个 worker 同时读到"没整理过"就都会往下做，
       排队拿到写锁的那一个必须**再看一眼标记**，不然白做一遍。
    2. 批量 UPDATE 必须限定"这一刻之前就存在"的资料。否则员工刚好在这儿提交了新资料，
       会被顺手自动批成"已通过"，等于绕过审核（审计 M-03）。
    3. 这个"这一刻"不能是每次重新算的临时值，必须先单独写进库（见 _claim_oneoff_cutoff）。
       不然失败回滚后再重试，范围就悄悄往后挪了，把别人刚提交的待审资料吞进去。
    所以：记录时间点 → 锁 → 复查标记 → 只整理那个时间点之前的旧数据 → 写标记。

    返回 True 表示整理好了（或早就整理过了），False 表示没做成、不能放行业务。
    """
    if not os.path.exists(DB_PATH):
        return True
    cutoff = _claim_oneoff_cutoff(ONEOFF_REVIEW_CUTOFF_KEY)
    if not cutoff:
        return False      # 时间点没落盘，宁可不整理也不能瞎整理
    db = sqlite3.connect(DB_PATH)
    try:
        # 两个进程同时开机时会一起到这儿，见 _claim_oneoff_cutoff 里的说明
        db.execute('PRAGMA busy_timeout = 10000')
        db.execute('BEGIN IMMEDIATE')
        if db.execute('SELECT value FROM settings WHERE key=?',
                      (ONEOFF_REVIEW_KEY,)).fetchone():
            db.execute('ROLLBACK')
            return True
        n1 = db.execute("UPDATE certificates SET flow_status='approved'"
                        " WHERE (flow_status IS NULL"
                        "        OR flow_status IN ('draft','pending'))"
                        "   AND (created_at IS NULL OR created_at < ?)", (cutoff,)).rowcount
        # 还压着没审的附件也一并算通过，否则这些证照会"有证无图"
        n2 = db.execute("UPDATE versions SET status='approved', reviewed_by=?,"
                        " reviewed_at=? WHERE status='pending'"
                        " AND (uploaded_at IS NULL OR uploaded_at < ?)",
                        ('历史数据补审', cutoff, cutoff)).rowcount
        db.execute('INSERT INTO settings (key,value) VALUES (?,?)'
                   ' ON CONFLICT(key) DO UPDATE SET value=?',
                   (ONEOFF_REVIEW_KEY, 'done', 'done'))
        db.commit()
        print('历史数据已按"审核通过"处理：证照 %d 条、附件 %d 个' % (n1, n2))
        return True
    except sqlite3.Error as e:
        print('!! 历史数据整理没做成：%s' % e)
        try:
            db.rollback()
        except Exception:
            pass
        return False
    finally:
        db.close()


def oneoff_fix_draft_items():
    """把历史上卡在"草稿"状态的资料救回来（审计 M-04）。

    draft 是审核功能上线之前的老状态。它的毛病很隐蔽：
    页面上提示"已添加"，可它既不在任何列表里出现，也进不了审核中心——
    提交人和管理员都找不到它，只有数据库里躺着。
    按北於一贯的口径（历史数据一律算已通过）统一补成 approved。

    规矩同上面的补审批：时间点先落盘、事务里复查标记、只动那个时间点之前的
    老数据，正在排队的另一个进程不会跟着做第二遍。
    返回 True 表示好了，False 表示没做成。
    """
    if not os.path.exists(DB_PATH):
        return True
    cutoff = _claim_oneoff_cutoff(ONEOFF_DRAFT_CUTOFF_KEY)
    if not cutoff:
        return False
    db = sqlite3.connect(DB_PATH)
    try:
        db.execute('PRAGMA busy_timeout = 10000')
        db.execute('BEGIN IMMEDIATE')
        if db.execute('SELECT value FROM settings WHERE key=?',
                      (ONEOFF_DRAFT_KEY,)).fetchone():
            db.execute('ROLLBACK')
            return True
        n = db.execute("UPDATE certificates SET flow_status='approved'"
                       " WHERE flow_status='draft'"
                       "   AND (created_at IS NULL OR created_at < ?)", (cutoff,)).rowcount
        db.execute('INSERT INTO settings (key,value) VALUES (?,?)'
                   ' ON CONFLICT(key) DO UPDATE SET value=?',
                   (ONEOFF_DRAFT_KEY, 'done', 'done'))
        db.commit()
        if n:
            print('补回 %d 份卡在「草稿」的老资料（以前谁都看不到）' % n)
        return True
    except sqlite3.Error as e:
        print('!! 草稿资料整理没做成：%s' % e)
        try:
            db.rollback()
        except Exception:
            pass
        return False
    finally:
        db.close()


def backfill_missing_thumbs(limit=30):
    """给早期上传、还没生成压缩图的附件补一道。

    压缩图的功能是后来才加的，在那之前传的图只有原图，
    手机上点开就是好几 MB，转半天圈。补一次就一劳永逸。
    一次最多补 limit 个，剩下的下次启动接着补，不拖慢开机。
    """
    if not HAS_PIL or not os.path.exists(DB_PATH):
        return
    db = sqlite3.connect(DB_PATH)
    todo = []
    try:
        for r in db.execute("SELECT id, stored_name FROM versions"
                            " WHERE (web_name IS NULL OR web_name='')"
                            " AND stored_name IS NOT NULL").fetchall():
            todo.append(('versions', r[0], r[1]))
        for r in db.execute("SELECT id, image_web FROM inventory_items"
                            " WHERE image_web IS NOT NULL AND image_web != ''").fetchall():
            pass      # 仓库的图在上传时就压好了，这里不用管
    except sqlite3.Error:
        db.close()
        return
    done = 0
    for table, vid, stored in todo:
        if done >= limit:
            break
        ext = (stored.rsplit('.', 1)[-1] if '.' in stored else '').lower()
        if ext not in ('jpg', 'jpeg', 'png'):
            continue
        src = os.path.join(UPLOAD_DIR, stored)
        if not os.path.exists(src):
            continue
        base = stored.rsplit('.', 1)[0]
        try:
            web, thumb = make_web_and_thumb(
                src, ext, base, progressive=True,
                max_side=CERT_WEB_MAX_SIDE, max_bytes=CERT_WEB_MAX_BYTES)
        except Exception:
            continue
        if not web:
            continue
        try:
            db.execute('UPDATE versions SET web_name=?, thumb_name=? WHERE id=?',
                       (web, thumb, vid))
            db.commit()
            done += 1
        except sqlite3.Error:
            pass
    db.close()
    if done:
        print('给 %d 个早期附件补上了压缩图（剩下的下次启动继续）' % done)


def _load_item_for_write(db, iid):
    """取一件物品，准备给它记账（入库 / 出库 / 盘点）。

    还没审过的物品不许动：它算不算进库还两说，先让人采购、领用、盘点，
    回头一退回，账就对不上了。管理员不受限——他随时能自己改。

    返回 (物品, 错误提示)。物品为 None 且提示也是 None，表示压根没这件东西
    （调用方报 404）。
    """
    r = db.execute(INVENTORY_WITH_STOCK_LOG + ' WHERE id=? AND active=1', (iid,)).fetchone()
    if not r:
        return None, None
    # status 这一列是后加的，老库要等启动时的迁移才补上。
    # 读不到就当"已通过"，免得因为一个字段把出入库整个卡死。
    st = r['status'] if 'status' in r.keys() else 'approved'
    if st != 'approved' and not can_review():
        return None, '这件物品还在等管理员审核，审过之后才能入库 / 出库 / 盘点'
    return r, None


def _dump_table(db, name):
    """把一张表整表取出成字典列表；表不存在就返回空列表，不让它把导出卡住。"""
    try:
        return [dict(r) for r in db.execute('SELECT * FROM %s' % name)]
    except sqlite3.OperationalError:
        return []


@app.route('/api/backup')
@admin_required
def api_backup():
    """导出台账文字数据。
    注意：这里面没有上传的附件文件，也没有账号密码，不能代替"把 data 整个目录复制一份"。

    所有表都在同一个「这一刻的画面」里取出来——先把一笔只看不改的事务打开，
    再挨个读。以前是一张一张表自由地读，读的过程中随时可能有人入库出库：
    实测导出来的存档里，库存数量还写着 10，流水却已经记到 12 了，
    管理员拿这份东西对账，怎么算都对不上（审计 10/03 S-08）。
    代价是写入的人要多等几十毫秒；比起拿到一份自相矛盾的存档，这很划算。

    导出这件事往台账里记的那一笔不在这个画面里写——它是这次导出之后
    才发生的动作，等画面收起来之后再单独记一笔。
    """
    db = get_db()
    snapshot_at = now()
    # BEGIN 让 SQLite 保证整段读到的都是同一个时间点的情况，
    # 别人这期间的改动不会半路混进来。取完就收，不提交任何东西。
    try:
        db.execute('BEGIN')
    except sqlite3.Error:
        pass        # 已经在某个事务里了，沿用当前这个画面即可
    try:
        data = {
            '说明': '本文件只含台账里的文字记录，不含上传的照片/附件文件，也不含账号密码；'
                    '要能完整恢复，请另外复制整个 data 目录。'
                    '下面各表都取自同一个时间点，彼此可以直接对账。',
            '导出时间': snapshot_at,
            'certificates': [dict(r) for r in db.execute('SELECT * FROM certificates')],
            'certificate_edit_requests': _dump_table(db, 'certificate_edit_requests'),
            'versions': [dict(r) for r in db.execute('SELECT * FROM versions')],
            'employees': [dict(r) for r in db.execute('SELECT * FROM employees')],
            'assets': [dict(r) for r in db.execute('SELECT * FROM assets')],
            'asset_logs': [dict(r) for r in db.execute('SELECT * FROM asset_logs')],
            # 仓库这两张表以前没导出来，管理员拿到的存档里缺了库存档案和出入库流水，
            # 真要恢复就只能干瞪眼（审计 S-04）。表还没建过的情况下跳过，不报错。
            'inventory_items': _dump_table(db, 'inventory_items'),
            'inventory_logs': _dump_table(db, 'inventory_logs'),
            'inventory_image_versions': _dump_table(db, 'inventory_image_versions'),
            'fire_photos': _dump_table(db, 'fire_photos'),
            'fire_photo_order_requests': _dump_table(db, 'fire_photo_order_requests'),
            'settings': _dump_table(db, 'settings'),
            'users': [{'id': r['id'], 'username': r['username'], 'name': r['name'],
                       'role': r['role'], 'active': r['active'], 'last_login': r['last_login']}
                      for r in db.execute('SELECT * FROM users')],
            'logs': [dict(r) for r in db.execute('SELECT * FROM logs ORDER BY id DESC LIMIT 2000')],
        }
    finally:
        # 数据已经全在内存里了，这笔只读事务到此为止，不落地任何改动
        if db.in_transaction:
            try:
                db.rollback()
            except sqlite3.Error:
                pass
    write_log('导出台账数据')
    db.commit()
    buf = io.BytesIO(json.dumps(data, ensure_ascii=False, indent=2).encode('utf-8'))
    from flask import send_file
    return send_file(buf, as_attachment=True, mimetype='application/json',
                     download_name='乐秀平台_台账数据_不含附件_%s.json' % TODAY().isoformat())


if __name__ == '__main__':
    SHOW_PREVIEW = True   # 本机直跑才打开「手机预览」入口；服务器不执行这里，正式版不显示
    init_db()
    if not migrate():
        raise SystemExit('数据库需要升级，但没能先备份成功，已停止启动。'
                         '请手动把 data 整个目录复制一份留底后，再重新启动。')
    # 上次没删掉的文件（比如初始密码文件）趁这次启动再试一遍
    retry_pending_cleanups()
    one_off_migrations()
    backfill_missing_thumbs()
    port = int(os.environ.get('PORT') or 5000)
    # 默认只服务本机（外面访问不到）。要拿手机连同一个 WiFi 实测时，
    # 用 HOST=0.0.0.0 启动，然后访问 http://<本机局域网IP>:<端口>
    host = os.environ.get('HOST') or '127.0.0.1'
    print('乐秀内部管理平台已启动： http://127.0.0.1:%d%s'
          % (port, '（同时允许局域网访问）' if host != '127.0.0.1' else ''))
    app.run(host=host, port=port, debug=False)
