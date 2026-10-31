const mongoose = require('mongoose')
const { BloodUnit } = require('./bloodUnitModel')
const { recordAuditLog } = require('./bloodUnitAuditModel')
const ReceiveRequests = require('../BloodReceive/bloodReceiveModel')
const { withTransaction } = require('../Utils/transactionHelper')

let workerIntervalId = null
let isTickRunning = false
let activeTickPromise = null
let isWorkerStopping = false

// Observability & Metrics State
let bootedAt = null
let activeConfig = null
let lastRunAt = null
let lastRunDurationMs = null
let lastRunResult = null
let lastError = null

const cumulativeMetrics = {
	totalRuns: 0,
	totalProcessedCount: 0,
	totalReleasedCount: 0,
	totalExpiredCount: 0,
	totalSkippedCount: 0,
	totalFailedCount: 0,
	totalErrorsCount: 0,
}

/**
 * Sanitizes error messages by scrubbing potential credentials, secrets, connection URIs, and tokens.
 *
 * @param {string} message - Raw error message
 * @returns {string} Sanitized message
 */
function sanitizeErrorMessage(message) {
	if (!message || typeof message !== 'string') return 'Unknown error'
	return message
		.replace(/mongodb(?:\+srv)?:\/\/[^@\s]+@/gi, 'mongodb://***:***@')
		.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer ***')
		.slice(0, 500)
}

/**
 * Parses and validates reservation expiry worker configuration from environment variables.
 *
 * Default & Boundary Rules:
 * - ENABLE_RESERVATION_EXPIRY_WORKER: default false.
 * - RESERVATION_EXPIRY_INTERVAL_MS: default 60000ms, minimum 5000ms (clamped).
 * - RESERVATION_EXPIRY_BATCH_SIZE: default 100, clamped to 1–500.
 * - RESERVATION_EXPIRY_RUN_ON_BOOT: default true when worker is enabled.
 *
 * @param {Object} [env=process.env] - Environment object to parse
 * @returns {Object} Validated worker configuration
 */
function parseWorkerConfig(env = process.env) {
	const rawEnabled = env.ENABLE_RESERVATION_EXPIRY_WORKER
	const enabled =
		typeof rawEnabled === 'string'
			? rawEnabled.trim().toLowerCase() === 'true'
			: Boolean(rawEnabled)

	const parsedInterval = parseInt(env.RESERVATION_EXPIRY_INTERVAL_MS, 10)
	let intervalMs = 60000
	if (Number.isFinite(parsedInterval)) {
		intervalMs = Math.max(5000, parsedInterval)
	}

	const parsedBatch = parseInt(env.RESERVATION_EXPIRY_BATCH_SIZE, 10)
	let batchSize = 100
	if (Number.isFinite(parsedBatch)) {
		batchSize = Math.max(1, Math.min(parsedBatch, 500))
	}

	const rawRunOnBoot = env.RESERVATION_EXPIRY_RUN_ON_BOOT
	let runOnBoot = true
	if (rawRunOnBoot !== undefined && rawRunOnBoot !== null && String(rawRunOnBoot).trim() !== '') {
		const normalized = String(rawRunOnBoot).trim().toLowerCase()
		runOnBoot = normalized !== 'false' && normalized !== '0'
	}

	return {
		enabled,
		intervalMs,
		batchSize,
		runOnBoot,
	}
}

