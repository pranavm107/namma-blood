/**
 * Emergency Discovery Controller
 * Namma Blood — Emergency Blood Connection (Milestone 4.3)
 *
 * REST Controller for Emergency Blood Donor Discovery
 */

const catchAsync = require('../Utils/catchAsync')
const {
	discoverNearbyDonors,
	discoverNearbyBloodbanks,
} = require('./emergencyDiscoveryService')
const { findEmergencyRequestMatches } = require('./emergencyMatchingService')
const { VALID_BLOOD_GROUPS, VALID_COMPONENT_TYPES } = require('../BloodUnit/bloodUnitModel')

/**
 * Controller handler for GET /api/emergency/discover/donors
 */
const getNearbyDonors = catchAsync(async (req, res) => {
	// 1. Guard against NoSQL injection via malicious query keys or nested query operators
	for (const key of Object.keys(req.query)) {
		if (key.startsWith('$') || key.includes('.')) {
			return res.status(400).json({
				status: 'fail',
				message: `Forbidden query operator or key: '${key}'.`,
			})
		}
		const val = req.query[key]
		if (typeof val === 'object' && val !== null) {
			return res.status(400).json({
				status: 'fail',
				message: `Invalid query parameter for '${key}'. Nested query objects are not allowed.`,
			})
		}
	}

	// 2. Extract and validate blood group
	const bloodGroup = req.query.bloodGroup
	if (!bloodGroup || typeof bloodGroup !== 'string' || !bloodGroup.trim()) {
		return res.status(400).json({
			status: 'fail',
			message: `Recipient blood group is mandatory. Allowed groups: ${VALID_BLOOD_GROUPS.join(', ')}`,
		})
	}

	const trimmedBloodGroup = bloodGroup.trim()
	if (!VALID_BLOOD_GROUPS.includes(trimmedBloodGroup)) {
		return res.status(400).json({
			status: 'fail',
			message: `Invalid blood group '${trimmedBloodGroup}'. Allowed groups: ${VALID_BLOOD_GROUPS.join(', ')}`,
		})
	}

	// 3. Extract and validate component type
	const rawComponent = req.query.componentType || req.query.component || 'Packed_Red_Blood_Cells'
	const trimmedComponent = typeof rawComponent === 'string' ? rawComponent.trim() : ''

	if (!VALID_COMPONENT_TYPES.includes(trimmedComponent)) {
		return res.status(400).json({
			status: 'fail',
			message: `Unsupported component type '${trimmedComponent}'. Allowed components: ${VALID_COMPONENT_TYPES.join(', ')}`,
		})
	}

	// 4. Extract and validate search radius
	const rawRadius = req.query.radiusKm !== undefined ? req.query.radiusKm : (req.query.radius !== undefined ? req.query.radius : 15)
	const parsedRadius = Number(rawRadius)

	if (isNaN(parsedRadius) || parsedRadius < 1 || parsedRadius > 50) {
		return res.status(400).json({
			status: 'fail',
			message: 'Search radius must be a numeric value between 1 and 50 km.',
		})
	}

	// 5. Extract and validate geospatial coordinates
	const rawLat = req.query.latitude !== undefined ? req.query.latitude : req.query.lat
	const rawLng = req.query.longitude !== undefined ? req.query.longitude : (req.query.lng !== undefined ? req.query.lng : req.query.lon)

	const hasLat = rawLat !== undefined && rawLat !== null && String(rawLat).trim() !== ''
	const hasLng = rawLng !== undefined && rawLng !== null && String(rawLng).trim() !== ''

	// Ensure both coordinates are supplied if either is present
	if ((hasLat && !hasLng) || (!hasLat && hasLng)) {
		return res.status(400).json({
			status: 'fail',
			message: 'Both latitude and longitude must be provided for geospatial discovery.',
		})
	}

	let parsedLat = null
	let parsedLng = null

	if (hasLat && hasLng) {
		parsedLat = Number(rawLat)
		parsedLng = Number(rawLng)

		if (isNaN(parsedLat) || isNaN(parsedLng)) {
			return res.status(400).json({
				status: 'fail',
				message: 'Invalid coordinates: latitude and longitude must be numeric values.',
			})
		}

		if (parsedLat < -90 || parsedLat > 90) {
			return res.status(400).json({
				status: 'fail',
				message: 'Latitude must be between -90 and +90 degrees.',
			})
		}

		if (parsedLng < -180 || parsedLng > 180) {
			return res.status(400).json({
				status: 'fail',
				message: 'Longitude must be between -180 and +180 degrees.',
			})
		}
	} else {
		// Fallback mode: require city or state
		const cleanCity = typeof req.query.city === 'string' ? req.query.city.trim() : ''
		const cleanState = typeof req.query.state === 'string' ? req.query.state.trim() : ''

		if (!cleanCity && !cleanState) {
			return res.status(400).json({
				status: 'fail',
				message: 'Either coordinates (latitude & longitude) or administrative location (city and/or state) must be provided.',
			})
		}

		if (cleanCity.length > 100 || cleanState.length > 100) {
			return res.status(400).json({
				status: 'fail',
				message: 'City and state parameters must not exceed 100 characters in length.',
			})
		}
	}

	// 6. Validate pagination parameters
	if (req.query.limit !== undefined) {
		const parsedLimit = Number(req.query.limit)
		if (isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 50) {
			return res.status(400).json({
				status: 'fail',
				message: 'Page limit must be an integer between 1 and 50.',
			})
		}
	}

	if (req.query.page !== undefined) {
		const parsedPage = Number(req.query.page)
		if (isNaN(parsedPage) || parsedPage < 1) {
			return res.status(400).json({
				status: 'fail',
				message: 'Page number must be a positive integer greater than or equal to 1.',
			})
		}
	}

	// 7. Invoke discovery service
	const discoveryResult = await discoverNearbyDonors({
		latitude: parsedLat,
		longitude: parsedLng,
		radiusKm: parsedRadius,
		bloodGroup: trimmedBloodGroup,
		componentType: trimmedComponent,
		city: req.query.city,
		state: req.query.state,
		page: req.query.page,
		limit: req.query.limit,
	})

	return res.status(200).json(discoveryResult)
})

