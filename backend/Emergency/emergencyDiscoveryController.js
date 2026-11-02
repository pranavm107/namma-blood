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

module.exports = {
	getNearbyDonors,
	getNearbyBloodbanks,
}