/**
 * Scans for traceable blood units whose reservation holds have elapsed and safely releases them.
 *
 * Strict Concurrency & Clinical Invariants:
 * 1. Database Readiness: Checks mongoose.connection.readyState === 1 before initiating queries.
 * 2. Bounded Batches: Fetches up to `batchSize` units to prevent unbounded memory/CPU consumption.
 * 3. Status Guard: Only units strictly in 'Reserved' status with 'reservation.reservedExpiresAt <= now' are targeted.
 *    Units already 'Issued', 'Dispatched', 'Discarded', or 'Available' are NEVER matched or mutated.
 * 4. Atomic Conditional Write: Each unit is transitioned via atomic conditional query.
 *    If a concurrent process issues the unit (status -> 'Issued') or extends the hold, the query matches 0 documents
 *    and the worker safely skips without error or data corruption.
 * 5. Request Lifecycle Policy: Expired unit IDs are removed from the associated receive request's `reservedUnitIds`
 *    via atomic `$pull`. The receive request's status is NOT cancelled or rejected, allowing blood bank staff to
 *    re-allocate fresh units in accordance with clinical governance rules.
 * 6. Shelf-Life Discrimination: If a unit's clinical `expiryDate <= now`, it is transitioned to 'Expired' (action: 'UNIT_EXPIRED');
 *    otherwise it returns to 'Available' (action: 'RESERVATION_EXPIRED' or 'RESERVATION_RELEASED').
 * 7. Tenant Scoping & Isolation: Every update and audit entry is strictly bound to `unit.bloodbankId`.
 * 8. Legacy Stock Isolation: Legacy aggregate `Bloodstock` is NEVER checked, decremented, or mutated.
 * 9. Idempotency: Repeated execution when no units have expired produces zero mutations (0 processed).
 *
 * @param {Object} options
 * @param {number} [options.batchSize=100] - Maximum units to process in one execution run
 * @param {Date} [options.now=new Date()] - Time baseline for expiration evaluation
 * @param {string|mongoose.Types.ObjectId} [options.bloodbankId=null] - Optional tenant scoping filter
 * @param {boolean} [options.skipDbCheck=false] - For mock testing only
 * @param {Object} [options.logger=console] - Custom logger interface
 * @returns {Promise<Object>} Execution metrics & audit summary
 */
