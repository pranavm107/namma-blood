/**
 * Chronological Verification Audit History Timeline
 * Namma Blood — Phase 4.3.5 Hospital-Based Medical Officer Verification System
 *
 * Visualizes append-only audit trail records with actor identity, action type,
 * status transitions, and clinical justification/remarks.
 */

import React from 'react'
import {
	Box,
	Chip,
	Paper,
	Typography,
	Divider,
	CircularProgress,
} from '@mui/material'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import CancelIcon from '@mui/icons-material/Cancel'
import HelpOutlineIcon from '@mui/icons-material/HelpOutline'
import ReplyIcon from '@mui/icons-material/Reply'
import AccessTimeIcon from '@mui/icons-material/AccessTime'
import PersonIcon from '@mui/icons-material/Person'
import LocalHospitalIcon from '@mui/icons-material/LocalHospital'

const ACTION_CONFIG = {
	APPROVED: {
		label: 'APPROVED',
		color: 'success',
		icon: <CheckCircleIcon fontSize='small' />,
		bg: '#f0fdf4',
		border: '#bbf7d0',
		text: '#166534',
	},
	REJECTED: {
		label: 'REJECTED',
		color: 'error',
		icon: <CancelIcon fontSize='small' />,
		bg: '#fef2f2',
		border: '#fecaca',
		text: '#991b1b',
	},
	MORE_INFORMATION_REQUESTED: {
		label: 'INFO REQUESTED',
		color: 'warning',
		icon: <HelpOutlineIcon fontSize='small' />,
		bg: '#fffbeb',
		border: '#fde68a',
		text: '#92400e',
	},
	RESUBMITTED: {
		label: 'INFO RESUBMITTED',
		color: 'info',
		icon: <ReplyIcon fontSize='small' />,
		bg: '#f0f9ff',
		border: '#bae6fd',
		text: '#075985',
	},
}

const VerificationHistoryTimeline = ({ history = [], isLoading = false }) => {
	if (isLoading) {
		return (
			<Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
				<CircularProgress size={32} />
			</Box>
		)
	}

	if (!history || history.length === 0) {
		return (
			<Paper
				elevation={0}
				sx={{
					p: 3,
					borderRadius: 2,
					border: '1px dashed #cbd5e1',
					bgcolor: '#f8fafc',
					textAlign: 'center',
				}}
			>
				<Typography variant='body2' sx={{ color: '#64748b' }}>
					No verification actions recorded yet. Request is currently awaiting initial clinical review.
				</Typography>
			</Paper>
		)
	}

	return (
		<Box sx={{ position: 'relative', pl: 2 }}>
			{history.map((record, index) => {
				const config = ACTION_CONFIG[record.action] || {
					label: record.action,
					bg: '#f8fafc',
					border: '#e2e8f0',
					text: '#334155',
					icon: <AccessTimeIcon fontSize='small' />,
				}

				const actorName = record.actorUserId
					? `${record.actorUserId.firstName || ''} ${record.actorUserId.lastName || ''}`.trim() ||
					  record.actorUserId.email ||
					  'Authorized Actor'
					: record.actorRole || 'System Actor'

				const formattedDate = record.createdAt
					? new Date(record.createdAt).toLocaleString('en-IN', {
							dateStyle: 'medium',
							timeStyle: 'short',
					  })
					: 'Timestamp unavailable'

				return (
					<Box
						key={record._id || index}
						sx={{
							position: 'relative',
							pb: index !== history.length - 1 ? 3 : 0,
							'&::before': {
								content: '""',
								position: 'absolute',
								left: -12,
								top: 8,
								bottom: index !== history.length - 1 ? -12 : 8,
								width: '2px',
								backgroundColor: '#e2e8f0',
								display: index === history.length - 1 ? 'none' : 'block',
							},
						}}
					>
						<Paper
							elevation={0}
							sx={{
								p: 2.5,
								borderRadius: 2.5,
								border: `1px solid ${config.border}`,
								bgcolor: config.bg,
							}}
						>
							{/* Header: Action badge & Timestamp */}
							<Box
								sx={{
									display: 'flex',
									justifyContent: 'space-between',
									alignItems: 'center',
									flexWrap: 'wrap',
									gap: 1,
									mb: 1.5,
								}}
							>
								<Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
									<Chip
										icon={config.icon}
										label={config.label}
										size='small'
										sx={{
											fontWeight: 800,
											fontSize: '0.75rem',
											letterSpacing: '0.04em',
											bgcolor: '#ffffff',
											border: `1px solid ${config.border}`,
											color: config.text,
										}}
									/>
									<Typography variant='caption' sx={{ fontWeight: 700, color: '#64748b' }}>
										{record.previousStatus} &rarr; {record.newStatus}
									</Typography>
								</Box>
								<Typography variant='caption' sx={{ color: '#64748b', fontWeight: 600 }}>
									{formattedDate}
								</Typography>
							</Box>

							{/* Actor Attribution */}
							<Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
								<PersonIcon sx={{ fontSize: 16, color: '#64748b' }} />
								<Typography variant='body2' sx={{ fontWeight: 700, color: '#1e293b' }}>
									{actorName}
								</Typography>
								<Chip
									label={record.actorRole}
									size='small'
									sx={{
										fontSize: '0.65rem',
										height: 20,
										fontWeight: 800,
										bgcolor: '#e2e8f0',
										color: '#334155',
									}}
								/>
								{record.actorUserId?.medicalRegistrationNumber && (
									<Typography variant='caption' sx={{ color: '#0369a1', fontWeight: 600 }}>
										Reg: {record.actorUserId.medicalRegistrationNumber}
									</Typography>
								)}
							</Box>

							{/* Hospital Scoping */}
							{record.hospitalId && (
								<Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 1.5 }}>
									<LocalHospitalIcon sx={{ fontSize: 15, color: '#64748b' }} />
									<Typography variant='caption' sx={{ color: '#475569', fontWeight: 600 }}>
										{record.hospitalId.hospitalName} ({record.hospitalId.hospitalCode})
									</Typography>
								</Box>
							)}

							<Divider sx={{ my: 1, borderColor: config.border }} />

							{/* Remarks or Clinical Reasons */}
							{record.remarks && (
								<Typography variant='body2' sx={{ color: '#1e293b', fontStyle: 'italic', mt: 1 }}>
									&ldquo;{record.remarks}&rdquo;
								</Typography>
							)}
						</Paper>
					</Box>
				)
			})}
		</Box>
	)
}

export default VerificationHistoryTimeline

