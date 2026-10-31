const mongoose = require('mongoose')

const VALID_RUN_TYPES = ['AUDIT_REPORT', 'MIGRATION_DRY_RUN', 'MIGRATION_EXECUTE']
const VALID_RUN_STATUSES = ['COMPLETED', 'FAILED', 'CONFLICT_DETECTED']

const inventoryReconciliationSchema = new mongoose.Schema(
	{
		bloodbankId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'bloodbank',
			required: [true, 'Owning blood bank ID is required.'],
			index: true,
		},
		batchId: {
			type: String,
			required: [true, 'Unique batch/run identifier is required.'],
			index: true,
		},
		runType: {
			type: String,
			enum: {
				values: VALID_RUN_TYPES,
				message: '{VALUE} is not a valid reconciliation run type.',
			},
			required: [true, 'Reconciliation run type is required.'],
			index: true,
		},
		status: {
			type: String,
			enum: {
				values: VALID_RUN_STATUSES,
				message: '{VALUE} is not a valid reconciliation status.',
			},
			required: [true, 'Reconciliation status is required.'],
			index: true,
		},
		actor: {
			actorId: {
				type: mongoose.Schema.Types.ObjectId,
				required: [true, 'Actor ID is required.'],
			},
			actorModel: {
				type: String,
				enum: ['bloodbank', 'bloodbankstaff', 'admin', 'system'],
				default: 'bloodbank',
			},
			staffId: {
				type: mongoose.Schema.Types.ObjectId,
				ref: 'bloodbankstaff',
				default: null,
			},
			ipAddress: {
				type: String,
				default: null,
			},
		},
		summary: {
			legacyTotal: { type: Number, default: 0 },
			traceableTotal: { type: Number, default: 0 },
			traceableVerifiedTotal: { type: Number, default: 0 },
			traceableQuarantinedTotal: { type: Number, default: 0 },
			traceableReservedTotal: { type: Number, default: 0 },
			traceableDiscardedTotal: { type: Number, default: 0 },
			traceableExpiredTotal: { type: Number, default: 0 },
			discrepancyCount: { type: Number, default: 0 },
			anomalyCount: { type: Number, default: 0 },
			nonReconcilableCount: { type: Number, default: 0 },
			migratedCount: { type: Number, default: 0 },
			skippedAlreadyMigratedCount: { type: Number, default: 0 },
		},
		perGroupDetails: [
			{
				bloodGroup: { type: String, required: true },
				legacyCount: { type: Number, default: 0 },
				traceableAvailable: { type: Number, default: 0 },
				traceableQuarantined: { type: Number, default: 0 },
				traceableReserved: { type: Number, default: 0 },
				traceableOther: { type: Number, default: 0 },
				delta: { type: Number, default: 0 },
			},
		],
		discrepancies: [
			{
				type: { type: String, required: true },
				bloodGroup: { type: String, default: null },
				unitNumber: { type: String, default: null },
				details: { type: String, required: true },
				severity: {
					type: String,
					enum: ['INFO', 'WARNING', 'ERROR', 'CRITICAL'],
					default: 'WARNING',
				},
			},
		],
		manifestResults: [
			{
				unitNumber: { type: String, required: true },
				bloodGroup: { type: String, required: true },
				status: {
					type: String,
					enum: ['MIGRATED', 'ALREADY_MIGRATED', 'FAILED', 'DRY_RUN_VALID'],
					required: true,
				},
				unitId: {
					type: mongoose.Schema.Types.ObjectId,
					ref: 'bloodunit',
					default: null,
				},
				error: { type: String, default: null },
			},
		],
		legacyStockBefore: {
			type: mongoose.Schema.Types.Mixed,
			default: {},
		},
		legacyStockAfter: {
			type: mongoose.Schema.Types.Mixed,
			default: {},
		},
		notes: {
			type: String,
			trim: true,
			default: '',
		},
		timestamp: {
			type: Date,
			default: Date.now,
			immutable: true,
			index: true,
		},
	},
	{
		timestamps: false,
		versionKey: false,
	}
)

// Immutable Ledger Guards: Prevent mutation or deletion of reconciliation records
function rejectMutation(next) {
	const err = new Error(
		'Security violation: InventoryReconciliationRecord entries are append-only audit artifacts and cannot be modified or deleted.'
	)
	if (typeof next === 'function') {
		return next(err)
	}
	throw err
}

inventoryReconciliationSchema.pre('updateOne', rejectMutation)
inventoryReconciliationSchema.pre('updateMany', rejectMutation)
inventoryReconciliationSchema.pre('findOneAndUpdate', rejectMutation)
inventoryReconciliationSchema.pre('replaceOne', rejectMutation)
inventoryReconciliationSchema.pre('findOneAndReplace', rejectMutation)
inventoryReconciliationSchema.pre('deleteOne', rejectMutation)
inventoryReconciliationSchema.pre('deleteMany', rejectMutation)
inventoryReconciliationSchema.pre('findOneAndDelete', rejectMutation)

const InventoryReconciliationRecord = mongoose.model(
	'inventoryreconciliation',
	inventoryReconciliationSchema
)

module.exports = {
	InventoryReconciliationRecord,
	VALID_RUN_TYPES,
	VALID_RUN_STATUSES,
}