async function processExpiredReservations({
	batchSize = 100,
	now = new Date(),
	bloodbankId = null,
	skipDbCheck = false,
	logger = console,
} = {}) {
	const startTime = Date.now()

	// 1. Database Readiness Guard
	if (!skipDbCheck && mongoose.connection && mongoose.connection.readyState !== 1) {
		const readyState = mongoose.connection.readyState
		const stateDescription =
			['disconnected', 'connected', 'connecting', 'disconnecting'][readyState] || 'unknown'
		if (logger && typeof logger.warn === 'function') {
			logger.warn(
				`[ReservationExpiryWorker] Database is not connected (readyState=${readyState} [${stateDescription}]); skipping reservation expiry sweep.`
			)
		}
		return {
			success: false,
			dbNotReady: true,
			readyState,
			candidatesFound: 0,
			processedCount: 0,
			releasedToAvailableCount: 0,
			transitionedToExpiredCount: 0,
			skippedCount: 0,
			failedCount: 0,
			errors: [{ error: `Database not connected (readyState=${readyState} [${stateDescription}])` }],
			durationMs: Date.now() - startTime,
		}
	}

	const effectiveNow = now instanceof Date ? now : new Date(now)
	const boundedLimit = Math.max(1, Math.min(Number(batchSize) || 100, 500))

	const query = {
		status: 'Reserved',
		'reservation.reservedExpiresAt': { $lte: effectiveNow, $ne: null },
	}

	if (bloodbankId) {
		query.bloodbankId = mongoose.Types.ObjectId.isValid(bloodbankId)
			? new mongoose.Types.ObjectId(bloodbankId)
			: bloodbankId
	}

	// Deterministic selection: oldest expired holds processed first
	const candidateUnits = await BloodUnit.find(query)
		.sort({ 'reservation.reservedExpiresAt': 1, _id: 1 })
		.limit(boundedLimit)

	let processedCount = 0
	let releasedToAvailableCount = 0
	let transitionedToExpiredCount = 0
	let skippedCount = 0
	let failedCount = 0
	const errors = []

	for (const candidate of candidateUnits) {
		try {
			await withTransaction(async (session) => {
				const isShelfLifeExpired =
					candidate.expiryDate && new Date(candidate.expiryDate) <= effectiveNow
				const targetStatus = isShelfLifeExpired ? 'Expired' : 'Available'
				const auditAction = isShelfLifeExpired ? 'UNIT_EXPIRED' : 'RESERVATION_EXPIRED'

				const targetRequestId = candidate.reservation?.receiveRequestId

				// Locate unit within transaction session checking status and hold expiry
				const unitToRelease = await BloodUnit.findOne(
					{
						_id: candidate._id,
						status: 'Reserved',
						'reservation.reservedExpiresAt': { $lte: effectiveNow, $ne: null },
						bloodbankId: candidate.bloodbankId,
					},
					null,
					{ session }
				)

				if (!unitToRelease) {
					// Race condition detected: concurrently issued, hold renewed, or manually released
					skippedCount++
					return
				}

				// Transition status and clear reservation metadata using document.save()
				// to enforce clinical safety validations and clearance integrity gates
				unitToRelease.status = targetStatus
				unitToRelease.reservation = {
					receiveRequestId: null,
					reservedAt: null,
					reservedExpiresAt: null,
				}

				await unitToRelease.save({ session })

				// Consistently pull unit reference from associated receive request
				if (targetRequestId) {
					await ReceiveRequests.findOneAndUpdate(
						{
							_id: targetRequestId,
							bloodbankId: candidate.bloodbankId,
						},
						{
							$pull: { reservedUnitIds: candidate._id },
						},
						{ session }
					)
				}

				// Append non-repudiable audit event inside transaction
				await recordAuditLog({
					unitId: unitToRelease._id,
					unitNumber: unitToRelease.unitNumber,
					bloodbankId: unitToRelease.bloodbankId,
					action: auditAction,
					previousStatus: 'Reserved',
					newStatus: targetStatus,
					actorId: unitToRelease.bloodbankId,
					actorModel: 'bloodbank',
					reason: isShelfLifeExpired
						? 'Reservation hold elapsed on clinically expired blood unit.'
						: 'Reservation hold expired; unit returned to available inventory by automated worker.',
					metadata: {
						receiveRequestId: targetRequestId || null,
						expiredHoldAt: candidate.reservation?.reservedExpiresAt || null,
						executedByWorker: true,
					},
					session,
				})

				if (isShelfLifeExpired) {
					transitionedToExpiredCount++
				} else {
					releasedToAvailableCount++
				}
				processedCount++
			})
		} catch (err) {
			failedCount++
			errors.push({
				unitId: candidate._id,
				error: sanitizeErrorMessage(err.message),
			})
			if (logger && typeof logger.error === 'function') {
				logger.error(
					`[ReservationExpiryWorker] Failed to process unit '${candidate.unitNumber || candidate._id}': ${sanitizeErrorMessage(err.message)}`
				)
			}
		}
	}

	return {
		success: failedCount === 0,
		candidatesFound: candidateUnits.length,
		processedCount,
		releasedToAvailableCount,
		transitionedToExpiredCount,
		skippedCount,
		failedCount,
		errors,
		durationMs: Date.now() - startTime,
	}
}

/**
 * Starts the periodic reservation expiry background worker.
 *
 * Safety & Observability:
 * - Interval timer is unreferenced (`timer.unref()`) so it never prevents clean Node.js process exit.
 * - Concurrency Lock: Prevents overlapping executions if a sweep takes longer than the interval.
 * - Graceful Error Handling: Catches unhandled rejections during worker tick and invokes onError callback.
 * - Boot Sweep: Optionally executes an immediate sweep on boot without overlapping scheduled ticks.
 *
 * @param {Object} options
 * @param {number} [options.intervalMs=60000] - Polling interval in milliseconds (default: 60s, min: 5s)
 * @param {number} [options.batchSize=100] - Batch size per tick (clamped 1–500)
 * @param {boolean} [options.runOnBoot=true] - Execute immediate sweep upon startup
 * @param {Function} [options.onError] - Error handler callback
 * @param {Object} [options.logger=console] - Logger interface
 * @returns {Object} Worker control handle { stop, isRunning, runOnce, getStatus }
 */
