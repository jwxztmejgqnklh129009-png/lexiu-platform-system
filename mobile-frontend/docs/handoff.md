# 给维护者的交接说明

本次新增独立 `mobile-frontend/`，用于体验和确认新的手机界面。原后端、数据库、上传文件、模板和部署配置没有修改。后端基线：`b5d52ff07ed83a736de73319218d2dd759e7d5cc`。

## 如何体验

按 [README](../README.md) 执行 `npm ci`、`npm run dev`。用顶部身份按钮切换员工/管理员，查看同一条演示申请的提交、审批及结果回写。公开酒水单在 `/#/drinks`。

可以依次测试：

1. 员工新增仓库物品，进入待审详情。
2. 管理员在审核中心通过；回详情执行入库/出库，核对流水。
3. 员工上传一张测试图片；审核前旧生效图保留，审核后新图生效。
4. 新增证照/健康证、上传版本、提交字段修改，再用管理员审核。
5. 在消防A01体验两张非现场演示样张的顺序和分册；只打印已生效照片。
6. 固定资产领用/归还，查看详情中的人员与时间历史。
7. 管理员维护酒单，公开页翻页、放大；客户没有下单入口。

## 接入原 Flask 时

前端 `src/stores/` 当前是本机演示实现。不要把演示身份切换或浏览器密码摘要当作正式认证。接入时应复用原后端会话、权限与已存在接口，按真实响应核对并替换读写；先保持字段和审核规则一致。

以下路由已从本仓库 `app.py` 核对，只作接入定位，具体请求/响应仍以实现为准：

| 业务 | 原有接口定位 |
|---|---|
| 会话/账号 | `/api/login`、`/api/logout`、`/api/me`、`/api/password`、`/api/users` |
| 企业证照 | `/api/certificates`、`/api/certificates/<cid>`、`/api/certificates/<cid>/versions` |
| 健康证创建 | `/api/health-certs`；勿混同独立员工档案创建 |
| 消防 | `/api/fire/directories`、`/api/fire/directories/<code>/photos`、`/api/fire/photos/<pid>/replacement`、`/api/fire/directories/<code>/order` |
| 消防打印 | `/api/fire/print-manifest`、`/api/fire/print-check` |
| 仓库 | `/api/inventory`、`/api/inventory/<iid>`、`/in`、`/out`、`/count`、`/logs`、`/image`（后五项挂在具体物品路径后） |
| 分类盘点 | `/api/inventory/stocktake` |
| 固定资产 | `/api/assets`、`/api/assets/<aid>/move`、`/api/assets/<aid>/logs` |
| 审核 | `/api/reviews`、`/api/reviews/<kind>/<rid>` |
| 酒单 | `/api/drinks`、`/api/drink-pages`、`/api/drink-pages/<pid>`、`/api/drink-pages/<pid>/move`、`/api/drink-note` |
| 原后端备份 | `/api/backup`；演示文字台账不是该备份能力的替代品 |

原请求使用 Cookie 会话，写入需满足原有同源及 `X-Requested-With: lexiu` 检查。仓库列表和审核列表的返回结构不同，不能套用臆造的统一响应。盘点保留数量与最新流水双基准，审核保留可见性和旧生效内容；原有8种审核类型为 `cert/version/cert_edit/item/item_image/asset/fire_photo/fire_order`。

保留原项目的两个业务口径：到期提醒仍按固定15天档位（虽然有提醒天数字段），月初数量公式沿原实现。若要改变这些规则，请单独确认需求并同时验证后端。

接入真实后端时，文件URL、审核状态、并发冲突和权限判定以服务端为准。演示记录的ID、文件引用和状态不应直接导入生产数据库。

## 下一阶段验收

完成真实会话/权限、服务端文件保存、多人并发和断网/重试后，在实际手机与微信环境核对输入法、软键盘、安全区、图片和打印。再由门店人员按真实任务确认功能与视觉，最后部署。
