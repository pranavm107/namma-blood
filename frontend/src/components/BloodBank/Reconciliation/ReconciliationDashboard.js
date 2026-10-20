import React, { useEffect, useState, useCallback } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import {
	Box,
	Button,
	Card,
	CardContent,
	Chip,
	Container,
	Dialog,
	DialogActions,
	DialogContent,
	DialogTitle,
	Divider,
	FormControlLabel,
	Grid,
	IconButton,
	MenuItem,
	Paper,
	Select,
	Switch,
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
	CircularProgress,
} from '@mui/material'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import AssessmentIcon from '@mui/icons-material/Assessment'
import HistoryIcon from '@mui/icons-material/History'
import TransformIcon from '@mui/icons-material/Transform'
import WarningAmberIcon from '@mui/icons-material/WarningAmber'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import AddCircleOutlineIcon from '@mui/icons-material/AddCircleOutline'
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline'
import RefreshIcon from '@mui/icons-material/Refresh'
import SecurityIcon from '@mui/icons-material/Security'
import { toast } from 'react-toastify'

import {
	fetchReconciliationReport,
	executeReconciliationMigration,
	fetchReconciliationHistory,
	clearMigrationResult,
	clearReconciliationError,
	clearReconciliationSuccessMessage,
} from '../../../store/reconciliationSlice'

const VALID_BLOOD_GROUPS = [
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
	'Whole_Blood',
	'Packed_Red_Blood_Cells',
	'Fresh_Frozen_Plasma',
	'Platelets',
	'Cryoprecipitate',
]

function formatBloodGroup(bg) {
	if (!bg) return '-'
	return bg.replace('_Positive', '+').replace('_Negative', '-')
}

function getDefaultExpiryDate() {
	const d = new Date()
	d.setDate(d.getDate() + 35)
	return d.toISOString().split('T')[0]
}

