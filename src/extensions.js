const fs = require('fs');
const path = require('path');
const express = require('express');
const AdmZip = require('adm-zip');
const ejs = require('ejs');
const db = require('./db');
const util = require('./util');

const ROOT = path.join(__dirname, '..');
const THEMES_DIR = path.join(ROOT, 'themes');
const PLUGINS_DIR = path.join(ROOT, 'plugins');
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,59}$/;
const MAX_ZIP_ENTRIES = 3000;
const MAX_UNZIPPED = 50 * 1024 * 1024;
fs.mkdirSync(THEMES_DIR, { recursive: true });
fs.mkdirSync(PLUGINS_DIR, { recursive: true });

let appRef = null;
let hooks = {};
let pluginRouters = {};
let adminRouters = {};
let adminLinks = [];
let loaded = [];
let errors = {};
let activeTheme = 'default';

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; } };

function listDir(base, manifestName) {
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory() && NAME_RE.test(d.name))
    .map((d) => {
      const m = readJson(path.join(base, d.name, manifestName));
      return m ? { slug: d.name, name: m.name || d.name, version: m.version || '', author: m.author || '', description: m.description || '' } : null;
    })
    .filter(Boolean);
}
const listThemes = () => listDir(THEMES_DIR, 'theme.json');
const listPlugins = () => listDir(PLUGINS_DIR, 'plugin.json');

const themeExists = (name) => name === 'default' || fs.existsSync(path.join(THEMES_DIR, name, 'theme.json'));

function applyTheme(name) {
  activeTheme = name !== 'default' && NAME_RE.test(name) && themeExists(name) ? name : 'default';
  const dirs = [];
  if (activeTheme !== 'default') dirs.push(path.join(THEMES_DIR, activeTheme, 'views'));
  dirs.push(path.join(ROOT, 'views'));
  appRef.set('views', dirs);
  appRef.cache = {};
  ejs.clearCache();
}

// ---------- Plugins ----------
function clearRequireCache(dir) {
  Object.keys(require.cache).forEach((k) => { if (k.startsWith(dir + path.sep)) delete require.cache[k]; });
}

function loadPlugins(names) {
  hooks = {}; pluginRouters = {}; adminRouters = {}; adminLinks = []; loaded = []; errors = {};
  for (const name of names) {
    if (!NAME_RE.test(name)) continue;
    const dir = path.join(PLUGINS_DIR, name);
    const manifest = readJson(path.join(dir, 'plugin.json'));
    if (!manifest) { errors[name] = 'plugin.json tidak ditemukan'; continue; }
    try {
      clearRequireCache(dir);
      const init = require(path.join(dir, manifest.main || 'index.js'));
      const router = express.Router();
      const admin = express.Router();
      const api = {
        slug: name, dir, q: db.q, one: db.one, getSettings: util.getSettings, util,
        router, adminRouter: admin,
        on(hook, fn, priority = 10) { (hooks[hook] = hooks[hook] || []).push({ fn, priority, owner: name }); hooks[hook].sort((a, b) => a.priority - b.priority); },
        addAdminLink(label) { adminLinks.push({ label, url: `/admin/x/${name}/` }); },
        adminPage(res, title, html) { res.render('admin/plugin-page', { title, html }); },
      };
      (typeof init === 'function' ? init : init.default)(api);
      pluginRouters[name] = router; adminRouters[name] = admin; loaded.push(name);
    } catch (e) {
      console.error(`[plugin:${name}]`, e);
      errors[name] = e.message;
      Object.keys(hooks).forEach((h) => { hooks[h] = hooks[h].filter((x) => x.owner !== name); });
    }
  }
}

const emit = (name, ctx) => (hooks[name] || []).map((h) => { try { return h.fn(ctx) || ''; } catch (e) { console.error('[hook]', name, e); return ''; } }).join('\n');
const filter = (name, value, ctx) => (hooks[name] || []).reduce((v, h) => { try { const r = h.fn(v, ctx); return r === undefined ? v : r; } catch (e) { console.error('[filter]', name, e); return v; } }, value);

const dispatch = (getMap) => (req, res, next) => {
  const r = getMap()[req.params.slug];
  return r ? r(req, res, next) : next();
};
const publicDispatch = dispatch(() => pluginRouters);
const adminDispatch = dispatch(() => adminRouters);

async function init(app) {
  appRef = app;
  const s = await util.getSettings();
  applyTheme(s.active_theme || 'default');
  let names = [];
  try { names = JSON.parse(s.active_plugins || '[]'); } catch (e) { names = []; }
  loadPlugins(names.filter((n) => typeof n === 'string'));
}

const getActivePlugins = async () => { try { return JSON.parse((await util.getSettings()).active_plugins || '[]'); } catch (e) { return []; } };

