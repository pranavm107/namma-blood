const mongoose = require('mongoose')
const Bloodstock = require('./bloodStockModel')
const {
	BloodUnit,
	VALID_BLOOD_GROUPS,
	VALID_COMPONENT_TYPES,
	MANDATORY_TTI_TESTS,
} = require('../BloodUnit/bloodUnitModel')
const {
	BloodUnitAuditLog,
	recordAuditLog,
} = require('../BloodUnit/bloodUnitAuditModel')
const { InventoryReconciliationRecord } = require('./reconciliationModel')
const stockService = require('./stockService')
const { withTransaction } = require('../Utils/transactionHelper')

/**
 * Validates that an ID is a valid Mongoose ObjectId.
 */
function isValidObjectId(id) {
	return id && mongoose.Types.ObjectId.isValid(id)
}

/**
 * Generates an immutable, traceable batch ID.
 */
function generateBatchId(prefix = 'REC') {
	const timestamp = Date.now()
	const random = Math.random().toString(36).substring(2, 8).toUpperCase()
	return `${prefix}-${timestamp}-${random}`
}

/**
 * Generates a comprehensive, dry-run reconciliation report comparing legacy aggregate
 * inventory with traceable unit records for a specific blood bank.
 *
 * Strict Safety Invariant:
 * This function performs ZERO writes to production inventory (Bloodstock and BloodUnit).
 *
 * @param {Object} params
 * @param {string|mongoose.Types.ObjectId} params.bloodbankId
 * @param {string|mongoose.Types.ObjectId} [params.actorId]
 * @param {string} [params.actorModel='bloodbank']
 * @param {string|mongoose.Types.ObjectId} [params.staffId=null]
 * @param {string} [params.ipAddress=null]
 * @param {boolean} [params.recordAudit=false]
 * @param {mongoose.ClientSession} [params.session=null]
 * @returns {Promise<Object>} Reviewable reconciliation report
 */
