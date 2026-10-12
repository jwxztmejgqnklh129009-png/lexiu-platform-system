# -*- coding: utf-8 -*-
"""周期完整备份：SQLite 在线快照 + 附件 + 密钥，验证整套后独立保留 3 套。

仅生成数据备份，不迁移、不初始化、不恢复、不部署。正式执行前须经用户放行。
python weekly_backup.py --root <server-app-dir>
"""
import argparse
from contextlib import closing
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import stat
import sys
import uuid

MANAGED_BY = 'lexiu-weekly-data-v1'
MANIFEST = 'weekly-manifest.json'
FULL_RE = re.compile(r'data_weekly_([0-9a-f]{32})_[0-9]{8}-[0-9]{6}(?:-[0-9]+)?')
SNAPSHOT_RE = re.compile(r'app_weekly_([0-9a-f]{32})_[0-9]{8}-[0-9]{6}\.db')


def utc_now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def next_scheduled_run():
    """返回下一次周日北京时间 06:00 的提示时间。"""
    cst = datetime.timezone(datetime.timedelta(hours=8))
    current = datetime.datetime.now(cst)
    days = (6 - current.weekday()) % 7
    candidate = current.replace(hour=6, minute=0, second=0, microsecond=0) + datetime.timedelta(days=days)
    if candidate <= current:
        candidate += datetime.timedelta(days=7)
    return candidate.isoformat()


def no_links(path):
    """Reject symlinks/junctions in both the target and all existing ancestors."""
    path = Path(path).absolute()
    for item in (path, *path.parents):
        if item.exists() or item.is_symlink():
            info = item.lstat()
            if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
                raise ValueError('路径包含链接，拒绝备份或清理：' + str(item))
    return path.resolve()


def file_hash(path):
    path = no_links(path)
    if not path.is_file():
        raise ValueError('缺少普通文件：' + str(path))
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def write_json(path, value):
    path = no_links(path)
    part = path.with_name(path.name + '.' + uuid.uuid4().hex + '.part')
    try:
        with part.open('x', encoding='utf-8') as stream:
            json.dump(value, stream, ensure_ascii=True, indent=2)
            stream.write('\n')
        os.chmod(part, 0o600)
        os.replace(part, path)
    finally:
        if part.exists():
            part.unlink()


def database_info(path):
    path = no_links(path)
    if not path.is_file() or not path.stat().st_size:
        raise ValueError('数据库不存在或为空')
    with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)) as db:
        if db.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
            raise ValueError('数据库 quick_check 校验失败')
        tables = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
        if not tables:
            raise ValueError('数据库没有业务表，拒绝初始化或备份空库')
        counts = {name: db.execute('SELECT COUNT(*) FROM "' + name.replace('"', '""') + '"').fetchone()[0] for name in tables}
    return {'quick_check': 'ok', 'counts': counts}


def asset_inventory(data_dir):
    data_dir = no_links(data_dir)
    uploads = no_links(data_dir / 'uploads')
    key = no_links(data_dir / 'secret.key')
    if not uploads.is_dir() or not key.is_file() or not key.read_text(encoding='utf-8').strip():
        raise ValueError('附件目录或现存密钥缺失，拒绝创建替代数据')
    files = {'secret.key': {'sha256': file_hash(key), 'bytes': key.stat().st_size}}
    for directory, dirs, names in os.walk(uploads, followlinks=False):
        for name in sorted(dirs + names):
            item = no_links(Path(directory) / name)
            if item.is_dir():
                continue
            if not item.is_file():
                raise ValueError('附件包含非普通文件')
            files[item.relative_to(data_dir).as_posix()] = {'sha256': file_hash(item), 'bytes': item.stat().st_size}
    return files


def preflight_data(data_dir):
    """Must run before importing app.py, whose import can create uploads/key."""
    assets = asset_inventory(data_dir)
    database_info(Path(data_dir) / 'app.db')
    return assets


