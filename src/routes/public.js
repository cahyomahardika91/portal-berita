const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { q, one } = require('../db');
const { stripHtml, upload } = require('../util');

const router = express.Router();
const BASE = `FROM posts p JOIN users u ON u.id = p.author_id
  WHERE p.type = 'post' AND p.status = 'published' AND p.published_at <= NOW()`;
const COLS = `p.id, p.title, p.slug, p.excerpt, p.featured_image, p.published_at, p.views, u.display_name author_name, u.username author_username`;

async function attachCats(posts) {
  if (!posts.length) return posts;
  const rows = await q(`SELECT pc.post_id, c.id, c.name, c.slug FROM post_categories pc JOIN categories c ON c.id = pc.category_id WHERE pc.post_id IN (?)`, [posts.map((p) => p.id)]);
  posts.forEach((p) => { p.categories = rows.filter((r) => r.post_id === p.id); p.category = p.categories[0] || null; });
  return posts;
}
const list = async (where = '', params = [], order = 'p.published_at DESC', limit = 10, offset = 0) =>
  attachCats(await q(`SELECT ${COLS} ${BASE} ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, [...params, limit, offset]));

// Shared data for layout: menus, sidebar
async function loadData(req, res, next) {
  try {
    const [menuRows, categories, popular, tags] = await Promise.all([
      q('SELECT * FROM menu_items ORDER BY location, position, id'),
      q(`SELECT c.*, COUNT(p.id) cnt FROM categories c LEFT JOIN post_categories pc ON pc.category_id = c.id
         LEFT JOIN posts p ON p.id = pc.post_id AND p.status = 'published' AND p.published_at <= NOW()
         GROUP BY c.id HAVING cnt > 0 ORDER BY c.name`),
      list('AND p.published_at > NOW() - INTERVAL 30 DAY', [], 'p.views DESC', 5),
      q(`SELECT t.name, t.slug FROM tags t JOIN post_tags pt ON pt.tag_id = t.id GROUP BY t.id ORDER BY COUNT(*) DESC LIMIT 20`),
    ]);
    res.locals.menus = { primary: menuRows.filter((m) => m.location === 'primary'), footer: menuRows.filter((m) => m.location === 'footer') };
    res.locals.sideCategories = categories;
    res.locals.sidePopular = popular;
    res.locals.sideTags = tags;
    res.locals.seo = {};
    next();
  } catch (e) { next(e); }
}
router.use(loadData);

const perPage = (res) => Math.max(1, Math.min(50, +res.locals.settings.posts_per_page || 10));
const pageNo = (req) => Math.max(1, parseInt(req.query.page, 10) || 1);
const render = (res, view, data) => res.render(`public/${view}`, data);

router.get('/', async (req, res, next) => {
  try {
    const page = pageNo(req); const pp = perPage(res);
    const featured = page === 1 ? await list('AND p.is_featured = 1', [], 'p.published_at DESC', 5) : [];
    const exclude = featured.map((f) => f.id);
    const ex = exclude.length ? 'AND p.id NOT IN (?)' : '';
    const exParams = exclude.length ? [exclude] : [];
    const [{ total }] = await q(`SELECT COUNT(*) total ${BASE} ${ex}`, exParams);
    const latest = await list(ex, exParams, 'p.published_at DESC', pp, (page - 1) * pp);
    let sections = [];
    if (page === 1) {
      const top = res.locals.sideCategories.slice(0, 3);
      sections = await Promise.all(top.map(async (c) => ({
        category: c,
        posts: await list('AND p.id IN (SELECT post_id FROM post_categories WHERE category_id = ?)', [c.id], 'p.published_at DESC', 4),
      })));
    }
    render(res, 'home', { title: res.locals.settings.site_title, seo: { title: res.locals.settings.site_title, description: res.locals.settings.site_description || res.locals.settings.tagline }, featured, latest, sections, page, pages: Math.ceil(total / pp), pagerBase: '/?' });
  } catch (e) { next(e); }
});

async function archive(req, res, next, { title, where, params, heading, sub, base }) {
  try {
    const page = pageNo(req); const pp = perPage(res);
    const [{ total }] = await q(`SELECT COUNT(*) total ${BASE} ${where}`, params);
    const posts = await list(where, params, 'p.published_at DESC', pp, (page - 1) * pp);
    render(res, 'archive', { title, seo: { title }, posts, heading, sub, page, pages: Math.ceil(total / pp), pagerBase: base });
  } catch (e) { next(e); }
}

router.get('/category/:slug', async (req, res, next) => {
  const c = await one('SELECT * FROM categories WHERE slug = ?', [req.params.slug]);
  if (!c) return next();
  archive(req, res, next, { title: c.name, where: 'AND p.id IN (SELECT post_id FROM post_categories WHERE category_id = ?)', params: [c.id], heading: c.name, sub: c.description, base: `/category/${c.slug}?` });
});
router.get('/tag/:slug', async (req, res, next) => {
  const t = await one('SELECT * FROM tags WHERE slug = ?', [req.params.slug]);
  if (!t) return next();
  archive(req, res, next, { title: `Tag: ${t.name}`, where: 'AND p.id IN (SELECT post_id FROM post_tags WHERE tag_id = ?)', params: [t.id], heading: `Tag: ${t.name}`, base: `/tag/${t.slug}?` });
});
router.get('/author/:username', async (req, res, next) => {
  const a = await one('SELECT id, display_name, bio FROM users WHERE username = ?', [req.params.username]);
  if (!a) return next();
  archive(req, res, next, { title: a.display_name, where: 'AND p.author_id = ?', params: [a.id], heading: a.display_name, sub: a.bio, base: `/author/${req.params.username}?` });
});
router.get('/search', async (req, res, next) => {
  const term = String(req.query.q || '').trim().slice(0, 100);
  if (!term) return render(res, 'archive', { title: 'Pencarian', seo: {}, posts: [], heading: 'Pencarian', sub: 'Masukkan kata kunci.', page: 1, pages: 1, pagerBase: '/search?' });
  const like = `%${term.replace(/[%_\\]/g, '\\$&')}%`;
  archive(req, res, next, { title: `Cari: ${term}`, where: 'AND (p.title LIKE ? OR p.content LIKE ? OR p.excerpt LIKE ?)', params: [like, like, like], heading: `Hasil pencarian: "${term}"`, base: `/search?q=${encodeURIComponent(term)}&` });
});

const esc = (s) => String(s ?? '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
router.get('/feed', async (req, res, next) => {
  try {
    const posts = await list('', [], 'p.published_at DESC', 20);
    const s = res.locals.settings; const site = res.locals.siteUrl;
    const items = posts.map((p) => `<item><title>${esc(p.title)}</title><link>${site}/${p.slug}</link><guid>${site}/${p.slug}</guid><pubDate>${new Date(p.published_at).toUTCString()}</pubDate><description>${esc(p.excerpt)}</description></item>`).join('');
    res.type('application/rss+xml').send(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${esc(s.site_title)}</title><link>${site}</link><description>${esc(s.tagline)}</description>${items}</channel></rss>`);
  } catch (e) { next(e); }
});
router.get('/sitemap.xml', async (req, res, next) => {
  try {
    const site = res.locals.siteUrl;
    const rows = await q(`SELECT slug, updated_at FROM posts WHERE status = 'published' AND published_at <= NOW()`);
    const cats = await q('SELECT slug FROM categories');
    const urls = [`<url><loc>${site}/</loc></url>`, ...cats.map((c) => `<url><loc>${site}/category/${c.slug}</loc></url>`),
      ...rows.map((r) => `<url><loc>${site}/${r.slug}</loc><lastmod>${new Date(r.updated_at).toISOString()}</lastmod></url>`)];
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join('')}</urlset>`);
  } catch (e) { next(e); }
});
router.get('/robots.txt', (req, res) => res.type('text').send(`User-agent: *\nDisallow: /admin\nSitemap: ${res.locals.siteUrl}/sitemap.xml\n`));

const registerLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });
const registerEnabled = (req, res, next) => (res.locals.settings.allow_registration === '1' ? next() : res.redirect('/admin/login'));
router.get('/register', registerEnabled, (req, res) => {
  if (req.session.user) return res.redirect('/admin');
  render(res, 'register', { title: 'Daftar', seo: { title: 'Daftar' }, error: null, form: { display_name: '', username: '', email: '' } });
});
router.post('/register', registerEnabled, registerLimiter, async (req, res, next) => {
  try {
    const b = req.body;
    const form = { display_name: String(b.display_name || '').trim().slice(0, 100), username: String(b.username || '').trim().toLowerCase(), email: String(b.email || '').trim().slice(0, 150) };
    const fail = (error) => res.status(400).render('public/register', { title: 'Daftar', seo: { title: 'Daftar' }, error, form });
    if (b.website) return res.redirect('/');
    const username = form.username;
    if (!form.display_name) return fail('Nama lengkap wajib diisi.');
    if (username.length < 3 || username.length > 40 || !/^[a-z0-9]+([._-][a-z0-9]+)*$/.test(username)) return fail('Username 3-40 karakter: huruf kecil, angka, titik, strip, atau underscore (tidak di awal/akhir).');
    if (!/^\S+@\S+\.\S+$/.test(form.email)) return fail('Email tidak valid.');
    if (String(b.password || '').length < 8) return fail('Password minimal 8 karakter.');
    if (await one('SELECT id FROM users WHERE username = ? OR email = ?', [username, form.email])) return fail('Username atau email sudah terdaftar.');
    const role = res.locals.settings.default_role === 'author' ? 'author' : 'contributor';
    const r = await q('INSERT INTO users (username, email, password, display_name, role) VALUES (?,?,?,?,?)', [username, form.email, await bcrypt.hash(b.password, 10), form.display_name, role]);
    req.session.regenerate((e) => {
      if (e) return next(e);
      req.session.user = { id: r.insertId, username, display_name: form.display_name, role };
      req.session.flash = { type: 'ok', msg: 'Pendaftaran berhasil. Selamat datang!' };
      res.redirect('/admin');
    });
  } catch (e) { next(e); }
});

const commentLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });
router.post('/comment/:id', commentLimiter, async (req, res, next) => {
  try {
    const post = await one(`SELECT id, slug, allow_comments FROM posts WHERE id = ? AND status = 'published'`, [req.params.id]);
    if (!post) return next();
    const s = res.locals.settings;
    const back = `/${post.slug}#comments`;
    if (req.body.website) return res.redirect(back); // honeypot
    const name = String(req.body.name || '').trim().slice(0, 100);
    const email = String(req.body.email || '').trim().slice(0, 150);
    const content = String(req.body.content || '').trim().slice(0, 3000);
    if (!post.allow_comments || s.comments_enabled !== '1') return res.redirect(back);
    if (!name || !/^\S+@\S+\.\S+$/.test(email) || content.length < 2) {
      req.session.flash = { type: 'error', msg: 'Nama, email valid, dan komentar wajib diisi.' };
      return res.redirect(back);
    }
    const status = s.comments_moderation === '1' && !(req.session.user && ['admin', 'editor'].includes(req.session.user.role)) ? 'pending' : 'approved';
    await q('INSERT INTO comments (post_id, author_name, author_email, content, status, ip) VALUES (?,?,?,?,?,?)', [post.id, name, email, content, status, req.ip]);
    req.session.flash = { type: 'ok', msg: status === 'pending' ? 'Komentar Anda menunggu moderasi.' : 'Komentar terkirim.' };
    res.redirect(back);
  } catch (e) { next(e); }
});