async function generateReconciliationReport({
	bloodbankId,
	actorId = null,
	actorModel = 'bloodbank',
	staffId = null,
	ipAddress = null,
	recordAudit = false,
	session = null,
} = {}) {
	if (!isValidObjectId(bloodbankId)) {
		const err = new Error('Valid bloodbankId is required to generate reconciliation report.')
		err.statusCode = 400
		throw err
	}

	const bbObjectId = new mongoose.Types.ObjectId(bloodbankId)
	const now = new Date()
	const batchId = generateBatchId('REC-AUDIT')

	// 1. Fetch raw legacy aggregate stock document
	const legacyStockData = await stockService.getLegacyStock(bbObjectId, { session })
	const legacyCounts = legacyStockData.counts

	// 2. Fetch all traceable units owned by this blood bank
	const unitQuery = BloodUnit.find({ bloodbankId: bbObjectId })
	if (session) {
		unitQuery.session(session)
	}
	const traceableUnits = await unitQuery.lean()

	// 3. Check for duplicate DINs within this blood bank and globally
	const dinAggregationPipeline = [
		{ $match: { bloodbankId: bbObjectId } },
		{
			$group: {
				_id: '$unitNumber',
				count: { $sum: 1 },
				unitIds: { $push: '$_id' },
			},
		},
		{ $match: { count: { $gt: 1 } } },
	]
	const dinAggQuery = BloodUnit.aggregate(dinAggregationPipeline)
	if (session) dinAggQuery.session(session)
	const localDuplicateDINs = await dinAggQuery

	// Check if any DIN in this blood bank is also owned by a different blood bank
	const allLocalDINs = traceableUnits.map((u) => u.unitNumber).filter(Boolean)
	let crossTenantDuplicateDINs = []
	if (allLocalDINs.length > 0) {
		let crossQuery = BloodUnit.find({
			unitNumber: { $in: allLocalDINs },
			bloodbankId: { $ne: bbObjectId },
		})
		if (typeof crossQuery.select === 'function') {
			crossQuery = crossQuery.select('unitNumber bloodbankId')
		}
		if (session && typeof crossQuery.session === 'function') {
			crossQuery = crossQuery.session(session)
		}
		crossTenantDuplicateDINs = typeof crossQuery.lean === 'function' ? await crossQuery.lean() : await crossQuery
	}


	// 4. Initialize per-group counters
	const perGroupSummary = {}
	for (const bg of VALID_BLOOD_GROUPS) {
		perGroupSummary[bg] = {
			bloodGroup: bg,
			legacyCount: legacyCounts[bg] || 0,
			traceableAvailable: 0,
			traceableQuarantined: 0,
			traceableTestedPassed: 0,
			traceableReserved: 0,
			traceableIssued: 0,
			traceableDiscarded: 0,
			traceableExpired: 0,
			traceableOther: 0,
			traceableTotalActive: 0, // Available + Quarantined + Tested_Passed + Reserved
			delta: 0,
		}
	}

	const discrepancies = []
	const nonReconcilableUnits = []
	const seenDINs = new Set()

	// 5. Anomaly Detection on Legacy Counts
	for (const bg of VALID_BLOOD_GROUPS) {
		const count = legacyCounts[bg] || 0
		if (count < 0) {
			discrepancies.push({
				type: 'NEGATIVE_LEGACY_COUNT',
				bloodGroup: bg,
				unitNumber: null,
				details: `Legacy aggregate count for ${bg} is negative (${count}). Inventory corruption detected.`,
				severity: 'CRITICAL',
			})
		}
	}

	// 6. Inspect individual traceable units for safety anomalies and status classification
	for (const unit of traceableUnits) {
		const bg = unit.bloodGroup
		const groupSummary = perGroupSummary[bg]

		if (!groupSummary) {
			discrepancies.push({
				type: 'INVALID_BLOOD_GROUP',
				bloodGroup: bg,
				unitNumber: unit.unitNumber,
				details: `Unit has invalid or unrecognized blood group: '${bg}'.`,
				severity: 'ERROR',
			})
			nonReconcilableUnits.push({
				unitId: unit._id,
				unitNumber: unit.unitNumber,
				reason: `Invalid blood group: ${bg}`,
			})
			continue
		}

		// Check for missing or malformed unitNumber
		if (!unit.unitNumber || typeof unit.unitNumber !== 'string' || unit.unitNumber.trim() === '') {
			discrepancies.push({
				type: 'MISSING_IDENTIFIER',
				bloodGroup: bg,
				unitNumber: null,
				details: `Traceable unit ID ${unit._id} has missing or empty DIN/unitNumber barcode.`,
				severity: 'CRITICAL',
			})
			nonReconcilableUnits.push({
				unitId: unit._id,
				unitNumber: 'UNKNOWN',
				reason: 'Missing DIN / unitNumber',
			})
		}

		// Check component type
		if (!VALID_COMPONENT_TYPES.includes(unit.componentType)) {
			discrepancies.push({
				type: 'INVALID_COMPONENT_TYPE',
				bloodGroup: bg,
				unitNumber: unit.unitNumber,
				details: `Unit has unrecognized component fraction type: '${unit.componentType}'.`,
				severity: 'ERROR',
			})
			nonReconcilableUnits.push({
				unitId: unit._id,
				unitNumber: unit.unitNumber,
				reason: `Unrecognized componentType: ${unit.componentType}`,
			})
		}

		// Check for expired Available units (clinical safety violation)
		const isExpired = unit.expiryDate && new Date(unit.expiryDate) <= now
		if (unit.status === 'Available' && isExpired) {
			discrepancies.push({
				type: 'EXPIRED_AVAILABLE_UNIT',
				bloodGroup: bg,
				unitNumber: unit.unitNumber,
				details: `Critical safety anomaly: Unit ${unit.unitNumber} is marked 'Available' but clinically expired on ${unit.expiryDate}. Must be transitioned to Expired.`,
				severity: 'CRITICAL',
			})
			nonReconcilableUnits.push({
				unitId: unit._id,
				unitNumber: unit.unitNumber,
				reason: 'Expired unit falsely marked Available',
			})
		}

		// Check for unverified Available units (clinical safety violation)
		if (unit.status === 'Available') {
			const hasClearance = unit.clearance?.isVerified === true
			const allPassedTTI = MANDATORY_TTI_TESTS.every(
				(test) => unit.testing && unit.testing[test] === 'Non_Reactive'
			)
			if (!hasClearance || !allPassedTTI) {
				discrepancies.push({
					type: 'UNVERIFIED_AVAILABLE_UNIT',
					bloodGroup: bg,
					unitNumber: unit.unitNumber,
					details: `Critical safety anomaly: Unit ${unit.unitNumber} is marked 'Available' without complete Medical Officer clearance and Non_Reactive TTI panel.`,
					severity: 'CRITICAL',
				})
				nonReconcilableUnits.push({
					unitId: unit._id,
					unitNumber: unit.unitNumber,
					reason: 'Unverified unit falsely marked Available without clearance',
				})
			}
		}

		// Tally lifecycle counts
		switch (unit.status) {
			case 'Available':
				groupSummary.traceableAvailable++
				groupSummary.traceableTotalActive++
				break
			case 'Quarantined':
				groupSummary.traceableQuarantined++
				groupSummary.traceableTotalActive++
				break
			case 'Tested_Passed':
				groupSummary.traceableTestedPassed++
				groupSummary.traceableTotalActive++
				break
			case 'Reserved':
				groupSummary.traceableReserved++
				groupSummary.traceableTotalActive++
				break
			case 'Issued':
				groupSummary.traceableIssued++
				break
			case 'Discarded':
				groupSummary.traceableDiscarded++
				break
			case 'Expired':
				groupSummary.traceableExpired++
				break
			default:
				groupSummary.traceableOther++
				discrepancies.push({
					type: 'UNRECOGNIZED_STATUS',
					bloodGroup: bg,
					unitNumber: unit.unitNumber,
					details: `Unit has invalid status: '${unit.status}'.`,
					severity: 'ERROR',
				})
				nonReconcilableUnits.push({
					unitId: unit._id,
					unitNumber: unit.unitNumber,
					reason: `Invalid status: ${unit.status}`,
				})
				break
		}
	}

	// 7. Duplicate DIN Discrepancies
	for (const dup of localDuplicateDINs) {
		discrepancies.push({
			type: 'DUPLICATE_DIN',
			bloodGroup: null,
			unitNumber: dup._id,
			details: `Duplicate DIN detected within this blood bank: DIN '${dup._id}' is assigned to ${dup.count} different unit records.`,
			severity: 'CRITICAL',
		})
		for (const uId of dup.unitIds) {
			nonReconcilableUnits.push({
				unitId: uId,
				unitNumber: dup._id,
				reason: 'Duplicate DIN within blood bank',
			})
		}
	}

	for (const crossDup of crossTenantDuplicateDINs) {
		discrepancies.push({
			type: 'CROSS_TENANT_DUPLICATE_DIN',
			bloodGroup: null,
			unitNumber: crossDup.unitNumber,
			details: `Cross-tenant collision detected: DIN '${crossDup.unitNumber}' is shared with another blood bank (${crossDup.bloodbankId}).`,
			severity: 'CRITICAL',
		})
	}

	// 8. Unsupported Component Mapping notice (Informative)
	discrepancies.push({
		type: 'UNSUPPORTED_COMPONENT_MAPPING',
		bloodGroup: null,
		unitNumber: null,
		details:
			'Notice: Legacy Bloodstock aggregates do not record component fraction types (PRBC, Platelets, FFP). Legacy quantities are treated as whole blood equivalents during reconciliation.',
		severity: 'INFO',
	})

	// 9. Calculate deltas and overall totals
	let legacyTotal = 0
	let traceableTotal = traceableUnits.length
	let traceableVerifiedTotal = 0
	let traceableQuarantinedTotal = 0
	let traceableReservedTotal = 0
	let traceableDiscardedTotal = 0
	let traceableExpiredTotal = 0

	const perGroupList = []
	for (const bg of VALID_BLOOD_GROUPS) {
		const g = perGroupSummary[bg]
		g.delta = g.legacyCount - g.traceableTotalActive
		legacyTotal += g.legacyCount
		traceableVerifiedTotal += g.traceableAvailable
		traceableQuarantinedTotal += g.traceableQuarantined
		traceableReservedTotal += g.traceableReserved
		traceableDiscardedTotal += g.traceableDiscarded
		traceableExpiredTotal += g.traceableExpired
		perGroupList.push(g)
	}

	const errorDiscrepancies = discrepancies.filter(
		(d) => d.severity === 'ERROR' || d.severity === 'CRITICAL'
	)
	const warningDiscrepancies = discrepancies.filter((d) => d.severity === 'WARNING')
	const isClean = errorDiscrepancies.length === 0 && nonReconcilableUnits.length === 0

	const summary = {
		legacyTotal,
		traceableTotal,
		traceableVerifiedTotal,
		traceableQuarantinedTotal,
		traceableReservedTotal,
		traceableDiscardedTotal,
		traceableExpiredTotal,
		discrepancyCount: discrepancies.length,
		anomalyCount: errorDiscrepancies.length,
		nonReconcilableCount: nonReconcilableUnits.length,
		migratedCount: 0,
		skippedAlreadyMigratedCount: 0,
	}

	const report = {
		bloodbankId,
		batchId,
		runType: 'AUDIT_REPORT',
		status: isClean ? 'COMPLETED' : 'CONFLICT_DETECTED',
		isClean,
		timestamp: now,
		summary,
		perGroupDetails: perGroupList,
		discrepancies,
		nonReconcilableUnits,
		recommendation: isClean
			? 'Inventory reconciled cleanly. Aggregate and traceable counts are aligned.'
			: 'Action required: Review discrepancies, quarantine or discard invalid units, and complete physical barcoding before executing migration.',
	}

	// 10. Persist audit ledger record if requested and actor provided
	if (recordAudit && actorId) {
		try {
			const auditRecord = new InventoryReconciliationRecord({
				bloodbankId: bbObjectId,
				batchId,
				runType: 'AUDIT_REPORT',
				status: isClean ? 'COMPLETED' : 'CONFLICT_DETECTED',
				actor: {
					actorId,
					actorModel,
					staffId,
					ipAddress,
				},
				summary,
				perGroupDetails: perGroupList,
				discrepancies,
				manifestResults: [],
				legacyStockBefore: legacyCounts,
				legacyStockAfter: legacyCounts,
				notes: 'Automated dry-run reconciliation inventory audit',
			})
			const opts = session ? { session } : {}
			await auditRecord.save(opts)
		} catch (auditErr) {
			console.error('Failed to persist reconciliation audit record:', auditErr.message)
		}
	}

	return report
}

