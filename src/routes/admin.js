const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { q, one } = require('../db');
const { requireLogin, requireRole, can } = require('../auth');
const { slug, uniqueSlug, cleanHtml, saveSettings, getSettings } = require('../util');

const router = express.Router();
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'public', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

router.use((req, res, next) => { res.locals.layout = 'layouts/admin'; res.locals.adminPath = req.path; next(); });

const flash = (req, type, msg) => { req.session.flash = { type, msg }; };
const ok = (req, msg) => flash(req, 'ok', msg);
const err = (req, msg) => flash(req, 'error', msg);
const page = (req) => Math.max(1, parseInt(req.query.page, 10) || 1);
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const PER = 20;

// ---------- Auth ----------
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
  handler: (req, res) => res.status(429).render('admin/login', { layout: false, title: 'Login', error: 'Terlalu banyak percobaan. Coba lagi 15 menit lagi.' }) });

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/admin');
  res.render('admin/login', { layout: false, title: 'Login', error: null });
});
router.post('/login', loginLimiter, wrap(async (req, res) => {
  const { username, password } = req.body;
  const u = await one('SELECT * FROM users WHERE username = ? OR email = ?', [username, username]);
  if (!u || !(await bcrypt.compare(String(password || ''), u.password))) {
    return res.status(401).render('admin/login', { layout: false, title: 'Login', error: 'Username atau password salah.' });
  }
  const returnTo = req.session.returnTo;
  req.session.regenerate((e) => {
    if (e) throw e;
    req.session.user = { id: u.id, username: u.username, display_name: u.display_name, role: u.role };
    res.redirect(returnTo && returnTo.startsWith('/admin') ? returnTo : '/admin');
  });
}));
router.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/admin/login')));

router.use(requireLogin);

// ---------- Dashboard ----------
router.get('/', wrap(async (req, res) => {
  const mine = can(req.session.user, 'editor') ? '' : ` AND author_id = ${+req.session.user.id}`;
  const counts = await q(`SELECT type, status, COUNT(*) n FROM posts WHERE 1=1 ${mine} GROUP BY type, status`);
  const n = (type, status) => (counts.find((c) => c.type === type && (!status || c.status === status)) || {}).n || 0;
  const stats = {
    published: n('post', 'published'), drafts: n('post', 'draft') + n('post', 'pending'), pages: n('page', 'published'),
    comments: (await one(`SELECT COUNT(*) n FROM comments WHERE status = 'pending'`)).n,
    views: (await one(`SELECT COALESCE(SUM(views),0) n FROM posts WHERE 1=1 ${mine}`)).n,
  };
  const recent = await q(`SELECT id, title, status, published_at, created_at, views FROM posts WHERE type = 'post' AND status <> 'trash' ${mine} ORDER BY created_at DESC LIMIT 8`);
  const topPosts = await q(`SELECT id, title, slug, views FROM posts WHERE type = 'post' AND status = 'published' ${mine} ORDER BY views DESC LIMIT 5`);
  const comments = await q(`SELECT c.*, p.title post_title FROM comments c JOIN posts p ON p.id = c.post_id ORDER BY c.created_at DESC LIMIT 5`);
  res.render('admin/dashboard', { title: 'Dashboard', stats, recent, topPosts, comments });
}));

