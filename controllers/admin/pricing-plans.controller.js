import { db } from "../../services/firebase.service.js";
import { badRequestResponse, serverErrorResponse, successResponse } from "../../utils/responses.js";

export const createPricingPlan = async (req, res) => {
    try {
        const {
            name,
            price,
            guestLimit,
            photoPool,
            features,
            storageOptions, // array of {days, price}
            defaultStorageDays, // number
            guestLimitIncreasePricePerGuest, // number
            photoPoolLimitIncreasePricePerPhoto // number
        } = req.body;

        if (
            !name ||
            price == null || price == undefined ||
            !features ||
            guestLimit == null || guestLimit == undefined ||
            photoPool == null || photoPool == undefined ||
            !storageOptions ||
            defaultStorageDays == null || defaultStorageDays == undefined ||
            guestLimitIncreasePricePerGuest == null ||
            photoPoolLimitIncreasePricePerPhoto == null
        ) {
            console.log("Missing required fields:", {
                name,
                price,
                features,
                guestLimit,
                photoPool,
                storageOptions,
                defaultStorageDays,
                guestLimitIncreasePricePerGuest,
                photoPoolLimitIncreasePricePerPhoto
            })
            return badRequestResponse(res, "All fields are required.");
        }

        // Validate guestLimit cannot be greater than photoPool
        if (Number(guestLimit) > Number(photoPool)) {
            return badRequestResponse(res, "Guest limit cannot be greater than photo pool.");
        }

        // Validate storageOptions
        if (!Array.isArray(storageOptions) || storageOptions.length === 0) {
            return badRequestResponse(res, "At least one storage option is required.");
        }
        if (!storageOptions.some(opt => opt.days === defaultStorageDays)) {
            return badRequestResponse(res, "Default storage days must be one of the storage options.");
        }
        if (typeof guestLimitIncreasePricePerGuest !== 'number' || typeof photoPoolLimitIncreasePricePerPhoto !== 'number') {
            return badRequestResponse(res, "Increase prices must be numbers.");
        }

        const newPlan = {
            name,
            price,
            features,
            guestLimit,
            photoPool,
            storageOptions,
            defaultStorageDays,
            guestLimitIncreasePricePerGuest,
            photoPoolLimitIncreasePricePerPhoto,
            createdAt: new Date()
        };

        await db.collection("pricingPlans").add(newPlan);
        return successResponse(res, "Pricing plan created successfully.");
    } catch (error) {
        console.error("Error creating pricing plan:", error);
        return serverErrorResponse(res, "Failed to create pricing plan.");
    }
};

export const getAllPricingPlans = async (req, res) => {

    try {
        const plansRef = db.collection("pricingPlans");
        const snapshot = await plansRef.get();

        if (snapshot.empty) {
            return badRequestResponse(res, "No pricing plans found.");
        }

        const plans = snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data(),
        }));

        return successResponse(res, "Pricing plans retrieved successfully.", plans);
    } catch (error) {
        console.error("Error fetching pricing plans:", error);
        return serverErrorResponse(res, "Failed to fetch pricing plans.");
    }

}

export const getPricingPlanById = async (req, res) => {
    try {
        const { id } = req.params;

        if (!id) {
            return badRequestResponse(res, "Plan ID is required.");
        }

        const planDoc = await db.collection("pricingPlans").doc(id).get();

        if (!planDoc.exists) {
            return badRequestResponse(res, "Pricing plan not found.");
        }

        const plan = {
            id: planDoc.id,
            ...planDoc.data()
        };

        return successResponse(res, "Pricing plan retrieved successfully.", plan);
    } catch (error) {
        console.error("Error fetching pricing plan:", error);
        return serverErrorResponse(res, "Failed to fetch pricing plan.");
    }
};

export const updatePricingPlan = async (req, res) => {
    try {
        const { id } = req.params;
        const {
            name,
            price,
            guestLimit,
            photoPool,
            features,
            storageOptions, // array of {days, price}
            defaultStorageDays, // number
            guestLimitIncreasePricePerGuest, // number
            photoPoolLimitIncreasePricePerPhoto // number
        } = req.body;

        if (!name || price == null || price == undefined || !features || !guestLimit || !photoPool || !storageOptions || !defaultStorageDays || guestLimitIncreasePricePerGuest == null || photoPoolLimitIncreasePricePerPhoto == null) {
            return badRequestResponse(res, "All fields are required.");
        }
        if (!Array.isArray(storageOptions) || storageOptions.length === 0) {
            return badRequestResponse(res, "At least one storage option is required.");
        }
        if (!storageOptions.some(opt => opt.days === defaultStorageDays)) {
            return badRequestResponse(res, "Default storage days must be one of the storage options.");
        }
        if (typeof guestLimitIncreasePricePerGuest !== 'number' || typeof photoPoolLimitIncreasePricePerPhoto !== 'number') {
            return badRequestResponse(res, "Increase prices must be numbers.");
        }

        const updateData = {
            name,
            price,
            features,
            guestLimit,
            photoPool,
            storageOptions,
            defaultStorageDays,
            guestLimitIncreasePricePerGuest,
            photoPoolLimitIncreasePricePerPhoto,
            updatedAt: new Date()
        };

        await db.collection("pricingPlans").doc(id).update(updateData);
        return successResponse(res, "Pricing plan updated successfully.");
    } catch (error) {
        console.error("Error updating pricing plan:", error);
        return serverErrorResponse(res, "Failed to update pricing plan.");
    }
};

export const deletePricingPlan = async (req, res) => {
    try {
        const { id } = req.params;

        if (!id) {
            return badRequestResponse(res, "Plan ID is required.");
        }

        await db.collection("pricingPlans").doc(id).delete();

        return successResponse(res, "Pricing plan deleted successfully.");
    } catch (error) {
        console.error("Error deleting pricing plan:", error);
        return serverErrorResponse(res, "Failed to delete pricing plan.", error.message);
    }
};
