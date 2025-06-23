require('dotenv').config(); // Load environment variables from .env file

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const crypto = require('crypto'); // Node.js built-in module for cryptographic functions
const { Pool } = require('pg'); // PostgreSQL client
const cors = require('cors'); // CORS middleware

const app = express();
const PORT = process.env.PORT || 3000; // Server will run on port 3000 locally, or Render's assigned port

// --- Middleware Setup ---
// For parsing JSON request bodies (e.g., from your frontend and Paystack webhooks)
app.use(bodyParser.json());
// For parsing URL-encoded request bodies
app.use(express.urlencoded({ extended: true }));

// CORS (Cross-Origin Resource Sharing) configuration
// This is essential to allow your frontend on InfinityFree to make requests to this backend on Render.
app.use(cors({
    // In development, you might use '*', but for production, BE SPECIFIC.
    // Replace 'https://zoeacademy.infy.uk' with your actual InfinityFree domain.
    // 'http://localhost:8000' is for local frontend testing.
    origin: ['https://zoeacademy.infy.uk', 'http://zoeacademy.infy.uk'], // <<< IMPORTANT: REPLACE WITH YOUR ACTUAL FRONTEND DOMAIN!
    methods: ['GET', 'POST'], // Allow GET and POST requests
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'x-paystack-signature'], // Allow these headers
}));

// --- Supabase PostgreSQL Database Connection Pool ---
// Using a connection pool is highly recommended for Node.js apps
// as it efficiently manages database connections.
const pool = new Pool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT,
    // When deploying to Render and connecting to Supabase, you often need SSL.
    // 'rejectUnauthorized: false' allows connection even if cert isn't fully trusted, common in dev/some deployments.
    // For stricter production, consider setting up specific SSL certs.
    ssl: {
        rejectUnauthorized: false
    }
});

// Test the database connection pool on server startup
pool.query('SELECT NOW()')
    .then(res => console.log('Successfully connected to Supabase PostgreSQL database!', res.rows[0]))
    .catch(err => console.error('Failed to connect to Supabase PostgreSQL database:', err.message, err.stack));


// --- API Routes ---

// 1. POST /api/initialize-payment
// This endpoint receives registration data from your frontend
// and initiates a transaction with Paystack.
app.post('/api/initialize-payment', async (req, res) => {
    const { email, amount, fullName } = req.body; // 'amount' is expected in Naira here (e.g., 50000)

    // Basic input validation
    if (!email || !amount || !fullName || amount <= 0) {
        return res.status(400).json({ message: 'Missing or invalid payment details (email, amount, or full name).' });
    }

    let client; // This will hold a database client from the pool
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
                // Not strictly needed for inline popup, but good for robust error handling.
                // callback_url: `https://zoeacademy.infy.uk/payment-status.html?ref={{reference}}`
            },
            {
                headers: {
                    // Authorization header with your SECRET KEY for secure API calls
                    Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
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
});


// 2. POST /api/paystack-webhook
// This endpoint receives real-time notifications from Paystack about transaction status changes.
app.post('/api/paystack-webhook', async (req, res) => {
    // Paystack sends the raw JSON body, so bodyParser.json() handles it.
    const secret = process.env.PAYSTACK_SECRET_KEY; // Your Paystack Secret Key
    const hash = crypto.createHmac('sha512', secret).update(JSON.stringify(req.body)).digest('hex');

    // --- Webhook Signature Verification ---
    // IMPORTANT: Verify the signature to ensure the webhook is genuinely from Paystack
    if (hash !== req.headers['x-paystack-signature']) {
        console.error('Webhook: Invalid signature received!');
        return res.sendStatus(400); // Bad Request - reject unauthorized requests
    }

    // Acknowledge receipt of the webhook immediately
    // Paystack expects a 200 OK response within a few seconds.
    // We process the event asynchronously to avoid delays.
    res.sendStatus(200);

    const event = req.body;

    // Process the event asynchronously (don't await, let the webhook return 200 OK)
    processWebhookEvent(event).catch(error => {
        console.error('Unhandled error processing webhook event:', error);
        // Log this error, as the 200 OK has already been sent to Paystack.
    });
});

// Asynchronous function to process Paystack webhook events
async function processWebhookEvent(event) {
    if (event.event === 'charge.success') {
        const transactionRef = event.data.reference;
        const transactionStatus = event.data.status; // Should be 'success'
        const customerEmail = event.data.customer.email;
        const paidAmountKobo = event.data.amount; // Amount from webhook in kobo
        const metadata = event.data.metadata; // Custom metadata you sent during initialization

        console.log(`Webhook: Processing successful charge. Ref=${transactionRef}, Status=${transactionStatus}, Email=${customerEmail}, Amount=${paidAmountKobo / 100} NGN`);

        let client;
        try {
            // --- Step 1: Verify the transaction with Paystack's API ---
            // This is the definitive verification step to prevent fraud.
            const verificationResponse = await axios.get(
                `https://api.paystack.co/transaction/verify/${transactionRef}`,
                {
                    headers: {
                        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, // Using SECRET KEY here!
                    },
                }
            );

            const verifiedData = verificationResponse.data.data;
            const verifiedStatus = verifiedData.status;
            const verifiedAmountKobo = verifiedData.amount; // Amount from verification in kobo
            const verifiedRef = verifiedData.reference;

            if (verifiedStatus === 'success' && verifiedAmountKobo === paidAmountKobo && verifiedRef === transactionRef) {
                console.log(`Transaction ${transactionRef} successfully verified and amount matches.`);

                // --- Step 2: Update your Supabase Database ---
                client = await pool.connect(); // Get a client for this operation
                await client.query(
                    'UPDATE registrations SET payment_ref = $1, status = $2, updated_at = NOW() WHERE email = $3',
                    [transactionRef, 'paid', customerEmail]
                );
                console.log(`DATABASE ACTION: User ${customerEmail} marked as 'paid' for Cohort 3. Ref: ${transactionRef}`);

                // --- Step 3: Grant Access / Send Confirmation (Your Business Logic) ---
                // This is where you would trigger the actual access grant for Cohort 3.
                // Examples:
                // - Send a confirmation email with access details (e.g., Zoom links, course portal access).
                // - Update a user role in a separate authentication system.
                // - Log the completion of the registration process.
                console.log(`BUSINESS LOGIC: Confirmation/Access grant for ${customerEmail} (Full Name: ${metadata.full_name}) for ${metadata.cohort}.`);

            } else {
                // Verification failed (e.g., status not 'success' or amount mismatch)
                console.warn(`Transaction ${transactionRef} verification failed or amount mismatch.`);
                console.warn(`Webhook received: Status=${transactionStatus}, Amount=${paidAmountKobo/100}`);
                console.warn(`Paystack verification: Status=${verifiedStatus}, Amount=${verifiedAmountKobo/100}`);
                // You might update status to 'verification_failed' in DB for manual review,
                // or just log it and handle manually via Paystack dashboard.
            }
        } catch (error) {
            console.error('Error during transaction verification or database update:', error.response ? error.response.data : error.message);
            // Log this critical error for manual investigation in your Render logs
        } finally {
            if (client) client.release(); // Always release the client back to the pool
        }
    } else {
        console.log(`Webhook: Unhandled event type: ${event.event}`);
    }
}


// Basic health check route for Render (and general testing)
app.get('/', (req, res) => {
    res.status(200).send('Zoe Academy Paystack Backend is running!');
});

// Start the Express server
app.listen(PORT, () => {
    console.log(`Backend server running on port ${PORT}`);
    console.log(`Local development URL (if running locally): http://localhost:${PORT}`);
});