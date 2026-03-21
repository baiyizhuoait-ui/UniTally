# UniTally

An Accounting book application which supports more than one currency.

## Features

- **Multi-currency Support**: Track expenses in multiple currencies with real-time exchange rates
- **Wallet Management**: Create and manage multiple wallets with custom icons and colors
- **Transaction Tracking**: Record income and expenses with categories and notes
- **Budget Center**: Set budgets and track subscription services
- **Expense Calendar**: Visualize daily spending patterns
- **Data Dashboard**: View asset trends and category distributions
- **Multi-language**: Support for Chinese and English
- **Multiple UI Styles**: Choose from 6 unique interface designs

## New Features (Latest Update)

### Wallet Classification System
- **Default Cash Accounts**: Automatically creates cash wallets for all selected currencies during setup
- **Wallet Types**: Organized by Cash, Savings, Credit Card, and E-Wallet
- **Credit Card Logic**: Displays available credit (limit + balance) instead of current balance
- **Grouped Wallet Selector**: Wallet picker shows options grouped by type

### Wallet Statistics & Editing
- **Edit Wallet**: Modify all wallet properties in management mode
- **Wallet Statistics**: Click any wallet to view expense breakdown by category
- **Time Range Filter**: View statistics for Today, This Week, This Month, This Year, or All Time
- **Pie Chart Visualization**: Beautiful category distribution charts

### Transfer System
- **Transfer Tab**: Dedicated tab for transfers in transaction modal
- **Cross-Currency Transfer**: Automatically detects different currencies and shows separate input fields
- **Data Isolation**: Transfers are excluded from expense calendar and data dashboard
- **Transfer Filter**: "Transfers Only" button in transaction hall

### Enhanced Categories
- **New Categories**: Drink (饮料), Fitness (健身), Gift (礼品)
- **Removed Transfer Category**: Transfer is now a separate transaction type
- **Auto-Sync**: Existing users automatically receive new categories

### Currency Colors
- **31 Currency Colors**: Each currency has a primary color based on its largest denomination banknote
- **Auto-Color Wallets**: New cash wallets automatically use the corresponding currency color

## UI Styles

UniTally offers 6 distinct UI styles to personalize your experience:

### Free Styles
1. **Minimalist (极简)** - Clean, simple design with focus on content
2. **Glassmorphism (玻璃拟态)** - Frosted glass effect with blur and transparency
3. **Neumorphism (新拟态)** - Soft UI with subtle shadows and embossed effects

### Premium Styles (Paid Feature)
4. **Brutalism (粗野主义)** - Bold, high-contrast design with thick borders and sharp edges
5. **Memphis (孟菲斯)** - Playful, colorful design with geometric shapes and vibrant colors
6. **Cyberpunk (赛博朋克)** - Neon-lit futuristic design with flowing gradients and glow effects

## Premium Features

Upgrade to premium to unlock:
- Unlimited wallets
- Unlimited transactions
- Data export functionality
- Unlimited budgets
- Unlimited subscription tracking
- Premium UI styles (Brutalism, Memphis, Cyberpunk)

## Tech Stack

- **Frontend**: React + TypeScript + Vite
- **UI**: shadcn-ui + Tailwind CSS
- **Backend**: Node.js + Express
- **Auth**: Firebase Authentication + Email verification
- **Email**: Brevo SMTP

## Getting Started

### Prerequisites

- Node.js 18+
- npm or bun

### Installation

```bash
# Clone the repository
git clone https://github.com/baiyizhuoait-ui/UniTally.git

# Navigate to project directory
cd UniTally

# Install frontend dependencies
npm install

# Install backend dependencies
cd backend && npm install

# Start backend server
npm start

# In another terminal, start frontend
cd .. && npm run dev
```

### Configuration

1. Copy `.env.example` to `.env` and fill in your credentials
2. Configure Firebase credentials for authentication
3. Set up Brevo SMTP for email verification

## License

MIT
