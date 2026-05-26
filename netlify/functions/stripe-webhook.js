const crypto = require('crypto');

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const ESSENTIAL_PRICE_ID = 'price_1TbD5qCxDwkyvY6bBZmJ4qiV';
const PROFESSIONAL_PRICE_ID = 'price_1TbD0OCxDwkyvY6bXfIie2IN';

function verifyStripeSignature(body, signature, secret) {
  const parts = signature.split(',');
  const timestamp = parts.find(p => p.startsWith('t=')).split('=')[1];
  const sig = parts.find(p => p.startsWith('v1=')).split('=')[1];
  const payload = `${timestamp}.${body}`;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const tolerance = 300;
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > tolerance) {
    throw new Error('Webhook timestamp too old');
  }
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    throw new Error('Webhook signature mismatch');
  }
  return true;
}

function getPlanFromPriceId(priceId) {
  if (priceId === PROFESSIONAL_PRICE_ID) return 'professional';
  if (priceId === ESSENTIAL_PRICE_ID) return 'essential';
  return 'free';
}

async function updateUserPlan(email, customerId, plan, status) {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?email=eq.${encodeURIComponent(email)}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        plan,
        stripe_customer_id: customerId,
        subscription_status: status,
        updated_at: new Date().toISOString()
      })
    }
  );
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Supabase update failed: ${error}`);
  }
  return true;
}

async function getCustomerEmail(customerId) {
  const response = await fetch(
    `https://api.stripe.com/v1/customers/${customerId}`,
    {
      headers: {
        'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`
      }
    }
  );
  if (!response.ok) throw new Error('Failed to fetch customer from Stripe');
  const customer = await response.json();
  return customer.email;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const signature = event.headers['stripe-signature'];
  if (!signature) {
    return { statusCode: 400, body: 'Missing stripe-signature header' };
  }

  let stripeEvent;
  try {
    verifyStripeSignature(event.body, signature, STRIPE_WEBHOOK_SECRET);
    stripeEvent = JSON.parse(event.body);
  } catch (err) {
    console.error('Webhook verification failed:', err.message);
    return { statusCode: 400, body: `Webhook error: ${err.message}` };
  }

  const subscription = stripeEvent.data.object;
  const customerId = subscription.customer;
  const priceId = subscription.items?.data?.[0]?.price?.id;

  try {
    let email, plan, status;

    switch (stripeEvent.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        email = await getCustomerEmail(customerId);
        plan = getPlanFromPriceId(priceId);
        status = subscription.status === 'active' ? 'active' : 'inactive';
        await updateUserPlan(email, customerId, plan, status);
        console.log(`Updated ${email} to ${plan} (${status})`);
        break;

      case 'customer.subscription.deleted':
        email = await getCustomerEmail(customerId);
        await updateUserPlan(email, customerId, 'free', 'cancelled');
        console.log(`Downgraded ${email} to free (cancelled)`);
        break;

      default:
        console.log(`Unhandled event type: ${stripeEvent.type}`);
    }

    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  } catch (err) {
    console.error('Error processing webhook:', err.message);
    return { statusCode: 500, body: `Server error: ${err.message}` };
  }
};
