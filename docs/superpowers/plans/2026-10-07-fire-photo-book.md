# 消防照片册 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** 在现有乐秀网站实现固定 40 目录、拍照选图、必要审核和 A4 一图一页打印的消防照片册，并验证全部状态照片可被现有台账、备份与发布检查准确覆盖。

**Architecture:** 保持现有 Flask 单应用，消防后端放在 app.py 的独立区段，两张新表登记 NEW_TABLE_SQL。/fire 与 /fire/print 使用独立模板、脚本和局部样式；审核复用原审核中心。原始照片字节独立保存，预览沿用现有 Pillow 派生能力；所有附件访问先按照片 ID 和状态授权。

**Tech Stack:** Flask、SQLite、现有 Pillow、原生 HTML/CSS/JavaScript、unittest；不安装依赖。

**Spec:** D:\乐秀平台系统\docs\消防档案方案-20261007\完整方案.md；执行前完整阅读 D:\乐秀平台系统\AGENTS.md。

**已确定的同批顺序：**新增照片内部保存 batch_token / batch_index，同批绑定上传用户与目录，索引来自提交前确认顺序；失败重试保持批信息和单张令牌。审核按当前生效同批新图相邻锚点插入，人工逆序时409要求先确认/调整页序；替换不参与新增批追加。无需新增表、用户输入或另行选择业务方案。

## Global Constraints

- 唯一正式项目 D:\乐秀平台系统；用户已明确“先开发消防照片册，备份按期验证”，本计划只落实本机开发与验收。
- 固定 A01–A18、B01–B22；不按照片再填写标题、日期、备注、年度；不恢复逐份档案流程。
- 仅 JPG/JPEG、PNG；MAX_IMAGE_BYTES = 15 * 1024 * 1024、MAX_IMAGE_PIXELS = 30 * 1000 * 1000；全站单请求 20MB 不改。
- 原件保持原字节；EXIF 方向纠正和压缩只作用于派生图；打印首选受保护原件，不用缩略图。
- 黑金导航、米白业务页；页面局部 CSS；正式站不新增手机预览入口。
- 员工添加待审、申请更换及排序；管理员直接生效、精确删除；员工可打印其可查看的已审核照片。
- 所有 /api/ 写请求保持 X-Requested-With: lexiu 与同站 Origin；JSON 经 json_body()；提交成功以 _end_write(db) 返回 True 为准。
- 新表只登记 NEW_TABLE_SQL，经现有 migrate() 先完成数据库一致性快照和整个 data/ 两份备份；任一失败拒绝迁移。
- 开发、测试、迁移样例、上传样例和恢复验证全部使用唯一隔离虚构目录；禁止读写正式 data/app.db、data/uploads/ 或真实业务资料。
- Task2 安全入口为 Temp/safe_test_entry.py 的 load_app(data_dir: Path, module_name: str)；兼容 Temp/blackgold_upgrade_20261005/isolated_app.py 门面提供 SANDBOX/load_app。先由安全入口验证派生路径再执行 app.py；不得先正常导入应用后修改路径。
- 无 Git 项目：不 init、commit、worktree、重置；用 Temp 精确文件快照及 diff 留证据。只快照本任务代码，排除 data、密钥、备份和审计报告。
- 不改 VERSION，不产正式发布包，不部署、安装服务器配置或外部发送。小北独立复测、用户验收及明确“可以发”仍是后续发布门槛；v1.14.3 既有授权不扩大到消防。
- 不修改 docs/审计-*.md 或 docs/复测结论-*.md。本机实际验证后只写消防实现/整改记录。
- 安全加载器由当前总目标的 Task2 完成；当前总目标的 Task3 仅处理证照提前 commit，不修改消防接口。本计划内部 Task 1–3 为消防自身的串行任务。

---

## 文件与交付边界

| 消防任务 | 修改/新增文件 | 职责 |
|---|---|---|
| Task 1 后端 | app.py；Temp/fire_photo_book_20261007/test_backend.py；Temp/fire_photo_book_20261007/test_migration.py | 固定目录、两表、API、审核、受保护图片、打印清单、事务与隔离 API/迁移验证 |
| Task 2 界面 | templates/fire.html；templates/fire_print.html；static/fire.js；static/fire_print.js；static/fire.css；templates/index.html；static/app.js；Temp/fire_photo_book_20261007/test_pages.py；Temp/fire_photo_book_20261007/test_fire_model.js | 独立目录照片/页序与打印界面、最少导航、原审核中心增加消防类型；页面契约与本地模型验证 |
| Task 3 备份发布接入 | weekly_backup.py；Temp/srv_check.py；Temp/optimization_20261006/backup_recovery.py；Temp/release_remote.py；Temp/deploy.py；app.py 的 JSON 台账区；Temp/fire_photo_book_20261007/test_integrations.py | 全状态照片引用、两表台账、备份/恢复兼容、新表与静态资源核对；不实际发布 |
| 最终验收 | docs/整改记录-20261007-消防照片册本机开发.md；AGENTS.md 中新增消防的准确权限约定 | 双角色/双宽度/打印/旧业务回归事实；分开列未验证真机或纸质打印；待小北复测与用户发布放行 |

首次执行记录当前源文件 SHA-256 到 Temp/fire_photo_book_20261007/source-before.json，精确复制上表既有文件到 Temp/fire_photo_book_20261007/before/，只对这些快照 diff。不要复制 data/ 或其他同名旧项目。

## 固定业务、存储与接口合同

### 1. 固定目录常量

在 app.py 新消防区定义 FIRE_DIRECTORIES，顺序直接用于返回清单与整册打印。名称严格保留方案原文：

~~~python
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
FIRE_PHOTO_STATUSES = ('pending', 'approved', 'rejected', 'replaced')
~~~

不要改 CATEGORIES 的旧“消防”分类，不给消防照片加到期日或提醒档位。

### 2. 两张表精确结构

放到 NEW_TABLE_SQL，两表的 SQL 以以下内容为准。目录编号由每个接口检查 FIRE_DIRECTORY_NAMES，不新建目录表。用户 ID 用于所有权校验；上传/审核显示名称保存快照，账号删除后仍可追溯，不给 users 新增级联关系。client_token 是每次本地选择生成并在重试时复用的 UUID，不能作为文件访问凭据。

~~~sql
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
    CHECK(
        (batch_token IS NULL AND batch_index IS NULL)
        OR (batch_token IS NOT NULL AND batch_index IS NOT NULL AND batch_index >= 1)
    ),
    CHECK(width * height <= 30000000),
    CHECK(
        (status = 'approved' AND sort_order IS NOT NULL AND sort_order >= 1)
        OR (status <> 'approved' AND sort_order IS NULL)
    )
);

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
);
~~~

原件文件名 fire_ + secrets.token_hex(16) + 合法扩展名；派生用同一 base 的 _web.jpg、_thumb.jpg，只存 data/uploads/ 单层文件。照片行 status=approved 才有 sort_order；其它状态均为 NULL。新增图必须有batch_token和batch_index；替换图两字段均NULL，FK SET NULL后仍允许保留该替换记录。新批首个生效图放末尾，后续按同批索引锚点插入并重编号；替换通过继承被替换照片当前位置，将旧照片改 replaced/NULL，保留旧照片字节与记录。员工自己 rejected 行允许显示原因，但不给任何文件 URL；replaced 只供管理员内部访问，不建设历史版本界面。

### 3. 角色可见性与返回对象

统一助手函数必须有明确单一语义：

- fire_current_rows(db, directory_code): 返回 approved 行，ORDER BY sort_order,id。
- fire_can_view_photo(user, row, file_access=False): 管理员所有状态；员工 approved 全部、pending 仅上传用户 ID 等于当前用户；rejected 仅本人元数据可见、file_access=True 返回 False；员工 replaced 不可见。
- fire_photo_dict(row, user): 构造下面的对象，拒绝状态/权限时先过滤，不能只在前端藏图。
- fire_order_ids(db, directory_code): 从 fire_current_rows 返回 int ID 列表。
- fire_approve_new_photo(db, row, reviewer): 仅处理有批信息的pending新增图，在调用方写锁内检查同批当前序号索引单调性并插入；逆序RuntimeError→409，成功更新approved序号/审核信息。
- fire_apply_order(db, directory_code, base_ids, target_ids): 校验严格 int、正数、无重复、target 与 base 同集合；当前 approved ID 顺序必须等于 base，变化返回 409；在调用方写事务内更新 target 顺序。
- review_fire_photo(photo_id, data) / review_fire_order(request_id, data): 原审核中心路由分发调用；只管理员、只 pending，提交失败返回错误。
- fire_manifest(db, scope, user): scope 为合法编号或 all；只返回 approved，固定目录序与目录内序，生成稳定清单 SHA-256。

