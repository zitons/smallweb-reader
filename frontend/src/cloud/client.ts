export interface Feedback {
  verdict: 'useful' | 'topic' | 'quality' | 'known' | null;
  is_read: number;
  saved: number;
}
export interface Article {
  url: string;
  title: string;
  summary: string;
  source: string;
  category: string;
  published_at: string;
  reason?: string;
  exploration?: boolean;
  feedback: Feedback | null;
}
export interface Digest {
  id: number;
  generated_at: string;
  run_key: string;
  embedding_model: string;
  candidate_count: number;
  topics: string[];
  profile?: {
    mode: 'cold_start' | 'learning' | 'personalized';
    positive_samples: number;
    clusters: number;
    profile_weight: number;
  };
  items: Article[];
}
export interface Feed {
  digest: Digest | null;
  history: { id: number; run_key: string; generated_at: string }[];
}
export interface ArticlePage {
  items: Article[];
  total: number;
  counts: { all: number; saved: number };
  next_cursor: string | null;
}
const base = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');
const storageKey = `smallweb-session:${base}`;

export function clearSession() { sessionStorage.removeItem(storageKey); }
export function hasSession() { return Boolean(sessionStorage.getItem(storageKey)); }

export async function request<T>(path: string, body?: unknown): Promise<T> {
  if (!base) throw new Error('尚未配置阅读服务地址。');
  const token = sessionStorage.getItem(storageKey);
  const response = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    if (response.status === 401) { clearSession(); window.dispatchEvent(new Event('smallweb:expired')); }
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || `请求失败（${response.status}）`);
  }
  return response.json();
}

export async function login(password: string) {
  const data = await request<{ token: string }>('/api/auth/login', { password });
  sessionStorage.setItem(storageKey, data.token);
}
