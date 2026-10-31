const crypto = require('crypto')
const { BloodUnit } = require('./bloodUnitModel')

const COMPONENT_SUFFIX_MAP = {
	Whole_Blood: 'WB',
	Packed_Red_Blood_Cells: 'PRBC',
	Fresh_Frozen_Plasma: 'FFP',
	Platelet_Concentrate: 'PLT',
	Cryoprecipitate: 'CRYO',
}

/**
 * Calculates the 3-digit Julian day of the year (001 - 366).
 */
function getJulianDay(date) {
	const startOfYear = new Date(Date.UTC(date.getUTCFullYear(), 0, 1))
	const diff = date - startOfYear
	const oneDay = 1000 * 60 * 60 * 24
	const dayNumber = Math.floor(diff / oneDay) + 1
	return String(dayNumber).padStart(3, '0')
}

/**
 * Builds a single formatted candidate DIN.
 * Format: DIN-[YEAR][JULIAN_DAY]-[6_CHAR_HEX]-[COMPONENT_CODE]
 * Example: DIN-2026292-8F3B91-WB
 */
function buildCandidateDIN(componentType = 'Whole_Blood', date = new Date()) {
	const year = date.getUTCFullYear()
	const julian = getJulianDay(date)
	const randomHex = crypto.randomBytes(3).toString('hex').toUpperCase()
	const suffix = COMPONENT_SUFFIX_MAP[componentType] || 'UNIT'
	return `DIN-${year}${julian}-${randomHex}-${suffix}`
}

/**
 * Generates a unique, collision-safe Donation Identification Number (DIN).
 * Checks the database for collisions and retries up to maxRetries times.
 *
 * @param {string|mongoose.Types.ObjectId} bloodbankId
 * @param {string} bloodGroup
 * @param {string} [componentType='Whole_Blood']
 * @param {Object} [options]
 * @param {number} [options.maxRetries=5]
 * @param {Object} [options.model=BloodUnit]
 * @param {mongoose.ClientSession} [options.session=null]
 * @returns {Promise<string>}
 */
async function generateUniqueDIN(
	bloodbankId,
	bloodGroup,
	componentType = 'Whole_Blood',
	options = {}
) {
	const maxRetries = options.maxRetries || 5
	const Model = options.model || BloodUnit
	const sessionOpt = options.session ? { session: options.session } : {}

	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		const candidateDIN = buildCandidateDIN(componentType, options.date || new Date())

		const existing = await Model.findOne(
			{ unitNumber: candidateDIN },
			{ _id: 1 },
			sessionOpt
		)

		if (!existing) {
			return candidateDIN
		}
	}

	throw new Error(
		`Collision failure: Unable to generate a unique DIN after ${maxRetries} collision retries.`
	)
}

/**
 * Checks whether an error is a MongoDB duplicate-key collision error (E11000 / E11001).
 */
function isDuplicateKeyError(err) {
	if (!err) return false
	return (
		err.code === 11000 ||
		err.code === 11001 ||
		(typeof err.message === 'string' && err.message.includes('E11000'))
	)
}

/**
 * Standardized insertion helper for Phase 3.2 unit intake:
 * Wraps unit creation and database save inside an automatic collision recovery loop.
 * If two concurrent transactions race and pass findOne but collide on MongoDB unique index (E11000),
 * this helper intercepts the duplicate-key error and retries with a freshly generated DIN.
 *
 * @param {Function} saveCallback - async (din) => unitDoc.save(opts)
 * @param {Object} [options]
 * @param {number} [options.maxRetries=5]
 * @param {string} [options.componentType='Whole_Blood']
 * @returns {Promise<any>}
 */
async function saveWithDINRetry(saveCallback, options = {}) {
	const maxRetries = options.maxRetries || 5

	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		const din = await generateUniqueDIN(
			options.bloodbankId,
			options.bloodGroup,
			options.componentType || 'Whole_Blood',
			options
		)

		try {
			return await saveCallback(din)
		} catch (err) {
			if (isDuplicateKeyError(err) && attempt < maxRetries) {
				continue
			}
			throw err
		}
	}
}

module.exports = {
	COMPONENT_SUFFIX_MAP,
	getJulianDay,
	buildCandidateDIN,
	generateUniqueDIN,
	isDuplicateKeyError,
	saveWithDINRetry,
}
