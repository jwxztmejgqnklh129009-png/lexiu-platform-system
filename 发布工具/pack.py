# -*- coding: utf-8 -*-
"""发布打包。仅在北於明确放行后执行；默认代码包不包含 data/。

python 发布工具/pack.py            -> 发布包/lexiu-code-v<版本>.zip
python 发布工具/pack.py withdata   -> 全量包（仅获准的首次部署/整机迁移）
历史包不得覆盖；版本从 app.py 的 VERSION 读取。
"""
from pathlib import Path
import re
import sys
import zipfile


def package_files(source, with_data=False):
    """Collect explicit roots only; safe to test without creating a release package."""
    source = Path(source).resolve(strict=True)
    root_files = ('app.py', 'AGENTS.md', 'README.md', 'requirements.txt', 'requirements-deploy.txt')
    version = re.search(r"^VERSION\s*=\s*['\"]([0-9]+\.[0-9]+\.[0-9]+)['\"]", (source / 'app.py').read_text(encoding='utf-8-sig'), re.M)
    if (source / 'weekly_backup.py').exists() or (version and tuple(map(int, version.group(1).split('.'))) >= (1, 14, 3)):
        root_files += ('weekly_backup.py',)
    root_dirs = ('templates', 'static', 'docs') + (('data',) if with_data else ())
    skip_dirs = {'__pycache__', '_停用脚本_可删除', '.venv', 'venv', '发布包'}
    if not with_data: skip_dirs.add('backups')
    files = []
    for name in root_files:
        item = source / name
        if item.is_symlink() or not item.is_file():
            raise ValueError('发布根文件不存在或不是普通文件：' + name)
        files.append((item, name))
    for name in root_dirs:
        directory = source / name
        if directory.is_symlink() or not directory.is_dir():
            raise ValueError('发布目录不存在或含链接：' + name)
        for item in sorted(directory.rglob('*')):
            relative = item.relative_to(source)
            if any(part in skip_dirs for part in relative.parts): continue
            if item.is_symlink(): raise ValueError('发布目录包含链接')
            if item.is_file():
                if not with_data and item.stat().st_size > 2 * 1024 * 1024:
                    continue  # Preserve the existing large-document exclusion.
                files.append((item, relative.as_posix()))
    return files


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if argv not in ([], ['withdata']):
        print('用法：python 发布工具/pack.py [withdata]', file=sys.stderr)
        return 1
    source = Path(__file__).resolve().parents[1]
    with_data = argv == ['withdata']
    try:
        match = re.search(r"^VERSION\s*=\s*['\"]([0-9]+\.[0-9]+\.[0-9]+)['\"]", (source / 'app.py').read_text(encoding='utf-8-sig'), re.M)
        if not match: raise ValueError('版本号无法读取')
        files = package_files(source, with_data)
        out = source / '发布包'; out.mkdir(exist_ok=True)
        target = out / ('lexiu-%s-v%s.zip' % ('full' if with_data else 'code', match.group(1)))
        if target.exists(): raise ValueError('该版本包已存在，请递增版本；禁止覆盖历史包')
        with zipfile.ZipFile(target, 'x', zipfile.ZIP_DEFLATED) as z:
            for item, name in files: z.write(item, name)
        print('已打包：%s\n共 %d 个文件，%.2f MB（%s）' % (target, len(files), target.stat().st_size / 1024 / 1024,
              '含数据' if with_data else '仅代码，不含数据'))
        return 0
    except Exception as exc:
        print('打包失败：' + type(exc).__name__ + '：' + str(exc), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
