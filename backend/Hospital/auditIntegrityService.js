/**
 * Audit Integrity Service
 * Namma Blood — Stage B3.4 Healthcare Governance & Tamper-Evident Ledger
 *
 * Implements canonical serialization, cryptographic hash verification,
 * atomic sequence-advancing transaction operations, and comprehensive
 * chain integrity verification.
 */

const crypto = require('crypto')
const mongoose = require('mongoose')
const { AdministrativeDecisionAudit } = require('./administrativeDecisionAuditModel')
const { AuditChainHead, GENESIS_ANCHOR_HASH } = require('./auditChainHeadModel')

const HASH_VERSION_V1 = 'v1'
const HASH_VERSION_V2 = 'v2'
const HASH_VERSION = HASH_VERSION_V2
const GLOBAL_HEAD_ID = 'GLOBAL_ADMIN_AUDIT_HEAD'

/**
 * Deterministic canonical value serializer:
 * - Nested objects: keys sorted lexicographically (code-point order)
 * - Arrays: elements recursively canonicalized
 * - ObjectIds / BSON ObjectIDs: hex string
 * - Dates: ISO 8601 UTC string (e.g. date.toISOString())
 * - Null: "null"
 * - Undefined: "null"
 * - Numbers: finite check (rejects NaN, Infinity, -Infinity)
 * - Strings: JSON.stringify (proper escape sequences)
 * - Booleans: "true" / "false"
 * - Unsupported types (BigInt, Function, Symbol): throws TypeError
 * - Circular references: throws TypeError
 */
function canonicalizeValue(val, seen = new WeakSet()) {
	if (val === null || val === undefined) {
		return 'null'
	}
	const type = typeof val
	if (type === 'boolean') {
		return val ? 'true' : 'false'
	}
	if (type === 'number') {
		if (!Number.isFinite(val)) {
			throw new TypeError(`Cannot canonicalize non-finite number: ${val}`)
		}
		return Object.is(val, -0) ? '0' : String(val)
	}
	if (type === 'string') {
		return JSON.stringify(val)
	}
	if (type === 'bigint' || type === 'symbol' || type === 'function') {
		throw new TypeError(
			`Unsupported JavaScript type: ${type} cannot be canonicalized in audit records.`
		)
	}
	if (type === 'object') {
		// Date instances
		if (val instanceof Date) {
			if (isNaN(val.getTime())) {
				throw new TypeError('Cannot canonicalize invalid Date.')
			}
			return JSON.stringify(val.toISOString())
		}
		// ObjectId / BSON ObjectId
		if (
			val._bsontype === 'ObjectID' ||
			(val.constructor && val.constructor.name === 'ObjectId') ||
			(typeof val.toHexString === 'function')
		) {
			return JSON.stringify(val.toString())
		}
		// If Mongoose Document or object with toObject()
		if (typeof val.toObject === 'function') {
			val = val.toObject()
		}

		if (seen.has(val)) {
			throw new TypeError('Circular reference detected in audit payload.')
		}
		seen.add(val)

		// Array
		if (Array.isArray(val)) {
			const items = val.map((item) => canonicalizeValue(item, seen))
			seen.delete(val)
			return '[' + items.join(',') + ']'
		}

		// Plain Object: sort keys in lexicographical order (code point order)
		const keys = Object.keys(val).sort()
		const entries = []
		for (const key of keys) {
			const v = val[key]
			if (v !== undefined) {
				entries.push(JSON.stringify(key) + ':' + canonicalizeValue(v, seen))
			}
		}
		seen.delete(val)
		return '{' + entries.join(',') + '}'
	}
	throw new TypeError(`Unsupported JavaScript type: ${type}`)
}

/**
 * Legacy v1 pipe-delimited serialization format (maintained for backward compatibility)
 */
function serializeV1(record) {
	const parts = [
		Number(record.sequenceNumber),
		String(record.hashVersion || HASH_VERSION_V1),
		String(record.entityType || ''),
		String(record.entityId?._id || record.entityId || ''),
		String(record.targetUserId?._id || record.targetUserId || ''),
		record.hospitalId ? String(record.hospitalId?._id || record.hospitalId) : '',
		String(record.decisionType || ''),
		String(record.previousStatus || ''),
		String(record.newStatus || ''),
		String(record.actorId?._id || record.actorId || ''),
		String(record.actorModel || 'admin'),
		String(record.actorRole || ''),
		String(record.previousRecordHash || ''),
	]
	return parts.join('|')
}

/**
 * V2 Comprehensive canonical JSON serialization format covering all security-relevant fields
 */
