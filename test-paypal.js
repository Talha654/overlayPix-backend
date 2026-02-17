/**
 * PayPal API Test Script
 * 
 * This script tests the PayPal payment endpoints to ensure they're working correctly.
 * 
 * Prerequisites:
 * 1. Server must be running (npm run dev)
 * 2. Valid Firebase authentication token
 * 3. Valid plan ID from Firestore
 * 
 * Usage: node test-paypal.js
 */

import fetch from 'node-fetch';

const BASE_URL = 'http://localhost:5001';
const API_URL = `${BASE_URL}/api/payments`;

// You need to replace this with a valid Firebase auth token
const AUTH_TOKEN = 'YOUR_FIREBASE_AUTH_TOKEN';

// Test data
const testPlanId = 'test_plan_id'; // Replace with actual plan ID from Firestore
const testEventId = 'test_event_id'; // Replace with actual event ID for upgrade test

const headers = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${AUTH_TOKEN}`
};

/**
 * Test 1: Create PayPal Order
 */
async function testCreatePayPalOrder() {

  try {
    const response = await fetch(`${API_URL}/create-paypal-order`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        planId: testPlanId,
        customPlan: {
          guestLimit: 100,
          photoPool: 500,
          storageDays: 30
        },
        finalPrice: 29.99,
        userEmail: 'test@example.com'
      })
    });

    const data = await response.json();
    console.log('Status:', response.status);
    console.log('Response:', JSON.stringify(data, null, 2));

    if (data.success && data.orderId) {
      // console.log('✅ PayPal order created successfully!');
      // console.log('Order ID:', data.orderId);
      // console.log('Approval URL:', data.approvalUrl);
      return data.orderId;
    } else {
      console.log('❌ Failed to create PayPal order');
      return null;
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
    return null;
  }
}

/**
 * Test 2: Get PayPal Order Status
 */
async function testGetPayPalOrderStatus(orderId) {
  console.log('\n=== Test 2: Get PayPal Order Status ===');

  if (!orderId) {
    console.log('⚠️  Skipping - no order ID available');
    return;
  }

  try {
    const response = await fetch(`${API_URL}/paypal-status/${orderId}`, {
      method: 'GET',
      headers
    });

    const data = await response.json();
    console.log('Status:', response.status);
    console.log('Response:', JSON.stringify(data, null, 2));

    if (data.success) {
      console.log('✅ Order status retrieved successfully!');
    } else {
      console.log('❌ Failed to get order status');
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

/**
 * Test 3: Create PayPal Upgrade Order
 */
async function testCreatePayPalUpgradeOrder() {
  console.log('\n=== Test 3: Create PayPal Upgrade Order ===');

  try {
    const response = await fetch(`${API_URL}/paypal-upgrade-order`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        eventId: testEventId,
        planId: testPlanId,
        customPlan: {
          guestLimit: 200,
          photoPool: 1000,
          storageDays: 60
        },
        upgradePrice: 19.99,
        userEmail: 'test@example.com'
      })
    });

    const data = await response.json();
    console.log('Status:', response.status);
    console.log('Response:', JSON.stringify(data, null, 2));

    if (data.success && data.orderId) {
      console.log('✅ PayPal upgrade order created successfully!');
      console.log('Order ID:', data.orderId);
      console.log('Upgrade Amount:', data.upgradeAmount);
      return data.orderId;
    } else {
      console.log('❌ Failed to create PayPal upgrade order');
      return null;
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
    return null;
  }
}

/**
 * Test 4: Debug PayPal Order Status
 */
async function testDebugPayPalOrderStatus(orderId) {
  console.log('\n=== Test 4: Debug PayPal Order Status ===');

  if (!orderId) {
    console.log('⚠️  Skipping - no order ID available');
    return;
  }

  try {
    const response = await fetch(`${API_URL}/debug/paypal-order-status/${orderId}`, {
      method: 'GET',
      headers
    });

    const data = await response.json();
    console.log('Status:', response.status);
    console.log('Response:', JSON.stringify(data, null, 2));

    if (data.success) {
      console.log('✅ Debug info retrieved successfully!');
      console.log('Status Match:', data.statusMatch);
    } else {
      console.log('❌ Failed to get debug info');
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

/**
 * Test 5: Test Server Health
 */
async function testServerHealth() {
  console.log('\n=== Test 5: Server Health Check ===');

  try {
    const response = await fetch(BASE_URL);
    const data = await response.json();
    console.log('Status:', response.status);
    console.log('Response:', JSON.stringify(data, null, 2));

    if (response.status === 200) {
      console.log('✅ Server is running!');
      return true;
    } else {
      console.log('❌ Server health check failed');
      return false;
    }
  } catch (error) {
    console.error('❌ Error: Server is not running or not accessible');
    console.error('Make sure to start the server with: npm run dev');
    return false;
  }
}

/**
 * Test 6: Test Free Plan (No PayPal API call)
 */
async function testFreePlan() {
  console.log('\n=== Test 6: Create Free Plan Order ===');

  try {
    const response = await fetch(`${API_URL}/create-paypal-order`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        planId: testPlanId,
        customPlan: {
          guestLimit: 50,
          photoPool: 100,
          storageDays: 7
        },
        finalPrice: 0, // Free plan
        userEmail: 'test@example.com'
      })
    });

    const data = await response.json();
    console.log('Status:', response.status);
    console.log('Response:', JSON.stringify(data, null, 2));

    if (data.success && data.isFreePlan) {
      console.log('✅ Free plan created successfully!');
      console.log('Order ID:', data.orderId);
      return data.orderId;
    } else {
      console.log('❌ Failed to create free plan');
      return null;
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
    return null;
  }
}

/**
 * Run all tests
 */
async function runAllTests() {
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║         PayPal Payment Integration Tests              ║');
  console.log('╚═══════════════════════════════════════════════════════╝');

  // Check if server is running
  const serverRunning = await testServerHealth();
  if (!serverRunning) {
    console.log('\n❌ Cannot proceed with tests - server is not running');
    return;
  }

  // Check authentication
  if (AUTH_TOKEN === 'YOUR_FIREBASE_AUTH_TOKEN') {
    console.log('\n⚠️  WARNING: Using placeholder auth token');
    console.log('Please update AUTH_TOKEN in test-paypal.js with a valid Firebase token');
    console.log('\nTests will likely fail due to authentication errors.');
    console.log('You can still see the API structure and error handling.\n');
  }

  // Run tests
  const orderId = await testCreatePayPalOrder();
  await testGetPayPalOrderStatus(orderId);
  await testDebugPayPalOrderStatus(orderId);

  const freeOrderId = await testFreePlan();
  await testGetPayPalOrderStatus(freeOrderId);

  // Upgrade test (may fail if event doesn't exist)
  await testCreatePayPalUpgradeOrder();

  console.log('\n╔═══════════════════════════════════════════════════════╗');
  console.log('║                  Tests Completed                       ║');
  console.log('╚═══════════════════════════════════════════════════════╝');

  console.log('\nNext Steps:');
  console.log('1. Update AUTH_TOKEN with a valid Firebase token');
  console.log('2. Update testPlanId with an actual plan ID from Firestore');
  console.log('3. Update testEventId with an actual event ID for upgrade tests');
  console.log('4. Visit the approvalUrl to complete payment on PayPal sandbox');
  console.log('5. Call /capture-paypal-order endpoint after approval');
  console.log('\nFor manual testing, use the PAYPAL_INTEGRATION.md documentation');
}

// Run tests
runAllTests().catch(console.error);
