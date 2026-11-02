/**
 * Emergency Discovery Service
 * Namma Blood — Emergency Blood Connection (Milestone 4.3)
 *
 * Location-Based Donor Discovery & Presumptive Compatibility Integration
 *
 * Clinical & Privacy Invariants:
 * 1. Presumptive compatibility only: calls compatibilityEngine.getCompatibleDonorGroups
 *    to resolve immunohematologically compatible donor groups.
 * 2. Never authorizes donation, collection, reservation, or dispatch.
 * 3. Excludes temporarily and permanently deferred donors.
 * 4. Flags Pending_Clinical_Evaluation donors with mandatory clinical evaluation advisories.
 * 5. Privacy Shield: Strips all raw fuzzed coordinates, residential addresses, push keys,
 *    and PII. Only approximate distance (approxDistanceKm) and administrative geography are output.
 */

const crypto = require('crypto')
const { EmergencyDonorProfile } = require('./emergencyDonorProfileModel')
const Bloodbank = require('../BloodBank/bloodbankModel')
const stockService = require('../BloodStock/stockService')
const { VALID_BLOOD_GROUPS, VALID_COMPONENT_TYPES } = require('../BloodUnit/bloodUnitModel')
const {
	getCompatibleDonorGroups,
	parseBloodGroup,
	COMPATIBILITY_SPEC_VERSION,
	CLINICAL_AUTHORITY,
} = require('./compatibilityEngine')
const { calculateHaversineDistanceKm } = require('./geoValidation')

/**
 * Escapes special characters for safe regular expression querying.
 * Prevents regex injection and ReDoS vulnerabilities in administrative searches.
 *
 * @param {string} text
 * @returns {string}
 */
function escapeRegex(text) {
	if (!text || typeof text !== 'string') return ''
	return text.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')
}

/**
 * Discovers nearby compatible emergency blood donors.
 *
 * @param {Object} params
 * @param {number} [params.latitude] - Client search latitude [-90, 90]
 * @param {number} [params.longitude] - Client search longitude [-180, 180]
 * @param {number} [params.radiusKm=15] - Search radius in km [1, 50]
 * @param {string} params.bloodGroup - Recipient blood group
 * @param {string} [params.componentType='Packed_Red_Blood_Cells'] - Requested blood component
 * @param {string} [params.city] - Fallback city name
 * @param {string} [params.state] - Fallback state name
 * @param {number} [params.page=1] - 1-based page number
 * @param {number} [params.limit=10] - Page size limit [1, 50]
 * @returns {Promise<Object>} Discovery search response
 */
