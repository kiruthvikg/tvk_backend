const express = require('express');
const mysql = require('mysql2/promise');
const bodyParser = require('body-parser');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs-extra');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
// Configure multer for multiple file types
// Configure storage// Configure Multer for file uploads
const storage = multer.diskStorage({
    destination: 'uploads/',
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname);
      const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1E9)}${ext}`;
      cb(null, uniqueName);
    }
  });
  
  const upload = multer({
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB
  }).any(); // Accept any file field name
  
  // Ensure upload directory exists
  fs.ensureDir('uploads').catch(err => console.error('Upload directory error:', err));
  

// Database connection
const pool = mysql.createPool({
  host: 'localhost',
  user: 'root', // replace with your MySQL username
  password: 'root', // replace with your MySQL password
  database: 'complaint_system',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// API Routes


  
app.post('/api/complaints', (req, res) => {
  upload(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ 
        success: false, 
        message: err instanceof multer.MulterError 
          ? err.message 
          : 'File upload error'
      });
    }

    try {
      const {
        fullName = null,
        age = null,
        voterNumber = null,
        gender = null,
        categories = null,
      } = req.body;
      const files = req.files || [];

      const connection = await pool.getConnection();
      await connection.beginTransaction();

      try {
        // Insert user (allowing nulls)
        const [userResult] = await connection.execute(
          'INSERT INTO users (full_name, age, voter_number, gender) VALUES (?, ?, ?, ?)',
          [fullName || null, age || null, voterNumber || null, gender || null]
        );
        const userId = userResult.insertId;

        // Insert complaint (category can be null or empty)
        const [complaintResult] = await connection.execute(
          'INSERT INTO complaints (user_id, category) VALUES (?, ?)',
          [userId, categories || null]
        );
        const complaintId = complaintResult.insertId;

        // Process all uploaded files
        for (const file of files) {
          await connection.execute(
            'INSERT INTO complaint_media (complaint_id, file_path, file_type) VALUES (?, ?, ?)',
            [complaintId, file.filename, file.fieldname]
          );
        }

        await connection.commit();
        connection.release();

        res.status(201).json({
          success: true,
          message: 'Complaint submitted successfully',
          complaintId
        });
      } catch (error) {
        await connection.rollback();
        connection.release();
        throw error;
      }
    } catch (error) {
      console.error('Error:', error);
      res.status(500).json({ 
        success: false, 
        message: 'Failed to submit complaint',
        error: error.message
      });
    }
  });
});

  app.get('/api/complaints', async (req, res) => {
    try {
        // Get pagination parameters from query string (default to page 1 and 10 items per page)
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 100;
        const offset = (page - 1) * limit;

        // First query to get the paginated complaints
        const [complaints] = await pool.query(`
            SELECT c.*, u.full_name, u.age, u.voter_number, u.gender 
            FROM complaints c
            LEFT JOIN users u ON c.user_id = u.id
            ORDER BY c.created_at DESC
            LIMIT ? OFFSET ?
        `, [limit, offset]);

        // Second query to get the total count for pagination metadata
        const [totalCount] = await pool.query(`
            SELECT COUNT(*) as total FROM complaints
        `);
        const total = totalCount[0].total;
        const totalPages = Math.ceil(total / limit);

        // Fetch media for each complaint
        for (const complaint of complaints) {
            const [media] = await pool.query(
                'SELECT id, file_path, file_type FROM complaint_media WHERE complaint_id = ?',
                [complaint.id]
            );
            complaint.media = media;
        }

        res.json({ 
            success: true, 
            data: complaints,
            pagination: {
                total,
                totalPages,
                currentPage: page,
                limit,
                hasNextPage: page < totalPages,
                hasPrevPage: page > 1
            }
        });
    } catch (error) {
        console.error('Error fetching complaints:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Failed to fetch complaints',
            error: error.message
        });
    }
});

// Get single complaint
app.get('/api/complaints/:id', async (req, res) => {
    try {
      const [complaints] = await pool.query(`
        SELECT c.*, u.full_name, u.age, u.voter_number, u.gender 
        FROM complaints c
        LEFT JOIN users u ON c.user_id = u.id
        WHERE c.id = ?
      `, [req.params.id]);
  
      if (complaints.length === 0) {
        return res.status(404).json({ success: false, message: 'Complaint not found' });
      }
  
      const complaint = complaints[0];
      const [media] = await pool.query(
        'SELECT id, file_path, file_type FROM complaint_media WHERE complaint_id = ?',
        [complaint.id]
      );
      complaint.media = media;
  
      res.json({ success: true, data: complaint });
    } catch (error) {
      console.error('Error fetching complaint:', error);
      res.status(500).json({ success: false, message: 'Failed to fetch complaint' });
    }
  });




// Delete a complaint
app.delete('/api/complaints/:id', async (req, res) => {
    try {
      const connection = await pool.getConnection();
      await connection.beginTransaction();
  
      try {
        // First get media files to delete them from filesystem
        const [mediaFiles] = await connection.query(
          'SELECT file_path FROM complaint_media WHERE complaint_id = ?',
          [req.params.id]
        );
  
        // Delete related media records first
        await connection.execute(
          'DELETE FROM complaint_media WHERE complaint_id = ?',
          [req.params.id]
        );
  
        // Now delete the complaint
        const [result] = await connection.execute(
          'DELETE FROM complaints WHERE id = ?',
          [req.params.id]
        );
  
        if (result.affectedRows === 0) {
          await connection.rollback();
          connection.release();
          return res.status(404).json({ success: false, message: 'Complaint not found' });
        }
  
        await connection.commit();
        connection.release();
  
        // Delete media files from filesystem
        for (const file of mediaFiles) {
          const filePath = path.join('uploads', file.file_path);
          try {
            await fs.unlink(filePath);
          } catch (err) {
            console.error('Error deleting file:', err);
          }
        }
  
        res.json({ success: true, message: 'Complaint deleted successfully' });
      } catch (error) {
        await connection.rollback();
        connection.release();
        throw error;
      }
    } catch (error) {
      console.error('Error deleting complaint:', error);
      res.status(500).json({ 
        success: false, 
        message: 'Failed to delete complaint',
        error: error.message
      });
    }
  });

  
  
  // Get audio file
app.get('/api/audios/:filename', (req, res) => {
    const filePath = path.join(__dirname, 'uploads', req.params.filename);
    
    if (fs.existsSync(filePath)) {
      res.sendFile(filePath);
    } else {
      res.status(404).json({ success: false, message: 'Audio file not found' });
    }
  });
  
  // Error handling middleware
  app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ success: false, message: 'Something broke!' });
  });
  
  

// REGISTER API
app.post('/api/register', async (req, res) => {
  const { fullName, age, gender, email, password } = req.body;

  if (!fullName || !age || !gender || !email || !password) {
    return res.status(400).json({ success: false, message: 'All fields are required' });
  }

  try {
    const connection = await pool.getConnection();

    const [existingUser] = await connection.execute(
      'SELECT * FROM register_users WHERE email = ?',
      [email]
    );

    if (existingUser.length > 0) {
      connection.release();
      return res.status(409).json({ success: false, message: 'Email already registered' });
    }

    await connection.execute(
      'INSERT INTO register_users (full_name, age, gender, email, password) VALUES (?, ?, ?, ?, ?)',
      [fullName, age, gender, email, password]
    );

    connection.release();
    res.status(201).json({ success: true, message: 'User registered successfully' });

  } catch (error) {
    console.error('Register error:', error);
    res.status(500).json({ success: false, message: 'Registration failed' });
  }
});

// LOGIN API
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Email and password are required' });
  }

  try {
    const connection = await pool.getConnection();

    const [users] = await connection.execute(
      'SELECT * FROM register_users WHERE email = ? AND password = ?',
      [email, password]
    );

    connection.release();

    if (users.length === 0) {
      return res.status(401).json({ success: false, message: 'Invalid email or password' });
    }

    const user = users[0];
    res.status(200).json({
      success: true,
      message: 'Login successful',
      user: {
        id: user.id,
        fullName: user.full_name,
        email: user.email,
        gender: user.gender,
        age: user.age
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, message: 'Login failed' });
  }
});



// Category-wise complaints search

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ success: false, message: 'Something broke!' });
});

// Start server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});