照片 JSON 形式：

~~~json
{
  "id": 31, "directory_code": "A01", "status": "approved",
  "sort_order": 1, "replaces_photo_id": null,
  "uploaded_by": "测试员工", "uploaded_at": "2026-10-07 12:00:00",
  "reviewed_by": "测试管理员", "reviewed_at": "2026-10-07 12:01:00",
  "reject_reason": "", "original_name": "page.jpg",
  "file_size": 123456, "width": 2400, "height": 3200,
  "web_url": "/fire-files/31/web",
  "thumb_url": "/fire-files/31/thumb",
  "original_url": "/fire-files/31/original"
}
~~~

不输出物理文件名、服务器路径、client_token、batch_token、用户密码；rejected 本人元数据的三种 URL 必须为 null。文件路由允许管理员全部状态，员工仅 approved 和自己 pending；未登录/越权/未知 ID 或 variant 保持现网登录保护或 404，不泄露另一个员工是否有待审图。

### 4. 页面与 API 一览

所有 POST/DELETE 用现有 guard_request。除 multipart 外，JSON 只允许列出的字段；非法类型、布尔代替 ID、错误目录、重复或跨目录 ID 返回 400；失效基准/非 pending 操作返回 409；管理员操作员工直连返回 403。

| 方法与地址 | 输入 | 200 返回 / 作用 |
|---|---|---|
| GET /fire | 可选 query directory=A01 | fire.html，需登录；不增加本机预览入口 |
| GET /fire/print | query scope=A01 或 all | fire_print.html，需登录；未加载完不给产品打印入口 |
| GET /api/fire/directories | 无 | {"items":[{"code":"A01","name":"单位基本情况","approved_count":2,"pending_count":1}]}，40项固定；员工 pending_count 只自己的，管理员为全部 |
| GET /api/fire/directories/A01/photos | 无 | {"directory":{"code":"A01","name":"单位基本情况"},"photos":[照片对象],"current_photo_ids":[31,32],"order_requests":[请求对象]}；employee只本人申请，管理员全部申请 |
| POST /api/fire/directories/A01/photos | multipart 单个 file + client_token + batch_token + batch_index（正整数文本） | {"ok":true,"photo":照片对象,"replayed":false}；员工pending；管理员按批锚点直接approved，新批首图末尾 |
| POST /api/fire/photos/31/replacement | multipart 单个 file + client_token | 同上传返回；31必须当前 approved；员工 pending不改31，管理员同事务生效，31转 replaced |
| POST /api/fire/directories/A01/order | {"base_photo_ids":[31,32],"photo_ids":[32,31]} | 管理员 {"ok":true,"status":"approved","photo_ids":[32,31]}；员工 {"ok":true,"status":"pending","request_id":8,"photo_ids":[32,31]} |
| DELETE /api/fire/photos/31 | {}，仅管理员 | {"ok":true,"deleted_id":31,"rejected_replacement_ids":[35]}；只删31所选照片，不级联其他历史/待审文件 |
| POST /api/reviews/fire_photo/35 | {"action":"approve"} 或 {"action":"reject","reason":"请补拍签字页"} | {"ok":true,"photo":照片对象}，照片新增/替换共用类型 |
| POST /api/reviews/fire_order/8 | 与原审核 action/reason 相同 | {"ok":true,"status":"approved","photo_ids":[32,31]} 或 {"ok":true,"status":"rejected"} |
| GET /fire-files/31/original、web、thumb | variant固定三值 | 原件按验证 MIME inline 返回，派生 JPEG；先权限/状态校验；Cache-Control: private, no-store |
| GET /api/fire/print-manifest?scope=all | scope合法编号/all | 下述完整清单，只 approved；空目录不输出页 |
| POST /api/fire/print-check | {"scope":"all","snapshot_hash":"64位SHA256"} | {"ok":true,"total_pages":3}；重建当前 authorized 清单，与 hash 不同返回409要求刷新，不跳过图片 |

顺序申请对象：

~~~json
{
  "id": 8, "directory_code": "A01", "status": "pending",
  "requested_by": "测试员工", "requested_at": "2026-10-07 12:02:00",
  "base_photo_ids": [31,32], "photo_ids": [32,31],
  "reviewed_by": null, "reviewed_at": null, "reject_reason": "",
  "conflict": false
}
~~~

清单对象：

~~~json
{
  "scope":"all",
  "snapshot_hash":"64位SHA256",
  "total_pages":3,
  "items":[
    {"id":31,"directory_code":"A01","directory_name":"单位基本情况",
     "number":1,"total":2,"width":2400,"height":3200,
     "url":"/fire-files/31/original"}
  ]
}
~~~

snapshot_hash 的规范输入是按清单顺序排列的 [id,directory_code,sort_order,stored_name,width,height,file_size]，json.dumps(...,ensure_ascii=False,separators=(',',':')) 后 SHA-256。不用当前时间/随机值，页序、替换、删除和文件引用变化必须改变 hash。数量 total 按该目录全部 approved 统计，即分册跨目录或分割同目录也显示准确“第 x 张/共 y 张”。

### 5. 删除和并发的精确定义

管理员确认框显示目录、当前位置、选定照片与受影响的待审替换数量，明确“只删除这张；关联待审更换会退回，其他历史记录保留”，不手输全名。后端同一 BEGIN IMMEDIATE 中读取目标、把直接替换它的 pending 行改 rejected、填自动原因“原照片已删除，请重新选择目录上传”，将其 sort_order 留 NULL；FK ON DELETE SET NULL 保留其它记录。删除目标行后按当前目录重排 approved 序号。排序申请不级联删除；基准变化时审核返回409，只能重新确认后发新申请，不能强制覆盖。

只有提交成功后才删除所选照片自己的 stored/web/thumb 文件；逐个检查剩余全部状态 fire_photos 及现有附件表的 stored/web/thumb 引用，没有引用才 unlink。引用仍在就保留文件，不误删别人照片。提交失败不删除任何原文件。落盘清理失败返回500且 {"deleted":true,"id":31,"error":"照片记录已删除，文件清理未完成，请联系管理员"}，日志写精确目标及失败事实，不假称数据完整回滚、不按名字片段批量清理。

上传每张独立事务；保存后校验/生成派生失败或事务提交失败只删本轮生成原件/派生。新原件重试client_token相同且同上传人、同目录/替换目标、同批标记/索引、同sha256/大小时复用原行；其它组合409，不复用别人记录。该旧行若已不可见，返回409提示重新获取目录而不创建新记录。原请求在guard阶段被409拦截时，前端刷新列表核对结果，不产生额外记录；每张未成功选择保留自身token与已确认批信息。

新图的batch_token规范化为UUID，batch_index是正整数ASCII十进制文本且能装入SQLite整数。写锁内查询现有同batch_token的全部状态行：上传用户不同403、目录不同400，错误不泄露绑定对象信息；若同batch/index已被不同client_token占用409。批绑定只靠两表中的照片记录，不新增批表。替换接口不接收批信息，存NULL，按原图位置处理。

## Task 1: 后端、两表和隔离 API/迁移验证

**Files:** Modify app.py:333 NEW_TABLE_SQL、906 图片边界、2501统一审核、4380台账；Create Temp/fire_photo_book_20261007/test_backend.py 和 test_migration.py。台账两表的最终集成核验放 Task 3，后端只提供表/API。

**Interfaces:** 消耗现有 get_db、current_user、json_body、_begin_write、_end_write、make_web_and_thumb、write_log、安全 load_app 与 test_fixture；产出上述固定 API/JSON 和 fire_* 助手；Task 2 不直接访问数据库。位置行号执行前用 rg 重新确认。

- [ ] **Step 1: 保存精确源码快照，建立唯一虚构 fixture 和先失败的权限/上传测试。**

在 test_backend.py 放下面可运行的测试骨架，后续同文件按步骤补测试方法。所有文件/账号仅此 fixture；每个请求上下文结束，清理前验证目标绝对路径、marker、无链接/交接点。安全入口未完成时先完成它的测试，不能绕过。

~~~python
import hashlib
import io
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile
import unittest
import uuid
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'Temp'))
sys.path.insert(0, str(ROOT / 'Temp/blackgold_upgrade_20261005'))
from isolated_app import SANDBOX, load_app
from test_fixture import seed_accounts, login, upload, image_bytes, WRITE_HEADERS

