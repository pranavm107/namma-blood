/**
 * Medical Officer Emergency Request Review Page
 * Namma Blood — Phase 4.3.5 Hospital-Based Medical Officer Verification System
 *
 * Provides complete structured clinical review for an assigned emergency request:
 * - Patient Demographics & Blood Specifications
 * - Authoritative Hospital Facility Identity
 * - Attending Physician & Clinical Justification
 * - Actions: Approve (remarks required), Reject (reason required), Request More Information
 * - Concurrency Conflict (HTTP 409) Detection & Manual Refresh
 * - Quarantined Flagged_Suspicious Protection
 * - Chronological Verification Audit History Timeline
 */

import React, { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useDispatch, useSelector } from 'react-redux'
import {
	Box,
	Button,
	Chip,
	Container,
	Divider,
	Grid,
	Paper,
	TextField,
	Typography,
	Alert,
	AlertTitle,
	CircularProgress,
	Dialog,
	DialogTitle,
	DialogContent,
	DialogContentText,
	DialogActions,
} from '@mui/material'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import CancelIcon from '@mui/icons-material/Cancel'
import HelpOutlineIcon from '@mui/icons-material/HelpOutline'
import RefreshIcon from '@mui/icons-material/Refresh'
import LocalHospitalIcon from '@mui/icons-material/LocalHospital'
import PersonIcon from '@mui/icons-material/Person'
import HistoryIcon from '@mui/icons-material/History'
import ShieldIcon from '@mui/icons-material/Shield'
import { toast } from 'react-toastify'
import {
	fetchRequestDetails,
	fetchVerificationHistory,
	approveEmergencyRequest,
	rejectEmergencyRequest,
	requestAdditionalInformation,
	clearConcurrencyConflict,
	resetActiveRequest,
} from '../../store/medicalOfficerSlice'
import VerificationHistoryTimeline from './VerificationHistoryTimeline'

const STATUS_CONFIG = {
	Pending_Verification: {
		label: 'PENDING VERIFICATION',
		color: 'warning',
		bg: '#fef3c7',
		text: '#92400e',
	},
	Verified: {
		label: 'VERIFIED',
		color: 'success',
		bg: '#dcfce7',
		text: '#15803d',
	},
	Rejected: {
		label: 'REJECTED',
		color: 'error',
		bg: '#fee2e2',
		text: '#991b1b',
	},
	More_Information_Required: {
		label: 'MORE INFORMATION REQUIRED',
		color: 'info',
		bg: '#e0f2fe',
		text: '#0369a1',
	},
	Flagged_Suspicious: {
		label: 'FLAGGED SUSPICIOUS (QUARANTINED)',
		color: 'error',
		bg: '#fef2f2',
		text: '#7f1d1d',
	},
}

