import { render } from 'preact';

import { App } from './app';
import { applyTheme, getInitialTheme } from './lib/theme';
import './index.css';

applyTheme(getInitialTheme());

if (import.meta.env.VITE_CLOUD_MODE === 'true') {
  import('./cloud/CloudApp').then(({ CloudApp }) => {
    render(<CloudApp />, document.getElementById('app')!);
  });
} else {
  render(<App />, document.getElementById('app')!);
}