class FireFixture(unittest.TestCase):
    def setUp(self):
        SANDBOX.mkdir(parents=True, exist_ok=True)
        self.root = Path(tempfile.mkdtemp(prefix='fire_', dir=SANDBOX))
        (self.root / '.fire-owned').write_text('fictional fire fixture', encoding='utf-8')
        self.m = load_app(self.root / 'data', 'fire_' + uuid.uuid4().hex)
        seed_accounts(self.m)
        self.admin = login(self.m, 'admin')
        self.staff = login(self.m, 'staff')
        self.other = login(self.m, 'other')

    def tearDown(self):
        resolved = self.root.resolve()
        linked = any(p.is_symlink() or getattr(p, 'is_junction', lambda: False)()
                     for p in (self.root, *self.root.parents))
        if (resolved.parent != SANDBOX.resolve() or not resolved.name.startswith('fire_')
                or not (resolved / '.fire-owned').is_file() or linked):
            raise AssertionError('拒绝清理非本例唯一虚构目录')
        shutil.rmtree(resolved)

    def add(self, client, code='A01', raw=None, token=None, name='page.jpg',
            batch_token=None, batch_index=1):
        raw = image_bytes() if raw is None else raw
        return upload(client, '/api/fire/directories/' + code + '/photos',
                      raw, name, client_token=token or str(uuid.uuid4()),
                      batch_token=batch_token or str(uuid.uuid4()),
                      batch_index=str(batch_index))

    def photo(self, client, code='A01'):
        response = self.add(client, code)
        self.assertEqual(response.status_code, 200, response.get_json())
        return response.get_json()['photo']

    def review(self, kind, rid, action='approve', **extra):
        return self.admin.post('/api/reviews/' + kind + '/' + str(rid),
                               json={'action': action, **extra}, headers=WRITE_HEADERS)

class FireBackendTests(FireFixture):
    def test_catalog_and_staff_pending_is_private(self):
        catalog = self.staff.get('/api/fire/directories').get_json()['items']
        self.assertEqual(len(catalog), 40)
        self.assertEqual([catalog[0]['code'], catalog[-1]['code']], ['A01', 'B22'])
        p = self.photo(self.staff)
        self.assertEqual(p['status'], 'pending')
        self.assertEqual(self.staff.get(p['original_url']).status_code, 200)
        self.assertEqual(self.other.get(p['original_url']).status_code, 404)
        visible = self.other.get('/api/fire/directories/A01/photos').get_json()
        self.assertEqual(visible['photos'], [])
        row = self.other.get('/api/fire/directories').get_json()['items'][0]
        self.assertEqual(row['pending_count'], 0)

    def test_original_bytes_and_rejection_access(self):
        raw = image_bytes(size=(1200, 1800))
        response = self.add(self.staff, raw=raw)
        p = response.get_json()['photo']
        self.assertEqual(self.staff.get(p['original_url']).data, raw)
        self.assertEqual(self.review('fire_photo', p['id'], 'reject',
                                     reason='请拍全签字页').status_code, 200)
        self.assertEqual(self.staff.get(p['original_url']).status_code, 404)
        row = self.staff.get('/api/fire/directories/A01/photos').get_json()['photos'][0]
        self.assertEqual(row['reject_reason'], '请拍全签字页')
        self.assertIsNone(row['original_url'])
        with sqlite3.connect(self.m.DB_PATH) as db:
            sha = db.execute('SELECT sha256 FROM fire_photos WHERE id=?', (p['id'],)).fetchone()[0]
        self.assertEqual(sha, hashlib.sha256(raw).hexdigest())

    def test_staff_cannot_delete_review_or_forge_origin(self):
        p = self.photo(self.staff)
        self.assertEqual(self.staff.delete('/api/fire/photos/' + str(p['id']),
                         json={}, headers=WRITE_HEADERS).status_code, 403)
        self.assertEqual(self.staff.post('/api/reviews/fire_photo/' + str(p['id']),
                         json={'action':'approve'}, headers=WRITE_HEADERS).status_code, 403)
        for headers in ({}, {'X-Requested-With':'lexiu'},
                        {'X-Requested-With':'lexiu','Origin':'https://other.invalid'}):
            self.assertEqual(self.admin.post('/api/fire/directories/A01/order',
                json={'base_photo_ids':[], 'photo_ids':[]}, headers=headers).status_code, 403)

if __name__ == '__main__':
    unittest.main()
~~~

- [ ] **Step 2: 执行先失败测试，只认缺失消防接口导致的404/无JSON。**

~~~powershell
& 'D:\乐秀平台系统\Temp\optimization_20261006\clean_env\Scripts\python.exe' 'Temp\fire_photo_book_20261007\test_backend.py' -v
~~~

预期：未实现时 catalog 无 items 或消防路由404；若是安全入口、Pillow或登录失败，先定位该错误，不将其当需求测试已变红。

- [ ] **Step 3: 登记两表和固定目录；实现目录/照片元数据/受保护文件读路径。**

SQL 与常量直接采用合同。GET目录按角色分别统计 pending；照片列表 approved 按sort_order，其余本人或管理员可见待审/退回附在后部；内部 replaced 不输出员工列表。文件 variant 用字典映射，不能由 URL 片段拼物理路径：

~~~python
variants = {'original': 'stored_name', 'web': 'web_name', 'thumb': 'thumb_name'}
field = variants.get(variant)
if field is None or not fire_can_view_photo(current_user(), row, file_access=True):
    abort(404)
name = row[field]
if not name or '/' in name or '\\' in name or '..' in name:
    abort(404)
response = make_response(send_from_directory(UPLOAD_DIR, name,
    mimetype=row['mime_type'] if variant == 'original' else 'image/jpeg'))
response.headers['Cache-Control'] = 'private, no-store'
return response
~~~

实现 fire_can_view_photo 时用当前用户 id，不以可复用的显示姓名判所有权。原件 inline，不给通用 /files/<随机名> 新开消防口子。

- [ ] **Step 4: 添加失败上传和提交回滚测试，再实现单文件保存。**

追加以下方法：

~~~python
def test_invalid_and_commit_failed_upload_leave_no_new_file(self):
    before = set(Path(self.m.UPLOAD_DIR).iterdir())
    for raw, name in ((b'', 'empty.jpg'), (b'broken', 'broken.png'),
                      (b'%PDF-1.4', 'fake.jpg'), (image_bytes(), 'phone.heic')):
        r = self.add(self.staff, raw=raw, name=name)
        self.assertEqual(r.status_code, 400, r.get_json())
        self.assertEqual(set(Path(self.m.UPLOAD_DIR).iterdir()), before)
    def fail_commit(db, ok=True):
        db.rollback()
        return False
    with patch.object(self.m, '_end_write', side_effect=fail_commit):
        r = self.add(self.staff)
    self.assertGreaterEqual(r.status_code, 500)
    self.assertEqual(set(Path(self.m.UPLOAD_DIR).iterdir()), before)
    with sqlite3.connect(self.m.DB_PATH) as db:
        self.assertEqual(db.execute('SELECT COUNT(*) FROM fire_photos').fetchone()[0], 0)

def test_client_token_replay_creates_one_row(self):
    token, batch, raw = str(uuid.uuid4()), str(uuid.uuid4()), image_bytes()
    first = self.add(self.admin, raw=raw, token=token, name='page.jpg', batch_token=batch)
    second = self.add(self.admin, raw=raw, token=token, name='retry.jpg', batch_token=batch)
    self.assertEqual(first.status_code, 200)
    self.assertEqual(second.status_code, 200)
    self.assertTrue(second.get_json()['replayed'])
    self.assertEqual(second.get_json()['photo']['id'], first.get_json()['photo']['id'])
    with sqlite3.connect(self.m.DB_PATH) as db:
        self.assertEqual(db.execute('SELECT COUNT(*) FROM fire_photos').fetchone()[0], 1)
~~~

单张保存顺序：先检查一个file和UUID单张token、目录/替换父图合法；新增还检查UUID batch_token与合法batch_index，替换不接批字段；流式写随机原件至15MB，检查实际大小>0，Pillow verify再重新打开/load并检查JPEG/PNG真实格式与扩展一致、像素<=30M；计算SHA/尺寸；调用make_web_and_thumb(...,max_side=CERT_WEB_MAX_SIDE,max_bytes=CERT_WEB_MAX_BYTES)，返回任一None则失败。明确记录本轮三个路径，异常只清这三个。原件不经Pillow.save。记录width/height原始像素即可，面积不受EXIF旋转交换影响；网页预览采用纠正后的派生图。

已有client_token记录比较上传用户ID、目录、替换ID、批标记/索引、SHA和大小，不新建派生；不同原文件名而内容相同且其余绑定一致允许幂等返回，改绑定或内容409。保留现有6秒submit_guard，不修改它；此测试故意filename不同使请求指纹不同，单独验证数据库幂等。批归属和同index占用在写锁内复查，失败清本轮文件，避免并发两个用户认领同一批。

