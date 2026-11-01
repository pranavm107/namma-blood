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

const { EmergencyDonorProfile } = require('./emergencyDonorProfileModel')
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

module.exports = {
	discoverNearbyDonors,
	escapeRegex,
}