/**
 * Controller handler for GET /api/emergency/discover/bloodbanks
 */
const getNearbyBloodbanks = catchAsync(async (req, res) => {
	// 1. Guard against NoSQL injection via malicious query keys or nested query operators
	for (const key of Object.keys(req.query)) {
		if (key.startsWith('$') || key.includes('.')) {
			return res.status(400).json({
				status: 'fail',
				message: `Forbidden query operator or key: '${key}'.`,
			})
		}
		const val = req.query[key]
		if (typeof val === 'object' && val !== null) {
			return res.status(400).json({
				status: 'fail',
				message: `Invalid query parameter for '${key}'. Nested query objects are not allowed.`,
			})
		}
	}

	// 2. Extract and validate blood group (optional)
	let trimmedBloodGroup = undefined
	if (req.query.bloodGroup !== undefined) {
		const bloodGroup = req.query.bloodGroup
		if (typeof bloodGroup !== 'string' || !bloodGroup.trim()) {
			return res.status(400).json({
				status: 'fail',
				message: `Blood group must be a valid string if provided. Allowed groups: ${VALID_BLOOD_GROUPS.join(', ')}`,
			})
		}
		trimmedBloodGroup = bloodGroup.trim()
		if (!VALID_BLOOD_GROUPS.includes(trimmedBloodGroup)) {
			return res.status(400).json({
				status: 'fail',
				message: `Invalid blood group '${trimmedBloodGroup}'. Allowed groups: ${VALID_BLOOD_GROUPS.join(', ')}`,
			})
		}
	}

	// 3. Extract and validate component type (optional)
	let trimmedComponent = undefined
	const rawComponent = req.query.componentType || req.query.component
	if (rawComponent !== undefined) {
		if (typeof rawComponent !== 'string' || !rawComponent.trim()) {
			return res.status(400).json({
				status: 'fail',
				message: `Component type must be a valid string if provided. Allowed components: ${VALID_COMPONENT_TYPES.join(', ')}`,
			})
		}
		trimmedComponent = rawComponent.trim()
		if (!VALID_COMPONENT_TYPES.includes(trimmedComponent)) {
			return res.status(400).json({
				status: 'fail',
				message: `Unsupported component type '${trimmedComponent}'. Allowed components: ${VALID_COMPONENT_TYPES.join(', ')}`,
			})
		}
	}

	// 4. Extract and validate search radius
	const rawRadius =
		req.query.radiusKm !== undefined
			? req.query.radiusKm
			: (req.query.radius !== undefined ? req.query.radius : 15)
	const parsedRadius = Number(rawRadius)

	if (isNaN(parsedRadius) || parsedRadius < 1 || parsedRadius > 50) {
		return res.status(400).json({
			status: 'fail',
			message: 'Search radius must be a numeric value between 1 and 50 km.',
		})
	}

	// 5. Extract and validate geospatial coordinates
	const rawLat = req.query.latitude !== undefined ? req.query.latitude : req.query.lat
	const rawLng =
		req.query.longitude !== undefined
			? req.query.longitude
			: (req.query.lng !== undefined ? req.query.lng : req.query.lon)

	const hasLat = rawLat !== undefined && rawLat !== null && String(rawLat).trim() !== ''
	const hasLng = rawLng !== undefined && rawLng !== null && String(rawLng).trim() !== ''

	// Ensure both coordinates are supplied if either is present
	if ((hasLat && !hasLng) || (!hasLat && hasLng)) {
		return res.status(400).json({
			status: 'fail',
			message: 'Both latitude and longitude must be provided for geospatial discovery.',
		})
	}

	let parsedLat = null
	let parsedLng = null

	if (hasLat && hasLng) {
		parsedLat = Number(rawLat)
		parsedLng = Number(rawLng)

		if (isNaN(parsedLat) || isNaN(parsedLng)) {
			return res.status(400).json({
				status: 'fail',
				message: 'Invalid coordinates: latitude and longitude must be numeric values.',
			})
		}

		if (parsedLat < -90 || parsedLat > 90) {
			return res.status(400).json({
				status: 'fail',
				message: 'Latitude must be between -90 and +90 degrees.',
			})
		}

		if (parsedLng < -180 || parsedLng > 180) {
			return res.status(400).json({
				status: 'fail',
				message: 'Longitude must be between -180 and +180 degrees.',
			})
		}
	} else {
		// Fallback mode: require city or state
		const cleanCity = typeof req.query.city === 'string' ? req.query.city.trim() : ''
		const cleanState = typeof req.query.state === 'string' ? req.query.state.trim() : ''

		if (!cleanCity && !cleanState) {
			return res.status(400).json({
				status: 'fail',
				message:
					'Either coordinates (latitude & longitude) or administrative location (city and/or state) must be provided.',
			})
		}

		if (cleanCity.length > 100 || cleanState.length > 100) {
			return res.status(400).json({
				status: 'fail',
				message: 'City and state parameters must not exceed 100 characters in length.',
			})
		}
	}

	// 6. Validate pagination parameters
	if (req.query.limit !== undefined) {
		const parsedLimit = Number(req.query.limit)
		if (isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 50) {
			return res.status(400).json({
				status: 'fail',
				message: 'Page limit must be an integer between 1 and 50.',
			})
		}
	}

	if (req.query.page !== undefined) {
		const parsedPage = Number(req.query.page)
		if (isNaN(parsedPage) || parsedPage < 1) {
			return res.status(400).json({
				status: 'fail',
				message: 'Page number must be a positive integer greater than or equal to 1.',
			})
		}
	}

	// 7. Invoke discovery service
	const discoveryResult = await discoverNearbyBloodbanks({
		latitude: parsedLat,
		longitude: parsedLng,
		radiusKm: parsedRadius,
		bloodGroup: trimmedBloodGroup,
		componentType: trimmedComponent,
		city: req.query.city,
		state: req.query.state,
		page: req.query.page,
		limit: req.query.limit,
	})

	return res.status(200).json(discoveryResult)
})

