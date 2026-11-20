import { useEffect, useMemo, useState } from 'preact/hooks';
import { Alert, Box, Button, Checkbox, Chip, CircularProgress, Collapse, CssBaseline, Divider, FormControlLabel, IconButton, Paper, Stack, TextField, ThemeProvider, Tooltip, Typography, createTheme } from '@mui/material';
import AutoStoriesOutlined from '@mui/icons-material/AutoStoriesOutlined';
import BookmarkBorderRounded from '@mui/icons-material/BookmarkBorderRounded';
import BookmarkRounded from '@mui/icons-material/BookmarkRounded';
import ArrowOutwardRounded from '@mui/icons-material/ArrowOutwardRounded';
import CheckRounded from '@mui/icons-material/CheckRounded';
import DarkModeOutlined from '@mui/icons-material/DarkModeOutlined';
import LightModeOutlined from '@mui/icons-material/LightModeOutlined';
import ThumbUpOutlined from '@mui/icons-material/ThumbUpOutlined';
import RefreshRounded from '@mui/icons-material/RefreshRounded';
import LogoutRounded from '@mui/icons-material/LogoutRounded';
import { getInitialTheme, persistTheme } from '../lib/theme';
import { clearSession, hasSession, login, request } from './client';
import type { Article, Feed, Feedback } from './client';
import './reader.css';

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
  const [about, setAbout] = useState(false);
  const theme = useMemo(() => createTheme({
    palette: { mode, primary: { main: mode === 'light' ? '#426449' : '#a8ceb0' },
      background: { default: mode === 'light' ? '#fafbf8' : '#151815', paper: mode === 'light' ? '#ffffff' : '#1b1f1b' },
      text: { primary: mode === 'light' ? '#242c25' : '#e1e8df', secondary: mode === 'light' ? '#69736a' : '#a0ada0' },
      divider: mode === 'light' ? '#e2e7df' : '#30392f' },
    shape: { borderRadius: 10 },
    typography: { fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
      button: { textTransform: 'none', fontWeight: 500 }, body1: { lineHeight: 1.85 }, body2: { lineHeight: 1.7 } },
    components: {
      MuiButton: { defaultProps: { disableElevation: true }, styleOverrides: { root: { borderRadius: 8, minHeight: 40 } } },
      MuiPaper: { defaultProps: { elevation: 0 }, styleOverrides: { root: { backgroundImage: 'none' } } },
      MuiIconButton: { styleOverrides: { root: { borderRadius: 10 } } },
    },
  }), [mode]);

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
  const profile = feed?.digest?.profile;
  const verdictLabel = { useful: '已标记有收获', topic: '已减少该话题', quality: '已记录质量问题', known: '已标记了解过' };
  const navigation = <>
    <Button className="reader-nav-button" variant={view === 'digest' ? 'contained' : 'text'} startIcon={<AutoStoriesOutlined />} onClick={() => setView('digest')}>精选</Button>
    <Button className="reader-nav-button" variant={view === 'saved' ? 'contained' : 'text'} startIcon={<BookmarkBorderRounded />} onClick={() => setView('saved')}>收藏</Button>
  </>;
  const themeButton = <Tooltip title={mode === 'dark' ? '切换浅色' : '切换深色'}><IconButton aria-label={mode === 'dark' ? '切换浅色' : '切换深色'} onClick={() => { const next = mode === 'dark' ? 'light' : 'dark'; setMode(next); persistTheme(next); }}>{mode === 'dark' ? <LightModeOutlined /> : <DarkModeOutlined />}</IconButton></Tooltip>;

  return <ThemeProvider theme={theme}><CssBaseline />
    <Box className="reader-app" sx={{ bgcolor: 'background.default', color: 'text.primary' }}>
      <Box component="header" className="reader-mobile-header" sx={{ borderColor: 'divider' }}>
        <a className="reader-brand" href={import.meta.env.BASE_URL}><AutoStoriesOutlined color="primary" />Small Web<span className="reader-brand-dot" /></a>
        <Stack direction="row" spacing={.5}>{themeButton}{authenticated && <IconButton aria-label="退出" onClick={() => { clearSession(); setAuthenticated(false); }}><LogoutRounded fontSize="small" /></IconButton>}</Stack>
      </Box>
      {authenticated && <Box component="aside" className="reader-sidebar" sx={{ borderColor: 'divider' }}>
        <a className="reader-brand" href={import.meta.env.BASE_URL}><AutoStoriesOutlined color="primary" />Small Web<span className="reader-brand-dot" /></a>
        <Typography variant="caption" color="textSecondary" sx={{ mt: 1, mb: 5 }}>为好文章，留一点时间。</Typography>
        <nav className="reader-navigation" aria-label="主导航">{navigation}</nav>
        <Box sx={{ mt: 5 }}><Typography variant="overline" color="textSecondary">你的阅读方向</Typography><div className="reader-interest-list">{feed?.digest?.topics.map(topic => <Typography key={topic} variant="body2" color="textSecondary">{topic}</Typography>)}</div></Box>
        <Stack direction="row" sx={{alignItems: 'center', justifyContent: 'space-between',  mt: 'auto', pt: 5 }}>{themeButton}<Button color="inherit" size="small" startIcon={<LogoutRounded fontSize="small" />} onClick={() => { clearSession(); setAuthenticated(false); setFeed(null); setLibrary([]); }}>退出</Button></Stack>
      </Box>}
      <main className={authenticated ? 'reader-main' : 'reader-login-main'}>
        {!authenticated ? <Paper className="reader-login" sx={{ border: 1, borderColor: 'divider' }}>
          <AutoStoriesOutlined color="primary" sx={{ fontSize: 36, mb: 4 }} />
          <Typography variant="overline" color="textSecondary" sx={{ letterSpacing: 2 }}>A SMALLER, BETTER WEB</Typography>
          <Typography component="h1" sx={{ fontSize: 32, fontWeight: 650, lineHeight: 1.4, mt: 1 }}>今天，读点好文章。</Typography>
          <Typography color="textSecondary" sx={{ mt: 2, mb: 4 }}>来自独立博客的每日阅读清单。<br />按你的兴趣发现，留住值得反复读的内容。</Typography>
          <form onSubmit={async e => { e.preventDefault(); setLoading(true); setError(''); try { await login(password); setPassword(''); setAuthenticated(true); } catch (err) { setError(err instanceof Error ? err.message : '登录失败'); } finally { setLoading(false); } }}>
            <TextField label="阅读密码" type="password" autoComplete="current-password" required fullWidth value={password} onChange={e => setPassword((e.target as HTMLInputElement).value)} />
            <Button type="submit" fullWidth variant="contained" disabled={loading} sx={{ mt: 2, py: 1.4 }}>{loading ? '登录中…' : '进入阅读'}</Button>
          </form>
        </Paper> : <>
          <div className="reader-mobile-navigation">{navigation}</div>
          <Box className="reader-page-heading">
            <div><Typography variant="overline" color="textSecondary" sx={{ letterSpacing: 2 }}>{view === 'saved' ? 'YOUR READING SHELF' : 'YOUR DAILY READING'}</Typography><Typography component="h1" sx={{ fontSize: { xs: 30, md: 38 }, fontWeight: 650, letterSpacing: '-.04em', mt: .5 }}>{view === 'saved' ? '我的收藏' : '每日精选'}</Typography></div>
            <Tooltip title="刷新文章"><IconButton aria-label="刷新" disabled={loading} onClick={() => void load()}><RefreshRounded /></IconButton></Tooltip>
          </Box>
          <Typography color="textSecondary" sx={{ mt: 1, mb: 4 }}>{view === 'saved' ? '那些想留着慢慢读的文章，都在这里。' : '从独立作者的思考里，发现值得停留的内容。'}</Typography>
          {view === 'digest' && <>
            <Paper className="reader-brief" sx={{ bgcolor: mode === 'light' ? '#edf3e9' : '#232e23' }}>
              <div><Typography variant="overline" color="primary">{feed?.digest ? date(feed.digest.generated_at) + ' · 阅读清单' : '今日阅读'}</Typography><Typography sx={{ fontSize: 23, fontWeight: 600, mt: .5 }}>为你选了 {items.length} 篇文章</Typography><Typography variant="body2" color="textSecondary" sx={{ mt: .7 }}>{feed?.digest ? `从 ${feed.digest.candidate_count} 篇近期文章中发现，按兴趣为你整理。` : '第一份阅读清单正在路上。'}</Typography></div>
              <Box className="reader-brief-mark" aria-hidden="true"><AutoStoriesOutlined sx={{ fontSize: 56 }} /></Box>
            </Paper>
            {profile && <Box className="reader-profile-note"><Typography variant="body2" color="textSecondary">{profile.mode === 'cold_start' ? '还在认识你的兴趣。读到喜欢的文章，点一下“有收获”。' : `已参考你认可的 ${profile.positive_samples} 篇文章，逐步认识你的兴趣。`}</Typography><Button size="small" onClick={() => setAbout(!about)} aria-expanded={about}>{about ? '收起说明' : '推荐说明'}</Button></Box>}
            <Collapse in={about}><Alert severity="info" sx={{ mb: 3 }}>{profile?.mode === 'cold_start' ? '冷启动探索：尚无你标记“有收获”的文章，当前根据兴趣描述筛选，可能不相关。' : `已形成 ${profile?.clusters} 个兴趣组。${profile?.mode === 'learning' ? '样本积累中，仍参考初始兴趣描述。' : '当前以文章样本为推荐依据。'}`}评价会在下次每日更新时参与推荐，点击、已读和收藏不会自动视为喜欢。</Alert></Collapse>
            <Box className="reader-filter-bar" sx={{ borderColor: 'divider' }}><Typography variant="body2" color="textSecondary">{shown.length} 篇可读</Typography><Stack direction="row" spacing={1} sx={{alignItems: 'center'}}><FormControlLabel sx={{ mr: 0 }} control={<Checkbox size="small" checked={hideRead} onChange={e => setHideRead((e.target as HTMLInputElement).checked)} />} label={<Typography variant="body2">隐藏已读</Typography>} />{Boolean(feed?.history.length) && <TextField select size="small" value={digestId} onChange={e => setDigestId((e.target as HTMLSelectElement).value)} slotProps={{ select: { native: true }, htmlInput: { 'aria-label': '选择历史精选' } }} sx={{ minWidth: 112, '& fieldset': { border: 0 }, '& select': { fontSize: 13 } }}><option value="latest">最新一期</option>{feed?.history.map(d => <option key={d.id} value={d.id}>{d.run_key}</option>)}</TextField>}</Stack></Box>
          </>}
          {loading && <Box role="status" sx={{ py: 8, textAlign: 'center' }}><CircularProgress size={26} /><Typography color="textSecondary" sx={{ mt: 2 }}>正在加载…</Typography></Box>}
          {!loading && !shown.length && <Box sx={{ py: 10, textAlign: 'center' }}><BookmarkBorderRounded sx={{ fontSize: 40, color: 'text.secondary', mb: 2 }} /><Typography color="textSecondary">{view === 'saved' ? '还没有收藏。读到想保留的文章时，点一下收藏。' : items.length ? '这一期已经读完了。取消“隐藏已读”可以重新查看。' : '还没有生成精选。第一轮每日任务完成后会显示在这里。'}</Typography></Box>}
          {!loading && shown.map((article, i) => <Box component="article" key={article.url} className="reader-article" sx={{ borderColor: 'divider' }}>
            <Typography className="reader-article-number" aria-hidden="true" sx={{ color: 'text.disabled' }}>{String(i + 1).padStart(2, '0')}</Typography>
            <div className="reader-article-content">
              <Stack direction="row" sx={{alignItems: 'center', flexWrap: 'wrap', gap: 1,  mb: 1.5 }}><Typography variant="caption" color="textSecondary" sx={{ overflowWrap: 'anywhere' }}>{article.source}</Typography><span className="reader-meta-dot">·</span><Typography variant="caption" color="textSecondary">{date(article.published_at)}</Typography>{article.exploration && <Chip size="small" label="探索" sx={{ height: 20, fontSize: 10 }} />}{Boolean(article.feedback?.is_read) && <Chip size="small" label="已读" variant="outlined" sx={{ height: 20, fontSize: 10 }} />}</Stack>
              <Typography component="h2" className="reader-article-title" sx={{ fontSize: { xs: 21, md: 25 }, fontWeight: 600, lineHeight: 1.4 }}><a href={article.url} target="_blank" rel="noopener noreferrer">{article.title}<ArrowOutwardRounded className="reader-open-icon" /></a></Typography>
              <Typography className="reader-excerpt" color="textSecondary" sx={{ mt: 1.7, fontSize: 15, lineHeight: 1.85 }}>{expanded === article.url ? article.summary : article.summary.slice(0, 320)}{article.summary.length > 320 && expanded !== article.url ? '…' : ''}</Typography>
              {article.summary.length > 320 && <Button size="small" sx={{ px: 0, minWidth: 0, mt: .5 }} onClick={() => setExpanded(expanded === article.url ? null : article.url)}>{expanded === article.url ? '收起摘录' : '展开原文摘录'}</Button>}
              {article.reason && profile?.mode !== 'cold_start' && <Typography variant="caption" color="textSecondary" sx={{ display: 'block', mt: 1.5 }}>{article.reason}</Typography>}
              <Stack className="reader-article-actions" direction="row" sx={{flexWrap: 'wrap', gap: .5,  mt: 2 }}>
                <Button size="small" variant={article.feedback?.verdict === 'useful' ? 'contained' : 'text'} color={article.feedback?.verdict === 'useful' ? 'primary' : 'inherit'} startIcon={<ThumbUpOutlined sx={{ fontSize: '16px !important' }} />} disabled={pending !== null} onClick={() => void act(article, article.feedback?.verdict === 'useful' ? 'clear' : 'useful')}>有收获</Button>
                <Button size="small" color="inherit" startIcon={article.feedback?.saved ? <BookmarkRounded sx={{ fontSize: '17px !important' }} /> : <BookmarkBorderRounded sx={{ fontSize: '17px !important' }} />} disabled={pending !== null} onClick={() => void act(article, article.feedback?.saved ? 'unsave' : 'save')}>{article.feedback?.saved ? '已收藏' : '收藏'}</Button>
                <Button size="small" color="inherit" startIcon={<CheckRounded sx={{ fontSize: '17px !important' }} />} disabled={pending !== null} onClick={() => void act(article, article.feedback?.is_read ? 'unread' : 'read')}>{article.feedback?.is_read ? '设为未读' : '标记已读'}</Button>
                <Button size="small" color="inherit" disabled={pending !== null} aria-expanded={less === article.url} onClick={() => setLess(less === article.url ? null : article.url)}>少推荐这类</Button>
              </Stack>
              <Collapse in={less === article.url}><Paper sx={{ bgcolor: 'action.hover', p: 1.5, mt: 1 }}><Typography variant="caption" color="textSecondary">哪一点不合适？</Typography><Stack direction="row" sx={{flexWrap: 'wrap', gap: .5,  mt: .5 }}>{[['topic', '话题不感兴趣'], ['quality', '质量不佳'], ['known', '已经了解']].map(([action, label]) => <Button key={action} size="small" disabled={pending !== null} onClick={() => void act(article, action)}>{label}</Button>)}</Stack></Paper></Collapse>
              {article.feedback?.verdict && <Stack direction="row" sx={{alignItems: 'center', gap: 1,  mt: 1 }}><Typography variant="caption" color="textSecondary">{verdictLabel[article.feedback.verdict]}</Typography><Button size="small" disabled={pending !== null} onClick={() => void act(article, 'clear')}>撤销评价</Button></Stack>}
            </div>
          </Box>)}
          <Divider sx={{ mt: 2 }} /><Typography component="footer" variant="caption" color="textSecondary" sx={{ display: 'block', py: 4 }}>SMALL WEB · 原文摘录，独立思考。每天更新，慢慢读。</Typography>
        </>}
        {error && <Alert severity="error" sx={{ my: 3 }} onClose={() => setError('')}>{error}</Alert>}
      </main>
    </Box>
  </ThemeProvider>;
}
