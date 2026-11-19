// Applies the saved theme before the page paints. Kept separate because the CSP allows no inline scripts.
try {
  const t = localStorage.getItem('acc-theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch {
  /* storage unavailable: follow the system theme */
}
