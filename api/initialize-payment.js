// zoe-academy-paystack-backend/api/initialize-payment.js
// This file handles POST requests to /api/initialize-payment

const pool = require('../utils/db'); // Import the database connection pool
const axios = require('axios');
const cors = require('cors'); // Vercel functions handle CORS, but explicit can help for clarity.

// Vercel serverless functions export a default handler function.
module.exports = async (req, res) => {
    // Setup CORS for this specific function. Replace with your actual InfinityFree domain.
    await new Promise(resolve => cors({
        origin: 'https://zoeacademy.infy.uk', // <<< REPLACE THIS!
        methods: ['POST'],
        allowedHeaders: ['Content-Type'],
    })(req, res, resolve));

    // Only allow POST requests to this endpoint
    if (req.method !== 'POST') {
        res.setHeader('Allow', ['POST']);
        return res.status(405).json({ message: 'Method Not Allowed' });
    }

    // Ensure environment variables are loaded (Vercel automatically provides them)
    // For local testing, ensure your .env file is configured and loaded correctly.
    const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
    if (!PAYSTACK_SECRET_KEY) {
        console.error('PAYSTACK_SECRET_KEY is not defined!');
        return res.status(500).json({ message: 'Server configuration error: Paystack key missing.' });
    }

    const { email, amount, fullName } = req.body; // 'amount' is expected in Naira here

    // Basic input validation
    if (!email || !amount || !fullName || amount <= 0) {
        return res.status(400).json({ message: 'Missing or invalid payment details (email, amount, or full name).' });
    }

    let client; // Database client for transaction
    try {
        client = await pool.connect(); // Acquire a client from the pool
        await client.query('BEGIN'); // Start a database transaction

        // Check if the user already exists in the registrations table
        const resUser = await client.query(
            'SELECT email, status FROM registrations WHERE email = $1',
            [email]
        );
        const existingUser = resUser.rows;

        if (existingUser.length > 0) {
            // User exists. Check their current payment status.
            if (existingUser[0].status === 'paid') {
                await client.query('ROLLBACK'); // Rollback the DB transaction
                return res.status(409).json({ message: 'This email is already registered and paid for Cohort 3.' });
            }
            // User exists but is not yet 'paid' (e.g., 'pending' or 'failed'), so update their record
            await client.query(
                'UPDATE registrations SET full_name = $1, amount_paid = $2, status = $3, updated_at = NOW() WHERE email = $4 RETURNING *',
                [fullName, amount, 'pending', email]
            );
            console.log(`Updated existing registration for ${email} to 'pending' status.`);
        } else {
            // New user, insert a new record with 'pending' status
            await client.query(
                'INSERT INTO registrations (email, full_name, amount_paid, cohort, status) VALUES ($1, $2, $3, $4, $5) RETURNING *',
                [email, fullName, amount, 'Cohort 3', 'pending']
            );
            console.log(`Created new pending registration for ${email}.`);
        }
        await client.query('COMMIT'); // Commit the database transaction

    } catch (dbError) {
        // If any database error occurs, rollback the transaction
        if (client) await client.query('ROLLBACK');
        console.error('Database error during registration preparation:', dbError);
        return res.status(500).json({ message: 'Database error occurred during registration. Please try again.' });
    } finally {
        if (client) client.release(); // Always release the client back to the pool
    }

    // Proceed to initialize payment with Paystack
    try {
        const paystackResponse = await axios.post(
            'https://api.paystack.co/transaction/initialize',
            {
                email: email,
                amount: amount * 100, // Paystack API expects amount in Kobo (Naira * 100)
                metadata: {
                    full_name: fullName,
                    email: email, // Useful to have email in metadata for webhook
                    cohort: 'Cohort 3',
                    amount_naira: amount, // Keep original Naira amount in metadata for reference
                },
                // Optional: callback_url for redirection after payment on Paystack's side.
                // For Vercel, if you need a callback_url, it should point to your InfinityFree domain.
                // callback_url: `https://yourzoeacademyfrontend.infinityfreeapp.com/payment-success.html?ref={{reference}}`
            },
            {
                headers: {
                    // Authorization header with your SECRET KEY for secure API calls
                    Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
                    'Content-Type': 'application/json',
                },
            }
        );

        // Send Paystack's response back to the frontend (contains access_code and reference)
        res.status(200).json(paystackResponse.data);
    } catch (error) {
        console.error('Error initializing Paystack transaction:', error.response ? error.response.data : error.message);
        res.status(500).json({
            message: 'Failed to initialize payment with Paystack. Please try again.',
            error: error.response ? error.response.data : error.message,
        });
    }
};
