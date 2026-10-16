/**
 * Bulk Import CSV Validation Engine
 *
 * Guarantees:
 * 1. STRICT ZERO-MUTATION invariant during preview / validation.
 * 2. Upload size limit (2 MB) and row limit (500 rows).
 * 3. In-file duplicate detection and database conflict detection.
 * 4. Referential integrity verification (State and City existence).
 * 5. Password security validation without exposing plaintext passwords in preview.
 */

const { parse } = require('csv-parse/sync')
const State = require('../State/stateModel')
const City = require('../City/cityModel')
const BloodBank = require('../BloodBank/bloodbankModel')
const { TEMPLATES } = require('./bulkImportTemplates')
const {
	emailValidate,
	passwordLengthValidate,
	passwordValidate,
} = require('../Common/Functions/validateInputs')

const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024 // 2 MB
const MAX_ROW_COUNT = 500

function escapeRegex(text) {
	return String(text).replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')
}

/**
 * Validates password rules:
 * - Length between 8 and 20 characters
 * - No whitespace
 * - At least one uppercase letter, one lowercase letter, and one digit
 */
function validatePasswordComplexity(password) {
	if (!password || typeof password !== 'string') return false
	if (password.length < 8 || password.length > 20) return false
	if (/\s/.test(password)) return false
	if (!/[A-Z]/.test(password)) return false
	if (!/[a-z]/.test(password)) return false
	if (!/[0-9]/.test(password)) return false
	return true
}

/**
 * Parse CSV content safely with csv-parse.
 * Rejects invalid format, size overflows, and row overflows.
 */
function parseCsvContent(rawCsv, options = {}) {
	if (typeof rawCsv !== 'string' && !Buffer.isBuffer(rawCsv)) {
		throw new Error('CSV content must be a string or buffer.')
	}

	const byteLength = Buffer.byteLength(rawCsv, 'utf8')
	if (byteLength > (options.maxBytes || MAX_FILE_SIZE_BYTES)) {
		const err = new Error(
			`File size exceeds maximum allowed limit of ${Math.round(
				(options.maxBytes || MAX_FILE_SIZE_BYTES) / (1024 * 1024)
			)} MB.`
		)
		err.statusCode = 400
		throw err
	}

	if (!rawCsv.toString().trim()) {
		const err = new Error('The uploaded CSV file is empty.')
		err.statusCode = 400
		throw err
	}

	let records
	try {
		records = parse(rawCsv, {
			columns: true,
			skip_empty_lines: true,
			trim: true,
			bom: true,
			relax_column_count: false,
		})
	} catch (parseErr) {
		const err = new Error(`Malformed CSV: ${parseErr.message}`)
		err.statusCode = 400
		throw err
	}

	if (!records || records.length === 0) {
		const err = new Error(
			'The uploaded CSV file contains no data rows or only blank rows.'
		)
		err.statusCode = 400
		throw err
	}

	if (records.length > (options.maxRows || MAX_ROW_COUNT)) {
		const err = new Error(
			`File row count (${records.length}) exceeds the maximum batch limit of ${
				options.maxRows || MAX_ROW_COUNT
			} rows.`
		)
		err.statusCode = 400
		throw err
	}

	return records
}

/**
 * Validates that all required headers exist and flags unknown headers.
 */
function validateHeaders(records, expectedHeaders) {
	if (!records.length) return []
	const firstRecordKeys = Object.keys(records[0])
	const missingHeaders = expectedHeaders.filter(
		(header) => !firstRecordKeys.includes(header)
	)
	return missingHeaders
}

/**
 * Performs validation on parsed CSV rows.
 * READ-ONLY: Never invokes save, create, update, or delete.
 */