function serializeV2(record) {
	const toIdString = (id) => (id ? String(id._id || id) : null)

	const canonicalObj = {
		sequenceNumber: Number(record.sequenceNumber),
		hashVersion: HASH_VERSION_V2,
		entityType: String(record.entityType || ''),
		entityId: toIdString(record.entityId) || '',
		targetUserId: toIdString(record.targetUserId) || '',
		hospitalAssociationId: toIdString(record.hospitalAssociationId),
		hospitalId: toIdString(record.hospitalId),
		decisionType: String(record.decisionType || ''),
		previousStatus: String(record.previousStatus || ''),
		newStatus: String(record.newStatus || ''),
		actorId: toIdString(record.actorId) || '',
		actorModel: String(record.actorModel || 'admin'),
		actorRole: String(record.actorRole || ''),
		reason: String(record.reason || ''),
		notes: String(record.notes || ''),
		evidenceReferences: Array.isArray(record.evidenceReferences) ? record.evidenceReferences : [],
		grantedPermissions: Array.isArray(record.grantedPermissions) ? record.grantedPermissions : [],
		metadata: record.metadata && typeof record.metadata === 'object' ? record.metadata : {},
		previousRecordHash: String(record.previousRecordHash || ''),
	}

	return canonicalizeValue(canonicalObj)
}

/**
 * Deterministic canonical serialization of audit record for SHA-256 calculation.
 * Preserves hash versioning and backward compatibility.
 */
function serializeAuditRecordCanonical(record) {
	if (!record) {
		throw new Error('Audit record is required for canonical serialization.')
	}

	const version = record.hashVersion || HASH_VERSION

	if (version === HASH_VERSION_V1) {
		return serializeV1(record)
	}

	if (version === HASH_VERSION_V2) {
		return serializeV2(record)
	}

	throw new Error(`Unsupported hashVersion '${version}' for audit record serialization.`)
}

/**
 * Computes SHA-256 record hash over canonical serialization
 */
function calculateRecordHash(record) {
	const canonical = serializeAuditRecordCanonical(record)
	return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex')
}

/**
 * Initializes or retrieves the singleton audit chain head inside a transaction session
 */
async function getOrInitAuditChainHead(session = null) {
	const options = { upsert: true, new: true, setDefaultsOnInsert: true }
	if (session) options.session = session

	return await AuditChainHead.findOneAndUpdate(
		{ _id: GLOBAL_HEAD_ID },
		{
			$setOnInsert: {
				sequenceNumber: 0,
				latestRecordId: null,
				latestRecordHash: GENESIS_ANCHOR_HASH,
				totalRecords: 0,
			},
		},
		options
	)
}

/**
 * Atomically appends an audit record to the ledger within a MongoDB transaction session.
 * Guarantees monotonic sequence numbering and strict hash chaining.
 *
 * @param {import('mongoose').ClientSession} session - Active MongoDB transaction session
 * @param {Object} auditData - Audit entry attributes
 * @returns {Promise<Object>} Created audit entry
 */
async function appendAuditRecordTransactional(session, auditData) {
	if (!session) {
		throw new Error(
			'Transaction session is mandatory for appending administrative decision audit records.'
		)
	}

	// 1. Atomically lock and retrieve current chain head within the transaction
	let head = await AuditChainHead.findById(GLOBAL_HEAD_ID).session(session)
	if (!head) {
		head = await getOrInitAuditChainHead(session)
	}

	const nextSeq = head.sequenceNumber + 1
	const prevHash = head.latestRecordHash

	// 2. Compute canonical SHA-256 hash for the new record
	const recordForHashing = {
		...auditData,
		sequenceNumber: nextSeq,
		hashVersion: HASH_VERSION,
		previousRecordHash: prevHash,
	}
	const currentRecordHash = calculateRecordHash(recordForHashing)

	// 3. Insert audit entry with bound sequence and hash link
	const [createdEntry] = await AdministrativeDecisionAudit.create(
		[
			{
				...auditData,
				sequenceNumber: nextSeq,
				hashVersion: HASH_VERSION,
				previousRecordHash: prevHash,
				recordHash: currentRecordHash,
			},
		],
		{ session }
	)

	// 4. Advance chain head in the same transaction
	const updatedHead = await AuditChainHead.findOneAndUpdate(
		{ _id: GLOBAL_HEAD_ID, sequenceNumber: head.sequenceNumber },
		{
			$set: {
				sequenceNumber: nextSeq,
				latestRecordId: createdEntry._id,
				latestRecordHash: currentRecordHash,
			},
			$inc: { totalRecords: 1 },
		},
		{ session, new: true }
	)

	if (!updatedHead) {
		const conflictErr = new mongoose.mongo.MongoServerError({
			message:
				'Concurrent audit chain head modification detected. Transaction must retry.',
			errmsg: 'Concurrent audit chain head modification detected.',
		})
		conflictErr.addErrorLabel('TransientTransactionError')
		throw conflictErr
	}

	return createdEntry
}