def attachment_references(database, data_dir):
    """Attachment fields follow recovery checks; active parents follow srv_check.snapshot()."""
    uploads = no_links(Path(data_dir) / 'uploads')
    references = []
    with closing(sqlite3.connect(no_links(database).as_uri() + '?mode=ro', uri=True)) as db:
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        fire_tables = {'fire_photos', 'fire_photo_order_requests'}
        if tables & fire_tables and not fire_tables <= tables:
            raise ValueError('消防照片册表不完整')
        for table, fields in (('versions', ('stored_name', 'web_name', 'thumb_name')),
                              ('drink_pages', ('stored_name', 'web_name', 'thumb_name')),
                              ('inventory_items', ('image_web', 'image_thumb')),
                              ('inventory_image_versions', ('web_name', 'thumb_name')),
                              ('fire_photos', ('stored_name', 'web_name', 'thumb_name'))):
            if table not in tables:
                continue
            columns = {row[1] for row in db.execute('PRAGMA table_info("' + table + '")')}
            if table == 'fire_photos' and not set(fields) <= columns:
                raise ValueError('消防照片册附件字段不完整')
            selected = [field for field in fields if field in columns]
            if not selected:
                continue
            source = ' FROM "' + table + '" r'
            condition = ''
            if table == 'inventory_items' and 'active' in columns:
                condition = ' WHERE r.active=1'
            parent = {'versions': ('certificates', 'cert_id'),
                      'inventory_image_versions': ('inventory_items', 'item_id')}.get(table)
            if parent and parent[0] in tables and parent[1] in columns:
                parent_columns = {row[1] for row in db.execute('PRAGMA table_info("' + parent[0] + '")')}
                if {'id', 'active'} <= parent_columns:
                    source += ' JOIN "' + parent[0] + '" p ON p.id=r."' + parent[1] + '"'
                    condition = ' WHERE p.active=1'
            query = 'SELECT ' + ','.join('r."' + field + '"' for field in selected) + source + condition
            for row in db.execute(query):
                for field, filename in zip(selected, row):
                    if not filename:
                        continue
                    if (not isinstance(filename, str) or filename in ('.', '..') or
                            any(char in filename for char in ('/', '\\', ':')) or
                            no_links(uploads / filename).parent != uploads or not (uploads / filename).is_file()):
                        raise ValueError('存在缺失或越界附件引用：' + table + '.' + field)
                    references.append([table, field, filename])
    encoded = json.dumps(sorted(references), ensure_ascii=True, separators=(',', ':')).encode('utf-8')
    return {'count': len(references), 'sha256': hashlib.sha256(encoded).hexdigest()}


def validate_manifest(value, directory_name):
    match = FULL_RE.fullmatch(directory_name)
    if (not isinstance(value, dict) or value.get('managed_by') != MANAGED_BY or
            value.get('verified') is not True or not match or value.get('backup_id') != match.group(1) or
            value.get('directory') != directory_name):
        raise ValueError('周期备份管理标记校验失败')
    snapshot = value.get('snapshot', '')
    snap_match = SNAPSHOT_RE.fullmatch(snapshot) if isinstance(snapshot, str) else None
    if not snap_match or snap_match.group(1) != value['backup_id']:
        raise ValueError('周期快照名称校验失败')
    if not isinstance(value.get('source_version'), str) or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', value['source_version']):
        raise ValueError('周期备份缺少有效的对应代码版本')
    stamp = datetime.datetime.fromisoformat(value['created_at'])
    if stamp.tzinfo is None:
        raise ValueError('周期备份时间缺少时区')
    files = value.get('files')
    if not isinstance(files, dict) or not {'app.db', 'secret.key'}.issubset(files):
        raise ValueError('周期备份文件清单不完整')
    for name, info in files.items():
        relative = Path(name)
        if (not isinstance(name, str) or '\\' in name or relative.is_absolute() or
                any(part in ('..', '.', '') for part in name.split('/')) or
                not (name in ('app.db', 'secret.key') or name.startswith('uploads/')) or
                not isinstance(info, dict) or not re.fullmatch(r'[0-9a-f]{64}', info.get('sha256', '')) or
                type(info.get('bytes')) is not int or info['bytes'] < 0):
            raise ValueError('周期文件清单路径或摘要校验失败')
    uploads = [info for name, info in files.items() if name.startswith('uploads/')]
    if value.get('uploads') != {'count': len(uploads), 'bytes': sum(info['bytes'] for info in uploads)}:
        raise ValueError('附件数量或体积校验失败')
    return value


def verify_backup(directory):
    directory = no_links(directory)
    if {path.name for path in directory.iterdir()} != {'app.db', 'uploads', 'secret.key', MANIFEST, '备份说明.txt'}:
        raise ValueError('周期目录含异常额外内容，拒绝校验及清理')
    with no_links(directory / MANIFEST).open(encoding='utf-8') as stream:
        manifest = validate_manifest(json.load(stream), directory.name)
    actual = asset_inventory(directory)
    db = directory / 'app.db'
    actual['app.db'] = {'sha256': file_hash(db), 'bytes': db.stat().st_size}
    if actual != manifest['files'] or database_info(db) != manifest['database']:
        raise ValueError('完整周期备份校验失败')
    if attachment_references(db, directory) != manifest['attachment_references']:
        raise ValueError('周期快照附件引用校验失败')
    snapshot = no_links(directory.parent / manifest['snapshot'])
    if snapshot.parent != directory.parent or file_hash(snapshot) != manifest['files']['app.db']['sha256']:
        raise ValueError('独立数据库快照与整套数据库校验不一致')
    if (directory / 'backups').exists():
        raise ValueError('备份包含递归 backups 目录')
    # Also refuse unexpected symlinks outside the three payload categories before deletion.
    for parent, dirs, files in os.walk(directory, followlinks=False):
        for name in dirs + files:
            no_links(Path(parent) / name)
    return manifest