写事务中验证批绑定、插入pending/NULL序号照片和现有日志；管理员新增在同一事务调用fire_approve_new_photo，员工保留pending。只_end_write=True才响应成功。实现helper保存动作须有单独清理责任，外层事务失败也须清理本次所有文件。20张以上目录测试逐文件调用，不提高MAX_CONTENT_LENGTH。

- [ ] **Step 5: 添加替换/序号基准失败测试，实现事务更新与原审核分发。**

~~~python
def test_replacement_stays_pending_then_keeps_old_bytes_internal(self):
    old = self.photo(self.admin)
    r = upload(self.staff, '/api/fire/photos/' + str(old['id']) + '/replacement',
               image_bytes((177, 80, 20)), 'new.jpg', client_token=str(uuid.uuid4()))
    new = r.get_json()['photo']
    self.assertEqual(new['status'], 'pending')
    current = self.other.get('/api/fire/directories/A01/photos').get_json()['current_photo_ids']
    self.assertEqual(current, [old['id']])
    self.assertEqual(self.review('fire_photo', new['id']).status_code, 200)
    current = self.other.get('/api/fire/directories/A01/photos').get_json()['current_photo_ids']
    self.assertEqual(current, [new['id']])
    self.assertEqual(self.admin.get(old['original_url']).status_code, 200)
    self.assertEqual(self.other.get(old['original_url']).status_code, 404)

def test_order_request_does_not_apply_and_stale_review_is_409(self):
    a, b = self.photo(self.admin), self.photo(self.admin)
    r = self.staff.post('/api/fire/directories/A01/order',
        json={'base_photo_ids':[a['id'],b['id']], 'photo_ids':[b['id'],a['id']]},
        headers=WRITE_HEADERS)
    self.assertEqual(r.status_code, 200)
    rid = r.get_json()['request_id']
    self.assertEqual(self.other.get('/api/fire/directories/A01/photos').get_json()
                     ['current_photo_ids'], [a['id'],b['id']])
    c = self.photo(self.admin)
    result = self.review('fire_order', rid)
    self.assertEqual(result.status_code, 409)
    self.assertEqual(self.other.get('/api/fire/directories/A01/photos').get_json()
                     ['current_photo_ids'], [a['id'],b['id'],c['id']])
~~~

替换审核/管理员直接替换在同一个写锁里重新读 replaces_photo_id 为 approved 的原行，读取其当下位置；原行已不approved返回409保留申请，不能覆盖另一个替换。关键 SQL：

~~~python
changed = db.execute(
    "UPDATE fire_photos SET status='replaced',sort_order=NULL "
    "WHERE id=? AND status='approved'", (old['id'],))
if changed.rowcount != 1:
    db.rollback()
    return jsonify({'error':'原照片已变化，请重新确认'}), 409
db.execute(
    "UPDATE fire_photos SET status='approved',sort_order=?,reviewed_by=?,reviewed_at=? "
    "WHERE id=? AND status='pending'",
    (old['sort_order'], reviewer, now(), new_id))
~~~

admin直接替换先插pending记录（批字段NULL）再沿相同事务规则生效，替换不进入新增批锚点算法。新增待审通过在锁内调用fire_approve_new_photo，按下节锚点规则插入；退回reason必须非空字符串且不超过1000字符。旧/新行、顺序、审核信息、日志一同提交；失败原图仍可访问，新上传文件由上传外层准确清理。

fire_apply_order 的校验与核心更新：

~~~python
if (not isinstance(base_ids, list) or not isinstance(target_ids, list)
    or any(type(x) is not int or x <= 0 for x in base_ids + target_ids)
    or len(set(base_ids)) != len(base_ids)
    or len(set(target_ids)) != len(target_ids)
    or set(base_ids) != set(target_ids)):
    raise ValueError('照片顺序不合法')
if fire_order_ids(db, code) != base_ids:
    raise RuntimeError('照片或顺序已变化，请重新确认')
for position, photo_id in enumerate(target_ids, 1):
    changed = db.execute(
        "UPDATE fire_photos SET sort_order=? WHERE id=? AND directory_code=? AND status='approved'",
        (position, photo_id, code))
    if changed.rowcount != 1:
        raise RuntimeError('照片已变化，请重新确认')
~~~

调用方 ValueError→400、RuntimeError→409、SQLite/提交错误→500并rollback；不要跨事务分开检查基准。员工提交仅 INSERT order_requests，审核时仍重新比对基准；相同人同目录同base/target已有pending申请返回该request_id，避免额外待审行。管理员直接排序不新建审批申请。

在 api_reviews 添加 kind=fire_photo（待审新增/替换）和 kind=fire_order，数据仍提供 id/title/sub/by/at/thumb_url/url，替换 sub说明原图保留；排序额外 base_photo_ids/photo_ids/conflict。api_review_one 显式分发这两种，不放宽旧类型白名单。

- [ ] **Step 6: 添加精确删除测试，实现后端管理员删除与剩余引用检查。**

~~~python
def test_delete_only_selected_photo_rejects_pending_replacement(self):
    selected, other = self.photo(self.admin), self.photo(self.admin)
    pending = upload(self.staff,
        '/api/fire/photos/' + str(selected['id']) + '/replacement',
        image_bytes((24,140,73)), 'replacement.jpg',
        client_token=str(uuid.uuid4())).get_json()['photo']
    r = self.admin.delete('/api/fire/photos/' + str(selected['id']),
                          json={}, headers=WRITE_HEADERS)
    self.assertEqual(r.status_code, 200, r.get_json())
    self.assertEqual(r.get_json()['rejected_replacement_ids'], [pending['id']])
    self.assertEqual(self.admin.get(selected['original_url']).status_code, 404)
    self.assertEqual(self.admin.get(other['original_url']).status_code, 200)
    self.assertEqual(self.admin.get(pending['original_url']).status_code, 200)
    self.assertEqual(self.staff.get(pending['original_url']).status_code, 404)
    with sqlite3.connect(self.m.DB_PATH) as db:
        row = db.execute('SELECT status,replaces_photo_id FROM fire_photos WHERE id=?',
                         (pending['id'],)).fetchone()
        self.assertEqual(row, ('rejected', None))
~~~

UPDATE关联pending→rejected及reason，然后DELETE目标；FK SET NULL而非CASCADE。提交后用三字段对应每个物理文件检查剩余全部状态引用：

~~~sql
SELECT 1 FROM fire_photos
WHERE stored_name=? OR web_name=? OR thumb_name=? LIMIT 1;
~~~

同时检查 versions、drink_pages、inventory_items(image_web/image_thumb)、inventory_image_versions，存在引用不unlink；不清其它pending/rejected/replaced文件。测试再注入_end_write失败确认选定原件仍在；注入os.remove失败确认错误响应带deleted事实及日志，不模糊批量删。

- [ ] **Step 7: 添加打印清单/变化测试，实现只已审清单与二次校验。**

~~~python
def test_print_manifest_only_approved_and_changes_block_entry(self):
    b = self.photo(self.admin, 'B01')
    a = self.photo(self.admin, 'A01')
    self.photo(self.staff, 'A01')
    manifest = self.staff.get('/api/fire/print-manifest?scope=all').get_json()
    self.assertEqual([p['id'] for p in manifest['items']], [a['id'],b['id']])
    check = {'scope':'all', 'snapshot_hash':manifest['snapshot_hash']}
    self.assertEqual(self.staff.post('/api/fire/print-check', json=check,
                                    headers=WRITE_HEADERS).status_code, 200)
    self.photo(self.admin, 'A01')
    self.assertEqual(self.staff.post('/api/fire/print-check', json=check,
                                    headers=WRITE_HEADERS).status_code, 409)
~~~

读取整册时不要 SQL 目录字典序误置，按FIRE_DIRECTORIES循环同一只读事务查询；清单只approved，employee自己的pending也不加入；验证未知scope400。原件缺失时清单或print-check返回错误阻止入口，不把缺图排除后降低total_pages假装成功。文件状态查询不把 read接口写日志强制commit；POST print-check只是读取，但照样保留现网POST头校验。

- [ ] **Step 8: 编写双备份迁移/安全边界测试并运行Task 1所有测试。**

test_migration.py 使用相同唯一 fixture；建立新空库时两表都在ALL_TABLE_SQL；模拟旧库仅在虚构库 DROP fire_photo_order_requests 再 DROP fire_photos，随后调用 init_db。用 patch包裹 backup_db_file / backup_data_dir，记录调用顺序和返回路径，断言实际两份备份都可打开/读，且建表只发生在两份成功之后。以下失败场景必须真实失败停止：

