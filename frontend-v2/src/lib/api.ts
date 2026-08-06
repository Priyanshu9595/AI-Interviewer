import axios, { AxiosError, AxiosRequestConfig } from 'axios';

export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:5000';

/**
 * The access token lives in memory only. The refresh token is an httpOnly
 * cookie, so a page reload silently re-authenticates via /auth/refresh rather
 * than leaving a long-lived token in localStorage.
 */
let accessToken: string | null = null;

export const setAccessToken = (token: string | null) => {
  accessToken = token;
};

export const getAccessToken = () => accessToken;

export const api = axios.create({
  baseURL: `${API_BASE}/api`,
  withCredentials: true,
  timeout: 120_000,
});

api.interceptors.request.use((config) => {
  if (accessToken) config.headers.Authorization = `Bearer ${accessToken}`;
  return config;
});

/** Concurrent 401s share a single refresh instead of stampeding the endpoint. */
let refreshInFlight: Promise<string | null> | null = null;

async function refreshAccessToken(): Promise<string | null> {
  refreshInFlight ??= axios
    .post<{ accessToken: string }>(`${API_BASE}/api/auth/refresh`, {}, { withCredentials: true })
    .then((res) => {
      setAccessToken(res.data.accessToken);
      return res.data.accessToken;
    })
    .catch(() => {
      setAccessToken(null);
      return null;
    })
    .finally(() => {
      refreshInFlight = null;
    });

  return refreshInFlight;
}

api.interceptors.response.use(
  (res) => res,
  async (error: AxiosError) => {
    const original = error.config as AxiosRequestConfig & { _retried?: boolean };

    // Never try to refresh a failed refresh, or a login attempt.
    const isAuthCall = original?.url?.includes('/auth/');

    if (error.response?.status === 401 && original && !original._retried && !isAuthCall) {
      original._retried = true;
      const token = await refreshAccessToken();

      if (token) {
        original.headers = { ...original.headers, Authorization: `Bearer ${token}` };
        return api(original);
      }

      if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
        window.location.href = '/';
      }
    }

    return Promise.reject(error);
  },
);

/** Pulls the server's message out of an axios error for display. */
export function errorMessage(err: unknown, fallback = 'Something went wrong'): string {
  if (axios.isAxiosError(err)) {
    const data = err.response?.data as
      | { error?: string; code?: string; details?: Array<{ message: string }> }
      | undefined;

    // The server already phrases quota errors with a concrete wait time.
    if (err.response?.status === 429 && data?.error) return data.error;

    if (data?.details?.length) {
      return data.details.map((d) => d.message).join(', ');
    }
    if (typeof data?.error === 'string') return data.error;
    if (err.code === 'ECONNABORTED') return 'The request timed out. Please try again.';
    if (!err.response) return 'Could not reach the server. Is the backend running?';
  }

  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

/** Downloads a binary endpoint (PDF/XLSX) as a file. */
export async function downloadFile(url: string, filename: string) {
  const res = await api.get(url, { responseType: 'blob' });
  const href = URL.createObjectURL(res.data as Blob);

  const link = document.createElement('a');
  link.href = href;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();

  URL.revokeObjectURL(href);
}
