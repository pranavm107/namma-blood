const mongoose = require('mongoose')
const Bloodstock = require('./bloodStockModel')
const { BloodUnit, VALID_BLOOD_GROUPS, MANDATORY_TTI_TESTS } = require('../BloodUnit/bloodUnitModel')

/**
 * Initializes a zeroed stock object across all 8 supported blood groups.
 */
function createZeroedStockMap() {
	const map = {}
	for (const bg of VALID_BLOOD_GROUPS) {
		map[bg] = 0
	}
	return map
}

/**
 * Derives issue-eligible, verified available blood units for a blood bank.
 *
 * Strict Clinical Safety Invariants:
 * 1. Unit status MUST be 'Available'.
 * 2. Unit expiryDate MUST be strictly in the future (> now).
 * 3. Unit Medical Officer clearance MUST be verified ('clearance.isVerified' === true).
 * 4. All 5 mandatory TTI screening tests (HIV, HBV, HCV, Syphilis, Malaria) MUST be 'Non_Reactive'.
 * 5. Quarantined, Tested_Passed, Reserved, Issued, Discarded, or Expired units are NEVER included.
 *
 * @param {string|mongoose.Types.ObjectId} bloodbankId
 * @param {Object} [options]
 * @param {Date} [options.now=new Date()]
 * @param {mongoose.ClientSession} [options.session=null]
 * @returns {Promise<Object>} Map of blood groups to count of issue-eligible units
 */
async function getTraceableAvailableStock(bloodbankId, options = {}) {
	const now = options.now || new Date()
	const sessionOpt = options.session ? { session: options.session } : {}
	const bbObjectId = new mongoose.Types.ObjectId(bloodbankId)

	// Build pipeline to match strictly issue-eligible units
	const matchCriteria = {
		bloodbankId: bbObjectId,
		status: 'Available',
		expiryDate: { $gt: now },
		'clearance.isVerified': true,
	}

	for (const test of MANDATORY_TTI_TESTS) {
		matchCriteria[`testing.${test}`] = 'Non_Reactive'
	}

	const pipeline = [
		{ $match: matchCriteria },
		{
			$group: {
				_id: '$bloodGroup',
				count: { $sum: 1 },
			},
		},
	]

	const aggregateQuery = BloodUnit.aggregate(pipeline)
	if (options.session) {
		aggregateQuery.session(options.session)
	}
	const results = await aggregateQuery

	const verifiedMap = createZeroedStockMap()
	for (const row of results) {
		if (verifiedMap[row._id] !== undefined) {
			verifiedMap[row._id] = row.count
		}
	}

	return verifiedMap
}

/**
 * Retrieves the raw legacy aggregate stock document for a blood bank.
 * Kept isolated as unverified inventory.
 *
 * @param {string|mongoose.Types.ObjectId} bloodbankId
 * @param {Object} [options]
 * @returns {Promise<Object>}
 */
async function getLegacyStock(bloodbankId, options = {}) {
	const sessionOpt = options.session ? { session: options.session } : {}
	const doc = await Bloodstock.findOne({ bloodbankId }, null, sessionOpt)

	const legacyMap = createZeroedStockMap()
	if (doc) {
		for (const bg of VALID_BLOOD_GROUPS) {
			legacyMap[bg] = Number(doc[bg]) || 0
		}
	}

	return {
		_id: doc?._id || null,
		bloodbankId,
		counts: legacyMap,
	}
}

/**
 * Retrieves a full lifecycle status breakdown of traceable units for a blood bank.
 *
 * Clinical Counting Rules:
 * 1. Discarded: Permanently retired biohazard waste.
 * 2. Issued: Fulfilled units (including dispatched).
 * 3. Expired: Units with status === 'Expired' OR whose expiryDate <= now.
 * 4. Reserved: Units in active reservation hold (not expired).
 * 5. Available: Units satisfying isIssueEligible (Available + verified MO clearance + 5 TTI Non_Reactive + not expired).
 * 6. Tested_Passed: Units in Tested_Passed awaiting MO clearance (not expired).
 * 7. Quarantined: Freshly collected or migrated units awaiting infectious disease screening (not expired).
 *
 * Every traceable unit is assigned to exactly one lifecycle category (sum of categories === totalUnits).
 *
 * @param {string|mongoose.Types.ObjectId} bloodbankId
 * @param {Object} [options]
 * @returns {Promise<Object>}
 */
