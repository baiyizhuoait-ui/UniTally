# Firebase Cloud Functions 部署指南

## 1. 安装 Firebase CLI

```bash
npm install -g firebase-tools
```

## 2. 登录 Firebase

```bash
firebase login
```

## 3. 初始化 Firebase 项目

在项目根目录运行：

```bash
firebase init
```

选择以下选项：
- Functions: Configure a Cloud Functions directory
- Firestore: Configure security rules and indexes files
- Use an existing project (选择你的 Firebase 项目)

## 4. 安装 Functions 依赖

```bash
cd functions
npm install
```

## 5. 配置环境变量

在 `functions` 目录下创建 `.env` 文件：

```
RESEND_API_KEY=re_guX21Bs8_58LaaL9kX6gZxLLrXm5jLyv3
```

或者使用 Firebase CLI 设置：

```bash
firebase functions:config:set resend.api_key="re_guX21Bs8_58LaaL9kX6gZxLLrXm5jLyv3"
```

## 6. 构建 Functions

```bash
cd functions
npm run build
```

## 7. 本地测试（可选）

```bash
firebase emulators:start --only functions
```

## 8. 部署到 Firebase

```bash
firebase deploy --only functions
```

## 9. 前端配置

在 `.env` 文件中配置 Firebase：

```env
VITE_FIREBASE_API_KEY=your_api_key
VITE_FIREBASE_AUTH_DOMAIN=your_project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your_project_id
VITE_FIREBASE_STORAGE_BUCKET=your_project.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=your_sender_id
VITE_FIREBASE_APP_ID=your_app_id
```

## 10. 启用 Firebase 验证

在 `Login.tsx` 中传入 `useFirebase={true}`：

```tsx
<EmailVerification 
  email={email}
  onVerify={setEmailVerified}
  language={language}
  useFirebase={true}
/>
```

## 文件结构

```
project/
├── functions/
│   ├── src/
│   │   └── index.ts      # Cloud Functions 代码
│   ├── package.json
│   ├── tsconfig.json
│   └── .env              # Resend API Key
├── firebase.json         # Firebase 配置
├── firestore.rules       # Firestore 安全规则
└── firestore.indexes.json
```

## 已创建的 Cloud Functions

| 函数名 | 类型 | 说明 |
|--------|------|------|
| `sendVerificationCode` | HTTPS Callable | 发送验证码邮件 |
| `verifyCode` | HTTPS Callable | 验证验证码 |
| `cleanupExpiredCodes` | Scheduled | 每10分钟清理过期验证码 |

## 注意事项

1. **Resend 免费版限制**：每月 3,000 封邮件
2. **Firebase 免费版限制**：每天 2,000 次 Cloud Functions 调用
3. **验证码有效期**：10 分钟
4. **发送频率限制**：每分钟最多 1 次，每小时最多 5 次
