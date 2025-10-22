require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const { Pool } = require('pg');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Inisialisasi Koneksi Database NeonDB
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false
    }
});

// Inisialisasi Supabase Client (untuk Server-Side Delete yang AMAN)
const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY 
);

// Middleware
// Kembalikan limit ke 10mb, cukup untuk thumbnail Base64
app.use(express.json({ limit: '10mb' })); 
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser(process.env.COOKIE_SECRET));
app.use(express.static('public'));

// == FUNGSI SQL UNTUK DATABASE ==
const createTable = async () => {
    const query = `
        CREATE TABLE IF NOT EXISTS books (
            id SERIAL PRIMARY KEY,
            title VARCHAR(255) NOT NULL,
            description TEXT,
            thumbnail_base64 TEXT,
            pdf_url VARCHAR(1024) NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
    `;
    try {
        await pool.query(query);
        console.log("Tabel 'books' berhasil disiapkan.");
    } catch (err) {
        console.error("Error membuat tabel:", err);
    }
};

// == MIDDLEWARE AUTENTIKASI ==
const authMiddleware = (req, res, next) => {
    const sessionToken = req.cookies.session;
    if (sessionToken === 'admin_logged_in') {
        return next();
    }
    const isApiRequest =
        req.xhr ||
        req.headers.accept?.includes('application/json') ||
        req.path.startsWith('/api/');

    if (isApiRequest) {
        return res.status(401).json({
            success: false,
            message: 'Akses ditolak. Silakan login terlebih dahulu.',
        });
    } else {
        return res.redirect('/login');
    }
};

// == HALAMAN STATIS ==
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.get('/dashboard', authMiddleware, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// == AUTHENTICATION API ROUTES ==
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
        res.cookie('session', 'admin_logged_in', {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            maxAge: 5 * 24 * 60 * 60 * 1000 // 5 hari
        });
        res.json({ success: true, message: 'Login berhasil' });
    } else {
        res.status(401).json({ success: false, message: 'Username atau password salah' });
    }
});
app.post('/api/logout', (req, res) => {
    res.clearCookie('session');
    res.json({ success: true, message: 'Logout berhasil' });
});
app.get('/api/check-auth', authMiddleware, (req, res) => {
    res.json({ success: true, message: 'Autentikasi valid' });
});

// == PUBLIC API ROUTES (Untuk index.html) ==
app.get('/api/public/books', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, title, description, thumbnail_base64, pdf_url FROM books ORDER BY created_at DESC'
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// == PROTECTED CRUD API ROUTES (Untuk dashboard.html) ==

// [GET] /api/books (Pagination)
app.get('/api/books', authMiddleware, async (req, res) => {
    // (Tidak ada perubahan di sini, kode Anda sudah benar)
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 5;
    const offset = (page - 1) * limit;
    try {
        const booksQuery = await pool.query(
            'SELECT * FROM books ORDER BY created_at DESC LIMIT $1 OFFSET $2',
            [limit, offset]
        );
        const totalQuery = await pool.query('SELECT COUNT(*) FROM books');
        const totalBooks = parseInt(totalQuery.rows[0].count);
        const totalPages = Math.ceil(totalBooks / limit);
        res.json({
            books: booksQuery.rows,
            pagination: {
                currentPage: page,
                totalPages: totalPages,
                totalBooks: totalBooks
            }
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

// [POST] /api/books (Create)
// DISEDERHANAKAN: Server hanya menerima URL, tidak lagi meng-upload.
app.post('/api/books', authMiddleware, async (req, res) => {
    // Client sekarang MENGIRIM pdf_url, bukan pdf_base64
    const { title, description, thumbnail_base64, pdf_url } = req.body;
    
    if (!title || !thumbnail_base64 || !pdf_url) {
        return res.status(400).json({ success: false, message: 'Data tidak lengkap' });
    }

    try {
        // Langsung simpan ke NeonDB
        await pool.query(
            'INSERT INTO books (title, description, thumbnail_base64, pdf_url) VALUES ($1, $2, $3, $4)',
            [title, description, thumbnail_base64, pdf_url]
        );
        
        res.status(201).json({ success: true, message: 'Buku berhasil ditambahkan' });
    } catch (err) {
        console.error("Error saat POST /api/books:", err);
        res.status(500).json({ success: false, message: err.message || 'Server error' });
    }
});

// [PUT] /api/books/:id (Update)
// DISESUAIKAN: Server menangani penghapusan file lama jika ada.
app.put('/api/books/:id', authMiddleware, async (req, res) => {
    const { id } = req.params;
    // Client mengirim:
    // - pdf_url: URL baru (atau URL lama jika tidak diubah)
    // - old_pdf_url: (Opsional) URL lama yang harus dihapus jika PDF diganti
    const { title, description, thumbnail_base64, pdf_url, old_pdf_url } = req.body;

    try {
        // 1. Update database NeonDB dengan data baru
        await pool.query(
            'UPDATE books SET title = $1, description = $2, thumbnail_base64 = $3, pdf_url = $4 WHERE id = $5',
            [title, description, thumbnail_base64, pdf_url, id]
        );

        // 2. Hapus file PDF lama dari Supabase jika ada (old_pdf_url diisi oleh client)
        if (old_pdf_url && old_pdf_url !== pdf_url) {
            try {
                const oldFilePath = new URL(old_pdf_url).pathname.split('/ebook-pdf/')[1];
                if (oldFilePath) {
                    await supabaseAdmin.storage.from('ebook-pdf').remove([oldFilePath]);
                }
            } catch (rmErr) {
                // Jangan gagalkan seluruh proses jika hanya hapus file lama yg gagal
                console.warn("Gagal hapus file lama di Supabase:", rmErr.message);
            }
        }
        
        res.json({ success: true, message: 'Buku berhasil diperbarui' });
    } catch (err) {
        console.error("Error saat PUT /api/books:", err);
        res.status(500).json({ success: false, message: err.message || 'Server error' });
    }
});


// [DELETE] /api/books/:id (Delete)
// (Tidak ada perubahan, kode Anda sudah benar dan aman)
app.delete('/api/books/:id', authMiddleware, async (req, res) => {
    const { id } = req.params;
    let client;
    try {
        client = await pool.connect();
        await client.query('BEGIN');

        const bookQuery = await client.query('SELECT pdf_url FROM books WHERE id = $1', [id]);
        if (bookQuery.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, message: 'Buku tidak ditemukan' });
        }
        
        const { pdf_url } = bookQuery.rows[0];
        await client.query('DELETE FROM books WHERE id = $1', [id]);

        try {
            const filePath = new URL(pdf_url).pathname.split('/ebook-pdf/')[1];
            if (filePath) {
                await supabaseAdmin.storage.from('ebook-pdf').remove([filePath]);
            }
        } catch (storageErr) {
            console.warn("Gagal hapus file Supabase (DB sudah dihapus):", storageErr.message);
        }

        await client.query('COMMIT');
        res.json({ success: true, message: 'Buku berhasil dihapus' });
    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error(err);
        res.status(500).json({ success: false, message: 'Server error saat menghapus' });
    } finally {
        if (client) client.release();
    }
});


// Start Server
app.listen(PORT, async () => {
    await createTable(); 
    console.log(`Server berjalan di http://localhost:${PORT}`);
});