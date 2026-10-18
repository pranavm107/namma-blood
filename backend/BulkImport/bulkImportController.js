/**
 * Bulk Import Controller
 *
 * Provides:
 * 1. Downloadable CSV templates & fictional samples.
 * 2. Schema documentation endpoints.
 * 3. Validation-only preview endpoint (strictly zero-mutation).
 * 4. Confirmed batch import with full server-side re-validation and atomic transaction safety.
 */

const catchAsync = require('../Utils/catchAsync')
const AppError = require('../Utils/appError')
const State = require('../State/stateModel')
const City = require('../City/cityModel')
const BloodBank = require('../BloodBank/bloodbankModel')
const Bloodstock = require('../BloodStock/bloodStockModel')
const { withTransaction } = require('../Utils/transactionHelper')
const { registerBloodbankEmail } = require('../Utils/emailContant')
const {
	getTemplateCsv,
	getSampleCsv,
	getDocumentation,
} = require('./bulkImportTemplates')
const {
	parseCsvContent,
	validateBulkData,
} = require('./bulkImportValidation')

// Extracts raw CSV string from request body (supporting both JSON and raw text)
function extractRawCsv(req) {
	if (typeof req.body === 'string') {
		return req.body
	}
	if (req.body && typeof req.body.csv === 'string') {
		return req.body.csv
	}
	if (req.body && typeof req.body.csvData === 'string') {
		return req.body.csvData
	}
	return null
}

const downloadTemplate = catchAsync(async (req, res, next) => {
	const entity = (req.params.entity || '').toLowerCase().trim()
	const csv = getTemplateCsv(entity)
	if (!csv) {
		return next(
			new AppError(
				`Invalid entity '${entity}'. Supported: bloodbank, city, state.`,
				400
			)
		)
	}

	res.setHeader('Content-Type', 'text/csv; charset=utf-8')
	res.setHeader(
		'Content-Disposition',
		`attachment; filename="namma_blood_${entity}_template.csv"`
	)
	return res.status(200).send(csv)
})

const downloadSample = catchAsync(async (req, res, next) => {
	const entity = (req.params.entity || '').toLowerCase().trim()
	const csv = getSampleCsv(entity)
	if (!csv) {
		return next(
			new AppError(
				`Invalid entity '${entity}'. Supported: bloodbank, city, state.`,
				400
			)
		)
	}

	res.setHeader('Content-Type', 'text/csv; charset=utf-8')
	res.setHeader(
		'Content-Disposition',
		`attachment; filename="namma_blood_${entity}_sample_fictional.csv"`
	)
	return res.status(200).send(csv)
})

const getSchemaDocumentation = catchAsync(async (req, res, next) => {
	const entity = (req.params.entity || '').toLowerCase().trim()
	const doc = getDocumentation(entity)
	if (!doc) {
		return next(
			new AppError(
				`Invalid entity '${entity}'. Supported: bloodbank, city, state.`,
				400
			)
		)
	}

	return res.status(200).json(doc)
})

/**
 * PREVIEW WORKFLOW (CRITICAL INVARIANT: ZERO DATABASE MUTATIONS)
 */
const previewBulkImport = catchAsync(async (req, res, next) => {
	const entity = (req.params.entity || '').toLowerCase().trim()
	const rawCsv = extractRawCsv(req)

	if (!rawCsv) {
		return next(
			new AppError(
				'CSV content is required. Provide raw CSV text or { csv: "..." } JSON property.',
				400
			)
		)
	}

	// 1. Parse CSV (enforces 2 MB size & 500 row count limits)
	const records = parseCsvContent(rawCsv)

	// 2. Validate records & foreign-key references (strictly read-only)
	const validationResult = await validateBulkData(entity, records)

	return res.status(200).json({
		status: 'success',
		entity: validationResult.entity,
		totalRows: validationResult.totalRows,
		validRowsCount: validationResult.validRowsCount,
		invalidRowsCount: validationResult.invalidRowsCount,
		canImport: validationResult.canImport,
		errors: validationResult.errors,
		preview: validationResult.preview,
	})
})

/**
 * CONFIRMED BATCH IMPORT
 * Re-validates data on the server; requires explicit { confirm: true };
 * Uses MongoDB multi-document transaction for atomic all-or-nothing execution.
 */
