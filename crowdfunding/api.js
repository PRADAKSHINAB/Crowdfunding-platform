// API Connection Utilities
const API_URL = 'http://localhost:4000/api';

// Generic fetch wrapper with error handling
async function fetchAPI(endpoint, options = {}) {
    try {
        const response = await fetch(`${API_URL}${endpoint}`, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                ...options.headers
            }
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.message || `API Error: ${response.status}`);
        }

        return await response.json();
    } catch (error) {
        console.error(`API Error (${endpoint}):`, error);
        throw error;
    }
}

// Campaign related API calls
const CampaignAPI = {
    // Get all approved campaigns
    getAllCampaigns: async () => {
        return await fetchAPI('/campaigns');
    },

    // Get a specific campaign by ID
    getCampaign: async (id) => {
        return await fetchAPI(`/campaigns/${id}`);
    },

    // Create a new campaign
    createCampaign: async (formData) => {
        return await fetch(`${API_URL}/campaigns`, {
            method: 'POST',
            body: formData, // FormData for file uploads
        }).then(res => {
            if (!res.ok) throw new Error('Failed to create campaign');
            return res.json();
        });
    },

    // Get campaign statistics
    getStatistics: async () => {
        return await fetchAPI('/statistics');
    }
};

// Authentication related API calls
const AuthAPI = {
    // Register a new user
    register: async (userData) => {
        return await fetchAPI('/auth/register', {
            method: 'POST',
            body: JSON.stringify(userData)
        });
    },

    // Login a user
    login: async (credentials) => {
        return await fetchAPI('/auth/login', {
            method: 'POST',
            body: JSON.stringify(credentials)
        });
    },

    // Admin login
    adminLogin: async (credentials) => {
        return await fetchAPI('/admin/login', {
            method: 'POST',
            body: JSON.stringify(credentials)
        });
    }
};

// Donation related API calls
const DonationAPI = {
    // Create a payment order
    createOrder: async (campaignId, donationData) => {
        return await fetchAPI(`/campaigns/${campaignId}/create-order`, {
            method: 'POST',
            body: JSON.stringify(donationData)
        });
    },

    // Verify payment after successful transaction
    verifyPayment: async (campaignId, paymentData) => {
        return await fetchAPI(`/campaigns/${campaignId}/verify-payment`, {
            method: 'POST',
            body: JSON.stringify(paymentData)
        });
    }
};

// KYC related API calls
const KYCAPI = {
    // Submit KYC verification
    submitKYC: async (formData) => {
        return await fetch(`${API_URL}/kyc`, {
            method: 'POST',
            body: formData, // FormData for file uploads
        }).then(res => {
            if (!res.ok) throw new Error('Failed to submit KYC');
            return res.json();
        });
    }
};

// Admin related API calls
const AdminAPI = {
    // Get all campaigns (including pending/rejected)
    getAllCampaigns: async () => {
        return await fetchAPI('/admin/campaigns');
    },

    // Update campaign status
    updateCampaignStatus: async (campaignId, status, reason) => {
        return await fetchAPI(`/admin/campaigns/${campaignId}/status`, {
            method: 'PUT',
            body: JSON.stringify({ status, reason })
        });
    },

    // Get pending campaigns count
    getPendingCount: async () => {
        return await fetchAPI('/admin/pending-count');
    },

    // Get all KYC submissions
    getAllKYC: async () => {
        return await fetchAPI('/admin/kyc');
    },

    // Update KYC status
    updateKYCStatus: async (kycId, status, reason) => {
        return await fetchAPI(`/admin/kyc/${kycId}/status`, {
            method: 'PUT',
            body: JSON.stringify({ status, reason })
        });
    }
};

// Contact form submission
const ContactAPI = {
    // Submit contact form
    submitContact: async (contactData) => {
        return await fetchAPI('/contact', {
            method: 'POST',
            body: JSON.stringify(contactData)
        });
    }
};