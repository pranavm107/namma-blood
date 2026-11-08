import axiosClient, { injectStore, getStoredAuth } from '../axiosClient'
import { toast } from 'react-toastify'

// Capture the registered interceptor handlers before any jest.clearAllMocks() runs
const requestSuccessHandler =
	axiosClient.interceptors?.request?.use?.mock?.calls?.[0]?.[0]
const responseErrorHandler =
	axiosClient.interceptors?.response?.use?.mock?.calls?.[0]?.[1]

jest.mock('react-toastify', () => ({
	toast: {
		error: jest.fn(),
		success: jest.fn(),
		info: jest.fn(),
	},
}))

describe('axiosClient & session interceptors', () => {
	let originalLocation
	let mockDispatch
	let mockStore

	beforeAll(() => {
		originalLocation = window.location
		delete window.location
		window.location = {
			href: 'http://localhost:3000/user/emergency-discovery',
			pathname: '/user/emergency-discovery',
		}
	})

	afterAll(() => {
		window.location = originalLocation
	})

	beforeEach(() => {
		localStorage.clear()
		jest.clearAllMocks()
		mockDispatch = jest.fn()
		mockStore = {
			dispatch: mockDispatch,
			getState: jest.fn(),
		}
		injectStore(mockStore)
	})

	describe('getStoredAuth helper', () => {
		it('returns null when no loginData in localStorage', () => {
			expect(getStoredAuth()).toBeNull()
		})

		it('returns null on invalid JSON in localStorage', () => {
			localStorage.setItem('loginData', 'invalid-json-{')
			expect(getStoredAuth()).toBeNull()
		})

		it('returns parsed auth object when valid JSON exists', () => {
			const auth = { token: 'jwt.token.here', role: 'USER', email: 'test@example.com' }
			localStorage.setItem('loginData', JSON.stringify(auth))
			expect(getStoredAuth()).toEqual(auth)
		})
	})

	describe('Request interceptor', () => {
		it('attaches Authorization header with Bearer token if token exists', async () => {
			localStorage.setItem('loginData', JSON.stringify({ token: 'test-token-123' }))

			const config = await requestSuccessHandler({
				url: '/emergency/discover/donors',
				headers: {},
			})

			expect(config.headers.Authorization).toBe('Bearer test-token-123')
		})

		it('does not set Authorization header if loginData is not present', async () => {
			const config = await requestSuccessHandler({
				url: '/emergency/discover/donors',
				headers: {},
			})

			expect(config.headers.Authorization).toBeUndefined()
		})
	})

	describe('Response interceptor 401 handling', () => {
		it('purges localStorage, dispatches logout, toasts error, and redirects on protected 401', async () => {
			localStorage.setItem(
				'loginData',
				JSON.stringify({ token: 'expired-token', role: 'USER' })
			)

			const error = {
				response: { status: 401, data: { message: 'Token expired' } },
				config: { url: '/emergency/requests/6aed932b2debf35b705967bd/matches' },
			}

			jest.useFakeTimers()

			await expect(responseErrorHandler(error)).rejects.toEqual(error)

			// 1. localStorage purged
			expect(localStorage.getItem('loginData')).toBeNull()

			// 2. logout dispatched
			expect(mockDispatch).toHaveBeenCalled()

			// 3. toast emitted
			expect(toast.error).toHaveBeenCalledWith(
				'Session expired or authentication failed. Please sign in again.'
			)

			// 4. Redirect after timeout
			jest.advanceTimersByTime(700)
			expect(window.location.href).toBe('/login/user')

			jest.useRealTimers()
		})

		it('does NOT purge localStorage or logout on 401 from public auth endpoints', async () => {
			localStorage.setItem(
				'loginData',
				JSON.stringify({ token: 'temp-token', role: 'USER' })
			)

			const error = {
				response: { status: 401, data: { message: 'Invalid credentials' } },
				config: { url: '/user/login' },
			}

			await expect(responseErrorHandler(error)).rejects.toEqual(error)

			// Should not purge
			expect(localStorage.getItem('loginData')).not.toBeNull()
			expect(mockDispatch).not.toHaveBeenCalled()
		})

		it('does NOT trigger logout or redirect on 403 Forbidden', async () => {
			localStorage.setItem(
				'loginData',
				JSON.stringify({ token: 'valid-token', role: 'USER' })
			)

			const error = {
				response: { status: 403, data: { message: 'Access forbidden' } },
				config: { url: '/admin/bloodbanks' },
			}

			await expect(responseErrorHandler(error)).rejects.toEqual(error)

			expect(localStorage.getItem('loginData')).not.toBeNull()
			expect(mockDispatch).not.toHaveBeenCalled()
			expect(toast.error).not.toHaveBeenCalled()
		})

		it('does NOT trigger logout or redirect on 500 Internal Server Error', async () => {
			localStorage.setItem(
				'loginData',
				JSON.stringify({ token: 'valid-token', role: 'USER' })
			)

			const error = {
				response: { status: 500, data: { message: 'Database connection failed' } },
				config: { url: '/emergency/discover/donors' },
			}

			await expect(responseErrorHandler(error)).rejects.toEqual(error)

			expect(localStorage.getItem('loginData')).not.toBeNull()
			expect(mockDispatch).not.toHaveBeenCalled()
		})
	})
})
