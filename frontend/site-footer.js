/* Shared public contacts; no tracking, account data or game dependencies. */
(() => {
  const footer = document.createElement('footer');
  footer.className = 'ac-site-footer';
  footer.setAttribute('aria-label', 'Copyright and contact information');
  footer.innerHTML = `
    <div class="ac-footer-inner">
      <div class="ac-footer-copyright">
        <span>© ${new Date().getFullYear()} 21astroboy · AlgoClimb.</span>
        <span>All rights reserved. / Все права защищены.</span>
        <a href="https://github.com/21astroboy/Algoclimb" target="_blank" rel="noopener noreferrer">Source &amp; license · AGPL-3.0</a>
      </div>
      <div class="ac-footer-contacts">
        <strong>Contact / Связаться</strong>
        <a href="mailto:leyurus21@gmail.com">leyurus21@gmail.com</a>
        <a href="mailto:konshin.kp@misis.ru">konshin.kp@misis.ru</a>
        <a href="https://t.me/twentyoneastro" target="_blank" rel="noopener noreferrer">Telegram · @twentyoneastro</a>
      </div>
    </div>`;
  const style = document.createElement('style');
  style.textContent = `
    .ac-site-footer { border-top: 1px solid var(--line, #dce3ec); padding: 24px; margin-top: 28px; color: var(--muted, #6e8095); font: 12px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; }
    .ac-footer-inner { max-width: 1420px; margin: 0 auto; display: flex; justify-content: space-between; gap: 24px; flex-wrap: wrap; }
    .ac-footer-copyright, .ac-footer-contacts { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    .ac-site-footer a { color: inherit; text-decoration: underline; text-underline-offset: 3px; overflow-wrap: anywhere; }
    .ac-site-footer a:hover { color: var(--text, #20384c); }
    .ac-footer-contacts strong { font-size: 13px; }
    @media (max-width: 600px) { .ac-footer-inner { flex-direction: column; gap: 18px; } .ac-site-footer { padding: 20px; } }
    @media print { .ac-site-footer { break-inside: avoid; } }
  `;
  document.head.append(style);
  document.body.append(footer);
})();
