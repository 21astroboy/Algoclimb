/* Interface-only translations. User content is interpolated after static text is translated. */
(() => {
  let language = 'en';
  try {
    language = localStorage.getItem('ac.language') === 'ru' ? 'ru' : 'en';
  } catch {}
  let messages = {};
  let matcher;
  const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const t = (message) => (language === 'ru' ? (messages[message] ?? message) : message);
  const replaceText = (value) =>
    language === 'ru' && matcher ? value.replace(matcher, (key) => messages[key]) : value;
  function staticHTML(value) {
    if (language !== 'ru') return value;
    return value.replace(/<[^>]*>|[^<]+/g, (part) =>
      part.startsWith('<')
        ? part.replace(
            /(aria-label|title|placeholder)="([^"]*)"/g,
            (_all, attr, text) => `${attr}="${replaceText(text)}"`
          )
        : replaceText(part)
    );
  }
  const controller = new AbortController();
  const loadTimeout = setTimeout(() => controller.abort(), 5000);
  const ready = fetch('/locales/ru.json?v=20261128', { signal: controller.signal })
    .then((response) => {
      if (!response.ok) throw new Error('Language pack unavailable');
      return response.json();
    })
    .then((data) => {
      messages = data;
      // Boundaries protect identifiers, URLs and partial words; longest phrases win.
      matcher = new RegExp(
        '(?<![\\p{L}\\p{N}_])(?:' +
          Object.keys(messages)
            .sort((a, b) => b.length - a.length)
            .map(escapeRegex)
            .join('|') +
          ')(?![\\p{L}\\p{N}_])',
        'gu'
      );
      document.documentElement.lang = language;
    })
    .catch(() => {
      language = 'en';
      document.documentElement.lang = 'en';
    })
    .finally(() => clearTimeout(loadTimeout));
  window.ACI18n = {
    ready,
    t,
    staticHTML,
    html: (parts, ...values) =>
      parts.reduce(
        (out, part, i) => out + staticHTML(part) + (i < values.length ? String(values[i]) : ''),
        ''
      ),
    get language() {
      return language;
    },
    setLanguage(value) {
      if (value === 'ru' && !Object.keys(messages).length)
        throw new Error('Language pack unavailable. Reload the page.');
      language = value === 'ru' ? 'ru' : 'en';
      document.documentElement.lang = language;
      try {
        localStorage.setItem('ac.language', language);
      } catch {}
    },
  };
})();
