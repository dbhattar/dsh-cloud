import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { readBoot } from './boot.ts';
import { Admin } from './pages/Admin.tsx';
import { Feedback } from './pages/Feedback.tsx';
import { Launching } from './pages/Launching.tsx';
import { Login } from './pages/Login.tsx';
import { Forgot, Notice, Reset, Waitlist } from './pages/Recovery.tsx';
import { Shell } from './pages/Shell.tsx';
import './styles/base.css';
import './styles/design-platform.css';
import './styles/global.css';

// Same palette switch as the harness boot script: system preference toggles body[data-ds-dark-theme].
const dark = matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => document.body.toggleAttribute('data-ds-dark-theme', dark.matches);
applyTheme();
dark.addEventListener('change', applyTheme);

const boot = readBoot();

// Standalone gateway pages jump out if they ever render inside the app iframe (e.g. session expired).
// The launching page lives in that iframe on purpose, so it never busts.
// Feedback also stays put: the shell shows it in a dialog.
if (boot.page !== 'launching' && boot.page !== 'shell' && boot.page !== 'feedback' && top !== self && top) top.location.href = location.href;

function App() {
  switch (boot.page) {
    case 'login': return <Login {...boot} />;
    case 'forgot': return <Forgot {...boot} />;
    case 'reset': return <Reset {...boot} />;
    case 'waitlist': return <Waitlist {...boot} />;
    case 'notice': return <Notice {...boot} />;
    case 'feedback': return <Feedback {...boot} />;
    case 'launching': return <Launching {...boot} />;
    case 'shell': return <Shell {...boot} />;
    case 'admin': return <Admin {...boot} />;
  }
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
