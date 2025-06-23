// zoe-academy-paystack-backend/api/paystack-webhook.js
// This file handles POST requests from Paystack to /api/paystack-webhook

const pool = require('../utils/db'); // Import the database connection pool
const { verifyPaystackTransaction, verifyPaystackWebhookSignature } = require('../utils/paystack');
const cors = require('cors'); // Vercel functions handle CORS, but explicit can help for clarity.

module.exports = async (req, res) => {
    // Webhooks don't typically need CORS, as they are server-to-server calls.
    // But if you're testing locally via frontend or have specific needs, you might keep it.
    // For production webhooks, it's safer to *not* use CORS here unless strictly necessary.
    // For now, let's keep it minimal for a webhook, as Paystack is direct.
    // The main purpose of this is to make sure your function can process the request.
    if (req.method !== 'POST') {
        res.setHeader('Allow', ['POST']);
        return res.status(405).send('Method Not Allowed');
    }

    // Ensure environment variables are loaded (Vercel automatically provides them)
    const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
    if (!PAYSTACK_SECRET_KEY) {
        console.error('PAYSTACK_SECRET_KEY is not defined!');
        return res.status(500).send('Server configuration error: Paystack key missing.');
    }

    // Verify webhook signature (CRITICAL SECURITY STEP)
    if (!verifyPaystackWebhookSignature(req, PAYSTACK_SECRET_KEY)) {
        console.error('Webhook: Invalid signature received!');
        return res.status(400).send('Invalid signature'); // Respond with 400 for security
    }

    // Acknowledge receipt of the webhook immediately
    // Paystack expects a 200 OK response within a few seconds.
    // We process the event asynchronously after sending 200 OK.
    res.status(200).send('Webhook Received');

    const event = req.body; // Vercel automatically parses JSON bodies.

    // Process the event asynchronously (don't await, let the webhook return 200 OK)
    try {
        if (event.event === 'charge.success') {
            const transactionRef = event.data.reference;
            const customerEmail = event.data.customer.email;
            const paidAmountKobo = event.data.amount;
            const metadata = event.data.metadata;

            console.log(`Webhook: Processing successful charge. Ref=<span class="math-inline">\{transactionRef\}, Email\=</span>{customerEmail}, Amount=${paidAmountKobo / 100} NGN`);

            // --- Step 1: Verify the transaction with Paystack's API ---
            const isVerified = await verifyPaystackTransaction(transactionRef, paidAmountKobo, PAYSTACK_SECRET_KEY);

            if (isVerified) {
                let client;
                try {
                    // --- Step 2: Update your Supabase Database ---
                    client = await pool.connect(); // Get a client for this operation
                    await client.query(
                        'UPDATE registrations SET payment_ref = $1, status = $2, updated_at = NOW() WHERE email = $3',
                        [transactionRef, 'paid', customerEmail]
                    );
                    console.log(`DATABASE ACTION: User ${customerEmail} marked as 'paid' for Cohort 3. Ref: ${transactionRef}`);

                    // --- Step 3: Grant Access / Send Confirmation (Your Business Logic) ---
                    // This is where you would trigger the actual access grant for Cohort 3.
                    console.log(`BUSINESS LOGIC: Confirmation/Access grant for ${customerEmail} (Full Name: ${metadata.full_name}) for ${metadata.cohort}.`);

                } catch (dbError) {
                    console.error('Webhook DB Update Error:', dbError);
                } finally {
                    if (client) client.release(); // Release the client back to the pool
                }
            } else {
                console.warn(`Webhook: Transaction ${transactionRef} could not be verified by Paystack API.`);
            }
        } else {
            console.log(`Webhook: Unhandled event type: ${event.event}`);
        }
    } catch (error) {
        console.error('Error processing webhook event:', error);
    }
};