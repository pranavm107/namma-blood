/**
 * Audit Checkpoint Scheduler Service
 * Namma Blood — Stage B3.5.2 Hourly Audit Checkpoint Generation & Recovery
 *
 * Implements an isolated, UTC-aligned hourly scheduler for automated audit checkpoint
 * generation with distributed lease control and concurrency safety.
 *
 * Configuration Invariants:
 * - Disabled by default in development and test environments unless explicitly enabled.
 * - Supports manual programmatic execution for deterministic testing and operations.
 * - Prevents concurrent in-process executions via activeTickPromise lock.
 */

const mongoose = require('mongoose')
const {
	generateHourlyCheckpoint,
	DEFAULT_BATCH_LIMIT,
	DEFAULT_CLAIM_TTL_MS,
} = require('./auditCheckpointGenerationService')
const {
	reconcileStaleClaims,
} = require('./auditCheckpointRecoveryService')
const {
	normalizeToUtcHourString,
} = require('./auditCheckpointPayloadService')
const {
	anchorNextCheckpoint,
	reconcileStaleAnchoringClaims,
} = require('./auditCheckpointAnchoringService')

let schedulerIntervalId = null
let anchoringSchedulerIntervalId = null
let isTickRunning = false
let isAnchoringTickRunning = false
let activeTickPromise = null
let activeAnchoringTickPromise = null
let isSchedulerStopping = false

// Observability and metrics
let bootedAt = null
let activeConfig = null
let lastRunAt = null
let lastRunDurationMs = null
let lastRunResult = null
let lastError = null

const cumulativeMetrics = {
	totalRuns: 0,
	totalCheckpointsCreated: 0,
	totalSkippedRuns: 0,
	totalAlreadyExistsRuns: 0,
	totalClaimActiveRuns: 0,
	totalErrors: 0,
}

/**
 * Parses and validates checkpoint scheduler configuration.
 *
 * Defaults:
 * - ENABLE_AUDIT_CHECKPOINT_SCHEDULER: false
 * - AUDIT_CHECKPOINT_INTERVAL_MS: 3600000 (1 hour, clamped min 5000ms)
 * - AUDIT_CHECKPOINT_BATCH_LIMIT: 1000 (clamped 1-5000)
 * - AUDIT_CHECKPOINT_CLAIM_TTL_MS: 60000 (1 min, clamped min 5000ms)
 *
 * @param {Object} [env=process.env]
 * @returns {Object} Validated config object
 */
function parseCheckpointSchedulerConfig(env = process.env) {
	const rawEnabled = env.ENABLE_AUDIT_CHECKPOINT_SCHEDULER
	const enabled =
		typeof rawEnabled === 'string'
			? rawEnabled.trim().toLowerCase() === 'true'
			: Boolean(rawEnabled)

	const parsedInterval = parseInt(env.AUDIT_CHECKPOINT_INTERVAL_MS, 10)
	let intervalMs = 3600000 // 1 hour
	if (Number.isFinite(parsedInterval)) {
		intervalMs = Math.max(5000, parsedInterval)
	}

	const parsedBatch = parseInt(env.AUDIT_CHECKPOINT_BATCH_LIMIT, 10)
	let batchLimit = DEFAULT_BATCH_LIMIT
	if (Number.isFinite(parsedBatch)) {
		batchLimit = Math.max(1, Math.min(parsedBatch, 5000))
	}

	const parsedTtl = parseInt(env.AUDIT_CHECKPOINT_CLAIM_TTL_MS, 10)
	let claimTtlMs = DEFAULT_CLAIM_TTL_MS
	if (Number.isFinite(parsedTtl)) {
		claimTtlMs = Math.max(5000, parsedTtl)
	}

	return {
		enabled,
		intervalMs,
		batchLimit,
		claimTtlMs,
	}
}

/**
 * Executes a single checkpoint generation tick.
 *
 * @param {Object} [options={}]
 * @param {Date|string} [options.injectedDate=null] - Optional injected clock for deterministic tests
 * @param {number} [options.batchLimit]
 * @param {number} [options.claimTtlMs]
 * @returns {Promise<Object>} Execution result
 */
async function runScheduledCheckpointTick(options = {}) {
	if (isTickRunning && activeTickPromise) {
		return await activeTickPromise
	}

	isTickRunning = true
	const startTime = Date.now()

	activeTickPromise = (async () => {
		try {
			// Fail-closed guard: Database must be connected
			if (mongoose.connection.readyState !== 1) {
				return {
					status: 'SKIPPED',
					reason: 'DATABASE_DISCONNECTED',
					message: 'MongoDB connection is not in ready state 1.',
				}
			}

			const config = activeConfig || parseCheckpointSchedulerConfig()
			const batchLimit = options.batchLimit || config.batchLimit
			const claimTtlMs = options.claimTtlMs || config.claimTtlMs
			const now = options.injectedDate ? new Date(options.injectedDate) : new Date()
			const scheduledHourUtc = normalizeToUtcHourString(now)

			// 1. Reconcile stale claims first
			await reconcileStaleClaims(claimTtlMs).catch(() => {})

			// 2. Generate checkpoint for current UTC hour
			const result = await generateHourlyCheckpoint({
				scheduledHourUtc,
				batchLimit,
				claimTtlMs,
			})

			lastRunAt = new Date()
			lastRunDurationMs = Date.now() - startTime
			lastRunResult = result
			lastError = null

			cumulativeMetrics.totalRuns++
			if (result.status === 'CREATED') {
				cumulativeMetrics.totalCheckpointsCreated++
			} else if (result.status === 'SKIPPED') {
				cumulativeMetrics.totalSkippedRuns++
			} else if (result.status === 'ALREADY_EXISTS') {
				cumulativeMetrics.totalAlreadyExistsRuns++
			} else if (result.status === 'CLAIM_ACTIVE') {
				cumulativeMetrics.totalClaimActiveRuns++
			}

			return result
		} catch (err) {
			lastRunAt = new Date()
			lastRunDurationMs = Date.now() - startTime
			lastRunResult = { status: 'ERROR', error: err.message }
			lastError = err.message
			cumulativeMetrics.totalRuns++
			cumulativeMetrics.totalErrors++
			throw err
		} finally {
			isTickRunning = false
			activeTickPromise = null
		}
	})()

	return await activeTickPromise
}

