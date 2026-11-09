/**
 * Audit WORM Storage Adapter (AWS S3 Object Lock in COMPLIANCE mode)
 * Namma Blood — Stage B3.5.3 External WORM Anchoring & S3 Object Lock
 *
 * Implements an isolated, least-privilege AWS S3 client adapter enforcing
 * Write-Once-Read-Many (WORM) storage using S3 Object Lock in COMPLIANCE mode.
 *
 * Security & Architectural Invariants:
 * 1. Strictly enforces Object Lock COMPLIANCE mode (never downgrades to GOVERNANCE).
 * 2. Mandatory retention duration configuration (AUDIT_WORM_RETENTION_DAYS).
 * 3. Deterministic object key structure preventing path traversal.
 * 4. Content checksum verification (SHA-256).
 * 5. Returns exact S3 VersionId for independent verification.
 * 6. ZERO delete or overwrite operations are exposed or implemented.
 * 7. Supports dependency injection of S3Client for isolated local mock tests.
 */

const crypto = require('crypto')
const {
	S3Client,
	PutObjectCommand,
	GetObjectCommand,
	GetObjectRetentionCommand,
	ListObjectVersionsCommand,
} = require('@aws-sdk/client-s3')

const S3_KEY_PREFIX = 'namma-blood/audit-checkpoints/v1'
const TARGET_OBJECT_LOCK_MODE = 'COMPLIANCE'

/**
 * Validates and formats a deterministic S3 object key.
 *
 * @param {string} ledgerId
 * @param {string} checkpointId
 * @returns {string} S3 Object Key
 */
function buildS3ObjectKey(ledgerId, checkpointId) {
	if (!ledgerId || typeof ledgerId !== 'string' || !/^[a-zA-Z0-9_\-]+$/.test(ledgerId)) {
		throw new Error(
			`Invalid ledgerId '${ledgerId}': must contain only alphanumeric characters, underscores, and dashes.`
		)
	}
	if (!checkpointId || typeof checkpointId !== 'string' || !/^[a-zA-Z0-9_\-]+$/.test(checkpointId)) {
		throw new Error(
			`Invalid checkpointId '${checkpointId}': must contain only alphanumeric characters, underscores, and dashes.`
		)
	}
	return `${S3_KEY_PREFIX}/${ledgerId}/${checkpointId}.json`
}

/**
 * Validates that an S3 object key strictly matches the approved format.
 *
 * @param {string} key
 * @returns {boolean}
 */
function validateS3ObjectKey(key) {
	const pattern = /^namma-blood\/audit-checkpoints\/v1\/[a-zA-Z0-9_\-]+\/[a-zA-Z0-9_\-]+\.json$/
	return typeof key === 'string' && pattern.test(key) && !key.includes('..')
}

/**
 * Validates the retention duration in days.
 *
 * @param {number|string} retentionDays
 * @returns {number} Validated integer retention duration in days
 */
function validateRetentionDays(retentionDays) {
	if (retentionDays === undefined || retentionDays === null || retentionDays === '') {
		throw new Error('AUDIT_WORM_RETENTION_DAYS is required and cannot be empty.')
	}

	const parsed = Number(retentionDays)
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(
			`Invalid retention duration '${retentionDays}': must be a positive integer greater than zero.`
		)
	}

	// Compliance sanity bounds (minimum 1 day, maximum 36500 days / ~100 years)
	if (parsed < 1 || parsed > 36500) {
		throw new Error(
			`Retention duration of ${parsed} days is outside allowed bounds (1 to 36500 days).`
		)
	}

	return parsed
}

/**
 * Calculates the exact UTC RetainUntilDate timestamp based on retention days.
 *
 * @param {number} retentionDays
 * @param {Date} [baseDate=new Date()]
 * @returns {Date}
 */
function calculateRetainUntilDate(retentionDays, baseDate = new Date()) {
	const days = validateRetentionDays(retentionDays)
	const retainUntilMs = baseDate.getTime() + days * 24 * 60 * 60 * 1000
	return new Date(retainUntilMs)
}