async function discoverNearbyDonors({
	latitude,
	longitude,
	radiusKm = 15,
	bloodGroup,
	componentType = 'Packed_Red_Blood_Cells',
	city,
	state,
	page = 1,
	limit = 10,
}) {
	// 1. Resolve immunohematologically compatible donor groups
	const compatResult = getCompatibleDonorGroups({
		recipientGroup: bloodGroup,
		componentType,
	})

	const compatibleGroups = compatResult.compatibleGroups
	const preferredGroup = compatResult.preferredGroup

	// 2. Validate search mode (Geospatial vs Administrative Fallback)
	const hasLatitude = latitude !== undefined && latitude !== null
	const hasLongitude = longitude !== undefined && longitude !== null

	if ((hasLatitude && !hasLongitude) || (!hasLatitude && hasLongitude)) {
		const err = new Error('Both latitude and longitude must be provided for geospatial discovery.')
		err.code = 'INCOMPLETE_COORDINATES'
		err.statusCode = 400
		throw err
	}

	const isGeospatial = hasLatitude && hasLongitude
	let searchPoint = null

	if (isGeospatial) {
		const lat = Number(latitude)
		const lng = Number(longitude)

		if (isNaN(lat) || isNaN(lng)) {
			const err = new Error('Invalid coordinates: latitude and longitude must be numeric values.')
			err.code = 'INVALID_COORDINATES'
			err.statusCode = 400
			throw err
		}

		if (lat < -90 || lat > 90) {
			const err = new Error('Latitude must be between -90 and +90 degrees.')
			err.code = 'LATITUDE_OUT_OF_BOUNDS'
			err.statusCode = 400
			throw err
		}

		if (lng < -180 || lng > 180) {
			const err = new Error('Longitude must be between -180 and +180 degrees.')
			err.code = 'LONGITUDE_OUT_OF_BOUNDS'
			err.statusCode = 400
			throw err
		}

		searchPoint = [lng, lat]
	} else {
		// Fallback mode requires at least city or state
		const cleanCity = typeof city === 'string' ? city.trim() : ''
		const cleanState = typeof state === 'string' ? state.trim() : ''

		if (!cleanCity && !cleanState) {
			const err = new Error(
				'Either valid coordinates (latitude and longitude) or administrative fallback location (city and/or state) must be provided.'
			)
			err.code = 'MISSING_SEARCH_LOCATION'
			err.statusCode = 400
			throw err
		}

		if (cleanCity.length > 100 || cleanState.length > 100) {
			const err = new Error('City and state names must not exceed 100 characters.')
			err.code = 'LOCATION_STRING_TOO_LONG'
			err.statusCode = 400
			throw err
		}
	}

	// 3. Build MongoDB query
	const now = new Date()

	// Base criteria: Voluntary opt-in + self-reported Ready + compatible blood group
	const baseQuery = {
		isEmergencyDonor: true,
		availabilityStatus: 'Ready',
		bloodGroup: { $in: compatibleGroups },
		clinicalEligibilityStatus: {
			$nin: ['Temporarily_Deferred', 'Permanently_Deferred'],
		},
		$or: [
			{ eligibleToDonateAfter: null },
			{ eligibleToDonateAfter: { $lte: now } },
		],
	}

	// Count query mirror (used for accurate pagination count)
	const countQuery = { ...baseQuery }

	if (isGeospatial) {
		const maxDistanceMeters = radiusKm * 1000

		// $nearSphere on 2dsphere index orders results by proximity ascending
		baseQuery.location = {
			$nearSphere: {
				$geometry: {
					type: 'Point',
					coordinates: searchPoint,
				},
				$maxDistance: maxDistanceMeters,
			},
		}

		// MongoDB does not allow $nearSphere in countDocuments; use $geoWithin with $centerSphere
		// Earth radius = 6371 km
		countQuery.location = {
			$geoWithin: {
				$centerSphere: [searchPoint, radiusKm / 6371],
			},
		}
	} else {
		if (city && typeof city === 'string' && city.trim()) {
			baseQuery.city = { $regex: new RegExp(`^${escapeRegex(city.trim())}$`, 'i') }
			countQuery.city = baseQuery.city
		}
		if (state && typeof state === 'string' && state.trim()) {
			baseQuery.state = { $regex: new RegExp(`^${escapeRegex(state.trim())}$`, 'i') }
			countQuery.state = baseQuery.state
		}
	}

	// 4. Execute queries with pagination
	const safePage = Math.max(1, parseInt(page, 10) || 1)
	const safeLimit = Math.max(1, Math.min(50, parseInt(limit, 10) || 10))
	const skip = (safePage - 1) * safeLimit

	const [totalCount, donorDocs] = await Promise.all([
		EmergencyDonorProfile.countDocuments(countQuery),
		EmergencyDonorProfile.find(baseQuery).skip(skip).limit(safeLimit).lean(),
	])

	// 5. Post-process and sanitize donor results (Privacy Shield & Governance Enrichment)
	const sanitizedDonors = donorDocs.map((donor) => {
		let approxDistanceKm = null
		let withinDonorTravelRadius = null

		if (isGeospatial && donor.location && Array.isArray(donor.location.coordinates)) {
			approxDistanceKm = calculateHaversineDistanceKm(
				searchPoint,
				donor.location.coordinates
			)
			withinDonorTravelRadius = approxDistanceKm <= (donor.maxTravelDistanceKm || 15)
		}

		const matchQuality =
			donor.bloodGroup === preferredGroup ? 'Identical' : 'Compatible_Alternative'

		// Clinical Governance Notice
		let clinicalNotice = ''
		if (donor.clinicalEligibilityStatus === 'Clinically_Cleared') {
			clinicalNotice =
				'Donor verified clinically cleared by Medical Officer review. Final laboratory crossmatching and pre-transfusion verification remain mandatory.'
		} else {
			clinicalNotice =
				'Self-reported availability only. Clinical evaluation, TTI screening, and pre-donation medical examination are mandatory before blood collection. This prospective match does not constitute clinical eligibility.'
		}

		// Explainable Ranking Description
		const rankingExplanation =
			(matchQuality === 'Identical' ? 'ABO/Rh identical match' : 'Compatible alternative match') +
			` (${donor.bloodGroup}), ` +
			(donor.clinicalEligibilityStatus === 'Clinically_Cleared'
				? 'verified clinical clearance'
				: 'pending clinical evaluation') +
			(approxDistanceKm !== null
				? `, approx distance ${approxDistanceKm} km.`
				: ' (administrative location match).')

		// PRIVACY SHIELD: Strictly exclude exact coordinates, user IDs, push keys, residential addresses, and profile IDs
		return {
			bloodGroup: donor.bloodGroup,
			matchQuality,
			approxDistanceKm,
			withinDonorTravelRadius,
			maxTravelDistanceKm: donor.maxTravelDistanceKm || 15,
			availabilityStatus: donor.availabilityStatus,
			clinicalEligibilityStatus: donor.clinicalEligibilityStatus,
			clinicalNotice,
			city: donor.city,
			state: donor.state,
			rankingExplanation,
		}
	})

	const totalPages = Math.ceil(totalCount / safeLimit) || 1

	return {
		searchCriteria: {
			isGeospatial,
			radiusKm: isGeospatial ? radiusKm : null,
			recipientBloodGroup: compatResult.recipientGroup,
			requestedComponent: componentType,
			compatibleDonorGroups: compatResult.compatibleGroups,
			preferredGroup: compatResult.preferredGroup,
			city: city ? city.trim() : null,
			state: state ? state.trim() : null,
		},
		pagination: {
			page: safePage,
			limit: safeLimit,
			totalCount,
			totalPages,
			hasNextPage: safePage < totalPages,
			hasPrevPage: safePage > 1,
		},
		data: sanitizedDonors,
		governance: {
			ruleVersion: COMPATIBILITY_SPEC_VERSION,
			clinicalAuthority: CLINICAL_AUTHORITY,
			isPresumptiveImmunohematologyCheck: true,
			cannotAuthorizeDonation: true,
			cannotAuthorizeDispatch: true,
			requiresLaboratoryCrossmatch: true,
			disclaimer:
				'Presumptive donor discovery only. Donor discovery indicates geographical proximity and self-reported communication availability. It does NOT constitute clinical donor eligibility, blood collection authorization, unit reservation, or transfusion clearance. Pre-donation clinical screening, TTI testing, and pre-transfusion serological crossmatching remain mandatory under NBTC standards and Drugs & Cosmetics Rules.',
		},
	}
}

