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
