const mongoose = require('mongoose')
require('dotenv').config()
const app = require('./app')
const AppError = require('./Utils/appError')
const {
	parseWorkerConfig,
	startReservationExpiryWorker,
	stopReservationExpiryWorker,
} = require('./BloodUnit/reservationExpiryWorker')

const workerConfig = parseWorkerConfig(process.env)

const connection = async () => {
	try {
		await mongoose.connect(process.env.database_url)
		console.log('Successfully connected your application with database!!')

		// Explicit Opt-In: Start reservation expiry background worker only when configured
		if (workerConfig.enabled) {
			startReservationExpiryWorker({
				intervalMs: workerConfig.intervalMs,
				batchSize: workerConfig.batchSize,
				runOnBoot: workerConfig.runOnBoot,
				logger: console,
			})
		}
	} catch (err) {
		console.error('Database connection failed:', err.message)
	}
}
connection()

const PORT = process.env.PORT || 5050
const HOST = process.env.HOST || '0.0.0.0'
const server = app.listen(PORT, HOST, () => {
	console.log(`Server is running on http://${HOST}:${PORT}`)
})

// Graceful Termination & Resource Drain Lifecycles
let isShuttingDown = false
async function handleShutdown(signal) {
	if (isShuttingDown) return
	isShuttingDown = true
	console.log(`\n[Server] Received ${signal}. Starting graceful shutdown...`)

	// 1. Await background worker in-flight sweep drain
	if (workerConfig.enabled) {
		try {
			await stopReservationExpiryWorker({ drain: true, timeoutMs: 10000 })
			console.log('[Server] Reservation expiry worker stopped and drained.')
		} catch (err) {
			console.error('[Server] Error stopping reservation expiry worker:', err.message)
		}
	}

	// 2. Close HTTP listener to stop receiving new inbound connections
	server.close(async () => {
		console.log('[Server] HTTP server closed.')

		// 3. Close database connection cleanly
		try {
			if (mongoose.connection && mongoose.connection.readyState !== 0) {
				await mongoose.connection.close(false)
				console.log('[Server] MongoDB connection closed.')
			}
		} catch (err) {
			console.error('[Server] Error closing MongoDB connection:', err.message)
		}
		process.exit(0)
	})

	// Fallback exit timer if open sockets or long-lived connections prevent server.close
	setTimeout(() => {
		console.error('[Server] Graceful shutdown timed out after 15s. Forcing exit.')
		process.exit(1)
	}, 15000).unref()
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'))
process.on('SIGINT', () => handleShutdown('SIGINT'))