const EmergencyRequestReviewPage = () => {
	const { id } = useParams()
	const navigate = useNavigate()
	const dispatch = useDispatch()

	const { activeRequest } = useSelector((state) => state?.medicalOfficer || {})
	const {
		data: request,
		verificationHistory,
		isLoading,
		historyLoading,
		actionLoading,
		error,
		concurrencyConflict,
	} = activeRequest

	// Dialog States
	const [approveDialogOpen, setApproveDialogOpen] = useState(false)
	const [approvalRemarks, setApprovalRemarks] = useState('')
	const [approvalError, setApprovalError] = useState('')

	const [rejectDialogOpen, setRejectDialogOpen] = useState(false)
	const [rejectionReason, setRejectionReason] = useState('')
	const [rejectionRemarks, setRejectionRemarks] = useState('')
	const [rejectionError, setRejectionError] = useState('')

	const [infoDialogOpen, setInfoDialogOpen] = useState(false)
	const [requiredInfo, setRequiredInfo] = useState('')
	const [infoRemarks, setInfoRemarks] = useState('')
	const [infoError, setInfoError] = useState('')

	const reloadRequestData = () => {
		if (id) {
			dispatch(clearConcurrencyConflict())
			dispatch(fetchRequestDetails(id))
			dispatch(fetchVerificationHistory(id))
		}
	}

	useEffect(() => {
		if (id) {
			dispatch(fetchRequestDetails(id))
			dispatch(fetchVerificationHistory(id))
		}
		return () => {
			dispatch(resetActiveRequest())
		}
	}, [id, dispatch])

	// Handlers for Verification Decisions
	const handleApproveConfirm = async () => {
		if (!approvalRemarks.trim() || approvalRemarks.trim().length < 2) {
			setApprovalError('Mandatory clinical remarks are required (minimum 2 characters).')
			return
		}
		setApprovalError('')

		const resultAction = await dispatch(
			approveEmergencyRequest({
				requestId: request._id,
				remarks: approvalRemarks.trim(),
				verificationVersion: request.verificationVersion,
			})
		)

		if (approveEmergencyRequest.fulfilled.match(resultAction)) {
			setApproveDialogOpen(false)
			setApprovalRemarks('')
			toast.success('Emergency blood request approved and clinically verified.')
			reloadRequestData()
		} else {
			toast.error(resultAction.payload?.message || 'Failed to approve request.')
		}
	}

	const handleRejectConfirm = async () => {
		if (!rejectionReason.trim() || rejectionReason.trim().length < 5) {
			setRejectionError('Mandatory rejection reason is required (minimum 5 characters).')
			return
		}
		setRejectionError('')

		const resultAction = await dispatch(
			rejectEmergencyRequest({
				requestId: request._id,
				rejectionReason: rejectionReason.trim(),
				remarks: rejectionRemarks.trim() || undefined,
				verificationVersion: request.verificationVersion,
			})
		)

		if (rejectEmergencyRequest.fulfilled.match(resultAction)) {
			setRejectDialogOpen(false)
			setRejectionReason('')
			setRejectionRemarks('')
			toast.success('Emergency blood request rejected.')
			reloadRequestData()
		} else {
			toast.error(resultAction.payload?.message || 'Failed to reject request.')
		}
	}

	const handleInfoConfirm = async () => {
		if (!requiredInfo.trim() || requiredInfo.trim().length < 5) {
			setInfoError('Please specify the required information in detail (minimum 5 characters).')
			return
		}
		setInfoError('')

		const resultAction = await dispatch(
			requestAdditionalInformation({
				requestId: request._id,
				requiredInformation: requiredInfo.trim(),
				remarks: infoRemarks.trim() || undefined,
				verificationVersion: request.verificationVersion,
			})
		)

		if (requestAdditionalInformation.fulfilled.match(resultAction)) {
			setInfoDialogOpen(false)
			setRequiredInfo('')
			setInfoRemarks('')
			toast.info('Clarification request dispatched to the original requester.')
			reloadRequestData()
		} else {
			toast.error(resultAction.payload?.message || 'Failed to request additional information.')
		}
	}

	if (isLoading) {
		return (
			<Container maxWidth='lg' sx={{ py: 6, display: 'flex', justifyContent: 'center' }}>
				<CircularProgress size={44} color='primary' />
			</Container>
		)
	}

	if (error || !request) {
		return (
			<Container maxWidth='lg' sx={{ py: 4 }}>
				<Button
					startIcon={<ArrowBackIcon />}
					onClick={() => navigate('/medical-officer/pending')}
					sx={{ mb: 2, textTransform: 'none', fontWeight: 700 }}
				>
					Back to Queue
				</Button>
				<Alert severity='error' sx={{ borderRadius: 2 }}>
					{error || 'Emergency blood request not found or access denied.'}
				</Alert>
			</Container>
		)
	}

	const isFlaggedSuspicious = request.verificationStatus === 'Flagged_Suspicious'
	const isActionable =
		(request.verificationStatus === 'Pending_Verification' ||
			request.verificationStatus === 'More_Information_Required') &&
		!isFlaggedSuspicious

	const statusInfo = STATUS_CONFIG[request.verificationStatus] || {
		label: request.verificationStatus,
		bg: '#f1f5f9',
		text: '#334155',
	}

	return (
		<Container maxWidth='lg' sx={{ py: 3 }}>
			{/* Top Navigation */}
			<Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
				<Button
					startIcon={<ArrowBackIcon />}
					onClick={() => navigate('/medical-officer/pending')}
					sx={{ color: '#64748b', textTransform: 'none', fontWeight: 700 }}
				>
					Back to Review Queue
				</Button>
				<Button
					variant='outlined'
					size='small'
					startIcon={<RefreshIcon />}
					onClick={reloadRequestData}
					sx={{ textTransform: 'none', fontWeight: 700, borderRadius: 2 }}
				>
					Refresh Data
				</Button>
			</Box>

			{/* Concurrency Conflict Alert (HTTP 409) */}
			{concurrencyConflict && (
				<Alert
					severity='warning'
					sx={{ mb: 3, borderRadius: 2.5, border: '1px solid #fde68a' }}
					action={
						<Button
							color='inherit'
							size='small'
							startIcon={<RefreshIcon />}
							onClick={reloadRequestData}
							sx={{ fontWeight: 800 }}
						>
							Refresh Now
						</Button>
					}
				>
					<AlertTitle sx={{ fontWeight: 800 }}>Concurrency Notice (HTTP 409)</AlertTitle>
					This emergency blood request was updated by another user or session. You must refresh the request to view the latest state before submitting a verification decision.
				</Alert>
			)}

			{/* Quarantined Ticket Warning */}
			{isFlaggedSuspicious && (
				<Alert
					severity='error'
					icon={<ShieldIcon />}
					sx={{ mb: 3, borderRadius: 2.5, border: '1px solid #fecaca', bgcolor: '#fef2f2' }}
				>
					<AlertTitle sx={{ fontWeight: 800 }}>Quarantined Ticket Notice</AlertTitle>
					This emergency blood request has been <strong>Flagged Suspicious</strong> and placed into clinical quarantine. In accordance with system security rules, standard Medical Officer actions cannot clear or approve this request.
				</Alert>
			)}

			{/* Header Card */}
			<Paper elevation={0} sx={{ p: 3.5, mb: 3, borderRadius: 3, border: '1px solid #e2e8f0' }}>
				<Grid container spacing={3} alignItems='center'>
					<Grid item xs={12} md={7}>
						<Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1 }}>
							<Typography variant='h5' sx={{ fontWeight: 900, color: '#0f172a', fontFamily: 'monospace' }}>
								{request.requestNumber || request._id}
							</Typography>
							<Chip
								label={statusInfo.label}
								size='small'
								sx={{
									fontWeight: 800,
									fontSize: '0.75rem',
									bgcolor: statusInfo.bg,
									color: statusInfo.text,
								}}
							/>
						</Box>
						<Typography variant='body2' sx={{ color: '#64748b' }}>
							Created on{' '}
							{new Date(request.createdAt).toLocaleString('en-IN', {
								dateStyle: 'medium',
								timeStyle: 'short',
							})}{' '}
							• Version: <strong>v{request.verificationVersion || 1}</strong>
						</Typography>
					</Grid>
					<Grid item xs={12} md={5}>
						<Box sx={{ display: 'flex', gap: 1.5, justifyContent: { xs: 'flex-start', md: 'flex-end' }, flexWrap: 'wrap' }}>
							<Chip
								label={`${request.urgencyLevel?.replace('_', ' ')} Urgency`}
								color={request.urgencyLevel === 'Critical' ? 'error' : 'warning'}
								sx={{ fontWeight: 800 }}
							/>
							<Chip
								label={`Window: ${request.requiredWithinHours || 4}h`}
								variant='outlined'
								sx={{ fontWeight: 700 }}
							/>
						</Box>
					</Grid>
				</Grid>
			</Paper>

			<Grid container spacing={3}>
				{/* Left Column: Request Details & Verification Actions */}
				<Grid item xs={12} md={8}>
					{/* Section 1: Clinical Demographics & Blood Requirements */}
					<Paper elevation={0} sx={{ p: 3, mb: 3, borderRadius: 3, border: '1px solid #e2e8f0' }}>
						<Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
							<PersonIcon sx={{ color: '#c62828' }} />
							<Typography variant='h6' sx={{ fontWeight: 800, color: '#0f172a' }}>
								Patient & Blood Specifications
							</Typography>
						</Box>
						<Grid container spacing={2}>
							<Grid item xs={6} sm={3}>
								<Typography variant='caption' sx={{ color: '#64748b', fontWeight: 600 }}>
									PATIENT NAME
								</Typography>
								<Typography variant='body1' sx={{ fontWeight: 700, color: '#1e293b' }}>
									{request.patientName}
								</Typography>
							</Grid>
							<Grid item xs={6} sm={3}>
								<Typography variant='caption' sx={{ color: '#64748b', fontWeight: 600 }}>
									AGE & GENDER
								</Typography>
								<Typography variant='body1' sx={{ fontWeight: 700, color: '#1e293b' }}>
									{request.patientAge} yrs • {request.patientGender}
								</Typography>
							</Grid>
							<Grid item xs={6} sm={3}>
								<Typography variant='caption' sx={{ color: '#64748b', fontWeight: 600 }}>
									BLOOD GROUP
								</Typography>
								<Box sx={{ mt: 0.5 }}>
									<Chip
										label={request.requiredBloodGroup?.replace('_', ' ')}
										color='error'
										size='small'
										sx={{ fontWeight: 800 }}
									/>
								</Box>
							</Grid>
							<Grid item xs={6} sm={3}>
								<Typography variant='caption' sx={{ color: '#64748b', fontWeight: 600 }}>
									UNITS REQUESTED
								</Typography>
								<Typography variant='h6' sx={{ fontWeight: 900, color: '#c62828' }}>
									{request.unitsRequested} Unit(s)
								</Typography>
							</Grid>
							<Grid item xs={12} sm={6}>
								<Typography variant='caption' sx={{ color: '#64748b', fontWeight: 600 }}>
									COMPONENT TYPE
								</Typography>
								<Typography variant='body1' sx={{ fontWeight: 600, color: '#1e293b' }}>
									{request.requiredComponent?.replace(/_/g, ' ')}
								</Typography>
							</Grid>
							<Grid item xs={12} sm={6}>
								<Typography variant='caption' sx={{ color: '#64748b', fontWeight: 600 }}>
									EXPIRES AT
								</Typography>
								<Typography variant='body2' sx={{ fontWeight: 600, color: '#d97706' }}>
									{request.expiresAt
										? new Date(request.expiresAt).toLocaleString('en-IN', {
												dateStyle: 'medium',
												timeStyle: 'short',
										  })
										: '—'}
								</Typography>
							</Grid>
						</Grid>
					</Paper>

					{/* Section 2: Hospital Facility & Medical Oversight */}
					<Paper elevation={0} sx={{ p: 3, mb: 3, borderRadius: 3, border: '1px solid #e2e8f0' }}>
						<Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
							<LocalHospitalIcon sx={{ color: '#059669' }} />
							<Typography variant='h6' sx={{ fontWeight: 800, color: '#0f172a' }}>
								Hospital Facility & Attending Physician
							</Typography>
						</Box>
						<Grid container spacing={2}>
							<Grid item xs={12} sm={6}>
								<Typography variant='caption' sx={{ color: '#64748b', fontWeight: 600 }}>
									HOSPITAL NAME
								</Typography>
								<Typography variant='body1' sx={{ fontWeight: 700, color: '#1e293b' }}>
									{request.hospitalId?.hospitalName || request.hospitalName}
								</Typography>
								<Typography variant='caption' sx={{ color: '#64748b' }}>
									Code: {request.hospitalId?.hospitalCode || '—'}
								</Typography>
							</Grid>
							<Grid item xs={12} sm={6}>
								<Typography variant='caption' sx={{ color: '#64748b', fontWeight: 600 }}>
									FACILITY ADDRESS
								</Typography>
								<Typography variant='body2' sx={{ color: '#1e293b' }}>
									{request.hospitalAddress}, {request.hospitalCity}, {request.hospitalState} —{' '}
									{request.hospitalPinCode}
								</Typography>
							</Grid>
							<Grid item xs={6} sm={4}>
								<Typography variant='caption' sx={{ color: '#64748b', fontWeight: 600 }}>
									ATTENDING DOCTOR
								</Typography>
								<Typography variant='body2' sx={{ fontWeight: 700, color: '#1e293b' }}>
									{request.attendingDoctor?.doctorName || '—'}
								</Typography>
							</Grid>
							<Grid item xs={6} sm={4}>
								<Typography variant='caption' sx={{ color: '#64748b', fontWeight: 600 }}>
									DOCTOR PHONE
								</Typography>
								<Typography variant='body2' sx={{ fontWeight: 600, color: '#1e293b' }}>
									{request.attendingDoctor?.doctorPhone || '—'}
								</Typography>
							</Grid>
							<Grid item xs={12} sm={4}>
								<Typography variant='caption' sx={{ color: '#64748b', fontWeight: 600 }}>
									HOSPITAL WARD / BED
								</Typography>
								<Typography variant='body2' sx={{ color: '#1e293b' }}>
									{request.hospitalWardBed || 'Not specified'}
								</Typography>
							</Grid>
							<Grid item xs={12}>
								<Divider sx={{ my: 1.5 }} />
								<Typography variant='caption' sx={{ color: '#64748b', fontWeight: 600 }}>
									CLINICAL JUSTIFICATION
								</Typography>
								<Paper
									elevation={0}
									sx={{
										p: 2,
										mt: 0.5,
										borderRadius: 2,
										bgcolor: '#f8fafc',
										border: '1px solid #e2e8f0',
									}}
								>
									<Typography variant='body2' sx={{ color: '#0f172a', lineHeight: 1.6 }}>
										{request.clinicalJustification || 'No clinical text provided.'}
									</Typography>
								</Paper>
							</Grid>
						</Grid>
					</Paper>

					{/* Section 3: Verification Decision Actions */}
					{isActionable && (
						<Paper
							elevation={0}
							sx={{
								p: 3.5,
								mb: 3,
								borderRadius: 3,
								border: '1px solid #cbd5e1',
								background: 'linear-gradient(135deg, #ffffff 0%, #f8fafc 100%)',
							}}
						>
							<Typography variant='h6' sx={{ fontWeight: 800, color: '#0f172a', mb: 1 }}>
								Medical Officer Verification Decision
							</Typography>
							<Typography variant='body2' sx={{ color: '#64748b', mb: 3 }}>
								As an authorized Medical Officer for this facility, please review the clinical information and submit your decision.
							</Typography>

							<Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
								<Button
									variant='contained'
									color='success'
									size='large'
									startIcon={actionLoading ? <CircularProgress size={20} color='inherit' /> : <CheckCircleIcon />}
									onClick={() => setApproveDialogOpen(true)}
									disabled={actionLoading}
									sx={{ fontWeight: 800, textTransform: 'none', px: 3, borderRadius: 2 }}
								>
									Approve Request
								</Button>

								<Button
									variant='outlined'
									color='warning'
									size='large'
									startIcon={<HelpOutlineIcon />}
									onClick={() => setInfoDialogOpen(true)}
									disabled={actionLoading}
									sx={{ fontWeight: 800, textTransform: 'none', px: 3, borderRadius: 2 }}
								>
									Request Additional Info
								</Button>

								<Button
									variant='outlined'
									color='error'
									size='large'
									startIcon={<CancelIcon />}
									onClick={() => setRejectDialogOpen(true)}
									disabled={actionLoading}
									sx={{ fontWeight: 800, textTransform: 'none', px: 3, borderRadius: 2 }}
								>
									Reject Request
								</Button>
							</Box>
						</Paper>
					)}
				</Grid>

				{/* Right Column: Verification Audit History Timeline */}
				<Grid item xs={12} md={4}>
					<Paper elevation={0} sx={{ p: 3, borderRadius: 3, border: '1px solid #e2e8f0', minHeight: 400 }}>
						<Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2.5 }}>
							<HistoryIcon sx={{ color: '#0284c7' }} />
							<Typography variant='h6' sx={{ fontWeight: 800, color: '#0f172a' }}>
								Audit Trail
							</Typography>
						</Box>

						<VerificationHistoryTimeline
							history={verificationHistory}
							isLoading={historyLoading}
						/>
					</Paper>
				</Grid>
			</Grid>

			{/* ========================================================================= */}
			{/* DIALOG 1: APPROVAL DIALOG (MANDATORY REMARKS)                            */}
			{/* ========================================================================= */}
			<Dialog
				open={approveDialogOpen}
				onClose={() => setApproveDialogOpen(false)}
				maxWidth='sm'
				fullWidth
			>
				<DialogTitle sx={{ fontWeight: 800, color: '#166534' }}>
					Approve Emergency Blood Request
				</DialogTitle>
				<DialogContent>
					<DialogContentText sx={{ mb: 2, color: '#475569' }}>
						By approving, you confirm that you have verified the patient&rsquo;s clinical condition,
						transfusion requirement, and attending physician details.
					</DialogContentText>
					<TextField
						autoFocus
						multiline
						rows={3}
						fullWidth
						label='Mandatory Clinical Remarks *'
						placeholder='e.g., Verified acute post-operative hemorrhage, crossmatch sample in lab.'
						value={approvalRemarks}
						onChange={(e) => setApprovalRemarks(e.target.value)}
						error={Boolean(approvalError)}
						helperText={approvalError || 'Minimum 2 characters required.'}
						sx={{ mt: 1 }}
					/>
				</DialogContent>
				<DialogActions sx={{ p: 2.5 }}>
					<Button onClick={() => setApproveDialogOpen(false)} sx={{ fontWeight: 700 }}>
						Cancel
					</Button>
					<Button
						variant='contained'
						color='success'
						onClick={handleApproveConfirm}
						disabled={actionLoading}
						sx={{ fontWeight: 800, px: 3 }}
					>
						Confirm Approval
					</Button>
				</DialogActions>
			</Dialog>

			{/* ========================================================================= */}
			{/* DIALOG 2: REJECTION DIALOG (MANDATORY REJECTION REASON)                   */}
			{/* ========================================================================= */}
			<Dialog
				open={rejectDialogOpen}
				onClose={() => setRejectDialogOpen(false)}
				maxWidth='sm'
				fullWidth
			>
				<DialogTitle sx={{ fontWeight: 800, color: '#991b1b' }}>
					Reject Emergency Blood Request
				</DialogTitle>
				<DialogContent>
					<DialogContentText sx={{ mb: 2, color: '#475569' }}>
						Please provide the mandatory clinical reason for rejecting this emergency request.
						This explanation will be permanently recorded in the audit trail.
					</DialogContentText>
					<TextField
						autoFocus
						fullWidth
						label='Mandatory Rejection Reason *'
						placeholder='e.g., Unverified patient identity; non-emergent elective case.'
						value={rejectionReason}
						onChange={(e) => setRejectionReason(e.target.value)}
						error={Boolean(rejectionError)}
						helperText={rejectionError || 'Minimum 5 characters required.'}
						sx={{ mt: 1, mb: 2 }}
					/>
					<TextField
						multiline
						rows={2}
						fullWidth
						label='Additional Remarks (Optional)'
						placeholder='Optional additional context for clinical record'
						value={rejectionRemarks}
						onChange={(e) => setRejectionRemarks(e.target.value)}
					/>
				</DialogContent>
				<DialogActions sx={{ p: 2.5 }}>
					<Button onClick={() => setRejectDialogOpen(false)} sx={{ fontWeight: 700 }}>
						Cancel
					</Button>
					<Button
						variant='contained'
						color='error'
						onClick={handleRejectConfirm}
						disabled={actionLoading}
						sx={{ fontWeight: 800, px: 3 }}
					>
						Confirm Rejection
					</Button>
				</DialogActions>
			</Dialog>

			{/* ========================================================================= */}
			{/* DIALOG 3: REQUEST ADDITIONAL INFORMATION DIALOG                          */}
			{/* ========================================================================= */}
			<Dialog
				open={infoDialogOpen}
				onClose={() => setInfoDialogOpen(false)}
				maxWidth='sm'
				fullWidth
			>
				<DialogTitle sx={{ fontWeight: 800, color: '#0369a1' }}>
					Request Additional Clinical Information
				</DialogTitle>
				<DialogContent>
					<DialogContentText sx={{ mb: 2, color: '#475569' }}>
						Specify the exact clinical documents or clarification required from the original requester.
						The ticket will transition to <strong>More_Information_Required</strong> until resubmitted.
					</DialogContentText>
					<TextField
						autoFocus
						multiline
						rows={3}
						fullWidth
						label='Information Required from Requester *'
						placeholder='e.g., Please provide attending doctor prescription and current Hb level.'
						value={requiredInfo}
						onChange={(e) => setRequiredInfo(e.target.value)}
						error={Boolean(infoError)}
						helperText={infoError || 'Minimum 5 characters required.'}
						sx={{ mt: 1, mb: 2 }}
					/>
					<TextField
						fullWidth
						label='Internal Clinical Remarks (Optional)'
						placeholder='Optional internal notes'
						value={infoRemarks}
						onChange={(e) => setInfoRemarks(e.target.value)}
					/>
				</DialogContent>
				<DialogActions sx={{ p: 2.5 }}>
					<Button onClick={() => setInfoDialogOpen(false)} sx={{ fontWeight: 700 }}>
						Cancel
					</Button>
					<Button
						variant='contained'
						color='primary'
						onClick={handleInfoConfirm}
						disabled={actionLoading}
						sx={{ fontWeight: 800, px: 3 }}
					>
						Send Clarification Request
					</Button>
				</DialogActions>
			</Dialog>
		</Container>
	)
}

export default EmergencyRequestReviewPage