async function validateBulkData(entity, records, options = {}) {
	const templateSpec = TEMPLATES[entity]
	if (!templateSpec) {
		const err = new Error(
			`Unsupported import entity '${entity}'. Supported entities: bloodbank, city, state.`
		)
		err.statusCode = 400
		throw err
	}

	const missingHeaders = validateHeaders(records, templateSpec.headers)
	if (missingHeaders.length > 0) {
		return {
			entity,
			totalRows: records.length,
			validRowsCount: 0,
			invalidRowsCount: records.length,
			canImport: false,
			errors: [
				{
					row: 0,
					field: 'headers',
					message: `Missing required header column(s): ${missingHeaders.join(', ')}`,
				},
			],
			preview: [],
		}
	}

	const errors = []
	const sanitizedRows = []

	if (entity === 'state') {
		await validateStateRows(records, errors, sanitizedRows, options)
	} else if (entity === 'city') {
		await validateCityRows(records, errors, sanitizedRows, options)
	} else if (entity === 'bloodbank') {
		await validateBloodbankRows(records, errors, sanitizedRows, options)
	}

	const validRowsCount = sanitizedRows.filter((r) => r.isValid).length
	const invalidRowsCount = sanitizedRows.length - validRowsCount
	const canImport = invalidRowsCount === 0 && validRowsCount > 0

	return {
		entity,
		totalRows: records.length,
		validRowsCount,
		invalidRowsCount,
		canImport,
		errors,
		preview: sanitizedRows.map((r) => ({
			row: r.rowNumber,
			status: r.isValid ? 'VALID' : 'INVALID',
			data: r.displayData,
			errors: r.rowErrors,
		})),
		validRecords: canImport ? sanitizedRows.map((r) => r.parsedData) : [],
	}
}

/**
 * Validate State records
 */
async function validateStateRows(records, errors, sanitizedRows, options = {}) {
	const seenStatesInFile = new Set()
	const stateNamesToCheck = []

	records.forEach((row, idx) => {
		const rowNum = idx + 2
		const stateName = (row.stateName || '').trim()
		const rowErrors = []

		if (!stateName) {
			rowErrors.push({
				row: rowNum,
				field: 'stateName',
				message: 'State name is required.',
			})
		} else {
			const lower = stateName.toLowerCase()
			if (seenStatesInFile.has(lower)) {
				rowErrors.push({
					row: rowNum,
					field: 'stateName',
					message: `Duplicate state name '${stateName}' within the uploaded file.`,
				})
			} else {
				seenStatesInFile.add(lower)
				stateNamesToCheck.push(stateName)
			}
		}

		errors.push(...rowErrors)
		sanitizedRows.push({
			rowNumber: rowNum,
			isValid: rowErrors.length === 0,
			rowErrors,
			displayData: { stateName },
			parsedData: { stateName },
		})
	})

	// Check against existing database states (READ ONLY)
	if (stateNamesToCheck.length > 0) {
		const regexQueries = stateNamesToCheck.map(
			(s) => new RegExp(`^${escapeRegex(s)}$`, 'i')
		)
		const existingStates = await State.find({
			stateName: { $in: regexQueries },
		})
			.select('stateName')
			.lean()

		if (existingStates.length > 0) {
			const existingSet = new Set(
				existingStates.map((s) => s.stateName.toLowerCase())
			)
			sanitizedRows.forEach((item) => {
				const stateLower = (item.parsedData.stateName || '').toLowerCase()
				if (existingSet.has(stateLower)) {
					const conflictErr = {
						row: item.rowNumber,
						field: 'stateName',
						message: `State '${item.parsedData.stateName}' already exists in the database.`,
					}
					item.rowErrors.push(conflictErr)
					item.isValid = false
					errors.push(conflictErr)
				}
			})
		}
	}
}

/**
 * Validate City records
 */
