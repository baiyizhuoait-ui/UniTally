# UniTally

An AI-powered accounting book that supports multiple currencies.

UniTally helps you track income and expenses across different currencies with real-time exchange rates, manage wallets, set budgets, track subscriptions, and visualize your spending — now with a full **AI accounting suite**: one-line transaction entry, smart paste detection, bill screenshot recognition, batch file import, and personalized spending insights. Bring your own key (BYOK) or run models locally — your financial data stays under your control.

> 📋 See [CHANGELOG.md](CHANGELOG.md) for the full update history.
>
> 🤖 The AI accounting suite lives on the [`feature/ai-accounting`](https://github.com/baiyizhuoait-ui/UniTally/tree/feature/ai-accounting) branch. Design documents: [`docs/unitally-ai/`](docs/unitally-ai/).

## Features

### 🤖 AI Accounting Suite

- **One-line entry** — type "昨天在泰国花了500株" and get a structured transaction (date, amount, THB, category) prefilled for confirmation
- **Two-stage parsing** — deterministic rule fast-path (regex + keyword categorization) handles the obvious cases with zero API cost; the LLM only sees ambiguous input
- **Smart paste detection** — copy a bill from WeChat/Alipay anywhere and the app asks if you want to import it; silent while you're pasting into a form
- **Bill screenshot recognition** — paste or upload a payment screenshot, a vision model (default: free GLM-4V-Flash) extracts every transaction; review with **inline editing** of type, merchant, datetime, amount, and category before importing
- **Batch file import** — upload WeChat/Alipay CSV bills, auto-categorized with duplicate fingerprints (same day + amount + type)
- **AI insights** — spending statistics and summaries with a rule-based fallback when no model is configured
- **Feedback loop** — your corrections are remembered and injected as few-shot examples, so parsing adapts to your habits
- **Three modes, honest status line** — Rule mode (no AI) / Cloud (BYOK) / Local (Ollama); the status badge reflects *verified* connectivity (local Ollama is health-checked, offline models never show a fake "connected" state)
- **27-currency awareness** — amount expressions in Chinese and English (¥ $ € £ ฿ ₩ 美元 ringgit baht rupiah…) map to correct ISO codes; unrecognized currencies fall back to your base currency instead of polluting records
- **Privacy by design** — BYOK direct connection (your key, your quota, stored only in localStorage) or a local Ollama model; a platform proxy with daily quota is available for quick starts

### Multi-Currency Accounting
- Track income and expenses in **27 supported currencies**
- Real-time exchange rates with automatic cross-rate calculation for all currency pairs
- Each currency has a distinct color based on its largest denomination banknote
- Cross-currency transfers with separate amount fields per currency

### Wallet Management
- Create and manage multiple wallets with custom icons and colors
- Wallet types: **Cash**, **Savings**, **Credit Card**, and **E-Wallet**
- Cash wallets are automatically created for your selected currencies during setup
- Credit cards display available credit (limit + balance) instead of current balance
- Wallet picker groups options by type
- Click any wallet to view an expense breakdown by category, filterable by time range with pie charts

### Transaction Tracking
- Record income and expenses with categories, notes, and timestamps
- Dedicated **transfer** tab for moving money between wallets (transfers are excluded from expense statistics)
- Filter by type, category, wallet, and platform
- 15 built-in categories — fully customizable
- Transfer-only filter in the transaction hall

### Budget Center
- Set budgets with amount, category, date range, and notes
- Visual progress tracking with spent / remaining / over-budget states
- **Subscription tracking** with providers, billing cycles, and amounts

### Analytics & Visualization
- **Data Dashboard**: total assets, monthly income/expense, asset trends, and category distribution charts
- **Expense Calendar**: visualize daily spending patterns with daily breakdowns and monthly stats
- **Exchange rate chart** with historical periods

### Data Management
- Data **export** (JSON) and **import** (premium)
- Email verification and password recovery (forgot / reset password)

### Customization
- Light / dark themes with 6 accent colors
- **4 UI styles**: Minimalist, Neumorphism, Brutalism, Cyberpunk
- Bilingual interface (Chinese / English)
- Custom avatar, book name, and notification center (credit card due reminders)

## AI Configuration

| Mode | Requirement | Notes |
|---|---|---|
| Rule mode | None | Regex + keyword parsing, always available, zero cost |
| Cloud (BYOK) | An OpenAI-compatible API key (default: [Zhipu GLM-4V-Flash](https://open.bigmodel.cn/), free) | Key stored in localStorage only; requests go directly to the provider |
| Local | [Ollama](https://ollama.com/) with any chat model | 100% offline; connectivity and installed models are health-checked |
| Platform proxy | Sign in | Free daily quota, no key management |

Screenshot recognition requires a **vision** model (text-only models like DeepSeek cannot read images).

## UI Styles

| Style | Description | Availability |
|---|---|---|
| Minimalist (极简) | Clean, simple design focused on content | Free |
| Neumorphism (新拟态) | Soft UI with subtle shadows and embossed effects | Free |
| Brutalism (粗野主义) | Bold, high-contrast design with thick borders and sharp edges | Premium |
| Cyberpunk (赛博朋克) | Neon-lit futuristic design with flowing gradients and glow effects | Premium |

## Pricing Plans

| Feature | Free | Premium |
|---|---|---|
| Wallets | 3 | Unlimited |
| Transactions / month | 100 | Unlimited |
| Budgets | 3 | Unlimited |
| Subscription tracking | 3 | Unlimited |
| Data management (export/import) | ✗ | ✓ |
| Premium UI styles | ✗ | ✓ |

Premium: **$2.99/month** · **$29.99/quarter** · **$35.99/lifetime**

## Quick Start (Windows, one-click)

1. Double-click **`一键启动.bat`** — it checks Node.js, installs dependencies if needed, starts the backend (port 5000) and frontend (port 8080), then opens the browser automatically.
2. Double-click **`停止服务.bat`** to stop all services and close the server windows.

## Getting Started (Manual)

### Prerequisites

- Node.js 18+
- npm or bun

### Installation

```bash
# Clone the repository
git clone https://github.com/baiyizhuoait-ui/UniTally.git
cd UniTally

# Install frontend dependencies
npm install

# Install backend dependencies
cd backend && npm install

# Start backend server (port 5000)
npm start

# In another terminal, start frontend (port 8080)
cd .. && npm run dev
```

### Configuration

1. Copy `backend/.env.example` to `backend/.env` and fill in your credentials
2. Configure Firebase credentials for authentication
3. Set up Brevo SMTP for email verification
4. (Optional) Configure AI in **Settings → AI** — bring your own key or point to a local Ollama instance

### Testing

```bash
npm test          # 220+ unit/integration tests (LLM evals gated behind RUN_AI_EVAL=1)
npx tsc --noEmit  # typecheck
```

## Project Structure

```
├── src/              # Frontend (React + TypeScript + Vite)
│   ├── components/   # UI components & feature modals (incl. AI quick input, screenshot modal)
│   ├── contexts/     # App & subscription state
│   ├── lib/          # Utilities (currencies, i18n, plans, storage, aiParse, aiConfig, billImport)
│   └── pages/        # Application pages
├── backend/          # Backend API (Node.js + Express; auth + AI parse proxy)
├── docs/unitally-ai/ # AI suite design docs (PRD, architecture, QA report)
├── functions/        # Firebase Cloud Functions
├── tests/            # Vitest test suite
└── public/           # Static assets
```

## Tech Stack

- **Frontend**: React + TypeScript + Vite
- **UI**: shadcn-ui + Tailwind CSS
- **Backend**: Node.js + Express
- **Auth**: Firebase Authentication + email verification
- **Email**: Brevo SMTP
- **AI**: OpenAI-compatible BYOK / Ollama / platform proxy, with a deterministic rule engine fallback

## License

MIT