/**
 * Verifies the complete integrity of the administrative decision audit ledger:
 * 1. Checks chain head existence and consistency.
 * 2. Checks monotonic sequence numbering from 1 to N with zero sequence gaps.
 * 3. Checks cryptographic previousRecordHash linkages across every block.
 * 4. Checks canonical content hashes to detect any unauthorized data mutation.
 * 5. Checks that the terminal record perfectly matches the AuditChainHead.
 *
 * Supports optional in-memory record verification for offline/checkpoint checks.
 *
 * @param {Array<Object>|{ records?: Array<Object>, head?: Object }|null} [recordsOrOptions=null]
 * @returns {Promise<{ isValid: boolean, totalRecords: number, verifiedSequence: number, errors: string[] }>}
 */
async function verifyAuditChainIntegrity(recordsOrOptions = null) {
	const errors = []
	let records
	let head = null

	if (Array.isArray(recordsOrOptions)) {
		records = recordsOrOptions
	} else if (recordsOrOptions && Array.isArray(recordsOrOptions.records)) {
		records = recordsOrOptions.records
		head = recordsOrOptions.head || null
	} else {
		records = await AdministrativeDecisionAudit.find({})
			.sort({ sequenceNumber: 1 })
			.lean()
	}

	if (!head) {
		head = await AuditChainHead.findById(GLOBAL_HEAD_ID).lean()
	}

	if (!head) {
		if (records.length === 0) {
			return { isValid: true, totalRecords: 0, verifiedSequence: 0, errors: [] }
		}
		errors.push('AuditChainHead singleton document is missing while audit records exist.')
		return { isValid: false, totalRecords: records.length, verifiedSequence: 0, errors }
	}

	if (records.length === 0) {
		if (head.sequenceNumber === 0 && head.latestRecordHash === GENESIS_ANCHOR_HASH) {
			return { isValid: true, totalRecords: 0, verifiedSequence: 0, errors: [] }
		}
		errors.push(
			`AuditChainHead indicates sequenceNumber ${head.sequenceNumber} but collection has 0 records.`
		)
		return { isValid: false, totalRecords: 0, verifiedSequence: 0, errors }
	}

	let expectedSeq = 1
	let expectedPrevHash = GENESIS_ANCHOR_HASH

	for (let i = 0; i < records.length; i++) {
		const rec = records[i]

		// 1. Sequence Continuity Check
		if (rec.sequenceNumber !== expectedSeq) {
			errors.push(
				`Sequence gap detected at record index ${i}: expected sequenceNumber ${expectedSeq}, found ${rec.sequenceNumber}.`
			)
			expectedSeq = rec.sequenceNumber // Attempt to resync sequence tracking
		}

		// 2. Hash Linkage Check
		if (rec.previousRecordHash !== expectedPrevHash) {
			errors.push(
				`Previous hash mismatch at sequence ${rec.sequenceNumber}: expected '${expectedPrevHash}', found '${rec.previousRecordHash}'.`
			)
		}

		// 3. Record Content Integrity Check
		const recomputedHash = calculateRecordHash(rec)
		if (rec.recordHash !== recomputedHash) {
			errors.push(
				`Tampered record detected at sequence ${rec.sequenceNumber}: stored recordHash '${rec.recordHash}' does not match recomputed '${recomputedHash}'.`
			)
		}

		expectedPrevHash = rec.recordHash
		expectedSeq++
	}

	// 4. Terminal Record & Head Consistency Check
	const terminalRecord = records[records.length - 1]
	if (head.sequenceNumber !== terminalRecord.sequenceNumber) {
		errors.push(
			`Terminal record sequence mismatch: AuditChainHead sequenceNumber is ${head.sequenceNumber}, but latest record in collection is ${terminalRecord.sequenceNumber}. Possible terminal-record deletion.`
		)
	}

	if (head.latestRecordHash !== terminalRecord.recordHash) {
		errors.push(
			`Terminal record hash mismatch: AuditChainHead latestRecordHash is '${head.latestRecordHash}', but latest record in collection has '${terminalRecord.recordHash}'.`
		)
	}

	if (head.totalRecords !== records.length) {
		errors.push(
			`Record count mismatch: AuditChainHead totalRecords is ${head.totalRecords}, but collection contains ${records.length} documents.`
		)
	}

	return {
		isValid: errors.length === 0,
		totalRecords: records.length,
		verifiedSequence: records.length > 0 ? records[records.length - 1].sequenceNumber : 0,
		errors,
	}
}