// Posts & pages by slug (must be last)
router.get('/:slug', async (req, res, next) => {
  try {
    const preview = req.query.preview && req.session.user;
    const post = await one(`SELECT p.*, u.display_name author_name, u.username author_username, u.bio author_bio FROM posts p JOIN users u ON u.id = p.author_id
      WHERE p.slug = ? ${preview ? "AND p.status <> 'trash'" : "AND p.status = 'published' AND p.published_at <= NOW()"}`, [req.params.slug]);
    if (!post) return next();
    const seo = {
      title: post.meta_title || post.title,
      description: post.meta_description || post.excerpt || stripHtml(post.content).slice(0, 160),
      image: post.featured_image ? upload(post.featured_image) : '', url: `/${post.slug}`, type: 'article',
    };
    if (post.type === 'page') return render(res, 'page', { title: seo.title, seo, post });
    await attachCats([post]);
    const tags = await q('SELECT t.name, t.slug FROM tags t JOIN post_tags pt ON pt.tag_id = t.id WHERE pt.post_id = ?', [post.id]);
    const catIds = post.categories.map((c) => c.id);
    const related = catIds.length
      ? await list('AND p.id <> ? AND p.id IN (SELECT post_id FROM post_categories WHERE category_id IN (?))', [post.id, catIds], 'p.published_at DESC', 4)
      : [];
    const comments = await q(`SELECT author_name, content, created_at FROM comments WHERE post_id = ? AND status = 'approved' ORDER BY created_at`, [post.id]);
    if (!preview) {
      req.session.viewed = req.session.viewed || [];
      if (!req.session.viewed.includes(post.id)) {
        req.session.viewed.push(post.id); if (req.session.viewed.length > 50) req.session.viewed.shift();
        q('UPDATE posts SET views = views + 1 WHERE id = ?', [post.id]).catch(() => {});
      }
    }
    render(res, 'post', { title: seo.title, seo, post, tags, related, comments });
  } catch (e) { next(e); }
});

module.exports = router;
