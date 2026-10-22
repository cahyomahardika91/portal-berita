const slugifyLib = require('slugify');
const sanitizeHtml = require('sanitize-html');
const { q, one } = require('./db');

const slug = (s) => slugifyLib(String(s || ''), { lower: true, strict: true, locale: 'id' }).slice(0, 150);

async function uniqueSlug(table, base, { type, excludeId } = {}) {
  let s = slug(base) || 'untitled';
  let candidate = s;
  let i = 2;
  for (;;) {
    let sql = `SELECT id FROM ${table} WHERE slug = ?`;
    const params = [candidate];
    if (type) { sql += ' AND type = ?'; params.push(type); }
    if (excludeId) { sql += ' AND id <> ?'; params.push(excludeId); }
    if (!(await one(sql, params))) return candidate;
    candidate = `${s}-${i++}`;
  }
}

const cleanHtml = (html) => sanitizeHtml(html || '', {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat(['img', 'h1', 'h2', 'figure', 'figcaption', 'iframe', 'u', 's', 'span']),
  allowedAttributes: {
    a: ['href', 'name', 'target', 'rel'],
    img: ['src', 'alt', 'width', 'height', 'loading'],
    iframe: ['src', 'width', 'height', 'allowfullscreen', 'frameborder'],
    '*': ['class', 'style'],
  },
  allowedStyles: { '*': { 'text-align': [/^(left|right|center|justify)$/], color: [/^#[0-9a-f]{3,6}$/i, /^rgb\([\d,\s]+\)$/] } },
  allowedIframeHostnames: ['www.youtube.com', 'www.youtube-nocookie.com', 'player.vimeo.com'],
  transformTags: { a: (tag, attribs) => ({ tagName: 'a', attribs: { ...attribs, rel: 'noopener noreferrer' } }) },
});

const stripHtml = (html) => sanitizeHtml(html || '', { allowedTags: [], allowedAttributes: {} }).replace(/\s+/g, ' ').trim();

// Settings with short cache
let settingsCache = null; let settingsAt = 0;
const DEFAULTS = {
  site_title: 'Portal Berita', tagline: 'Berita terkini setiap hari', site_description: '',
  logo: '', favicon: '', posts_per_page: '10', comments_enabled: '1', comments_moderation: '1',
  footer_text: '', facebook: '', twitter: '', instagram: '', youtube: '', head_code: '',
  allow_registration: '0', default_role: 'contributor', active_theme: 'default', active_plugins: '[]',
};
async function getSettings() {
  if (settingsCache && Date.now() - settingsAt < 30000) return settingsCache;
  const rows = await q('SELECT k, v FROM settings');
  const s = { ...DEFAULTS };
  rows.forEach((r) => { s[r.k] = r.v; });
  settingsCache = s; settingsAt = Date.now();
  return s;
}
async function saveSettings(obj) {
  for (const [k, v] of Object.entries(obj)) {
    if (!(k in DEFAULTS)) continue;
    await q('INSERT INTO settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', [k, v]);
  }
  settingsCache = null;
}

const fmtDate = (d) => d ? new Date(d).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
const fmtDateTime = (d) => d ? new Date(d).toLocaleString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
const toInputDate = (d) => {
  if (!d) return '';
  const x = new Date(d); const p = (n) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}T${p(x.getHours())}:${p(x.getMinutes())}`;
};
const upload = (f) => (f ? `/uploads/${f}` : '');

module.exports = { slug, uniqueSlug, cleanHtml, stripHtml, getSettings, saveSettings, fmtDate, fmtDateTime, toInputDate, upload };