/**
 * Validates a single item in a migration manifest.
 */
function validateManifestItem(item, index, now = new Date()) {
	const errors = []

	if (!item || typeof item !== 'object') {
		return { isValid: false, errors: [`Row ${index + 1}: Manifest item must be a valid object.`] }
	}

	const unitNumber = typeof item.unitNumber === 'string' ? item.unitNumber.trim().toUpperCase() : ''
	if (!unitNumber) {
		errors.push(`Row ${index + 1}: Unique Unit Number (DIN / Barcode) is required.`)
	}

	const bloodGroup = item.bloodGroup
	if (!VALID_BLOOD_GROUPS.includes(bloodGroup)) {
		errors.push(
			`Row ${index + 1}: Invalid blood group '${bloodGroup}'. Must be one of: ${VALID_BLOOD_GROUPS.join(', ')}.`
		)
	}

	const componentType = item.componentType || 'Whole_Blood'
	if (!VALID_COMPONENT_TYPES.includes(componentType)) {
		errors.push(
			`Row ${index + 1}: Invalid component type '${componentType}'. Must be one of: ${VALID_COMPONENT_TYPES.join(', ')}.`
		)
	}

	const volumeMl = Number(item.volumeMl) || 350
	if (volumeMl < 50 || volumeMl > 600) {
		errors.push(`Row ${index + 1}: Volume in mL (${volumeMl}) must be between 50 and 600.`)
	}

	if (!item.expiryDate) {
		errors.push(`Row ${index + 1}: Expiry date is required.`)
	} else {
		const exp = new Date(item.expiryDate)
		if (isNaN(exp.getTime())) {
			errors.push(`Row ${index + 1}: Invalid expiry date format.`)
		} else if (exp <= now) {
			errors.push(`Row ${index + 1}: Clinical safety violation: Expiry date (${item.expiryDate}) must be in the future. Cannot migrate already-expired units.`)
		}
	}

	const deductFromLegacy = item.deductFromLegacy !== false

	return {
		isValid: errors.length === 0,
		errors,
		sanitizedItem: {
			unitNumber,
			bloodGroup,
			componentType,
			volumeMl,
			collectionDate: item.collectionDate ? new Date(item.collectionDate) : new Date(),
			expiryDate: new Date(item.expiryDate),
			storageLocation: item.storageLocation || {},
			deductFromLegacy,
		},
	}
}