function startReservationExpiryWorker({
	intervalMs = 60000,
	batchSize = 100,
	runOnBoot = true,
	onError = null,
	logger = console,
} = {}) {
	if (workerIntervalId) {
		if (logger && typeof logger.warn === 'function') {
			logger.warn('[ReservationExpiryWorker] Worker is already running. Call stopReservationExpiryWorker() first.')
		}
		return {
			stop: stopReservationExpiryWorker,
			isRunning: () => true,
			runOnce: () => runTick(),
			getStatus: getWorkerStatus,
		}
	}

	isWorkerStopping = false
	bootedAt = new Date()
	activeConfig = {
		intervalMs: Math.max(5000, Number(intervalMs) || 60000),
		batchSize: Math.max(1, Math.min(Number(batchSize) || 100, 500)),
		runOnBoot: Boolean(runOnBoot),
	}

	async function runTick() {
		if (isWorkerStopping) {
			return null
		}
		if (isTickRunning) {
			if (logger && typeof logger.warn === 'function') {
				logger.warn('[ReservationExpiryWorker] Previous sweep is still active; skipping tick to prevent overlap.')
			}
			return activeTickPromise
		}

		isTickRunning = true
		activeTickPromise = (async () => {
			try {
				const result = await processExpiredReservations({
					batchSize: activeConfig.batchSize,
					logger,
				})

				lastRunAt = new Date()
				lastRunDurationMs = result ? result.durationMs : 0
				lastRunResult = result ? { ...result } : null

				if (result && !result.dbNotReady) {
					cumulativeMetrics.totalRuns++
					cumulativeMetrics.totalProcessedCount += result.processedCount || 0
					cumulativeMetrics.totalReleasedCount += result.releasedToAvailableCount || 0
					cumulativeMetrics.totalExpiredCount += result.transitionedToExpiredCount || 0
					cumulativeMetrics.totalSkippedCount += result.skippedCount || 0
					cumulativeMetrics.totalFailedCount += result.failedCount || 0

					if (result.failedCount > 0) {
						cumulativeMetrics.totalErrorsCount += result.failedCount
						const firstErr = result.errors?.[0]
						lastError = {
							timestamp: new Date().toISOString(),
							message: sanitizeErrorMessage(firstErr?.error || 'Batch item processing failure'),
							unitId: firstErr?.unitId ? String(firstErr.unitId) : null,
						}
					}
				}

				if (result && result.processedCount > 0 && logger && typeof logger.info === 'function') {
					logger.info(
						`[ReservationExpiryWorker] Processed ${result.processedCount} expired reservation(s) (${result.releasedToAvailableCount} released, ${result.transitionedToExpiredCount} expired) in ${result.durationMs}ms.`
					)
				}
				return result
			} catch (err) {
				const sanitizedMsg = sanitizeErrorMessage(err.message)
				lastError = {
					timestamp: new Date().toISOString(),
					message: sanitizedMsg,
					unitId: null,
				}
				cumulativeMetrics.totalErrorsCount++

				if (typeof onError === 'function') {
					try {
						onError(err)
					} catch (_) {}
				} else if (logger && typeof logger.error === 'function') {
					logger.error(`[ReservationExpiryWorker] Unhandled error during tick: ${sanitizedMsg}`)
				}
				return null
			} finally {
				isTickRunning = false
				activeTickPromise = null
			}
		})()

		return activeTickPromise
	}

	workerIntervalId = setInterval(runTick, activeConfig.intervalMs)
	if (typeof workerIntervalId.unref === 'function') {
		workerIntervalId.unref()
	}

	if (logger && typeof logger.info === 'function') {
		logger.info(
			`[ReservationExpiryWorker] Started with interval ${activeConfig.intervalMs}ms, batchSize ${activeConfig.batchSize}, runOnBoot=${activeConfig.runOnBoot}.`
		)
	}

	// Immediate run-on-boot sweep if enabled
	if (activeConfig.runOnBoot) {
		runTick().catch((err) => {
			if (logger && typeof logger.error === 'function') {
				logger.error(`[ReservationExpiryWorker] Boot sweep error: ${sanitizeErrorMessage(err.message)}`)
			}
		})
	}

	return {
		stop: stopReservationExpiryWorker,
		isRunning: () => workerIntervalId !== null,
		runOnce: () => runTick(),
		getStatus: getWorkerStatus,
	}
}

