# API 分发

后台入口：`/imgadmin` → **API 分发**。与原站内 Key 独立，不互通。

创建时设置客户名称、总张数、到期时间和最大并发。总张数 `-1` 为不限，`0` 为不可出图；有效期留空为永久。增加总张数即可充值，编辑有效期即可续期。停用阻止后续请求，已经接收的请求仍会完成结算。

完整密钥只在创建成功时显示一次；数据库仅保存 SHA-256 摘要和前缀。丢失后停用旧密钥、创建新密钥。上游密钥不会交给客户。

## 接入

Base URL：`https://你的域名/v1`。调用方在服务端保管密钥。

```bash
curl https://你的域名/v1/images/generations \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-image-2","prompt":"一只在窗边晒太阳的猫","n":1,"size":"1024x1024"}'
```

同步返回上游图片 JSON，默认 `data[].b64_json`。客户端超时建议 360 秒；反向代理需允许长连接请求。该版本支持文生图，不包含图片编辑和流式返回。

- `POST /v1/images/generations`：必填 prompt；n 为 1–10 整数；模型固定 gpt-image-2。支持 size、quality、background、output_format、output_compression、moderation、response_format；这些可选能力仍取决于当前上游。size 可为 auto 或宽x高（每边 1–3840）。
- `GET /v1/usage`：返回 maxImages、usedImages、reservedImages、remaining、expiresAt 等；不限额度时 remaining 为 -1。余额用尽仍可查询，停用或到期后不可查询。
- `GET /v1/models`：可用模型列表。

三个接口均要求 `Authorization: Bearer 分发密钥`。错误格式为 `{"error":{"message":"说明"}}`。

状态码：400 参数错误；401 密钥无效；403 已停用或到期；429 余额或并发不足；502 上游拒绝或结果不确定；503 分发持久化不可用。请求受理后返回 `X-Request-Id`，可用于查找后台记录。不对 502/503 自动重试，避免重复出图；接口暂不提供幂等重放。

## 扣量与异常处理

SQLite 事务先预占请求张数，并同时检查总额度与并发数。成功后按实际返回图片数扣减，剩余预占退回；上游明确返回 4xx 时全部退回。网络超时、5xx、损坏的响应或进程重启无法确认是否已出图，保留额度和并发占位，在后台「记录 → 核对结算」填实际成功张数（0 表示全部退回）。结算只允许执行一次。

到期时间由浏览器按本地时间输入，存储为 UTC。额度不能改到低于已用与预占之和。调用记录不存储客户提示词或图片内容。

## 部署与备份

更新 server.js、api-distribution.js、distribution-backup.js、public/admin.html、public/admin-distribution.js 后重启 Node 服务。首次加载自动在现有 data/keys.db 中创建独立的 distribution_keys / distribution_requests 表，不重写原站内 Key。无需新增依赖。

Render 免费实例使用 GitHub 加密持久化，无需付费磁盘。需要 GITHUB_TOKEN、GITHUB_REPO、GITHUB_BRANCH 和 DISTRIBUTION_BACKUP_SECRET 环境变量。备份保存至 data/distribution-backup.json，使用 AES-256-GCM 加密，解密密钥只保存在 Render 环境变量中，请妥善保留，切勿随意更换。

每次创建、编辑、预占和结算均串行写入 GitHub，成功后才确认操作或发送上游生图请求。启动时从 GitHub 恢复全部分发密钥与额度。备份读取、写入或冲突校验失败会暂停分发接口，修复配置或网络后重启恢复。备份提交使用 [skip render] 避免触发自动部署。此方式适合低频分发，GitHub API 延迟和限流会影响操作速度；高并发业务应迁移到持久数据库。

原有 keys-backup.json 仅包含站内 Key，不包含分发额度。未配置 GITHUB_TOKEN 的本地部署使用 SQLite，必须自行持久化 data 目录。使用 SQLite 在线备份 API，或停服后备份完整 data 目录；运行中不要只复制 keys.db 而遗漏 WAL。

当前按单实例设计，请使用单 Node 实例。重新部署前尽量避开进行中请求；重启时未完成的预占会标记为待核对。GitHub 文件版本冲突会停止写入，避免两个实例覆盖额度。

验证命令：`npm run test:distribution`。测试在内存 SQLite 与模拟上游中运行，不读取生产密钥或消耗真实额度。
