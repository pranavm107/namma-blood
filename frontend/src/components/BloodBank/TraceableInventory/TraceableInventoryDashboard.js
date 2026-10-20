import React, { useEffect, useState, useCallback } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import {
	Box,
	Button,
	Card,
	Chip,
	Container,
	Dialog,
	DialogActions,
	DialogContent,
	DialogTitle,
	Divider,
	FormControl,
	Grid,
	IconButton,
	InputLabel,
	MenuItem,
	Pagination,
	Paper,
	Select,
	Table,
	TableBody,
	TableCell,
	TableContainer,
	TableHead,
	TableRow,
	TextField,
	Tooltip,
	Typography,
	Alert,
	CircularProgress,
} from '@mui/material'
import SearchIcon from '@mui/icons-material/Search'
import RefreshIcon from '@mui/icons-material/Refresh'
import VisibilityIcon from '@mui/icons-material/Visibility'
import BiotechIcon from '@mui/icons-material/Biotech'
import VerifiedUserIcon from '@mui/icons-material/VerifiedUser'
import DeleteForeverIcon from '@mui/icons-material/DeleteForever'
import LocalShippingIcon from '@mui/icons-material/LocalShipping'
import CompareArrowsIcon from '@mui/icons-material/CompareArrows'
import WarningAmberIcon from '@mui/icons-material/WarningAmber'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty'
import { toast } from 'react-toastify'

import {
	fetchBloodUnits,
	fetchBloodUnitById,
	recordScreeningResults,
	verifyMedicalClearance,
	recordCrossmatch,
	dispatchUnits,
	discardBloodUnit,
	clearUnitError,
	clearUnitSuccessMessage,
} from '../../../store/bloodUnitSlice'
import { getBloodStock } from '../../../store/stockSlice'

const VALID_BLOOD_GROUPS = [
	'All',
	'A_Positive',
	'A_Negative',
	'B_Positive',
	'B_Negative',
	'AB_Positive',
	'AB_Negative',
	'O_Positive',
	'O_Negative',
]

const VALID_COMPONENTS = [
	'All',
	'Whole_Blood',
	'Packed_Red_Blood_Cells',
	'Platelet_Concentrate',
	'Fresh_Frozen_Plasma',
	'Cryoprecipitate',
]

const VALID_STATUSES = [
	'All',
	'Quarantined',
	'Tested_Passed',
	'Available',
	'Reserved',
	'Issued',
	'Expired',
	'Discarded',
]

const DISCARD_REASONS = [
	'TTI_Reactive',
	'Expired',
	'Hemolysis',
	'Bag_Leakage',
	'Clotted',
	'Temperature_Excursion',
	'Other',
]

const formatBloodGroup = (bg) => {
	if (!bg) return '-'
	return bg.replace('_Positive', '+').replace('_Negative', '-')
}

const formatComponent = (c) => {
	if (!c) return '-'
	return c.replace(/_/g, ' ')
}

const getStatusColor = (status) => {
	switch (status) {
		case 'Available':
			return { bg: '#ecfdf5', text: '#065f46', border: '#a7f3d0' }
		case 'Quarantined':
			return { bg: '#fffbeb', text: '#92400e', border: '#fde68a' }
		case 'Tested_Passed':
			return { bg: '#eff6ff', text: '#1e40af', border: '#bfdbfe' }
		case 'Reserved':
			return { bg: '#f5f3ff', text: '#5b21b6', border: '#ddd6fe' }
		case 'Issued':
			return { bg: '#eef2ff', text: '#3730a3', border: '#c7d2fe' }
		case 'Expired':
			return { bg: '#f1f5f9', text: '#475569', border: '#cbd5e1' }
		case 'Discarded':
			return { bg: '#fef2f2', text: '#991b1b', border: '#fecaca' }
		default:
			return { bg: '#f8fafc', text: '#64748b', border: '#e2e8f0' }
	}
}

const getTestBadge = (result) => {
	if (result === 'Non_Reactive') {
		return <Chip label='Pass' size='small' sx={{ bgcolor: '#ecfdf5', color: '#065f46', fontWeight: 700, fontSize: '0.65rem', height: 20 }} />
	}
	if (result === 'Reactive') {
		return <Chip label='REACTIVE' size='small' sx={{ bgcolor: '#fef2f2', color: '#991b1b', fontWeight: 800, fontSize: '0.65rem', height: 20 }} />
	}
	return <Chip label='Pending' size='small' sx={{ bgcolor: '#f8fafc', color: '#64748b', fontWeight: 600, fontSize: '0.65rem', height: 20 }} />
}