async function getTraceableStatusBreakdown(bloodbankId, options = {}) {
	const bbObjectId = new mongoose.Types.ObjectId(bloodbankId)
	const now = options.now || new Date()

	const pipeline = [
		{ $match: { bloodbankId: bbObjectId } },
		{
			$project: {
				category: {
					$cond: [
						{ $eq: ['$status', 'Discarded'] },
						'Discarded',
						{
							$cond: [
								{ $eq: ['$status', 'Issued'] },
								'Issued',
								{
									$cond: [
										{
											$or: [
												{ $eq: ['$status', 'Expired'] },
												{
													$and: [
														{ $ne: ['$expiryDate', null] },
														{ $lte: ['$expiryDate', now] },
													],
												},
											],
										},
										'Expired',
										{
											$cond: [
												{ $eq: ['$status', 'Reserved'] },
												'Reserved',
												{
													$cond: [
														{
															$and: [
																{ $eq: ['$status', 'Available'] },
																{ $eq: ['$clearance.isVerified', true] },
																{ $eq: ['$testing.hiv', 'Non_Reactive'] },
																{ $eq: ['$testing.hbv', 'Non_Reactive'] },
																{ $eq: ['$testing.hcv', 'Non_Reactive'] },
																{ $eq: ['$testing.syphilis', 'Non_Reactive'] },
																{ $eq: ['$testing.malaria', 'Non_Reactive'] },
															],
														},
														'Available',
														{
															$cond: [
																{ $eq: ['$status', 'Tested_Passed'] },
																'Tested_Passed',
																'Quarantined',
															],
														},
													],
												},
											],
										},
									],
								},
							],
						},
					],
				},
			},
		},
		{
			$group: {
				_id: '$category',
				count: { $sum: 1 },
			},
		},
	]

	const aggregateQuery = BloodUnit.aggregate(pipeline)
	if (options.session) {
		aggregateQuery.session(options.session)
	}
	const results = await aggregateQuery

	const breakdown = {
		Quarantined: 0,
		Tested_Passed: 0,
		Available: 0,
		Reserved: 0,
		Issued: 0,
		Discarded: 0,
		Expired: 0,
		totalUnits: 0,
	}

	for (const row of results) {
		if (breakdown[row._id] !== undefined) {
			breakdown[row._id] = row.count
			breakdown.totalUnits += row.count
		}
	}

	return breakdown
}

/**
 * Returns a consolidated inventory view that preserves backward compatibility for existing
 * frontend components while maintaining strict architectural isolation between legacy unverified
 * stock and verifiable traceable blood units.
 *
 * Safety & Compatibility Rule:
 * - If verified traceable units exist, top-level availability strictly represents verified units.
 * - If a bank only has legacy stock and their first traceable units are still in Quarantine,
 *   top-level counts preserve legacy operational visibility BUT explicitly classify the inventory as
 *   'LEGACY_WITH_QUARANTINE_INTAKE' (isVerifiedStock: false) so unverified stock is never misrepresented
 *   as verified, and quarantined units are never counted as available.
 *
 * @param {string|mongoose.Types.ObjectId} bloodbankId
 * @param {Object} [options]
 * @returns {Promise<Object>}
 */
