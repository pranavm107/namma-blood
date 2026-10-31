/**
 * Reusable Client-Side Geolocation Utility
 * Namma Blood — Emergency Blood Connection (Milestone 4.1)
 */

export const GEO_ERROR_CODES = {
	PERMISSION_DENIED: 'PERMISSION_DENIED',
	POSITION_UNAVAILABLE: 'POSITION_UNAVAILABLE',
	TIMEOUT: 'TIMEOUT',
	NOT_SUPPORTED: 'NOT_SUPPORTED',
	INVALID_COORDINATES: 'INVALID_COORDINATES',
}

const ERROR_MESSAGES = {
	[GEO_ERROR_CODES.PERMISSION_DENIED]:
		'Location permission was denied. Please allow location access or select your city manually.',
	[GEO_ERROR_CODES.POSITION_UNAVAILABLE]:
		'Network or GPS location information is currently unavailable. Please select your city manually.',
	[GEO_ERROR_CODES.TIMEOUT]:
		'The request to get your location timed out. Please retry or select your city manually.',
	[GEO_ERROR_CODES.NOT_SUPPORTED]:
		'Geolocation is not supported by your current browser. Please select your city manually.',
	[GEO_ERROR_CODES.INVALID_COORDINATES]:
		'Retrieved coordinates are outside valid geographical bounds.',
}

/**
 * Validates whether an input represents a valid [longitude, latitude] coordinate pair.
 *
 * @param {Array} coordinates - [longitude, latitude]
 * @returns {boolean}
 */
export function validateCoordinates(coordinates) {
	if (!Array.isArray(coordinates) || coordinates.length !== 2) {
		return false
	}
	const [lng, lat] = coordinates
	if (typeof lng !== 'number' || typeof lat !== 'number') {
		return false
	}
	if (isNaN(lng) || isNaN(lat)) {
		return false
	}
	return lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90
}

/**
 * Asynchronously retrieves the client's current geographical location using the browser Geolocation API.
 * Wraps navigator.geolocation.getCurrentPosition in a resilient Promise.
 *
 * @param {Object} options - Standard PositionOptions (enableHighAccuracy, timeout, maximumAge)
 * @returns {Promise<{success: boolean, coordinates: [number, number]|null, latitude?: number, longitude?: number, accuracy?: number, error: Object|null, fallbackRequired: boolean}>}
 */
export function getCurrentPosition(options = {}) {
	const defaultOptions = {
		enableHighAccuracy: true,
		timeout: 10000, // 10 second timeout
		maximumAge: 60000, // 1 minute cached position acceptable
		...options,
	}

	return new Promise((resolve) => {
		if (typeof window === 'undefined' || !navigator || !navigator.geolocation) {
			return resolve({
				success: false,
				coordinates: null,
				error: {
					code: GEO_ERROR_CODES.NOT_SUPPORTED,
					message: ERROR_MESSAGES[GEO_ERROR_CODES.NOT_SUPPORTED],
				},
				fallbackRequired: true,
			})
		}

		navigator.geolocation.getCurrentPosition(
			(position) => {
				const lat = position?.coords?.latitude
				const lng = position?.coords?.longitude
				const accuracy = position?.coords?.accuracy || 0

				// Format as GeoJSON Point coordinates: [longitude, latitude]
				const coordinates = [lng, lat]

				if (!validateCoordinates(coordinates)) {
					return resolve({
						success: false,
						coordinates: null,
						error: {
							code: GEO_ERROR_CODES.INVALID_COORDINATES,
							message: ERROR_MESSAGES[GEO_ERROR_CODES.INVALID_COORDINATES],
						},
						fallbackRequired: true,
					})
				}

				return resolve({
					success: true,
					coordinates, // [longitude, latitude]
					latitude: lat,
					longitude: lng,
					accuracy,
					error: null,
					fallbackRequired: false,
				})
			},
			(err) => {
				let code = GEO_ERROR_CODES.POSITION_UNAVAILABLE

				if (err.code === 1) {
					code = GEO_ERROR_CODES.PERMISSION_DENIED
				} else if (err.code === 2) {
					code = GEO_ERROR_CODES.POSITION_UNAVAILABLE
				} else if (err.code === 3) {
					code = GEO_ERROR_CODES.TIMEOUT
				}

				return resolve({
					success: false,
					coordinates: null,
					error: {
						code,
						message: ERROR_MESSAGES[code] || err.message,
						originalError: err,
					},
					fallbackRequired: true,
				})
			},
			defaultOptions
		)
	})
}

/**
 * Formats a distance in kilometers into a human-readable string.
 *
 * @param {number} distanceKm
 * @returns {string} e.g. "450 m" or "3.5 km"
 */
export function formatDistance(distanceKm) {
	if (typeof distanceKm !== 'number' || isNaN(distanceKm) || distanceKm < 0) {
		return 'Distance unknown'
	}

	if (distanceKm < 1) {
		const meters = Math.round(distanceKm * 1000)
		return `${meters} m`
	}

	return `${distanceKm.toFixed(1)} km`
}

/**
 * Calculates great-circle distance between two [longitude, latitude] points in kilometers.
 *
 * @param {[number, number]} coord1 - [longitude, latitude]
 * @param {[number, number]} coord2 - [longitude, latitude]
 * @returns {number} Distance in kilometers
 */
export function calculateHaversineDistanceKm(coord1, coord2) {
	if (!validateCoordinates(coord1) || !validateCoordinates(coord2)) {
		return 0
	}

	const [lon1, lat1] = coord1
	const [lon2, lat2] = coord2
	const R = 6371 // Earth radius in km

	const dLat = ((lat2 - lat1) * Math.PI) / 180
	const dLon = ((lon2 - lon1) * Math.PI) / 180

	const lat1Rad = (lat1 * Math.PI) / 180
	const lat2Rad = (lat2 * Math.PI) / 180

	const a =
		Math.sin(dLat / 2) * Math.sin(dLat / 2) +
		Math.cos(lat1Rad) * Math.cos(lat2Rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2)

	const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
	return Math.round(R * c * 100) / 100
}

/**
 * Prepares a structured manual City/State fallback payload when geolocation is disabled or unavailable.
 *
 * @param {string} city
 * @param {string} state
 * @returns {Object} Fallback query descriptor
 */
export function getCityStateFallback(city = '', state = '') {
	return {
		isGeospatial: false,
		city: city.trim(),
		state: state.trim(),
		canFallback: Boolean(city.trim() && state.trim()),
	}
}
