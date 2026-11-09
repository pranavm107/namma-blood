/**
 * Audit Checkpoint Payload Service
 * Namma Blood — Stage B3.5.2 Hourly Audit Checkpoint Generation & Recovery
 *
 * Implements deterministic canonical payload serialization and SHA-256 hashing
 * for administrative decision audit checkpoints.
 *
 * Privacy & Data Minimization:
 * - Payloads strictly contain cryptographic metadata (sequence ranges and block hashes).
 * - Zero patient identities, clinical remarks, donor data, medical registrations,
 *   evidence URLs, or credential secrets are ever included.
 */

const crypto = require('crypto')
const { canonicalizeValue } = require('./auditIntegrityService')
const { GENESIS_CHECKPOINT_HASH } = require('./auditCheckpointCursorModel')

const CHECKPOINT_FORMAT_VERSION = 'v1'

// Forbidden sensitive keys that must never appear in any checkpoint payload
const FORBIDDEN_PAYLOAD_KEYS = [
	'patientName',
	'patientAge',
	'patientGender',
	'donorId',
	'medicalRegistrationNumber',
	'supportingEvidence',
	'evidenceReferences',
	'password',
	'token',
	'secret',
	'notes',
	'reason',
]

/**
 * Normalizes an arbitrary Date or ISO timestamp into a canonical UTC hour ISO string.
 * e.g., "2026-11-09T14:35:22.123Z" -> "2026-11-09T14:00:00.000Z"
 *
 * @param {Date|string|number} dateInput - Input timestamp
 * @returns {string} Canonical UTC hour string
 */
function normalizeToUtcHourString(dateInput) {
	const d = dateInput instanceof Date ? dateInput : new Date(dateInput)
	if (isNaN(d.getTime())) {
		throw new TypeError(`Invalid date input for UTC hour normalization: ${dateInput}`)
	}
	const year = d.getUTCFullYear()
	const month = String(d.getUTCMonth() + 1).padStart(2, '0')
	const day = String(d.getUTCDate()).padStart(2, '0')
	const hours = String(d.getUTCHours()).padStart(2, '0')
	return `${year}-${month}-${day}T${hours}:00:00.000Z`
}

/**
 * Generates a deterministic, unique checkpoint ID from ledgerId, sequence range, and UTC hour.
 * Format: CHK-{ledgerId}-{startSeq10d}-{endSeq10d}-{compactUtcHour}
 * e.g. "CHK-GLOBAL_ADMIN_AUDIT_HEAD-0000000001-0000000005-20261109T140000Z"
 */
function generateDeterministicCheckpointId(
	ledgerId,
	startSequence,
	endSequence,
	scheduledHourUtc
) {
	if (!ledgerId || typeof ledgerId !== 'string') {
		throw new TypeError('ledgerId is required to generate checkpoint ID.')
	}
	const start10d = String(startSequence).padStart(10, '0')
	const end10d = String(endSequence).padStart(10, '0')
	const compactHour = String(scheduledHourUtc)
		.replace(/[-:]/g, '')
		.replace('.000Z', 'Z')
		.replace('.000', '')
	return `CHK-${ledgerId.trim()}-${start10d}-${end10d}-${compactHour}`
}

/**
 * Constructs a verified deterministic checkpoint payload object.
 *
 * @param {Object} params
 * @param {string} params.ledgerId - Target audit ledger identifier
 * @param {number} params.startSequence - Range starting sequence number (inclusive)
 * @param {number} params.endSequence - Range ending sequence number (inclusive)
 * @param {number} params.recordCount - Total records in the sequence range
 * @param {string} params.firstRecordHash - SHA-256 hash of the first record in the range
 * @param {string} params.lastRecordHash - SHA-256 hash of the last record in the range
 * @param {string} params.previousCheckpointHash - Checkpoint hash of predecessor checkpoint (or genesis)
 * @param {string|Date} params.scheduledHourUtc - Designated UTC hour boundary
 * @param {string} [params.checkpointId] - Optional explicit checkpoint ID
 * @param {string} [params.formatVersion='v1'] - Format version
 * @returns {Object} Strict deterministic payload object
 */
