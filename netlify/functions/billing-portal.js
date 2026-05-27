const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  let userId;
  try {
    const body = JSON.parse(event.body);
    userId = body.user_id;
  } catch(e) {
    return { statusCode: 400, body: 'Invalid request body' };
  }

  if (!userId) {
    return { statusCode: 400, body: 'Missing user_id' };
  }

  try {
    const profileRes = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=stripe_customer_id`,
      {
        headers: {
          'apikey': SUPABASE_SERVICE_KEY,
          'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`
        }
      }
    );
    const profiles = await profileRes.json();
    if (!profiles || profiles.length === 0) {
      return { statusCode: 404, body: 'User not found' };
    }

    const { stripe_customer_id } = profiles[0];
    if (!stripe_customer_id) {
      return {
        statusCode: 200,
        body: JSON.stringify({ url: null, message: 'No active subscription found.' })
      };
    }

    const portalRes = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        customer: stripe_customer_id,
        return_url: 'https://foundations.groundworkaustralia.com.au'
      })
    });

    const session = await portalRes.json();
    if (!session.url) throw new Error('Failed to create portal session');

    return { statusCode: 200, body: JSON.stringify({ url: session.url }) };
  } catch (err) {
    console.error('Portal error:', err.message);
    return { statusCode: 500, body: `Server error: ${err.message}` };
  }
};