/**
 * ============================================================================
 * SERVICE BOUNDARIES: WRITER, READER, VERIFIER
 * ============================================================================
 * Establishes strict separation of concerns for audit operations:
 * - Audit Writer: Enforces atomic, transaction-bound sequence advancement.
 * - Audit Reader: Controlled read access with query optimization and projections.
 * - Audit Verifier: Cryptographic validation of ledger continuity and record hashes.
 *
 * Intended Future Production MongoDB RBAC Roles:
 * 1. auditWriterRole:
 *    - administrativedecisionaudits: actions: ['find', 'insert']
 *    - auditchainheads: actions: ['find', 'update'] (sequence advance only)
 * 2. auditReaderRole:
 *    - administrativedecisionaudits: actions: ['find']
 *    - auditchainheads: actions: ['find']
 * 3. auditVerifierRole:
 *    - administrativedecisionaudits: actions: ['find']
 *    - auditchainheads: actions: ['find']
 * 4. administrativeReportingRole:
 *    - Controlled read-only views or aggregation pipelines on audit records.
 * ============================================================================
 */

const auditWriterService = Object.freeze({
	appendRecord: appendAuditRecordTransactional,
	initHead: getOrInitAuditChainHead,
})

const auditReaderService = Object.freeze({
	getRecordBySequence: async (sequenceNumber) => {
		return AdministrativeDecisionAudit.findOne({ sequenceNumber }).lean()
	},
	getRecordsByRange: async (startSeq, endSeq) => {
		return AdministrativeDecisionAudit.find({
			sequenceNumber: { $gte: Number(startSeq), $lte: Number(endSeq) },
		})
			.sort({ sequenceNumber: 1 })
			.lean()
	},
	getRecordsByTargetUser: async (targetUserId, limit = 50) => {
		return AdministrativeDecisionAudit.find({ targetUserId })
			.sort({ sequenceNumber: -1 })
			.limit(limit)
			.lean()
	},
	getRecordsByEntity: async (entityType, entityId) => {
		return AdministrativeDecisionAudit.find({ entityType, entityId })
			.sort({ sequenceNumber: 1 })
			.lean()
	},
	getLatestRecord: async () => {
		return AdministrativeDecisionAudit.findOne({})
			.sort({ sequenceNumber: -1 })
			.lean()
	},
	getChainHead: async () => {
		return AuditChainHead.findById(GLOBAL_HEAD_ID).lean()
	},
	getRecordCount: async (filter = {}) => {
		return AdministrativeDecisionAudit.countDocuments(filter)
	},
})

const auditVerifierService = Object.freeze({
	verifyChain: verifyAuditChainIntegrity,
	verifyRecordContent: (record) => {
		if (!record) return false
		const recomputed = calculateRecordHash(record)
		return record.recordHash === recomputed
	},
	verifyRecordLinkage: (currentRecord, previousRecordHash) => {
		if (!currentRecord) return false
		return currentRecord.previousRecordHash === previousRecordHash
	},
	verifyRecordSequence: (records) => {
		if (!Array.isArray(records)) {
			return { isValid: false, errors: ['Records must be an array.'] }
		}
		const errors = []
		let expectedSeq = records.length > 0 ? records[0].sequenceNumber : 1
		let prevHash = records.length > 0 ? records[0].previousRecordHash : GENESIS_ANCHOR_HASH

		for (let i = 0; i < records.length; i++) {
			const rec = records[i]
			if (rec.sequenceNumber !== expectedSeq) {
				errors.push(
					`Sequence order error at index ${i}: expected ${expectedSeq}, found ${rec.sequenceNumber}.`
				)
			}
			if (i > 0 && rec.previousRecordHash !== prevHash) {
				errors.push(
					`Hash linkage mismatch at sequence ${rec.sequenceNumber}: expected '${prevHash}', found '${rec.previousRecordHash}'.`
				)
			}
			const recomputed = calculateRecordHash(rec)
			if (rec.recordHash !== recomputed) {
				errors.push(
					`Hash content mismatch at sequence ${rec.sequenceNumber}: stored '${rec.recordHash}' vs computed '${recomputed}'.`
				)
			}
			prevHash = rec.recordHash
			expectedSeq++
		}
		return { isValid: errors.length === 0, errors }
	},
})

module.exports = {
	HASH_VERSION,
	HASH_VERSION_V1,
	HASH_VERSION_V2,
	GLOBAL_HEAD_ID,
	GENESIS_ANCHOR_HASH,
	canonicalizeValue,
	serializeAuditRecordCanonical,
	calculateRecordHash,
	getOrInitAuditChainHead,
	appendAuditRecordTransactional,
	verifyAuditChainIntegrity,
	auditWriterService,
	auditReaderService,
	auditVerifierService,
}
