const mongoose = require('mongoose')
const { BloodUnit } = require('./bloodUnitModel')
const { recordAuditLog } = require('./bloodUnitAuditModel')
const ReceiveRequests = require('../BloodReceive/bloodReceiveModel')
const { withTransaction } = require('../Utils/transactionHelper')

let workerIntervalId = null
let isTickRunning = false

/**
 * Scans for traceable blood units whose reservation holds have elapsed and safely releases them.
 *
 * Strict Concurrency & Clinical Invariants:
 * 1. Bounded Batches: Fetches up to `batchSize` units to prevent unbounded memory/CPU consumption.
 * 2. Status Guard: Only units strictly in 'Reserved' status with 'reservation.reservedExpiresAt <= now' are targeted.
 *    Units already 'Issued', 'Dispatched', 'Discarded', or 'Available' are NEVER matched or mutated.
 * 3. Atomic Conditional Write: Each unit is transitioned via atomic conditional query.
 *    If a concurrent process issues the unit (status -> 'Issued') or extends the hold, the query matches 0 documents
 *    and the worker safely skips without error or data corruption.
 * 4. Request Lifecycle Policy: Expired unit IDs are removed from the associated receive request's `reservedUnitIds`
 *    via atomic `$pull`. The receive request's status is NOT cancelled or rejected, allowing blood bank staff to
 *    re-allocate fresh units in accordance with clinical governance rules.
 * 5. Shelf-Life Discrimination: If a unit's clinical `expiryDate <= now`, it is transitioned to 'Expired' (action: 'UNIT_EXPIRED');
 *    otherwise it returns to 'Available' (action: 'RESERVATION_EXPIRED' or 'RESERVATION_RELEASED').
 * 6. Tenant Scoping & Isolation: Every update and audit entry is strictly bound to `unit.bloodbankId`.
 * 7. Legacy Stock Isolation: Legacy aggregate `Bloodstock` is NEVER checked, decremented, or mutated.
 * 8. Idempotency: Repeated execution when no units have expired produces zero mutations (0 processed).
 *
 * @param {Object} options
 * @param {number} [options.batchSize=100] - Maximum units to process in one execution run
 * @param {Date} [options.now=new Date()] - Time baseline for expiration evaluation
 * @param {string|mongoose.Types.ObjectId} [options.bloodbankId=null] - Optional tenant scoping filter
 * @param {Object} [options.logger=console] - Custom logger interface
 * @returns {Promise<Object>} Execution metrics & audit summary
 */
async function processExpiredReservations({
	batchSize = 100,
	now = new Date(),
	bloodbankId = null,
	logger = console,
} = {}) {
	const startTime = Date.now()
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
				error: err.message,
			})
			if (logger && typeof logger.error === 'function') {
				logger.error(
					`[ReservationExpiryWorker] Failed to process unit '${candidate.unitNumber || candidate._id}': ${err.message}`
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
 * - Concurrency Lock: Prevents overlapping executions if a batch run takes longer than the interval.
 * - Graceful Error Handling: Catches unhandled rejections during worker tick and invokes onError callback.
 *
 * @param {Object} options
 * @param {number} [options.intervalMs=60000] - Polling interval in milliseconds (default: 60s)
 * @param {number} [options.batchSize=100] - Batch size per tick
 * @param {Function} [options.onError] - Error handler callback
 * @param {Object} [options.logger=console] - Logger interface
 * @returns {Object} Worker control handle { stop, isRunning }
 */
function startReservationExpiryWorker({
	intervalMs = 60000,
	batchSize = 100,
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
		}
	}

	async function runTick() {
		if (isTickRunning) {
			if (logger && typeof logger.warn === 'function') {
				logger.warn('[ReservationExpiryWorker] Previous tick is still active; skipping tick to prevent overlap.')
			}
			return
		}

		isTickRunning = true
		try {
			const result = await processExpiredReservations({ batchSize, logger })
			if (result.processedCount > 0 && logger && typeof logger.info === 'function') {
				logger.info(
					`[ReservationExpiryWorker] Processed ${result.processedCount} expired reservation(s) (${result.releasedToAvailableCount} released, ${result.transitionedToExpiredCount} expired) in ${result.durationMs}ms.`
				)
			}
		} catch (err) {
			if (typeof onError === 'function') {
				onError(err)
			} else if (logger && typeof logger.error === 'function') {
				logger.error(`[ReservationExpiryWorker] Unhandled error during tick: ${err.message}`)
			}
		} finally {
			isTickRunning = false
		}
	}

	workerIntervalId = setInterval(runTick, intervalMs)
	if (typeof workerIntervalId.unref === 'function') {
		workerIntervalId.unref()
	}

	if (logger && typeof logger.info === 'function') {
		logger.info(`[ReservationExpiryWorker] Started with interval ${intervalMs}ms and batchSize ${batchSize}.`)
	}

	return {
		stop: stopReservationExpiryWorker,
		isRunning: () => workerIntervalId !== null,
		runOnce: () => runTick(),
	}
}

/**
 * Stops the periodic reservation expiry background worker.
 */
function stopReservationExpiryWorker() {
	if (workerIntervalId) {
		clearInterval(workerIntervalId)
		workerIntervalId = null
		isTickRunning = false
	}
}

module.exports = {
	processExpiredReservations,
	startReservationExpiryWorker,
	stopReservationExpiryWorker,
}
