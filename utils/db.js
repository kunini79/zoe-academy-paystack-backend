// zoe-academy-paystack-backend/utils/db.js
const { Pool } = require('pg');

// Initialize the PostgreSQL connection pool using environment variables
const pool = new Pool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT,
    ssl: {
        rejectUnauthorized: false // Required for Render/Vercel to Supabase connection
    }
});

// Basic check for database connection on module load
pool.query('SELECT NOW()')
    .then(res => console.log('Successfully connected to Supabase PostgreSQL database from utility!', res.rows[0]))
    .catch(err => console.error('Failed to connect to Supabase PostgreSQL database from utility:', err.message));

module.exports = pool; // Export the connection pool for use in other files