// ---------- Posts & Pages ----------
function contentRouter(type) {
  const r = express.Router();
  const base = `/admin/${type}s`;
  const label = type === 'post' ? 'Berita' : 'Halaman';
  if (type === 'page') r.use(requireRole('editor'));

  const canEdit = (u, p) => can(u, 'editor') || (p.author_id === u.id && (p.status !== 'published' || can(u, 'author')));
  const ownerClause = (u) => (can(u, 'editor') ? ['', []] : [' AND p.author_id = ?', [u.id]]);

  r.get('/', wrap(async (req, res) => {
    const status = req.query.status || '';
    const search = String(req.query.s || '').trim();
    const cat = +req.query.cat || 0;
    let where = ' WHERE p.type = ?'; const params = [type];
    if (status) { where += ' AND p.status = ?'; params.push(status); } else where += " AND p.status <> 'trash'";
    if (search) { where += ' AND p.title LIKE ?'; params.push(`%${search}%`); }
    if (cat) { where += ' AND p.id IN (SELECT post_id FROM post_categories WHERE category_id = ?)'; params.push(cat); }
    const [oc, op] = ownerClause(req.session.user); where += oc; params.push(...op);
    const { total } = await one(`SELECT COUNT(*) total FROM posts p ${where}`, params);
    const rows = await q(`SELECT p.id, p.title, p.slug, p.status, p.published_at, p.views, p.author_id, p.is_featured, u.display_name author,
      (SELECT GROUP_CONCAT(c.name SEPARATOR ', ') FROM post_categories pc JOIN categories c ON c.id = pc.category_id WHERE pc.post_id = p.id) cats
      FROM posts p JOIN users u ON u.id = p.author_id ${where} ORDER BY p.created_at DESC LIMIT ? OFFSET ?`, [...params, PER, (page(req) - 1) * PER]);
    const tabs = await q('SELECT status, COUNT(*) n FROM posts p WHERE p.type = ?' + oc + ' GROUP BY status', [type, ...op]);
    const categories = await q('SELECT id, name FROM categories ORDER BY name');
    res.render('admin/posts', { title: label, type, base, label, rows, tabs, status, search, cat, categories, page: page(req), pages: Math.ceil(total / PER), canEdit: (p) => canEdit(req.session.user, p),
      pagerBase: `${base}?status=${encodeURIComponent(status)}&s=${encodeURIComponent(search)}&cat=${cat}&` });
  }));

  const form = wrap(async (req, res) => {
    let post = { id: 0, type, title: '', slug: '', excerpt: '', content: '', featured_image: '', status: 'draft', is_featured: 0, published_at: null, meta_title: '', meta_description: '', allow_comments: 1 };
    let selCats = []; let tags = ''; let revisions = [];
    if (req.params.id) {
      post = await one('SELECT * FROM posts WHERE id = ? AND type = ?', [req.params.id, type]);
      if (!post) return res.redirect(base);
      if (!canEdit(req.session.user, post)) return res.status(403).render('admin/error', { title: 'Akses ditolak', message: 'Anda tidak dapat mengedit konten ini.' });
      selCats = (await q('SELECT category_id FROM post_categories WHERE post_id = ?', [post.id])).map((r) => r.category_id);
      tags = (await q('SELECT t.name FROM tags t JOIN post_tags pt ON pt.tag_id = t.id WHERE pt.post_id = ?', [post.id])).map((r) => r.name).join(', ');
      revisions = await q('SELECT r.id, r.created_at, u.display_name FROM post_revisions r JOIN users u ON u.id = r.user_id WHERE r.post_id = ? ORDER BY r.id DESC LIMIT 10', [post.id]);
    }
    const categories = await q('SELECT id, name FROM categories ORDER BY name');
    const allTags = await q('SELECT name FROM tags ORDER BY name');
    res.render('admin/post-form', { title: post.id ? `Edit ${label}` : `${label} baru`, type, base, label, post, categories, selCats, tags, allTags, revisions });
  });
  r.get('/new', form);
  r.get('/:id/edit', form);

  r.post('/save', wrap(async (req, res) => {
    const b = req.body; const u = req.session.user; const id = +b.id || 0;
    let existing = null;
    if (id) {
      existing = await one('SELECT * FROM posts WHERE id = ? AND type = ?', [id, type]);
      if (!existing || !canEdit(u, existing)) return res.status(403).send('Forbidden');
    }
    const title = String(b.title || '').trim().slice(0, 255);
    if (!title) { err(req, 'Judul wajib diisi.'); return res.redirect(id ? `${base}/${id}/edit` : `${base}/new`); }
    let status = ['draft', 'pending', 'published'].includes(b.status) ? b.status : 'draft';
    if (status === 'published' && !can(u, 'author')) status = 'pending';
    let publishedAt = b.published_at ? new Date(b.published_at) : null;
    if (publishedAt && isNaN(publishedAt)) publishedAt = null;
    if (status === 'published' && !publishedAt) publishedAt = (existing && existing.published_at) || new Date();
    const content = cleanHtml(b.content);
    const excerpt = String(b.excerpt || '').trim().slice(0, 500) || null;
    const img = /^[\w.-]+$/.test(b.featured_image || '') ? b.featured_image : null;
    const featured = can(u, 'editor') ? (b.is_featured ? 1 : 0) : (existing ? existing.is_featured : 0);
    const s = await uniqueSlug('posts', b.slug || title, { type, excludeId: id });
    const vals = [title, s, excerpt, content, img, status, featured, publishedAt, String(b.meta_title || '').slice(0, 255) || null, String(b.meta_description || '').slice(0, 320) || null, b.allow_comments ? 1 : 0];
    let pid = id;
    if (id) {
      await q('UPDATE posts SET title=?, slug=?, excerpt=?, content=?, featured_image=?, status=?, is_featured=?, published_at=?, meta_title=?, meta_description=?, allow_comments=? WHERE id=?', [...vals, id]);
      if (existing.content !== content || existing.title !== title) {
        await q('INSERT INTO post_revisions (post_id, user_id, title, content) VALUES (?,?,?,?)', [id, u.id, existing.title, existing.content]);
        await q('DELETE FROM post_revisions WHERE post_id = ? AND id NOT IN (SELECT id FROM (SELECT id FROM post_revisions WHERE post_id = ? ORDER BY id DESC LIMIT 20) x)', [id, id]);
      }
    } else {
      const r2 = await q('INSERT INTO posts (title, slug, excerpt, content, featured_image, status, is_featured, published_at, meta_title, meta_description, allow_comments, type, author_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', [...vals, type, u.id]);
      pid = r2.insertId;
    }
    if (type === 'post') {
      const cats = [].concat(b.categories || []).map(Number).filter(Boolean);
      await q('DELETE FROM post_categories WHERE post_id = ?', [pid]);
      for (const c of cats) await q('INSERT IGNORE INTO post_categories VALUES (?,?)', [pid, c]);
      const tagNames = [...new Set(String(b.tags || '').split(',').map((t) => t.trim()).filter(Boolean))].slice(0, 20);
      await q('DELETE FROM post_tags WHERE post_id = ?', [pid]);
      for (const name of tagNames) {
        const ts = slug(name); if (!ts) continue;
        await q('INSERT INTO tags (name, slug) VALUES (?,?) ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)', [name.slice(0, 120), ts]);
        const t = await one('SELECT LAST_INSERT_ID() id');
        await q('INSERT IGNORE INTO post_tags VALUES (?,?)', [pid, t.id]);
      }
    }
    ok(req, status === 'published' && publishedAt > new Date() ? `Tersimpan & dijadwalkan terbit ${publishedAt.toLocaleString('id-ID')}.` : 'Tersimpan.');
    res.redirect(`${base}/${pid}/edit`);
  }));

  r.post('/:id/revision/:rid', wrap(async (req, res) => {
    const p = await one('SELECT * FROM posts WHERE id = ? AND type = ?', [req.params.id, type]);
    if (!p || !canEdit(req.session.user, p)) return res.status(403).send('Forbidden');
    const rev = await one('SELECT * FROM post_revisions WHERE id = ? AND post_id = ?', [req.params.rid, p.id]);
    if (rev) { await q('UPDATE posts SET title = ?, content = ? WHERE id = ?', [rev.title, rev.content, p.id]); ok(req, 'Revisi dipulihkan.'); }
    res.redirect(`${base}/${p.id}/edit`);
  }));

  r.post('/:id/:action(trash|restore|delete)', wrap(async (req, res) => {
    const p = await one('SELECT * FROM posts WHERE id = ? AND type = ?', [req.params.id, type]);
    if (!p || !canEdit(req.session.user, p)) return res.status(403).send('Forbidden');
    const a = req.params.action;
    if (a === 'trash') await q("UPDATE posts SET status = 'trash' WHERE id = ?", [p.id]);
    if (a === 'restore') await q("UPDATE posts SET status = 'draft' WHERE id = ?", [p.id]);
    if (a === 'delete' && p.status === 'trash') await q('DELETE FROM posts WHERE id = ?', [p.id]);
    ok(req, { trash: 'Dipindahkan ke tong sampah.', restore: 'Dipulihkan sebagai draft.', delete: 'Dihapus permanen.' }[a]);
    res.redirect(req.get('referer') && req.get('referer').includes(base) ? req.get('referer') : base);
  }));
  return r;
}
router.use('/posts', contentRouter('post'));
router.use('/pages', contentRouter('page'));

