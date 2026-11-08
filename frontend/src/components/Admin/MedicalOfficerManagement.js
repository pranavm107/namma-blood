/**
 * Medical Officer Management, Onboarding & Hospital Association
 * Namma Blood — Phase 4.3.5 Hospital-Based Medical Officer Verification System
 */

import React, { useEffect, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { useLocation } from 'react-router-dom'
import { Formik, Form, Field } from 'formik'
import * as Yup from 'yup'
import {
	Autocomplete,
	Badge,
	Box,
	Button,
	Card,
	Checkbox,
	Chip,
	Container,
	Dialog,
	DialogActions,
	DialogContent,
	DialogTitle,
	Divider,
	FormControlLabel,
	FormGroup,
	Grid,
	IconButton,
	MenuItem,
	Paper,
	Select,
	Tab,
	Tabs,
	Table,
	TableBody,
	TableCell,
	TableContainer,
	TableHead,
	TableRow,
	TextField,
	Typography,
	Alert,
	AlertTitle,
	CircularProgress,
	Tooltip,
} from '@mui/material'
import SecurityIcon from '@mui/icons-material/Security'
import PersonAddAlt1Icon from '@mui/icons-material/PersonAddAlt1'
import HowToRegIcon from '@mui/icons-material/HowToReg'
import MedicalServicesIcon from '@mui/icons-material/MedicalServices'
import EditIcon from '@mui/icons-material/Edit'
import RefreshIcon from '@mui/icons-material/Refresh'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import CancelIcon from '@mui/icons-material/Cancel'
import PendingActionsIcon from '@mui/icons-material/PendingActions'
import ArrowForwardIcon from '@mui/icons-material/ArrowForward'
import { toast } from 'react-toastify'
import {
	fetchAdminHospitals,
	fetchMoAssociations,
	fetchMedicalOfficersList,
	fetchMoDirectory,
	onboardMedicalOfficer,
	verifyMedicalOfficerAccount,
	assignMedicalOfficer,
	updateAssociationStatus,
	clearAssociationActionStatus,
	clearMoDirectoryActionStatus,
} from '../../store/adminHospitalSlice'

const VALID_STATUSES = ['Active', 'Pending', 'Suspended', 'Revoked']
const VALID_LIFECYCLE_STATUSES = ['All', 'Pending', 'Verified', 'Rejected', 'Suspended']

const assignmentValidationSchema = Yup.object().shape({
	medicalOfficerUserId: Yup.string()
		.trim()
		.matches(/^[0-9a-fA-F]{24}$/, 'Must be a valid 24-character MongoDB User ID.')
		.required('Medical Officer account must be selected.'),
	hospitalId: Yup.string().trim().required('Please select a hospital facility.'),
	associationStatus: Yup.string()
		.oneOf(VALID_STATUSES, 'Select a valid status.')
		.required('Association status is required.'),
	effectiveFrom: Yup.date().required('Effective from date is required.'),
	expiresAt: Yup.date().nullable(),
	permissions: Yup.array()
		.min(1, 'At least one permission must be explicitly granted.')
		.required('Permissions required.'),
})

const onboardingValidationSchema = Yup.object().shape({
	firstName: Yup.string().trim().required('First name is required.'),
	lastName: Yup.string().trim().required('Last name is required.'),
	email: Yup.string().trim().email('Enter a valid email address.').required('Email is required.'),
	phoneNo1: Yup.string()
		.trim()
		.matches(/^[0-9+\-\s]{10,15}$/, 'Contact number must have at least 10 digits.')
		.required('Contact phone number is required.'),
	medicalRegistrationNumber: Yup.string()
		.trim()
		.min(3, 'At least 3 characters')
		.required('Medical registration number is required.'),
	medicalCouncil: Yup.string().trim().required('State or National Medical Council is required.'),
	registrationState: Yup.string().trim().required('State of medical registration is required.'),
	supportingEvidence: Yup.string().trim(),
	nominatedByHospitalId: Yup.string().nullable(),
})

const MedicalOfficerManagement = () => {
	const location = useLocation()
	const dispatch = useDispatch()

	const queryParams = new URLSearchParams(location.search)
	const initialHospitalId = queryParams.get('hospitalId') || ''

	const [activeTab, setActiveTab] = useState(0)

	// Redux state
	const { items: associations, isLoading: assocLoading, actionLoading: assocActionLoading, actionError: assocActionError } = useSelector(
		(state) => state.adminHospital?.associations || {}
	)
	const { items: hospitalList } = useSelector((state) => state.adminHospital?.hospitals || {})
	const { items: medicalOfficersList, isLoading: moListLoading } = useSelector(
		(state) => state.adminHospital?.availableMedicalOfficers || { items: [], isLoading: false }
	)
	const {
		items: moDirectory,
		isLoading: moDirLoading,
		actionLoading: moDirActionLoading,
		actionError: moDirActionError,
	} = useSelector((state) => state.adminHospital?.medicalOfficerDirectory || { items: [] })

	// Association Filters
	const [filterHospital, setFilterHospital] = useState(initialHospitalId)
	const [filterAssocStatus, setFilterAssocStatus] = useState('')

	// Directory Filters
	const [dirSearch, setDirSearch] = useState('')
	const [dirStatus, setDirStatus] = useState('All')

	// Onboarding Dialog State
	const [onboardOpen, setOnboardOpen] = useState(false)

	// Review/Verification Dialog State
	const [reviewOpen, setReviewOpen] = useState(false)
	const [selectedDoctorForReview, setSelectedDoctorForReview] = useState(null)
	const [reviewStatus, setReviewStatus] = useState('Verified')
	const [reviewRejectionReason, setReviewRejectionReason] = useState('')
	const [reviewIsActive, setReviewIsActive] = useState(true)

	// Edit Association Dialog State
	const [editDialogOpen, setEditDialogOpen] = useState(false)
	const [activeAssociation, setActiveAssociation] = useState(null)
	const [editStatus, setEditStatus] = useState('Active')
	const [editPermissions, setEditPermissions] = useState([])
	const [editExpiresAt, setEditExpiresAt] = useState('')

	useEffect(() => {
		dispatch(fetchAdminHospitals({ limit: 100 }))
		dispatch(fetchMedicalOfficersList())
		dispatch(
			fetchMoDirectory({
				verificationStatus: dirStatus === 'All' ? undefined : dirStatus,
				search: dirSearch || undefined,
			})
		)
		dispatch(
			fetchMoAssociations({
				hospitalId: filterHospital || undefined,
				associationStatus: filterAssocStatus || undefined,
			})
		)
	}, [dispatch, filterHospital, filterAssocStatus, dirStatus, dirSearch])

	// Handlers for Onboarding
	const handleOpenOnboard = () => {
		dispatch(clearMoDirectoryActionStatus())
		setOnboardOpen(true)
	}

	const handleCloseOnboard = () => {
		setOnboardOpen(false)
		dispatch(clearMoDirectoryActionStatus())
	}

	const handleSubmitOnboard = async (values, { setSubmitting, setFieldError, resetForm }) => {
		const payload = {
			firstName: values.firstName.trim(),
			lastName: values.lastName.trim(),
			email: values.email.trim().toLowerCase(),
			phoneNo1: values.phoneNo1.trim(),
			medicalRegistrationNumber: values.medicalRegistrationNumber.trim().toUpperCase(),
			medicalCouncil: values.medicalCouncil.trim(),
			registrationState: values.registrationState.trim(),
			supportingEvidence: values.supportingEvidence.trim(),
			nominatedByHospitalId: values.nominatedByHospitalId || undefined,
		}

		const result = await dispatch(onboardMedicalOfficer(payload))
		setSubmitting(false)

		if (onboardMedicalOfficer.fulfilled.match(result)) {
			toast.success(
				`Dr. ${payload.firstName} ${payload.lastName} onboarded successfully in Pending verification status.`,
				{ toastId: 'mo-onboard-success' }
			)
			resetForm()
			handleCloseOnboard()
			dispatch(
				fetchMoDirectory({
					verificationStatus: dirStatus === 'All' ? undefined : dirStatus,
					search: dirSearch || undefined,
				})
			)
		} else {
			const errorPayload = result.payload
			const errMsg = errorPayload?.message || errorPayload || 'Failed to onboard Medical Officer.'
			toast.error(errMsg, { toastId: 'mo-onboard-error' })
			if (errorPayload?.field) {
				setFieldError(errorPayload.field, errMsg)
			}
		}
	}

	// Handlers for Review & Verification
	const handleOpenReview = (doc) => {
		setSelectedDoctorForReview(doc)
		setReviewStatus(doc.verificationStatus === 'Pending' ? 'Verified' : doc.verificationStatus)
		setReviewRejectionReason(doc.rejectionReason || '')
		setReviewIsActive(doc.status !== false)
		setReviewOpen(true)
	}

	const handleCloseReview = () => {
		setReviewOpen(false)
		setSelectedDoctorForReview(null)
		dispatch(clearMoDirectoryActionStatus())
	}

	const handleSaveReview = async () => {
		if (!selectedDoctorForReview) return

		if (reviewStatus === 'Rejected' && !reviewRejectionReason.trim()) {
			toast.error('Rejection reason is mandatory when rejecting a Medical Officer.', { toastId: 'rej-reason-err' })
			return
		}

		const result = await dispatch(
			verifyMedicalOfficerAccount({
				id: selectedDoctorForReview._id,
				verificationStatus: reviewStatus,
				rejectionReason: reviewStatus === 'Rejected' ? reviewRejectionReason.trim() : undefined,
				isActive: reviewStatus === 'Verified' ? reviewIsActive : false,
			})
		)

		if (verifyMedicalOfficerAccount.fulfilled.match(result)) {
			toast.success(
				`Dr. ${selectedDoctorForReview.firstName} ${selectedDoctorForReview.lastName} verification status updated to '${reviewStatus}'.`,
				{ toastId: 'mo-verify-success' }
			)
			handleCloseReview()
			dispatch(
				fetchMoDirectory({
					verificationStatus: dirStatus === 'All' ? undefined : dirStatus,
					search: dirSearch || undefined,
				})
			)
			dispatch(fetchMedicalOfficersList())
		} else {
			toast.error(result.payload?.message || result.payload || 'Failed to update verification status.', { toastId: 'mo-verify-err' })
		}
	}

	// Handlers for Association Edit
	const handleOpenEdit = (assoc) => {
		setActiveAssociation(assoc)
		setEditStatus(assoc.associationStatus)
		setEditPermissions(assoc.permissions || ['VIEW_EMERGENCY_REQUESTS'])
		setEditExpiresAt(assoc.expiresAt ? assoc.expiresAt.substring(0, 10) : '')
		setEditDialogOpen(true)
	}

	const handleCloseEdit = () => {
		setEditDialogOpen(false)
		setActiveAssociation(null)
		dispatch(clearAssociationActionStatus())
	}

	const handleSaveEdit = async () => {
		if (!activeAssociation) return

		const result = await dispatch(
			updateAssociationStatus({
				associationId: activeAssociation._id,
				associationStatus: editStatus,
				permissions: editPermissions,
				expiresAt: editExpiresAt ? new Date(editExpiresAt) : null,
			})
		)

		if (updateAssociationStatus.fulfilled.match(result)) {
			toast.success(`Association updated to '${editStatus}'.`, { toastId: 'assoc-upd-success' })
			handleCloseEdit()
			dispatch(
				fetchMoAssociations({
					hospitalId: filterHospital || undefined,
					associationStatus: filterAssocStatus || undefined,
				})
			)
		} else {
			toast.error(result.payload || 'Failed to update association.', { toastId: 'assoc-upd-err' })
		}
	}

	const handleCreateAssignment = async (values, { resetForm, setSubmitting }) => {
		const payload = {
			medicalOfficerUserId: values.medicalOfficerUserId.trim(),
			hospitalId: values.hospitalId.trim(),
			permissions: values.permissions,
			associationStatus: values.associationStatus,
			effectiveFrom: new Date(values.effectiveFrom),
			expiresAt: values.expiresAt ? new Date(values.expiresAt) : null,
		}

		const result = await dispatch(assignMedicalOfficer(payload))
		setSubmitting(false)

		if (assignMedicalOfficer.fulfilled.match(result)) {
			toast.success(result.payload?.message || 'Medical Officer assigned successfully.', { toastId: 'assoc-create-success' })
			resetForm()
			dispatch(
				fetchMoAssociations({
					hospitalId: filterHospital || undefined,
					associationStatus: filterAssocStatus || undefined,
				})
			)
		} else {
			const errMsg = result.payload?.message || result.payload || 'Assignment failed.'
			toast.error(errMsg, { toastId: 'assoc-create-error' })
		}
	}

	const pendingDoctorCount = moDirectory.filter((d) => d.verificationStatus === 'Pending').length

	return (
		<Container maxWidth='xl' sx={{ pb: 8, pt: 2 }}>
			{/* Top Hero Banner */}
			<Paper
				elevation={0}
				sx={{
					p: 3,
					mb: 3,
					borderRadius: 3,
					background: 'linear-gradient(135deg, #ffffff 0%, #f0fdf4 100%)',
					border: '1px solid #bbf7d0',
					display: 'flex',
					alignItems: 'center',
					gap: 2,
				}}
			>
				<SecurityIcon sx={{ color: '#16a34a', fontSize: 40 }} />
				<Box sx={{ flex: 1 }}>
					<Typography variant='h5' sx={{ fontWeight: 800, color: '#1e293b' }}>
						Medical Officer Governance & Hospital Verification Interface
					</Typography>
					<Typography variant='body2' sx={{ color: '#64748b' }}>
						Onboard accredited doctors, review medical credentials, approve active lifecycle status, and manage granular hospital associations.
					</Typography>
				</Box>
				<Button
					variant='contained'
					startIcon={<PersonAddAlt1Icon />}
					onClick={handleOpenOnboard}
					sx={{
						backgroundColor: '#16a34a',
						fontWeight: 700,
						textTransform: 'none',
						px: 3,
						py: 1.2,
						borderRadius: 2,
						'&:hover': { backgroundColor: '#15803d' },
					}}
				>
					Onboard Doctor
				</Button>
			</Paper>

			{/* Navigation Tabs */}
			<Paper elevation={0} sx={{ mb: 3, borderRadius: 2, border: '1px solid #e2e8f0' }}>
				<Tabs
					value={activeTab}
					onChange={(_, val) => setActiveTab(val)}
					textColor='primary'
					indicatorColor='primary'
					sx={{
						px: 2,
						'& .MuiTab-root': { textTransform: 'none', fontWeight: 700, fontSize: '0.95rem', minHeight: 52 },
					}}
				>
					<Tab
						iconPosition='start'
						icon={
							<Badge badgeContent={pendingDoctorCount} color='warning' sx={{ mr: 1 }}>
								<MedicalServicesIcon />
							</Badge>
						}
						label='Accredited Medical Officers (Directory & Verification)'
					/>
					<Tab
						iconPosition='start'
						icon={<HowToRegIcon sx={{ mr: 1 }} />}
						label={`Hospital Facility Associations (${associations?.length || 0})`}
					/>
				</Tabs>
			</Paper>

			{/* TAB 0: DOCTOR DIRECTORY & CREDENTIAL VERIFICATION */}
			{activeTab === 0 && (
				<Card elevation={0} sx={{ p: 3, borderRadius: 3, border: '1px solid #e2e8f0', backgroundColor: '#ffffff' }}>
					<Box sx={{ display: 'flex', flexDirection: { xs: 'column', md: 'row' }, justifyContent: 'space-between', alignItems: { md: 'center' }, gap: 2, mb: 3 }}>
						<Box>
							<Typography variant='h6' sx={{ fontWeight: 700, color: '#1e293b' }}>
								Registered Medical Officers ({moDirectory.length})
							</Typography>
							<Typography variant='caption' sx={{ color: '#64748b' }}>
								Accredited physicians registered with State or National Medical Councils. Only Verified and active accounts can be associated with hospitals.
							</Typography>
						</Box>

						{/* Search & Filters */}
						<Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
							<TextField
								size='small'
								placeholder='Search name, email, reg no...'
								value={dirSearch}
								onChange={(e) => setDirSearch(e.target.value)}
								sx={{ minWidth: 240 }}
							/>

							<Select
								size='small'
								value={dirStatus}
								onChange={(e) => setDirStatus(e.target.value)}
								sx={{ minWidth: 150 }}
							>
								{VALID_LIFECYCLE_STATUSES.map((st) => (
									<MenuItem key={st} value={st}>
										{st === 'All' ? 'All Statuses' : st}
									</MenuItem>
								))}
							</Select>

							<Tooltip title='Refresh Directory'>
								<IconButton
									size='small'
									onClick={() =>
										dispatch(
											fetchMoDirectory({
												verificationStatus: dirStatus === 'All' ? undefined : dirStatus,
												search: dirSearch || undefined,
											})
										)
									}
									sx={{ border: '1px solid #cbd5e1', borderRadius: 2 }}
								>
									<RefreshIcon fontSize='small' />
								</IconButton>
							</Tooltip>
						</Box>
					</Box>

					{moDirLoading ? (
						<Box sx={{ textAlign: 'center', py: 8 }}>
							<CircularProgress size={36} sx={{ color: '#16a34a' }} />
						</Box>
					) : moDirectory.length === 0 ? (
						<Box sx={{ textAlign: 'center', py: 8 }}>
							<MedicalServicesIcon sx={{ fontSize: 48, color: '#94a3b8', mb: 1 }} />
							<Typography variant='h6' sx={{ color: '#1e293b', fontWeight: 700 }}>
								No Medical Officers Found
							</Typography>
							<Typography variant='body2' sx={{ color: '#64748b', mb: 2 }}>
								No doctor accounts match the current filter criteria.
							</Typography>
							<Button variant='outlined' startIcon={<PersonAddAlt1Icon />} onClick={handleOpenOnboard} sx={{ textTransform: 'none', fontWeight: 600 }}>
								Onboard New Doctor
							</Button>
						</Box>
					) : (
						<TableContainer>
							<Table sx={{ minWidth: 800 }}>
								<TableHead sx={{ backgroundColor: '#f8fafc' }}>
									<TableRow>
										<TableCell sx={{ fontWeight: 700 }}>Doctor Identity</TableCell>
										<TableCell sx={{ fontWeight: 700 }}>Registration & Council</TableCell>
										<TableCell sx={{ fontWeight: 700 }}>Hospital Nomination</TableCell>
										<TableCell sx={{ fontWeight: 700 }}>Lifecycle Status</TableCell>
										<TableCell align='right' sx={{ fontWeight: 700 }}>
											Governance Action
										</TableCell>
									</TableRow>
								</TableHead>
								<TableBody>
									{moDirectory.map((doc) => (
										<TableRow key={doc._id} hover>
											<TableCell>
												<Typography variant='body2' sx={{ fontWeight: 700, color: '#1e293b' }}>
													Dr. {doc.firstName} {doc.lastName}
												</Typography>
												<Typography variant='caption' sx={{ color: '#64748b', display: 'block' }}>
													{doc.email} • Ph: {doc.phoneNo1}
												</Typography>
												<Typography variant='caption' sx={{ color: '#0284c7', display: 'block', fontFamily: 'monospace' }}>
													ID: {doc._id}
												</Typography>
											</TableCell>
											<TableCell>
												<Typography variant='body2' sx={{ fontWeight: 600, color: '#0f172a' }}>
													Reg: {doc.medicalRegistrationNumber}
												</Typography>
												<Typography variant='caption' sx={{ color: '#475569', display: 'block' }}>
													Council: {doc.medicalCouncil} ({doc.registrationState || 'State'})
												</Typography>
												{doc.supportingEvidence && (
													<Typography variant='caption' sx={{ color: '#059669', display: 'block', fontStyle: 'italic' }}>
														Evidence: {doc.supportingEvidence}
													</Typography>
												)}
											</TableCell>
											<TableCell>
												{doc.nominatedByHospital ? (
													<Box>
														<Typography variant='body2' sx={{ fontWeight: 600, color: '#1e293b' }}>
															{doc.nominatedByHospital.hospitalName}
														</Typography>
														<Typography variant='caption' sx={{ color: '#64748b', fontFamily: 'monospace' }}>
															{doc.nominatedByHospital.hospitalCode} • {doc.nominatedByHospital.address?.city}
														</Typography>
													</Box>
												) : (
													<Typography variant='caption' sx={{ color: '#94a3b8' }}>
														Direct Platform Onboarding
													</Typography>
												)}
											</TableCell>
											<TableCell>
												<Chip
													size='small'
													label={doc.verificationStatus}
													color={
														doc.verificationStatus === 'Verified'
															? 'success'
															: doc.verificationStatus === 'Pending'
															? 'warning'
															: doc.verificationStatus === 'Rejected'
															? 'error'
															: 'default'
													}
													sx={{ fontWeight: 700 }}
												/>
												<Typography variant='caption' sx={{ color: '#64748b', display: 'block', mt: 0.5 }}>
													Active: {doc.status ? 'Yes ✓' : 'No ✗'}
												</Typography>
											</TableCell>
											<TableCell align='right'>
												<Button
													size='small'
													variant='outlined'
													startIcon={<HowToRegIcon />}
													onClick={() => handleOpenReview(doc)}
													sx={{ textTransform: 'none', fontWeight: 600 }}
												>
													Review & Verify
												</Button>
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</TableContainer>
					)}
				</Card>
			)}

			{/* TAB 1: HOSPITAL FACILITY ASSOCIATIONS */}
			{activeTab === 1 && (
				<Grid container spacing={3}>
					{/* Left: Assignment Form Card */}
					<Grid item xs={12} lg={4}>
						<Card elevation={0} sx={{ p: 3, borderRadius: 3, border: '1px solid #e2e8f0', backgroundColor: '#ffffff' }}>
							<Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
								<PersonAddAlt1Icon sx={{ color: '#16a34a' }} />
								<Typography variant='h6' sx={{ fontWeight: 700, color: '#1e293b' }}>
									Assign Medical Officer
								</Typography>
							</Box>
							<Typography variant='body2' sx={{ color: '#64748b', mb: 2 }}>
								Link an accredited, verified doctor to an authorized hospital with explicit verification permissions.
							</Typography>

							{/* Empty state alert if no verified doctors exist */}
							{medicalOfficersList.length === 0 && (
								<Alert severity='info' sx={{ mb: 2.5, borderRadius: 2 }}>
									<AlertTitle sx={{ fontWeight: 700 }}>No Verified Medical Officers Available</AlertTitle>
									No verified Medical Officer accounts are currently available. Register or onboard a Medical Officer before creating a hospital association.
									<Box sx={{ mt: 1.5 }}>
										<Button
											size='small'
											variant='contained'
											color='primary'
											startIcon={<ArrowForwardIcon />}
											onClick={() => setActiveTab(0)}
											sx={{ textTransform: 'none', fontWeight: 700 }}
										>
											Go to Doctor Onboarding
										</Button>
									</Box>
								</Alert>
							)}

							{assocActionError && (
								<Alert severity='error' sx={{ mb: 2, borderRadius: 2 }}>
									{assocActionError}
								</Alert>
							)}

							<Formik
								initialValues={{
									medicalOfficerUserId: '',
									hospitalId: initialHospitalId,
									associationStatus: 'Active',
									effectiveFrom: new Date().toISOString().substring(0, 10),
									expiresAt: '',
									permissions: ['VIEW_EMERGENCY_REQUESTS', 'VERIFY_EMERGENCY_REQUESTS'],
								}}
								validationSchema={assignmentValidationSchema}
								onSubmit={handleCreateAssignment}
							>
								{({ values, errors, touched, setFieldValue, isSubmitting }) => (
									<Form>
										<Box sx={{ mb: 2 }}>
											<Autocomplete
												id='medical-officer-search-select'
												options={medicalOfficersList}
												loading={moListLoading}
												disabled={medicalOfficersList.length === 0}
												value={
													medicalOfficersList.find((mo) => mo._id === values.medicalOfficerUserId) || null
												}
												onChange={(_, newValue) => {
													setFieldValue('medicalOfficerUserId', newValue ? newValue._id : '')
												}}
												getOptionLabel={(option) => {
													if (!option) return ''
													return `Dr. ${option.firstName} ${option.lastName} (${option.medicalRegistrationNumber || 'Reg: N/A'}) - ${option.email}`
												}}
												isOptionEqualToValue={(option, val) => option._id === val?._id}
												filterOptions={(options, { inputValue }) => {
													const query = inputValue.toLowerCase().trim()
													if (!query) return options
													return options.filter((mo) => {
														const name = `${mo.firstName || ''} ${mo.lastName || ''}`.toLowerCase()
														const email = (mo.email || '').toLowerCase()
														const reg = (mo.medicalRegistrationNumber || '').toLowerCase()
														const council = (mo.medicalCouncil || '').toLowerCase()
														return (
															name.includes(query) ||
															email.includes(query) ||
															reg.includes(query) ||
															council.includes(query)
														)
													})
												}}
												renderOption={(props, option) => (
													<li {...props} key={option._id}>
														<Box sx={{ py: 0.5, width: '100%' }}>
															<Typography variant='body2' sx={{ fontWeight: 700, color: '#1e293b' }}>
																Dr. {option.firstName} {option.lastName}
															</Typography>
															<Typography variant='caption' sx={{ color: '#475569', display: 'block' }}>
																Reg No: <strong>{option.medicalRegistrationNumber || 'Not Specified'}</strong> • Council: {option.medicalCouncil || 'State Council'}
															</Typography>
															<Typography variant='caption' sx={{ color: '#0284c7', display: 'block', wordBreak: 'break-all' }}>
																{option.email}
															</Typography>
														</Box>
													</li>
												)}
												renderInput={(params) => (
													<TextField
														{...params}
														size='small'
														label='Search & Select Medical Officer'
														placeholder='Search name, email, reg no...'
														InputProps={{
															...params.InputProps,
															endAdornment: (
																<React.Fragment>
																	{moListLoading ? <CircularProgress color='inherit' size={18} /> : null}
																	{params.InputProps.endAdornment}
																</React.Fragment>
															),
														}}
													/>
												)}
											/>
										</Box>

										<Box sx={{ mb: 2 }}>
											<Field
												as={TextField}
												fullWidth
												size='small'
												name='medicalOfficerUserId'
												label='Populated Medical Officer User ID'
												value={values.medicalOfficerUserId}
												InputProps={{
													readOnly: true,
												}}
												error={touched.medicalOfficerUserId && Boolean(errors.medicalOfficerUserId)}
												helperText={
													touched.medicalOfficerUserId && errors.medicalOfficerUserId
														? errors.medicalOfficerUserId
														: values.medicalOfficerUserId
														? 'Authoritative MongoDB User ID populated from verified account selection (read-only).'
														: 'Select an accredited Medical Officer above to populate this ID.'
												}
												sx={{
													backgroundColor: '#f8fafc',
													'& .MuiInputBase-input': { fontFamily: 'monospace', fontWeight: 600, color: '#0f172a' },
												}}
											/>
										</Box>

										<Box sx={{ mb: 2 }}>
											<Field
												as={TextField}
												fullWidth
												select
												size='small'
												name='hospitalId'
												label='Target Hospital Facility'
												error={touched.hospitalId && Boolean(errors.hospitalId)}
												helperText={touched.hospitalId && errors.hospitalId}
											>
												<MenuItem value='' disabled>
													<em>-- Select Hospital --</em>
												</MenuItem>
												{hospitalList.map((h) => (
													<MenuItem key={h._id} value={h._id}>
														{h.hospitalName} ({h.hospitalCode}) — {h.address?.city}
													</MenuItem>
												))}
											</Field>
										</Box>

										<Box sx={{ mb: 2 }}>
											<Field
												as={TextField}
												fullWidth
												select
												size='small'
												name='associationStatus'
												label='Association Status'
												error={touched.associationStatus && Boolean(errors.associationStatus)}
												helperText={touched.associationStatus && errors.associationStatus}
											>
												{VALID_STATUSES.map((st) => (
													<MenuItem key={st} value={st}>
														{st}
													</MenuItem>
												))}
											</Field>
										</Box>

										<Box sx={{ mb: 2 }}>
											<Field
												as={TextField}
												fullWidth
												size='small'
												type='date'
												name='effectiveFrom'
												label='Effective From'
												InputLabelProps={{ shrink: true }}
												error={touched.effectiveFrom && Boolean(errors.effectiveFrom)}
												helperText={touched.effectiveFrom && errors.effectiveFrom}
											/>
										</Box>

										<Box sx={{ mb: 2 }}>
											<Field
												as={TextField}
												fullWidth
												size='small'
												type='date'
												name='expiresAt'
												label='Expires At (Optional)'
												InputLabelProps={{ shrink: true }}
												error={touched.expiresAt && Boolean(errors.expiresAt)}
												helperText={touched.expiresAt && errors.expiresAt}
											/>
										</Box>

										<Box sx={{ mb: 2 }}>
											<Typography variant='caption' sx={{ fontWeight: 700, color: '#475569', display: 'block', mb: 0.5 }}>
												Explicit Permissions (Never Granted Implicitly)
											</Typography>
											<FormGroup>
												<FormControlLabel
													control={
														<Checkbox
															size='small'
															checked={values.permissions.includes('VIEW_EMERGENCY_REQUESTS')}
															onChange={(e) => {
																if (e.target.checked) {
																	setFieldValue('permissions', [
																		...values.permissions,
																		'VIEW_EMERGENCY_REQUESTS',
																	])
																} else {
																	setFieldValue(
																		'permissions',
																		values.permissions.filter((p) => p !== 'VIEW_EMERGENCY_REQUESTS')
																	)
																}
															}}
														/>
													}
													label={<Typography variant='body2'>VIEW_EMERGENCY_REQUESTS (Queue read-only)</Typography>}
												/>
												<FormControlLabel
													control={
														<Checkbox
															size='small'
															checked={values.permissions.includes('VERIFY_EMERGENCY_REQUESTS')}
															onChange={(e) => {
																if (e.target.checked) {
																	setFieldValue('permissions', [
																		...values.permissions,
																		'VERIFY_EMERGENCY_REQUESTS',
																	])
																} else {
																	setFieldValue(
																		'permissions',
																		values.permissions.filter((p) => p !== 'VERIFY_EMERGENCY_REQUESTS')
																	)
																}
															}}
														/>
													}
													label={<Typography variant='body2'>VERIFY_EMERGENCY_REQUESTS (Clinical decision)</Typography>}
												/>
											</FormGroup>
											{touched.permissions && errors.permissions && (
												<Typography variant='caption' color='error'>
													{errors.permissions}
												</Typography>
											)}
										</Box>

										<Button
											type='submit'
											variant='contained'
											fullWidth
											disabled={isSubmitting || assocActionLoading || medicalOfficersList.length === 0}
											startIcon={assocActionLoading ? <CircularProgress size={16} /> : <SecurityIcon />}
											sx={{
												backgroundColor: '#16a34a',
												fontWeight: 700,
												textTransform: 'none',
												py: 1.2,
												borderRadius: 2,
												'&:hover': { backgroundColor: '#15803d' },
											}}
										>
											{assocActionLoading ? 'Assigning...' : 'Save Association'}
										</Button>
									</Form>
								)}
							</Formik>
						</Card>
					</Grid>

					{/* Right: Existing Associations Directory */}
					<Grid item xs={12} lg={8}>
						<Card elevation={0} sx={{ p: 3, borderRadius: 3, border: '1px solid #e2e8f0', backgroundColor: '#ffffff' }}>
							<Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, justifyContent: 'space-between', alignItems: { sm: 'center' }, gap: 2, mb: 3 }}>
								<Box>
									<Typography variant='h6' sx={{ fontWeight: 700, color: '#1e293b' }}>
										Active Associations ({associations?.length || 0})
									</Typography>
									<Typography variant='caption' sx={{ color: '#64748b' }}>
										Accredited Medical Officers linked to hospital facilities
									</Typography>
								</Box>

								{/* Filters */}
								<Box sx={{ display: 'flex', gap: 1 }}>
									<Select
										size='small'
										displayEmpty
										value={filterHospital}
										onChange={(e) => setFilterHospital(e.target.value)}
										sx={{ minWidth: 160 }}
									>
										<MenuItem value=''>
											<em>All Hospitals</em>
										</MenuItem>
										{hospitalList.map((h) => (
											<MenuItem key={h._id} value={h._id}>
												{h.hospitalCode} — {h.hospitalName}
											</MenuItem>
										))}
									</Select>

									<Select
										size='small'
										displayEmpty
										value={filterAssocStatus}
										onChange={(e) => setFilterAssocStatus(e.target.value)}
										sx={{ minWidth: 120 }}
									>
										<MenuItem value=''>
											<em>All Statuses</em>
										</MenuItem>
										{VALID_STATUSES.map((st) => (
											<MenuItem key={st} value={st}>
												{st}
											</MenuItem>
										))}
									</Select>

									<Tooltip title='Refresh'>
										<IconButton
											size='small'
											onClick={() =>
												dispatch(
													fetchMoAssociations({
														hospitalId: filterHospital || undefined,
														associationStatus: filterAssocStatus || undefined,
													})
												)
											}
											sx={{ border: '1px solid #cbd5e1', borderRadius: 2 }}
										>
											<RefreshIcon fontSize='small' />
										</IconButton>
									</Tooltip>
								</Box>
							</Box>

							{assocLoading ? (
								<Box sx={{ textAlign: 'center', py: 8 }}>
									<CircularProgress size={36} sx={{ color: '#16a34a' }} />
								</Box>
							) : associations?.length === 0 ? (
								<Box sx={{ textAlign: 'center', py: 8 }}>
									<SecurityIcon sx={{ fontSize: 48, color: '#94a3b8', mb: 1 }} />
									<Typography variant='h6' sx={{ color: '#1e293b', fontWeight: 700 }}>
										No Associations Found
									</Typography>
									<Typography variant='body2' sx={{ color: '#64748b' }}>
										No doctor-hospital associations match the filter criteria.
									</Typography>
								</Box>
							) : (
								<TableContainer>
									<Table sx={{ minWidth: 700 }}>
										<TableHead sx={{ backgroundColor: '#f8fafc' }}>
											<TableRow>
												<TableCell sx={{ fontWeight: 700 }}>Medical Officer</TableCell>
												<TableCell sx={{ fontWeight: 700 }}>Hospital Facility</TableCell>
												<TableCell sx={{ fontWeight: 700 }}>Status</TableCell>
												<TableCell sx={{ fontWeight: 700 }}>Permissions</TableCell>
												<TableCell sx={{ fontWeight: 700 }}>Effective Period</TableCell>
												<TableCell align='right' sx={{ fontWeight: 700 }}>
													Action
												</TableCell>
											</TableRow>
										</TableHead>
										<TableBody>
											{associations.map((assoc) => (
												<TableRow key={assoc._id} hover>
													<TableCell>
														<Typography variant='body2' sx={{ fontWeight: 700, color: '#1e293b' }}>
															Dr. {assoc.medicalOfficerUserId?.firstName}{' '}
															{assoc.medicalOfficerUserId?.lastName}
														</Typography>
														<Typography variant='caption' sx={{ color: '#64748b', display: 'block' }}>
															{assoc.medicalOfficerUserId?.email}
														</Typography>
														<Typography variant='caption' sx={{ color: '#0284c7', display: 'block', fontFamily: 'monospace' }}>
															ID: {assoc.medicalOfficerUserId?._id || assoc.medicalOfficerUserId}
														</Typography>
													</TableCell>
													<TableCell>
														<Typography variant='body2' sx={{ fontWeight: 600, color: '#1e293b' }}>
															{assoc.hospitalId?.hospitalName}
														</Typography>
														<Typography variant='caption' sx={{ fontFamily: 'monospace', color: '#64748b' }}>
															{assoc.hospitalId?.hospitalCode} • {assoc.hospitalId?.address?.city}
														</Typography>
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
														<Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
															{assoc.permissions?.map((perm) => (
																<Chip
																	key={perm}
																	size='small'
																	label={
																		perm === 'VERIFY_EMERGENCY_REQUESTS'
																			? 'VERIFY (Decision)'
																			: 'VIEW (Queue)'
																	}
																	sx={{ fontSize: '0.68rem', fontWeight: 600 }}
																/>
															))}
														</Box>
													</TableCell>
													<TableCell>
														<Typography variant='caption' sx={{ display: 'block', color: '#475569' }}>
															From: {new Date(assoc.effectiveFrom).toLocaleDateString()}
														</Typography>
														<Typography variant='caption' sx={{ display: 'block', color: '#64748b' }}>
															Exp:{' '}
															{assoc.expiresAt
																? new Date(assoc.expiresAt).toLocaleDateString()
																: 'Indefinite'}
														</Typography>
													</TableCell>
													<TableCell align='right'>
														<Tooltip title='Edit Permissions / Status'>
															<IconButton
																size='small'
																onClick={() => handleOpenEdit(assoc)}
																sx={{ border: '1px solid #cbd5e1', borderRadius: 2 }}
															>
																<EditIcon fontSize='small' />
															</IconButton>
														</Tooltip>
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
			)}

			{/* DIALOG 1: ONBOARD NEW MEDICAL OFFICER */}
			<Dialog open={onboardOpen} onClose={handleCloseOnboard} maxWidth='md' fullWidth>
				<DialogTitle sx={{ fontWeight: 800, color: '#1e293b' }}>
					Onboard Accredited Medical Officer
				</DialogTitle>
				<Formik
					initialValues={{
						firstName: '',
						lastName: '',
						email: '',
						phoneNo1: '',
						medicalRegistrationNumber: '',
						medicalCouncil: 'Tamil Nadu Medical Council',
						registrationState: 'Tamil Nadu',
						supportingEvidence: '',
						nominatedByHospitalId: '',
					}}
					validationSchema={onboardingValidationSchema}
					onSubmit={handleSubmitOnboard}
				>
					{({ errors, touched, isSubmitting }) => (
						<Form>
							<DialogContent dividers>
								<Alert severity='info' sx={{ mb: 3, borderRadius: 2 }}>
									<AlertTitle sx={{ fontWeight: 700 }}>Governance Safeguard</AlertTitle>
									Medical Officer accounts are registered in <strong>Pending</strong> verification status and are inactive by default. An Admin must review professional credentials before approving the account for hospital association.
								</Alert>

								{moDirActionError && (
									<Alert severity='error' sx={{ mb: 2, borderRadius: 2 }}>
										{moDirActionError}
									</Alert>
								)}

								<Typography variant='subtitle2' sx={{ fontWeight: 700, color: '#1e293b', mb: 1.5 }}>
									1. Doctor Professional Identity
								</Typography>
								<Grid container spacing={2} sx={{ mb: 2.5 }}>
									<Grid item xs={12} sm={6}>
										<Field
											as={TextField}
											fullWidth
											size='small'
											name='firstName'
											label='First Name'
											placeholder='e.g. Ramesh'
											error={touched.firstName && Boolean(errors.firstName)}
											helperText={touched.firstName && errors.firstName}
										/>
									</Grid>
									<Grid item xs={12} sm={6}>
										<Field
											as={TextField}
											fullWidth
											size='small'
											name='lastName'
											label='Last Name'
											placeholder='e.g. Kuppusamy'
											error={touched.lastName && Boolean(errors.lastName)}
											helperText={touched.lastName && errors.lastName}
										/>
									</Grid>
									<Grid item xs={12} sm={6}>
										<Field
											as={TextField}
											fullWidth
											size='small'
											name='email'
											label='Official Doctor Email'
											placeholder='dr.ramesh@hospital.org'
											error={touched.email && Boolean(errors.email)}
											helperText={touched.email && errors.email}
										/>
									</Grid>
									<Grid item xs={12} sm={6}>
										<Field
											as={TextField}
											fullWidth
											size='small'
											name='phoneNo1'
											label='Contact Phone Number'
											placeholder='9840123456'
											error={touched.phoneNo1 && Boolean(errors.phoneNo1)}
											helperText={touched.phoneNo1 && errors.phoneNo1}
										/>
									</Grid>
								</Grid>

								<Divider sx={{ my: 2 }} />

								<Typography variant='subtitle2' sx={{ fontWeight: 700, color: '#1e293b', mb: 1.5 }}>
									2. Medical Registration Credentials
								</Typography>
								<Grid container spacing={2} sx={{ mb: 2.5 }}>
									<Grid item xs={12} sm={6}>
										<Field
											as={TextField}
											fullWidth
											size='small'
											name='medicalRegistrationNumber'
											label='Medical Registration Number'
											placeholder='e.g. TN-MED-84920'
											error={touched.medicalRegistrationNumber && Boolean(errors.medicalRegistrationNumber)}
											helperText={touched.medicalRegistrationNumber && errors.medicalRegistrationNumber}
										/>
									</Grid>
									<Grid item xs={12} sm={6}>
										<Field
											as={TextField}
											fullWidth
											size='small'
											name='medicalCouncil'
											label='State / National Medical Council'
											placeholder='e.g. Tamil Nadu Medical Council'
											error={touched.medicalCouncil && Boolean(errors.medicalCouncil)}
											helperText={touched.medicalCouncil && errors.medicalCouncil}
										/>
									</Grid>
									<Grid item xs={12} sm={6}>
										<Field
											as={TextField}
											fullWidth
											size='small'
											name='registrationState'
											label='Registration State'
											placeholder='e.g. Tamil Nadu'
											error={touched.registrationState && Boolean(errors.registrationState)}
											helperText={touched.registrationState && errors.registrationState}
										/>
									</Grid>
									<Grid item xs={12} sm={6}>
										<Field
											as={TextField}
											fullWidth
											size='small'
											name='supportingEvidence'
											label='Supporting Registration Evidence / Notes'
											placeholder='Certificate Ref / State Registry URL'
											error={touched.supportingEvidence && Boolean(errors.supportingEvidence)}
											helperText={touched.supportingEvidence && errors.supportingEvidence}
										/>
									</Grid>
								</Grid>

								<Divider sx={{ my: 2 }} />

								<Typography variant='subtitle2' sx={{ fontWeight: 700, color: '#1e293b', mb: 1.5 }}>
									3. Hospital Nomination (Optional)
								</Typography>
								<Grid container spacing={2}>
									<Grid item xs={12}>
										<Field
											as={TextField}
											fullWidth
											select
											size='small'
											name='nominatedByHospitalId'
											label='Nominating Hospital Facility'
											helperText='Select if this doctor was nominated by an onboarded hospital facility.'
										>
											<MenuItem value=''>
												<em>None — Direct Administrative Onboarding</em>
											</MenuItem>
											{hospitalList.map((h) => (
												<MenuItem key={h._id} value={h._id}>
													{h.hospitalName} ({h.hospitalCode}) — {h.address?.city}
												</MenuItem>
											))}
										</Field>
									</Grid>
								</Grid>
							</DialogContent>
							<DialogActions sx={{ p: 2.5 }}>
								<Button onClick={handleCloseOnboard} sx={{ textTransform: 'none', fontWeight: 600 }}>
									Cancel
								</Button>
								<Button
									type='submit'
									variant='contained'
									disabled={isSubmitting || moDirActionLoading}
									startIcon={moDirActionLoading ? <CircularProgress size={16} /> : <HowToRegIcon />}
									sx={{
										backgroundColor: '#16a34a',
										fontWeight: 700,
										textTransform: 'none',
										px: 3,
										'&:hover': { backgroundColor: '#15803d' },
									}}
								>
									{moDirActionLoading ? 'Onboarding...' : 'Onboard Doctor'}
								</Button>
							</DialogActions>
						</Form>
					)}
				</Formik>
			</Dialog>

			{/* DIALOG 2: REVIEW CREDENTIALS & VERIFY / REJECT DOCTOR */}
			<Dialog open={reviewOpen} onClose={handleCloseReview} maxWidth='sm' fullWidth>
				<DialogTitle sx={{ fontWeight: 800, color: '#1e293b' }}>
					Review Professional Credentials & Verify Account
				</DialogTitle>
				<DialogContent dividers>
					{selectedDoctorForReview && (
						<Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
							<Paper elevation={0} sx={{ p: 2, backgroundColor: '#f8fafc', borderRadius: 2, border: '1px solid #e2e8f0' }}>
								<Typography variant='subtitle1' sx={{ fontWeight: 700, color: '#0f172a' }}>
									Dr. {selectedDoctorForReview.firstName} {selectedDoctorForReview.lastName}
								</Typography>
								<Typography variant='body2' sx={{ color: '#475569' }}>
									Email: {selectedDoctorForReview.email}
								</Typography>
								<Typography variant='body2' sx={{ color: '#475569' }}>
									Phone: {selectedDoctorForReview.phoneNo1}
								</Typography>
								<Typography variant='caption' sx={{ color: '#0284c7', fontFamily: 'monospace', display: 'block', mt: 0.5 }}>
									User ID: {selectedDoctorForReview._id}
								</Typography>
							</Paper>

							<Box>
								<Typography variant='caption' sx={{ fontWeight: 700, color: '#64748b', textTransform: 'uppercase' }}>
									Professional Credentials
								</Typography>
								<Typography variant='body2' sx={{ fontWeight: 600, color: '#1e293b' }}>
									Registration No: <strong>{selectedDoctorForReview.medicalRegistrationNumber}</strong>
								</Typography>
								<Typography variant='body2' sx={{ color: '#334155' }}>
									Council: {selectedDoctorForReview.medicalCouncil} ({selectedDoctorForReview.registrationState})
								</Typography>
								{selectedDoctorForReview.supportingEvidence && (
									<Typography variant='body2' sx={{ color: '#059669', mt: 0.5 }}>
										Evidence / Document: {selectedDoctorForReview.supportingEvidence}
									</Typography>
								)}
								{selectedDoctorForReview.nominatedByHospital && (
									<Typography variant='body2' sx={{ color: '#64748b', mt: 0.5 }}>
										Nominated by: {selectedDoctorForReview.nominatedByHospital.hospitalName} ({selectedDoctorForReview.nominatedByHospital.hospitalCode})
									</Typography>
								)}
							</Box>

							<Divider />

							<Box>
								<Typography variant='subtitle2' sx={{ fontWeight: 700, color: '#1e293b', mb: 1 }}>
									Administrative Determination
								</Typography>
								<TextField
									fullWidth
									select
									size='small'
									label='Account Verification Status'
									value={reviewStatus}
									onChange={(e) => setReviewStatus(e.target.value)}
									sx={{ mb: 2 }}
								>
									<MenuItem value='Verified'>Verified (Approve & Accredit)</MenuItem>
									<MenuItem value='Pending'>Pending (Keep in Review)</MenuItem>
									<MenuItem value='Rejected'>Rejected (Deny Accreditation)</MenuItem>
									<MenuItem value='Suspended'>Suspended (Temporarily Revoke)</MenuItem>
								</TextField>

								{reviewStatus === 'Rejected' && (
									<TextField
										fullWidth
										size='small'
										multiline
										rows={2}
										required
										label='Rejection Reason (Mandatory)'
										placeholder='State specific clinical or credential verification failure...'
										value={reviewRejectionReason}
										onChange={(e) => setReviewRejectionReason(e.target.value)}
										sx={{ mb: 2 }}
									/>
								)}

								{reviewStatus === 'Verified' && (
									<FormControlLabel
										control={
											<Checkbox
												checked={reviewIsActive}
												onChange={(e) => setReviewIsActive(e.target.checked)}
												color='success'
											/>
										}
										label={<Typography variant='body2' sx={{ fontWeight: 600 }}>Activate account for clinical verification operations</Typography>}
									/>
								)}
							</Box>
						</Box>
					)}
				</DialogContent>
				<DialogActions sx={{ p: 2 }}>
					<Button onClick={handleCloseReview} sx={{ textTransform: 'none', fontWeight: 600 }}>
						Cancel
					</Button>
					<Button
						variant='contained'
						onClick={handleSaveReview}
						disabled={moDirActionLoading}
						color={reviewStatus === 'Verified' ? 'success' : reviewStatus === 'Rejected' ? 'error' : 'primary'}
						startIcon={reviewStatus === 'Verified' ? <CheckCircleIcon /> : reviewStatus === 'Rejected' ? <CancelIcon /> : <PendingActionsIcon />}
						sx={{ textTransform: 'none', fontWeight: 700, px: 3 }}
					>
						{moDirActionLoading ? 'Saving...' : `Apply Status (${reviewStatus})`}
					</Button>
				</DialogActions>
			</Dialog>

			{/* DIALOG 3: EDIT ASSOCIATION STATUS & PERMISSIONS */}
			<Dialog open={editDialogOpen} onClose={handleCloseEdit} maxWidth='sm' fullWidth>
				<DialogTitle sx={{ fontWeight: 800, color: '#1e293b' }}>
					Update Medical Officer Association
				</DialogTitle>
				<DialogContent dividers>
					{activeAssociation && (
						<Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
							<Paper elevation={0} sx={{ p: 2, backgroundColor: '#f8fafc', borderRadius: 2, border: '1px solid #e2e8f0' }}>
								<Typography variant='subtitle1' sx={{ fontWeight: 700, color: '#0f172a' }}>
									Dr. {activeAssociation.medicalOfficerUserId?.firstName}{' '}
									{activeAssociation.medicalOfficerUserId?.lastName}
								</Typography>
								<Typography variant='body2' sx={{ color: '#475569' }}>
									Hospital: {activeAssociation.hospitalId?.hospitalName} (
									{activeAssociation.hospitalId?.hospitalCode})
								</Typography>
							</Paper>

							<Box>
								<TextField
									fullWidth
									select
									size='small'
									label='Association Lifecycle Status'
									value={editStatus}
									onChange={(e) => setEditStatus(e.target.value)}
									sx={{ mb: 2 }}
								>
									{VALID_STATUSES.map((st) => (
										<MenuItem key={st} value={st}>
											{st}
										</MenuItem>
									))}
								</TextField>

								<TextField
									fullWidth
									size='small'
									type='date'
									label='Expires At'
									value={editExpiresAt}
									onChange={(e) => setEditExpiresAt(e.target.value)}
									InputLabelProps={{ shrink: true }}
									helperText='Leave blank for indefinite validity period'
									sx={{ mb: 2 }}
								/>

								<Typography variant='caption' sx={{ fontWeight: 700, color: '#475569', display: 'block', mb: 0.5 }}>
									Explicit Permissions
								</Typography>
								<FormGroup>
									<FormControlLabel
										control={
											<Checkbox
												size='small'
												checked={editPermissions.includes('VIEW_EMERGENCY_REQUESTS')}
												onChange={(e) => {
													if (e.target.checked) {
														setEditPermissions([...editPermissions, 'VIEW_EMERGENCY_REQUESTS'])
													} else {
														setEditPermissions(
															editPermissions.filter((p) => p !== 'VIEW_EMERGENCY_REQUESTS')
														)
													}
												}}
											/>
										}
										label={<Typography variant='body2'>VIEW_EMERGENCY_REQUESTS</Typography>}
									/>
									<FormControlLabel
										control={
											<Checkbox
												size='small'
												checked={editPermissions.includes('VERIFY_EMERGENCY_REQUESTS')}
												onChange={(e) => {
													if (e.target.checked) {
														setEditPermissions([...editPermissions, 'VERIFY_EMERGENCY_REQUESTS'])
													} else {
														setEditPermissions(
															editPermissions.filter((p) => p !== 'VERIFY_EMERGENCY_REQUESTS')
														)
													}
												}}
											/>
										}
										label={<Typography variant='body2'>VERIFY_EMERGENCY_REQUESTS</Typography>}
									/>
								</FormGroup>
							</Box>
						</Box>
					)}
				</DialogContent>
				<DialogActions sx={{ p: 2 }}>
					<Button onClick={handleCloseEdit} sx={{ textTransform: 'none', fontWeight: 600 }}>
						Cancel
					</Button>
					<Button
						variant='contained'
						onClick={handleSaveEdit}
						disabled={assocActionLoading || editPermissions.length === 0}
						sx={{
							backgroundColor: '#16a34a',
							fontWeight: 700,
							textTransform: 'none',
							'&:hover': { backgroundColor: '#15803d' },
						}}
					>
						{assocActionLoading ? 'Saving...' : 'Save Updates'}
					</Button>
				</DialogActions>
			</Dialog>
		</Container>
	)
}

export default MedicalOfficerManagement
