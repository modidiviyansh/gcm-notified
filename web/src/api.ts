export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body && !isForm ? { 'Content-Type': 'application/json' } : undefined,
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });
  if (res.status === 401 && !path.startsWith('/auth/login')) {
    if (location.pathname !== '/login') location.href = '/login';
    throw new ApiError('Not logged in', 401);
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const msg = Array.isArray(data?.message) ? data.message.join(', ') : data?.message || res.statusText;
    throw new ApiError(msg, res.status);
  }
  return data as T;
}

export const api = {
  get: <T = any>(p: string) => request<T>('GET', p),
  post: <T = any>(p: string, b?: unknown) => request<T>('POST', p, b ?? {}),
  put: <T = any>(p: string, b?: unknown) => request<T>('PUT', p, b ?? {}),
  del: <T = any>(p: string) => request<T>('DELETE', p),
  upload: <T = any>(p: string, file: File, extra: Record<string, string> = {}) => {
    const f = new FormData();
    f.append('file', file);
    for (const [k, v] of Object.entries(extra)) f.append(k, v);
    return request<T>('POST', p, f);
  },
};

export const fmtDate = (d?: string | null) =>
  d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';

export const fmtPhone = (p?: string | null) => (p ? p.includes('•') ? p : (p.startsWith('91') && p.length === 12 ? `+91 ${p.slice(2, 7)} ${p.slice(7)}` : `+${p}`) : '—');

export const fmtDuration = (mins: number) => {
  if (mins < 1) return '< 1 min';
  const h = Math.floor(mins / 60), m = mins % 60;
  return h ? `${h} h ${m} min` : `${m} min`;
};
