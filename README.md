# 乐秀平台系统

乐秀 KTV 内部管理平台，使用 Flask、SQLite 和原生页面，包含证照、健康证、固定资产、仓库、用户、日志和备份模块。

## 本机运行

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
$env:PORT='5001'
$env:HOST='127.0.0.1'
.\.venv\Scripts\python.exe app.py
```

浏览器打开 `http://127.0.0.1:5001/`。业务数据默认放在本地 `data/` 目录；该目录包含数据库、附件和会话密钥，已被 Git 忽略，不应提交或公开。

## 项目结构

- `app.py`：Flask 应用与接口
- `templates/`：页面模板
- `static/`：样式、脚本和静态资源
- `docs/`：公开设计方案与交互原型

## 验证

启动后请检查登录页 `/` 与公开酒水单 `/drinks`；代码改动可先运行 `python -m py_compile app.py weekly_backup.py`。

## 协作约定

请先创建分支，再提交聚焦的变更；提交前说明修改范围、验证命令和未验证事项。生产数据、附件、密钥、远程维护脚本和内部审计记录不属于公开仓库内容。

公开仓库只用于代码协作。生产部署、备份恢复和账号运维请在受控的私有环境中执行。

## 手机前端演示版

新增的独立目录 [`mobile-frontend/`](mobile-frontend/README.md) 使用 Vue 3、TypeScript 与 Vant，提供员工/管理员及公开酒水单的手机页面演示。它不连接后端，也不替换现有 Flask 页面；运行方式、演示账号和对接边界见其 README。