/**
 * Stops the periodic reservation expiry background worker gracefully.
 *
 * @param {Object} options
 * @param {boolean} [options.drain=true] - Await in-flight sweep completion before resolving
 * @param {number} [options.timeoutMs=10000] - Maximum milliseconds to wait for drain
 * @returns {Promise<boolean>}
 */
async function stopReservationExpiryWorker({
	drain = true,
	timeoutMs = 10000,
} = {}) {
	isWorkerStopping = true

	if (workerIntervalId) {
		clearInterval(workerIntervalId)
		workerIntervalId = null
	}

	if (drain && isTickRunning && activeTickPromise) {
		try {
			let timerId = null
			const timeoutPromise = new Promise((_, reject) => {
				timerId = setTimeout(() => {
					reject(new Error(`Worker stop drain timed out after ${timeoutMs}ms`))
				}, timeoutMs)
				if (typeof timerId.unref === 'function') timerId.unref()
			})
			await Promise.race([activeTickPromise, timeoutPromise])
			if (timerId) clearTimeout(timerId)
		} catch (err) {
			// Drain timeout absorbed to ensure graceful stop completes
		}
	}

	isTickRunning = false
	activeTickPromise = null
	isWorkerStopping = false
	return true
}

/**
 * Returns read-only operational telemetry and diagnostics for the worker.
 *
 * @returns {Object} Safe worker telemetry and status snapshot
 */
function getWorkerStatus() {
	return {
		isRunning: workerIntervalId !== null,
		isTickRunning,
		isStopping: isWorkerStopping,
		bootedAt: bootedAt ? new Date(bootedAt).toISOString() : null,
		config: activeConfig ? { ...activeConfig } : null,
		lastRunAt: lastRunAt ? new Date(lastRunAt).toISOString() : null,
		lastRunDurationMs,
		lastRunResult: lastRunResult ? { ...lastRunResult } : null,
		metrics: { ...cumulativeMetrics },
		lastError: lastError ? { ...lastError } : null,
	}
}

/**
 * Resets worker metrics and internal state for isolated testing.
 * @private
 */
function _resetWorkerStateForTests() {
	if (workerIntervalId) {
		clearInterval(workerIntervalId)
		workerIntervalId = null
	}
	isTickRunning = false
	activeTickPromise = null
	isWorkerStopping = false
	bootedAt = null
	activeConfig = null
	lastRunAt = null
	lastRunDurationMs = null
	lastRunResult = null
	lastError = null
	cumulativeMetrics.totalRuns = 0
	cumulativeMetrics.totalProcessedCount = 0
	cumulativeMetrics.totalReleasedCount = 0
	cumulativeMetrics.totalExpiredCount = 0
	cumulativeMetrics.totalSkippedCount = 0
	cumulativeMetrics.totalFailedCount = 0
	cumulativeMetrics.totalErrorsCount = 0
}

module.exports = {
	parseWorkerConfig,
	processExpiredReservations,
	startReservationExpiryWorker,
	stopReservationExpiryWorker,
	getWorkerStatus,
	sanitizeErrorMessage,
	_resetWorkerStateForTests,
}
