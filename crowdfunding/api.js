// API Connection Utilities
// Render backend URL provided by user
const RENDER_BACKEND_URL = 'https://crowdfunding-platform-backend-ffke.onrender.com';
const API_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' 
    ? 'http://localhost:4000/api' 
    : `${RENDER_BACKEND_URL}/api`;

/** Returns the stored admin JWT token (sessionStorage preferred, localStorage fallback) */
function getAdminToken() {
    return (typeof sessionStorage !== 'undefined' && sessionStorage.getItem('adminToken'))
        || (typeof localStorage !== 'undefined' && localStorage.getItem('adminToken'))
        || '';
}

/** Returns the stored user JWT token */
function getUserToken() {
    return (typeof sessionStorage !== 'undefined' && (sessionStorage.getItem('userToken') || sessionStorage.getItem('token')))
        || (typeof localStorage !== 'undefined' && (localStorage.getItem('userToken') || localStorage.getItem('token')))
        || '';
}

// Generic fetch wrapper with error handling and token refresh interceptor
async function fetchAPI(endpoint, options = {}) {
    const token = getUserToken();
    const headers = {
        'Content-Type': 'application/json',
        ...options.headers
    };
    
    // Automatically attach user authorization header if token is present and not overridden
    if (token && !headers['Authorization']) {
        headers['Authorization'] = `Bearer ${token}`;
    }

    try {
        let response = await fetch(`${API_URL}${endpoint}`, {
            ...options,
            headers
        });

        // Intercept 401 Unauthorised to attempt transparent token refresh
        if (response.status === 401 && !options._retry && !endpoint.includes('/auth/login') && !endpoint.includes('/auth/refresh')) {
            options._retry = true;
            
            try {
                // Call token refresh route (cookies are sent automatically)
                const refreshResponse = await fetch(`${API_URL}/auth/refresh`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                });

                if (refreshResponse.ok) {
                    const data = await refreshResponse.json();
                    const newToken = data.token;
                    
                    // Save new access token
                    if (typeof sessionStorage !== 'undefined') {
                        sessionStorage.setItem('userToken', newToken);
                        sessionStorage.setItem('token', newToken);
                    }
                    if (typeof localStorage !== 'undefined') {
                        localStorage.setItem('userToken', newToken);
                        localStorage.setItem('token', newToken);
                    }

                    // Retry request with new token
                    headers['Authorization'] = `Bearer ${newToken}`;
                    response = await fetch(`${API_URL}${endpoint}`, {
                        ...options,
                        headers
                    });
                } else {
                    // Refresh token is expired/invalid, clear session
                    if (typeof sessionStorage !== 'undefined') {
                        sessionStorage.removeItem('userToken');
                        sessionStorage.removeItem('token');
                    }
                    if (typeof localStorage !== 'undefined') {
                        localStorage.removeItem('userToken');
                        localStorage.removeItem('token');
                    }
                }
            } catch (refreshError) {
                console.error('Transparent token refresh failed:', refreshError);
            }
        }

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
    // Get campaigns with potential location/category/search filters
    getAllCampaigns: async (filters = {}) => {
        const queryParams = new URLSearchParams(filters).toString();
        const endpoint = `/campaigns${queryParams ? '?' + queryParams : ''}`;
        return await fetchAPI(endpoint);
    },

    // Get a specific campaign by ID
    getCampaign: async (id) => {
        return await fetchAPI(`/campaigns/${id}`);
    },

    // Create a new campaign
    createCampaign: async (formData) => {
        const token = getUserToken();
        return await fetch(`${API_URL}/campaigns`, {
            method: 'POST',
            headers: token ? { 'Authorization': `Bearer ${token}` } : undefined,
            body: formData, // FormData for file uploads
        }).then(res => {
            if (!res.ok) throw new Error('Failed to create campaign');
            return res.json();
        });
    },

    // Submit campaign verification request
    requestVerification: async (campaignId) => {
        return await fetchAPI(`/campaigns/${campaignId}/verify-request`, {
            method: 'POST'
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

    // Verify email verification link
    verifyEmail: async (token) => {
        return await fetchAPI('/auth/verify-email', {
            method: 'POST',
            body: JSON.stringify({ token })
        });
    },

    // Forgot password (request reset link)
    forgotPassword: async (email) => {
        return await fetchAPI('/auth/forgot-password', {
            method: 'POST',
            body: JSON.stringify({ email })
        });
    },

    // Reset password (submit new password)
    resetPassword: async (token, password) => {
        return await fetchAPI('/auth/reset-password', {
            method: 'POST',
            body: JSON.stringify({ token, password })
        });
    },

    // Logout
    logout: async () => {
        return await fetchAPI('/auth/logout', {
            method: 'POST'
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
        const token = getUserToken();
        return await fetch(`${API_URL}/kyc`, {
            method: 'POST',
            headers: token ? { 'Authorization': `Bearer ${token}` } : undefined,
            body: formData, // FormData for file uploads
        }).then(res => {
            if (!res.ok) throw new Error('Failed to submit KYC');
            return res.json();
        });
    }
};

// Admin related API calls — all carry the admin JWT
const AdminAPI = {
    // Get all campaigns (including pending/rejected)
    getAllCampaigns: async () => {
        return await fetchAPI('/admin/campaigns', {
            headers: { 'Authorization': `Bearer ${getAdminToken()}` }
        });
    },

    // Update campaign status
    updateCampaignStatus: async (campaignId, status, reason) => {
        return await fetchAPI(`/admin/campaigns/${campaignId}/status`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${getAdminToken()}` },
            body: JSON.stringify({ status, reason })
        });
    },

    // Get pending campaigns count
    getPendingCount: async () => {
        return await fetchAPI('/admin/pending-count', {
            headers: { 'Authorization': `Bearer ${getAdminToken()}` }
        });
    },

    // Get all KYC submissions
    getAllKYC: async () => {
        return await fetchAPI('/admin/kyc', {
            headers: { 'Authorization': `Bearer ${getAdminToken()}` }
        });
    },

    // Update KYC status
    updateKYCStatus: async (kycId, status, reason) => {
        return await fetchAPI(`/admin/kyc/${kycId}/status`, {
            method: 'PUT',
            headers: { 'Authorization': `Bearer ${getAdminToken()}` },
            body: JSON.stringify({ status, reason })
        });
    },

    // Get platform analytics
    getAnalytics: async () => {
        return await fetchAPI('/admin/analytics', {
            headers: { 'Authorization': `Bearer ${getAdminToken()}` }
        });
    },

    // Get audit logs
    getAuditLogs: async (filters = {}) => {
        const queryParams = new URLSearchParams(filters).toString();
        const endpoint = `/admin/audit-logs${queryParams ? '?' + queryParams : ''}`;
        return await fetchAPI(endpoint, {
            headers: { 'Authorization': `Bearer ${getAdminToken()}` }
        });
    },

    // Get security event feed
    getSecurityFeed: async () => {
        return await fetchAPI('/admin/security/feed', {
            headers: { 'Authorization': `Bearer ${getAdminToken()}` }
        });
    },

    // Get suspicious IPs
    getSuspiciousIPs: async () => {
        return await fetchAPI('/admin/security/suspicious', {
            headers: { 'Authorization': `Bearer ${getAdminToken()}` }
        });
    },

    // Update user status
    updateUserStatus: async (userId, status, reason) => {
        return await fetchAPI(`/admin/users/${userId}/status`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${getAdminToken()}` },
            body: JSON.stringify({ status, reason })
        });
    },

    // Get user active sessions
    getUserSessions: async (userId) => {
        return await fetchAPI(`/admin/sessions/${userId}`, {
            headers: { 'Authorization': `Bearer ${getAdminToken()}` }
        });
    },

    // Revoke user session family
    revokeSession: async (family) => {
        return await fetchAPI('/admin/sessions/revoke', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${getAdminToken()}` },
            body: JSON.stringify({ family })
        });
    },

    // Campaign verification request workflow
    getPendingVerifications: async () => {
        return await fetchAPI('/admin/campaigns/verification-pending', {
            headers: { 'Authorization': `Bearer ${getAdminToken()}` }
        });
    },
    approveVerification: async (campaignId, notes) => {
        return await fetchAPI(`/admin/campaigns/${campaignId}/verify-approve`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${getAdminToken()}` },
            body: JSON.stringify({ notes })
        });
    },
    rejectVerification: async (campaignId, notes) => {
        return await fetchAPI(`/admin/campaigns/${campaignId}/verify-reject`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${getAdminToken()}` },
            body: JSON.stringify({ notes })
        });
    },

    // Escrow management
    getDonations: async (filters = {}) => {
        const queryParams = new URLSearchParams(filters).toString();
        const endpoint = `/admin/donations${queryParams ? '?' + queryParams : ''}`;
        return await fetchAPI(endpoint, {
            headers: { 'Authorization': `Bearer ${getAdminToken()}` }
        });
    },
    getCampaignEscrow: async (campaignId) => {
        return await fetchAPI(`/admin/campaigns/${campaignId}/escrow`, {
            headers: { 'Authorization': `Bearer ${getAdminToken()}` }
        });
    },
    releaseDonation: async (donationId, data = {}) => {
        return await fetchAPI(`/admin/donations/${donationId}/release`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${getAdminToken()}` },
            body: JSON.stringify(data)
        });
    },
    refundDonation: async (donationId, data = {}) => {
        return await fetchAPI(`/admin/donations/${donationId}/refund`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${getAdminToken()}` },
            body: JSON.stringify(data)
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