// ---------- Categories & Tags ----------
function taxRouter(table, label, hasDesc) {
  const r = express.Router(); const base = `/admin/${table}`;
  r.use(requireRole('editor'));
  r.get('/', wrap(async (req, res) => {
    const rows = await q(`SELECT t.*, (SELECT COUNT(*) FROM post_${table} x WHERE x.${table === 'categories' ? 'category_id' : 'tag_id'} = t.id) cnt FROM ${table} t ORDER BY t.name`);
    const edit = req.query.edit ? rows.find((x) => x.id === +req.query.edit) : null;
    res.render('admin/taxonomy', { title: label, table, label, base, rows, edit, hasDesc });
  }));
  r.post('/save', wrap(async (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 120); const id = +req.body.id || 0;
    if (!name) { err(req, 'Nama wajib diisi.'); return res.redirect(base); }
    const s = await uniqueSlug(table, req.body.slug || name, { excludeId: id });
    const desc = hasDesc ? String(req.body.description || '').slice(0, 500) : null;
    if (id) await q(`UPDATE ${table} SET name=?, slug=?${hasDesc ? ', description=?' : ''} WHERE id=?`, hasDesc ? [name, s, desc, id] : [name, s, id]);
    else await q(`INSERT INTO ${table} (name, slug${hasDesc ? ', description' : ''}) VALUES (?,?${hasDesc ? ',?' : ''})`, hasDesc ? [name, s, desc] : [name, s]);
    ok(req, 'Tersimpan.'); res.redirect(base);
  }));
  r.post('/:id/delete', wrap(async (req, res) => { await q(`DELETE FROM ${table} WHERE id = ?`, [req.params.id]); ok(req, 'Dihapus.'); res.redirect(base); }));
  return r;
}
router.use('/categories', taxRouter('categories', 'Kategori', true));
router.use('/tags', taxRouter('tags', 'Tag', false));