async function getConsolidatedStock(bloodbankId, options = {}) {
	const [verifiedUnits, legacyData, breakdown] = await Promise.all([
		getTraceableAvailableStock(bloodbankId, options),
		getLegacyStock(bloodbankId, options),
		getTraceableStatusBreakdown(bloodbankId, options),
	])

	const totalVerifiedCount = Object.values(verifiedUnits).reduce(
		(sum, count) => sum + count,
		0
	)
	const totalLegacyCount = Object.values(legacyData.counts).reduce(
		(sum, count) => sum + count,
		0
	)

	const hasVerifiedUnits = totalVerifiedCount > 0
	const hasLegacyStock = totalLegacyCount > 0
	const hasTraceableUnits = breakdown.totalUnits > 0
	const hasQuarantinedOnly = hasTraceableUnits && !hasVerifiedUnits

	// Determine classification and top-level display counts
	let inventoryClassification = 'EMPTY'
	let activeCounts = verifiedUnits
	let isVerifiedStock = true
	let legacyNotice = null

	if (hasVerifiedUnits && !hasLegacyStock) {
		inventoryClassification = 'TRACEABLE_VERIFIED'
		activeCounts = verifiedUnits
		isVerifiedStock = true
	} else if (hasVerifiedUnits && hasLegacyStock) {
		inventoryClassification = 'HYBRID_TRANSITIONAL'
		activeCounts = verifiedUnits
		isVerifiedStock = true
		legacyNotice =
			'Notice: Top-level quantities reflect issue-eligible verified units only. Legacy aggregate stock is isolated in legacyUnverifiedStock.'
	} else if (hasLegacyStock && hasQuarantinedOnly) {
		inventoryClassification = 'LEGACY_WITH_QUARANTINE_INTAKE'
		activeCounts = legacyData.counts
		isVerifiedStock = false
		legacyNotice = `Notice: Top-level quantities represent unverified legacy stock. Unit intake is active, but ${breakdown.Quarantined} unit(s) are currently Quarantined awaiting infectious screening and Medical Officer clearance.`
	} else if (hasLegacyStock) {
		inventoryClassification = 'LEGACY_UNVERIFIED'
		activeCounts = legacyData.counts
		isVerifiedStock = false
		legacyNotice =
			'Notice: Inventory consists of unverified legacy aggregate quantities. Individual units have not undergone verified batch testing or Medical Officer clearance.'
	}

	return {
		_id: legacyData._id,
		bloodbankId,

		// Top-level 8 blood group integers for 100% Redux & UI compatibility:
		A_Positive: activeCounts.A_Positive,
		A_Negative: activeCounts.A_Negative,
		B_Positive: activeCounts.B_Positive,
		B_Negative: activeCounts.B_Negative,
		AB_Positive: activeCounts.AB_Positive,
		AB_Negative: activeCounts.AB_Negative,
		O_Positive: activeCounts.O_Positive,
		O_Negative: activeCounts.O_Negative,

		// Explicit, isolated inventory demarcation:
		inventoryClassification,
		isTraceableActive: hasTraceableUnits,
		isVerifiedStock,

		// Verified issue-eligible traceable stock:
		traceableVerifiedStock: verifiedUnits,

		// Legacy unverified aggregate numbers:
		legacyUnverifiedStock: legacyData.counts,

		// Complete unit lifecycle status breakdown:
		traceableStatusBreakdown: breakdown,

		// Regulatory / Clinical safety notice:
		legacyNotice,
	}
}

/**
 * Checks whether sufficient verified, issue-eligible units exist for a request.
 * Strictly ignores unverified legacy stock, quarantined units, and expired units.
 *
 * @param {string|mongoose.Types.ObjectId} bloodbankId
 * @param {string} bloodGroup
 * @param {number} [requiredUnits=1]
 * @param {Object} [options]
 * @returns {Promise<boolean>}
 */
async function checkIssueEligibleAvailability(
	bloodbankId,
	bloodGroup,
	requiredUnits = 1,
	options = {}
) {
	const validUnits = Math.max(1, Number(requiredUnits) || 1)
	const verifiedStock = await getTraceableAvailableStock(bloodbankId, options)
	return (verifiedStock[bloodGroup] || 0) >= validUnits
}

module.exports = {
	createZeroedStockMap,
	getTraceableAvailableStock,
	getLegacyStock,
	getTraceableStatusBreakdown,
	getConsolidatedStock,
	checkIssueEligibleAvailability,
}