def prune_backups(backup_root, keep=3, protect=None):
    if type(keep) is not int or keep < 1:
        raise ValueError('至少保留 1 套周期备份')
    root = no_links(backup_root)
    candidates = []
    for path in root.iterdir():
        if not FULL_RE.fullmatch(path.name):
            continue
        try:
            manifest = verify_backup(path)
        except (OSError, ValueError, KeyError, TypeError, sqlite3.Error):
            continue  # Unknown, incomplete or damaged copies are never deletion candidates.
        candidates.append((manifest['created_at'], path, manifest))
    candidates.sort(key=lambda item: (item[0], item[2]['backup_id']), reverse=True)
    protected = no_links(protect) if protect else None
    kept = {path for _, path, _ in candidates[:keep]}
    if protected and protected not in kept:
        kept = {protected, *[path for _, path, _ in candidates if path != protected][:keep - 1]}
    removed = []
    for _, path, manifest in candidates:
        if path in kept:
            continue
        # Recheck exact containment and the management marker immediately before deletion.
        target = no_links(path)
        if target.parent != root or verify_backup(target) != manifest:
            raise ValueError('周期清理目标校验失败')
        snapshot = no_links(root / manifest['snapshot'])
        shutil.rmtree(target)
        snapshot.unlink()
        removed.append(target.name)
    return removed