async function setActivePlugins(names) {
  await util.saveSettings({ active_plugins: JSON.stringify(names) });
  loadPlugins(names);
}
async function setTheme(name) {
  await util.saveSettings({ active_theme: name });
  applyTheme(name);
}

function locals() {
  const css = activeTheme !== 'default' && fs.existsSync(path.join(THEMES_DIR, activeTheme, 'assets', 'style.css'));
  return {
    hook: emit, filter,
    themeUrl: activeTheme === 'default' ? '' : `/themes/${activeTheme}/assets`,
    themeCss: css ? `/themes/${activeTheme}/assets/style.css` : '',
    pluginAdminLinks: adminLinks,
  };
}

function themeAssets(req, res, next) {
  if (!NAME_RE.test(req.params.name)) return next();
  express.static(path.join(THEMES_DIR, req.params.name, 'assets'), { maxAge: '1d', fallthrough: true })(req, res, next);
}

// ---------- ZIP installation ----------
function installZip(buffer, kind) {
  const isTheme = kind === 'theme';
  const manifestName = isTheme ? 'theme.json' : 'plugin.json';
  const base = isTheme ? THEMES_DIR : PLUGINS_DIR;
  let zip;
  try { zip = new AdmZip(buffer); } catch (e) { throw new Error('File ZIP tidak valid.'); }
  const entries = zip.getEntries().filter((e) => !e.entryName.startsWith('__MACOSX/'));
  if (entries.length > MAX_ZIP_ENTRIES) throw new Error('ZIP berisi terlalu banyak file.');
  let total = 0;
  for (const e of entries) {
    total += e.header.size;
    const n = e.entryName.replace(/\\/g, '/');
    if (n.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(n) || /^[a-zA-Z]:/.test(n)) throw new Error('ZIP berisi path berbahaya.');
  }
  if (total > MAX_UNZIPPED) throw new Error('Ukuran hasil ekstrak terlalu besar (maks 50MB).');

  const mEntry = entries
    .filter((e) => !e.isDirectory && path.posix.basename(e.entryName) === manifestName && e.entryName.split('/').length <= 2)
    .sort((a, b) => a.entryName.length - b.entryName.length)[0];
  if (!mEntry) throw new Error(`${manifestName} tidak ditemukan di ZIP.`);
  let manifest;
  try { manifest = JSON.parse(mEntry.getData().toString('utf8')); } catch (e) { throw new Error(`${manifestName} bukan JSON valid.`); }
  if (!manifest.name) throw new Error('Manifest harus memiliki "name".');
  const prefix = mEntry.entryName.slice(0, mEntry.entryName.length - manifestName.length);
  const slug = util.slug(manifest.slug || manifest.name);
  if (!NAME_RE.test(slug)) throw new Error('Nama ekstensi tidak valid.');
  const dest = path.join(base, slug);
  if (fs.existsSync(dest)) throw new Error(`"${slug}" sudah terpasang. Hapus dahulu untuk memasang ulang.`);

  const files = entries.filter((e) => e.entryName.startsWith(prefix));
  if (isTheme && !files.some((e) => e.entryName.startsWith(`${prefix}views/`) || e.entryName.startsWith(`${prefix}assets/`))) throw new Error('Tema harus memiliki folder views/ atau assets/.');
  if (!isTheme && !files.some((e) => e.entryName === `${prefix}${manifest.main || 'index.js'}`)) throw new Error('File utama plugin (index.js) tidak ditemukan.');

  try {
    for (const e of files) {
      const rel = e.entryName.slice(prefix.length);
      if (!rel) continue;
      const target = path.resolve(dest, rel);
      if (target !== dest && !target.startsWith(dest + path.sep)) throw new Error('ZIP berisi path berbahaya.');
      if (e.isDirectory) { fs.mkdirSync(target, { recursive: true }); continue; }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, e.getData());
    }
  } catch (e) {
    fs.rmSync(dest, { recursive: true, force: true });
    throw e;
  }
  return { slug, name: manifest.name };
}

function remove(kind, name) {
  if (!NAME_RE.test(name)) throw new Error('Nama tidak valid.');
  const dir = path.join(kind === 'theme' ? THEMES_DIR : PLUGINS_DIR, name);
  if (!fs.existsSync(dir)) throw new Error('Tidak ditemukan.');
  fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = {
  init, listThemes, listPlugins, setTheme, setActivePlugins, getActivePlugins, installZip, remove,
  emit, filter, locals, themeAssets, publicDispatch, adminDispatch,
  getActiveTheme: () => activeTheme, getLoaded: () => loaded, getErrors: () => errors, NAME_RE,
};