const ReconciliationDashboard = () => {
	const dispatch = useDispatch()
	const {
		report,
		migrationResult,
		history,
		historyTotal,
		isReportLoading,
		isMigrationSubmitting,
		isHistoryLoading,
		error,
		successMessage,
	} = useSelector((state) => state.reconciliation)

	// Navigation Tabs: 0 = Audit Report, 1 = Safe Migration, 2 = Audit History
	const [activeTab, setActiveTab] = useState(0)

	// Report Options
	const [recordAuditOnReport, setRecordAuditOnReport] = useState(false)

	// Migration Form State (Strictly default to DRY_RUN mode)
	const [migrationMode, setMigrationMode] = useState('DRY_RUN')
	const [batchIdInput, setBatchIdInput] = useState('')
	const [migrationNotes, setMigrationNotes] = useState('')
	const [manifestRows, setManifestRows] = useState([
		{
			unitNumber: '',
			bloodGroup: 'O_Positive',
			componentType: 'Whole_Blood',
			volumeMl: 350,
			expiryDate: getDefaultExpiryDate(),
			deductFromLegacy: true,
		},
	])

	// Confirmation Dialog for EXECUTE mode
	const [isConfirmDialogOpen, setIsConfirmDialogOpen] = useState(false)
	const [executeConfirmed, setExecuteConfirmed] = useState(false)

	// Notifications
	useEffect(() => {
		if (error) {
			toast.error(error)
			dispatch(clearReconciliationError())
		}
	}, [error, dispatch])

	useEffect(() => {
		if (successMessage) {
			toast.success(successMessage)
			dispatch(clearReconciliationSuccessMessage())
		}
	}, [successMessage, dispatch])

	const handleGenerateReport = useCallback(() => {
		dispatch(fetchReconciliationReport({ recordAudit: recordAuditOnReport }))
	}, [dispatch, recordAuditOnReport])

	const handleLoadHistory = useCallback(() => {
		dispatch(fetchReconciliationHistory({ limit: 20, skip: 0 }))
	}, [dispatch])

	// Switch tab handler
	const handleTabChange = (event, newValue) => {
		setActiveTab(newValue)
		if (newValue === 2 && history.length === 0) {
			handleLoadHistory()
		}
	}

	// Manifest row management
	const handleAddRow = () => {
		setManifestRows((prev) => [
			...prev,
			{
				unitNumber: '',
				bloodGroup: 'O_Positive',
				componentType: 'Whole_Blood',
				volumeMl: 350,
				expiryDate: getDefaultExpiryDate(),
				deductFromLegacy: true,
			},
		])
	}

	const handleRemoveRow = (index) => {
		setManifestRows((prev) => prev.filter((_, idx) => idx !== index))
	}

	const handleRowChange = (index, field, value) => {
		setManifestRows((prev) =>
			prev.map((row, idx) => (idx === index ? { ...row, [field]: value } : row))
		)
	}

	const handleAddSampleRow = () => {
		const randomNum = Math.floor(100000 + Math.random() * 900000)
		setManifestRows((prev) => [
			...prev,
			{
				unitNumber: `DIN-LEG-${randomNum}`,
				bloodGroup: 'A_Positive',
				componentType: 'Whole_Blood',
				volumeMl: 350,
				expiryDate: getDefaultExpiryDate(),
				deductFromLegacy: true,
			},
		])
	}

	const handleClearManifest = () => {
		setManifestRows([])
		dispatch(clearMigrationResult())
	}

	// Submission handler
	const handleRunMigration = (targetMode) => {
		if (manifestRows.length === 0) {
			toast.warning('Please enter at least one unit in the migration manifest.')
			return
		}

		// Validation on required unit numbers
		const missingDin = manifestRows.find((r) => !r.unitNumber || r.unitNumber.trim() === '')
		if (missingDin) {
			toast.error('All manifest items must have a unique DIN / Barcode.')
			return
		}

		if (targetMode === 'EXECUTE') {
			setIsConfirmDialogOpen(true)
			setExecuteConfirmed(false)
		} else {
			// Trigger Dry Run directly
			dispatch(
				executeReconciliationMigration({
					mode: 'DRY_RUN',
					migrationManifest: manifestRows,
					batchId: batchIdInput.trim() || undefined,
					notes: migrationNotes.trim(),
				})
			)
		}
	}

	const handleConfirmExecute = () => {
		if (!executeConfirmed) return
		setIsConfirmDialogOpen(false)
		dispatch(
			executeReconciliationMigration({
				mode: 'EXECUTE',
				migrationManifest: manifestRows,
				batchId: batchIdInput.trim() || undefined,
				notes: migrationNotes.trim(),
			})
		)
	}

	return (
		<Container maxWidth='xl' sx={{ mt: 3, mb: 6 }}>
			{/* Header */}
			<Box
				sx={{
					display: 'flex',
					justifyContent: 'space-between',
					alignItems: 'center',
					mb: 3,
					flexWrap: 'wrap',
					gap: 2,
				}}
			>
				<Box>
					<Typography variant='h4' fontWeight='bold' color='primary' sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
						<SecurityIcon fontSize='large' />
						Legacy Inventory Reconciliation & Safe Migration
					</Typography>
					<Typography variant='body2' color='textSecondary'>
						Safely audit legacy aggregate stock against traceable units, identify discrepancies, and migrate with atomic transaction safeguards.
					</Typography>
				</Box>

				<Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
					<Chip
						label='Safe Dry-Run Default'
						color='success'
						variant='outlined'
						icon={<CheckCircleIcon />}
						sx={{ fontWeight: 'bold' }}
					/>
					<Chip
						label='Unverified Stock Isolated'
						color='warning'
						variant='outlined'
						icon={<WarningAmberIcon />}
						sx={{ fontWeight: 'bold' }}
					/>
				</Box>
			</Box>

			{/* Navigation Tabs */}
			<Paper sx={{ mb: 3 }}>
				<Tabs
					value={activeTab}
					onChange={handleTabChange}
					indicatorColor='primary'
					textColor='primary'
					variant='fullWidth'
				>
					<Tab icon={<AssessmentIcon />} iconPosition='start' label='1. Dry-Run Audit & Discrepancies' />
					<Tab icon={<TransformIcon />} iconPosition='start' label='2. Safe Migration Console' />
					<Tab icon={<HistoryIcon />} iconPosition='start' label='3. Reconciliation Audit Ledger' />
				</Tabs>
			</Paper>

			{/* ========================================================================= */}
			{/* TAB 0: DRY-RUN AUDIT & DISCREPANCY REPORT                                */}
			{/* ========================================================================= */}
			{activeTab === 0 && (
				<Box>
					{/* Action Bar */}
					<Paper sx={{ p: 2, mb: 3, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
						<Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
							<Button
								variant='contained'
								color='primary'
								size='large'
								startIcon={isReportLoading ? <CircularProgress size={20} color='inherit' /> : <PlayArrowIcon />}
								onClick={handleGenerateReport}
								disabled={isReportLoading}
							>
								{isReportLoading ? 'Analyzing Inventory...' : 'Generate Dry-Run Audit Report'}
							</Button>
							<FormControlLabel
								control={
									<Switch
										checked={recordAuditOnReport}
										onChange={(e) => setRecordAuditOnReport(e.target.checked)}
										color='primary'
									/>
								}
								label={<Typography variant='body2'>Record in Audit Ledger</Typography>}
							/>
						</Box>

						<Typography variant='caption' color='textSecondary'>
							Safety Guarantee: Generating an audit report performs <strong>zero writes</strong> to inventory.
						</Typography>
					</Paper>

					{!report && !isReportLoading && (
						<Paper sx={{ p: 6, textAlign: 'center' }}>
							<AssessmentIcon sx={{ fontSize: 64, color: 'text.secondary', mb: 2 }} />
							<Typography variant='h6' color='textSecondary'>
								No Reconciliation Report Generated Yet
							</Typography>
							<Typography variant='body2' color='textSecondary' sx={{ mt: 1, mb: 3 }}>
								Click <strong>"Generate Dry-Run Audit Report"</strong> to perform a non-destructive safety analysis comparing legacy aggregate stock with traceable barcoded units.
							</Typography>
							<Button
								variant='outlined'
								color='primary'
								startIcon={<PlayArrowIcon />}
								onClick={handleGenerateReport}
							>
								Run Audit Now
							</Button>
						</Paper>
					)}

					{isReportLoading && (
						<Box sx={{ p: 6, textAlign: 'center' }}>
							<CircularProgress size={48} />
							<Typography variant='body1' sx={{ mt: 2 }}>
								Scanning traceable unit records and aggregate totals...
							</Typography>
						</Box>
					)}

					{report && !isReportLoading && (
						<Box>
							{/* Report Summary Cards */}
							<Grid container spacing={2} sx={{ mb: 3 }}>
								<Grid item xs={12} sm={6} md={3}>
									<Card sx={{ bgcolor: 'rgba(237, 108, 2, 0.08)', borderLeft: '4px solid #ed6c02' }}>
										<CardContent>
											<Typography variant='caption' color='textSecondary' fontWeight='bold'>
												LEGACY AGGREGATE STOCK
											</Typography>
											<Typography variant='h4' fontWeight='bold' color='warning.dark'>
												{report.summary?.legacyTotal ?? 0}
											</Typography>
											<Chip
												label='Unverified Stock'
												size='small'
												color='warning'
												sx={{ mt: 1, fontSize: 10, height: 20 }}
											/>
										</CardContent>
									</Card>
								</Grid>

								<Grid item xs={12} sm={6} md={3}>
									<Card sx={{ bgcolor: 'rgba(2, 136, 209, 0.08)', borderLeft: '4px solid #0288d1' }}>
										<CardContent>
											<Typography variant='caption' color='textSecondary' fontWeight='bold'>
												TOTAL TRACEABLE UNITS
											</Typography>
											<Typography variant='h4' fontWeight='bold' color='info.dark'>
												{report.summary?.traceableTotal ?? 0}
											</Typography>
											<Typography variant='caption' color='textSecondary'>
												Barcoded traceable units
											</Typography>
										</CardContent>
									</Card>
								</Grid>

								<Grid item xs={12} sm={6} md={3}>
									<Card sx={{ bgcolor: 'rgba(46, 125, 50, 0.08)', borderLeft: '4px solid #2e7d32' }}>
										<CardContent>
											<Typography variant='caption' color='textSecondary' fontWeight='bold'>
												VERIFIED AVAILABLE
											</Typography>
											<Typography variant='h4' fontWeight='bold' color='success.dark'>
												{report.summary?.traceableVerifiedTotal ?? 0}
											</Typography>
											<Typography variant='caption' color='textSecondary'>
												Non-reactive & MO cleared
											</Typography>
										</CardContent>
									</Card>
								</Grid>

								<Grid item xs={12} sm={6} md={3}>
									<Card
										sx={{
											bgcolor: report.isClean ? 'rgba(46, 125, 50, 0.08)' : 'rgba(211, 47, 47, 0.08)',
											borderLeft: `4px solid ${report.isClean ? '#2e7d32' : '#d32f2f'}`,
										}}
									>
										<CardContent>
											<Typography variant='caption' color='textSecondary' fontWeight='bold'>
												AUDIT STATUS
											</Typography>
											<Typography
												variant='h6'
												fontWeight='bold'
												color={report.isClean ? 'success.dark' : 'error.dark'}
											>
												{report.status}
											</Typography>
											<Chip
												label={`${report.summary?.discrepancyCount ?? 0} Discrepancies`}
												size='small'
												color={report.isClean ? 'success' : 'error'}
												sx={{ mt: 1, fontSize: 10, height: 20 }}
											/>
										</CardContent>
									</Card>
								</Grid>
							</Grid>

							{/* Backend Recommendation Alert */}
							<Alert
								severity={report.isClean ? 'success' : 'warning'}
								icon={report.isClean ? <CheckCircleIcon /> : <WarningAmberIcon />}
								sx={{ mb: 3 }}
							>
								<Typography variant='subtitle2' fontWeight='bold'>
									Reconciliation Finding & Recommendation:
								</Typography>
								<Typography variant='body2'>{report.recommendation}</Typography>
								<Typography variant='caption' display='block' sx={{ mt: 0.5 }}>
									Audit Batch ID: <strong>{report.batchId}</strong> | Timestamp:{' '}
									{new Date(report.timestamp).toLocaleString()}
								</Typography>
							</Alert>

							{/* Per Blood Group Comparison Table */}
							<Paper sx={{ mb: 3, overflow: 'hidden' }}>
								<Box sx={{ p: 2, bgcolor: '#f5f5f5', borderBottom: '1px solid #ddd' }}>
									<Typography variant='subtitle1' fontWeight='bold'>
										Per-Blood-Group Inventory Breakdown (Legacy vs Traceable)
									</Typography>
									<Typography variant='caption' color='textSecondary'>
										Delta = Legacy Aggregate Count - Traceable Total Active. Positive delta indicates unverified legacy units needing barcoding.
									</Typography>
								</Box>
								<TableContainer>
									<Table size='small'>
										<TableHead sx={{ bgcolor: '#fafafa' }}>
											<TableRow>
												<TableCell><strong>Blood Group</strong></TableCell>
												<TableCell align='center'><strong>Legacy Aggregate (Unverified)</strong></TableCell>
												<TableCell align='center'><strong>Quarantined</strong></TableCell>
												<TableCell align='center'><strong>Verified Available</strong></TableCell>
												<TableCell align='center'><strong>Reserved</strong></TableCell>
												<TableCell align='center'><strong>Issued / Dispatched</strong></TableCell>
												<TableCell align='center'><strong>Expired / Discarded</strong></TableCell>
												<TableCell align='center'><strong>Delta (Unverified Balance)</strong></TableCell>
											</TableRow>
										</TableHead>
										<TableBody>
											{report.perGroupDetails?.map((g) => (
												<TableRow key={g.bloodGroup} hover>
													<TableCell>
														<Chip
															label={formatBloodGroup(g.bloodGroup)}
															size='small'
															color='primary'
															variant='outlined'
															sx={{ fontWeight: 'bold' }}
														/>
													</TableCell>
													<TableCell align='center'>
														<Typography fontWeight='bold' color='warning.dark'>
															{g.legacyCount}
														</Typography>
													</TableCell>
													<TableCell align='center'>
														<Chip
															label={g.traceableQuarantined}
															size='small'
															color={g.traceableQuarantined > 0 ? 'warning' : 'default'}
															sx={{ minWidth: 32 }}
														/>
													</TableCell>
													<TableCell align='center'>
														<Chip
															label={g.traceableAvailable}
															size='small'
															color={g.traceableAvailable > 0 ? 'success' : 'default'}
															sx={{ minWidth: 32 }}
														/>
													</TableCell>
													<TableCell align='center'>{g.traceableReserved}</TableCell>
													<TableCell align='center'>{g.traceableIssued + g.traceableDispatched}</TableCell>
													<TableCell align='center'>{g.traceableExpired + g.traceableDiscarded}</TableCell>
													<TableCell align='center'>
														<Chip
															label={g.delta > 0 ? `+${g.delta} Unverified` : `${g.delta}`}
															size='small'
															color={g.delta > 0 ? 'warning' : g.delta < 0 ? 'error' : 'success'}
															sx={{ fontWeight: 'bold' }}
														/>
													</TableCell>
												</TableRow>
											))}
										</TableBody>
									</Table>
								</TableContainer>
							</Paper>

							{/* Discrepancies and Safety Hazards */}
							{report.discrepancies && report.discrepancies.length > 0 && (
								<Paper sx={{ mb: 3, overflow: 'hidden' }}>
									<Box sx={{ p: 2, bgcolor: '#fff3e0', borderBottom: '1px solid #ffe0b2' }}>
										<Typography variant='subtitle1' fontWeight='bold' color='warning.dark'>
											Detected Inventory Discrepancies ({report.discrepancies.length})
										</Typography>
									</Box>
									<TableContainer>
										<Table size='small'>
											<TableHead>
												<TableRow>
													<TableCell><strong>Severity</strong></TableCell>
													<TableCell><strong>Discrepancy Type</strong></TableCell>
													<TableCell><strong>Blood Group / DIN</strong></TableCell>
													<TableCell><strong>Details</strong></TableCell>
												</TableRow>
											</TableHead>
											<TableBody>
												{report.discrepancies.map((d, index) => (
													<TableRow key={index} hover>
														<TableCell>
															<Chip
																label={d.severity}
																size='small'
																color={
																	d.severity === 'CRITICAL' || d.severity === 'ERROR'
																		? 'error'
																		: d.severity === 'WARNING'
																		? 'warning'
																		: 'info'
																}
																sx={{ fontWeight: 'bold', fontSize: 11 }}
															/>
														</TableCell>
														<TableCell>
															<code>{d.type}</code>
														</TableCell>
														<TableCell>
															{d.bloodGroup ? formatBloodGroup(d.bloodGroup) : ''}
															{d.unitNumber ? ` (${d.unitNumber})` : ''}
															{!d.bloodGroup && !d.unitNumber && '-'}
														</TableCell>
														<TableCell>{d.details}</TableCell>
													</TableRow>
												))}
											</TableBody>
										</Table>
									</TableContainer>
								</Paper>
							)}

							{/* Non-reconcilable Units */}
							{report.nonReconcilableUnits && report.nonReconcilableUnits.length > 0 && (
								<Paper sx={{ mb: 3, p: 2, bgcolor: '#ffebee' }}>
									<Typography variant='subtitle2' fontWeight='bold' color='error.dark' sx={{ mb: 1 }}>
										Non-Reconcilable Units ({report.nonReconcilableUnits.length})
									</Typography>
									<Typography variant='body2' color='textSecondary' sx={{ mb: 2 }}>
										These units have missing barcodes, invalid component types, or duplicate DINs and cannot participate in automated reconciliation.
									</Typography>
									<Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
										{report.nonReconcilableUnits.map((u, i) => (
											<Chip
												key={i}
												label={`${u.unitNumber}: ${u.reason}`}
												size='small'
												color='error'
												variant='outlined'
											/>
										))}
									</Box>
								</Paper>
							)}
						</Box>
					)}
				</Box>
			)}

			{/* ========================================================================= */}
			{/* TAB 1: SAFE MIGRATION CONSOLE                                            */}
			{/* ========================================================================= */}
			{activeTab === 1 && (
				<Box>
					{/* Mode Selector Notice */}
					<Paper
						sx={{
							p: 3,
							mb: 3,
							border: migrationMode === 'EXECUTE' ? '2px solid #d32f2f' : '2px solid #0288d1',
							bgcolor: migrationMode === 'EXECUTE' ? '#fff8f8' : '#f8fbff',
						}}
					>
						<Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
							<Box>
								<Typography variant='h6' fontWeight='bold' color={migrationMode === 'EXECUTE' ? 'error.dark' : 'primary'}>
									Active Migration Mode: {migrationMode === 'EXECUTE' ? 'EXECUTE (LIVE WRITES)' : 'DRY RUN (SIMULATION)'}
								</Typography>
								<Typography variant='body2' color='textSecondary'>
									{migrationMode === 'EXECUTE'
										? 'Live mode will execute atomic deductions from legacy stock and register new traceable units in QUARANTINED status.'
										: 'Dry-run mode tests manifest validity, checks DIN duplicates, and simulates post-migration stock balances with ZERO database writes.'}
								</Typography>
							</Box>

							<Box sx={{ display: 'flex', gap: 1 }}>
								<Button
									variant={migrationMode === 'DRY_RUN' ? 'contained' : 'outlined'}
									color='primary'
									onClick={() => setMigrationMode('DRY_RUN')}
								>
									DRY RUN (Safe Default)
								</Button>
								<Button
									variant={migrationMode === 'EXECUTE' ? 'contained' : 'outlined'}
									color='error'
									onClick={() => setMigrationMode('EXECUTE')}
								>
									EXECUTE MODE
								</Button>
							</Box>
						</Box>

						{migrationMode === 'EXECUTE' && (
							<Alert severity='error' icon={<WarningAmberIcon />} sx={{ mt: 2 }}>
								<strong>CAUTION — LIVE MIGRATION SELECTED:</strong> Running in EXECUTE mode permanently decrements legacy aggregate stock counts and inserts barcoded traceable units. Explicit confirmation will be requested before changes are applied.
							</Alert>
						)}
					</Paper>

					{/* Metadata Input: Batch ID & Notes */}
					<Paper sx={{ p: 2, mb: 3 }}>
						<Grid container spacing={2}>
							<Grid item xs={12} sm={4}>
								<TextField
									label='Batch Identifier (Optional)'
									placeholder='e.g. MIG-2026-OCT-01'
									fullWidth
									size='small'
									value={batchIdInput}
									onChange={(e) => setBatchIdInput(e.target.value)}
									helperText='Auto-generated if left blank'
								/>
							</Grid>
							<Grid item xs={12} sm={8}>
								<TextField
									label='Operational Migration Notes / Justification'
									placeholder='Physical count reconciled against central cold room rack #4'
									fullWidth
									size='small'
									value={migrationNotes}
									onChange={(e) => setMigrationNotes(e.target.value)}
									helperText='Auditable documentation recorded with this migration batch'
								/>
							</Grid>
						</Grid>
					</Paper>

					{/* Manifest Data Entry Table */}
					<Paper sx={{ mb: 3, overflow: 'hidden' }}>
						<Box sx={{ p: 2, bgcolor: '#f5f5f5', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
							<Typography variant='subtitle1' fontWeight='bold'>
								Physical Units Manifest ({manifestRows.length} units)
							</Typography>
							<Box sx={{ display: 'flex', gap: 1 }}>
								<Button
									size='small'
									variant='outlined'
									startIcon={<AddCircleOutlineIcon />}
									onClick={handleAddRow}
								>
									Add Unit Row
								</Button>
								<Button
									size='small'
									variant='outlined'
									color='secondary'
									onClick={handleAddSampleRow}
								>
									+ Sample Unit
								</Button>
								<Button
									size='small'
									variant='text'
									color='error'
									onClick={handleClearManifest}
								>
									Clear All
								</Button>
							</Box>
						</Box>

						<TableContainer sx={{ maxHeight: 400 }}>
							<Table size='small' stickyHeader>
								<TableHead>
									<TableRow>
										<TableCell width='50'>#</TableCell>
										<TableCell><strong>Unit Barcode / DIN *</strong></TableCell>
										<TableCell><strong>Blood Group *</strong></TableCell>
										<TableCell><strong>Component Type</strong></TableCell>
										<TableCell width='120'><strong>Volume (mL)</strong></TableCell>
										<TableCell width='160'><strong>Expiry Date *</strong></TableCell>
										<TableCell align='center'><strong>Deduct Legacy</strong></TableCell>
										<TableCell align='center' width='60'><strong>Action</strong></TableCell>
									</TableRow>
								</TableHead>
								<TableBody>
									{manifestRows.length === 0 ? (
										<TableRow>
											<TableCell colSpan={8} align='center' sx={{ py: 4 }}>
												<Typography color='textSecondary'>
													No units in manifest. Click <strong>"Add Unit Row"</strong> or <strong>"+ Sample Unit"</strong> to start.
												</Typography>
											</TableCell>
										</TableRow>
									) : (
										manifestRows.map((row, index) => (
											<TableRow key={index} hover>
												<TableCell>{index + 1}</TableCell>
												<TableCell>
													<TextField
														size='small'
														fullWidth
														placeholder='DIN-12345'
														value={row.unitNumber}
														onChange={(e) => handleRowChange(index, 'unitNumber', e.target.value)}
														error={!row.unitNumber}
													/>
												</TableCell>
												<TableCell>
													<Select
														size='small'
														fullWidth
														value={row.bloodGroup}
														onChange={(e) => handleRowChange(index, 'bloodGroup', e.target.value)}
													>
														{VALID_BLOOD_GROUPS.map((bg) => (
															<MenuItem key={bg} value={bg}>
																{formatBloodGroup(bg)}
															</MenuItem>
														))}
													</Select>
												</TableCell>
												<TableCell>
													<Select
														size='small'
														fullWidth
														value={row.componentType}
														onChange={(e) => handleRowChange(index, 'componentType', e.target.value)}
													>
														{VALID_COMPONENTS.map((comp) => (
															<MenuItem key={comp} value={comp}>
																{comp.replace(/_/g, ' ')}
															</MenuItem>
														))}
													</Select>
												</TableCell>
												<TableCell>
													<TextField
														size='small'
														type='number'
														value={row.volumeMl}
														onChange={(e) => handleRowChange(index, 'volumeMl', e.target.value)}
													/>
												</TableCell>
												<TableCell>
													<TextField
														size='small'
														type='date'
														value={row.expiryDate}
														onChange={(e) => handleRowChange(index, 'expiryDate', e.target.value)}
													/>
												</TableCell>
												<TableCell align='center'>
													<Switch
														checked={row.deductFromLegacy}
														onChange={(e) => handleRowChange(index, 'deductFromLegacy', e.target.checked)}
														color='primary'
														size='small'
													/>
												</TableCell>
												<TableCell align='center'>
													<IconButton
														size='small'
														color='error'
														onClick={() => handleRemoveRow(index)}
													>
														<DeleteOutlineIcon fontSize='small' />
													</IconButton>
												</TableCell>
											</TableRow>
										))
									)}
								</TableBody>
							</Table>
						</TableContainer>
					</Paper>

					{/* Action Buttons */}
					<Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 2, mb: 4 }}>
						<Button
							variant='outlined'
							color='primary'
							size='large'
							startIcon={isMigrationSubmitting && migrationMode === 'DRY_RUN' ? <CircularProgress size={20} /> : <PlayArrowIcon />}
							onClick={() => handleRunMigration('DRY_RUN')}
							disabled={isMigrationSubmitting}
						>
							Simulate Dry-Run
						</Button>

						<Button
							variant='contained'
							color={migrationMode === 'EXECUTE' ? 'error' : 'secondary'}
							size='large'
							startIcon={isMigrationSubmitting && migrationMode === 'EXECUTE' ? <CircularProgress size={20} color='inherit' /> : <TransformIcon />}
							onClick={() => handleRunMigration('EXECUTE')}
							disabled={isMigrationSubmitting || manifestRows.length === 0}
						>
							{migrationMode === 'EXECUTE' ? 'Execute Live Migration' : 'Switch & Execute'}
						</Button>
					</Box>

					{/* Migration / Simulation Outcome View */}
					{migrationResult && (
						<Paper sx={{ p: 3, mb: 3 }}>
							<Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
								<Typography variant='h6' fontWeight='bold' color='primary'>
									Migration Result — {migrationResult.mode}
								</Typography>
								<Chip
									label={migrationResult.status}
									color={migrationResult.status === 'COMPLETED' ? 'success' : 'error'}
									sx={{ fontWeight: 'bold' }}
								/>
							</Box>

							{migrationResult.recommendation && (
								<Alert
									severity={migrationResult.status === 'COMPLETED' ? 'success' : 'warning'}
									sx={{ mb: 2 }}
								>
									{migrationResult.recommendation}
								</Alert>
							)}

							{/* Validation Errors */}
							{migrationResult.validationErrors && migrationResult.validationErrors.length > 0 && (
								<Alert severity='error' sx={{ mb: 2 }}>
									<Typography variant='subtitle2' fontWeight='bold'>
										Validation / Conflict Errors ({migrationResult.validationErrors.length}):
									</Typography>
									<ul>
										{migrationResult.validationErrors.map((err, i) => (
											<li key={i}>{err}</li>
										))}
									</ul>
								</Alert>
							)}

							{/* Result Summary */}
							<Grid container spacing={2} sx={{ mb: 3 }}>
								<Grid item xs={6} sm={3}>
									<Typography variant='caption' color='textSecondary'>Batch ID</Typography>
									<Typography variant='body1' fontWeight='bold'>
										{migrationResult.batchId}
									</Typography>
								</Grid>
								<Grid item xs={6} sm={3}>
									<Typography variant='caption' color='textSecondary'>Valid Units to Migrate</Typography>
									<Typography variant='body1' fontWeight='bold' color='success.main'>
										{migrationResult.summary?.validToMigrate ?? migrationResult.migratedCount ?? 0}
									</Typography>
								</Grid>
								<Grid item xs={6} sm={3}>
									<Typography variant='caption' color='textSecondary'>Already Migrated Units</Typography>
									<Typography variant='body1' fontWeight='bold' color='info.main'>
										{migrationResult.summary?.alreadyMigratedCount ?? 0}
									</Typography>
								</Grid>
								<Grid item xs={6} sm={3}>
									<Typography variant='caption' color='textSecondary'>Validation Failures</Typography>
									<Typography variant='body1' fontWeight='bold' color='error.main'>
										{migrationResult.summary?.failedValidationCount ?? 0}
									</Typography>
								</Grid>
							</Grid>

							{/* Per Unit Manifest Results Table */}
							{migrationResult.manifestResults && migrationResult.manifestResults.length > 0 && (
								<Box sx={{ mt: 2 }}>
									<Typography variant='subtitle2' fontWeight='bold' sx={{ mb: 1 }}>
										Manifest Processing Status
									</Typography>
									<TableContainer component={Paper} variant='outlined'>
										<Table size='small'>
											<TableHead>
												<TableRow>
													<TableCell><strong>DIN</strong></TableCell>
													<TableCell><strong>Blood Group</strong></TableCell>
													<TableCell><strong>Outcome Status</strong></TableCell>
													<TableCell><strong>Details</strong></TableCell>
												</TableRow>
											</TableHead>
											<TableBody>
												{migrationResult.manifestResults.map((r, idx) => (
													<TableRow key={idx}>
														<TableCell><code>{r.unitNumber}</code></TableCell>
														<TableCell>{formatBloodGroup(r.bloodGroup)}</TableCell>
														<TableCell>
															<Chip
																label={r.status}
																size='small'
																color={
																	r.status === 'CREATED' || r.status === 'VALID'
																		? 'success'
																		: r.status === 'SKIPPED_ALREADY_MIGRATED'
																		? 'info'
																		: 'error'
																}
															/>
														</TableCell>
														<TableCell>
															{r.errorMessage || (r.status === 'CREATED' ? 'Created in QUARANTINED status' : 'Ready')}
														</TableCell>
													</TableRow>
												))}
											</TableBody>
										</Table>
									</TableContainer>
								</Box>
							)}
						</Paper>
					)}
				</Box>
			)}

			{/* ========================================================================= */}
			{/* TAB 2: RECONCILIATION AUDIT LEDGER                                       */}
			{/* ========================================================================= */}
			{activeTab === 2 && (
				<Box>
					<Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
						<Typography variant='subtitle1' fontWeight='bold'>
							Historical Audit Records ({historyTotal})
						</Typography>
						<Button
							size='small'
							variant='outlined'
							startIcon={<RefreshIcon />}
							onClick={handleLoadHistory}
							disabled={isHistoryLoading}
						>
							Refresh Ledger
						</Button>
					</Box>

					{isHistoryLoading ? (
						<Box sx={{ p: 4, textAlign: 'center' }}>
							<CircularProgress size={32} />
						</Box>
					) : history.length === 0 ? (
						<Paper sx={{ p: 4, textAlign: 'center' }}>
							<HistoryIcon sx={{ fontSize: 48, color: 'text.secondary', mb: 1 }} />
							<Typography color='textSecondary'>
								No historical audit records found for this blood bank.
							</Typography>
						</Paper>
					) : (
						<TableContainer component={Paper}>
							<Table size='small'>
								<TableHead sx={{ bgcolor: '#fafafa' }}>
									<TableRow>
										<TableCell><strong>Timestamp</strong></TableCell>
										<TableCell><strong>Batch ID</strong></TableCell>
										<TableCell><strong>Run Type</strong></TableCell>
										<TableCell><strong>Mode</strong></TableCell>
										<TableCell><strong>Status</strong></TableCell>
										<TableCell align='center'><strong>Migrated Units</strong></TableCell>
										<TableCell align='center'><strong>Discrepancies</strong></TableCell>
										<TableCell><strong>Notes</strong></TableCell>
									</TableRow>
								</TableHead>
								<TableBody>
									{history.map((record) => (
										<TableRow key={record._id} hover>
											<TableCell>
												{new Date(record.timestamp).toLocaleString()}
											</TableCell>
											<TableCell>
												<code>{record.batchId}</code>
											</TableCell>
											<TableCell>{record.runType}</TableCell>
											<TableCell>
												<Chip
													label={record.mode}
													size='small'
													color={record.mode === 'EXECUTE' ? 'error' : 'default'}
													variant='outlined'
												/>
											</TableCell>
											<TableCell>
												<Chip
													label={record.status}
													size='small'
													color={record.status === 'COMPLETED' ? 'success' : 'error'}
												/>
											</TableCell>
											<TableCell align='center'>
												{record.summary?.migratedCount ?? 0}
											</TableCell>
											<TableCell align='center'>
												{record.summary?.discrepancyCount ?? 0}
											</TableCell>
											<TableCell>{record.notes || '-'}</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</TableContainer>
					)}
				</Box>
			)}

			{/* ========================================================================= */}
			{/* CONFIRMATION MODAL FOR LIVE EXECUTION                                    */}
			{/* ========================================================================= */}
			<Dialog
				open={isConfirmDialogOpen}
				onClose={() => setIsConfirmDialogOpen(false)}
				maxWidth='sm'
				fullWidth
			>
				<DialogTitle sx={{ bgcolor: '#d32f2f', color: '#fff', display: 'flex', alignItems: 'center', gap: 1 }}>
					<WarningAmberIcon />
					Confirm Live Migration Execution
				</DialogTitle>
				<DialogContent sx={{ mt: 2 }}>
					<Alert severity='warning' sx={{ mb: 2 }}>
						This action performs <strong>live atomic writes</strong>. Aggregate stock counts will be decremented and {manifestRows.length} traceable unit(s) will be created.
					</Alert>
					<Typography variant='body2' sx={{ mb: 2 }}>
						Please confirm the following safety invariants:
					</Typography>
					<ul>
						<li>
							<Typography variant='body2'>
								Physical bag barcodes match the DINs in this manifest.
							</Typography>
						</li>
						<li>
							<Typography variant='body2'>
								Migrated units will be placed into <strong>QUARANTINED</strong> status.
							</Typography>
						</li>
						<li>
							<Typography variant='body2'>
								Units remain <strong>unissuable</strong> until mandatory TTI screening is recorded and a verified Medical Officer performs clinical clearance.
							</Typography>
						</li>
					</ul>

					<Divider sx={{ my: 2 }} />

					<FormControlLabel
						control={
							<Switch
								checked={executeConfirmed}
								onChange={(e) => setExecuteConfirmed(e.target.checked)}
								color='error'
							/>
						}
						label={
							<Typography variant='body2' fontWeight='bold' color='error.dark'>
								I verify physical bags have been inspected and authorize live migration.
							</Typography>
						}
					/>
				</DialogContent>
				<DialogActions sx={{ p: 2 }}>
					<Button onClick={() => setIsConfirmDialogOpen(false)} color='inherit'>
						Cancel
					</Button>
					<Button
						variant='contained'
						color='error'
						disabled={!executeConfirmed || isMigrationSubmitting}
						onClick={handleConfirmExecute}
					>
						{isMigrationSubmitting ? <CircularProgress size={20} color='inherit' /> : 'Confirm & Execute Live'}
					</Button>
				</DialogActions>
			</Dialog>
		</Container>
	)
}

export default ReconciliationDashboard
