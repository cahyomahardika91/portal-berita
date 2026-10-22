require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

(async () => {
  const dbName = process.env.DB_NAME || 'cms_node';
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1', port: +(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root', password: process.env.DB_PASS || '', multipleStatements: true, charset: 'utf8mb4',
  });
  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await conn.query(`USE \`${dbName}\``);
  await conn.query(fs.readFileSync(path.join(__dirname, '..', 'sql', 'schema.sql'), 'utf8'));
  console.log('Schema OK');

  const [[{ n }]] = await conn.query('SELECT COUNT(*) n FROM users');
  if (n === 0) {
    const hash = await bcrypt.hash(process.env.ADMIN_PASS || 'admin123', 10);
    const [r] = await conn.query('INSERT INTO users (username,email,password,display_name,role) VALUES (?,?,?,?,?)',
      [process.env.ADMIN_USER || 'admin', process.env.ADMIN_EMAIL || 'admin@example.com', hash, 'Administrator', 'admin']);
    const uid = r.insertId;
    const cats = [['Marketing', 'marketing'], ['Branding', 'branding'], ['Digital', 'digital'], ['Bisnis', 'bisnis'], ['Tokoh', 'tokoh'], ['Event', 'event']];
    for (const [name, slug] of cats) await conn.query('INSERT INTO categories (name, slug) VALUES (?,?)', [name, slug]);
    await conn.query('INSERT INTO tags (name, slug) VALUES (?,?),(?,?)', ['Strategi', 'strategi', 'Tren', 'tren']);
    const posts = [
      ['Selamat Datang di Portal Berita', 'selamat-datang', 'Artikel pertama Anda. Edit atau hapus melalui dashboard admin.', 1, 1],
      ['Tren Digital Marketing yang Perlu Dipantau', 'tren-digital-marketing', 'Ringkasan tren pemasaran digital terbaru untuk pelaku bisnis.', 3, 1],
      ['Membangun Brand yang Kuat di Era Media Sosial', 'membangun-brand-kuat', 'Strategi branding agar merek Anda diingat konsumen.', 2, 0],
    ];
    for (const [title, slug, ex, cat, feat] of posts) {
      const [p] = await conn.query(
        'INSERT INTO posts (type,title,slug,excerpt,content,status,is_featured,author_id,published_at) VALUES ("post",?,?,?,?,"published",?,?,NOW())',
        [title, slug, ex, `<p>${ex}</p><p>Ini adalah konten contoh. Silakan ganti dengan berita Anda.</p>`, feat, uid]);
      await conn.query('INSERT INTO post_categories VALUES (?,?)', [p.insertId, cat]);
    }
    await conn.query('INSERT INTO posts (type,title,slug,content,status,author_id,published_at) VALUES ("page","Tentang Kami","tentang-kami","<p>Halaman tentang kami.</p>","published",?,NOW()),("page","Kontak","kontak","<p>Hubungi kami di redaksi@example.com</p>","published",?,NOW())', [uid, uid]);
    const menu = [['primary', 'Beranda', '/', 0], ['primary', 'Marketing', '/category/marketing', 1], ['primary', 'Branding', '/category/branding', 2],
      ['primary', 'Digital', '/category/digital', 3], ['primary', 'Bisnis', '/category/bisnis', 4], ['primary', 'Tokoh', '/category/tokoh', 5],
      ['footer', 'Tentang Kami', '/tentang-kami', 0], ['footer', 'Kontak', '/kontak', 1]];
    for (const m of menu) await conn.query('INSERT INTO menu_items (location,label,url,position) VALUES (?,?,?,?)', m);
    console.log('Seed OK. Login: ' + (process.env.ADMIN_USER || 'admin') + ' / ' + (process.env.ADMIN_PASS || 'admin123'));
  }
  await conn.end();
})().catch((e) => { console.error(e); process.exit(1); });
