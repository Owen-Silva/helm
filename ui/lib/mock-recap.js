// ?mock=1 stand-in for sessions.recap (lane recap). Home loads it directly in mock mode (ui/shell/home.js), so
// transport.js needs no case for it. ?recap=0 previews Home with nothing to recap; ?recap=many shows "+N more".
const MIN = 60_000;

export function mockRecap() {
  const q = new URLSearchParams(location.search).get('recap');
  if (q === '0') return { rows: [] };
  const t = Date.now();
  const rows = [
    { id: 's_booking', title: 'Customer import preview', project: 'booking-portal', outcome: 'waiting', commits: 0, fileCount: 2, files: ['import.ts', 'preview.tsx'], costUsd: 0.41, from: t - 34 * MIN, to: t - 3 * MIN },
    { id: 's_mobile', title: 'Bundle size report on release', project: 'mobile-app', outcome: 'failed', error: 'API Error: 529 overloaded_error (the API is busy, try again)', commits: 0, fileCount: 1, files: ['size-report.js'], costUsd: 0.18, from: t - 52 * MIN, to: t - 40 * MIN },
    { id: 's_storefront', title: 'Fix the login redirect loop', project: 'storefront', outcome: 'done', commits: 2, commitSubject: 'Fix the Clerk redirect loop on /app', fileCount: 5, files: ['auth.js', 'app.html', 'redirect.test.js'], costUsd: 1.27, from: t - 95 * MIN, to: t - 22 * MIN },
    { id: 's_helm', title: 'Helm design system', project: 'helm', outcome: 'working', commits: 0, fileCount: 3, files: ['tokens.css', 'components.css', 'home.css'], costUsd: 0.62, from: t - 18 * MIN, to: t - 1 * MIN },
  ];
  if (q === 'many') {
    rows.push(
      { id: 's_api', title: 'Scheduler clock drift', project: 'api-server', outcome: 'done', commits: 1, commitSubject: 'Clock: resync on resume', fileCount: 1, files: ['clock.js'], costUsd: 0.09, from: t - 140 * MIN, to: t - 120 * MIN },
      { id: 's_sim', title: 'Match simulated load to real traffic', project: 'simulator', outcome: 'stopped', commits: 0, fileCount: 0, files: [], costUsd: 0.03, from: t - 200 * MIN, to: t - 199 * MIN },
      { id: 's_3h', title: 'Sidebar spacing pass', project: 'helm', outcome: 'done', commits: 0, fileCount: 1, files: ['sidebar.css'], costUsd: 0.05, from: t - 240 * MIN, to: t - 236 * MIN },
      { id: 's_pin', title: 'Release checklist', project: 'storefront', outcome: 'done', commits: 0, fileCount: 0, files: [], costUsd: 0, from: t - 300 * MIN, to: t - 300 * MIN },
    );
  }
  return { rows };
}
