/**
 * In-Memory Sliding-Window Discovery Rate Limiter
 * Namma Blood — Emergency Blood Connection (Milestone 4.3)
 *
 * Security & Anti-Scraping Protection:
 * Limits rapid consecutive geospatial discovery requests to prevent automated
 * location enumeration, data scraping, and platform resource exhaustion.
 *
 * Limit: 30 requests per minute per IP / Authenticated Account.
 *
 * ARCHITECTURAL DEPLOYMENT NOTE (Multi-Instance / Clustered Scale):
 * This in-memory implementation provides zero-dependency rate limiting within a single
 * Node.js process. In horizontally scaled or containerized production deployments with
 * multiple application replicas, rate limiting state should be backed by a centralized
 * distributed store (e.g. Redis sliding-window via ZADD/ZREMRANGEBYSCORE).
 *
 * ANTI-SPOOFING GUARANTEE:
 * Because discovery endpoints enforce JWT authentication via protectEmergencyAuth prior to
 * rate limiting, authenticated requests are keyed on the cryptographically validated account
 * identifier (req.user._id). Spoofing proxy headers (such as X-Forwarded-For or Client-IP)
 * cannot bypass the quota.
 *
 * REMAINING MULTI-ACCOUNT ABUSE RISK & PRODUCTION RECOMMENDATION:
 * While account-based keying prevents single-account header spoofing, an adversary operating
 * multiple registered accounts could distribute discovery requests across accounts.
 * Before production deployment, a dual-layer limiter (enforcing both per-account and per-IP/subnet
 * thresholds) backed by centralized Redis should be deployed to prevent distributed sybil enumeration.
 */

const REQUEST_WINDOW_MS = 60 * 1000 // 1 minute sliding window
const MAX_REQUESTS_PER_WINDOW = 30

// Map storing key -> array of request timestamps
const requestStore = new Map()

/**
 * Cleanup expired timestamps periodically to prevent memory accumulation.
 */
function cleanupExpiredRecords() {
	const now = Date.now()
	for (const [key, timestamps] of requestStore.entries()) {
		const validTimestamps = timestamps.filter((ts) => now - ts < REQUEST_WINDOW_MS)
		if (validTimestamps.length === 0) {
			requestStore.delete(key)
		} else {
			requestStore.set(key, validTimestamps)
		}
	}
}

// Run cleanup every 2 minutes
const cleanupInterval = setInterval(cleanupExpiredRecords, 2 * 60 * 1000)
if (cleanupInterval.unref) {
	cleanupInterval.unref() // Do not hold open node event loop
}

/**
 * Express middleware enforcing discovery rate limiting.
 */
function discoveryRateLimiter(req, res, next) {
	// Robust IP extraction fallback for unauthenticated requests
	const clientIp =
		req.ip ||
		req.socket?.remoteAddress ||
		req.connection?.remoteAddress ||
		'unknown'

	// Prefer cryptographically verified user identity; fallback to client IP
	const clientKey = req.user?._id
		? `user_${req.user._id.toString()}`
		: `ip_${clientIp}`

	const now = Date.now()
	const timestamps = requestStore.get(clientKey) || []

	// Filter timestamps within the current sliding window
	const activeTimestamps = timestamps.filter((ts) => now - ts < REQUEST_WINDOW_MS)

	if (activeTimestamps.length >= MAX_REQUESTS_PER_WINDOW) {
		const oldestTimestamp = activeTimestamps[0]
		const retryAfterSeconds = Math.max(
			1,
			Math.ceil((REQUEST_WINDOW_MS - (now - oldestTimestamp)) / 1000)
		)

		res.setHeader('Retry-After', retryAfterSeconds)
		res.setHeader('X-RateLimit-Limit', MAX_REQUESTS_PER_WINDOW)
		res.setHeader('X-RateLimit-Remaining', 0)
		res.setHeader('X-RateLimit-Reset', Math.ceil((oldestTimestamp + REQUEST_WINDOW_MS) / 1000))

		return res.status(429).json({
			status: 'fail',
			message: `Too many discovery requests. Limit is ${MAX_REQUESTS_PER_WINDOW} requests per minute. Please try again after ${retryAfterSeconds} seconds.`,
			retryAfter: retryAfterSeconds,
		})
	}

	// Record current request timestamp
	activeTimestamps.push(now)
	requestStore.set(clientKey, activeTimestamps)

	// Set informative rate limit headers
	const remaining = MAX_REQUESTS_PER_WINDOW - activeTimestamps.length
	res.setHeader('X-RateLimit-Limit', MAX_REQUESTS_PER_WINDOW)
	res.setHeader('X-RateLimit-Remaining', remaining)

	next()
}

/**
 * Resets the in-memory request store. Strictly intended for test suites.
 */
function resetDiscoveryRateLimiter() {
	requestStore.clear()
}

module.exports = {
	discoveryRateLimiter,
	resetDiscoveryRateLimiter,
	MAX_REQUESTS_PER_WINDOW,
	REQUEST_WINDOW_MS,
}
