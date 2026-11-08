/**
 * Hospital Details & Verification — Admin Hospital Registry Management
 * Namma Blood — Phase 4.3.5 Hospital-Based Medical Officer Verification System
 */

import React, { useEffect, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { useNavigate, useParams } from 'react-router-dom'
import {
	Box,
	Button,
	Card,
	Chip,
	Container,
	Dialog,
	DialogActions,
	DialogContent,
	DialogContentText,
	DialogTitle,
	Divider,
	Grid,
	Paper,
	Table,
	TableBody,
	TableCell,
	TableContainer,
	TableHead,
	TableRow,
	Typography,
	Alert,
	AlertTitle,
	CircularProgress,
} from '@mui/material'
import LocalHospitalIcon from '@mui/icons-material/LocalHospital'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import CancelIcon from '@mui/icons-material/Cancel'
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty'
import VerifiedIcon from '@mui/icons-material/Verified'
import PersonAddAlt1Icon from '@mui/icons-material/PersonAddAlt1'
import ShieldIcon from '@mui/icons-material/Shield'
import { toast } from 'react-toastify'
import {
	fetchHospitalById,
	verifyHospital,
	fetchMoAssociations,
	resetCurrentHospital,
} from '../../store/adminHospitalSlice'

const HospitalDetails = () => {
	const { id } = useParams()
	const navigate = useNavigate()
	const dispatch = useDispatch()

	const { data: hospital, isLoading, error, verifyLoading } = useSelector(
		(state) => state.adminHospital?.currentHospital || {}
	)
	const { items: associations, isLoading: moLoading } = useSelector(
		(state) => state.adminHospital?.associations || {}
	)

	// Confirmation Dialog State
	const [confirmOpen, setConfirmOpen] = useState(false)
	const [actionType, setActionType] = useState(null) // 'VERIFY' | 'REJECT' | 'PENDING'

	useEffect(() => {
		if (id) {
			dispatch(fetchHospitalById(id))
			dispatch(fetchMoAssociations({ hospitalId: id }))
		}
		return () => {
			dispatch(resetCurrentHospital())
		}
	}, [dispatch, id])

	const handleOpenConfirm = (type) => {
		setActionType(type)
		setConfirmOpen(true)
	}

	const handleCloseConfirm = () => {
		setConfirmOpen(false)
		setActionType(null)
	}

	const handleExecuteVerification = async () => {
		let verificationStatus = 'Pending'
		let isActive = false

		if (actionType === 'VERIFY') {
			verificationStatus = 'Verified'
			isActive = true
		} else if (actionType === 'REJECT') {
			verificationStatus = 'Rejected'
			isActive = false
		} else if (actionType === 'PENDING') {
			verificationStatus = 'Pending'
			isActive = false
		}

		handleCloseConfirm()
		const result = await dispatch(
			verifyHospital({
				hospitalId: id,
				verificationStatus,
				isActive,
			})
		)

		if (verifyHospital.fulfilled.match(result)) {
			toast.success(result.payload?.message || `Hospital updated to '${verificationStatus}'.`)
			dispatch(fetchHospitalById(id))
		} else {
			toast.error(result.payload || 'Failed to update hospital status.')
		}
	}

	if (isLoading) {
		return (
			<Container maxWidth='lg' sx={{ py: 8, textAlign: 'center' }}>
				<CircularProgress size={40} sx={{ color: '#16a34a' }} />
				<Typography variant='body2' sx={{ mt: 2, color: '#64748b' }}>
					Loading hospital record...
				</Typography>
			</Container>
		)
	}

	if (error || !hospital) {
		return (
			<Container maxWidth='lg' sx={{ py: 6 }}>
				<Button
					startIcon={<ArrowBackIcon />}
					onClick={() => navigate('/admin/hospitals')}
					sx={{ mb: 2, textTransform: 'none' }}
				>
					Back to Directory
				</Button>
				<Alert severity='error' sx={{ borderRadius: 2 }}>
					<AlertTitle>Facility Record Error</AlertTitle>
					{error || 'Hospital record not found.'}
				</Alert>
			</Container>
		)
	}

	return (
		<Container maxWidth='lg' sx={{ pb: 8, pt: 2 }}>
			<Button
				startIcon={<ArrowBackIcon />}
				onClick={() => navigate('/admin/hospitals')}
				sx={{ mb: 2, textTransform: 'none', color: '#64748b', fontWeight: 600 }}
			>
				Back to Hospital Directory
			</Button>

			{/* Top Header Card */}
			<Paper
				elevation={0}
				sx={{
					p: 3,
					mb: 3,
					borderRadius: 3,
					background: 'linear-gradient(135deg, #ffffff 0%, #f0fdf4 100%)',
					border: '1px solid #bbf7d0',
					display: 'flex',
					flexDirection: { xs: 'column', md: 'row' },
					alignItems: { xs: 'flex-start', md: 'center' },
					justifyContent: 'space-between',
					gap: 2,
				}}
			>
				<Box>
					<Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 0.5 }}>
						<LocalHospitalIcon sx={{ color: '#16a34a', fontSize: 32 }} />
						<Typography variant='h5' sx={{ fontWeight: 800, color: '#1e293b' }}>
							{hospital.hospitalName}
						</Typography>
						<Chip
							label={hospital.hospitalCode}
							sx={{ fontFamily: 'monospace', fontWeight: 700, backgroundColor: '#dcfce7', color: '#166534' }}
						/>
					</Box>
					<Typography variant='body2' sx={{ color: '#64748b' }}>
						Facility Type: <strong>{hospital.hospitalType || 'Private'}</strong> • {hospital.address?.city}, {hospital.address?.state}
					</Typography>
				</Box>

				<Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
					{hospital.verificationStatus === 'Verified' ? (
						<Chip
							icon={<CheckCircleIcon />}
							label='Accredited & Verified'
							color='success'
							sx={{ fontWeight: 700, px: 1, py: 2 }}
						/>
					) : hospital.verificationStatus === 'Rejected' ? (
						<Chip
							icon={<CancelIcon />}
							label='Verification Rejected'
							color='error'
							sx={{ fontWeight: 700, px: 1, py: 2 }}
						/>
					) : (
						<Chip
							icon={<HourglassEmptyIcon />}
							label='Verification Pending'
							color='warning'
							sx={{ fontWeight: 700, px: 1, py: 2 }}
						/>
					)}

					<Chip
						label={hospital.isActive ? 'Active' : 'Inactive'}
						sx={{
							fontWeight: 700,
							backgroundColor: hospital.isActive ? '#dcfce7' : '#f1f5f9',
							color: hospital.isActive ? '#15803d' : '#64748b',
						}}
					/>
				</Box>
			</Paper>

			{/* Governance Disclaimer */}
			<Alert severity='info' icon={<ShieldIcon />} sx={{ mb: 3, borderRadius: 2 }}>
				<AlertTitle sx={{ fontWeight: 700 }}>Hospital Verification Governance Boundary</AlertTitle>
				Hospital verification activates facility credentials in the central hospital registry and authorizes affiliated Medical Officers to conduct clinical verification.
				Hospital verification is <strong>NOT clinical approval</strong>, <strong>NOT blood allocation</strong>, and <strong>NOT blood dispatch or issuance</strong>.
			</Alert>

			<Grid container spacing={3}>
				{/* Column 1: Hospital Details & Verification Action */}
				<Grid item xs={12} md={7}>
					<Card elevation={0} sx={{ p: 3, borderRadius: 3, border: '1px solid #e2e8f0', mb: 3 }}>
						<Typography variant='h6' sx={{ fontWeight: 700, color: '#1e293b', mb: 2 }}>
							Institutional Details
						</Typography>

						<Grid container spacing={2}>
							<Grid item xs={12} sm={6}>
								<Typography variant='caption' sx={{ color: '#64748b', fontWeight: 600 }}>
									Facility Name
								</Typography>
								<Typography variant='body1' sx={{ fontWeight: 600, color: '#1e293b' }}>
									{hospital.hospitalName}
								</Typography>
							</Grid>

							<Grid item xs={12} sm={6}>
								<Typography variant='caption' sx={{ color: '#64748b', fontWeight: 600 }}>
									Hospital Code
								</Typography>
								<Typography variant='body1' sx={{ fontFamily: 'monospace', fontWeight: 600, color: '#1e293b' }}>
									{hospital.hospitalCode}
								</Typography>
							</Grid>

							<Grid item xs={12} sm={6}>
								<Typography variant='caption' sx={{ color: '#64748b', fontWeight: 600 }}>
									Classification
								</Typography>
								<Typography variant='body1' sx={{ color: '#1e293b' }}>
									{hospital.hospitalType}
								</Typography>
							</Grid>

							<Grid item xs={12} sm={6}>
								<Typography variant='caption' sx={{ color: '#64748b', fontWeight: 600 }}>
									Postal PIN Code
								</Typography>
								<Typography variant='body1' sx={{ fontFamily: 'monospace', color: '#1e293b' }}>
									{hospital.address?.pinCode}
								</Typography>
							</Grid>

							<Grid item xs={12}>
								<Typography variant='caption' sx={{ color: '#64748b', fontWeight: 600 }}>
									Address
								</Typography>
								<Typography variant='body2' sx={{ color: '#1e293b' }}>
									{hospital.address?.street}, {hospital.address?.city}, {hospital.address?.state} — {hospital.address?.pinCode}
								</Typography>
							</Grid>

							<Grid item xs={12} sm={6}>
								<Typography variant='caption' sx={{ color: '#64748b', fontWeight: 600 }}>
									Contact Phone
								</Typography>
								<Typography variant='body1' sx={{ color: '#1e293b' }}>
									{hospital.contactPhone}
								</Typography>
							</Grid>

							<Grid item xs={12} sm={6}>
								<Typography variant='caption' sx={{ color: '#64748b', fontWeight: 600 }}>
									Contact Email
								</Typography>
								<Typography variant='body1' sx={{ color: '#1e293b' }}>
									{hospital.contactEmail}
								</Typography>
							</Grid>

							{hospital.location?.coordinates && (
								<Grid item xs={12}>
									<Typography variant='caption' sx={{ color: '#64748b', fontWeight: 600 }}>
										Geolocation Coordinates [Lng, Lat]
									</Typography>
									<Typography variant='body2' sx={{ fontFamily: 'monospace', color: '#059669' }}>
										[{hospital.location.coordinates[0]}, {hospital.location.coordinates[1]}]
									</Typography>
								</Grid>
							)}

							<Grid item xs={12}>
								<Divider sx={{ my: 1 }} />
							</Grid>

							<Grid item xs={12} sm={6}>
								<Typography variant='caption' sx={{ color: '#64748b', fontWeight: 600 }}>
									Registration Timestamp
								</Typography>
								<Typography variant='body2' sx={{ color: '#64748b' }}>
									{hospital.createdAt ? new Date(hospital.createdAt).toLocaleString() : 'N/A'}
								</Typography>
							</Grid>

							{hospital.verifiedAt && (
								<Grid item xs={12} sm={6}>
									<Typography variant='caption' sx={{ color: '#64748b', fontWeight: 600 }}>
										Last Verified Timestamp
									</Typography>
									<Typography variant='body2' sx={{ color: '#15803d' }}>
										{new Date(hospital.verifiedAt).toLocaleString()}
									</Typography>
								</Grid>
							)}
						</Grid>
					</Card>
				</Grid>

				{/* Column 2: Administrative Verification Actions Panel */}
				<Grid item xs={12} md={5}>
					<Card elevation={0} sx={{ p: 3, borderRadius: 3, border: '1px solid #e2e8f0', backgroundColor: '#fafafa', mb: 3 }}>
						<Typography variant='h6' sx={{ fontWeight: 700, color: '#1e293b', mb: 1 }}>
							Administrative Verification
						</Typography>
						<Typography variant='body2' sx={{ color: '#64748b', mb: 3 }}>
							Only platform administrators can change hospital accreditation and activation status.
						</Typography>

						<Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
							<Button
								variant='contained'
								color='success'
								fullWidth
								startIcon={verifyLoading ? <CircularProgress size={18} color='inherit' /> : <VerifiedIcon />}
								disabled={verifyLoading || hospital.verificationStatus === 'Verified'}
								onClick={() => handleOpenConfirm('VERIFY')}
								sx={{ textTransform: 'none', py: 1.2, fontWeight: 700, borderRadius: 2 }}
							>
								{hospital.verificationStatus === 'Verified' ? 'Facility Verified & Active' : 'Verify & Activate Facility'}
							</Button>

							<Button
								variant='outlined'
								color='error'
								fullWidth
								startIcon={<CancelIcon />}
								disabled={verifyLoading || hospital.verificationStatus === 'Rejected'}
								onClick={() => handleOpenConfirm('REJECT')}
								sx={{ textTransform: 'none', py: 1.2, fontWeight: 700, borderRadius: 2 }}
							>
								Reject Facility Credential
							</Button>

							<Button
								variant='outlined'
								color='warning'
								fullWidth
								startIcon={<HourglassEmptyIcon />}
								disabled={verifyLoading || hospital.verificationStatus === 'Pending'}
								onClick={() => handleOpenConfirm('PENDING')}
								sx={{ textTransform: 'none', py: 1.2, fontWeight: 700, borderRadius: 2 }}
							>
								Reset to Pending Review
							</Button>
						</Box>
					</Card>

					{/* Quick Actions Card */}
					<Card elevation={0} sx={{ p: 3, borderRadius: 3, border: '1px solid #e2e8f0', backgroundColor: '#ffffff' }}>
						<Typography variant='subtitle1' sx={{ fontWeight: 700, color: '#1e293b', mb: 1 }}>
							Medical Officer Associations
						</Typography>
						<Typography variant='body2' sx={{ color: '#64748b', mb: 2 }}>
							Assign accredited doctors to verify emergency tickets originating from this hospital.
						</Typography>
						<Button
							variant='outlined'
							fullWidth
							startIcon={<PersonAddAlt1Icon />}
							onClick={() => navigate(`/admin/medical-officers?hospitalId=${hospital._id}`)}
							sx={{ textTransform: 'none', fontWeight: 600, color: '#16a34a', borderColor: '#bbf7d0' }}
						>
							Assign Medical Officer to this Hospital
						</Button>
					</Card>
				</Grid>

				{/* Affiliated Medical Officers Table */}
				<Grid item xs={12}>
					<Card elevation={0} sx={{ p: 3, borderRadius: 3, border: '1px solid #e2e8f0', backgroundColor: '#ffffff' }}>
						<Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
							<Typography variant='h6' sx={{ fontWeight: 700, color: '#1e293b' }}>
								Affiliated Medical Officers ({associations?.length || 0})
							</Typography>
							<Button
								size='small'
								startIcon={<PersonAddAlt1Icon fontSize='small' />}
								onClick={() => navigate(`/admin/medical-officers?hospitalId=${hospital._id}`)}
								sx={{ textTransform: 'none', fontWeight: 600 }}
							>
								Manage Associations
							</Button>
						</Box>

						{moLoading ? (
							<Box sx={{ textAlign: 'center', py: 4 }}>
								<CircularProgress size={24} />
							</Box>
						) : associations?.length === 0 ? (
							<Alert severity='warning' sx={{ borderRadius: 2 }}>
								No Medical Officers currently associated with this hospital. Emergency requests created under this facility cannot be verified until an accredited Medical Officer is assigned.
							</Alert>
						) : (
							<TableContainer>
								<Table size='small'>
									<TableHead sx={{ backgroundColor: '#f8fafc' }}>
										<TableRow>
											<TableCell sx={{ fontWeight: 700 }}>Doctor Name</TableCell>
											<TableCell sx={{ fontWeight: 700 }}>Email</TableCell>
											<TableCell sx={{ fontWeight: 700 }}>Registration / Council</TableCell>
											<TableCell sx={{ fontWeight: 700 }}>Association Status</TableCell>
											<TableCell sx={{ fontWeight: 700 }}>Granted Permissions</TableCell>
											<TableCell sx={{ fontWeight: 700 }}>Effective Period</TableCell>
										</TableRow>
									</TableHead>
									<TableBody>
										{associations.map((assoc) => (
											<TableRow key={assoc._id} hover>
												<TableCell sx={{ fontWeight: 600 }}>
													Dr. {assoc.medicalOfficerUserId?.firstName} {assoc.medicalOfficerUserId?.lastName}
												</TableCell>
												<TableCell sx={{ color: '#64748b' }}>
													{assoc.medicalOfficerUserId?.email || 'N/A'}
												</TableCell>
												<TableCell>
													{assoc.medicalOfficerUserId?.medicalRegistrationNumber || 'N/A'} (
													{assoc.medicalOfficerUserId?.medicalCouncil || 'State Council'})
												</TableCell>
												<TableCell>
													<Chip
														size='small'
														label={assoc.associationStatus}
														color={
															assoc.associationStatus === 'Active'
																? 'success'
																: assoc.associationStatus === 'Suspended'
																? 'warning'
																: assoc.associationStatus === 'Revoked'
																? 'error'
																: 'default'
														}
														sx={{ fontWeight: 600 }}
													/>
												</TableCell>
												<TableCell>
													<Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
														{assoc.permissions?.map((p) => (
															<Chip
																key={p}
																size='small'
																label={p === 'VERIFY_EMERGENCY_REQUESTS' ? 'Verify Requests' : 'View Only'}
																sx={{ fontSize: '0.7rem', fontWeight: 600 }}
															/>
														))}
													</Box>
												</TableCell>
												<TableCell sx={{ fontSize: '0.75rem', color: '#64748b' }}>
													From: {new Date(assoc.effectiveFrom).toLocaleDateString()}
													{assoc.expiresAt && ` to ${new Date(assoc.expiresAt).toLocaleDateString()}`}
												</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							</TableContainer>
						)}
					</Card>
				</Grid>
			</Grid>

			{/* Confirmation Dialog */}
			<Dialog open={confirmOpen} onClose={handleCloseConfirm} maxWidth='xs' fullWidth>
				<DialogTitle sx={{ fontWeight: 700 }}>
					{actionType === 'VERIFY'
						? 'Confirm Facility Verification'
						: actionType === 'REJECT'
						? 'Confirm Facility Rejection'
						: 'Reset to Pending Status'}
				</DialogTitle>
				<DialogContent>
					<DialogContentText sx={{ color: '#475569' }}>
						{actionType === 'VERIFY' &&
							`Are you sure you want to verify and activate '${hospital.hospitalName}'? Verified facilities will be available for emergency blood requests and Medical Officer oversight.`}
						{actionType === 'REJECT' &&
							`Are you sure you want to mark '${hospital.hospitalName}' as Rejected? This will deactivate the facility and prevent Medical Officers from verifying tickets under it.`}
						{actionType === 'PENDING' &&
							`Are you sure you want to revert '${hospital.hospitalName}' back to Pending status?`}
					</DialogContentText>
				</DialogContent>
				<DialogActions sx={{ p: 2, pt: 0 }}>
					<Button onClick={handleCloseConfirm} color='inherit' sx={{ textTransform: 'none' }}>
						Cancel
					</Button>
					<Button
						onClick={handleExecuteVerification}
						variant='contained'
						color={actionType === 'VERIFY' ? 'success' : actionType === 'REJECT' ? 'error' : 'warning'}
						sx={{ textTransform: 'none', fontWeight: 700 }}
					>
						Confirm
					</Button>
				</DialogActions>
			</Dialog>
		</Container>
	)
}

export default HospitalDetails
