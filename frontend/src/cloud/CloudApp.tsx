import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { getInitialTheme, persistTheme } from '../lib/theme';
import { clearSession, hasSession, login, request } from './client';
import type { Article, ArticlePage, Feed, Feedback } from './client';
import { Settings, defaultSettings } from './Settings';
import type { ReaderSettings, SettingsResponse } from './Settings';
import './reader.css';

function Icon({ name }: { name: string }) {
  const paths: Record<string, ComponentChildren> = {
    book: <><path d="M3 4h7l2 2 2-2h7v15h-7l-2 2-2-2H3z" /><path d="M12 6v15" /></>,
    inbox: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 13h5l2 3h4l2-3h5" /></>,
    save: <path d="M6 3h12v18l-6-4-6 4z" />,
    search: <><circle cx="10" cy="10" r="6" /><path d="m15 15 5 5" /></>,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10v1" /></>,
    like: <path d="M7 10v11H3V10zm0 10h11l3-10h-8l1-6-3-2-4 8" />,
    check: <path d="m5 12 4 4L19 6" />,
    arrow: <path d="M7 17 18 6M7 6h11v11" />,
    moon: <path d="M20.5 13A9 9 0 0 1 11 3.5a9 9 0 1 0 9.5 9.5Z" />,
    sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1" /></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1" /></>,
    logout: <><path d="M10 4H4v16h6m4-12 4 4-4 4m-6-4h12" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="m9 3-1 3-3 1-2 3 2 2-1 3 3 2 2 3 3-1 3 1 2-3 3-2-1-3 2-2-2-3-3-1-1-3z" /></>,
    rss: <><circle cx="5" cy="19" r="1" /><path d="M4 11a9 9 0 0 1 9 9M4 4a16 16 0 0 1 16 16" /></>,
  };
  return <svg aria-hidden="true" viewBox="0 0 24 24">{paths[name] || paths.book}</svg>;
}
function date(value: string) {
  const d = new Date(value);
  return Number.isNaN(d.valueOf()) ? '' : d.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
}

