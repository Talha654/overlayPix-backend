import dotenv from 'dotenv';

dotenv.config();

/**
 * Service for interacting with RevenueCat API
 */
export const verifySubscription = async (appUserId, productId) => {
    try {
        const apiKey = process.env.REVENUECAT_SECRET_KEY;

        if (!apiKey) {
            console.error('REVENUECAT_SECRET_KEY is not defined in environment variables');
            return { success: false, error: 'Server configuration error' };
        }

        console.log(`Verifying subscription for user: ${appUserId}, product: ${productId}`);

        // Call RevenueCat API to get subscriber info
        // https://www.revenuecat.com/docs/api-v1#tag/customers/operation/subscribers
        const response = await fetch(`https://api.revenuecat.com/v1/subscribers/${appUserId}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`RevenueCat API error (${response.status}):`, errorText);
            return {
                success: false,
                error: `RevenueCat verification failed: ${response.statusText}`,
                details: errorText
            };
        }

        const data = await response.json();
        const subscriber = data.subscriber;

        // 1. Check Entitlements (Standard Subscriptions & Non-Consumables)
        const activeEntitlements = [];
        const entitlements = subscriber.entitlements;

        if (entitlements) {
            for (const [entitlementId, entitlementData] of Object.entries(entitlements)) {
                let isActive = true;
                if (entitlementData.expires_date) {
                    const expirationDate = new Date(entitlementData.expires_date);
                    if (expirationDate < new Date()) {
                        isActive = false;
                    }
                }

                if (isActive) {
                    activeEntitlements.push({
                        id: entitlementId,
                        product_identifier: entitlementData.product_identifier,
                        purchase_date: entitlementData.purchase_date,
                        expires_date: entitlementData.expires_date
                    });
                }
            }
        }

        // 2. Check Non-Subscription Purchases (Consumables)
        // If a specific productId is provided, we check if it was purchased recently
        let validConsumablePurchase = null;
        if (subscriber.non_subscriptions && productId) {
            const purchases = subscriber.non_subscriptions[productId];
            if (purchases && purchases.length > 0) {
                // Sort by purchase date descending to find the latest one
                const sortedPurchases = purchases.sort((a, b) =>
                    new Date(b.purchase_date) - new Date(a.purchase_date)
                );

                const latestPurchase = sortedPurchases[0];
                const purchaseDate = new Date(latestPurchase.purchase_date);

                // Ideally, we might want to check if this purchase is "fresh" (e.g. within last X minutes)
                // to prevent replay attacks if we were strictly validating *new* purchases.
                // For now, we confirm it exists.
                validConsumablePurchase = latestPurchase;
                console.log(`Found valid consumable purchase for ${productId}:`, latestPurchase);
            }
        }


        if (activeEntitlements.length > 0 || validConsumablePurchase) {
            console.log(`Verification successful for user ${appUserId}`);
            return {
                success: true,
                activeEntitlements,
                validConsumablePurchase: validConsumablePurchase ? {
                    ...validConsumablePurchase,
                    store_transaction_identifier: validConsumablePurchase.store_transaction_identifier
                } : null,
                subscriber: {
                    original_app_user_id: subscriber.original_app_user_id,
                    first_seen: subscriber.first_seen,
                    management_url: subscriber.management_url
                }
            };
        } else {
            console.log(`User ${appUserId} has NO active entitlements or valid consumable purchase for ${productId}`);
            return {
                success: false,
                error: 'No active subscription or valid purchase found',
                details: {
                    subscriberId: subscriber.original_app_user_id,
                    checkedProductId: productId
                }
            };
        }

    } catch (error) {
        console.error('Error verifying RevenueCat subscription:', error);
        return {
            success: false,
            error: 'Internal server error during verification',
            details: error.message
        };
    }
};
