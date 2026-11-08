/**
 * Hospital Sequence Counter Model — Concurrency-Safe Code Generation
 * Namma Blood — Phase 4.3.5 Hospital-Based Medical Officer Verification System
 */

const mongoose = require('mongoose')

const hospitalSequenceSchema = new mongoose.Schema(
	{
		_id: {
			type: String, // Prefix identifier, e.g., "HOSP-CHE", "HOSP-COI", "HOSP-GEN"
			required: true,
		},
		seq: {
			type: Number,
			default: 0,
		},
	},
	{ timestamps: true }
)

const HospitalSequence = mongoose.model('HospitalSequence', hospitalSequenceSchema)

module.exports = { HospitalSequence }