// ---------- Media ----------
const ALLOWED = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' };
const uploader = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ALLOWED[file.mimetype]}`),
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(ALLOWED[file.mimetype] ? null : new Error('Hanya JPG, PNG, GIF, WEBP'), !!ALLOWED[file.mimetype]),
});
router.get('/media', wrap(async (req, res) => {
  const mine = can(req.session.user, 'editor') ? '' : 'WHERE uploaded_by = ' + +req.session.user.id;
  const { total } = await one(`SELECT COUNT(*) total FROM media ${mine}`);
  const rows = await q(`SELECT * FROM media ${mine} ORDER BY id DESC LIMIT 40 OFFSET ?`, [(page(req) - 1) * 40]);
  res.render('admin/media', { title: 'Media', rows, page: page(req), pages: Math.ceil(total / 40), pagerBase: '/admin/media?' });
}));
router.get('/media/list.json', wrap(async (req, res) => {
  res.json(await q('SELECT id, filename, original_name, alt FROM media ORDER BY id DESC LIMIT 100'));
}));
const SIGS = { 'image/jpeg': [0xff, 0xd8, 0xff], 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/gif': [0x47, 0x49, 0x46, 0x38], 'image/webp': [0x52, 0x49, 0x46, 0x46] };
function validSignature(f) {
  const fd = fs.openSync(f.path, 'r'); const buf = Buffer.alloc(4);
  fs.readSync(fd, buf, 0, 4, 0); fs.closeSync(fd);
  return SIGS[f.mimetype].every((b, i) => buf[i] === b);
}
router.post('/media/upload', (req, res, next) => uploader.array('files', 10)(req, res, (e) => {
  if (e) return res.status(400).json({ error: e.message });
  next();
}), wrap(async (req, res) => {
  const out = [];
  for (const f of req.files || []) {
    if (!validSignature(f)) { fs.unlink(f.path, () => {}); continue; }
    const r2 = await q('INSERT INTO media (filename, original_name, mime, size, uploaded_by) VALUES (?,?,?,?,?)', [f.filename, f.originalname.slice(0, 255), f.mimetype, f.size, req.session.user.id]);
    out.push({ id: r2.insertId, filename: f.filename, url: `/uploads/${f.filename}` });
  }
  if (req.accepts(['json', 'html']) === 'json' || req.xhr) return res.json({ files: out });
  ok(req, `${out.length} file diunggah.`); res.redirect('/admin/media');
}));
router.post('/media/:id/alt', wrap(async (req, res) => {
  await q('UPDATE media SET alt = ? WHERE id = ?', [String(req.body.alt || '').slice(0, 255), req.params.id]); ok(req, 'Teks alternatif disimpan.'); res.redirect('/admin/media');
}));
router.post('/media/:id/delete', wrap(async (req, res) => {
  const m = await one('SELECT * FROM media WHERE id = ?', [req.params.id]);
  if (m && (can(req.session.user, 'editor') || m.uploaded_by === req.session.user.id)) {
    fs.unlink(path.join(UPLOAD_DIR, path.basename(m.filename)), () => {});
    await q('DELETE FROM media WHERE id = ?', [m.id]); ok(req, 'File dihapus.');
  }
  res.redirect('/admin/media');
}));

// ---------- Comments ----------
router.get('/comments', requireRole('editor'), wrap(async (req, res) => {
  const status = ['pending', 'approved', 'spam', 'trash'].includes(req.query.status) ? req.query.status : 'pending';
  const { total } = await one('SELECT COUNT(*) total FROM comments WHERE status = ?', [status]);
  const rows = await q('SELECT c.*, p.title post_title, p.slug post_slug FROM comments c JOIN posts p ON p.id = c.post_id WHERE c.status = ? ORDER BY c.created_at DESC LIMIT ? OFFSET ?', [status, PER, (page(req) - 1) * PER]);
  const tabs = await q('SELECT status, COUNT(*) n FROM comments GROUP BY status');
  res.render('admin/comments', { title: 'Komentar', rows, status, tabs, page: page(req), pages: Math.ceil(total / PER), pagerBase: `/admin/comments?status=${status}&` });
}));
router.post('/comments/:id/:action(approved|pending|spam|trash|delete)', requireRole('editor'), wrap(async (req, res) => {
  if (req.params.action === 'delete') await q('DELETE FROM comments WHERE id = ?', [req.params.id]);
  else await q('UPDATE comments SET status = ? WHERE id = ?', [req.params.action, req.params.id]);
  ok(req, 'Komentar diperbarui.'); res.redirect(req.get('referer') || '/admin/comments');
}));

// ---------- Users ----------
router.get('/users', requireRole('admin'), wrap(async (req, res) => {
  const rows = await q('SELECT u.*, (SELECT COUNT(*) FROM posts WHERE author_id = u.id AND type = "post") posts FROM users u ORDER BY u.id');
  res.render('admin/users', { title: 'Pengguna', rows });
}));
const userForm = wrap(async (req, res) => {
  const u = req.params.id ? await one('SELECT * FROM users WHERE id = ?', [req.params.id]) : { id: 0, username: '', email: '', display_name: '', bio: '', role: 'author' };
  if (!u) return res.redirect('/admin/users');
  res.render('admin/user-form', { title: u.id ? 'Edit pengguna' : 'Pengguna baru', u });
});
router.get('/users/new', requireRole('admin'), userForm);
router.get('/users/:id/edit', requireRole('admin'), userForm);
router.post('/users/save', requireRole('admin'), wrap(async (req, res) => {
  const b = req.body; const id = +b.id || 0;
  const username = String(b.username || '').trim().toLowerCase(); const email = String(b.email || '').trim();
  const role = ['admin', 'editor', 'author', 'contributor'].includes(b.role) ? b.role : 'author';
  const back = id ? `/admin/users/${id}/edit` : '/admin/users/new';
  if (!/^[a-z0-9]+([._-][a-z0-9]+)*$/.test(username) || username.length < 3 || username.length > 40 || !/^\S+@\S+\.\S+$/.test(email) || !b.display_name || (!id && String(b.password || '').length < 8) || (b.password && b.password.length < 8)) {
    err(req, 'Username (3-40 karakter: huruf kecil, angka, titik, strip, underscore), email valid, nama, dan password (min. 8 karakter) wajib diisi.'); return res.redirect(back);
  }
  const dup = await one('SELECT id FROM users WHERE (username = ? OR email = ?) AND id <> ?', [username, email, id]);
  if (dup) { err(req, 'Username atau email sudah dipakai.'); return res.redirect(back); }
  if (id === req.session.user.id && role !== 'admin') { err(req, 'Anda tidak dapat menurunkan peran sendiri.'); return res.redirect(back); }
  if (id) {
    await q('UPDATE users SET username=?, email=?, display_name=?, bio=?, role=? WHERE id=?', [username, email, b.display_name, b.bio || null, role, id]);
    if (b.password) await q('UPDATE users SET password = ? WHERE id = ?', [await bcrypt.hash(b.password, 10), id]);
  } else {
    await q('INSERT INTO users (username, email, password, display_name, bio, role) VALUES (?,?,?,?,?,?)', [username, email, await bcrypt.hash(b.password, 10), b.display_name, b.bio || null, role]);
  }
  ok(req, 'Pengguna tersimpan.'); res.redirect('/admin/users');
}));
router.post('/users/:id/delete', requireRole('admin'), wrap(async (req, res) => {
  const id = +req.params.id;
  if (id === req.session.user.id) { err(req, 'Tidak dapat menghapus akun sendiri.'); return res.redirect('/admin/users'); }
  const has = await one('SELECT COUNT(*) n FROM posts WHERE author_id = ?', [id]);
  if (has.n) await q('UPDATE posts SET author_id = ? WHERE author_id = ?', [req.session.user.id, id]);
  await q('DELETE FROM users WHERE id = ?', [id]); ok(req, 'Pengguna dihapus; konten dialihkan ke Anda.'); res.redirect('/admin/users');
}));

// ---------- Profile ----------
router.get('/profile', wrap(async (req, res) => {
  res.render('admin/profile', { title: 'Profil Saya', u: await one('SELECT * FROM users WHERE id = ?', [req.session.user.id]) });
}));
router.post('/profile', wrap(async (req, res) => {
  const b = req.body; const id = req.session.user.id;
  if (!b.display_name || !/^\S+@\S+\.\S+$/.test(b.email || '')) { err(req, 'Nama dan email valid wajib diisi.'); return res.redirect('/admin/profile'); }
  if (await one('SELECT id FROM users WHERE email = ? AND id <> ?', [b.email, id])) { err(req, 'Email sudah dipakai.'); return res.redirect('/admin/profile'); }
  await q('UPDATE users SET display_name=?, email=?, bio=? WHERE id=?', [b.display_name, b.email, b.bio || null, id]);
  if (b.password) {
    if (b.password.length < 8) { err(req, 'Password minimal 8 karakter.'); return res.redirect('/admin/profile'); }
    await q('UPDATE users SET password = ? WHERE id = ?', [await bcrypt.hash(b.password, 10), id]);
  }
  req.session.user.display_name = b.display_name; ok(req, 'Profil diperbarui.'); res.redirect('/admin/profile');
}));

// ---------- Menus ----------
router.get('/menus', requireRole('admin'), wrap(async (req, res) => {
  const items = await q('SELECT * FROM menu_items ORDER BY position, id');
  res.render('admin/menus', { title: 'Menu', primary: items.filter((i) => i.location === 'primary'), footer: items.filter((i) => i.location === 'footer') });
}));
router.post('/menus', requireRole('admin'), wrap(async (req, res) => {
  for (const loc of ['primary', 'footer']) {
    const labels = [].concat(req.body[`${loc}_label`] || []); const urls = [].concat(req.body[`${loc}_url`] || []);
    await q('DELETE FROM menu_items WHERE location = ?', [loc]);
    let pos = 0;
    for (let i = 0; i < labels.length; i++) {
      const label = String(labels[i]).trim().slice(0, 120); const url = String(urls[i] || '').trim().slice(0, 255);
      if (label && /^(\/|https?:\/\/)/.test(url)) await q('INSERT INTO menu_items (location, label, url, position) VALUES (?,?,?,?)', [loc, label, url, pos++]);
    }
  }
  ok(req, 'Menu disimpan.'); res.redirect('/admin/menus');
}));

// ---------- Themes & Plugins ----------
const ext = require('../extensions');
const zipUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(/\.zip$/i.test(file.originalname) ? null : new Error('Hanya file .zip'), /\.zip$/i.test(file.originalname)) });
const zipOne = (field) => (req, res, next) => zipUpload.single(field)(req, res, (e) => {
  if (e) { err(req, e.message); return res.redirect(req.baseUrl + req.path); }
  next();
});

router.get('/themes', requireRole('admin'), wrap(async (req, res) => {
  res.render('admin/themes', { title: 'Tema', themes: ext.listThemes(), active: ext.getActiveTheme() });
}));
router.post('/themes/upload', requireRole('admin'), zipOne('file'), wrap(async (req, res) => {
  if (!req.file) { err(req, 'Pilih file ZIP tema.'); return res.redirect('/admin/themes'); }
  try { const r = ext.installZip(req.file.buffer, 'theme'); ok(req, `Tema "${r.name}" terpasang.`); } catch (e) { err(req, e.message); }
  res.redirect('/admin/themes');
}));
router.post('/themes/:name/activate', requireRole('admin'), wrap(async (req, res) => {
  const name = req.params.name;
  if (name !== 'default' && !ext.listThemes().some((t) => t.slug === name)) { err(req, 'Tema tidak ditemukan.'); return res.redirect('/admin/themes'); }
  await ext.setTheme(name); ok(req, 'Tema diaktifkan.'); res.redirect('/admin/themes');
}));
router.post('/themes/:name/delete', requireRole('admin'), wrap(async (req, res) => {
  if (req.params.name === ext.getActiveTheme()) err(req, 'Tema aktif tidak dapat dihapus.');
  else { try { ext.remove('theme', req.params.name); ok(req, 'Tema dihapus.'); } catch (e) { err(req, e.message); } }
  res.redirect('/admin/themes');
}));

router.get('/plugins', requireRole('admin'), wrap(async (req, res) => {
  res.render('admin/plugins', { title: 'Plugin', plugins: ext.listPlugins(), active: await ext.getActivePlugins(), loaded: ext.getLoaded(), errors: ext.getErrors() });
}));
router.post('/plugins/upload', requireRole('admin'), zipOne('file'), wrap(async (req, res) => {
  if (!req.file) { err(req, 'Pilih file ZIP plugin.'); return res.redirect('/admin/plugins'); }
  try { const r = ext.installZip(req.file.buffer, 'plugin'); ok(req, `Plugin "${r.name}" terpasang. Aktifkan untuk menggunakannya.`); } catch (e) { err(req, e.message); }
  res.redirect('/admin/plugins');
}));
router.post('/plugins/:name/:action(activate|deactivate|delete)', requireRole('admin'), wrap(async (req, res) => {
  const { name, action } = req.params;
  if (!ext.listPlugins().some((p) => p.slug === name)) { err(req, 'Plugin tidak ditemukan.'); return res.redirect('/admin/plugins'); }
  let active = await ext.getActivePlugins();
  if (action === 'activate') { active = [...new Set([...active, name])]; await ext.setActivePlugins(active); ok(req, ext.getErrors()[name] ? `Gagal memuat: ${ext.getErrors()[name]}` : 'Plugin diaktifkan.'); if (ext.getErrors()[name]) { await ext.setActivePlugins(active.filter((n) => n !== name)); req.session.flash.type = 'error'; } }
  if (action === 'deactivate') { await ext.setActivePlugins(active.filter((n) => n !== name)); ok(req, 'Plugin dinonaktifkan.'); }
  if (action === 'delete') {
    if (active.includes(name)) await ext.setActivePlugins(active.filter((n) => n !== name));
    try { ext.remove('plugin', name); ok(req, 'Plugin dihapus.'); } catch (e) { err(req, e.message); }
  }
  res.redirect('/admin/plugins');
}));
router.use('/x/:slug', requireRole('admin'), ext.adminDispatch);

// ---------- Settings ----------
router.get('/settings', requireRole('admin'), wrap(async (req, res) => res.render('admin/settings', { title: 'Pengaturan', s: await getSettings() })));
router.post('/settings', requireRole('admin'), wrap(async (req, res) => {
  const b = req.body;
  const data = {};
  for (const k of ['site_title', 'tagline', 'site_description', 'footer_text', 'facebook', 'twitter', 'instagram', 'youtube']) data[k] = String(b[k] || '').slice(0, 500);
  data.logo = /^[\w.-]*$/.test(b.logo || '') ? b.logo : '';
  data.posts_per_page = String(Math.max(1, Math.min(50, +b.posts_per_page || 10)));
  data.comments_enabled = b.comments_enabled ? '1' : '0';
  data.comments_moderation = b.comments_moderation ? '1' : '0';
  data.allow_registration = b.allow_registration ? '1' : '0';
  data.default_role = ['contributor', 'author'].includes(b.default_role) ? b.default_role : 'contributor';
  await saveSettings(data); ok(req, 'Pengaturan disimpan.'); res.redirect('/admin/settings');
}));

module.exports = router;
