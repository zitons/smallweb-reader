import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { getInitialTheme, persistTheme } from '../lib/theme';
import { clearSession, hasSession, login, request } from './client';
import type { Article, Feed, Feedback } from './client';
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
  const [library, setLibrary] = useState<Article[]>([]);
  const [view, setView] = useState<'digest' | 'saved'>('digest');
  const [digestId, setDigestId] = useState('latest');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [less, setLess] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [hideRead, setHideRead] = useState(false);
  const [query, setQuery] = useState('');
  const loadId = useRef(0);

  useEffect(() => {
    document.title = 'Small Web · 每日精选';
    document.documentElement.lang = 'zh-CN';
    const expired = () => { loadId.current++; setAuthenticated(false); setFeed(null); setLibrary([]); setLoading(false); setPending(null); };
    window.addEventListener('smallweb:expired', expired);
    return () => window.removeEventListener('smallweb:expired', expired);
  }, []);
  useEffect(() => {
    document.documentElement.setAttribute('data-color-mode', mode);
    document.documentElement.setAttribute('data-dark-theme', 'dark');
    document.documentElement.setAttribute('data-light-theme', 'light');
  }, [mode]);

  async function load() {
    if (!authenticated) return;
    const id = ++loadId.current;
    setLoading(true); setError('');
    try {
      const [saved, nextFeed] = await Promise.all([
        request<{ items: Article[] }>('/api/library'),
        view === 'digest' ? request<Feed>(`/api/feed?digest=${encodeURIComponent(digestId)}`) : Promise.resolve(null),
      ]);
      if (id !== loadId.current) return;
      setLibrary(saved.items);
      if (nextFeed) setFeed(nextFeed);
    } catch (e) { if (id === loadId.current) setError(e instanceof Error ? e.message : '加载失败'); }
    finally { if (id === loadId.current) setLoading(false); }
  }
  useEffect(() => { void load(); }, [authenticated, view, digestId]);

  function logout() {
    loadId.current++; clearSession(); setAuthenticated(false); setFeed(null); setLibrary([]); setError(''); setPassword(''); setLoading(false); setPending(null);
  }
  async function act(article: Article, action: string) {
    if (pending) return;
    setPending(article.url); setError('');
    try {
      const result = await request<{ feedback: Feedback }>('/api/feedback', { url: article.url, action });
      const updated = { ...article, feedback: result.feedback };
      setFeed(f => f?.digest ? { ...f, digest: { ...f.digest, items: f.digest.items.map(i => i.url === article.url ? updated : i) } } : f);
      setLibrary(items => result.feedback.saved
        ? items.some(i => i.url === article.url) ? items.map(i => i.url === article.url ? updated : i) : [updated, ...items]
        : items.filter(i => i.url !== article.url));
      setLess(null);
    } catch (e) { setError(e instanceof Error ? e.message : '保存失败，请重试'); }
    finally { setPending(null); }
  }

  const items = view === 'saved' ? library : (feed?.digest?.items || []);
  const search = query.trim().toLowerCase();
  const shown = items.filter(i => (!hideRead || !i.feedback?.is_read) && (!search || [i.title, i.source, i.summary].join(' ').toLowerCase().includes(search)));
  const profile = feed?.digest?.profile;
  const verdictLabel = { useful: '已标记有收获', topic: '已减少该话题', quality: '已记录质量问题', known: '已标记了解过' };
  const tab = (which: 'digest' | 'saved', sidebar = false) => <button type="button" class={sidebar ? `side-item ${view === which ? 'selected' : ''}` : `tab ${view === which ? 'active' : ''}`} aria-label={sidebar ? which === 'digest' ? '每日精选' : '我的收藏' : which === 'digest' ? '精选' : '收藏'} aria-current={view === which ? 'page' : undefined} onClick={() => setView(which)}><Icon name={which === 'digest' ? sidebar ? 'inbox' : 'book' : 'save'} />{sidebar ? which === 'digest' ? '每日精选' : '我的收藏' : which === 'digest' ? '精选' : '收藏'}<span class="Counter">{which === 'digest' ? feed?.digest?.items.length || 0 : library.length}</span></button>;

  return <div class="reader-app">
    <header class="topbar"><a href={import.meta.env.BASE_URL} class="brand"><Icon name="book" />Small Web</a><span class="top-separator">/</span><span class="top-location">你的阅读空间</span><div class="header-actions"><button type="button" class="btn icon-button" aria-label={mode === 'dark' ? '切换浅色' : '切换深色'} title={mode === 'dark' ? '切换浅色' : '切换深色'} onClick={() => { const next = mode === 'dark' ? 'light' : 'dark'; persistTheme(next); setMode(next); }}><Icon name={mode === 'dark' ? 'sun' : 'moon'} /></button>{authenticated && <button type="button" class="btn btn-sm" onClick={logout}><Icon name="logout" /><span class="logout-label">退出</span></button>}</div></header>
    {!authenticated ? <main class="login-main"><section class="Box login-box"><Icon name="book" /><h1>登录 Small Web</h1><p>你的独立博客阅读清单。</p><form onSubmit={async e => { e.preventDefault(); setLoading(true); setError(''); try { await login(password); setPassword(''); setAuthenticated(true); } catch (err) { setError(err instanceof Error ? err.message : '登录失败'); } finally { setLoading(false); } }}><label for="reader-password">阅读密码</label><input id="reader-password" class="form-control" type="password" autoComplete="current-password" required value={password} onInput={e => setPassword(e.currentTarget.value)} /><button class="btn login-button" type="submit" disabled={loading}>{loading ? '登录中…' : '进入阅读'}</button></form>{error && <p role="alert" class="reader-error">{error}</p>}</section></main>
      : <div class="workspace"><aside class="sidebar"><div class="sidebar-heading">阅读清单</div><nav aria-label="主导航">{tab('digest', true)}{tab('saved', true)}</nav><div class="sidebar-heading interests-heading">关注的方向</div><div class="topics">{feed?.digest?.topics.map(topic => <div class="topic" key={topic}>{topic}</div>)}</div><div class="sidebar-footer"><Icon name="rss" />Kagi Small Web<br /><span class="sidebar-subtext">独立博客，原文摘录</span></div></aside>
        <main class="reader-main"><div class="page-heading"><div><h1>{view === 'saved' ? '我的收藏' : '每日精选'}</h1><p>{view === 'saved' ? '留给以后慢慢读的文章。' : '从你关注的方向里，发现值得读的文章。'}</p></div><div class="page-tools">{view === 'digest' && feed?.digest && <span class="Label">{date(feed.digest.generated_at)}</span>}<button type="button" class="btn icon-button" aria-label="刷新" title="刷新文章" disabled={loading} onClick={() => void load()}><Icon name="refresh" /></button></div></div>
          <nav class="tabs" aria-label="阅读视图">{tab('digest')}{tab('saved')}</nav>
          <div class="filter-bar"><div class="search-wrap"><Icon name="search" /><input class="form-control" placeholder="筛选标题、作者或内容…" aria-label="筛选文章" type="search" value={query} onInput={e => setQuery(e.currentTarget.value)} /></div><label class="read-filter"><input type="checkbox" checked={hideRead} onChange={e => setHideRead(e.currentTarget.checked)} />隐藏已读</label>{view === 'digest' && Boolean(feed?.history.length) && <select class="form-select history-select" aria-label="选择历史精选" value={digestId} onChange={e => setDigestId(e.currentTarget.value)}><option value="latest">最新一期</option>{feed?.history.map(d => <option key={d.id} value={d.id}>{d.run_key}</option>)}</select>}</div>
          {view === 'digest' && profile && <details class="profile-note"><summary><Icon name="info" />{profile.mode === 'cold_start' ? '推荐正在认识你的兴趣' : `已参考 ${profile.positive_samples} 篇你认可的文章`}<span class="note-short">标记“有收获”，让下次推荐更贴近你</span><span class="details-arrow">⌄</span></summary><p>{profile.mode === 'cold_start' ? '当前使用初始兴趣描述探索，可能不相关。' : `已形成 ${profile.clusters} 个兴趣组，${profile.mode === 'learning' ? '仍参考初始兴趣描述。' : '以你认可的文章为推荐依据。'}`}你认可的文章会在下次每日更新时参与推荐。点击、收藏和已读不会自动视为喜欢。</p></details>}
          {error && <div role="alert" class="reader-error">{error}<button type="button" aria-label="关闭错误提示" onClick={() => setError('')}>×</button></div>}
          <section class="Box article-box" aria-label="文章清单"><div class="Box-header list-header"><span><Icon name="inbox" /><strong>{loading ? '正在加载…' : `${shown.length} 篇文章`}</strong></span><span>{view === 'saved' ? '已收藏' : feed?.digest ? `${feed.digest.candidate_count} 篇候选` : '等待更新'}</span></div>
            {loading ? <p role="status" class="empty">正在加载…</p> : !shown.length ? <div class="empty">{search ? '没有符合筛选条件的文章。' : view === 'saved' ? '还没有收藏。读到想保留的文章时，点一下收藏。' : items.length ? '这一期已经读完了。取消“隐藏已读”可以重新查看。' : '还没有生成精选。第一轮每日任务完成后会显示在这里。'}</div> : shown.map(article => <article class="Box-row article-row" key={article.url}><div class={`row-icon ${article.feedback?.is_read ? 'read' : ''}`}><Icon name={article.feedback?.is_read ? 'check' : 'book'} /></div><div class="row-main"><h2 class="article-title"><a href={article.url} target="_blank" rel="noopener noreferrer">{article.title}</a></h2><div class="article-meta"><span class="source">{article.source}</span><span>·</span><span>{date(article.published_at)}</span>{Boolean(article.feedback?.is_read) && <span class="Label">已读</span>}{article.exploration && <span class="Label">探索</span>}</div><p class={`excerpt ${expanded === article.url ? 'expanded' : ''}`}>{article.summary}</p>
              <div class="row-actions"><button type="button" class={`btn ${article.feedback?.verdict === 'useful' ? 'active' : ''}`} disabled={pending !== null} aria-pressed={article.feedback?.verdict === 'useful'} onClick={() => void act(article, article.feedback?.verdict === 'useful' ? 'clear' : 'useful')}><Icon name="like" />有收获</button><button type="button" class={`btn ${article.feedback?.saved ? 'active' : ''}`} disabled={pending !== null} onClick={() => void act(article, article.feedback?.saved ? 'unsave' : 'save')}><Icon name="save" />{article.feedback?.saved ? '已收藏' : '收藏'}</button><button type="button" class="btn btn-linklike" disabled={pending !== null} onClick={() => void act(article, article.feedback?.is_read ? 'unread' : 'read')}>{article.feedback?.is_read ? '设为未读' : '标记已读'}</button><button type="button" class="btn btn-linklike" disabled={pending !== null} aria-expanded={less === article.url} onClick={() => setLess(less === article.url ? null : article.url)}>少推荐这类</button><button type="button" class="btn btn-linklike" aria-expanded={expanded === article.url} onClick={() => setExpanded(expanded === article.url ? null : article.url)}>{expanded === article.url ? '收起摘录' : '展开摘录'}</button><a class="original-link" href={article.url} target="_blank" rel="noopener noreferrer">原文<Icon name="arrow" /></a></div>
              {profile?.mode !== 'cold_start' && article.reason && <p class="recommendation-reason">{article.reason}</p>}
              {less === article.url && <div class="feedback-options"><span>哪里不合适？</span>{[['topic', '话题不感兴趣'], ['quality', '质量不佳'], ['known', '已经了解']].map(([action, label]) => <button type="button" key={action} disabled={pending !== null} onClick={() => void act(article, action)}>{label}</button>)}</div>}
              {article.feedback?.verdict && <div class="verdict-row"><span class="verdict">{verdictLabel[article.feedback.verdict]}</span><button type="button" class="clear-verdict" disabled={pending !== null} onClick={() => void act(article, 'clear')}>撤销评价</button></div>}
            </div></article>)}
          </section><footer><span>Small Web · 原文摘录，不生成 AI 摘要</span><span>每天更新，慢慢读</span></footer>
        </main>
      </div>}
  </div>;
}