~~~python
with patch.object(module, 'backup_db_file', return_value=None):
    with self.assertRaises(SystemExit):
        module.init_db()
with sqlite3.connect(module.DB_PATH) as db:
    names = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
self.assertNotIn('fire_photos', names)
self.assertNotIn('fire_photo_order_requests', names)
~~~

另测快照成功但backup_data_dir返回None同样不建表；过大15MB文件用同fixtureBytesIO；>30M像素用虚构PNG及Pillow生成，不上传真实图；所有分支没有新原件/派生残留。

~~~powershell
& 'D:\乐秀平台系统\Temp\optimization_20261006\clean_env\Scripts\python.exe' -m unittest discover -s 'Temp\fire_photo_book_20261007' -p 'test_backend.py' -v
& 'D:\乐秀平台系统\Temp\optimization_20261006\clean_env\Scripts\python.exe' -m unittest discover -s 'Temp\fire_photo_book_20261007' -p 'test_migration.py' -v
~~~

再验证审批重复、管理员立即新增/更换/排序、staff不能看other待审、reject不改原照片顺序、跨目录/重复/布尔ID拒绝、原件SHA、超过20张继续添加。Task 1通过标准：这些API/迁移测试真实通过、正式data未访问、失败清理准确、旧接口没有变更。

## Task 2: 独立照片页面、页序、原审核中心与打印

**Files:** Create templates/fire.html、templates/fire_print.html、static/fire.js、static/fire_print.js、static/fire.css；Modify templates/index.html、static/app.js审核消防类型；Create test_pages.py、test_fire_model.js。

**Interfaces:** 只消耗合同API，后端为字段/权限唯一来源。fire.js提供 window.FireBookModel 的空框/选图纯状态函数供Node内置assert验证，不引入框架；fire_print.js消耗完整清单及print-check；主站审核仍reviewOne(kind,id,action)。

- [ ] **Step 1: 页面路由/模型先失败，定义可测试状态。**

test_pages.py复用唯一安全fixture，验证匿名/fire与/fire/print被现网登录保护；登录后模板200，fire.html必须加载fire.js/fire.css，print模板只加载fire_print.js/fire.css，不加载后台app.js操作表单；关键按钮 type=button，文件控件accept仅JPEG/PNG，拍照控件capture=environment；引用文件本地存在且静态GET200。只从test_backend导入无test_*方法的FireFixture辅助基类，页面/集成测试不继承FireBackendTests而重复后端整套：

~~~python
import unittest
from test_backend import FireFixture

class FirePagesTests(FireFixture):
    def test_pages_have_independent_resources_and_login_guard(self):
        anonymous = self.m.app.test_client()
        for path in ('/fire', '/fire/print?scope=all'):
            self.assertEqual(anonymous.get(path).status_code, 401)
        for client in (self.admin, self.staff):
            page = client.get('/fire')
            self.assertEqual(page.status_code, 200)
            html = page.get_data(as_text=True)
            self.assertIn('/static/fire.js', html)
            self.assertIn('capture="environment"', html)
            printed = client.get('/fire/print?scope=all').get_data(as_text=True)
            self.assertIn('/static/fire_print.js', printed)
            self.assertNotIn('/static/app.js', printed)
        for path in ('/static/fire.js', '/static/fire_print.js', '/static/fire.css'):
            self.assertEqual(self.staff.get(path).status_code, 200)

if __name__ == '__main__':
    unittest.main()
~~~

fire.js本地状态为 {saved:[], drafts:[]}；draft为 {key:UUID,batch_token:null|UUID,batch_index:null|int,file:null|File,preview_url:null|URL,phase:'empty'|'selected'|'sending'|'failed',error:''}；首次发送前按已确认顺序给本轮新增选择共享batch_token与1起batch_index，失败重试不重排、不改这两字段或key；新一轮选择产生新批。替换draft批字段始终NULL。加载saved后，若saved为空且drafts为空才建立一个empty；有saved不自动新框。纯状态函数签名：ensureInitial(state)、addBlank(state)、selectFiles(state,files)、moveDraft(state,key,delta)、removeDraft(state,key)。以下Node测试不得依赖外部包：

~~~javascript
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('static/fire.js','utf8');
const ctx = {
  window:{},
  document:{addEventListener(){}},
  crypto:{randomUUID:()=> 'fixture-' + (++ctx.counter)},
  URL:{createObjectURL:()=> 'blob:fixture',revokeObjectURL(){}},
  counter:0
};
vm.createContext(ctx); vm.runInContext(source,ctx);
const model = ctx.window.FireBookModel;
const s = {saved:[],drafts:[]};
model.ensureInitial(s);
assert.equal(s.drafts.length,1);
assert.equal(s.drafts[0].phase,'empty');
assert.equal(model.addBlank(s).ok,false);
model.selectFiles(s,[{name:'one.jpg'},{name:'two.jpg'}]);
assert.equal(s.drafts.length,2);
assert.equal(s.drafts.filter(x=>x.phase==='empty').length,0);
assert.equal(model.addBlank(s).ok,true);
assert.equal(s.drafts.length,3);
const existing={saved:[{id:1}],drafts:[]};
model.ensureInitial(existing);
assert.equal(existing.drafts.length,0);
~~~

先运行 python test_pages.py 与 node Temp/fire_photo_book_20261007/test_fire_model.js，预期路由/资源或FireBookModel缺失导致失败；不因未找到node安装新依赖，使用当前已有Node runtime，否则记录模型测试条件。

- [ ] **Step 2: 实现独立fire.html及局部样式、只添加链接导航。**

fire.html页面<body class="app fire-book">；加载现style.css保留黑金壳，再fire.css。40目录显示编号、名称、已生效数量，员工自己的待审数量；当前目录标题和照片容器；无必填标题/日期/备注。尾部唯一＋；先中央拍照/上传，選后同框完整预览；保存照片/待审照片用状态区分，本地selected显示“待提交”。移动控件>=44px，390/320px单列/两列不挤；admin删除仅该选定图明确确认。

模板关键片段：

~~~html
<main class="fire-content">
  <nav id="fireDirectories" aria-label="消防固定目录"></nav>
  <section aria-labelledby="fireDirectoryTitle">
    <h1 id="fireDirectoryTitle"></h1>
    <div id="firePhotos" class="fire-photo-grid"></div>
    <button type="button" id="fireAddBlank" aria-label="增加下一张照片">＋</button>
    <button type="button" id="fireSubmit">提交照片</button>
    <a id="firePrintCurrent" href="/fire/print?scope=A01">打印当前目录</a>
    <a href="/fire/print?scope=all">打印全部有照片目录</a>
  </section>
  <input type="file" id="fireCamera" accept="image/jpeg,image/png"
         capture="environment" hidden>
  <input type="file" id="fireUpload" accept="image/jpeg,image/png"
         multiple hidden>
  <div id="fireStatus" role="status" aria-live="polite"></div>
</main>
~~~

只在原首页导航/模块卡的合理位置加href=/fire链接，不把go('fire')接入现SPA状态而重构路由；手机导航对应链接同样可达，原管理员专属节点不变。新页“返回工作台/审核中心”指向现首页；不要复刻旧证照编辑表单。

- [ ] **Step 3: 实现选图/逐文件提交/失败保留与页序操作。**

ensureInitial/addBlank/selectFiles按Step1精确定义；selectFiles先填唯一空框，其余选图逐个加filled框，不额外加empty。重选先revoke旧blob并为新选择生成新的UUID key；只有同一选择的网络重试才复用原key，避免改图与旧已提交token冲突。取消file数组为空不改状态；有效server图替换preview放独立draft，不改saved对象。切目录有未传选择时明确提示，不误删已落盘照片。beforeunload仅在selected/sending/failed未完成时提示。

请求具体形式：