const confirmBulkImport = catchAsync(async (req, res, next) => {
	const entity = (req.params.entity || '').toLowerCase().trim()
	const isConfirmed =
		req.body.confirm === true ||
		req.body.confirm === 'true' ||
		req.headers['x-confirm-import'] === 'true'

	if (!isConfirmed) {
		return next(
			new AppError(
				'Explicit user confirmation is required to execute the import. Set confirm: true in the request body.',
				400
			)
		)
	}

	const rawCsv = extractRawCsv(req)
	if (!rawCsv) {
		return next(
			new AppError(
				'CSV content is required. Provide { csv: "...", confirm: true } in the request body.',
				400
			)
		)
	}

	// 1. Full Server-side Re-parsing & Re-validation
	const records = parseCsvContent(rawCsv)
	const validationResult = await validateBulkData(entity, records)

	if (!validationResult.canImport || validationResult.invalidRowsCount > 0) {
		return res.status(400).json({
			status: 'fail',
			message: `Cannot import: ${validationResult.invalidRowsCount} invalid row(s) detected. Fix all errors and try again.`,
			entity,
			totalRows: validationResult.totalRows,
			validRowsCount: validationResult.validRowsCount,
			invalidRowsCount: validationResult.invalidRowsCount,
			errors: validationResult.errors,
		})
	}

	// 2. Execute Atomic Import within Transaction
	const importedRecords = []
	const emailsToSend = []

	await withTransaction(async (session) => {
		const sessionOpt = session ? { session } : {}

		if (entity === 'state') {
			for (const row of validationResult.validRecords) {
				const stateDoc = new State({ stateName: row.stateName })
				await stateDoc.save(sessionOpt)
				importedRecords.push({ id: stateDoc._id, name: stateDoc.stateName })
			}
		} else if (entity === 'city') {
			for (const row of validationResult.validRecords) {
				const cityDoc = new City({
					stateName: row.stateName,
					cityName: row.cityName,
				})
				await cityDoc.save(sessionOpt)
				importedRecords.push({
					id: cityDoc._id,
					name: `${cityDoc.cityName} (${cityDoc.stateName})`,
				})
			}
		} else if (entity === 'bloodbank') {
			for (const row of validationResult.validRecords) {
				const bloodbankDoc = new BloodBank({
					bloodbankName: row.bloodbankName,
					category: row.category,
					contactPerson: row.contactPerson,
					address1: row.address1,
					address2: row.address2,
					state: row.state,
					city: row.city,
					pinCode: row.pinCode,
					phoneNo1: row.phoneNo1,
					phoneNo2: row.phoneNo2,
					email: row.email,
					password: row.password,
					openingDate: row.openingDate,
				})

				// Save BloodBank within transaction (triggers password hash pre-save hook)
				await bloodbankDoc.save(sessionOpt)

				// Provision associated BloodStock record within the SAME transaction
				const stockDoc = new Bloodstock({
					bloodbankId: bloodbankDoc._id,
				})
				await stockDoc.save(sessionOpt)

				importedRecords.push({
					id: bloodbankDoc._id,
					name: bloodbankDoc.bloodbankName,
					email: bloodbankDoc.email,
				})

				emailsToSend.push({
					name: bloodbankDoc.bloodbankName,
					email: bloodbankDoc.email,
				})
			}
		}
	})

	// 3. Post-commit Asynchronous Welcome Emails (non-blocking)
	if (emailsToSend.length > 0) {
		setImmediate(async () => {
			for (const item of emailsToSend) {
				try {
					await registerBloodbankEmail(item.name, item.email)
				} catch (emailErr) {
					// Email delivery failures do not invalidate successful atomic database creation
					console.error(
						`[BulkImport] Failed to send onboarding email to ${item.email}:`,
						emailErr.message
					)
				}
			}
		})
	}

	return res.status(201).json({
		status: 'success',
		message: `Successfully imported ${importedRecords.length} ${entity} record(s).`,
		entity,
		totalImported: importedRecords.length,
		importedRecords,
	})
})

module.exports = {
	downloadTemplate,
	downloadSample,
	getSchemaDocumentation,
	previewBulkImport,
	confirmBulkImport,
}
