# UniTally 上线前安全检查清单（06）

日期：2026-10-14 · 适用场景：合并 main / 部署公网 / 多用户使用前逐项清零
来源：外部代码质检报告，lead 已核实定位属实但**本地单人使用阶段不构成风险**，故统一推迟到上线前处理。

## 🔒 认证与密钥

- [ ] **DEV_BYPASS_AUTH**（src/contexts/AppContext.tsx:12）改回 `false`；如需本地调试保留，改成 `import.meta.env.DEV && import.meta.env.VITE_BYPASS_AUTH === 'true'` 门控
- [ ] **JWT_SECRET 强校验**（backend/utils/auth.js:34 回退 'your-secret-key'）：backend/server.js 启动时检查 `process.env.JWT_SECRET`（≥32 字符），缺失直接 `process.exit(1)`
- [ ] **firestore.rules:4-9** `allow read, write: if true` → `if false`（admin SDK 走服务端特权，客户端无需直读写 verificationCodes/rateLimits）
- [ ] **开发模式免验签门控**（backend/routes/auth.js:277,378）：`NODE_ENV === 'development'` 信任任意 email 的分支，增加 `ALLOW_INSECURE_DEV_AUTH === 'true'` 显式开关

## 🔒 注册 / 找回密码链路

- [ ] `/api/auth/register`（auth.js:167-190）校验邮箱已通过 `/verify-code`：verify 成功写 `verifiedEmails[email]` 并 **补调 saveDb()**（当前漏调，重启验证码复活）；register 核验存在且未过期才放行
- [ ] L94 明文 console.log 邮箱+验证码 → 仅 `NODE_ENV !== 'production'`
- [ ] `/reset-password`：挂 `authLimiter`；`typeof token === 'string'` 校验；密码最短 8 位
- [ ] `/forgot-password`：不存在邮箱也返回相同 200（防账号枚举）；`FRONTEND_URL` 补默认值
- [ ] OAuth 覆盖 provider 问题（auth.js:287-293 等）：登录/找回改判 `Boolean(user.password)`，允许同邮箱密码+Google 并存

## 🔒 AI 代理配额

- [ ] `x-user-plan` 请求头改为服务端查库（db.users → req.userId），不信任客户端头（backend/routes/ai.js:36,117,187,251）
- [ ] quotaMap 跨日清理历史键（防内存泄漏）
- [ ] `express.json({ limit: '32kb' })` 收紧 body 大小（backend/server.js:24）

## 📋 合并 main 前的另外两件事

- [ ] feature/ai-accounting → main 的合并方式：按 2026-10-07 约定**不开 PR**；若仓库 main 保护规则仍拦截直推，先问用户是否关闭 Rulesets
- [ ] 合并前确认 dbd236f（6 项缺陷修复）已包含在合并范围