/**
 * Executes or simulates legacy inventory reconciliation and safe migration.
 *
 * Strict Architectural & Clinical Invariants:
 * 1. Explicit execution mode: Defaults strictly to 'DRY_RUN'. Only 'EXECUTE' performs writes.
 * 2. Multi-tenant isolation: All mutations strictly scoped to authenticated bloodbankId.
 * 3. Never manufacture clinical clearance: Migrated units enter status 'Quarantined',
 *    requiring mandatory TTI testing and Medical Officer authorization before issue.
 * 4. Safe failure & rollback: Insufficient legacy stock or duplicate DIN causes immediate abort.
 * 5. Idempotent & Resumable: Re-running with existing migrated units recognizes them as ALREADY_MIGRATED
 *    without re-decrementing legacy stock or creating duplicates.
 * 6. Audit Trail: Appends an immutable InventoryReconciliationRecord and BloodUnitAuditLog entry.
 *
 * @param {Object} params
 * @param {string|mongoose.Types.ObjectId} params.bloodbankId
 * @param {string} [params.mode='DRY_RUN'] - 'DRY_RUN' or 'EXECUTE'
 * @param {Array<Object>} params.migrationManifest - Physical units to ingest
 * @param {string} [params.batchId]
 * @param {string|mongoose.Types.ObjectId} params.actorId
 * @param {string} [params.actorModel='bloodbank']
 * @param {string|mongoose.Types.ObjectId} [params.staffId=null]
 * @param {string} [params.ipAddress=null]
 * @param {string} [params.notes='']
 * @param {mongoose.ClientSession} [params.session=null]
 * @returns {Promise<Object>} Migration outcome report
 */
