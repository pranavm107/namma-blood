/**
 * Centralized Axios HTTP Client with Session Integrity & 401 Interceptors
 * Namma Blood — Phase 4.3 Frontend Integration
 */

import axios from 'axios'
import { toast } from 'react-toastify'

const BASE_URL = process.env.REACT_APP_BASEURL || 'http://127.0.0.1:5050/api'

// Centralized Axios Instance
const axiosClient = axios.create({
	baseURL: BASE_URL,
	headers: {
		'Content-Type': 'application/json',
	},
	timeout: 15000,
})

// Store reference holder to prevent circular dependencies
let storeRef = null

export const injectStore = (store) => {
	storeRef = store
}

// Helper to safely extract stored session
export const getStoredAuth = () => {
	try {
		const raw = localStorage.getItem('loginData')
		if (!raw) return null
		return JSON.parse(raw)
	} catch (e) {
		return null
	}
}

// Request Interceptor: Attach JWT to protected API requests
axiosClient.interceptors.request.use(
	(config) => {
		const auth = getStoredAuth()
		if (auth && auth.token && typeof auth.token === 'string') {
			config.headers = config.headers || {}
			config.headers.Authorization = `Bearer ${auth.token.trim()}`
		}
		return config
	},
	(error) => Promise.reject(error)
)

// Single-trigger guard for expired session redirect to prevent toast/redirect loops
let isHandling401 = false

// Response Interceptor: Handle 401 Session Expiration
axiosClient.interceptors.response.use(
	(response) => response,
	(error) => {
		const status = error.response ? error.response.status : null
		const requestUrl = error.config ? error.config.url || '' : ''

		// Exclude public authentication endpoints from automatic session wipeout
		const isAuthEndpoint =
			requestUrl.includes('/login') ||
			requestUrl.includes('/register') ||
			requestUrl.includes('/forgotpassword') ||
			requestUrl.includes('/resetpassword')

		if (status === 401 && !isAuthEndpoint) {
			if (!isHandling401) {
				isHandling401 = true

				// 1. Purge stale localStorage credentials
				const auth = getStoredAuth()
				const previousRole = auth?.role ? auth.role.toLowerCase() : 'user'
				localStorage.removeItem('loginData')

				// 2. Reset Redux authentication state if store is injected
				if (storeRef && typeof storeRef.dispatch === 'function') {
					try {
						// Lazy-load logout action to ensure clean execution
						const { logout } = require('../store/loginslice')
						storeRef.dispatch(logout())
					} catch (dispatchErr) {
						// Fallback silently if action resolution fails
					}
				}

				// 3. Inform user with non-intrusive notification
				toast.error('Session expired or authentication failed. Please sign in again.')

				// 4. Safe navigation to login route without full reload loop
				setTimeout(() => {
					isHandling401 = false
					if (typeof window !== 'undefined' && window.location) {
						const loginPath = `/login/${previousRole === 'bloodbank' ? 'bloodbank' : previousRole === 'admin' ? 'admin' : 'user'}`
						if (!window.location.pathname.startsWith('/login')) {
							window.location.href = loginPath
						}
					}
				}, 600)
			}
		}

		// Strictly preserve 403, 404, 422, 429, 500 without logging out the user
		return Promise.reject(error)
	}
)

export default axiosClient

