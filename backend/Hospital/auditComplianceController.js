/**
 * Audit Compliance Auditor Read-Only Controller
 * Namma Blood — Stage B3.5.4 Remediation: Independent Offline & Live Verification
 *
 * Exposes a strictly read-only, administrative endpoint for auditors to inspect,
 * cryptographically verify, and validate sequence continuity and S3 WORM evidence
 * across audit checkpoints without modifying any database or storage state.
 *
 * Guarantees:
 * 1. Strict Administrator Authorization: Requires Platform Administrator credentials.
 * 2. Zero-Trust Mode Transparency: Clearly states whether verification is offline
 *    (verifying stored metadata consistency) or live against AWS S3 API.
 * 3. Never implies MongoDB metadata constitutes live AWS verification.
 * 4. Explicit Retention Policy: Does NOT silently assume seven-year retention.
 * 5. Strictly Read-Only: Uses lean queries exclusively; mutates zero documents or watermarks.
 */

const { AuditCheckpoint } = require('./auditCheckpointModel')
const { AuditChainHead, GLOBAL_HEAD_ID } = require('./auditChainHeadModel')
const { AuditCheckpointCursor } = require('./auditCheckpointCursorModel')
const {
	verifyCheckpointChain,
	verifyCheckpointLiveAws,
	compareWatermarkConsistency,
	resolveRequiredRetentionDays,
	VERIFICATION_STATUS,
	VERIFICATION_MODE,
	RETENTION_VERIFICATION_SOURCE,
} = require('./auditCheckpointComplianceVerifier')
const { resolvePublicKey } = require('./auditSigningService')

/**
 * Controller to independently verify the compliance of persisted checkpoints.
 *
 * Query params:
 * - ledgerId: string (default: GLOBAL_HEAD_ID)
 * - startSequence: integer >= 1 (optional)
 * - endSequence: integer >= 1 (optional)
 * - requiredRetentionDays: integer (optional; no silent 7-year assumption)
 * - mode: 'crypto' | 'bundle' | 'live' (default: 'bundle')
 *
 * Strict read-only guarantee:
 * - Uses lean queries exclusively.
 * - Modifies zero documents, cursors, or head records.
 * - Advances zero watermarks.
 */