class AuditWormStorageAdapter {
	/**
	 * @param {Object} [options={}]
	 * @param {S3Client} [options.s3Client=null] - Injected AWS S3Client (e.g. for mock testing)
	 * @param {string} [options.bucket] - Target S3 Bucket
	 * @param {string} [options.region] - AWS Region
	 * @param {number} [options.retentionDays] - Retention duration in days
	 */
	constructor(options = {}) {
		this.bucket = options.bucket || process.env.AUDIT_WORM_S3_BUCKET || 'namma-blood-audit-worm'
		this.region = options.region || process.env.AUDIT_WORM_S3_REGION || 'ap-south-1'
		this.retentionDays = options.retentionDays || process.env.AUDIT_WORM_RETENTION_DAYS || null

		// Injected or newly initialized S3Client
		this.s3Client =
			options.s3Client ||
			new S3Client({
				region: this.region,
			})
	}

	/**
	 * Uploads checkpoint evidence document to AWS S3 with Object Lock in COMPLIANCE mode.
	 *
	 * @param {Object} params
	 * @param {string} params.ledgerId
	 * @param {string} params.checkpointId
	 * @param {Object} params.evidenceDocument - Cryptographic evidence payload
	 * @param {number} [params.retentionDays]
	 * @returns {Promise<{ bucket: string, objectKey: string, versionId: string, eTag: string, sha256Checksum: string, retentionUntil: Date, objectLockMode: string }>}
	 */
	async uploadCheckpointEvidence(params) {
		const { ledgerId, checkpointId, evidenceDocument } = params
		const retentionDays = validateRetentionDays(params.retentionDays || this.retentionDays)

		const objectKey = buildS3ObjectKey(ledgerId, checkpointId)
		if (!validateS3ObjectKey(objectKey)) {
			throw new Error(`Security Violation: Unsafe S3 object key '${objectKey}' generated.`)
		}

		if (!evidenceDocument || typeof evidenceDocument !== 'object') {
			throw new TypeError('evidenceDocument must be a valid object.')
		}

		const bodyString = JSON.stringify(evidenceDocument)
		const sha256Checksum = crypto.createHash('sha256').update(bodyString, 'utf8').digest('hex')
		const retainUntilDate = calculateRetainUntilDate(retentionDays)

		const putParams = {
			Bucket: this.bucket,
			Key: objectKey,
			Body: bodyString,
			ContentType: 'application/json',
			ObjectLockMode: TARGET_OBJECT_LOCK_MODE,
			ObjectLockRetainUntilDate: retainUntilDate,
			Metadata: {
				'x-namma-ledger-id': ledgerId,
				'x-namma-checkpoint-id': checkpointId,
				'x-namma-sha256': sha256Checksum,
			},
		}

		const response = await this.s3Client.send(new PutObjectCommand(putParams))

		const versionId = response.VersionId
		if (!versionId || typeof versionId !== 'string') {
			throw new Error(
				`S3 Bucket Configuration Error: Object uploaded to '${this.bucket}' without a VersionId. S3 bucket versioning and Object Lock must be enabled.`
			)
		}

		return {
			bucket: this.bucket,
			objectKey,
			versionId,
			eTag: response.ETag ? response.ETag.replace(/"/g, '') : null,
			sha256Checksum,
			retentionUntil: retainUntilDate,
			objectLockMode: TARGET_OBJECT_LOCK_MODE,
		}
	}

	/**
	 * Retrieves the exact version of an object from S3.
	 *
	 * @param {Object} params
	 * @param {string} [params.bucket]
	 * @param {string} params.objectKey
	 * @param {string} params.versionId
	 * @returns {Promise<{ body: string, versionId: string, eTag: string, sha256Checksum: string }>}
	 */
	async getObjectVersion(params) {
		const bucket = params.bucket || this.bucket
		const { objectKey, versionId } = params

		if (!validateS3ObjectKey(objectKey)) {
			throw new Error(`Invalid S3 object key: '${objectKey}'.`)
		}
		if (!versionId || typeof versionId !== 'string') {
			throw new Error('versionId is required to retrieve exact object version.')
		}

		const getParams = {
			Bucket: bucket,
			Key: objectKey,
			VersionId: versionId,
		}

		const response = await this.s3Client.send(new GetObjectCommand(getParams))

		// Read stream body into string
		const body = await response.Body.transformToString('utf8')
		const sha256Checksum = crypto.createHash('sha256').update(body, 'utf8').digest('hex')

		return {
			body,
			versionId: response.VersionId || versionId,
			eTag: response.ETag ? response.ETag.replace(/"/g, '') : null,
			sha256Checksum,
		}
	}

	/**
	 * Retrieves and verifies the S3 Object Lock retention metadata for an exact object version.
	 *
	 * @param {Object} params
	 * @param {string} [params.bucket]
	 * @param {string} params.objectKey
	 * @param {string} params.versionId
	 * @returns {Promise<{ mode: string, retainUntilDate: Date }>}
	 */
	async getObjectRetention(params) {
		const bucket = params.bucket || this.bucket
		const { objectKey, versionId } = params

		if (!validateS3ObjectKey(objectKey)) {
			throw new Error(`Invalid S3 object key: '${objectKey}'.`)
		}
		if (!versionId || typeof versionId !== 'string') {
			throw new Error('versionId is required to check Object Lock retention.')
		}

		const command = new GetObjectRetentionCommand({
			Bucket: bucket,
			Key: objectKey,
			VersionId: versionId,
		})

		const response = await this.s3Client.send(command)

		const retention = response.Retention
		if (!retention || !retention.Mode || !retention.RetainUntilDate) {
			throw new Error(
				`Object Lock Missing: Object version '${versionId}' has no active retention metadata configured.`
			)
		}

		if (retention.Mode !== TARGET_OBJECT_LOCK_MODE) {
			throw new Error(
				`Security Violation: Object Lock mode is '${retention.Mode}', expected strictly '${TARGET_OBJECT_LOCK_MODE}'. GOVERNANCE mode or unconfigured retention is prohibited.`
			)
		}

		return {
			mode: retention.Mode,
			retainUntilDate: new Date(retention.RetainUntilDate),
		}
	}

	/**
	 * Lists all existing versions for a deterministic S3 object key.
	 *
	 * @param {Object} params
	 * @param {string} [params.bucket]
	 * @param {string} params.objectKey
	 * @returns {Promise<Array<{ versionId: string, key: string, isLatest: boolean, lastModified: Date, eTag: string }>>}
	 */
	async listObjectVersions(params) {
		const bucket = params.bucket || this.bucket
		const { objectKey } = params

		if (!validateS3ObjectKey(objectKey)) {
			throw new Error(`Invalid S3 object key: '${objectKey}'.`)
		}

		const command = new ListObjectVersionsCommand({
			Bucket: bucket,
			Prefix: objectKey,
		})

		const response = await this.s3Client.send(command)
		const versions = response.Versions || []

		// Filter strictly to exact objectKey match (Prefix is a substring/prefix match)
		const matchingVersions = versions
			.filter((v) => v.Key === objectKey)
			.map((v) => ({
				versionId: v.VersionId,
				key: v.Key,
				isLatest: Boolean(v.IsLatest),
				lastModified: v.LastModified ? new Date(v.LastModified) : new Date(),
				eTag: v.ETag ? v.ETag.replace(/"/g, '') : null,
			}))

		// Sort ascending by lastModified (earliest created version first)
		matchingVersions.sort((a, b) => a.lastModified.getTime() - b.lastModified.getTime())

		return matchingVersions
	}
}

module.exports = {
	S3_KEY_PREFIX,
	TARGET_OBJECT_LOCK_MODE,
	buildS3ObjectKey,
	validateS3ObjectKey,
	validateRetentionDays,
	calculateRetainUntilDate,
	AuditWormStorageAdapter,
}