const TraceableInventoryDashboard = () => {
	const dispatch = useDispatch()
	const { units, total, page, limit, totalPages, selectedUnit, isLoading, isDetailLoading, isActionSubmitting, error, actionSuccessMessage } = useSelector(
		(state) => state?.bloodUnit || {}
	)
	const { stock } = useSelector((state) => state?.stock || {})
	const loginState = useSelector((state) => state?.login || {})

	// Staff / Actor role derivation
	const staffRole = loginState?.user?.staffRole || loginState?.user?.role || ''
	const isMedicalOfficer = staffRole === 'Medical_Officer' || loginState?.role === 'BLOODBANK'

	// Filters
	const [search, setSearch] = useState('')
	const [bloodGroup, setBloodGroup] = useState('All')
	const [componentType, setComponentType] = useState('All')
	const [status, setStatus] = useState('All')
	const [screeningStatus, setScreeningStatus] = useState('All')
	const [isExpiredFilter, setIsExpiredFilter] = useState('')

	// Modals
	const [detailOpen, setDetailOpen] = useState(false)
	const [screeningModalOpen, setScreeningModalOpen] = useState(false)
	const [clearanceModalOpen, setClearanceModalOpen] = useState(false)
	const [discardModalOpen, setDiscardModalOpen] = useState(false)
	const [dispatchModalOpen, setDispatchModalOpen] = useState(false)
	const [crossmatchModalOpen, setCrossmatchModalOpen] = useState(false)
	const [activeUnit, setActiveUnit] = useState(null)

	// Action Form States
	const [screeningData, setScreeningData] = useState({
		hiv: 'Non_Reactive',
		hbv: 'Non_Reactive',
		hcv: 'Non_Reactive',
		syphilis: 'Non_Reactive',
		malaria: 'Non_Reactive',
		testBatchId: '',
		notes: '',
	})

	const [clearanceNotes, setClearanceNotes] = useState('')
	const [discardData, setDiscardData] = useState({
		reason: 'TTI_Reactive',
		wasteManifestNumber: '',
		notes: '',
	})
	const [dispatchData, setDispatchData] = useState({
		dispatchedToRecipient: '',
		transportBoxId: '',
		dispatchNotes: '',
	})
	const [crossmatchData, setCrossmatchData] = useState({
		result: 'Compatible',
		notes: '',
	})

	const loadData = useCallback(() => {
		dispatch(
			fetchBloodUnits({
				search,
				bloodGroup,
				status,
				componentType,
				screeningStatus,
				isExpired: isExpiredFilter,
				page,
				limit,
			})
		)
		dispatch(getBloodStock())
	}, [dispatch, search, bloodGroup, status, componentType, screeningStatus, isExpiredFilter, page, limit])

	useEffect(() => {
		loadData()
	}, [loadData])

	useEffect(() => {
		if (actionSuccessMessage) {
			toast.success(actionSuccessMessage)
			dispatch(clearUnitSuccessMessage())
			loadData()
		}
		if (error) {
			toast.error(error)
			dispatch(clearUnitError())
		}
	}, [actionSuccessMessage, error, dispatch, loadData])

	// Handlers for Modals
	const handleOpenDetail = (unit) => {
		setActiveUnit(unit)
		dispatch(fetchBloodUnitById(unit._id))
		setDetailOpen(true)
	}

	const handleOpenScreening = (unit) => {
		setActiveUnit(unit)
		setScreeningData({
			hiv: unit?.testing?.hiv === 'Reactive' ? 'Reactive' : 'Non_Reactive',
			hbv: unit?.testing?.hbv === 'Reactive' ? 'Reactive' : 'Non_Reactive',
			hcv: unit?.testing?.hcv === 'Reactive' ? 'Reactive' : 'Non_Reactive',
			syphilis: unit?.testing?.syphilis === 'Reactive' ? 'Reactive' : 'Non_Reactive',
			malaria: unit?.testing?.malaria === 'Reactive' ? 'Reactive' : 'Non_Reactive',
			testBatchId: unit?.testing?.testBatchId || `BATCH-${Date.now().toString().slice(-6)}`,
			notes: '',
		})
		setScreeningModalOpen(true)
	}

	const handleSubmitScreening = async () => {
		if (!screeningData.testBatchId.trim()) {
			toast.error('Test batch ID is required.')
			return
		}
		const res = await dispatch(
			recordScreeningResults({
				unitId: activeUnit._id,
				tests: {
					hiv: screeningData.hiv,
					hbv: screeningData.hbv,
					hcv: screeningData.hcv,
					syphilis: screeningData.syphilis,
					malaria: screeningData.malaria,
				},
				testBatchId: screeningData.testBatchId.trim(),
				notes: screeningData.notes,
			})
		)
		if (res?.meta?.requestStatus === 'fulfilled') {
			setScreeningModalOpen(false)
		}
	}

	const handleOpenClearance = (unit) => {
		setActiveUnit(unit)
		setClearanceNotes('')
		setClearanceModalOpen(true)
	}

	const handleSubmitClearance = async () => {
		const res = await dispatch(
			verifyMedicalClearance({
				unitId: activeUnit._id,
				notes: clearanceNotes.trim(),
			})
		)
		if (res?.meta?.requestStatus === 'fulfilled') {
			setClearanceModalOpen(false)
		}
	}

	const handleOpenDiscard = (unit) => {
		setActiveUnit(unit)
		setDiscardData({
			reason: unit.status === 'Expired' ? 'Expired' : 'TTI_Reactive',
			wasteManifestNumber: '',
			notes: '',
		})
		setDiscardModalOpen(true)
	}

	const handleSubmitDiscard = async () => {
		if (!discardData.reason) {
			toast.error('Clinical discard reason is required.')
			return
		}
		const res = await dispatch(
			discardBloodUnit({
				unitIds: [activeUnit._id],
				reason: discardData.reason,
				wasteManifestNumber: discardData.wasteManifestNumber.trim(),
				notes: discardData.notes.trim(),
			})
		)
		if (res?.meta?.requestStatus === 'fulfilled') {
			setDiscardModalOpen(false)
		}
	}

	const handleOpenDispatch = (unit) => {
		setActiveUnit(unit)
		setDispatchData({
			dispatchedToRecipient: unit.issuance?.recipientPatientName || '',
			transportBoxId: '',
			dispatchNotes: '',
		})
		setDispatchModalOpen(true)
	}

	const handleSubmitDispatch = async () => {
		const res = await dispatch(
			dispatchUnits({
				unitIds: [activeUnit._id],
				dispatchedToRecipient: dispatchData.dispatchedToRecipient.trim(),
				transportBoxId: dispatchData.transportBoxId.trim(),
				dispatchNotes: dispatchData.dispatchNotes.trim(),
			})
		)
		if (res?.meta?.requestStatus === 'fulfilled') {
			setDispatchModalOpen(false)
		}
	}

	const handleOpenCrossmatch = (unit) => {
		setActiveUnit(unit)
		setCrossmatchData({
			result: 'Compatible',
			notes: '',
		})
		setCrossmatchModalOpen(true)
	}

	const handleSubmitCrossmatch = async () => {
		const res = await dispatch(
			recordCrossmatch({
				unitId: activeUnit._id,
				crossmatchResult: crossmatchData.result,
				notes: crossmatchData.notes.trim(),
			})
		)
		if (res?.meta?.requestStatus === 'fulfilled') {
			setCrossmatchModalOpen(false)
		}
	}

	// Status breakdown counts
	const breakdown = stock?.traceableStatusBreakdown || {
		Quarantined: 0,
		Tested_Passed: 0,
		Available: 0,
		Reserved: 0,
		Issued: 0,
		Discarded: 0,
		Expired: 0,
		totalUnits: 0,
	}

	return (
		<Container maxWidth='xl' sx={{ pb: 8, pt: 2 }}>
			{/* Top Hero Banner */}
			<Paper
				elevation={0}
				sx={{
					p: { xs: 2.5, md: 3.5 },
					mb: 3,
					borderRadius: 3,
					background: 'linear-gradient(135deg, #ffffff 0%, #f8fafc 100%)',
					border: '1px solid #e2e8f0',
				}}
			>
				<Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
					<Box>
						<Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
							<Chip
								label='TRACEABLE INVENTORY MANAGEMENT'
								sx={{
									backgroundColor: '#eff6ff',
									color: '#1d4ed8',
									fontWeight: 700,
									fontSize: '0.75rem',
									letterSpacing: '0.08em',
								}}
							/>
							{stock?.inventoryClassification === 'HYBRID_TRANSITIONAL' && (
								<Chip
									label='HYBRID / TRANSITIONAL'
									sx={{ backgroundColor: '#fffbeb', color: '#b45309', fontWeight: 700, fontSize: '0.75rem' }}
								/>
							)}
						</Box>
						<Typography variant='h4' component='h1' sx={{ fontWeight: 800, color: '#1e293b' }}>
							Blood Unit Inventory & Lifecycle Console
						</Typography>
						<Typography variant='body2' sx={{ color: '#64748b', mt: 0.5 }}>
							Track individual donation identification numbers (DIN), laboratory screening panels, Medical Officer clearance, and cold-chain dispatches.
						</Typography>
					</Box>

					<Box sx={{ display: 'flex', gap: 1.5 }}>
						<Button
							variant='outlined'
							startIcon={<RefreshIcon />}
							onClick={loadData}
							disabled={isLoading}
							sx={{ borderRadius: 2 }}
						>
							Refresh
						</Button>
					</Box>
				</Box>

				{/* Regulatory Notice Banner if Legacy stock is active */}
				{stock?.legacyNotice && (
					<Alert severity='warning' icon={<WarningAmberIcon />} sx={{ mt: 2.5, borderRadius: 2 }}>
						<Typography variant='body2' sx={{ fontWeight: 600 }}>
							{stock.legacyNotice}
						</Typography>
					</Alert>
				)}
			</Paper>

			{/* Lifecycle Status Summary Counters */}
			<Grid container spacing={2} sx={{ mb: 3 }}>
				{[
					{ label: 'Available (Issue-Eligible)', count: breakdown.Available, color: '#059669', bg: '#ecfdf5', border: '#a7f3d0' },
					{ label: 'Quarantined (Untested)', count: breakdown.Quarantined, color: '#d97706', bg: '#fffbeb', border: '#fde68a' },
					{ label: 'Tested Passed (Awaiting MO)', count: breakdown.Tested_Passed, color: '#2563eb', bg: '#eff6ff', border: '#bfdbfe' },
					{ label: 'Reserved (Patient Hold)', count: breakdown.Reserved, color: '#7c3aed', bg: '#f5f3ff', border: '#ddd6fe' },
					{ label: 'Issued (Fulfillment)', count: breakdown.Issued, color: '#4f46e5', bg: '#eef2ff', border: '#c7d2fe' },
					{ label: 'Expired (Biohazard)', count: breakdown.Expired, color: '#475569', bg: '#f1f5f9', border: '#cbd5e1' },
					{ label: 'Discarded (Waste)', count: breakdown.Discarded, color: '#dc2626', bg: '#fef2f2', border: '#fecaca' },
				].map((stat, i) => (
					<Grid item xs={6} sm={4} md={3} lg={1.71} key={i}>
						<Card
							elevation={0}
							sx={{
								p: 1.5,
								borderRadius: 2.5,
								backgroundColor: stat.bg,
								border: `1px solid ${stat.border}`,
								textAlign: 'center',
								height: '100%',
								display: 'flex',
								flexDirection: 'column',
								justifyContent: 'center',
							}}
						>
							<Typography variant='caption' sx={{ color: '#475569', fontWeight: 700, fontSize: '0.72rem', textTransform: 'uppercase' }}>
								{stat.label}
							</Typography>
							<Typography variant='h5' sx={{ color: stat.color, fontWeight: 900, mt: 0.5 }}>
								{stat.count || 0}
							</Typography>
						</Card>
					</Grid>
				))}
			</Grid>

			{/* Filter & Search Bar */}
			<Paper elevation={0} sx={{ p: 2.5, mb: 3, borderRadius: 2.5, border: '1px solid #e2e8f0', bgcolor: '#ffffff' }}>
				<Grid container spacing={2} alignItems='center'>
					<Grid item xs={12} sm={6} md={3}>
						<TextField
							fullWidth
							size='small'
							placeholder='Search DIN / Barcode...'
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							InputProps={{
								startAdornment: <SearchIcon sx={{ color: '#94a3b8', mr: 1, fontSize: 20 }} />,
							}}
						/>
					</Grid>

					<Grid item xs={6} sm={3} md={2}>
						<FormControl fullWidth size='small'>
							<InputLabel>Blood Group</InputLabel>
							<Select value={bloodGroup} label='Blood Group' onChange={(e) => setBloodGroup(e.target.value)}>
								{VALID_BLOOD_GROUPS.map((bg) => (
									<MenuItem key={bg} value={bg}>
										{bg === 'All' ? 'All Groups' : formatBloodGroup(bg)}
									</MenuItem>
								))}
							</Select>
						</FormControl>
					</Grid>

					<Grid item xs={6} sm={3} md={2}>
						<FormControl fullWidth size='small'>
							<InputLabel>Component</InputLabel>
							<Select value={componentType} label='Component' onChange={(e) => setComponentType(e.target.value)}>
								{VALID_COMPONENTS.map((c) => (
									<MenuItem key={c} value={c}>
										{c === 'All' ? 'All Components' : formatComponent(c)}
									</MenuItem>
								))}
							</Select>
						</FormControl>
					</Grid>

					<Grid item xs={6} sm={3} md={2}>
						<FormControl fullWidth size='small'>
							<InputLabel>Status</InputLabel>
							<Select value={status} label='Status' onChange={(e) => setStatus(e.target.value)}>
								{VALID_STATUSES.map((s) => (
									<MenuItem key={s} value={s}>
										{s === 'All' ? 'All Statuses' : s}
									</MenuItem>
								))}
							</Select>
						</FormControl>
					</Grid>

					<Grid item xs={6} sm={3} md={1.5}>
						<FormControl fullWidth size='small'>
							<InputLabel>Screening</InputLabel>
							<Select value={screeningStatus} label='Screening' onChange={(e) => setScreeningStatus(e.target.value)}>
								<MenuItem value='All'>All</MenuItem>
								<MenuItem value='Pending'>Pending</MenuItem>
								<MenuItem value='Non_Reactive'>Non-Reactive</MenuItem>
								<MenuItem value='Reactive'>Reactive</MenuItem>
							</Select>
						</FormControl>
					</Grid>

					<Grid item xs={12} sm={3} md={1.5}>
						<FormControl fullWidth size='small'>
							<InputLabel>Expiry</InputLabel>
							<Select value={isExpiredFilter} label='Expiry' onChange={(e) => setIsExpiredFilter(e.target.value)}>
								<MenuItem value=''>All Shelf</MenuItem>
								<MenuItem value='false'>Active</MenuItem>
								<MenuItem value='true'>Expired</MenuItem>
							</Select>
						</FormControl>
					</Grid>
				</Grid>
			</Paper>

			{/* Traceable Units Data Table */}
			<TableContainer component={Paper} elevation={0} sx={{ borderRadius: 3, border: '1px solid #e2e8f0', overflow: 'hidden' }}>
				<Table sx={{ minWidth: 900 }}>
					<TableHead sx={{ bgcolor: '#f8fafc' }}>
						<TableRow>
							<TableCell sx={{ fontWeight: 700, color: '#475569' }}>DIN / Barcode</TableCell>
							<TableCell sx={{ fontWeight: 700, color: '#475569' }}>Group</TableCell>
							<TableCell sx={{ fontWeight: 700, color: '#475569' }}>Component / Volume</TableCell>
							<TableCell sx={{ fontWeight: 700, color: '#475569' }}>Lifecycle Status</TableCell>
							<TableCell sx={{ fontWeight: 700, color: '#475569' }}>TTI Screening (5 Panel)</TableCell>
							<TableCell sx={{ fontWeight: 700, color: '#475569' }}>Clearance</TableCell>
							<TableCell sx={{ fontWeight: 700, color: '#475569' }}>Expiry Date</TableCell>
							<TableCell align='right' sx={{ fontWeight: 700, color: '#475569' }}>Actions</TableCell>
						</TableRow>
					</TableHead>

					<TableBody>
						{isLoading ? (
							<TableRow>
								<TableCell colSpan={8} align='center' sx={{ py: 6 }}>
									<CircularProgress size={36} sx={{ color: '#c62828', mb: 1 }} />
									<Typography variant='body2' sx={{ color: '#64748b' }}>
										Loading traceable blood inventory...
									</Typography>
								</TableCell>
							</TableRow>
						) : units?.length === 0 ? (
							<TableRow>
								<TableCell colSpan={8} align='center' sx={{ py: 8 }}>
									<HourglassEmptyIcon sx={{ fontSize: 48, color: '#cbd5e1', mb: 1 }} />
									<Typography variant='h6' sx={{ color: '#475569', fontWeight: 700 }}>
										No blood units match criteria
									</Typography>
									<Typography variant='body2' sx={{ color: '#94a3b8' }}>
										Try adjusting filters or intake new donation units.
									</Typography>
								</TableCell>
							</TableRow>
						) : (
							units.map((unit) => {
								const sColor = getStatusColor(unit.status)
								const isExpired = unit.expiryDate && new Date(unit.expiryDate) <= new Date()
								const canScreen = unit.status === 'Quarantined' || unit.status === 'Tested_Passed'
								const canClear = isMedicalOfficer && unit.status === 'Tested_Passed' && !unit.clearance?.isVerified
								const canCrossmatch = unit.status === 'Reserved'
								const canDispatch = unit.status === 'Issued' && !unit.issuance?.dispatch?.isDispatched
								const canDiscard = ['Quarantined', 'Tested_Passed', 'Available', 'Reserved', 'Expired'].includes(unit.status)

								return (
									<TableRow key={unit._id} hover sx={{ '&:last-child td, &:last-child th': { border: 0 } }}>
										{/* DIN */}
										<TableCell>
											<Typography variant='body2' sx={{ fontWeight: 800, color: '#1e293b', letterSpacing: '0.04em' }}>
												{unit.unitNumber}
											</Typography>
											{unit.isLegacyMigrated && (
												<Chip
													label='LEGACY MIGRATED'
													size='small'
													sx={{ fontSize: '0.6rem', height: 16, bgcolor: '#fef3c7', color: '#92400e', fontWeight: 800 }}
												/>
											)}
										</TableCell>

										{/* Blood Group */}
										<TableCell>
											<Chip
												label={formatBloodGroup(unit.bloodGroup)}
												sx={{
													fontWeight: 900,
													fontSize: '0.85rem',
													bgcolor: unit.bloodGroup.includes('Negative') ? '#fee2e2' : '#fef2f2',
													color: '#b91c1c',
												}}
											/>
										</TableCell>

										{/* Component & Volume */}
										<TableCell>
											<Typography variant='body2' sx={{ fontWeight: 600, color: '#334155' }}>
												{formatComponent(unit.componentType)}
											</Typography>
											<Typography variant='caption' sx={{ color: '#64748b' }}>
												{unit.volumeMl} mL
											</Typography>
										</TableCell>

										{/* Status */}
										<TableCell>
											<Chip
												label={unit.status}
												sx={{
													bgcolor: sColor.bg,
													color: sColor.text,
													border: `1px solid ${sColor.border}`,
													fontWeight: 800,
													fontSize: '0.75rem',
												}}
											/>
										</TableCell>

										{/* 5-Panel TTI Results */}
										<TableCell>
											<Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
												<Box sx={{ display: 'flex', gap: 0.5 }}>
													<Tooltip title='HIV 1 & 2'>{getTestBadge(unit.testing?.hiv)}</Tooltip>
													<Tooltip title='Hepatitis B'>{getTestBadge(unit.testing?.hbv)}</Tooltip>
													<Tooltip title='Hepatitis C'>{getTestBadge(unit.testing?.hcv)}</Tooltip>
												</Box>
												<Box sx={{ display: 'flex', gap: 0.5 }}>
													<Tooltip title='Syphilis'>{getTestBadge(unit.testing?.syphilis)}</Tooltip>
													<Tooltip title='Malaria'>{getTestBadge(unit.testing?.malaria)}</Tooltip>
												</Box>
											</Box>
										</TableCell>

										{/* Medical Officer Clearance */}
										<TableCell>
											{unit.clearance?.isVerified ? (
												<Chip
													icon={<CheckCircleIcon sx={{ fontSize: '14px !important', color: '#059669 !important' }} />}
													label='Verified'
													size='small'
													sx={{ bgcolor: '#ecfdf5', color: '#065f46', fontWeight: 700 }}
												/>
											) : (
												<Chip
													label='Unverified'
													size='small'
													sx={{ bgcolor: '#fffbeb', color: '#b45309', fontWeight: 600 }}
												/>
											)}
										</TableCell>

										{/* Expiry Date */}
										<TableCell>
											<Typography
												variant='body2'
												sx={{
													fontWeight: isExpired ? 800 : 500,
													color: isExpired ? '#dc2626' : '#334155',
												}}
											>
												{unit.expiryDate ? new Date(unit.expiryDate).toLocaleDateString() : '-'}
											</Typography>
											{isExpired && (
												<Chip
													label='EXPIRED'
													size='small'
													sx={{ height: 18, fontSize: '0.62rem', bgcolor: '#fee2e2', color: '#991b1b', fontWeight: 800 }}
												/>
											)}
										</TableCell>

										{/* Action Buttons */}
										<TableCell align='right'>
											<Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 0.5 }}>
												{/* View Details */}
												<Tooltip title='View Full Details & Audit Trail'>
													<IconButton size='small' onClick={() => handleOpenDetail(unit)} sx={{ color: '#0284c7' }}>
														<VisibilityIcon fontSize='small' />
													</IconButton>
												</Tooltip>

												{/* Record Screening */}
												{canScreen && (
													<Tooltip title='Record Laboratory Screening Results'>
														<IconButton size='small' onClick={() => handleOpenScreening(unit)} sx={{ color: '#2563eb' }}>
															<BiotechIcon fontSize='small' />
														</IconButton>
													</Tooltip>
												)}

												{/* Medical Officer Clearance */}
												{canClear && (
													<Tooltip title='Medical Officer Quality Clearance'>
														<IconButton size='small' onClick={() => handleOpenClearance(unit)} sx={{ color: '#059669' }}>
															<VerifiedUserIcon fontSize='small' />
														</IconButton>
													</Tooltip>
												)}

												{/* Crossmatch Compatibility */}
												{canCrossmatch && (
													<Tooltip title='Record Pre-Issuance Crossmatch'>
														<IconButton size='small' onClick={() => handleOpenCrossmatch(unit)} sx={{ color: '#7c3aed' }}>
															<CompareArrowsIcon fontSize='small' />
														</IconButton>
													</Tooltip>
												)}

												{/* Physical Dispatch */}
												{canDispatch && (
													<Tooltip title='Execute Physical Dispatch'>
														<IconButton size='small' onClick={() => handleOpenDispatch(unit)} sx={{ color: '#4f46e5' }}>
															<LocalShippingIcon fontSize='small' />
														</IconButton>
													</Tooltip>
												)}

												{/* Clinical / Biohazard Discard */}
												{canDiscard && (
													<Tooltip title='Authorize Discard'>
														<IconButton size='small' onClick={() => handleOpenDiscard(unit)} sx={{ color: '#dc2626' }}>
															<DeleteForeverIcon fontSize='small' />
														</IconButton>
													</Tooltip>
												)}
											</Box>
										</TableCell>
									</TableRow>
								)
							})
						)}
					</TableBody>
				</Table>

				{/* Pagination Controls */}
				<Box sx={{ p: 2, display: 'flex', justifyContent: 'space-between', alignItems: 'center', bgcolor: '#ffffff' }}>
					<Typography variant='caption' sx={{ color: '#64748b' }}>
						Showing {units?.length || 0} of {total || 0} blood units
					</Typography>
					<Pagination
						count={totalPages}
						page={page}
						onChange={(e, p) => dispatch(fetchBloodUnits({ search, bloodGroup, status, componentType, screeningStatus, isExpired: isExpiredFilter, page: p, limit }))}
						color='primary'
						shape='rounded'
					/>
				</Box>
			</TableContainer>

			{/* ========================================================= */}
			{/* 1. Unit Detail & Audit Trail Modal */}
			{/* ========================================================= */}
			<Dialog open={detailOpen} onClose={() => setDetailOpen(false)} maxWidth='md' fullWidth>
				<DialogTitle sx={{ fontWeight: 800, color: '#1e293b' }}>
					Unit Traceability Dossier: {selectedUnit?.unitNumber || activeUnit?.unitNumber}
				</DialogTitle>
				<DialogContent dividers>
					{isDetailLoading ? (
						<Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
							<CircularProgress size={32} />
						</Box>
					) : (
						<Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
							{/* Unit Key Specs */}
							<Grid container spacing={2}>
								<Grid item xs={6} sm={3}>
									<Typography variant='caption' sx={{ color: '#64748b' }}>Blood Group</Typography>
									<Typography variant='body1' sx={{ fontWeight: 800, color: '#b91c1c' }}>
										{formatBloodGroup(selectedUnit?.bloodGroup)}
									</Typography>
								</Grid>
								<Grid item xs={6} sm={3}>
									<Typography variant='caption' sx={{ color: '#64748b' }}>Component Fraction</Typography>
									<Typography variant='body1' sx={{ fontWeight: 600 }}>
										{formatComponent(selectedUnit?.componentType)}
									</Typography>
								</Grid>
								<Grid item xs={6} sm={3}>
									<Typography variant='caption' sx={{ color: '#64748b' }}>Status</Typography>
									<Typography variant='body1' sx={{ fontWeight: 700 }}>
										{selectedUnit?.status}
									</Typography>
								</Grid>
								<Grid item xs={6} sm={3}>
									<Typography variant='caption' sx={{ color: '#64748b' }}>Issue-Eligible?</Typography>
									<Typography variant='body1' sx={{ fontWeight: 800, color: selectedUnit?.isIssueEligible ? '#059669' : '#dc2626' }}>
										{selectedUnit?.isIssueEligible ? 'YES (Available)' : 'NO (Unverified / Locked)'}
									</Typography>
								</Grid>

								<Grid item xs={6} sm={3}>
									<Typography variant='caption' sx={{ color: '#64748b' }}>Collection Date</Typography>
									<Typography variant='body2'>
										{selectedUnit?.collectionDate ? new Date(selectedUnit.collectionDate).toLocaleString() : '-'}
									</Typography>
								</Grid>
								<Grid item xs={6} sm={3}>
									<Typography variant='caption' sx={{ color: '#64748b' }}>Expiry Date</Typography>
									<Typography variant='body2' sx={{ fontWeight: 700 }}>
										{selectedUnit?.expiryDate ? new Date(selectedUnit.expiryDate).toLocaleString() : '-'}
									</Typography>
								</Grid>
								<Grid item xs={6} sm={3}>
									<Typography variant='caption' sx={{ color: '#64748b' }}>Storage Coordinates</Typography>
									<Typography variant='body2'>
										Ref: {selectedUnit?.storageLocation?.refrigeratorId || 'Main'} | Shelf: {selectedUnit?.storageLocation?.shelfNumber || '-'}
									</Typography>
								</Grid>
								<Grid item xs={6} sm={3}>
									<Typography variant='caption' sx={{ color: '#64748b' }}>Legacy Ingested?</Typography>
									<Typography variant='body2' sx={{ fontWeight: 600 }}>
										{selectedUnit?.isLegacyMigrated ? 'Yes (Shelf Migration)' : 'No (Standard Intake)'}
									</Typography>
								</Grid>
							</Grid>

							<Divider />

							{/* TTI Laboratory Testing Panel */}
							<Box>
								<Typography variant='subtitle2' sx={{ fontWeight: 800, color: '#1e293b', mb: 1 }}>
									Mandatory TTI Screening Panel
								</Typography>
								<Grid container spacing={1}>
									{['hiv', 'hbv', 'hcv', 'syphilis', 'malaria'].map((test) => (
										<Grid item xs={4} sm={2.4} key={test}>
											<Box sx={{ p: 1, borderRadius: 1.5, border: '1px solid #e2e8f0', textAlign: 'center' }}>
												<Typography variant='caption' sx={{ fontWeight: 700, textTransform: 'uppercase', color: '#475569' }}>
													{test}
												</Typography>
												<Box sx={{ mt: 0.5 }}>{getTestBadge(selectedUnit?.testing?.[test])}</Box>
											</Box>
										</Grid>
									))}
								</Grid>
							</Box>

							{/* Medical Officer Verification */}
							<Box>
								<Typography variant='subtitle2' sx={{ fontWeight: 800, color: '#1e293b', mb: 0.5 }}>
									Medical Officer Clinical Clearance
								</Typography>
								<Typography variant='body2' sx={{ color: '#475569' }}>
									Status:{' '}
									<strong>
										{selectedUnit?.clearance?.isVerified ? 'VERIFIED & CLEARED' : 'PENDING AUTHORIZATION'}
									</strong>{' '}
									{selectedUnit?.clearance?.verifiedAt && `at ${new Date(selectedUnit.clearance.verifiedAt).toLocaleString()}`}
								</Typography>
								{selectedUnit?.clearance?.notes && (
									<Typography variant='caption' sx={{ color: '#64748b', fontStyle: 'italic', display: 'block' }}>
										Notes: {selectedUnit.clearance.notes}
									</Typography>
								)}
							</Box>

							{/* Reservation / Issuance / Discard Details */}
							{selectedUnit?.reservation?.receiveRequestId && (
								<Alert severity='info' sx={{ borderRadius: 2 }}>
									<Typography variant='body2'>
										Hold active for Request ID: <strong>{selectedUnit.reservation.receiveRequestId}</strong> | Expires:{' '}
										{new Date(selectedUnit.reservation.reservedExpiresAt).toLocaleString()}
									</Typography>
								</Alert>
							)}

							{selectedUnit?.status === 'Discarded' && (
								<Alert severity='error' sx={{ borderRadius: 2 }}>
									<Typography variant='body2'>
										Unit discarded for reason: <strong>{selectedUnit.discard?.reason}</strong> | Manifest #:{' '}
										{selectedUnit.discard?.wasteManifestNumber || 'N/A'}
									</Typography>
								</Alert>
							)}

							<Divider />

							{/* Audit History Log */}
							<Box>
								<Typography variant='subtitle2' sx={{ fontWeight: 800, color: '#1e293b', mb: 1 }}>
									Immutable Audit Log History
								</Typography>
								{selectedUnit?.auditHistory?.length > 0 ? (
									<TableContainer component={Paper} elevation={0} sx={{ border: '1px solid #e2e8f0', maxHeight: 220 }}>
										<Table size='small'>
											<TableHead sx={{ bgcolor: '#f8fafc' }}>
												<TableRow>
													<TableCell sx={{ fontWeight: 700 }}>Timestamp</TableCell>
													<TableCell sx={{ fontWeight: 700 }}>Action</TableCell>
													<TableCell sx={{ fontWeight: 700 }}>Transition</TableCell>
													<TableCell sx={{ fontWeight: 700 }}>Actor Model</TableCell>
													<TableCell sx={{ fontWeight: 700 }}>Reason / Notes</TableCell>
												</TableRow>
											</TableHead>
											<TableBody>
												{selectedUnit.auditHistory.map((log) => (
													<TableRow key={log._id}>
														<TableCell sx={{ fontSize: '0.75rem' }}>
															{new Date(log.timestamp).toLocaleString()}
														</TableCell>
														<TableCell>
															<Chip label={log.action} size='small' sx={{ fontSize: '0.65rem', height: 20 }} />
														</TableCell>
														<TableCell sx={{ fontSize: '0.75rem' }}>
															{log.previousStatus} &rarr; <strong>{log.newStatus}</strong>
														</TableCell>
														<TableCell sx={{ fontSize: '0.75rem' }}>
															{log.actor?.actorModel || 'bloodbank'}
														</TableCell>
														<TableCell sx={{ fontSize: '0.75rem', color: '#64748b' }}>
															{log.reason || '-'}
														</TableCell>
													</TableRow>
												))}
											</TableBody>
										</Table>
									</TableContainer>
								) : (
									<Typography variant='caption' sx={{ color: '#94a3b8' }}>
										No audit events recorded for this unit.
									</Typography>
								)}
							</Box>
						</Box>
					)}
				</DialogContent>
				<DialogActions>
					<Button onClick={() => setDetailOpen(false)}>Close</Button>
				</DialogActions>
			</Dialog>

			{/* ========================================================= */}
			{/* 2. Record Laboratory TTI Screening Modal */}
			{/* ========================================================= */}
			<Dialog open={screeningModalOpen} onClose={() => setScreeningModalOpen(false)} maxWidth='sm' fullWidth>
				<DialogTitle sx={{ fontWeight: 800 }}>Record TTI Laboratory Screening Panel</DialogTitle>
				<DialogContent dividers>
					<Typography variant='body2' sx={{ color: '#475569', mb: 2 }}>
						Unit: <strong>{activeUnit?.unitNumber}</strong> ({formatBloodGroup(activeUnit?.bloodGroup)})
					</Typography>

					<Grid container spacing={2}>
						{['hiv', 'hbv', 'hcv', 'syphilis', 'malaria'].map((test) => (
							<Grid item xs={6} key={test}>
								<FormControl fullWidth size='small'>
									<InputLabel sx={{ textTransform: 'uppercase' }}>{test}</InputLabel>
									<Select
										value={screeningData[test]}
										label={test}
										onChange={(e) => setScreeningData({ ...screeningData, [test]: e.target.value })}
									>
										<MenuItem value='Non_Reactive'>Non-Reactive (Passed)</MenuItem>
										<MenuItem value='Reactive'>Reactive (Positive / Failed)</MenuItem>
										<MenuItem value='Pending'>Pending (In Progress)</MenuItem>
									</Select>
								</FormControl>
							</Grid>
						))}

						<Grid item xs={12}>
							<TextField
								fullWidth
								size='small'
								label='Test Batch Identifier'
								value={screeningData.testBatchId}
								onChange={(e) => setScreeningData({ ...screeningData, testBatchId: e.target.value })}
								required
							/>
						</Grid>

						<Grid item xs={12}>
							<TextField
								fullWidth
								size='small'
								label='Laboratory Notes'
								multiline
								rows={2}
								value={screeningData.notes}
								onChange={(e) => setScreeningData({ ...screeningData, notes: e.target.value })}
							/>
						</Grid>
					</Grid>
				</DialogContent>
				<DialogActions>
					<Button onClick={() => setScreeningModalOpen(false)}>Cancel</Button>
					<Button
						variant='contained'
						color='primary'
						onClick={handleSubmitScreening}
						disabled={isActionSubmitting}
					>
						{isActionSubmitting ? 'Recording...' : 'Submit Screening Results'}
					</Button>
				</DialogActions>
			</Dialog>

			{/* ========================================================= */}
			{/* 3. Medical Officer Quality Verification Modal */}
			{/* ========================================================= */}
			<Dialog open={clearanceModalOpen} onClose={() => setClearanceModalOpen(false)} maxWidth='sm' fullWidth>
				<DialogTitle sx={{ fontWeight: 800, color: '#059669' }}>
					Medical Officer Quality Verification & Clearance
				</DialogTitle>
				<DialogContent dividers>
					<Alert severity='info' sx={{ mb: 2 }}>
						This action transitions unit <strong>{activeUnit?.unitNumber}</strong> from Tested_Passed to Available, making it issue-eligible. All 5 mandatory TTI tests must be Non-Reactive.
					</Alert>

					<TextField
						fullWidth
						label='Medical Officer Clearance Notes'
						multiline
						rows={3}
						placeholder='Confirmed negative screening panel, bag integrity, and cold-chain compliance.'
						value={clearanceNotes}
						onChange={(e) => setClearanceNotes(e.target.value)}
					/>
				</DialogContent>
				<DialogActions>
					<Button onClick={() => setClearanceModalOpen(false)}>Cancel</Button>
					<Button
						variant='contained'
						color='success'
						onClick={handleSubmitClearance}
						disabled={isActionSubmitting}
					>
						{isActionSubmitting ? 'Verifying...' : 'Authorize Clearance'}
					</Button>
				</DialogActions>
			</Dialog>

			{/* ========================================================= */}
			{/* 4. Pre-Issuance Crossmatch Modal */}
			{/* ========================================================= */}
			<Dialog open={crossmatchModalOpen} onClose={() => setCrossmatchModalOpen(false)} maxWidth='sm' fullWidth>
				<DialogTitle sx={{ fontWeight: 800 }}>Record Serological Crossmatch</DialogTitle>
				<DialogContent dividers>
					<Typography variant='body2' sx={{ mb: 2 }}>
						Unit: <strong>{activeUnit?.unitNumber}</strong>
					</Typography>
					<FormControl fullWidth size='small' sx={{ mb: 2 }}>
						<InputLabel>Crossmatch Outcome</InputLabel>
						<Select
							value={crossmatchData.result}
							label='Crossmatch Outcome'
							onChange={(e) => setCrossmatchData({ ...crossmatchData, result: e.target.value })}
						>
							<MenuItem value='Compatible'>Compatible (Safe for Transfusion)</MenuItem>
							<MenuItem value='Incompatible'>Incompatible (Transfusion Blocked)</MenuItem>
							<MenuItem value='Emergency_Uncrossmatched'>Emergency Uncrossmatched (MO Authorized Only)</MenuItem>
						</Select>
					</FormControl>
					<TextField
						fullWidth
						label='Crossmatch Notes'
						size='small'
						value={crossmatchData.notes}
						onChange={(e) => setCrossmatchData({ ...crossmatchData, notes: e.target.value })}
					/>
				</DialogContent>
				<DialogActions>
					<Button onClick={() => setCrossmatchModalOpen(false)}>Cancel</Button>
					<Button
						variant='contained'
						onClick={handleSubmitCrossmatch}
						disabled={isActionSubmitting}
					>
						{isActionSubmitting ? 'Recording...' : 'Record Crossmatch'}
					</Button>
				</DialogActions>
			</Dialog>

			{/* ========================================================= */}
			{/* 5. Physical Dispatch Modal */}
			{/* ========================================================= */}
			<Dialog open={dispatchModalOpen} onClose={() => setDispatchModalOpen(false)} maxWidth='sm' fullWidth>
				<DialogTitle sx={{ fontWeight: 800 }}>Execute Physical Dispatch</DialogTitle>
				<DialogContent dividers>
					<Typography variant='body2' sx={{ mb: 2 }}>
						Unit: <strong>{activeUnit?.unitNumber}</strong>
					</Typography>
					<Grid container spacing={2}>
						<Grid item xs={12}>
							<TextField
								fullWidth
								size='small'
								label='Recipient Hospital / Courier Name'
								value={dispatchData.dispatchedToRecipient}
								onChange={(e) => setDispatchData({ ...dispatchData, dispatchedToRecipient: e.target.value })}
								required
							/>
						</Grid>
						<Grid item xs={12}>
							<TextField
								fullWidth
								size='small'
								label='Transport Box Identifier / Cold-Chain Box #'
								value={dispatchData.transportBoxId}
								onChange={(e) => setDispatchData({ ...dispatchData, transportBoxId: e.target.value })}
							/>
						</Grid>
						<Grid item xs={12}>
							<TextField
								fullWidth
								size='small'
								label='Dispatch Notes'
								multiline
								rows={2}
								value={dispatchData.dispatchNotes}
								onChange={(e) => setDispatchData({ ...dispatchData, dispatchNotes: e.target.value })}
							/>
						</Grid>
					</Grid>
				</DialogContent>
				<DialogActions>
					<Button onClick={() => setDispatchModalOpen(false)}>Cancel</Button>
					<Button
						variant='contained'
						color='primary'
						onClick={handleSubmitDispatch}
						disabled={isActionSubmitting}
					>
						{isActionSubmitting ? 'Dispatching...' : 'Confirm Physical Dispatch'}
					</Button>
				</DialogActions>
			</Dialog>

			{/* ========================================================= */}
			{/* 6. Authorized Biohazard / Clinical Discard Modal */}
			{/* ========================================================= */}
			<Dialog open={discardModalOpen} onClose={() => setDiscardModalOpen(false)} maxWidth='sm' fullWidth>
				<DialogTitle sx={{ fontWeight: 800, color: '#dc2626' }}>
					Authorize Biohazard / Clinical Discard
				</DialogTitle>
				<DialogContent dividers>
					<Alert severity='error' sx={{ mb: 2 }}>
						<strong>IRREVERSIBLE ACTION:</strong> Unit <strong>{activeUnit?.unitNumber}</strong> will be permanently retired from inventory and marked Discarded.
					</Alert>

					<Grid container spacing={2}>
						<Grid item xs={12}>
							<FormControl fullWidth size='small' required>
								<InputLabel>Discard Reason</InputLabel>
								<Select
									value={discardData.reason}
									label='Discard Reason'
									onChange={(e) => setDiscardData({ ...discardData, reason: e.target.value })}
								>
									{DISCARD_REASONS.map((r) => (
										<MenuItem key={r} value={r}>
											{r.replace(/_/g, ' ')}
										</MenuItem>
									))}
								</Select>
							</FormControl>
						</Grid>
						<Grid item xs={12}>
							<TextField
								fullWidth
								size='small'
								label='Biohazard Waste Manifest Number'
								value={discardData.wasteManifestNumber}
								onChange={(e) => setDiscardData({ ...discardData, wasteManifestNumber: e.target.value })}
								placeholder='WM-2026-XXXXX'
							/>
						</Grid>
						<Grid item xs={12}>
							<TextField
								fullWidth
								size='small'
								label='Disposal Notes'
								multiline
								rows={2}
								value={discardData.notes}
								onChange={(e) => setDiscardData({ ...discardData, notes: e.target.value })}
							/>
						</Grid>
					</Grid>
				</DialogContent>
				<DialogActions>
					<Button onClick={() => setDiscardModalOpen(false)}>Cancel</Button>
					<Button
						variant='contained'
						color='error'
						onClick={handleSubmitDiscard}
						disabled={isActionSubmitting}
					>
						{isActionSubmitting ? 'Discarding...' : 'Confirm Discard'}
					</Button>
				</DialogActions>
			</Dialog>
		</Container>
	)
}

export default TraceableInventoryDashboard