async function validateCityRows(records, errors, sanitizedRows, options = {}) {
	const seenCitiesInFile = new Set()
	const cityNamesToCheck = []
	const stateNamesReferenced = new Set()

	records.forEach((row, idx) => {
		const rowNum = idx + 2
		const stateName = (row.stateName || '').trim()
		const cityName = (row.cityName || '').trim()
		const rowErrors = []

		if (!stateName) {
			rowErrors.push({
				row: rowNum,
				field: 'stateName',
				message: 'State name is required.',
			})
		} else {
			stateNamesReferenced.add(stateName)
		}

		if (!cityName) {
			rowErrors.push({
				row: rowNum,
				field: 'cityName',
				message: 'City name is required.',
			})
		} else {
			const lower = cityName.toLowerCase()
			if (seenCitiesInFile.has(lower)) {
				rowErrors.push({
					row: rowNum,
					field: 'cityName',
					message: `Duplicate city name '${cityName}' within the uploaded file.`,
				})
			} else {
				seenCitiesInFile.add(lower)
				cityNamesToCheck.push(cityName)
			}
		}

		errors.push(...rowErrors)
		sanitizedRows.push({
			rowNumber: rowNum,
			isValid: rowErrors.length === 0,
			rowErrors,
			displayData: { stateName, cityName },
			parsedData: { stateName, cityName },
		})
	})

	// Verify referenced states exist in database (READ ONLY)
	if (stateNamesReferenced.size > 0) {
		const stateRegexes = Array.from(stateNamesReferenced).map(
			(s) => new RegExp(`^${escapeRegex(s)}$`, 'i')
		)
		const existingStates = await State.find({
			stateName: { $in: stateRegexes },
		})
			.select('stateName')
			.lean()

		const validStateNameMap = new Map()
		existingStates.forEach((s) => {
			validStateNameMap.set(s.stateName.toLowerCase(), s.stateName)
		})

		sanitizedRows.forEach((item) => {
			const stateLower = (item.parsedData.stateName || '').toLowerCase()
			if (item.parsedData.stateName && !validStateNameMap.has(stateLower)) {
				const stateRefErr = {
					row: item.rowNumber,
					field: 'stateName',
					message: `Referenced state '${item.parsedData.stateName}' does not exist in the database.`,
				}
				item.rowErrors.push(stateRefErr)
				item.isValid = false
				errors.push(stateRefErr)
			} else if (validStateNameMap.has(stateLower)) {
				// Normalize exact casing from database
				item.parsedData.stateName = validStateNameMap.get(stateLower)
				item.displayData.stateName = item.parsedData.stateName
			}
		})
	}

	// Verify city does not already exist in database (READ ONLY)
	if (cityNamesToCheck.length > 0) {
		const cityRegexes = cityNamesToCheck.map(
			(c) => new RegExp(`^${escapeRegex(c)}$`, 'i')
		)
		const existingCities = await City.find({ cityName: { $in: cityRegexes } })
			.select('cityName')
			.lean()

		if (existingCities.length > 0) {
			const existingCitySet = new Set(
				existingCities.map((c) => c.cityName.toLowerCase())
			)
			sanitizedRows.forEach((item) => {
				const cityLower = (item.parsedData.cityName || '').toLowerCase()
				if (existingCitySet.has(cityLower)) {
					const conflictErr = {
						row: item.rowNumber,
						field: 'cityName',
						message: `City '${item.parsedData.cityName}' already exists in the database.`,
					}
					item.rowErrors.push(conflictErr)
					item.isValid = false
					errors.push(conflictErr)
				}
			})
		}
	}
}

/**
 * Validate BloodBank records
 */