/**
 * Derives a deterministic, opaque public discovery reference for a blood bank.
 * Avoids exposing raw 24-character hex MongoDB ObjectIds in public discovery responses.
 *
 * Format: BB-XXXXXXXXXXXX (12-character uppercase alphanumeric hex string)
 *
 * @param {string|mongoose.Types.ObjectId} bloodbankId
 * @returns {string} Public facility reference
 */
function derivePublicFacilityReference(bloodbankId) {
	if (!bloodbankId) return ''
	const rawId = bloodbankId.toString()
	const hash = crypto
		.createHash('sha256')
		.update(`namma_blood_facility_public_ref_${rawId}`)
		.digest('hex')
		.slice(0, 12)
		.toUpperCase()
	return `BB-${hash}`
}

/**
 * Dedicated response sanitizer for blood bank discovery.
 * Strictly strips staff credentials, personal contact info, passwords, token versions,
 * MongoDB internals, and database connection data.
 *
 * Exposes only approved public facility information with a scoped public facilityRef
 * rather than internal MongoDB ObjectIds.
 *
 * @param {Object} bank - Blood bank document
 * @param {Object} meta - Proximity and inventory verification metadata
 * @returns {Object} Sanitized blood bank discovery response
 */
function sanitizeBloodBankForDiscovery(bank, {
	approxDistanceKm = null,
	inventoryTrustStatus = 'Inventory_Unverified',
	verifiedUnitsAvailable = null,
	availableComponentCategories = [],
	inventoryNotice = '',
	verifiedStockByGroup = null,
} = {}) {
	return {
		facilityRef: derivePublicFacilityReference(bank._id),
		bloodbankName: bank.bloodbankName || '',
		category: bank.category || '',
		address: [bank.address1, bank.address2].filter(Boolean).join(', '),
		city: bank.city || '',
		state: bank.state || '',
		pinCode: bank.pinCode || null,
		phoneNo1: bank.phoneNo1 || '',
		phoneNo2: bank.phoneNo2 || '',
		email: bank.email || '',
		operatingStatus: bank.status !== false ? 'Active' : 'Inactive',
		approxDistanceKm,
		distanceKm: approxDistanceKm,
		isDistanceApproximate: approxDistanceKm !== null,
		inventoryTrustStatus,
		verifiedUnitsAvailable,
		availableComponentCategories,
		inventoryNotice,
		verifiedStockByGroup,
	}
}

