# 手机版工作台应用导航实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将手机底部导航收敛为“工作台、应用、我的”三项，并按已确认的业务分组承载现有模块。

**Architecture:** 保留现有 `go(view)` 单页切换和管理员后端权限，只新增两个前端视图 `apps` 与 `me`。移动端底栏固定在视口底部，桌面端仍使用现有侧栏；业务模块本身和接口不改。

**Tech Stack:** Flask 模板、原生 HTML/CSS、现有 `static/app.js`，不增加依赖。

**Spec:** 用户已确认的“工作台应用”手机版底部导航方案：工作台承载待处理事项，应用按档案管理 / 物资管理 / 后台管理分组，我的承载个人与管理员工具。

## Global Constraints

- 只使用现有业务模块，不新增业务功能、字段、接口或角色。
- 桌面端继续使用现有黑金导航，移动端业务页保持米白配色。
- 普通员工不显示审核中心、酒水单、系统设置、账号管理和台账下载等管理员入口。
- 不操作 `data/app.db`、`data/uploads/`，不打包，不部署。
- 固定底栏必须给页面内容预留底部空间，不能遮挡表格、表单和按钮。
- 本机验证必须覆盖桌面宽度、手机宽度、管理员和普通员工视图。

---

### Task 1: 增加应用与我的导航视图

**Files:**
- Modify: `templates/index.html`（底部导航前的主内容区、底部导航、导航标签映射）
- Test: 浏览器中点击“应用”和“我的”，确认视图切换和管理员入口显示规则

**Interfaces:**
- Consumes: 现有 `go(view)`、`.admin-only`、`data-nav` 约定。
- Produces: `view-apps`、`view-me` 两个可由 `go('apps')` / `go('me')` 切换的页面视图，以及三项移动底栏入口。

- [x] **Step 1: 新增应用页分组结构**

在 `templates/index.html` 的工作台区段之后增加 `section#view-apps`，分成：

```html
档案管理：企业证照、员工健康证、消防档案
物资管理：仓库管理、固定资产
后台管理（admin-only）：审核中心、酒水单、系统设置
```

模块按钮继续调用现有 `go()` 或 `/fire`，不复制业务实现。

- [x] **Step 2: 新增我的页结构**

增加 `section#view-me`，普通员工显示账号信息、修改密码和退出；管理员再显示账号管理、台账下载、审核中心和酒水单入口。退出按钮复用现有 `logoutBtn`，密码修改复用现有 `changePassword()`。

- [x] **Step 3: 替换移动底栏与标签映射**

把原先多个业务按钮替换为：

```html
工作台 -> data-nav="dashboard"
应用   -> data-nav="apps"
我的   -> data-nav="me"
```

在模板末尾 `LABELS` 中增加 `apps: '应用'` 和 `me: '我的'`。

- [x] **Step 4: 浏览器验证模板结构**

启动本机服务后，以管理员和普通员工分别点击三项底栏；确认应用分组内容、我的页内容和管理员隐藏入口符合上面的映射。

---

### Task 2: 接通单页导航状态

**Files:**
- Modify: `static/app.js:227-254, 2100-2120`（`go()`、`load()` 和登录后的导航显示）
- Test: 浏览器检查 `state.view`、标题高亮和返回工作台行为

**Interfaces:**
- Consumes: Task 1 的 `view-apps`、`view-me` DOM 节点。
- Produces: `go('apps')` 与 `go('me')` 的统一显示 / 隐藏行为，且不触发不存在的接口加载。

- [x] **Step 1: 扩展视图清单**

在 `go()` 的视图数组加入 `apps`、`me`，在 `load()` 中对这两个视图直接返回，避免导航点击触发错误请求。

- [x] **Step 2: 保留权限收口**

继续使用现有 `api('/api/me')` 后的 `.admin-only` 切换；不把员工可见性改成仅管理员，也不依赖前端权限作为后端安全边界。

- [x] **Step 3: 浏览器验证状态切换**

验证三项底栏均能切换，当前项有 `on` 状态，面包屑显示正确；从应用页进入现有模块后，现有业务页面加载不受影响。

---

### Task 3: 固定移动底栏并预留内容空间

**Files:**
- Modify: `static/style.css:568-578, 600-675`（移动端 `.tabbar`、`.tab-item` 和页面底部间距）
- Test: 390px、360px 和桌面宽度截图与点击测试

**Interfaces:**
- Consumes: Task 1 的三项 `.tab-item` 结构。
- Produces: 移动端固定底部导航，安全区内边距和页面底部留白，桌面端不改变现有侧栏。

- [x] **Step 1: 固定底栏布局**

移动端使用 `position: fixed; left: 0; right: 0; bottom: 0;` 和三等分网格，每项保留至少 44px 触控高度；保留黑金配色和当前选中样式。

- [x] **Step 2: 预留内容底部空间**

在手机端主内容增加底部 padding，并叠加 `env(safe-area-inset-bottom)`，确保长表格、表单和弹窗触发区域不被底栏遮住。

- [x] **Step 3: 验证响应式结果**

在 390px 与 360px 宽度确认三项按钮不横向溢出；在桌面宽度确认底栏继续隐藏、侧栏仍可用；滚动长页面确认底栏持续可见且最后一项内容可触达。

---

## Verification Checklist

- [x] 模板和 JavaScript 静态语法检查通过。
- [x] 管理员：工作台、应用、我的均可进入；后台管理和管理员工具显示。
- [x] 普通员工：工作台、应用、我的均可进入；管理员入口隐藏。
- [x] 手机宽度底栏固定且不遮挡内容（390px/360px 断点样式与安全区留白已静态核验，设计预览已完成点击验证）。
- [x] 桌面宽度侧栏和现有业务模块保持可用。
- [x] 未修改后端接口、数据库、生产数据和发布包。
