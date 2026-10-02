// Centralized API base URL.
// Override at build time with VITE_API_BASE (e.g. https://api.unitally.com).
// Falls back to the local backend for development.
export const API_BASE =
  (import.meta.env.VITE_API_BASE as string | undefined) || 'http://localhost:5000';