async function getComplianceVerification(req, res) {
	try {
		const ledgerId = (req.query.ledgerId || GLOBAL_HEAD_ID).trim()

		let requiredRetentionDays = null
		try {
			requiredRetentionDays = resolveRequiredRetentionDays({
				requiredRetentionDays: req.query.requiredRetentionDays,
			})
		} catch (err) {
			return res.status(400).json({
				status: 'fail',
				message: err.message,
			})
		}

		let startSequence = null
		if (req.query.startSequence !== undefined && req.query.startSequence !== '') {
			startSequence = parseInt(req.query.startSequence, 10)
			if (isNaN(startSequence) || startSequence < 1) {
				return res.status(400).json({
					status: 'fail',
					message: 'Invalid startSequence: must be a positive integer >= 1.',
				})
			}
		}

		let endSequence = null
		if (req.query.endSequence !== undefined && req.query.endSequence !== '') {
			endSequence = parseInt(req.query.endSequence, 10)
			if (isNaN(endSequence) || endSequence < 1) {
				return res.status(400).json({
					status: 'fail',
					message: 'Invalid endSequence: must be a positive integer >= 1.',
				})
			}
		}

		if (startSequence !== null && endSequence !== null && startSequence > endSequence) {
			return res.status(400).json({
				status: 'fail',
				message: 'startSequence cannot be greater than endSequence.',
			})
		}

		// Resolve requested verification mode
		const requestedMode = (req.query.mode || 'bundle').toLowerCase()
		let verificationMode = VERIFICATION_MODE.OFFLINE_EXPORTED_EVIDENCE
		if (requestedMode === 'crypto' || requestedMode === 'offline-crypto') {
			verificationMode = VERIFICATION_MODE.OFFLINE_CRYPTOGRAPHIC
		} else if (requestedMode === 'live' || requestedMode === 'live-aws') {
			verificationMode = VERIFICATION_MODE.LIVE_AWS_VERIFICATION
			if (process.env.ENABLE_LIVE_AWS_VERIFICATION !== 'true') {
				return res.status(400).json({
					status: 'fail',
					message:
						'Live AWS verification is disabled by default. Configure ENABLE_LIVE_AWS_VERIFICATION=true with read-only AWS credentials to enable live verification.',
				})
			}
		}

		// 1. Fetch read-only chain head and cursor (zero mutation)
		const [chainHead, cursor] = await Promise.all([
			AuditChainHead.findById(ledgerId).lean(),
			AuditCheckpointCursor.findOne({ ledgerId }).lean(),
		])

		// 2. Fetch checkpoints within requested sequence boundaries
		const query = { ledgerId }
		if (startSequence !== null || endSequence !== null) {
			query.startSequence = {}
			if (startSequence !== null) query.startSequence.$gte = startSequence
			if (endSequence !== null) query.startSequence.$lte = endSequence
		}

		const checkpoints = await AuditCheckpoint.find(query).sort({ startSequence: 1 }).lean()

		// 3. Resolve public key for verification
		let publicKey = null
		try {
			publicKey =
				process.env.AUDIT_SIGNING_PUBLIC_KEY ||
				process.env.AUDIT_CHECKPOINT_PUBLIC_KEY ||
				resolvePublicKey()
		} catch (e) {
			publicKey =
				process.env.AUDIT_SIGNING_PUBLIC_KEY ||
				process.env.AUDIT_CHECKPOINT_PUBLIC_KEY ||
				null
		}

		// 4. Run chain verification according to mode
		let verificationReport
		if (verificationMode === VERIFICATION_MODE.LIVE_AWS_VERIFICATION) {
			verificationReport = await verifyCheckpointLiveAws(checkpoints, {
				ledgerId,
				expectedStartSequence: startSequence !== null ? startSequence : 1,
				expectedEndSequence: endSequence !== null ? endSequence : undefined,
				requiredRetentionDays,
				publicKey,
			})
		} else {
			verificationReport = verifyCheckpointChain(checkpoints, {
				ledgerId,
				verificationMode,
				expectedStartSequence: startSequence !== null ? startSequence : 1,
				expectedEndSequence: endSequence !== null ? endSequence : undefined,
				requiredRetentionDays,
				publicKey,
			})
		}

		// 5. Compare watermarks (read-only)
		const chainEndSequence =
			checkpoints.length > 0 ? checkpoints[checkpoints.length - 1].endSequence : 0
		const watermarkComparison = compareWatermarkConsistency({
			operationalSequence: chainHead?.sequenceNumber ?? 0,
			checkpointCursorSequence: cursor?.lastCheckpointedSequence ?? 0,
			anchoredSequence: chainHead?.lastAnchoredSequence ?? 0,
			chainEndSequence,
		})

		// Incorporate watermark findings into verification report
		if (!watermarkComparison.consistent) {
			for (const issue of watermarkComparison.discrepancies) {
				verificationReport.findings = verificationReport.findings || []
				verificationReport.findings.push({
					severity: 'HIGH',
					code: 'WATERMARK_INCONSISTENCY',
					message: issue,
				})
			}
			if (verificationReport.overallStatus === VERIFICATION_STATUS.VALID) {
				verificationReport.overallStatus = VERIFICATION_STATUS.INCOMPLETE
			}
		}

		// Distinguish stored metadata consistency from live AWS verification
		const retentionSource =
			verificationMode === VERIFICATION_MODE.LIVE_AWS_VERIFICATION
				? RETENTION_VERIFICATION_SOURCE.LIVE_AWS_S3_API
				: RETENTION_VERIFICATION_SOURCE.STORED_MONGODB_METADATA_UNVERIFIED_LIVE

		const disclaimer =
			verificationMode === VERIFICATION_MODE.LIVE_AWS_VERIFICATION
				? 'Live AWS S3 Object Lock retention was independently verified against AWS API.'
				: 'Verification evaluated cryptographic integrity and MongoDB-stored metadata consistency. Live AWS S3 Object Lock retention has NOT been independently checked against AWS.'

		return res.status(200).json({
			status: 'success',
			data: {
				overallStatus: verificationReport.overallStatus,
				verificationMode: verificationReport.verificationMode,
				cryptographicVerificationStatus:
					verificationReport.cryptographicVerificationStatus,
				checkpointContinuityStatus:
					verificationReport.checkpointContinuityStatus,
				s3EvidenceVerificationStatus:
					verificationReport.s3EvidenceVerificationStatus,
				liveAwsVerificationPerformed:
					verificationReport.liveAwsVerificationPerformed,
				retentionVerificationSource: retentionSource,
				disclaimer,
				ledgerId,
				range: {
					startSequence,
					endSequence,
					checkpointsEvaluated: checkpoints.length,
				},
				verificationReport,
				watermarkConsistency: watermarkComparison,
			},
		})
	} catch (error) {
		return res.status(500).json({
			status: 'error',
			message: `Compliance verification failed: ${error.message}`,
		})
	}
}

module.exports = {
	getComplianceVerification,
}