/**
 * Controller handler for GET /api/emergency/requests/:id/matches
 * Sub-Milestone 4.3.3.4: Request-Centric Emergency Matching Engine
 *
 * Core Capabilities:
 * 1. Resolves request by MongoDB ObjectId or formatted requestNumber.
 * 2. Enforces strict BOLA/IDOR authorization using authenticated req.user / req.staff context.
 * 3. Enforces anti-enumeration security: missing and unauthorized requests return identical 404 responses.
 * 4. Validates request lifecycle and shortfall data integrity.
 * 5. Integrates dual-stream discovery engine with 128-bit truncated HMAC references.
 * 6. Guarantees zero database mutations (strictly read-only).
 */
const getRequestMatches = catchAsync(async (req, res) => {
	// 1. Guard against NoSQL injection via malicious query keys or nested query operators
	const query = req.query || {}
	for (const key of Object.keys(query)) {
		if (key.startsWith('$') || key.includes('.')) {
			return res.status(400).json({
				status: 'fail',
				message: 'Forbidden query operator or key. Query operators and nested keys are not permitted.',
			})
		}
		const val = query[key]
		if (typeof val === 'object' && val !== null) {
			return res.status(400).json({
				status: 'fail',
				message: 'Invalid query parameter: nested query objects are not permitted.',
			})
		}
	}

	// 2. Validate request identifier parameter (:id)
	const requestId = req.params ? req.params.id : undefined
	if (!requestId || typeof requestId !== 'string' || !requestId.trim()) {
		return res.status(400).json({
			status: 'fail',
			code: 'INVALID_REQUEST_IDENTIFIER',
			message: 'The emergency request identifier is invalid.',
		})
	}

	// 3. Validate optional search radius
	let radiusKm = 15
	if (req.query.radiusKm !== undefined || req.query.radius !== undefined) {
		const rawRadius = req.query.radiusKm !== undefined ? req.query.radiusKm : req.query.radius
		const parsedRadius = Number(rawRadius)
		if (isNaN(parsedRadius) || parsedRadius < 1 || parsedRadius > 50) {
			return res.status(400).json({
				status: 'fail',
				message: 'Search radius must be a numeric value between 1 and 50 km.',
			})
		}
		radiusKm = parsedRadius
	}

	// 4. Validate pagination parameters
	const options = {
		radiusKm,
	}

	if (req.query.donorLimit !== undefined) {
		const parsed = Number(req.query.donorLimit)
		if (isNaN(parsed) || parsed < 1 || parsed > 50) {
			return res.status(400).json({
				status: 'fail',
				message: 'Donor page limit must be an integer between 1 and 50.',
			})
		}
		options.donorLimit = parsed
	}

	if (req.query.donorPage !== undefined) {
		const parsed = Number(req.query.donorPage)
		if (isNaN(parsed) || parsed < 1) {
			return res.status(400).json({
				status: 'fail',
				message: 'Donor page number must be a positive integer greater than or equal to 1.',
			})
		}
		options.donorPage = parsed
	}

	if (req.query.bankLimit !== undefined) {
		const parsed = Number(req.query.bankLimit)
		if (isNaN(parsed) || parsed < 1 || parsed > 50) {
			return res.status(400).json({
				status: 'fail',
				message: 'Blood bank page limit must be an integer between 1 and 50.',
			})
		}
		options.bankLimit = parsed
	}

	if (req.query.bankPage !== undefined) {
		const parsed = Number(req.query.bankPage)
		if (isNaN(parsed) || parsed < 1) {
			return res.status(400).json({
				status: 'fail',
				message: 'Blood bank page number must be a positive integer greater than or equal to 1.',
			})
		}
		options.bankPage = parsed
	}

	// 5. Build strict authContext from authenticated request (NEVER trust client query params)
	const authContext = {
		user: req.user,
		userRole: req.userRole,
		staff: req.staff,
	}

	// 6. Invoke matching engine with error boundary
	try {
		const matchingResult = await findEmergencyRequestMatches(requestId.trim(), authContext, options)

		return res.status(200).json({
			status: 'success',
			data: matchingResult,
			...matchingResult,
		})
	} catch (err) {
		// Safe, non-leaking error responses
		const statusCode = err.statusCode || (err.status === 'fail' ? 400 : 500)

		// Indistinguishable 404 response (Anti-enumeration security)
		// Internal audit fields (isAuthorizationDenial, internalCode) are NEVER leaked
		if (statusCode === 404 || err.code === 'REQUEST_NOT_FOUND') {
			return res.status(404).json({
				status: 'fail',
				code: 'REQUEST_NOT_FOUND',
				message: 'Emergency blood request was not found.',
			})
		}

		// Account deactivated / staff inactive / authentication required
		if (statusCode === 401) {
			return res.status(401).json({
				status: 'fail',
				code: err.code || 'AUTHENTICATION_REQUIRED',
				message: err.message,
			})
		}

		// Invalid request identifier (400)
		if (err.code === 'INVALID_REQUEST_IDENTIFIER') {
			return res.status(400).json({
				status: 'fail',
				code: 'INVALID_REQUEST_IDENTIFIER',
				message: 'The emergency request identifier is invalid.',
			})
		}

		// Operational validation / lifecycle errors (400)
		if (statusCode >= 400 && statusCode < 500) {
			return res.status(statusCode).json({
				status: 'fail',
				code: err.code || 'VALIDATION_ERROR',
				message: err.message,
			})
		}

		// Data integrity violations (500)
		if (err.code === 'DATA_INTEGRITY_VIOLATION') {
			return res.status(500).json({
				status: 'error',
				code: 'DATA_INTEGRITY_VIOLATION',
				message: err.message,
			})
		}

		// HMAC configuration failures (500)
		if (err.code === 'HMAC_CONFIG_INVALID') {
			return res.status(500).json({
				status: 'error',
				code: 'HMAC_CONFIG_INVALID',
				message: 'Cryptographic configuration failure: HMAC configuration is invalid.',
			})
		}

		// Internal server error: Never leak stack traces, database credentials, or internal details
		console.error('Matching Controller Error:', err.message)
		return res.status(500).json({
			status: 'error',
			code: 'INTERNAL_SERVER_ERROR',
			message: 'An internal error occurred while processing emergency request matches.',
		})
	}
})

module.exports = {
	getNearbyDonors,
	getNearbyBloodbanks,
	getRequestMatches,
}