~~~javascript
async function sendPhoto(code, draft, replacesId) {
  const data = new FormData();
  data.set('file', draft.file);
  data.set('client_token', draft.key);
  if (!replacesId) {
    data.set('batch_token', draft.batch_token);
    data.set('batch_index', String(draft.batch_index));
  }
  const path = replacesId
    ? '/api/fire/photos/' + replacesId + '/replacement'
    : '/api/fire/directories/' + encodeURIComponent(code) + '/photos';
  const response = await fetch(path, {
    method:'POST',credentials:'same-origin',
    headers:{'X-Requested-With':'lexiu'},body:data
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '上传失败，请重试');
  return value.photo;
}
~~~

Origin由浏览器同站写请求自然产生，不能手工伪造；FormData不手写Content-Type边界。每批候选最多10个选择作为处理队列，逐文件发送，超过10个自动续批，文字明确“每批10张自动继续，目录总数不限”；已经成功photo独立进入saved状态，失败draft保留file/blob/key，重试不重复成功项；提交中禁同一draft重复，6秒guard409时先拉列表核实后台结果而不称整批失败或成功。10只是候选队列参数，20+目录验收不能受其限制。

已生效图排序在页面产生draftIds，相邻上/下移；基准baseIds保留加载时current_photo_ids。提交JSON明确是base/target全目录已审ID序列；首次发送前新增选择在本地单独排序，确认后固定本批index，网络重试不改变；新一轮新增用新批，不把已发送图混进本地选择队列。staff提交后清楚显示待管理员确认，正式saved仍按原序刷新；admin立即刷新生效。409重新拉列表并提示再确认，不自动覆写新基准重发；新增批审批409明确要求先确认/调整已生效同批页序，不能改batch_index绕过。

- [ ] **Step 4: 原审核中心增加两个kind，保留全部旧分支。**

REVIEW_KIND新增fire_photo:'消防照片'、fire_order:'消防照片页序'。reviewFile对fire_photo渲染受保护web/缩略图和新增/替换说明；对fire_order用服务器base/target ID序和conflict提示，不依赖随机文件名。reviewOne仍现入口，409原样提示刷新重新确认；管理员必须能退回且reason非空。所有动态姓名/原因/文件名/目录名称走esc或textContent，不拼未转义HTML。

不建消防独立审核页；iframe或打印预览不要读管理员专属审核数据。已有cert/cert_edit/version/item/item_image/asset审核回归不变。

- [ ] **Step 5: 实现自动A4预览与按候选预算分册，先完成加载再开放打印。**

fire.css仅.fire-book/.fire-print前缀和@media print/@page打印区生效。原件选择后本地框与生效print页均等比完整居中，A4竖版；标题/页码预留。打印样式：

~~~css
@page { size: A4 portrait; margin: 12mm; }
.fire-print .fire-sheet {
  background: #fff; color: #111; box-sizing: border-box;
  display: grid; grid-template-rows: 13mm minmax(0,1fr) 8mm;
}
.fire-print .fire-sheet-photo { min-height: 0; display: grid; place-items: center; }
.fire-print .fire-sheet-photo img {
  display: block; max-width: 100%; max-height: 100%;
  width: 100%; height: 100%; object-fit: contain;
  image-orientation: from-image;
}
@media print {
  .fire-print .fire-controls { display: none !important; }
  .fire-print .fire-sheet {
    width: 186mm; height: 273mm; break-after: page; page-break-after: always;
  }
  .fire-print .fire-sheet:last-child { break-after: auto; page-break-after: auto; }
}
~~~

屏幕页宽取min(100%,794px)，纵横比保持210/297并为标题/脚注留白；打印独立页只有标题、照片、“第x张/共y张”，不含操作导航、空框、本地选择或pending。不要把完整后台DOM通过CSS隐藏后直接打印。

候选分册参数 FIRE_PRINT_MAX_PAGES=12、FIRE_PRINT_MAX_PIXELS=45*1000*1000；单张<=30M必能装进一册；按既定清单顺序贪心分册，任一预算将超则从下一册开始，分册清单列所含目录与张数范围，全部分册扁平化必须等于原始items。候选用于实际Chrome内存/打印验证，允许降低/提高后在记录说明，不是目录或全册业务总上限。

纯分册函数与最小测试：

~~~javascript
function splitFirePrint(items,maxPages=12,maxPixels=45000000) {
  const parts=[]; let part=[],pixels=0;
  for (const item of items) {
    const area=item.width*item.height;
    if (part.length && (part.length>=maxPages || pixels+area>maxPixels)) {
      parts.push(part); part=[]; pixels=0;
    }
    part.push(item); pixels+=area;
  }
  if (part.length) parts.push(part);
  return parts;
}
~~~

test_fire_model.js另外在同VM装载fire_print.js暴露的window.FirePrintModel.split，断言41张虚构每张4M像素的清单分册合并ID=原ID、不丢不重，每册<=12页且<=45M。换册释放原册DOM与图片引用，只解码当前册，不同时创建全册所有原图；保留轻量清单和分册范围。

逐图等待load/error和img.decode；同时检查naturalWidth/Height>0。之后POSTprint-check比对scope/hash，按钮才enabled；点击打印前再校验一次，任何缺图、解码失败或409均禁产品打印入口并给可重试提示。window.print只在用户主动点击后调用，不自动跳对话框。应明确该控制不能拦浏览器Ctrl+P，也不能撤回已经合法显示/保存的内容；不作虚假保证。

- [ ] **Step 6: 跑页面/模型测试，再在唯一虚构站桌面与手机宽度实际走通。**

~~~powershell
& 'D:\乐秀平台系统\Temp\optimization_20261006\clean_env\Scripts\python.exe' 'Temp\fire_photo_book_20261007\test_pages.py' -v
node 'Temp\fire_photo_book_20261007\test_fire_model.js'
node --check 'static/fire.js'
node --check 'static/fire_print.js'
node --check 'static/app.js'
~~~

用安全入口 CLI --serve --port5099 创建唯一UUID空虚构库；浏览器账号使用test_fixture种子，若CLI不自动建种子，在同fixture明确播种后由安全入口启动，禁止登录正式数据页面。实际验证管理员与staff路径、桌面1280px、390px、320px；连续两张、主动作多选、重选取消、未填＋、局部失败后重试、审核前原图原序、误传管理员精准删除、再按原审核中心批准、排序409重新确认。

Chrome打印对话框与保存PDF检查横/竖图整张、A01两页到A02、标题/页码、无控制/空页、分册总数；使用包含四角标记和清楚虚构表格/签字的合成图，缺图/解码异常要看到入口受阻。真实iPhone/Android/微信拍照和纸质字迹检查没有设备条件时明确未验证，桌面capture不能代替真机。

Task 2通过标准：后端API合同字段一致、纯模型和页面测试通过、实际两角色与三宽度通过、可完成Chrome打印预览/保存PDF；未验证项不能标通过。

## Task 3: 全状态备份、台账、恢复与发布核验接入

**Files:** Modify weekly_backup.py:107附件引用、Temp/srv_check.py:48查询枚举、Temp/optimization_20261006/backup_recovery.py:153引用/兼容、Temp/release_remote.py:39包检查及87快照比较、Temp/deploy.py:233资源及239新表、app.py:4402台账；Create test_integrations.py。

**Interfaces:** 从Task1两表的stored_name/web_name/thumb_name读引用，不筛status；沿用现有backup/recovery函数和snapshot字典，不复制真实库。新表是可选功能：检查历史合法备份时没有消防表允许，只有一表出现应报结构不完整；已带两表的新版全部状态文件必须核对。全站每周日06:00、两端3套、迁移5份、发布独立保护不改。

- [ ] **Step 1: 写先失败的引用与JSON台账测试。**

test_integrations.py只继承test_backend的FireFixture，自己的FireIntegrationTests提供集成test_*；不继承FireBackendTests而重复整套。使用该唯一fixture创建approved、pending、rejected、replaced四状态：管理员a，staff待审p、另一个staff图r退回，staff替换a并批准使a replaced。每状态保存自己的三文件。调用weekly_backup.attachment_references和srv_check.snapshot；移走一个rejected原件到fixture的明确临时文件并核验必须失败，finally精确还原，以证明核验没有只检查当前图。

~~~python
def test_export_contains_fire_tables_but_no_password(self):
    self.photo(self.admin)
    response = self.admin.get('/api/backup')
    self.assertEqual(response.status_code, 200)
    data = response.get_json()
    self.assertIn('fire_photos', data)
    self.assertIn('fire_photo_order_requests', data)
    self.assertEqual(len(data['fire_photos']), 1)
    self.assertTrue(all('password_hash' not in row for row in data['users']))
~~~

备份函数和导出当前返回Content-Disposition但JSONbody仍可get_json；若实际Content-Type不同用json.loads(response.data)，不能修改产品为迎合测试。对非admin台账接口403继续验证。

- [ ] **Step 2: 加入全状态引用，保持旧备份与既有核验严格程度。**

weekly_backup与backup_recovery显式枚举追加('fire_photos',('stored_name','web_name','thumb_name'))。srv_check存在fire_photos时追加：

~~~python
queries.append(('fire_photos',
    'SELECT id,stored_name,web_name,thumb_name FROM fire_photos ORDER BY id'))
~~~

不WHERE status='approved'，不只统计当前图；检查fire_photos/reorder表同时有或同时无，单表存在抛ValueError。既有完整性、文件路径、符号链接、密钥/引用摘要校验不放宽；replaced/rejected/待审文件同样参与还原。所有未知表兼容保护保持：旧代码对含非空消防表的回退应明确拒绝，不能删表/照片解除保护。

app.py JSON台账原读事务中追加：

~~~python
'fire_photos': _dump_table(db, 'fire_photos'),
'fire_photo_order_requests': _dump_table(db, 'fire_photo_order_requests'),
~~~

日志继续在现有logs，台账不导出密码；备份目录排除backups自身不改；不借此重写备份函数或远程连接。

- [ ] **Step 3: 扩展发布新表允许名单与消防资源检查，写虚构清单通过/失败测试。**

compare_snapshots签名追加require_fire=False；仅该标记为True允许两张新表，要求新增表为空、旧业务条数/附件/密钥/文件摘要不变。实施片段：

~~~python
if require_fire:
    expected_new['fire_photos'] = '消防照片'
    expected_new['fire_photo_order_requests'] = '消防照片页序申请'
~~~

validate_archive通过AST读取app.py的NEW_TABLE_SQL常量key，若声明任一消防表则要求两表同在，并要求templates/fire.html、templates/fire_print.html、static/fire.js、static/fire_print.js、static/fire.css都在发布代码范围。不根据当前不变VERSION偷偷启用未知表，也不修改旧包验证要求。部署调用从已验证包的消防资源集合判断require_fire，两张表对应新空库核验只在迁移后比较启用；发布前备份的before/after比较仍默认False。AST只读取常量键，不执行归档源码：

~~~python
source = z.read('app.py').decode('utf-8-sig')
declared_new = set()
for node in ast.parse(source).body:
    if (isinstance(node, ast.Assign)
            and any(isinstance(t, ast.Name) and t.id == 'NEW_TABLE_SQL' for t in node.targets)
            and isinstance(node.value, ast.Dict)):
        declared_new.update(ast.literal_eval(key) for key in node.value.keys
                            if isinstance(key, ast.Constant) and isinstance(key.value, str))
fire_tables = {'fire_photos', 'fire_photo_order_requests'}
if declared_new & fire_tables:
    if not fire_tables <= declared_new or not FIRE_REQUIRED_FILES <= paths:
        raise ValueError('消防两表或必需模板/脚本/样式不完整')
~~~

~~~python
FIRE_REQUIRED_FILES = {'templates/fire.html','templates/fire_print.html',
                       'static/fire.js','static/fire_print.js','static/fire.css'}
requires_fire = FIRE_REQUIRED_FILES <= set(manifest['files'])
compare_snapshots(before, after,
                  require_new=(version == '1.14.0'),
                  require_edit=(version == '1.14.1'),
                  require_fire=requires_fire)
~~~

部署资源核验追加/static/fire.js、/static/fire_print.js、/static/fire.css；未登录/fire与/fire/print沿用现有login_required，精确返回401及“请先登录”JSON，不得返回照片内容或强行要求200，不用错误密码探测。原计划302示例与冻结源码不符，现按完整方案“必须登录”及现有保护更正检查，不改登录规则。授权发布时再用真管理员登录确认新页面/打印；本任务仅实现检查与虚构测试，不执行Temp/deploy.py。

test_integrations构造虚构before和after快照deepcopy，after只添加两表=0：默认require_fireFalse必须ValueError；require_fireTrue通过；非空新表、缺一表、未知第三表、旧业务条数改变、附件/密钥摘要变化均ValueError。资源验证使用临时虚构ZIP与虚构源码字面量，仅在唯一fixture，不产正式发布包，缺fire_print.js必须拒绝；旧合法无消防包仍通过。

- [ ] **Step 4: 虚构完整备份恢复与历史回退兼容性，证明全部状态不丢。**

同一虚构fixture调用现有 weekly_backup.run_backup(self.m, keep=3)，然后 weekly_backup.verify_backup(Path(result['directory'])) 验证一致性快照+uploads+secret。恢复测试不用运行生产恢复命令，下面代码仅复制已经验证且不再写入的虚构备份，目的路径仍在本例唯一目录内；不是复制运行中的数据库：

~~~python
import weekly_backup
result = weekly_backup.run_backup(self.m, keep=3)
self.assertTrue(result['ok'], result)
source = Path(result['directory'])
manifest = weekly_backup.verify_backup(source)
restore_data = self.root / 'restored' / 'data'
restore_data.mkdir(parents=True)
shutil.copy2(source / 'app.db', restore_data / 'app.db')
shutil.copy2(source / 'secret.key', restore_data / 'secret.key')
shutil.copytree(source / 'uploads', restore_data / 'uploads')
restored = load_app(restore_data, 'fire_restored_' + uuid.uuid4().hex)
restored.init_db()
restored_admin = login(restored, 'admin')
restored_staff = login(restored, 'staff')
self.assertEqual(restored_admin.get('/api/fire/directories').status_code, 200)
~~~

对每个原件/派生使用已验证manifest['files']的SHA与恢复后文件逐一比较；对两库分别执行SELECT * FROM fire_photos ORDER BY id和SELECT * FROM fire_photo_order_requests ORDER BY id，结果逐行比较。rejected/replaced原链接在restored_admin为200、restored_staff为404；自己pending在restored_staff仍200、other为404。包与恢复兼容工具另用对应当前源码的测试专用归档，不引用旧停用项目。

旧版回退验证仅可读取本项目保留的匹配官方发布ZIP在安全fixture内核验；不真实回退、不连接服务器、不改正式数据。若官方包不存在，按既有工具构造严格虚构“旧声明未含fire表”兼容测试并明确“官方历史包未验证”；恢复工具对非空未知fire表必须拒绝。不能为了回退通过删新表、历史原件或放宽未知表保护。

- [ ] **Step 5: 运行集成及既有相关回归，只在失败/新变更时追加检查。**

~~~powershell
& 'D:\乐秀平台系统\Temp\optimization_20261006\clean_env\Scripts\python.exe' 'Temp\fire_photo_book_20261007\test_integrations.py' -v
& 'D:\乐秀平台系统\Temp\optimization_20261006\clean_env\Scripts\python.exe' -m unittest discover -s 'Temp\rectification_20261006' -p 'test_weekly*.py' -v
& 'D:\乐秀平台系统\Temp\optimization_20261006\clean_env\Scripts\python.exe' -m unittest discover -s 'Temp\blackgold_upgrade_20261005' -p 'test_release_scripts.py' -v
& 'D:\乐秀平台系统\Temp\optimization_20261006\clean_env\Scripts\python.exe' -m unittest discover -s 'Temp\optimization_20261006' -p 'test_operations.py' -v
~~~

先确认所跑旧测试全部通过统一安全入口，不运行先正常import app后改DB路径的旧脚本。Task3通过标准：四状态照片引用缺失都能被拦、JSON包含两表、虚构备份还原数据/字节/权限一致、火表新增/资源/未知表门槛有正反案例、周期保留类别不受改变；没有生产备份或远程部署行为。

## 最终相关回归、浏览器验收与交接

- [ ] 三个消防任务全部测试串行通过后，执行一次所有消防测试与既有相关权限、上传、审核、登录、库存/资产、台账、备份回归，不重复已通过且无新变化的整套测试。
- [ ] 审查精确diff：app.py仅新表、消防模块、消防审核分发与两表台账；旧证照提前commit由当前总目标Task3独立改动，不混成消防设计；其他旧业务行为不重构。
- [ ] 当前SOURCE VERSION未改变；没有Git操作、正式发布包、正式迁移/数据写入、服务器配置或外部消息。静态资源源代码检查和虚构ZIP测试不算发布。
- [ ] 重新以安全入口唯一虚构站验证两角色、1280/390/320宽度、40目录、多选/取消/＋/失败重试、21张以上、真实审核、更换/排序基准冲突、精确删除影响、匿名/直链拒绝。
- [ ] Chrome实际打印/保存PDF验证一图一页、标题页码、竖横图四角和虚构签字完整、原字节未改、空框/待审/控件不输出、缺图入口受阻、分册合并不漏重；记录采用的实测分册/队列参数。
- [ ] 真实iPhone/Android/微信拍照和纸张清晰度有设备就验，没有就明确未验证；不把桌面宽度或PDF渲染当真实手机/纸张验收。
- [ ] 将本机修改/影响/测试事实、未验证项、精准访问入口写到消防整改记录；AGENTS.md同步已获用户批准的消防角色/排序/打印规则，不改审计报告。交小北独立复测，问题关闭以复测报告为准。
- [ ] 用户本机验收且明确“可以发”后，另行递增版本、双备份、打包不含data、先迁移后重启、核对新表/资源/附件/密钥/数据条数/正式预览关闭；本计划到本机可审阅交付止。

## 计划自核对

固定40目录、无输入字段、同框按需追加、15MB/30M/20MB、原件/派生、部分失败、员工待审及基准冲突、原审核中心、准确删除、A4清晰打印、加载及二次授权、分册、全状态备份、两表台账与发布白名单均有任务/测试落点。单批与分册数值已给候选与调整依据，不是业务总量上限。打印入口控制不承诺阻止Ctrl+P或事后撤回。

当前主代理已采纳删除单一照片/关联待审退回保留/历史保留/剩余引用检查，以及内部批索引、原件哈希/尺寸、基准变化409。SQL、API与以下测试已按同一批序合同统一，不再提供改变业务要求的替代方案。真实设备与纸质打印条件如不足只影响验收标注，不自行降低标准，不自行发布。

## 同批顺序固定合同与Task1补充测试

同批绑定上传用户ID+目录+UUID batch_token，batch_index来自发送前确认顺序。照片表为该批唯一绑定来源；所有状态均参与归属/索引占用检查。新图字段必须有值；替换两字段NULL，旧图删除触发replaces_photo_id SET NULL不破坏其保留。原件失败重试必须仍带同batch/index/client_token；目录或用户变化不自动归入原批。

新增pending图生效在写锁内执行以下完整算法。新批首个生效图在目录末尾；存在同批更大索引时在其前，否则在最后较小索引后；位于两同批锚点间的旧图相对顺序不改变。当前同批已审图出现人工逆序时409“该批照片页序已变化，请先确认或调整页序”；新图继续pending，无文件/序号/日志部分提交。管理员直接新增也先插pending再调用相同算法；替换沿原图位置的独立分支。

~~~python
def fire_approve_new_photo(db, row, reviewer):
    if row['status'] != 'pending' or not row['batch_token'] or row['batch_index'] is None:
        raise ValueError('不是可通过的新增照片')
    current = fire_current_rows(db, row['directory_code'])
    siblings = [p for p in current
                if p['batch_token'] == row['batch_token']
                and p['uploaded_user_id'] == row['uploaded_user_id']]
    indexes = [p['batch_index'] for p in siblings]
    if any(a >= b for a, b in zip(indexes, indexes[1:])):
        raise RuntimeError('该批照片页序已变化，请先确认或调整页序')
    ids = [p['id'] for p in current]
    upper = next((p for p in siblings if p['batch_index'] > row['batch_index']), None)
    lower = next((p for p in reversed(siblings)
                  if p['batch_index'] < row['batch_index']), None)
    if upper is not None:
        insert_at = ids.index(upper['id'])
    elif lower is not None:
        insert_at = ids.index(lower['id']) + 1
    else:
        insert_at = len(ids)
    ids.insert(insert_at, row['id'])
    for position, photo_id in enumerate(ids, 1):
        if photo_id == row['id']:
            changed = db.execute(
                "UPDATE fire_photos SET status='approved',sort_order=?,"
                "reviewed_by=?,reviewed_at=? WHERE id=? AND status='pending'",
                (position, reviewer, now(), photo_id))
        else:
            changed = db.execute(
                "UPDATE fire_photos SET sort_order=? "
                "WHERE id=? AND directory_code=? AND status='approved'",
                (position, photo_id, row['directory_code']))
        if changed.rowcount != 1:
            raise RuntimeError('照片已变化，请重新确认')
~~~

加入test_backend.py的具体测试；API帮助方法add已经包含batch_token/index，因此下面可直接执行。

~~~python
def test_reverse_approval_keeps_confirmed_batch_and_old_relative_order(self):
    old_a, old_b = self.photo(self.admin), self.photo(self.admin)
    batch = str(uuid.uuid4())
    photos = [self.add(self.staff, batch_token=batch, batch_index=i,
                      name='batch_' + str(i) + '.jpg').get_json()['photo']
              for i in (1, 2, 3)]
    self.assertEqual(self.review('fire_photo', photos[2]['id']).status_code, 200)
    old_c = self.photo(self.admin)
    self.assertEqual(self.review('fire_photo', photos[0]['id']).status_code, 200)
    self.assertEqual(self.review('fire_photo', photos[1]['id']).status_code, 200)
    ids = self.staff.get('/api/fire/directories/A01/photos').get_json()['current_photo_ids']
    self.assertEqual(ids, [old_a['id'], old_b['id'],
                          photos[0]['id'], photos[1]['id'], photos[2]['id'], old_c['id']])

def test_partial_failed_upload_retry_keeps_batch_indexes(self):
    batch, first_token = str(uuid.uuid4()), str(uuid.uuid4())
    before = set(Path(self.m.UPLOAD_DIR).iterdir())
    with patch.object(self.m, 'make_web_and_thumb', return_value=(None, None)):
        failed = self.add(self.staff, token=first_token, batch_token=batch,
                          batch_index=1, name='first.jpg')
    self.assertEqual(failed.status_code, 400)
    self.assertEqual(set(Path(self.m.UPLOAD_DIR).iterdir()), before)
    second = self.add(self.staff, batch_token=batch, batch_index=2,
                      name='second.jpg').get_json()['photo']
    retried = self.add(self.staff, token=first_token, batch_token=batch,
                      batch_index=1, name='first.jpg')
    self.assertEqual(retried.status_code, 200)
    first = retried.get_json()['photo']
    self.assertEqual(self.review('fire_photo', second['id']).status_code, 200)
    self.assertEqual(self.review('fire_photo', first['id']).status_code, 200)
    self.assertEqual(self.staff.get('/api/fire/directories/A01/photos').get_json()
                     ['current_photo_ids'], [first['id'], second['id']])
    with sqlite3.connect(self.m.DB_PATH) as db:
        rows = db.execute('SELECT client_token,batch_index FROM fire_photos '
                          'WHERE batch_token=? ORDER BY batch_index', (batch,)).fetchall()
    self.assertEqual(len(rows), 2)
    self.assertEqual(rows[0], (first_token, 1))

def test_batch_user_directory_and_index_binding_reject_forgery(self):
    batch = str(uuid.uuid4())
    accepted = self.add(self.staff, batch_token=batch, batch_index=1)
    self.assertEqual(accepted.status_code, 200)
    before = set(Path(self.m.UPLOAD_DIR).iterdir())
    self.assertEqual(self.add(self.other, batch_token=batch, batch_index=2).status_code, 403)
    self.assertEqual(self.add(self.staff, code='B01', batch_token=batch,
                              batch_index=2).status_code, 400)
    self.assertEqual(self.add(self.staff, batch_token=batch, batch_index=1).status_code, 409)
    self.assertEqual(set(Path(self.m.UPLOAD_DIR).iterdir()), before)
    with sqlite3.connect(self.m.DB_PATH) as db:
        self.assertEqual(db.execute('SELECT COUNT(*) FROM fire_photos').fetchone()[0], 1)

def test_manual_reverse_batch_blocks_later_approval_without_overwrite(self):
    batch = str(uuid.uuid4())
    photos = [self.add(self.staff, batch_token=batch, batch_index=i,
                      name='manual_' + str(i) + '.jpg').get_json()['photo']
              for i in (1, 2, 3)]
    for p in photos[:2]:
        self.assertEqual(self.review('fire_photo', p['id']).status_code, 200)
    base = [photos[0]['id'], photos[1]['id']]
    reverse = list(reversed(base))
    changed = self.admin.post('/api/fire/directories/A01/order',
        json={'base_photo_ids':base, 'photo_ids':reverse}, headers=WRITE_HEADERS)
    self.assertEqual(changed.status_code, 200)
    result = self.review('fire_photo', photos[2]['id'])
    self.assertEqual(result.status_code, 409)
    self.assertEqual(self.staff.get('/api/fire/directories/A01/photos').get_json()
                     ['current_photo_ids'], reverse)
    with sqlite3.connect(self.m.DB_PATH) as db:
        self.assertEqual(db.execute('SELECT status,sort_order FROM fire_photos WHERE id=?',
                                   (photos[2]['id'],)).fetchone(), ('pending', None))
~~~

把人工逆序恢复为已确认的正序后，再次approve可通过；第一次409不能给新申请偷偷换批绕过。再补管理员同一批直接按3→1→2上传最终1→2→3、同令牌改batch/index为409、不重建原件、替换始终batch字段NULL并保持旧位置、SET NULL删除后保留替换记录等断言。所有测试仍只用唯一虚构fixture。