async function executeInventoryMigration({
	bloodbankId,
	mode = 'DRY_RUN',
	migrationManifest = [],
	batchId = null,
	actorId = null,
	actorModel = 'bloodbank',
	staffId = null,
	ipAddress = null,
	notes = '',
	session = null,
} = {}) {
	if (!isValidObjectId(bloodbankId)) {
		const err = new Error('Valid bloodbankId is required for inventory migration.')
		err.statusCode = 400
		throw err
	}

	const isExecute = mode === 'EXECUTE'
	const actualBatchId = batchId || generateBatchId(isExecute ? 'MIG-EXEC' : 'MIG-DRY')
	const bbObjectId = new mongoose.Types.ObjectId(bloodbankId)
	const now = new Date()

	if (!Array.isArray(migrationManifest)) {
		const err = new Error('migrationManifest must be an array of physical blood units.')
		err.statusCode = 400
		throw err
	}

	if (isExecute && !actorId) {
		const err = new Error('Authenticated actorId is strictly required to execute migration.')
		err.statusCode = 401
		throw err
	}

	// Step 1: Pre-validation of all manifest items
	const validationErrors = []
	const sanitizedManifest = []
	const manifestDINs = new Set()
	const duplicateDINsInManifest = []

	for (let i = 0; i < migrationManifest.length; i++) {
		const item = migrationManifest[i]
		const res = validateManifestItem(item, i, now)
		if (!res.isValid) {
			validationErrors.push(...res.errors)
		} else {
			const din = res.sanitizedItem.unitNumber
			if (manifestDINs.has(din)) {
				duplicateDINsInManifest.push(din)
				validationErrors.push(`Row ${i + 1}: Duplicate DIN '${din}' found within the submitted manifest.`)
			} else {
				manifestDINs.add(din)
				sanitizedManifest.push(res.sanitizedItem)
			}
		}
	}

	// Step 2: Check database for DIN collisions
	const existingUnits = await BloodUnit.find({
		unitNumber: { $in: Array.from(manifestDINs) },
	}).lean()

	const existingUnitMap = new Map()
	for (const u of existingUnits) {
		existingUnitMap.set(u.unitNumber, u)
	}

	const unitsToCreate = []
	const alreadyMigratedUnits = []
	const manifestResults = []
	const requestedLegacyDeductions = {}
	for (const bg of VALID_BLOOD_GROUPS) {
		requestedLegacyDeductions[bg] = 0
	}

	for (const item of sanitizedManifest) {
		const existing = existingUnitMap.get(item.unitNumber)

		if (existing) {
			// Cross-tenant collision
			if (String(existing.bloodbankId) !== String(bbObjectId)) {
				validationErrors.push(
					`DIN '${item.unitNumber}' belongs to another blood bank. Cross-tenant collisions are strictly forbidden.`
				)
				manifestResults.push({
					unitNumber: item.unitNumber,
					bloodGroup: item.bloodGroup,
					status: 'FAILED',
					unitId: existing._id,
					error: 'Cross-tenant DIN collision',
				})
				continue
			}

			// Already migrated unit (Resumability & Idempotency)
			if (existing.isLegacyMigrated) {
				alreadyMigratedUnits.push(existing)
				manifestResults.push({
					unitNumber: item.unitNumber,
					bloodGroup: item.bloodGroup,
					status: 'ALREADY_MIGRATED',
					unitId: existing._id,
					error: null,
				})
				continue
			}

			// Duplicate DIN collision with an existing non-migrated unit
			validationErrors.push(
				`DIN '${item.unitNumber}' is already registered as a non-migrated blood unit for this blood bank.`
			)
			manifestResults.push({
				unitNumber: item.unitNumber,
				bloodGroup: item.bloodGroup,
				status: 'FAILED',
				unitId: existing._id,
				error: 'Duplicate DIN with existing non-migrated unit',
			})
			continue
		}

		// New unit to migrate
		unitsToCreate.push(item)
		if (item.deductFromLegacy) {
			requestedLegacyDeductions[item.bloodGroup]++
		}

		manifestResults.push({
			unitNumber: item.unitNumber,
			bloodGroup: item.bloodGroup,
			status: isExecute ? 'MIGRATED' : 'DRY_RUN_VALID',
			unitId: null,
			error: null,
		})
	}

	// Step 3: Check legacy stock availability for requested deductions
	const legacyStockData = await stockService.getLegacyStock(bbObjectId, { session })
	const legacyStockBefore = legacyStockData.counts
	const legacyStockShortfalls = []

	for (const bg of VALID_BLOOD_GROUPS) {
		const required = requestedLegacyDeductions[bg]
		const current = legacyStockBefore[bg] || 0
		if (required > current) {
			legacyStockShortfalls.push({
				bloodGroup: bg,
				required,
				current,
				shortfall: required - current,
			})
			validationErrors.push(
				`Insufficient legacy stock for blood group ${bg}: Requested ${required} unit(s) to deduct, but current legacy stock is only ${current}.`
			)
		}
	}

	const hasConflicts = validationErrors.length > 0

	// If in DRY_RUN mode, calculate simulated resulting stock and return report with ZERO writes
	if (!isExecute) {
		const simulatedLegacyStockAfter = { ...legacyStockBefore }
		for (const bg of VALID_BLOOD_GROUPS) {
			simulatedLegacyStockAfter[bg] = Math.max(
				0,
				(simulatedLegacyStockAfter[bg] || 0) - requestedLegacyDeductions[bg]
			)
		}

		const dryRunSummary = {
			totalSubmitted: migrationManifest.length,
			validToMigrate: unitsToCreate.length,
			alreadyMigratedCount: alreadyMigratedUnits.length,
			failedValidationCount: validationErrors.length,
			requestedLegacyDeductions,
			isExecutable: !hasConflicts,
		}

		return {
			bloodbankId,
			batchId: actualBatchId,
			mode: 'DRY_RUN',
			status: hasConflicts ? 'CONFLICT_DETECTED' : 'COMPLETED',
			isExecutable: !hasConflicts,
			summary: dryRunSummary,
			legacyStockBefore,
			simulatedLegacyStockAfter,
			validationErrors,
			manifestResults,
			recommendation: hasConflicts
				? 'Fix reported validation errors and stock deficits before running migration in EXECUTE mode.'
				: 'Manifest is valid. Ready to execute migration with atomic deductions and quarantined unit creation.',
		}
	}

	// Step 4: EXECUTE mode — Strict Transactional Safety
	if (hasConflicts) {
		const err = new Error(
			`Migration aborted due to ${validationErrors.length} validation/conflict errors: ${validationErrors[0]}`
		)
		err.statusCode = 400
		err.details = validationErrors
		throw err
	}

	// Helper function containing atomic execution writes
	const executeOperation = async (activeSession) => {
		// A. Decrement legacy stock proportionally
		const activeLegacyStock = await Bloodstock.findOne(
			{ bloodbankId: bbObjectId },
			null,
			{ session: activeSession }
		)
		if (!activeLegacyStock) {
			const err = new Error('Legacy Bloodstock document not found for this blood bank.')
			err.statusCode = 404
			throw err
		}

		for (const bg of VALID_BLOOD_GROUPS) {
			const unitsToDeduct = requestedLegacyDeductions[bg]
			if (unitsToDeduct > 0) {
				const updated = await Bloodstock.findOneAndUpdate(
					{
						bloodbankId: bbObjectId,
						[bg]: { $gte: unitsToDeduct },
					},
					{ $inc: { [bg]: -unitsToDeduct } },
					{ new: true, session: activeSession }
				)
				if (!updated) {
					const err = new Error(
						`Atomic deduction failed: Insufficient legacy stock for ${bg} during write lock. Another transaction may have modified stock.`
					)
					err.statusCode = 409
					throw err
				}
			}
		}

		// Read updated legacy stock snapshot
		const updatedStockDoc = await Bloodstock.findOne(
			{ bloodbankId: bbObjectId },
			null,
			{ session: activeSession }
		)
		const legacyStockAfter = {}
		for (const bg of VALID_BLOOD_GROUPS) {
			legacyStockAfter[bg] =
				updatedStockDoc && typeof updatedStockDoc[bg] === 'number'
					? updatedStockDoc[bg]
					: Number(updatedStockDoc?.[bg]) || 0
		}


		// B. Create BloodUnit documents strictly in 'Quarantined' status
		const createdUnits = []
		for (const item of unitsToCreate) {
			const unitDoc = new BloodUnit({
				unitNumber: item.unitNumber,
				bloodbankId: bbObjectId,
				bloodGroup: item.bloodGroup,
				componentType: item.componentType,
				volumeMl: item.volumeMl,
				collectionDate: item.collectionDate,
				expiryDate: item.expiryDate,
				storageLocation: item.storageLocation,
				status: 'Quarantined', // CLINICAL SAFETY GATE: Unverified legacy stock NEVER Available
				testing: {
					hiv: 'Pending',
					hbv: 'Pending',
					hcv: 'Pending',
					syphilis: 'Pending',
					malaria: 'Pending',
				},
				clearance: {
					isVerified: false,
					verifiedBy: null,
					verifiedByStaffId: null,
					verifiedAt: null,
					notes: 'Migrated from legacy shelf inventory; awaiting TTI screening and Medical Officer clearance.',
				},
				isLegacyMigrated: true,
			})

			await unitDoc.save({ session: activeSession })
			createdUnits.push(unitDoc)

			// Record immutable unit audit log
			const unitAuditActorModel =
				actorModel === 'bloodbankstaff' ? 'bloodbank' : actorModel || 'bloodbank'

			await recordAuditLog({
				unitId: unitDoc._id,
				unitNumber: unitDoc.unitNumber,
				bloodbankId: bbObjectId,
				action: 'LEGACY_RECONCILED',
				previousStatus: 'None',
				newStatus: 'Quarantined',
				actorId: actorId || bbObjectId,
				actorModel: unitAuditActorModel,
				ipAddress,
				reason: notes || 'Legacy inventory migration from aggregate stock',
				metadata: {
					batchId: actualBatchId,
					isLegacyMigrated: true,
					deductedFromLegacy: item.deductFromLegacy,
					staffId,
				},
				session: activeSession,
			})


			// Update unitId in manifest results
			const mResult = manifestResults.find((r) => r.unitNumber === item.unitNumber)
			if (mResult) {
				mResult.unitId = unitDoc._id
			}
		}

		// C. Persist immutable InventoryReconciliationRecord
		const reconciliationRecord = new InventoryReconciliationRecord({
			bloodbankId: bbObjectId,
			batchId: actualBatchId,
			runType: 'MIGRATION_EXECUTE',
			status: 'COMPLETED',
			actor: {
				actorId,
				actorModel,
				staffId,
				ipAddress,
			},
			summary: {
				legacyTotal: Object.values(legacyStockAfter).reduce((a, b) => a + (Number(b) || 0), 0),
				traceableTotal: createdUnits.length + alreadyMigratedUnits.length,

				traceableVerifiedTotal: 0,
				traceableQuarantinedTotal: createdUnits.length,
				traceableReservedTotal: 0,
				traceableDiscardedTotal: 0,
				traceableExpiredTotal: 0,
				discrepancyCount: 0,
				anomalyCount: 0,
				nonReconcilableCount: 0,
				migratedCount: createdUnits.length,
				skippedAlreadyMigratedCount: alreadyMigratedUnits.length,
			},
			perGroupDetails: VALID_BLOOD_GROUPS.map((bg) => ({
				bloodGroup: bg,
				legacyCount: legacyStockAfter[bg] || 0,
				traceableAvailable: 0,
				traceableQuarantined: unitsToCreate.filter((u) => u.bloodGroup === bg).length,
				traceableReserved: 0,
				traceableOther: 0,
				delta: (legacyStockAfter[bg] || 0),
			})),
			discrepancies: [],
			manifestResults,
			legacyStockBefore,
			legacyStockAfter,
			notes: notes || 'Legacy physical unit migration executed successfully.',
		})

		await reconciliationRecord.save({ session: activeSession })

		return {
			bloodbankId,
			batchId: actualBatchId,
			mode: 'EXECUTE',
			status: 'COMPLETED',
			migratedCount: createdUnits.length,
			alreadyMigratedCount: alreadyMigratedUnits.length,
			legacyStockBefore,
			legacyStockAfter,
			createdUnits: createdUnits.map((u) => ({
				_id: u._id,
				unitNumber: u.unitNumber,
				bloodGroup: u.bloodGroup,
				status: u.status,
				isLegacyMigrated: u.isLegacyMigrated,
				isIssueEligible: u.isIssueEligible(),
			})),
			manifestResults,
			timestamp: now,
		}
	}

	// Use external session if provided, or wrap inside transaction helper
	if (session) {
		return await executeOperation(session)
	}

	return await withTransaction(executeOperation)
}

/**
 * Retrieves audit history of reconciliation and migration runs for a blood bank.
 */
async function getReconciliationHistory({ bloodbankId, limit = 20, skip = 0 }) {
	if (!isValidObjectId(bloodbankId)) {
		const err = new Error('Valid bloodbankId is required.')
		err.statusCode = 400
		throw err
	}

	const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20))
	const safeSkip = Math.max(0, Number(skip) || 0)

	const records = await InventoryReconciliationRecord.find({
		bloodbankId: new mongoose.Types.ObjectId(bloodbankId),
	})
		.sort({ timestamp: -1 })
		.skip(safeSkip)
		.limit(safeLimit)
		.lean()

	const total = await InventoryReconciliationRecord.countDocuments({
		bloodbankId: new mongoose.Types.ObjectId(bloodbankId),
	})

	return {
		total,
		limit: safeLimit,
		skip: safeSkip,
		records,
	}
}

module.exports = {
	generateReconciliationReport,
	executeInventoryMigration,
	getReconciliationHistory,
	validateManifestItem,
	generateBatchId,
}
