/**
 * Emergency Blood Request Creation Rate Limiter
 * Namma Blood — Pre-Phase 4.4 Emergency Connection API
 *
 * Enforces per-account rate limiting on emergency ticket initiation to prevent
 * ticket flooding, resource exhaustion, and abuse.
 *
 * Limit: 10 requests per 10 minutes per authenticated account.
 */

const REQUEST_WINDOW_MS = 10 * 60 * 1000 // 10 minute sliding window
const MAX_REQUESTS_PER_WINDOW = 10

// In-memory sliding window request store: clientKey -> Array<timestamp>
const requestStore = new Map()

/**
 * Periodically purge expired records to prevent unbounded memory growth.
 */
function cleanupExpiredRecords() {
	const now = Date.now()
	for (const [key, timestamps] of requestStore.entries()) {
		const valid = timestamps.filter((ts) => now - ts < REQUEST_WINDOW_MS)
		if (valid.length === 0) {
			requestStore.delete(key)
		} else {
			requestStore.set(key, valid)
		}
	}
}

const cleanupInterval = setInterval(cleanupExpiredRecords, 2 * 60 * 1000)
if (cleanupInterval.unref) {
	cleanupInterval.unref()
}

/**
 * Express middleware for emergency blood request creation rate limiting.
 */
function requestCreationRateLimiter(req, res, next) {
	// Key exclusively on cryptographically validated account identifier (protectEmergencyAuth runs first)
	const clientIp =
		req.ip ||
		req.socket?.remoteAddress ||
		req.connection?.remoteAddress ||
		'unknown'

	const clientKey = req.user?._id
		? `user_${req.user._id.toString()}`
		: `ip_${clientIp}`

	const now = Date.now()
	const timestamps = requestStore.get(clientKey) || []

	const activeTimestamps = timestamps.filter((ts) => now - ts < REQUEST_WINDOW_MS)

	if (activeTimestamps.length >= MAX_REQUESTS_PER_WINDOW) {
		const oldest = activeTimestamps[0]
		const retryAfterSeconds = Math.max(
			1,
			Math.ceil((REQUEST_WINDOW_MS - (now - oldest)) / 1000)
		)

		res.setHeader('Retry-After', retryAfterSeconds)
		res.setHeader('X-RateLimit-Limit', MAX_REQUESTS_PER_WINDOW)
		res.setHeader('X-RateLimit-Remaining', 0)
		res.setHeader('X-RateLimit-Reset', Math.ceil((oldest + REQUEST_WINDOW_MS) / 1000))

		return res.status(429).json({
			status: 'fail',
			code: 'RATE_LIMIT_EXCEEDED',
			message: `Emergency request creation quota exceeded. Maximum ${MAX_REQUESTS_PER_WINDOW} requests per 10 minutes. Please retry after ${retryAfterSeconds} seconds.`,
			retryAfter: retryAfterSeconds,
		})
	}

	activeTimestamps.push(now)
	requestStore.set(clientKey, activeTimestamps)

	res.setHeader('X-RateLimit-Limit', MAX_REQUESTS_PER_WINDOW)
	res.setHeader('X-RateLimit-Remaining', Math.max(0, MAX_REQUESTS_PER_WINDOW - activeTimestamps.length))

	next()
}

/**
 * Test helper to reset rate limiter state between automated test cases.
 */
function _resetRateLimiter() {
	requestStore.clear()
}

module.exports = {
	requestCreationRateLimiter,
	_resetRateLimiter,
	MAX_REQUESTS_PER_WINDOW,
	REQUEST_WINDOW_MS,
}