def run_backup(app_module, keep=3):
    value = {'ok': False, 'backup_verified': False, 'managed_by': MANAGED_BY,
             'started_at': utc_now(), 'stage': 'preflight', 'files': [], 'bytes': 0,
             'next_run': next_scheduled_run()}
    backup_root = None
    lock = None
    owned_lock = False
    snapshot_path = None
    directory_path = None
    previous_umask = os.umask(0o077)
    try:
        # 状态文件只用于展示连续失败和最近成功，不参与备份内容校验。
        try:
            old_status_path = no_links(Path(app_module.BACKUP_DIR) / 'weekly-status.json')
            if old_status_path.is_file():
                with old_status_path.open(encoding='utf-8') as stream:
                    old_status = json.load(stream)
            else:
                old_status = {}
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            old_status = {}
        value['last_success'] = old_status.get('last_success')
        value['last_failure'] = old_status.get('last_failure')
        value['consecutive_failures'] = int(old_status.get('consecutive_failures') or 0)
        value['source_version'] = app_module.VERSION
        if not isinstance(value['source_version'], str) or not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+', value['source_version']):
            raise ValueError('来源代码版本无效')
        data = no_links(app_module.DATA_DIR)
        if (no_links(app_module.DB_PATH) != data / 'app.db' or
                no_links(app_module.UPLOAD_DIR) != data / 'uploads' or
                no_links(app_module.BACKUP_DIR) != data / 'backups'):
            raise ValueError('应用数据路径不一致')
        before = preflight_data(data)
        backup_root = no_links(app_module.BACKUP_DIR)
        backup_root.mkdir(mode=0o700, exist_ok=True)
        lock = backup_root / '.weekly-backup.lock'
        with lock.open('x', encoding='utf-8') as stream:
            stream.write(str(os.getpid()))
        owned_lock = True
        value['backup_id'] = uuid.uuid4().hex
        tag = 'weekly_' + value['backup_id']
        value['stage'] = 'database_snapshot'
        snapshot = app_module.backup_db_file(tag)
        if not snapshot:
            raise ValueError('数据库在线快照失败')
        snapshot = no_links(snapshot)
        snapshot_path = snapshot
        snap_match = SNAPSHOT_RE.fullmatch(snapshot.name)
        if snapshot.parent != backup_root or not snap_match or snap_match.group(1) != value['backup_id']:
            raise ValueError('新快照路径校验失败')
        os.chmod(snapshot, 0o600)
        value['snapshot'] = str(snapshot)
        db_info = database_info(snapshot)
        value['stage'] = 'copy_full_data'
        directory = app_module.backup_data_dir(tag, db_snapshot=str(snapshot), keep=None, payload_only=True)
        if not directory:
            raise ValueError('完整附件与密钥备份失败')
        directory = no_links(directory)
        directory_path = directory
        full_match = FULL_RE.fullmatch(directory.name)
        if directory.parent != backup_root or not full_match or full_match.group(1) != value['backup_id']:
            raise ValueError('新完整备份路径校验失败')
        os.chmod(directory, 0o700)
        os.chmod(directory / 'secret.key', 0o600)
        os.chmod(directory / 'app.db', 0o600)
        value['directory'] = str(directory)
        value['stage'] = 'verify_full_set'
        after = asset_inventory(data)
        copied = asset_inventory(directory)
        if before != after or after != copied:
            raise ValueError('附件/密钥复制校验失败或备份期间发生变化，请重试')
        db = directory / 'app.db'
        copied['app.db'] = {'sha256': file_hash(db), 'bytes': db.stat().st_size}
        if copied['app.db']['sha256'] != file_hash(snapshot) or database_info(db) != db_info:
            raise ValueError('数据库一致性快照校验失败')
        references = attachment_references(db, directory)
        uploads = [info for name, info in copied.items() if name.startswith('uploads/')]
        manifest = {'managed_by': MANAGED_BY, 'verified': True, 'backup_id': value['backup_id'],
                    'source_version': value['source_version'],
                    'created_at': utc_now(), 'directory': directory.name, 'snapshot': snapshot.name,
                    'database': db_info, 'files': copied,
                    'attachment_references': references,
                    'uploads': {'count': len(uploads), 'bytes': sum(info['bytes'] for info in uploads)}}
        write_json(directory / MANIFEST, manifest)
        verify_backup(directory)
        value.update(backup_verified=True, files=sorted(copied), bytes=sum(info['bytes'] for info in copied.values()))
        value['stage'] = 'retention'
        value['removed'] = prune_backups(backup_root, keep=keep, protect=directory)
        verify_backup(directory)
        completed_at = utc_now()
        value.update(ok=True, stage='complete', completed_at=completed_at,
                     last_success=completed_at, consecutive_failures=0)
    except Exception as exc:
        failed_at = utc_now()
        value.update(error=type(exc).__name__ + '：' + str(exc), failed_at=failed_at,
                     last_failure=failed_at,
                     consecutive_failures=int(value.get('consecutive_failures') or 0) + 1)
    finally:
        # 本次没有完成 verify_backup 的快照和目录都属于未验证半成品，
        # 只清理由本次 backup_id 生成且仍在备份根目录内的对象。
        if not value.get('backup_verified'):
            for target, kind in ((directory_path, 'directory'), (snapshot_path, 'snapshot')):
                try:
                    if not target or not backup_root or target.parent != backup_root:
                        continue
                    if value.get('backup_id') and value['backup_id'] not in target.name:
                        continue
                    if kind == 'directory' and target.is_dir():
                        shutil.rmtree(target)
                    elif kind == 'snapshot' and target.is_file():
                        target.unlink()
                    value.setdefault('cleaned_unverified', []).append(target.name)
                except Exception as exc:
                    value.setdefault('cleanup_errors', []).append(type(exc).__name__ + '：' + str(exc))
        if owned_lock:
            try:
                no_links(lock).unlink()
            except Exception as exc:
                value.update(ok=False, lock_cleanup_error=type(exc).__name__ + '：' + str(exc))
        if backup_root and backup_root.is_dir():
            try:
                write_json(backup_root / 'weekly-status.json', value)
            except Exception as exc:
                value.update(ok=False, status_write_error=type(exc).__name__ + '：' + str(exc))
        os.umask(previous_umask)
    return value


def _load_application(root):
    spec = importlib.util.spec_from_file_location('lexiu_weekly_app', root / 'app.py')
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    try:
        spec.loader.exec_module(module)  # __name__ is not __main__; never call init_db().
    except BaseException:
        sys.modules.pop(spec.name, None)
        raise
    return module


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parent)
    args = parser.parse_args(argv)
    try:
        root = no_links(args.root)
        if not (root / 'app.py').is_file():
            raise ValueError('应用源码不存在')
        preflight_data(root / 'data')  # Always precedes app import and all mkdir operations.
        result = run_backup(_load_application(root))
    except (Exception, SystemExit) as exc:
        result = {'ok': False, 'stage': 'preflight_or_import', 'error': type(exc).__name__ + '：' + str(exc), 'failed_at': utc_now()}
    print(json.dumps(result, ensure_ascii=True), file=sys.stdout if result['ok'] else sys.stderr)
    return 0 if result['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())
