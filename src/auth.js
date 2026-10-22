const crypto = require('crypto');

const LEVEL = { contributor: 1, author: 2, editor: 3, admin: 4 };

function requireLogin(req, res, next) {
  if (!req.session.user) {
    req.session.returnTo = req.originalUrl;
    return res.redirect('/admin/login');
  }
  next();
}
const requireRole = (role) => (req, res, next) => {
  if (!req.session.user || LEVEL[req.session.user.role] < LEVEL[role]) {
    return res.status(403).render('admin/error', { layout: 'layouts/admin', title: 'Akses ditolak', message: 'Anda tidak memiliki izin untuk halaman ini.' });
  }
  next();
};
const can = (user, role) => !!user && LEVEL[user.role] >= LEVEL[role];

function csrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrfToken = req.session.csrf;
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const token = (req.body && req.body._csrf) || req.get('x-csrf-token') || req.query._csrf;
  if (token && token.length === req.session.csrf.length &&
      crypto.timingSafeEqual(Buffer.from(token), Buffer.from(req.session.csrf))) return next();
  res.status(403).send('Token keamanan tidak valid. Muat ulang halaman dan coba lagi.');
}

module.exports = { requireLogin, requireRole, can, csrf };