export function CloudApp() {
  const [mode, setMode] = useState(getInitialTheme());
  const [authenticated, setAuthenticated] = useState(hasSession());
  const [password, setPassword] = useState('');
  const [feed, setFeed] = useState<Feed | null>(null);
  const [archiveItems, setArchiveItems] = useState<Article[]>([]);
  const [counts, setCounts] = useState({ all: 0, saved: 0 });
  const [archiveTotal, setArchiveTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [archiveQuery, setArchiveQuery] = useState('');
  const [view, setView] = useState<'all' | 'digest' | 'saved'>('all');
  const [digestId, setDigestId] = useState('latest');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [less, setLess] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [hideRead, setHideRead] = useState(false);
  const [query, setQuery] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [preferences, setPreferences] = useState<ReaderSettings>(() => ({ ...structuredClone(defaultSettings), theme: getInitialTheme() }));
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const [preferencesLoading, setPreferencesLoading] = useState(false);
  const loadId = useRef(0);

  useEffect(() => {
    document.title = 'Small Web · 阅读空间';
    document.documentElement.lang = 'zh-CN';
    const expired = () => { loadId.current++; setAuthenticated(false); setFeed(null); setArchiveItems([]); setCounts({ all: 0, saved: 0 }); setLoading(false); setPending(null); };
    window.addEventListener('smallweb:expired', expired);
    return () => window.removeEventListener('smallweb:expired', expired);
  }, []);
  useEffect(() => {
    document.documentElement.setAttribute('data-color-mode', mode);
    document.documentElement.setAttribute('data-dark-theme', 'dark');
    document.documentElement.setAttribute('data-light-theme', 'light');
  }, [mode]);

  function articlePath(cursor?: string) {
    const params = new URLSearchParams({ scope: view === 'saved' ? 'saved' : 'all', limit: '30', unread: hideRead ? '1' : '0', q: archiveQuery });
    if (cursor) params.set('cursor', cursor);
    return '/api/articles?' + params.toString();
  }
  async function load() {
    if (!authenticated) return;
    const id = ++loadId.current;
    setLoading(true); setLoadingMore(false); setError('');
    if (view !== 'digest') { setArchiveItems([]); setArchiveTotal(0); setNextCursor(null); }
    try {
      const [page, nextFeed] = await Promise.all([
        view === 'digest' ? Promise.resolve(null) : request<ArticlePage>(articlePath()),
        request<Feed>(`/api/feed?digest=${encodeURIComponent(digestId)}`).catch(e => { if (view === 'digest') throw e; return null; }),
      ]);
      if (id !== loadId.current) return;
      if (nextFeed) setFeed(nextFeed);
      if (page) {
        setArchiveItems(page.items); setCounts(page.counts); setArchiveTotal(page.total); setNextCursor(page.next_cursor);
      }
    } catch (e) { if (id === loadId.current) setError(e instanceof Error ? e.message : '加载失败'); }
    finally { if (id === loadId.current) setLoading(false); }
  }
  async function loadMore() {
    if (!nextCursor || loadingMore || loading) return;
    const id = loadId.current;
    setLoadingMore(true); setError('');
    try {
      const page = await request<ArticlePage>(articlePath(nextCursor));
      if (id !== loadId.current) return;
      setArchiveItems(items => [...new Map([...items, ...page.items].map(a => [a.url, a])).values()]);
      setCounts(page.counts); setArchiveTotal(page.total); setNextCursor(page.next_cursor);
    } catch (e) { if (id === loadId.current) setError(e instanceof Error ? e.message : '加载失败'); }
    finally { if (id === loadId.current) setLoadingMore(false); }
  }
  useEffect(() => { const timer = window.setTimeout(() => setArchiveQuery(query.trim()), 250); return () => window.clearTimeout(timer); }, [query]);
  useEffect(() => { void load(); }, [authenticated, view, view === 'digest' ? digestId : '', view === 'digest' ? '' : archiveQuery, view === 'digest' ? false : hideRead]);

  function applyPreferences(next: ReaderSettings) {
    setPreferences(next); setMode(next.theme); persistTheme(next.theme); setHideRead(next.hide_read);
  }
  async function loadPreferences() {
    setPreferencesLoading(true); setPreferencesLoaded(false);
    try {
      const response = await request<SettingsResponse>('/api/settings');
      if (!hasSession()) return;
      applyPreferences(response.configured ? response.settings : { ...response.settings, theme: getInitialTheme() });
      setPreferencesLoaded(true);
    } catch (e) { setError(e instanceof Error ? e.message : '设置加载失败'); }
    finally { setPreferencesLoading(false); }
  }
  useEffect(() => { if (authenticated) void loadPreferences(); else { setShowSettings(false); setPreferencesLoaded(false); } }, [authenticated]);
  async function savePreferences(next: ReaderSettings) {
    const response = await request<SettingsResponse>('/api/settings', next);
    applyPreferences(response.settings); return response.settings;
  }
  async function toggleTheme() {
    const next = mode === 'dark' ? 'light' : 'dark';
    if (!authenticated) { setMode(next); persistTheme(next); return; }
    try {
      const response = await request<SettingsResponse>('/api/settings', { theme: next });
      setPreferences(response.settings); setMode(next); persistTheme(next);
    } catch (e) { setError(e instanceof Error ? e.message : '主题保存失败'); }
  }

  function logout() {
    loadId.current++; clearSession(); setAuthenticated(false); setFeed(null); setArchiveItems([]); setCounts({ all: 0, saved: 0 }); setError(''); setPassword(''); setLoading(false); setPending(null);
  }
  async function act(article: Article, action: string) {
    if (pending) return;
    setPending(article.url); setError('');
    try {
      const result = await request<{ feedback: Feedback }>('/api/feedback', { url: article.url, action });
      const updated = { ...article, feedback: result.feedback };
      setFeed(f => f?.digest ? { ...f, digest: { ...f.digest, items: f.digest.items.map(i => i.url === article.url ? updated : i) } } : f);
      setArchiveItems(items => items.map(i => i.url === article.url ? updated : i));
      setCounts(c => ({ ...c, saved: c.saved + Number(Boolean(result.feedback.saved)) - Number(Boolean(article.feedback?.saved)) }));
      if (view !== 'digest') {
        const wasVisible = (view !== 'saved' || Boolean(article.feedback?.saved)) && (!hideRead || !article.feedback?.is_read);
        const isVisible = (view !== 'saved' || Boolean(result.feedback.saved)) && (!hideRead || !result.feedback.is_read);
        setArchiveTotal(n => Math.max(0, n + Number(isVisible) - Number(wasVisible)));
      }
      setLess(null);
    } catch (e) { setError(e instanceof Error ? e.message : '保存失败，请重试'); }
    finally { setPending(null); }
  }

  const items = view === 'digest' ? (feed?.digest?.items || []) : archiveItems;
  const search = query.trim().toLowerCase();
  const shown = items.filter(i => (view !== 'saved' || Boolean(i.feedback?.saved)) && (!hideRead || !i.feedback?.is_read) && (view !== 'digest' || !search || [i.title, i.source, i.summary].join(' ').toLowerCase().includes(search)));
  const profile = feed?.digest?.profile;
  const verdictLabel = { useful: '已标记有收获', topic: '已减少该话题', quality: '已记录质量问题', known: '已标记了解过' };
  const tab = (which: 'all' | 'digest' | 'saved', sidebar = false) => {
    const label = which === 'all' ? '全部文章' : which === 'saved' ? sidebar ? '我的收藏' : '收藏' : sidebar ? '每日精选' : '精选';
    const count = which === 'all' ? counts.all : which === 'saved' ? counts.saved : feed?.digest?.items.length || 0;
    return <button type="button" class={sidebar ? `side-item ${view === which ? 'selected' : ''}` : `tab ${view === which ? 'active' : ''}`} aria-label={label} disabled={showSettings} aria-current={view === which ? 'page' : undefined} onClick={() => { setView(which); setQuery(''); }}><Icon name={which === 'all' ? 'inbox' : which === 'saved' ? 'save' : 'book'} />{label}<span class="Counter">{count}</span></button>;
  };

  return <div class={`reader-app density-${preferences.density}`}>
    <header class="topbar"><a href={import.meta.env.BASE_URL} class="brand"><Icon name="book" />Small Web</a><span class="top-separator">/</span><span class="top-location">你的阅读空间</span><div class="header-actions">{authenticated && <button type="button" class="btn icon-button" aria-label="设置" title="设置" onClick={() => setShowSettings(true)}><Icon name="settings" /></button>}<button type="button" class="btn icon-button" disabled={authenticated && (!preferencesLoaded || showSettings)} aria-label={mode === 'dark' ? '切换浅色' : '切换深色'} title={mode === 'dark' ? '切换浅色' : '切换深色'} onClick={() => void toggleTheme()}><Icon name={mode === 'dark' ? 'sun' : 'moon'} /></button>{authenticated && <button type="button" class="btn btn-sm" onClick={logout}><Icon name="logout" /><span class="logout-label">退出</span></button>}</div></header>
    {!authenticated ? <main class="login-main"><section class="Box login-box"><Icon name="book" /><h1>登录 Small Web</h1><p>你的独立博客文章库。</p><form onSubmit={async e => { e.preventDefault(); setLoading(true); setError(''); try { await login(password); setPassword(''); setAuthenticated(true); } catch (err) { setError(err instanceof Error ? err.message : '登录失败'); } finally { setLoading(false); } }}><label for="reader-password">阅读密码</label><input id="reader-password" class="form-control" type="password" autoComplete="current-password" required value={password} onInput={e => setPassword(e.currentTarget.value)} /><button class="btn login-button" type="submit" disabled={loading}>{loading ? '登录中…' : '进入阅读'}</button></form>{error && <p role="alert" class="reader-error">{error}</p>}</section></main>
      : <div class="workspace"><aside class="sidebar"><div class="sidebar-heading">阅读清单</div><nav aria-label="主导航">{tab('all', true)}{tab('digest', true)}{tab('saved', true)}</nav><div class="sidebar-heading interests-heading">关注的方向</div><div class="topics">{(preferencesLoaded ? preferences.topics.map(t => t.name) : feed?.digest?.topics || []).map(topic => <div class="topic" key={topic}>{topic}</div>)}</div><div class="sidebar-footer"><Icon name="rss" />Kagi Small Web<br /><span class="sidebar-subtext">独立博客，原文摘录</span></div></aside>
        <main class="reader-main">{showSettings ? <>{error && <div role="alert" class="reader-error">{error}</div>}{preferencesLoaded ? <Settings value={preferences} onSave={savePreferences} onClose={() => setShowSettings(false)} /> : <div class="empty"><p role="status">{preferencesLoading ? '正在加载设置…' : '设置加载失败，请重试。'}</p><button type="button" class="btn" disabled={preferencesLoading} onClick={() => void loadPreferences()}>重新加载设置</button><button type="button" class="btn" onClick={() => setShowSettings(false)}>返回阅读</button></div>}</> : <><div class="page-heading"><div><h1>{view === 'all' ? '全部文章' : view === 'saved' ? '我的收藏' : '每日精选'}</h1><p>{view === 'all' ? '已抓取的文章都在这里，随时阅读、收藏和评价。' : view === 'saved' ? '留给以后慢慢读的文章。' : '从你关注的方向里，发现值得读的文章。'}</p></div><div class="page-tools">{view === 'digest' && feed?.digest && <span class="Label">{date(feed.digest.generated_at)}</span>}<button type="button" class="btn icon-button" aria-label="刷新" title="刷新文章" disabled={loading} onClick={() => void load()}><Icon name="refresh" /></button></div></div>
          <nav class="tabs" aria-label="阅读视图">{tab('all')}{tab('digest')}{tab('saved')}</nav>
          <div class="filter-bar"><div class="search-wrap"><Icon name="search" /><input class="form-control" placeholder="筛选标题、作者或内容…" aria-label="筛选文章" type="search" value={query} onInput={e => setQuery(e.currentTarget.value)} /></div><label class="read-filter"><input type="checkbox" checked={hideRead} onChange={e => setHideRead(e.currentTarget.checked)} />隐藏已读</label>{view === 'digest' && Boolean(feed?.history.length) && <select class="form-select history-select" aria-label="选择历史精选" value={digestId} onChange={e => setDigestId(e.currentTarget.value)}><option value="latest">最新一期</option>{feed?.history.map(d => <option key={d.id} value={d.id}>{d.run_key}</option>)}</select>}</div>
          {view === 'digest' && profile && <details class="profile-note"><summary><Icon name="info" />{profile.mode === 'cold_start' ? '推荐正在认识你的兴趣' : `已参考 ${profile.positive_samples} 篇你认可的文章`}<span class="note-short">标记“有收获”，让下次推荐更贴近你</span><span class="details-arrow">⌄</span></summary><p>{profile.mode === 'cold_start' ? '当前使用初始兴趣描述探索，可能不相关。' : `已形成 ${profile.clusters} 个兴趣组，${profile.mode === 'learning' ? '仍参考初始兴趣描述。' : '以你认可的文章为推荐依据。'}`}你认可的文章会在下次每日更新时参与推荐。点击、收藏和已读不会自动视为喜欢。</p></details>}
          {error && <div role="alert" class="reader-error">{error}<button type="button" aria-label="关闭错误提示" onClick={() => setError('')}>×</button></div>}
          <section class="Box article-box" aria-label="文章清单"><div class="Box-header list-header"><span><Icon name="inbox" /><strong>{loading ? '正在加载…' : view === 'digest' ? `${shown.length} 篇文章` : `${shown.length} / ${archiveTotal} 篇文章`}</strong></span><span>{view === 'all' ? '全部已入库文章' : view === 'saved' ? '已收藏' : feed?.digest ? `${feed.digest.candidate_count} 篇候选` : '等待更新'}</span></div>
            {loading ? <p role="status" class="empty">正在加载…</p> : !shown.length ? <div class="empty">{search ? '没有符合筛选条件的文章。' : view === 'saved' ? '还没有收藏。读到想保留的文章时，点一下收藏。' : view === 'all' ? '暂时没有符合条件的文章，可以取消筛选或稍后刷新。' : items.length ? '这一期已经读完了。取消“隐藏已读”可以重新查看。' : '还没有生成精选。第一轮每日任务完成后会显示在这里。'}</div> : shown.map(article => <article class="Box-row article-row" key={article.url}><div class={`row-icon ${article.feedback?.is_read ? 'read' : ''}`}><Icon name={article.feedback?.is_read ? 'check' : 'book'} /></div><div class="row-main"><h2 class="article-title"><a href={article.url} target="_blank" rel="noopener noreferrer">{article.title}</a></h2><div class="article-meta"><span class="source">{article.source}</span><span>·</span><span>{date(article.published_at)}</span>{Boolean(article.feedback?.is_read) && <span class="Label">已读</span>}{article.exploration && <span class="Label">探索</span>}</div><p class={`excerpt ${expanded === article.url ? 'expanded' : ''}`}>{article.summary}</p>
              <div class="row-actions"><button type="button" class={`btn ${article.feedback?.verdict === 'useful' ? 'active' : ''}`} disabled={pending !== null} aria-pressed={article.feedback?.verdict === 'useful'} onClick={() => void act(article, article.feedback?.verdict === 'useful' ? 'clear' : 'useful')}><Icon name="like" />有收获</button><button type="button" class={`btn ${article.feedback?.saved ? 'active' : ''}`} disabled={pending !== null} onClick={() => void act(article, article.feedback?.saved ? 'unsave' : 'save')}><Icon name="save" />{article.feedback?.saved ? '已收藏' : '收藏'}</button><button type="button" class="btn btn-linklike" disabled={pending !== null} onClick={() => void act(article, article.feedback?.is_read ? 'unread' : 'read')}>{article.feedback?.is_read ? '设为未读' : '标记已读'}</button><button type="button" class="btn btn-linklike" disabled={pending !== null} aria-expanded={less === article.url} onClick={() => setLess(less === article.url ? null : article.url)}>少推荐这类</button><button type="button" class="btn btn-linklike" aria-expanded={expanded === article.url} onClick={() => setExpanded(expanded === article.url ? null : article.url)}>{expanded === article.url ? '收起摘录' : '展开摘录'}</button><a class="original-link" href={article.url} target="_blank" rel="noopener noreferrer">原文<Icon name="arrow" /></a></div>
              {profile?.mode !== 'cold_start' && article.reason && <p class="recommendation-reason">{article.reason}</p>}
              {less === article.url && <div class="feedback-options"><span>哪里不合适？</span>{[['topic', '话题不感兴趣'], ['quality', '质量不佳'], ['known', '已经了解']].map(([action, label]) => <button type="button" key={action} disabled={pending !== null} onClick={() => void act(article, action)}>{label}</button>)}</div>}
              {article.feedback?.verdict && <div class="verdict-row"><span class="verdict">{verdictLabel[article.feedback.verdict]}</span><button type="button" class="clear-verdict" disabled={pending !== null} onClick={() => void act(article, 'clear')}>撤销评价</button></div>}
            </div></article>)}
          </section>{view !== 'digest' && !loading && <div class="archive-pagination"><span>已显示 {shown.length} / {archiveTotal} 篇，搜索范围为整个文章库</span>{nextCursor && <button type="button" class="btn btn-sm" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? '加载中…' : '加载更多'}</button>}</div>}<footer><span>Small Web · 原文摘录，不生成 AI 摘要</span><span>持续入库，随时阅读</span></footer></>}
        </main>
      </div>}
  </div>;
}
