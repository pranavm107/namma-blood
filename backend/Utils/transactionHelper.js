const mongoose = require('mongoose')

/**
 * Checks whether the active Mongoose connection supports multi-document transactions.
 * Multi-document transactions require a MongoDB Replica Set or Sharded Cluster (mongos).
 * Standalone MongoDB instances ('Single') do not support multi-document transactions.
 */
function canUseTransactions() {
	if (!mongoose.connection || mongoose.connection.readyState !== 1) {
		return false
	}
	const client =
		typeof mongoose.connection.getClient === 'function'
			? mongoose.connection.getClient()
			: mongoose.connection.client
	const topology = client?.topology
	if (!topology) return false

	const topologyType = topology.description?.type
	return (
		topologyType === 'ReplicaSetWithPrimary' ||
		topologyType === 'ReplicaSetNoPrimary' ||
		topologyType === 'Sharded'
	)
}

/**
 * Executes a callback within a managed Mongoose transaction session if supported.
 *
 * FAIL-CLOSED IN PRODUCTION:
 * If running in production (process.env.NODE_ENV === 'production' or options.isProduction === true)
 * and multi-document transactions are unsupported (e.g. standalone MongoDB deployment or disconnected/unknown topology),
 * this function immediately rejects with a 500 error BEFORE executing workFn or performing any database mutation.
 * This guarantees production never runs un-isolated, non-atomic fulfillment operations.
 *
 * NON-PRODUCTION FALLBACK:
 * In development / test environments, a standalone fallback (session = null) is permitted for
 * local development compatibility.
 * IMPORTANT: Compensating rollbacks in standalone mode DO NOT provide ACID crash safety.
 * If the Node.js process dies or database network drops between operations, records can become inconsistent.
 *
 * @param {Function} workFn - Async function taking (session) => Promise<any>
 * @param {Object} [options] - Optional transaction configuration or mock injection
 * @returns {Promise<any>}
 */
async function withTransaction(workFn, options = {}) {
	// If a session is explicitly provided in options (e.g. from parent transaction or test mock)
	if (options.session) {
		return await workFn(options.session)
	}

	const transactionsSupported =
		options.forceTransaction === true ||
		canUseTransactions() ||
		(typeof mongoose.startSession === 'function' &&
			mongoose.startSession._isMock === true)

	if (transactionsSupported) {
		const session = await mongoose.startSession()
		try {
			let result
			if (typeof session.withTransaction === 'function') {
				await session.withTransaction(
					async () => {
						result = await workFn(session)
					},
					{
						readPreference: 'primary',
						readConcern: { level: 'local' },
						writeConcern: { w: 'majority' },
						...options.transactionOptions,
					}
				)
			} else {
				// Fallback for custom / mock sessions without withTransaction helper
				await session.startTransaction()
				try {
					result = await workFn(session)
					await session.commitTransaction()
				} catch (txnErr) {
					await session.abortTransaction()
					throw txnErr
				}
			}
			return result
		} finally {
			if (typeof session.endSession === 'function') {
				await session.endSession()
			}
		}
	}

	// Fail-closed in production: Reject before executing work callback or any database mutation
	const isProduction =
		options.isProduction !== undefined
			? options.isProduction
			: process.env.NODE_ENV === 'production'

	if (isProduction) {
		const err = new Error(
			'Multi-document transaction safety failure: Production deployment requires a MongoDB Replica Set or Sharded Cluster. Operations aborted before mutation.'
		)
		err.statusCode = 500
		throw err
	}

	// Non-production fallback (development / test without replica set)
	// WARNING: Compensating rollback is best-effort and does not provide ACID crash safety.
	return await workFn(null)
}

module.exports = {
	canUseTransactions,
	withTransaction,
}
