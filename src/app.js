require('dotenv').config();
const path = require('path');
const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const helmet = require('helmet');
const compression = require('compression');
const { pool, q } = require('./db');
const { csrf, can } = require('./auth');
const util = require('./util');
const ext = require('./extensions');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.set('trust proxy', 1);
app.use(expressLayouts);
app.set('layout', 'layouts/public');

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
      imgSrc: ["'self'", 'data:', 'https:'],
      fontSrc: ["'self'", 'data:', 'https://cdn.jsdelivr.net'],
      frameSrc: ['https://www.youtube.com', 'https://www.youtube-nocookie.com', 'https://player.vimeo.com'],
      upgradeInsecureRequests: null,
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(compression());
app.use(express.urlencoded({ extended: true, limit: '2mb' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '7d' }));

app.use(session({
  name: 'cms.sid',
  secret: process.env.SESSION_SECRET || 'dev-secret',
  resave: false,
  saveUninitialized: false,
  store: new MySQLStore({ createDatabaseTable: true }, pool),
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 7, secure: 'auto' },
}));
app.use(csrf);

app.use(async (req, res, next) => {
  try {
    // EJS reads app-level "views" from locals.settings; ours shadows Express's, so expose the (theme-aware) view dirs on it.
    res.locals.settings = Object.defineProperty({ ...(await util.getSettings()) }, 'views', { value: app.get('views'), enumerable: false });
    res.locals.currentUser = req.session.user || null;
    res.locals.can = (role) => can(req.session.user, role);
    Object.assign(res.locals, util, ext.locals(), { siteUrl: process.env.SITE_URL || `${req.protocol}://${req.get('host')}`, flash: req.session.flash || null, currentPath: req.path });
    delete req.session.flash;
    next();
  } catch (e) { next(e); }
});

app.use('/themes/:name/assets', ext.themeAssets);
app.use('/admin', require('./routes/admin'));
app.use('/p/:slug', ext.publicDispatch);
app.use('/', require('./routes/public'));

app.use((req, res) => res.status(404).render('public/404', { title: 'Halaman tidak ditemukan', seo: {} }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return;
  res.status(err.status || 500);
  if (err.code === 'LIMIT_FILE_SIZE') return res.json({ error: 'File terlalu besar (maks 5MB)' });
  res.type('text').send('Terjadi kesalahan pada server.');
});

const port = process.env.PORT || 3000;
q('SELECT 1').then(() => ext.init(app)).then(() => app.listen(port, () => console.log(`CMS berjalan di http://localhost:${port}`)))
  .catch((e) => { console.error('Gagal konek database. Jalankan: npm run migrate\n', e.message); process.exit(1); });
