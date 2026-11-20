import { useState } from 'preact/hooks';
import defaults from '../../../cloud/preferences.json';
import type { Theme } from '../lib/theme';

export interface ReaderSettings {
  theme: Theme;
  density: 'compact' | 'comfortable';
  hide_read: boolean;
  topics: { name: string; description: string }[];
}
export interface SettingsResponse { settings: ReaderSettings; configured: boolean; updated_at: string | null }
export const defaultSettings = defaults as ReaderSettings;

export function Settings({ value, onSave, onClose }: {
  value: ReaderSettings;
  onSave: (value: ReaderSettings) => Promise<ReaderSettings>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<ReaderSettings>(() => structuredClone(value));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const dirty = JSON.stringify(draft) !== JSON.stringify(value);
  function topic(index: number, key: 'name' | 'description', text: string) {
    setDraft(d => ({ ...d, topics: d.topics.map((t, i) => i === index ? { ...t, [key]: text } : t) })); setMessage('');
  }
  function close() {
    if (saving) return;
    if (!dirty || window.confirm('还有未保存的修改，放弃修改并返回阅读？')) onClose();
  }
  return <div class="settings-page"><div class="page-heading"><div><h1>设置</h1><p>调整阅读体验，以及你希望发现的内容。</p></div><button type="button" class="btn btn-sm" onClick={close} disabled={saving}>返回阅读</button></div>
    {error && <p class="reader-error" role="alert">{error}</p>}{message && <p class="settings-message" role="status">{message}</p>}
    <form onSubmit={async e => { e.preventDefault(); setSaving(true); setError(''); setMessage(''); try { setDraft(structuredClone(await onSave(draft))); setMessage('已保存。阅读设置已生效，兴趣偏好将在下次每日更新时使用。'); } catch (err) { setError(err instanceof Error ? err.message : '保存失败，请重试'); } finally { setSaving(false); } }}>
      <fieldset disabled={saving} class="settings-fieldset">
      <div class="settings-save"><button class="btn" type="submit" disabled={!dirty || saving}>{saving ? '保存中…' : '保存设置'}</button><button class="btn btn-linklike" type="button" onClick={close} disabled={saving}>取消</button><span>{dirty ? '有尚未保存的修改' : '设置已同步'}</span></div>
      <section class="Box settings-section"><div class="Box-header"><h2>阅读体验</h2></div><div class="settings-row"><div><label for="settings-theme">主题</label><p>选择深色或浅色，登录后跨设备保留。</p></div><select id="settings-theme" class="form-select" value={draft.theme} onChange={e => { setDraft({ ...draft, theme: e.currentTarget.value as Theme }); setMessage(''); }}><option value="dark">深色</option><option value="light">浅色</option></select></div>
        <div class="settings-row"><div><label for="settings-density">阅读密度</label><p>紧凑模式显示更多文章，舒适模式增加字号和留白。</p></div><select id="settings-density" class="form-select" value={draft.density} onChange={e => { setDraft({ ...draft, density: e.currentTarget.value as ReaderSettings['density'] }); setMessage(''); }}><option value="compact">紧凑</option><option value="comfortable">舒适</option></select></div>
        <div class="settings-row"><div><label for="settings-hide-read">默认隐藏已读</label><p>每次进入阅读器时，自动隐藏已读文章。</p></div><input id="settings-hide-read" type="checkbox" checked={draft.hide_read} onChange={e => { setDraft({ ...draft, hide_read: e.currentTarget.checked }); setMessage(''); }} /></div></section>
      <section class="Box settings-section"><div class="Box-header settings-section-header"><h2>兴趣偏好</h2><span>{draft.topics.length} / 20</span></div><p class="settings-help">兴趣描述用于冷启动和样本积累阶段。积累足够“有收获”文章后，推荐主要参考你的文章兴趣中心。支持中文或英文描述；写清希望读什么，比只写关键词更有帮助。</p>
        {draft.topics.map((t, i) => <div class="settings-topic" key={i}><div class="settings-topic-heading"><label for={`topic-name-${i}`}>兴趣 {i + 1}</label><button type="button" class="btn btn-sm" aria-label={`删除兴趣 ${i + 1}`} disabled={draft.topics.length <= 1} onClick={() => { setDraft({ ...draft, topics: draft.topics.filter((_, j) => j !== i) }); setMessage(''); }}>删除</button></div><input id={`topic-name-${i}`} aria-label={`兴趣 ${i + 1} 名称`} class="form-control" required maxLength={40} placeholder="兴趣名称，如语言学习" value={t.name} onInput={e => topic(i, 'name', e.currentTarget.value)} /><label class="topic-description-label" for={`topic-description-${i}`}>希望读到什么</label><textarea id={`topic-description-${i}`} aria-label={`兴趣 ${i + 1} 描述`} class="form-control" required minLength={10} maxLength={2000} rows={3} placeholder="描述希望发现的主题、内容深度和具体例子，至少 10 个字符。" value={t.description} onInput={e => topic(i, 'description', e.currentTarget.value)} /></div>)}
        <div class="settings-add"><button type="button" class="btn btn-sm" disabled={draft.topics.length >= 20} onClick={() => { setDraft({ ...draft, topics: [...draft.topics, { name: '', description: '' }] }); setMessage(''); }}>添加兴趣</button><span>至少保留 1 个兴趣；最多 20 个。</span></div></section>
      </fieldset>
    </form>
  </div>;
}