function constructCheckpointPayload(params) {
	if (!params || typeof params !== 'object') {
		throw new TypeError('Checkpoint parameters must be an object.')
	}

	// 1. Data Minimization & Privacy Audit: Reject forbidden sensitive attributes
	for (const key of Object.keys(params)) {
		if (FORBIDDEN_PAYLOAD_KEYS.includes(key)) {
			throw new Error(
				`Security Violation: Sensitive field '${key}' is prohibited from checkpoint payloads.`
			)
		}
	}

	const ledgerId = String(params.ledgerId || '').trim()
	if (!ledgerId) {
		throw new Error('ledgerId is required for checkpoint payload.')
	}

	const startSequence = Number(params.startSequence)
	const endSequence = Number(params.endSequence)
	const recordCount = Number(params.recordCount)

	if (!Number.isInteger(startSequence) || startSequence < 1) {
		throw new TypeError(
			`startSequence must be an integer >= 1, received: ${params.startSequence}`
		)
	}
	if (!Number.isInteger(endSequence) || endSequence < startSequence) {
		throw new TypeError(
			`endSequence must be an integer >= startSequence (${startSequence}), received: ${params.endSequence}`
		)
	}
	const expectedCount = endSequence - startSequence + 1
	if (!Number.isInteger(recordCount) || recordCount !== expectedCount) {
		throw new Error(
			`recordCount mismatch: expected ${expectedCount} (${startSequence} to ${endSequence}), received: ${recordCount}`
		)
	}

	// Hash validation
	const hex64Regex = /^[a-f0-9]{64}$/i
	const firstRecordHash = String(params.firstRecordHash || '').trim()
	const lastRecordHash = String(params.lastRecordHash || '').trim()
	const previousCheckpointHash = String(params.previousCheckpointHash || '').trim()

	if (!hex64Regex.test(firstRecordHash)) {
		throw new Error(
			`firstRecordHash must be a 64-character SHA-256 hex string, received: ${firstRecordHash}`
		)
	}
	if (!hex64Regex.test(lastRecordHash)) {
		throw new Error(
			`lastRecordHash must be a 64-character SHA-256 hex string, received: ${lastRecordHash}`
		)
	}
	if (
		previousCheckpointHash !== GENESIS_CHECKPOINT_HASH &&
		!hex64Regex.test(previousCheckpointHash)
	) {
		throw new Error(
			`previousCheckpointHash must be a 64-character hex string or GENESIS_CHECKPOINT_HASH, received: ${previousCheckpointHash}`
		)
	}

	// Timestamp normalization
	const scheduledHourUtc = normalizeToUtcHourString(params.scheduledHourUtc)

	const checkpointFormatVersion = String(
		params.formatVersion || params.checkpointFormatVersion || CHECKPOINT_FORMAT_VERSION
	).trim()

	const checkpointId =
		params.checkpointId ||
		generateDeterministicCheckpointId(
			ledgerId,
			startSequence,
			endSequence,
			scheduledHourUtc
		)

	return {
		checkpointFormatVersion,
		checkpointId,
		endSequence,
		firstRecordHash,
		lastRecordHash,
		ledgerId,
		previousCheckpointHash,
		recordCount,
		scheduledHourUtc,
		startSequence,
	}
}

/**
 * Deterministically canonicalizes a checkpoint payload into a JSON string
 * with sorted lexicographical keys.
 *
 * @param {Object} payload - Checkpoint payload object
 * @returns {string} Canonical JSON string
 */
function canonicalizeCheckpointPayload(payload) {
	if (!payload || typeof payload !== 'object') {
		throw new TypeError('Payload must be an object for canonicalization.')
	}
	return canonicalizeValue(payload)
}

/**
 * Computes the SHA-256 checkpoint hash over the canonical checkpoint payload.
 *
 * @param {Object} payload - Checkpoint payload object
 * @returns {string} 64-character hexadecimal SHA-256 digest
 */
function calculateCheckpointHash(payload) {
	const canonical = canonicalizeCheckpointPayload(payload)
	return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex')
}

/**
 * Validates an existing checkpoint payload and verifies that its computed hash
 * matches the provided checkpointHash.
 *
 * @param {Object} payload - Checkpoint payload
 * @param {string} [expectedHash] - Optional expected SHA-256 hash
 * @returns {{ isValid: boolean, computedHash: string, errors: string[] }}
 */
function verifyCheckpointPayload(payload, expectedHash = null) {
	const errors = []
	let computedHash = ''

	try {
		const verified = constructCheckpointPayload(payload)
		computedHash = calculateCheckpointHash(verified)

		if (expectedHash && computedHash !== expectedHash) {
			errors.push(
				`Checkpoint hash mismatch: expected '${expectedHash}', computed '${computedHash}'.`
			)
		}
	} catch (err) {
		errors.push(`Payload structure error: ${err.message}`)
	}

	return {
		isValid: errors.length === 0,
		computedHash,
		errors,
	}
}

module.exports = {
	CHECKPOINT_FORMAT_VERSION,
	GENESIS_CHECKPOINT_HASH,
	FORBIDDEN_PAYLOAD_KEYS,
	normalizeToUtcHourString,
	generateDeterministicCheckpointId,
	constructCheckpointPayload,
	canonicalizeCheckpointPayload,
	calculateCheckpointHash,
	verifyCheckpointPayload,
}