/**
 * Starts the hourly audit checkpoint scheduler.
 *
 * @param {Object} [customConfig=null] - Optional configuration overrides
 * @returns {boolean} True if started, false if disabled
 */
function startCheckpointScheduler(customConfig = null) {
	if (schedulerIntervalId) {
		return true // Already running
	}

	activeConfig = customConfig || parseCheckpointSchedulerConfig()

	if (!activeConfig.enabled) {
		return false
	}

	bootedAt = new Date()
	isSchedulerStopping = false

	schedulerIntervalId = setInterval(async () => {
		if (isSchedulerStopping) return
		try {
			await runScheduledCheckpointTick()
		} catch (err) {
			// Scheduler tick errors are recorded in metrics, never crash process
		}
	}, activeConfig.intervalMs)

	// Unref interval timer so it does not block Node process exit
	if (schedulerIntervalId && typeof schedulerIntervalId.unref === 'function') {
		schedulerIntervalId.unref()
	}

	return true
}

/**
 * Stops the checkpoint scheduler.
 */
function stopCheckpointScheduler() {
	isSchedulerStopping = true
	if (schedulerIntervalId) {
		clearInterval(schedulerIntervalId)
		schedulerIntervalId = null
	}
	isTickRunning = false
	activeTickPromise = null
}

/**
 * Returns current scheduler observability metrics and state.
 *
 * @returns {Object} Scheduler metrics
 */
function getSchedulerStatus() {
	return {
		isRunning: Boolean(schedulerIntervalId),
		isTickRunning,
		bootedAt,
		activeConfig: activeConfig ? { ...activeConfig } : null,
		lastRunAt,
		lastRunDurationMs,
		lastRunResult,
		lastError,
		cumulativeMetrics: { ...cumulativeMetrics },
	}
}

/**
 * Executes a single external WORM anchoring tick.
 * Reconciles stale claims and anchors the next eligible pending checkpoint.
 *
 * @param {Object} [options={}]
 * @returns {Promise<Object>} Execution result
 */
async function runScheduledAnchoringTick(options = {}) {
	if (isAnchoringTickRunning && activeAnchoringTickPromise) {
		return await activeAnchoringTickPromise
	}

	isAnchoringTickRunning = true

	activeAnchoringTickPromise = (async () => {
		try {
			if (mongoose.connection.readyState !== 1) {
				return {
					status: 'SKIPPED',
					reason: 'DATABASE_DISCONNECTED',
					message: 'MongoDB connection is not in ready state 1.',
				}
			}

			// 1. Reconcile stale anchoring claims
			await reconcileStaleAnchoringClaims().catch(() => {})

			// 2. Anchor next checkpoint
			const result = await anchorNextCheckpoint(options)
			return result
		} finally {
			isAnchoringTickRunning = false
			activeAnchoringTickPromise = null
		}
	})()

	return await activeAnchoringTickPromise
}

/**
 * Starts the external WORM anchoring scheduler.
 *
 * @param {Object} [customConfig=null]
 * @returns {boolean} True if started, false if disabled
 */
function startAnchoringScheduler(customConfig = null) {
	if (anchoringSchedulerIntervalId) {
		return true
	}

	const enabled =
		customConfig?.enabled ??
		(process.env.ENABLE_AUDIT_ANCHORING_SCHEDULER === 'true' || false)

	if (!enabled) {
		return false
	}

	const intervalMs = customConfig?.intervalMs || 3600000 // 1 hour

	anchoringSchedulerIntervalId = setInterval(async () => {
		try {
			await runScheduledAnchoringTick(customConfig)
		} catch (err) {
			// Scheduler tick errors never crash process
		}
	}, intervalMs)

	if (anchoringSchedulerIntervalId && typeof anchoringSchedulerIntervalId.unref === 'function') {
		anchoringSchedulerIntervalId.unref()
	}

	return true
}

/**
 * Stops the external WORM anchoring scheduler.
 */
function stopAnchoringScheduler() {
	if (anchoringSchedulerIntervalId) {
		clearInterval(anchoringSchedulerIntervalId)
		anchoringSchedulerIntervalId = null
	}
	isAnchoringTickRunning = false
	activeAnchoringTickPromise = null
}

module.exports = {
	parseCheckpointSchedulerConfig,
	runScheduledCheckpointTick,
	startCheckpointScheduler,
	stopCheckpointScheduler,
	getSchedulerStatus,
	runScheduledAnchoringTick,
	startAnchoringScheduler,
	stopAnchoringScheduler,
}