/**
 * Discovers nearby registered blood banks and queries verified traceable inventory.
 *
 * Invariants:
 * 1. Only active blood banks (status: true) are surfaced.
 * 2. Proximity ordering via geospatial $nearSphere index.
 * 3. Verified inventory uses stockService.getTraceableAvailableStock meeting all Phase 3 gates.
 * 4. Fails closed with Inventory_Unverified (null count) when inventory cannot be reliably verified.
 * 5. City/State fallback when GPS coordinates are unavailable.
 *
 * @param {Object} params
 * @param {number} [params.latitude] - Client search latitude [-90, 90]
 * @param {number} [params.longitude] - Client search longitude [-180, 180]
 * @param {number} [params.radiusKm=15] - Search radius in km [1, 50]
 * @param {string} [params.bloodGroup] - Optional blood group filter
 * @param {string} [params.componentType] - Optional blood component filter
 * @param {string} [params.city] - Fallback city name
 * @param {string} [params.state] - Fallback state name
 * @param {number} [params.page=1] - 1-based page number
 * @param {number} [params.limit=10] - Page size limit [1, 50]
 * @returns {Promise<Object>} Discovery search response
 */
async function discoverNearbyBloodbanks({
	latitude,
	longitude,
	radiusKm = 15,
	bloodGroup,
	componentType,
	city,
	state,
	page = 1,
	limit = 10,
}) {
	// 1. Validate search mode (Geospatial vs Administrative Fallback)
	const hasLatitude = latitude !== undefined && latitude !== null
	const hasLongitude = longitude !== undefined && longitude !== null

	if ((hasLatitude && !hasLongitude) || (!hasLatitude && hasLongitude)) {
		const err = new Error('Both latitude and longitude must be provided for geospatial discovery.')
		err.code = 'INCOMPLETE_COORDINATES'
		err.statusCode = 400
		throw err
	}

	const isGeospatial = hasLatitude && hasLongitude
	let searchPoint = null

	if (isGeospatial) {
		const lat = Number(latitude)
		const lng = Number(longitude)

		if (isNaN(lat) || isNaN(lng)) {
			const err = new Error('Invalid coordinates: latitude and longitude must be numeric values.')
			err.code = 'INVALID_COORDINATES'
			err.statusCode = 400
			throw err
		}

		if (lat < -90 || lat > 90) {
			const err = new Error('Latitude must be between -90 and +90 degrees.')
			err.code = 'LATITUDE_OUT_OF_BOUNDS'
			err.statusCode = 400
			throw err
		}

		if (lng < -180 || lng > 180) {
			const err = new Error('Longitude must be between -180 and +180 degrees.')
			err.code = 'LONGITUDE_OUT_OF_BOUNDS'
			err.statusCode = 400
			throw err
		}

		searchPoint = [lng, lat]
	} else {
		// Fallback mode requires at least city or state
		const cleanCity = typeof city === 'string' ? city.trim() : ''
		const cleanState = typeof state === 'string' ? state.trim() : ''

		if (!cleanCity && !cleanState) {
			const err = new Error(
				'Either valid coordinates (latitude and longitude) or administrative fallback location (city and/or state) must be provided.'
			)
			err.code = 'MISSING_SEARCH_LOCATION'
			err.statusCode = 400
			throw err
		}

		if (cleanCity.length > 100 || cleanState.length > 100) {
			const err = new Error('City and state names must not exceed 100 characters.')
			err.code = 'LOCATION_STRING_TOO_LONG'
			err.statusCode = 400
			throw err
		}
	}

	// 2. Validate optional filters
	if (bloodGroup && !VALID_BLOOD_GROUPS.includes(bloodGroup)) {
		const err = new Error(`Invalid blood group '${bloodGroup}'. Allowed groups: ${VALID_BLOOD_GROUPS.join(', ')}`)
		err.code = 'INVALID_BLOOD_GROUP'
		err.statusCode = 400
		throw err
	}

	if (componentType && !VALID_COMPONENT_TYPES.includes(componentType)) {
		const err = new Error(`Unsupported component type '${componentType}'. Allowed components: ${VALID_COMPONENT_TYPES.join(', ')}`)
		err.code = 'INVALID_COMPONENT_TYPE'
		err.statusCode = 400
		throw err
	}

	const parsedRadius = Number(radiusKm)
	if (isNaN(parsedRadius) || parsedRadius < 1 || parsedRadius > 50) {
		const err = new Error('Search radius must be a numeric value between 1 and 50 km.')
		err.code = 'INVALID_RADIUS'
		err.statusCode = 400
		throw err
	}

	// 3. Build MongoDB query
	const baseQuery = {
		status: true,
	}
	const countQuery = { ...baseQuery }

	if (isGeospatial) {
		const maxDistanceMeters = parsedRadius * 1000

		// $nearSphere on 2dsphere index orders results by proximity ascending
		baseQuery.location = {
			$nearSphere: {
				$geometry: {
					type: 'Point',
					coordinates: searchPoint,
				},
				$maxDistance: maxDistanceMeters,
			},
		}

		// MongoDB does not allow $nearSphere in countDocuments; use $geoWithin with $centerSphere
		countQuery.location = {
			$geoWithin: {
				$centerSphere: [searchPoint, parsedRadius / 6371],
			},
		}
	} else {
		if (city && typeof city === 'string' && city.trim()) {
			baseQuery.city = { $regex: new RegExp(`^${escapeRegex(city.trim())}$`, 'i') }
			countQuery.city = baseQuery.city
		}
		if (state && typeof state === 'string' && state.trim()) {
			baseQuery.state = { $regex: new RegExp(`^${escapeRegex(state.trim())}$`, 'i') }
			countQuery.state = baseQuery.state
		}
	}

	// 4. Execute queries with pagination
	const safePage = Math.max(1, parseInt(page, 10) || 1)
	const safeLimit = Math.max(1, Math.min(50, parseInt(limit, 10) || 10))
	const skip = (safePage - 1) * safeLimit

	let findQuery = Bloodbank.find(baseQuery)
	if (!isGeospatial) {
		findQuery = findQuery.sort({ bloodbankName: 1 })
	}

	const [totalCount, bloodbankDocs] = await Promise.all([
		Bloodbank.countDocuments(countQuery),
		findQuery.skip(skip).limit(safeLimit).lean(),
	])

	// 5. Query verified inventory and sanitize each blood bank
	const sanitizedBloodbanks = await Promise.all(
		bloodbankDocs.map(async (bank) => {
			let approxDistanceKm = null
			if (isGeospatial && bank.location && Array.isArray(bank.location.coordinates)) {
				approxDistanceKm = calculateHaversineDistanceKm(
					searchPoint,
					bank.location.coordinates
				)
			}

			let inventoryTrustStatus = 'Inventory_Unverified'
			let verifiedUnitsAvailable = null
			let availableComponentCategories = []
			let inventoryNotice = ''
			let verifiedStockByGroup = null

			try {
				// Inspect lifecycle breakdown to verify traceable inventory status
				const breakdown = await stockService.getTraceableStatusBreakdown(bank._id)

				if (
					!breakdown ||
					typeof breakdown !== 'object' ||
					typeof breakdown.totalUnits !== 'number' ||
					breakdown.totalUnits === 0
				) {
					// Facility has no traceable inventory registered on the platform
					inventoryTrustStatus = 'Inventory_Unverified'
					verifiedUnitsAvailable = null
					availableComponentCategories = []
					inventoryNotice =
						'Traceable inventory records are not available or have not been initialized for this facility. Presence in discovery does not imply stock availability.'
				} else {
					// Facility has active traceable units. Query issue-eligible stock meeting all Phase 3 safety gates.
					const [stockMap, distinctComponents] = await Promise.all([
						stockService.getTraceableAvailableStock(bank._id, {
							componentType: componentType || undefined,
							bloodGroup: bloodGroup || undefined,
						}),
						stockService.getTraceableAvailableComponents(bank._id, {
							componentType: componentType || undefined,
							bloodGroup: bloodGroup || undefined,
						}),
					])

					if (!stockMap || typeof stockMap !== 'object') {
						throw new Error('Malformed stock data returned from inventory service.')
					}

					availableComponentCategories = Array.isArray(distinctComponents) ? distinctComponents : []

					let matchingUnits = 0
					if (bloodGroup) {
						matchingUnits = Number(stockMap[bloodGroup]) || 0
						verifiedStockByGroup = { [bloodGroup]: matchingUnits }
					} else {
						matchingUnits = Object.values(stockMap).reduce((sum, c) => sum + (Number(c) || 0), 0)
						verifiedStockByGroup = stockMap
					}

					if (matchingUnits > 0) {
						inventoryTrustStatus = 'Verified_Available'
						verifiedUnitsAvailable = matchingUnits
						inventoryNotice =
							'Verified issue-eligible inventory meeting all safety standards is available.'
					} else {
						// Verified query found 0 matching issue-eligible units
						inventoryTrustStatus = 'No_Matching_Stock'
						verifiedUnitsAvailable = 0
						inventoryNotice =
							'Inventory records verified. No matching units found for the requested filter.'
					}
				}
			} catch (err) {
				// Fail-closed on any inventory lookup error, database error, or malformed data
				inventoryTrustStatus = 'Inventory_Unverified'
				verifiedUnitsAvailable = null
				availableComponentCategories = []
				verifiedStockByGroup = null
				inventoryNotice =
					'Inventory verification service is temporarily unavailable for this facility. Presence in discovery does not imply stock availability.'
			}

			return sanitizeBloodBankForDiscovery(bank, {
				approxDistanceKm,
				inventoryTrustStatus,
				verifiedUnitsAvailable,
				availableComponentCategories,
				inventoryNotice,
				verifiedStockByGroup,
			})
		})
	)

	const totalPages = Math.ceil(totalCount / safeLimit) || 1

	return {
		searchCriteria: {
			isGeospatial,
			latitude: isGeospatial ? Number(latitude) : null,
			longitude: isGeospatial ? Number(longitude) : null,
			radiusKm: isGeospatial ? parsedRadius : null,
			bloodGroup: bloodGroup || null,
			componentType: componentType || null,
			city: city ? city.trim() : null,
			state: state ? state.trim() : null,
		},
		pagination: {
			page: safePage,
			limit: safeLimit,
			totalCount,
			totalPages,
			hasNextPage: safePage < totalPages,
			hasPrevPage: safePage > 1,
		},
		data: sanitizedBloodbanks,
		governance: {
			isDiscoveryOnly: true,
			cannotAuthorizeCollection: true,
			cannotAuthorizeReservation: true,
			cannotAuthorizeIssuance: true,
			cannotAuthorizeDispatch: true,
			requiresLaboratoryCrossmatch: true,
			preservesPhase3Safeguards: true,
			disclaimer:
				'Emergency blood bank discovery service only. Discovery results indicate geographical proximity and verified traceable stock availability at the time of query. Discovery does NOT constitute blood unit reservation, issuance, dispatch authorization, or transfusion clearance. All transfusions require mandatory pre-transfusion crossmatching and clinical verification under NBTC and Drugs & Cosmetics Rules.',
		},
	}
}

module.exports = {
	discoverNearbyDonors,
	discoverNearbyBloodbanks,
	sanitizeBloodBankForDiscovery,
	derivePublicFacilityReference,
	escapeRegex,
}
