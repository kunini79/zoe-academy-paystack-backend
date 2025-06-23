// zoe-academy-paystack-backend/utils/paystack.js
const axios = require('axios');
const crypto = require('crypto');

// Function to verify a Paystack transaction with Paystack's API
async function verifyPaystackTransaction(transactionRef, paidAmountKobo, secretKey) {
    try {
        const verificationResponse = await axios.get(
            `https://api.paystack.co/transaction/verify/${transactionRef}`,
            {
                headers: {
                    Authorization: `Bearer ${secretKey}`,
                },
            }
        );

        const verifiedData = verificationResponse.data.data;
        const verifiedStatus = verifiedData.status;
        const verifiedAmountKobo = verifiedData.amount;
        const verifiedRef = verifiedData.reference;

        if (verifiedStatus === 'success' && verifiedAmountKobo === paidAmountKobo && verifiedRef === transactionRef) {
            console.log(`Paystack Verification: Transaction ${transactionRef} successfully verified and amount matches.`);
            return true;
        } else {
            console.warn(`Paystack Verification: Transaction ${transactionRef} verification failed or amount mismatch.`);
            console.warn(`Expected Amount: ${paidAmountKobo}, Verified Amount: ${verifiedAmountKobo}, Status: ${verifiedStatus}`);
            return false;
        }
    } catch (error) {
        console.error('Error verifying transaction with Paystack:', error.response ? error.response.data : error.message);
        return false;
    }
}

// Function to verify the signature of a Paystack webhook event
function verifyPaystackWebhookSignature(req, secretKey) {
    // Vercel functions might need raw body for signature verification.
    // Ensure req.rawBody is available or use req.body (Vercel often parses it)
    const signature = req.headers['x-paystack-signature'];
    if (!signature) {
        console.error('Webhook: Signature header missing.');
        return false;
    }

    // Paystack expects HMAC-SHA512 of the RAW request body
    // Vercel provides req.body as parsed JSON, so we stringify it.
    // In a real production scenario, for webhooks, it's safer to use the raw body buffer.
    // For now, stringify req.body is often sufficient for Vercel's parsing.
    const hash = crypto.createHmac('sha512', secretKey).update(JSON.stringify(req.body)).digest('hex');

    return hash === signature;
}

module.exports = {
    verifyPaystackTransaction,
    verifyPaystackWebhookSignature
};