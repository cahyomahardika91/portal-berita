# CMS Berita (Node.js + Express + MySQL)

CMS portal berita sederhana ala WordPress.

## Menjalankan
1. Pastikan MySQL/MariaDB aktif. Salin `.env.example` ke `.env` dan sesuaikan.
2. `npm install`
3. `npm run migrate` (membuat database, tabel, dan data contoh)
4. `npm start` → http://localhost:3000 — admin: http://localhost:3000/admin (default `admin` / `admin123`, **segera ganti**).

## Fitur
- Berita & Halaman: draft / menunggu review / terbit / terjadwal / sampah, revisi, berita utama (headline), SEO meta, permalink, pratinjau
- Editor WYSIWYG (Quill) dengan pustaka media; kategori, tag, gambar utama
- Media library (validasi tipe & signature file), komentar + moderasi + anti-spam honeypot
- Peran: admin, editor, author, contributor
- Menu (header/footer), pengaturan situs, profil, manajemen pengguna
- Publik: beranda headline, arsip kategori/tag/penulis, pencarian, berita terkait, terpopuler, RSS `/feed`, `/sitemap.xml`, `/robots.txt`
- Keamanan: bcrypt, CSRF, helmet/CSP, rate limit login & komentar, sanitasi HTML
- Pendaftaran publik (`/register`): diaktifkan di Admin → Pengaturan, dengan peran default Kontributor/Penulis
- Tema & plugin: Admin → Tema / Plugin (pasang lewat ZIP, aktifkan, hapus)

## Membuat tema
Folder `themes/<nama>/` berisi `theme.json` (`name`, `version`, `author`, `description`), `assets/style.css` (otomatis dimuat setelah CSS bawaan; aset di `/themes/<nama>/assets/`), dan opsional `views/` yang menimpa template bawaan dengan path yang sama (mis. `views/public/home.ejs`, `views/layouts/public.ejs`). Partial di-include dengan `include('public/_card')` sehingga dapat ditimpa juga.

## Membuat plugin
Folder `plugins/<nama>/` berisi `plugin.json` (`name`, `version`, `description`, `main`) dan `index.js`:
```js
module.exports = (api) => {
  api.on('head', () => '<meta name="x" content="y">');      // juga 'body_end'
  api.on('content', (html, post) => html + '<p>…</p>');     // filter isi artikel
  api.router.get('/halo', (req, res) => res.send('hi'));     // /p/<nama>/halo
  api.adminRouter.get('/', (req, res) => api.adminPage(res, 'Judul', '<p>…</p>')); // /admin/x/<nama>/
  api.addAdminLink('Plugin Saya');
  // api.q(sql, params) / api.one(sql, params) untuk database
};
```
Contoh: `themes/dark`, `plugins/reading-time`. Tema/plugin dijalankan di server dengan akses penuh; pasang hanya dari sumber tepercaya.