async function validateBloodbankRows(
	records,
	errors,
	sanitizedRows,
	options = {}
) {
	const seenEmails = new Set()
	const seenPhones = new Set()
	const seenNames = new Set()

	const emailsToCheck = []
	const phonesToCheck = []
	const statesReferenced = new Set()
	const citiesReferenced = new Set()

	records.forEach((row, idx) => {
		const rowNum = idx + 2
		const rowErrors = []

		const bloodbankName = (row.bloodbankName || '').trim()
		const category = (row.category || '').trim()
		const contactPerson = (row.contactPerson || '').trim()
		const address1 = (row.address1 || '').trim()
		const address2 = (row.address2 || '').trim()
		const state = (row.state || '').trim()
		const city = (row.city || '').trim()
		const pinCodeRaw = (row.pinCode || '').trim()
		const phoneNo1 = (row.phoneNo1 || '').trim()
		const phoneNo2 = (row.phoneNo2 || '').trim()
		const email = (row.email || '').trim().toLowerCase()
		const password = (row.password || '').trim()
		const openingDateRaw = (row.openingDate || '').trim()

		// 1. bloodbankName
		if (!bloodbankName) {
			rowErrors.push({
				row: rowNum,
				field: 'bloodbankName',
				message: 'Blood bank name is required.',
			})
		} else {
			const lowerName = bloodbankName.toLowerCase()
			if (seenNames.has(lowerName)) {
				rowErrors.push({
					row: rowNum,
					field: 'bloodbankName',
					message: `Duplicate blood bank name '${bloodbankName}' within file.`,
				})
			} else {
				seenNames.add(lowerName)
			}
		}

		// 2. category
		if (!category) {
			rowErrors.push({
				row: rowNum,
				field: 'category',
				message: 'Category is required.',
			})
		} else if (!['Government', 'RedCross', 'Private'].includes(category)) {
			rowErrors.push({
				row: rowNum,
				field: 'category',
				message: `Invalid category '${category}'. Allowed values: Government, RedCross, Private.`,
			})
		}

		// 3. contactPerson
		if (!contactPerson) {
			rowErrors.push({
				row: rowNum,
				field: 'contactPerson',
				message: 'Contact person name is required.',
			})
		}

		// 4. address1 & address2
		if (!address1) {
			rowErrors.push({
				row: rowNum,
				field: 'address1',
				message: 'Address line 1 is required.',
			})
		}
		if (!address2) {
			rowErrors.push({
				row: rowNum,
				field: 'address2',
				message: 'Address line 2 is required.',
			})
		}

		// 5. state & city references
		if (!state) {
			rowErrors.push({
				row: rowNum,
				field: 'state',
				message: 'State name is required.',
			})
		} else {
			statesReferenced.add(state)
		}

		if (!city) {
			rowErrors.push({
				row: rowNum,
				field: 'city',
				message: 'City name is required.',
			})
		} else {
			citiesReferenced.add(city)
		}

		// 6. pinCode
		const pinCodeNum = Number(pinCodeRaw)
		if (!pinCodeRaw) {
			rowErrors.push({
				row: rowNum,
				field: 'pinCode',
				message: 'PIN code is required.',
			})
		} else if (
			isNaN(pinCodeNum) ||
			!/^\d{6}$/.test(pinCodeRaw) ||
			pinCodeNum <= 0
		) {
			rowErrors.push({
				row: rowNum,
				field: 'pinCode',
				message: 'PIN code must be exactly 6 positive numeric digits.',
			})
		}

		// 7. phoneNo1 & phoneNo2
		if (!phoneNo1) {
			rowErrors.push({
				row: rowNum,
				field: 'phoneNo1',
				message: 'Primary phone number is required.',
			})
		} else if (!/^\d{10}$/.test(phoneNo1)) {
			rowErrors.push({
				row: rowNum,
				field: 'phoneNo1',
				message: 'Primary phone number must be exactly 10 digits.',
			})
		} else if (seenPhones.has(phoneNo1)) {
			rowErrors.push({
				row: rowNum,
				field: 'phoneNo1',
				message: `Phone number '${phoneNo1}' is duplicated within file.`,
			})
		} else {
			seenPhones.add(phoneNo1)
			phonesToCheck.push(phoneNo1)
		}

		if (!phoneNo2) {
			rowErrors.push({
				row: rowNum,
				field: 'phoneNo2',
				message: 'Alternate phone number is required.',
			})
		} else if (!/^\d{10}$/.test(phoneNo2)) {
			rowErrors.push({
				row: rowNum,
				field: 'phoneNo2',
				message: 'Alternate phone number must be exactly 10 digits.',
			})
		} else if (phoneNo2 === phoneNo1) {
			rowErrors.push({
				row: rowNum,
				field: 'phoneNo2',
				message: 'Alternate phone number must differ from primary phone number.',
			})
		} else if (seenPhones.has(phoneNo2)) {
			rowErrors.push({
				row: rowNum,
				field: 'phoneNo2',
				message: `Alternate phone number '${phoneNo2}' is duplicated within file.`,
			})
		} else {
			seenPhones.add(phoneNo2)
			phonesToCheck.push(phoneNo2)
		}

		// 8. email
		if (!email) {
			rowErrors.push({
				row: rowNum,
				field: 'email',
				message: 'Email address is required.',
			})
		} else if (!emailValidate(email)) {
			rowErrors.push({
				row: rowNum,
				field: 'email',
				message: 'Invalid email address format.',
			})
		} else if (seenEmails.has(email)) {
			rowErrors.push({
				row: rowNum,
				field: 'email',
				message: `Email '${email}' is duplicated within file.`,
			})
		} else {
			seenEmails.add(email)
			emailsToCheck.push(email)
		}

		// 9. password
		if (!password) {
			rowErrors.push({
				row: rowNum,
				field: 'password',
				message: 'Initial account password is required in CSV.',
			})
		} else if (!validatePasswordComplexity(password)) {
			rowErrors.push({
				row: rowNum,
				field: 'password',
				message:
					'Password must be 8-20 characters without spaces, containing at least one uppercase letter, one lowercase letter, and one number.',
			})
		}

		// 10. openingDate
		let parsedOpeningDate = new Date()
		if (openingDateRaw) {
			const parsedDate = new Date(openingDateRaw)
			if (isNaN(parsedDate.getTime())) {
				rowErrors.push({
					row: rowNum,
					field: 'openingDate',
					message: 'Invalid opening date format. Use YYYY-MM-DD.',
				})
			} else if (parsedDate > new Date()) {
				rowErrors.push({
					row: rowNum,
					field: 'openingDate',
					message: 'Opening date must be in the past.',
				})
			} else {
				parsedOpeningDate = parsedDate
			}
		}

		errors.push(...rowErrors)

		sanitizedRows.push({
			rowNumber: rowNum,
			isValid: rowErrors.length === 0,
			rowErrors,
			displayData: {
				bloodbankName,
				category,
				contactPerson,
				address1,
				address2,
				state,
				city,
				pinCode: pinCodeNum || pinCodeRaw,
				phoneNo1,
				phoneNo2,
				email,
				password: password ? '********' : '', // REDACT PASSWORD FOR DISPLAY
				openingDate: parsedOpeningDate.toISOString().slice(0, 10),
			},
			parsedData: {
				bloodbankName,
				category,
				contactPerson,
				address1,
				address2,
				state,
				city,
				pinCode: pinCodeNum,
				phoneNo1,
				phoneNo2,
				email,
				password, // retained internally for confirmed import hash
				openingDate: parsedOpeningDate,
			},
		})
	})

	// Reference check: Validate State and City in DB (READ ONLY)
	if (statesReferenced.size > 0) {
		const stateRegexes = Array.from(statesReferenced).map(
			(s) => new RegExp(`^${escapeRegex(s)}$`, 'i')
		)
		const existingStates = await State.find({
			stateName: { $in: stateRegexes },
		})
			.select('stateName')
			.lean()

		const stateMap = new Map()
		existingStates.forEach((s) => {
			stateMap.set(s.stateName.toLowerCase(), s.stateName)
		})

		sanitizedRows.forEach((item) => {
			const sLower = (item.parsedData.state || '').toLowerCase()
			if (item.parsedData.state && !stateMap.has(sLower)) {
				const stateErr = {
					row: item.rowNumber,
					field: 'state',
					message: `State '${item.parsedData.state}' does not exist in the system.`,
				}
				item.rowErrors.push(stateErr)
				item.isValid = false
				errors.push(stateErr)
			} else if (stateMap.has(sLower)) {
				item.parsedData.state = stateMap.get(sLower)
				item.displayData.state = item.parsedData.state
			}
		})
	}

	if (citiesReferenced.size > 0) {
		const cityRegexes = Array.from(citiesReferenced).map(
			(c) => new RegExp(`^${escapeRegex(c)}$`, 'i')
		)
		const existingCities = await City.find({ cityName: { $in: cityRegexes } })
			.select('cityName stateName')
			.lean()

		// Key: `${stateName.toLowerCase()}::${cityName.toLowerCase()}`
		const cityStateSet = new Set(
			existingCities.map(
				(c) => `${c.stateName.toLowerCase()}::${c.cityName.toLowerCase()}`
			)
		)

		sanitizedRows.forEach((item) => {
			const sLower = (item.parsedData.state || '').toLowerCase()
			const cLower = (item.parsedData.city || '').toLowerCase()
			const pairKey = `${sLower}::${cLower}`

			if (item.parsedData.city && item.parsedData.state) {
				if (!cityStateSet.has(pairKey)) {
					const cityErr = {
						row: item.rowNumber,
						field: 'city',
						message: `City '${item.parsedData.city}' is not registered under State '${item.parsedData.state}'.`,
					}
					item.rowErrors.push(cityErr)
					item.isValid = false
					errors.push(cityErr)
				}
			}
		})
	}

	// Conflict check: Validate uniqueness against database (READ ONLY)
	if (emailsToCheck.length > 0 || phonesToCheck.length > 0) {
		const orConditions = []
		if (emailsToCheck.length > 0) {
			orConditions.push({ email: { $in: emailsToCheck } })
		}
		if (phonesToCheck.length > 0) {
			orConditions.push({ phoneNo1: { $in: phonesToCheck } })
			orConditions.push({ phoneNo2: { $in: phonesToCheck } })
		}

		const existingBanks = await BloodBank.find({ $or: orConditions })
			.select('email phoneNo1 phoneNo2')
			.lean()

		if (existingBanks.length > 0) {
			const existingEmailSet = new Set(
				existingBanks.map((b) => (b.email || '').toLowerCase())
			)
			const existingPhoneSet = new Set(
				existingBanks.flatMap((b) => [b.phoneNo1, b.phoneNo2]).filter(Boolean)
			)

			sanitizedRows.forEach((item) => {
				const emailLower = (item.parsedData.email || '').toLowerCase()
				if (existingEmailSet.has(emailLower)) {
					const err = {
						row: item.rowNumber,
						field: 'email',
						message: `Email '${item.parsedData.email}' already belongs to an existing blood bank.`,
					}
					item.rowErrors.push(err)
					item.isValid = false
					errors.push(err)
				}

				if (existingPhoneSet.has(item.parsedData.phoneNo1)) {
					const err = {
						row: item.rowNumber,
						field: 'phoneNo1',
						message: `Primary phone '${item.parsedData.phoneNo1}' already belongs to an existing blood bank.`,
					}
					item.rowErrors.push(err)
					item.isValid = false
					errors.push(err)
				}

				if (existingPhoneSet.has(item.parsedData.phoneNo2)) {
					const err = {
						row: item.rowNumber,
						field: 'phoneNo2',
						message: `Alternate phone '${item.parsedData.phoneNo2}' already belongs to an existing blood bank.`,
					}
					item.rowErrors.push(err)
					item.isValid = false
					errors.push(err)
				}
			})
		}
	}
}

module.exports = {
	MAX_FILE_SIZE_BYTES,
	MAX_ROW_COUNT,
	parseCsvContent,
	validateHeaders,
	validateBulkData,
	validatePasswordComplexity,
}
