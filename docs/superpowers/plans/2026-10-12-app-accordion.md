# 应用页纵向手风琴导航实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将手机应用页的三个业务分组改为纵向单开手风琴，默认只显示分组标题，点击后显示该分组内的功能入口。

**Architecture:** 保留现有 `view-apps`、功能入口和权限类名，只给每个 `app-group` 增加原生 button 触发器与可折叠面板。交互由 `static/app.js` 绑定，使用 `aria-expanded`、`aria-controls` 和 `hidden` 表达状态；样式集中在现有应用导航 CSS 区域，移动端面板统一一列。

**Tech Stack:** Flask/Jinja 模板、原生 JavaScript、现有 CSS、Python `unittest` 源码契约测试。

**Spec:** 用户 2026-10-12 已确认的应用页纵向手风琴设计；现有 `AGENTS.md` 的黑金登录/首页、米白业务页、权限不变和本机双端验证要求。

## Global Constraints

- 只修改应用页相关模板、脚本、样式和对应测试，不重构其他模块。
- 不改变管理员/普通员工权限，不改变功能入口 URL 和 `go()` 路由。
- 默认所有分组收起；同一时间最多展开一个分组；刷新后恢复全部收起。
- 生产数据、`data/`、版本号、部署脚本和服务器均不触碰。
- 本机必须验证桌面宽度和手机宽度，并运行相关测试与脚本语法检查。

### Task 1: 建立应用页手风琴契约

**Files:**
- Modify: `Temp/product_optimization_20261011/test_ui_contracts.py`

- [ ] **Step 1: Write the failing test**

增加 `test_apps_use_vertical_single_open_accordion`，检查模板包含 `app-accordion-trigger`、`app-accordion-panel`、`aria-expanded`、`aria-controls`，脚本包含 `bindAppAccordion` 和 `hidden` 状态控制，样式包含应用页一列布局。

- [ ] **Step 2: Run test to verify it fails**

运行：`C:\Users\Administrator\.workbuddy\binaries\python\envs\default\Scripts\python.exe Temp\product_optimization_20261011\test_ui_contracts.py`

预期：新增测试失败，原因是当前模板、脚本和样式还没有手风琴契约。

### Task 2: 实现模板与原生交互

**Files:**
- Modify: `templates/index.html:199-224`
- Modify: `static/app.js:2282` 附近的 DOMContentLoaded 初始化区

- [ ] **Step 1: Write minimal implementation**

把三个 `.app-group-heading` 改为原生 `button.app-accordion-trigger`，分别关联 `app-panel-records`、`app-panel-supplies`、`app-panel-admin`；面板使用 `app-accordion-panel` 和 `hidden`，保留原有功能卡、`onclick`、`href`、`admin-only hidden`。

在 `static/app.js` 增加 `bindAppAccordion()`：初始化所有触发器为收起；点击时先收起其他分组，再切换当前面板；同步 `aria-expanded`、`hidden` 和 `data-open`。原生 button 自动支持 Enter/Space。

- [ ] **Step 2: Run the focused test**

运行：`C:\Users\Administrator\.workbuddy\binaries\python\envs\default\Scripts\python.exe Temp\product_optimization_20261011\test_ui_contracts.py`

预期：全部 UI 契约测试通过。

### Task 3: 实现纵向视觉并验证

**Files:**
- Modify: `static/style.css:731-785`
- Modify: `docs/整改记录-20261011-产品体验优化.md`

- [ ] **Step 1: Write minimal implementation**

为触发器建立全宽、可聚焦、带右侧箭头的分组标题样式；展开时箭头旋转；应用页 `.app-module-grid` 在所有目标宽度均为一列；面板收起时由 `hidden` 隐藏，保持米白业务页配色和底部导航。

- [ ] **Step 2: Run verification**

运行 UI 契约测试、`C:\Program Files\nodejs\node.exe --check static\app.js` 和 `git diff --check`。

使用本机 `http://127.0.0.1:5001/preview`：在手机宽度进入“应用”，确认只见三个分组标题；点击“档案管理”显示三个入口；点击“物资管理”后档案面板收起且物资面板显示；切换桌面宽度确认仍为纵向排列，浏览器控制台无错误。

- [ ] **Step 3: Commit**

提交信息：`feat: add accordion app navigation`
