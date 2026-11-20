import { useEffect, useState } from 'preact/hooks';
import { ThemeToggle } from '../components/ThemeToggle';
import { clearSession, hasSession, login, request } from './client';
import type { Article, Feed, Feedback } from './client';

const button = 'rounded-lg border border-slate-200 dark:border-slate-700 px-3 py-2 text-sm hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40';
const active = ' bg-teal-50 text-teal-700 dark:bg-teal-950 dark:text-teal-300';

function date(value: string) {
  const d = new Date(value);
  return Number.isNaN(d.valueOf()) ? '' : d.toLocaleDateString('zh-CN');
}

export function CloudApp() {
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

  useEffect(() => {
    document.title = 'Small Web · 每日精选';
    document.documentElement.lang = 'zh-CN';
    const expired = () => setAuthenticated(false);
    window.addEventListener('smallweb:expired', expired);
    return () => window.removeEventListener('smallweb:expired', expired);
  }, []);

  async function load() {
    if (!authenticated) return;
    setLoading(true); setError('');
    try {
      if (view === 'saved') setLibrary((await request<{ items: Article[] }>('/api/library')).items);
      else setFeed(await request<Feed>(`/api/feed?digest=${encodeURIComponent(digestId)}`));
    } catch (e) { setError(e instanceof Error ? e.message : '加载失败'); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [authenticated, view, digestId]);

  async function act(article: Article, action: string) {
    if (pending) return;
    setPending(article.url); setError('');
    try {
      const result = await request<{ feedback: Feedback }>('/api/feedback', { url: article.url, action });
      const update = (items: Article[]) => items.map(i => i.url === article.url ? { ...i, feedback: result.feedback } : i);
      setFeed(f => f?.digest ? { ...f, digest: { ...f.digest, items: update(f.digest.items) } } : f);
      setLibrary(items => update(items).filter(i => i.feedback?.saved));
      setLess(null);
    } catch (e) { setError(e instanceof Error ? e.message : '保存失败，请重试'); }
    finally { setPending(null); }
  }

  const items = view === 'saved' ? library : (feed?.digest?.items || []);
  const shown = hideRead && view === 'digest' ? items.filter(i => !i.feedback?.is_read) : items;
  const verdictLabel = { useful: '已标记有收获', topic: '已减少该话题', quality: '已记录质量问题', known: '已标记了解过' };

  return <div class="min-h-screen bg-slate-50 text-slate-800 dark:bg-slate-950 dark:text-slate-200">
    <header class="sticky top-0 z-20 border-b border-slate-200 bg-white/95 dark:border-slate-800 dark:bg-slate-950/95">
      <div class="mx-auto flex max-w-5xl items-center justify-between gap-4 px-5 py-4">
        <a href={import.meta.env.BASE_URL} class="font-bold text-lg tracking-tight no-underline text-inherit">Small Web · 每日精选</a>
        <div class="flex gap-2 items-center"><ThemeToggle />{authenticated && <button class={button} onClick={() => { clearSession(); setAuthenticated(false); setFeed(null); setLibrary([]); }}>退出</button>}</div>
      </div>
    </header>
    <main class="mx-auto max-w-5xl px-5 py-8">
      {!authenticated ? <section class="mx-auto mt-10 max-w-md rounded-2xl border border-slate-200 bg-white p-7 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <p class="text-sm text-teal-600 dark:text-teal-400">给好文章留一点时间</p>
        <h1 class="text-2xl font-bold mt-2">你的独立博客阅读清单</h1>
        <p class="text-sm leading-6 text-slate-500 mt-3">每天更新，按兴趣精选。登录后阅读、收藏并留下反馈。</p>
        <form class="mt-6 space-y-3" onSubmit={async e => { e.preventDefault(); setLoading(true); setError(''); try { await login(password); setPassword(''); setAuthenticated(true); } catch (err) { setError(err instanceof Error ? err.message : '登录失败'); } finally { setLoading(false); } }}>
          <label class="block text-sm">阅读密码<input type="password" autoComplete="current-password" required value={password} onInput={e => setPassword(e.currentTarget.value)} class="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 dark:border-slate-700 dark:bg-slate-950" /></label>
          <button disabled={loading} class="w-full rounded-lg bg-teal-700 py-2.5 text-white disabled:opacity-50">{loading ? '登录中…' : '进入阅读'}</button>
        </form>
      </section> : <>
        <div class="flex flex-wrap items-end justify-between gap-4 mb-5">
          <div><p class="text-sm text-teal-700 dark:text-teal-400">{view === 'saved' ? '留给以后的自己' : '从小网络里，发现值得读的声音'}</p><h1 class="text-3xl font-bold mt-2">{view === 'saved' ? '我的收藏' : '每日精选'}</h1></div>
          <div class="flex flex-wrap gap-2"><button class={button + (view === 'digest' ? active : '')} onClick={() => setView('digest')}>精选</button><button class={button + (view === 'saved' ? active : '')} onClick={() => setView('saved')}>收藏</button><button class={button} onClick={() => void load()} disabled={loading}>刷新</button></div>
        </div>
        {view === 'digest' && <div class="mb-6 space-y-4">
          <div class="flex flex-wrap gap-2">{feed?.digest?.topics?.map(topic => <span class="rounded-full border border-teal-200 bg-teal-50 px-3 py-1 text-xs text-teal-800 dark:border-teal-900 dark:bg-teal-950 dark:text-teal-300">{topic}</span>)}</div>
          {feed?.digest?.profile && <p class="text-sm leading-6 text-slate-500">{feed.digest.profile.mode === 'cold_start'
            ? '冷启动探索：尚无你标记“有收获”的文章。当前根据兴趣描述筛选，可能不相关；认可的文章会逐步建立你的兴趣。'
            : `已采用 ${feed.digest.profile.positive_samples} 篇“有收获”文章，形成 ${feed.digest.profile.clusters} 个兴趣组。${feed.digest.profile.mode === 'learning' ? '样本积累中，仍参考初始兴趣描述。' : '当前以文章样本为推荐依据。'}`}</p>}
          <div class="flex flex-wrap items-center justify-between gap-3 text-sm text-slate-500">
            <span>{feed?.digest ? `${date(feed.digest.generated_at)} 更新 · 从 ${feed.digest.candidate_count} 篇候选中选出 ${items.length} 篇` : '等待第一份精选'}</span>
            <div class="flex gap-3 items-center"><label class="flex gap-2 items-center"><input type="checkbox" checked={hideRead} onChange={e => setHideRead(e.currentTarget.checked)} />隐藏已读</label>{Boolean(feed?.history.length) && <select aria-label="选择历史精选" class="rounded-lg border border-slate-200 bg-white px-2 py-2 dark:border-slate-700 dark:bg-slate-900" value={digestId} onChange={e => setDigestId(e.currentTarget.value)}><option value="latest">最新一期</option>{feed?.history.map(d => <option value={d.id}>{d.run_key}</option>)}</select>}</div>
          </div>
        </div>}
        {loading && <p role="status" class="py-8 text-slate-500">正在加载…</p>}
        {!loading && !shown.length && <div class="rounded-xl border border-dashed border-slate-300 p-10 text-center text-slate-500 dark:border-slate-700">{view === 'saved' ? '还没有收藏。读到想保留的文章时，点一下收藏。' : items.length ? '这一期已经读完了。取消“隐藏已读”可以重新查看。' : '还没有生成精选。第一轮每日任务完成后会显示在这里。'}</div>}
        <div class="grid gap-5 md:grid-cols-2">{!loading && shown.map(article => <article key={article.url} class="flex flex-col rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <div class="flex justify-between gap-2 text-xs text-slate-500"><span>{article.category}{article.exploration ? ' · 探索' : ''}</span><span>{article.feedback?.is_read ? '已读' : date(article.published_at)}</span></div>
          <h2 class="mt-3 text-xl font-semibold leading-7"><a href={article.url} target="_blank" rel="noopener noreferrer" class="text-inherit hover:text-teal-700 dark:hover:text-teal-400">{article.title}</a></h2>
          <p class="mt-2 text-xs text-slate-500 break-all">{article.source}</p>
          <p class="mt-4 text-sm leading-7 whitespace-pre-line">{expanded === article.url ? article.summary : article.summary.slice(0, 320)}{article.summary.length > 320 && expanded !== article.url ? '…' : ''}</p>
          {article.summary.length > 320 && <button class="mt-2 self-start text-sm text-teal-700 dark:text-teal-400" onClick={() => setExpanded(expanded === article.url ? null : article.url)}>{expanded === article.url ? '收起摘录' : '展开原文摘录'}</button>}
          {article.reason && <p class="mt-4 rounded-lg bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-500 dark:bg-slate-950">{article.reason}</p>}
          <div class="mt-auto pt-5 flex flex-wrap gap-2">
            <button disabled={pending !== null} class={button + (article.feedback?.verdict === 'useful' ? active : '')} onClick={() => void act(article, article.feedback?.verdict === 'useful' ? 'clear' : 'useful')}>有收获</button>
            <button disabled={pending !== null} class={button} onClick={() => setLess(less === article.url ? null : article.url)}>少推荐这类</button>
            <button disabled={pending !== null} class={button + (article.feedback?.saved ? active : '')} onClick={() => void act(article, article.feedback?.saved ? 'unsave' : 'save')}>{article.feedback?.saved ? '已收藏' : '收藏'}</button>
            <button disabled={pending !== null} class={button} onClick={() => void act(article, article.feedback?.is_read ? 'unread' : 'read')}>{article.feedback?.is_read ? '设为未读' : '标记已读'}</button>
          </div>
          {less === article.url && <div class="mt-3 flex flex-wrap gap-2 rounded-lg bg-slate-50 p-3 dark:bg-slate-950">{[['topic', '话题不感兴趣'], ['quality', '质量不佳'], ['known', '已经了解']].map(([action, label]) => <button class={button} disabled={pending !== null} onClick={() => void act(article, action)}>{label}</button>)}</div>}
          {article.feedback?.verdict && <div class="mt-3 flex gap-3 text-xs text-slate-500"><span>{verdictLabel[article.feedback.verdict]}</span><button class="underline" disabled={pending !== null} onClick={() => void act(article, 'clear')}>撤销评价</button></div>}
        </article>)}</div>
        <p class="mt-8 text-xs leading-6 text-slate-500">展示原文摘录，不生成 AI 摘要。反馈影响后续精选，点击原文不会自动视为喜欢。</p>
      </>}
      {error && <div role="alert" class="mt-5 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-300">{error}</div>}
    </main>
  </div>;
}
