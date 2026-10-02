const express = require('express');
const cors = require('cors');
require('dotenv').config();

const { loadDb } = require('./db');

const app = express();

// --- CORS: dev origins by default; override via CORS_ORIGINS for deployment ---
const defaultOrigins = [
  'http://localhost:8080',
  'http://localhost:8081',
  'http://127.0.0.1:8080',
  'http://127.0.0.1:8081',
];
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
  : defaultOrigins;

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));
app.use(express.json());

// --- Request logging (production: drop query strings to avoid leaking sensitive params) ---
app.use((req, res, next) => {
  const url = process.env.NODE_ENV === 'production' ? req.path : req.originalUrl;
  console.log(`${new Date().toISOString()} - ${req.method} ${url}`);
  next();
});

// --- Persistence: load from JSON file so data survives restarts ---
const db = loadDb();

// Pass db to routes
app.use('/api/auth', (req, res, next) => {
  req.db = db;
  next();
}, require('./routes/auth'));

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`CORS allowed origins: ${allowedOrigins.join(', ') || '(none)'}`);
  console.log('Using file-backed database (survives restarts)');
});
