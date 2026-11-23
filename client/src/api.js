const API_BASE = ((import.meta.env && import.meta.env.VITE_API_URL) || 'http://localhost:4000/api').replace(/\/+$/, '');
const REQUEST_TIMEOUT_MS = 15000;

export const UNAUTHORIZED_EVENT = 'smh:unauthorized';

export function getStoredUser() {
  try { return JSON.parse(localStorage.getItem('smh_user') || 'null'); }
  catch { return null; }
}

export function setStoredUser(user) {
  if (user) localStorage.setItem('smh_user', JSON.stringify(user));
  else localStorage.removeItem('smh_user');
}

// '?a=1&b=2' from an object; empty values are left out. Example: api(`/parking/slots${query({ hubId, startAt })}`)
export function query(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

/**
 * Calls the API. Resolves with the JSON body; rejects with an Error whose `message` is safe to show to the user and
 * which also carries `status` (HTTP status, 0 when the server cannot be reached) and `details` (extra data from the
 * server, for example the id of the booking that blocks a new one).
 * The server decides who the user is from x-user-id (demo identity); the role is never sent from here.
 */
export async function api(path, options = {}) {
  const user = getStoredUser();
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (user?.id) headers['x-user-id'] = user.id;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
      signal: controller.signal,
      body: options.body && typeof options.body !== 'string' ? JSON.stringify(options.body) : options.body
    });
  } catch (cause) {
    const error = new Error(cause?.name === 'AbortError'
      ? 'The server took too long to answer. Please try again.'
      : 'Cannot reach the server. Check that the backend is running (npm run dev).');
    error.status = 0;
    throw error;
  } finally {
    clearTimeout(timer);
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    // A stored demo id that the server no longer knows (for example after the database was recreated): sign out.
    if (response.status === 401 && user && typeof window !== 'undefined') {
      setStoredUser(null);
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }
    const error = new Error(data.error || `Request failed (${response.status})`);
    error.status = response.status;
    error.details = data.details;
    throw error;
  }
  return data;
}

// Call once when the app opens. Returns the user the server still knows, or null (and clears the stored one).
export async function verifyStoredUser() {
  if (!getStoredUser()) return null;
  try { return (await api('/auth/me')).user; }
  catch (error) {
    if (error.status === 401) { setStoredUser(null); return null; }
    throw error; // server unreachable: keep the stored user and let the caller show the message
  }
}

// <input type="datetime-local"> works in local time without a zone. These two convert it to and from the UTC ISO text the API uses.
export const isoToLocalInput = (date) => {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

export const localInputToIso = (value) => {
  const d = new Date(value);
  return value && !Number.isNaN(d.getTime()) ? d.toISOString() : '';
};