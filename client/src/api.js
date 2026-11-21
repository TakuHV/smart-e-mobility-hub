const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:4000/api';

export function getStoredUser() {
  try { return JSON.parse(localStorage.getItem('smh_user') || 'null'); }
  catch { return null; }
}

export function setStoredUser(user) {
  if (user) localStorage.setItem('smh_user', JSON.stringify(user));
  else localStorage.removeItem('smh_user');
}

export async function api(path, options = {}) {
  const user = getStoredUser();
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (user?.id) {
    headers['x-user-id'] = user.id;
    headers['x-user-role'] = user.role;
  }
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

export const isoToLocalInput = (date) => {
  const d = new Date(date);
  const offset = d.getTimezoneOffset();
  return new Date(d.getTime() - offset * 60000).toISOString().slice(0, 16);
};
