import React, { useState } from 'react'
import {
	Alert,
	Box,
	Button,
	Card,
	CardContent,
	Chip,
	CircularProgress,
	Container,
	Dialog,
	DialogActions,
	DialogContent,
	DialogContentText,
	DialogTitle,
	Divider,
	Grid,
	Paper,
	Tab,
	Table,
	TableBody,
	TableCell,
	TableContainer,
	TableHead,
	TableRow,
	Tabs,
	Tooltip,
	Typography,
} from '@mui/material'
import axios from 'axios'
import { toast } from 'react-toastify'
import { useNavigate } from 'react-router-dom'
import CloudUploadIcon from '@mui/icons-material/CloudUpload'
import DownloadIcon from '@mui/icons-material/Download'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import ErrorIcon from '@mui/icons-material/Error'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import TableViewIcon from '@mui/icons-material/TableView'

const BASE_URL = process.env.REACT_APP_BASEURL || 'http://localhost:5050/api'
const MAX_FILE_SIZE = 2 * 1024 * 1024 // 2 MB

const ENTITY_CONFIG = {
	bloodbank: {
		label: 'Blood Banks',
		description: 'Accredited partner blood banks with contact, address, and login credentials',
		successRedirect: '/admin/bloodbanks',
	},
	city: {
		label: 'Cities',
		description: 'City master data linked to existing state coverage',
		successRedirect: '/admin/bloodbanks',
	},
	state: {
		label: 'States',
		description: 'Regional state master data for geographical hierarchy',
		successRedirect: '/admin/bloodbanks',
	},
}

const BulkImport = () => {
	const navigate = useNavigate()
	const [entity, setEntity] = useState('bloodbank')
	const [selectedFile, setSelectedFile] = useState(null)
	const [csvText, setCsvText] = useState('')
	const [loading, setLoading] = useState(false)
	const [previewResult, setPreviewResult] = useState(null)
	const [confirmDialogOpen, setConfirmDialogOpen] = useState(false)
	const [importing, setImporting] = useState(false)

	const getAuthHeaders = () => {
		try {
			const loginData = JSON.parse(localStorage.getItem('loginData'))
			const token = loginData?.token
			return token ? { Authorization: `Bearer ${token}` } : {}
		} catch {
			return {}
		}
	}

	const handleEntityChange = (event, newEntity) => {
		setEntity(newEntity)
		setSelectedFile(null)
		setCsvText('')
		setPreviewResult(null)
	}

	const handleFileSelect = (event) => {
		const file = event.target.files[0]
		if (!file) return

		if (!file.name.toLowerCase().endsWith('.csv')) {
			toast.error('Only CSV (.csv) files are supported.')
			return
		}

		if (file.size > MAX_FILE_SIZE) {
			toast.error('File size exceeds maximum allowed limit of 2 MB.')
			return
		}

		setSelectedFile(file)
		setPreviewResult(null)

		const reader = new FileReader()
		reader.onload = (e) => {
			setCsvText(e.target.result)
		}
		reader.onerror = () => {
			toast.error('Failed to read CSV file content.')
		}
		reader.readAsText(file)
	}

	const downloadFile = async (type) => {
		try {
			const url = `${BASE_URL}/admin/bulk-import/${type}/${entity}`
			const response = await axios.get(url, {
				headers: getAuthHeaders(),
				responseType: 'blob',
			})

			const blob = new Blob([response.data], { type: 'text/csv;charset=utf-8;' })
			const downloadUrl = window.URL.createObjectURL(blob)
			const link = document.createElement('a')
			link.href = downloadUrl
			link.setAttribute(
				'download',
				`namma_blood_${entity}_${type === 'template' ? 'template' : 'sample'}.csv`
			)
			document.body.appendChild(link)
			link.click()
			document.body.removeChild(link)
			window.URL.revokeObjectURL(downloadUrl)
		} catch (err) {
			toast.error('Failed to download CSV file. Please verify login session.')
		}
	}

	const handlePreview = async () => {
		if (!csvText) {
			toast.error('Please select a valid CSV file first.')
			return
		}

		setLoading(true)
		try {
			const response = await axios.post(
				`${BASE_URL}/admin/bulk-import/preview/${entity}`,
				{ csv: csvText },
				{ headers: getAuthHeaders() }
			)
			setPreviewResult(response.data)
			if (response.data.canImport) {
				toast.success(
					`Validation successful! All ${response.data.validRowsCount} row(s) are valid.`
				)
			} else {
				toast.warn(
					`Validation completed: ${response.data.invalidRowsCount} issue(s) detected.`
				)
			}
		} catch (err) {
			const message =
				err.response?.data?.message || 'Validation failed. Check CSV format.'
			toast.error(message)
			setPreviewResult(null)
		} finally {
			setLoading(false)
		}
	}

	const handleExecuteImport = async () => {
		setConfirmDialogOpen(false)
		setImporting(true)

		try {
			const response = await axios.post(
				`${BASE_URL}/admin/bulk-import/confirm/${entity}`,
				{ csv: csvText, confirm: true },
				{ headers: getAuthHeaders() }
			)

			toast.success(
				response.data?.message || `Successfully imported ${entity} records!`
			)
			setPreviewResult(null)
			setSelectedFile(null)
			setCsvText('')

			// Redirect to entity view after brief pause
			setTimeout(() => {
				navigate(ENTITY_CONFIG[entity]?.successRedirect || '/admin')
			}, 1500)
		} catch (err) {
			const message =
				err.response?.data?.message || 'Import failed. Database rolled back cleanly.'
			toast.error(message)
		} finally {
			setImporting(false)
		}
	}

	return (
		<Container maxWidth='lg' sx={{ pb: 8 }}>
			{/* Header Navigation */}
			<Box sx={{ mb: 3, display: 'flex', alignItems: 'center', gap: 2 }}>
				<Button
					startIcon={<ArrowBackIcon />}
					onClick={() => navigate('/admin')}
					sx={{ textTransform: 'none', color: '#64748b' }}
				>
					Back to Admin Dashboard
				</Button>
			</Box>

			{/* Main Banner */}
			<Paper
				elevation={0}
				sx={{
					p: 4,
					mb: 4,
					borderRadius: 3,
					background: 'linear-gradient(135deg, #ffffff 0%, #fff8f8 100%)',
					border: '1px solid #ffebee',
				}}
			>
				<Chip
					label='ADMINISTRATIVE BULK OPERATIONS'
					sx={{
						backgroundColor: '#ffebee',
						color: '#c62828',
						fontWeight: 700,
						fontSize: '0.75rem',
						letterSpacing: '0.08em',
						mb: 2,
					}}
				/>
				<Typography variant='h4' component='h1' sx={{ fontWeight: 800, color: '#1e293b', mb: 1 }}>
					Bulk Import & Schema Validation
				</Typography>
				<Typography variant='body1' sx={{ color: '#64748b', maxWidth: 800 }}>
					Upload CSV spreadsheets to batch-import accredited partner blood banks and geographic master data.
					All uploads undergo server-side schema verification, duplicate inspection, referential checks, and atomic transaction execution.
				</Typography>
			</Paper>

			{/* Entity Tabs */}
			<Paper elevation={0} sx={{ borderRadius: 3, border: '1px solid #e2e8f0', mb: 4, overflow: 'hidden' }}>
				<Tabs
					value={entity}
					onChange={handleEntityChange}
					variant='fullWidth'
					indicatorColor='primary'
					textColor='primary'
					sx={{
						backgroundColor: '#f8fafc',
						borderBottom: '1px solid #e2e8f0',
						'& .Mui-selected': {
							fontWeight: 800,
							color: '#c62828 !important',
						},
						'& .MuiTabs-indicator': {
							backgroundColor: '#c62828',
							height: 3,
						},
					}}
				>
					<Tab value='bloodbank' label='1. Blood Banks' />
					<Tab value='city' label='2. Cities' />
					<Tab value='state' label='3. States' />
				</Tabs>

				<Box sx={{ p: 3 }}>
					<Typography variant='subtitle1' sx={{ fontWeight: 700, color: '#1e293b', mb: 0.5 }}>
						Target Entity: {ENTITY_CONFIG[entity]?.label}
					</Typography>
					<Typography variant='body2' sx={{ color: '#64748b', mb: 3 }}>
						{ENTITY_CONFIG[entity]?.description}
					</Typography>

					{/* Download Template / Sample Action Bar */}
					<Grid container spacing={2} sx={{ mb: 3 }}>
						<Grid item xs={12} sm={6}>
							<Button
								variant='outlined'
								fullWidth
								startIcon={<DownloadIcon />}
								onClick={() => downloadFile('template')}
								sx={{
									py: 1.2,
									textTransform: 'none',
									fontWeight: 700,
									borderColor: '#cbd5e1',
									color: '#334155',
									borderRadius: 2,
									'&:hover': {
										borderColor: '#94a3b8',
										backgroundColor: '#f8fafc',
									},
								}}
							>
								Download Blank Template CSV
							</Button>
						</Grid>
						<Grid item xs={12} sm={6}>
							<Button
								variant='outlined'
								fullWidth
								startIcon={<DownloadIcon />}
								onClick={() => downloadFile('sample')}
								sx={{
									py: 1.2,
									textTransform: 'none',
									fontWeight: 700,
									borderColor: '#cbd5e1',
									color: '#334155',
									borderRadius: 2,
									'&:hover': {
										borderColor: '#94a3b8',
										backgroundColor: '#f8fafc',
									},
								}}
							>
								Download Fictional Sample CSV
							</Button>
						</Grid>
					</Grid>

					<Divider sx={{ my: 3 }} />

					{/* File Upload Box */}
					<Box
						sx={{
							p: 4,
							border: '2px dashed #cbd5e1',
							borderRadius: 3,
							textAlign: 'center',
							backgroundColor: '#f8fafc',
							cursor: 'pointer',
							'&:hover': {
								borderColor: '#c62828',
								backgroundColor: '#fff5f5',
							},
							transition: 'all 0.2s ease-in-out',
						}}
						onClick={() => document.getElementById('csv-file-input').click()}
					>
						<input
							type='file'
							id='csv-file-input'
							accept='.csv'
							style={{ display: 'none' }}
							onChange={handleFileSelect}
						/>
						<CloudUploadIcon sx={{ fontSize: 48, color: '#94a3b8', mb: 1 }} />
						<Typography variant='h6' sx={{ fontWeight: 700, color: '#334155', mb: 0.5 }}>
							{selectedFile ? selectedFile.name : 'Select or Drop CSV File Here'}
						</Typography>
						<Typography variant='caption' sx={{ color: '#64748b' }}>
							{selectedFile
								? `${(selectedFile.size / 1024).toFixed(1)} KB — Ready to preview`
								: 'Accepts standard UTF-8 CSV (Maximum 2 MB / 500 rows)'}
						</Typography>
					</Box>

					{/* Preview Trigger Button */}
					{selectedFile && (
						<Box sx={{ mt: 3, display: 'flex', justifyContent: 'flex-end', gap: 2 }}>
							<Button
								variant='outlined'
								onClick={() => {
									setSelectedFile(null)
									setCsvText('')
									setPreviewResult(null)
								}}
								sx={{ textTransform: 'none', color: '#64748b', borderRadius: 2 }}
							>
								Clear
							</Button>
							<Button
								variant='contained'
								disabled={loading}
								startIcon={loading ? <CircularProgress size={20} color='inherit' /> : <TableViewIcon />}
								onClick={handlePreview}
								sx={{
									backgroundColor: '#1e293b',
									fontWeight: 700,
									textTransform: 'none',
									px: 3,
									py: 1.2,
									borderRadius: 2,
									'&:hover': { backgroundColor: '#0f172a' },
								}}
							>
								{loading ? 'Validating CSV...' : 'Validate & Preview Import'}
							</Button>
						</Box>
					)}
				</Box>
			</Paper>

			{/* Preview & Validation Results Section */}
			{previewResult && (
				<Paper elevation={0} sx={{ p: 3, borderRadius: 3, border: '1px solid #e2e8f0', mb: 4 }}>
					<Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3, flexWrap: 'wrap', gap: 2 }}>
						<Box>
							<Typography variant='h6' sx={{ fontWeight: 800, color: '#1e293b' }}>
								Validation Preview Results
							</Typography>
							<Typography variant='body2' sx={{ color: '#64748b' }}>
								Critical Invariant: No database changes were made during this validation check.
							</Typography>
						</Box>

						{/* Confirmation Action */}
						{previewResult.canImport ? (
							<Button
								variant='contained'
								disabled={importing}
								onClick={() => setConfirmDialogOpen(true)}
								sx={{
									backgroundColor: '#16a34a',
									fontWeight: 700,
									textTransform: 'none',
									px: 3,
									py: 1.2,
									borderRadius: 2,
									boxShadow: '0 4px 12px rgba(22, 163, 74, 0.3)',
									'&:hover': { backgroundColor: '#15803d' },
								}}
							>
								Confirm & Execute Batch Import
							</Button>
						) : (
							<Chip
								icon={<ErrorIcon />}
								label='Import Blocked — Fix Row Errors'
								color='error'
								sx={{ fontWeight: 700 }}
							/>
						)}
					</Box>

					{/* Metrics Cards */}
					<Grid container spacing={2} sx={{ mb: 3 }}>
						<Grid item xs={12} sm={4}>
							<Card elevation={0} sx={{ border: '1px solid #e2e8f0', backgroundColor: '#f8fafc', borderRadius: 2 }}>
								<CardContent sx={{ py: 2 }}>
									<Typography variant='caption' sx={{ color: '#64748b', fontWeight: 600 }}>
										TOTAL ROWS
									</Typography>
									<Typography variant='h4' sx={{ fontWeight: 800, color: '#1e293b' }}>
										{previewResult.totalRows}
									</Typography>
								</CardContent>
							</Card>
						</Grid>
						<Grid item xs={12} sm={4}>
							<Card elevation={0} sx={{ border: '1px solid #bbf7d0', backgroundColor: '#f0fdf4', borderRadius: 2 }}>
								<CardContent sx={{ py: 2 }}>
									<Typography variant='caption' sx={{ color: '#15803d', fontWeight: 600 }}>
										VALID ROWS
									</Typography>
									<Typography variant='h4' sx={{ fontWeight: 800, color: '#15803d' }}>
										{previewResult.validRowsCount}
									</Typography>
								</CardContent>
							</Card>
						</Grid>
						<Grid item xs={12} sm={4}>
							<Card elevation={0} sx={{ border: '1px solid #fecaca', backgroundColor: '#fef2f2', borderRadius: 2 }}>
								<CardContent sx={{ py: 2 }}>
									<Typography variant='caption' sx={{ color: '#b91c1c', fontWeight: 600 }}>
										INVALID ROWS
									</Typography>
									<Typography variant='h4' sx={{ fontWeight: 800, color: '#b91c1c' }}>
										{previewResult.invalidRowsCount}
									</Typography>
								</CardContent>
							</Card>
						</Grid>
					</Grid>

					{/* Issues List (if any) */}
					{previewResult.errors && previewResult.errors.length > 0 && (
						<Alert severity='error' sx={{ mb: 3, borderRadius: 2 }}>
							<Typography variant='subtitle2' sx={{ fontWeight: 700, mb: 1 }}>
								Validation issues require correction before import:
							</Typography>
							<Box component='ul' sx={{ pl: 2, m: 0 }}>
								{previewResult.errors.slice(0, 10).map((err, i) => (
									<li key={i}>
										<Typography variant='body2'>
											<strong>Row {err.row} ({err.field}):</strong> {err.message}
										</Typography>
									</li>
								))}
								{previewResult.errors.length > 10 && (
									<li>
										<Typography variant='caption' sx={{ fontStyle: 'italic' }}>
											...and {previewResult.errors.length - 10} additional error(s).
										</Typography>
									</li>
								)}
							</Box>
						</Alert>
					)}

					{/* Parsed Data Preview Table */}
					<Typography variant='subtitle1' sx={{ fontWeight: 700, color: '#1e293b', mb: 1 }}>
						Parsed Row Preview
					</Typography>
					<TableContainer component={Paper} elevation={0} sx={{ border: '1px solid #e2e8f0', borderRadius: 2, maxHeight: 400 }}>
						<Table size='small' stickyHeader>
							<TableHead>
								<TableRow>
									<TableCell sx={{ fontWeight: 700, backgroundColor: '#f8fafc' }}>Row</TableCell>
									<TableCell sx={{ fontWeight: 700, backgroundColor: '#f8fafc' }}>Status</TableCell>
									{entity === 'bloodbank' && (
										<>
											<TableCell sx={{ fontWeight: 700, backgroundColor: '#f8fafc' }}>Blood Bank Name</TableCell>
											<TableCell sx={{ fontWeight: 700, backgroundColor: '#f8fafc' }}>Category</TableCell>
											<TableCell sx={{ fontWeight: 700, backgroundColor: '#f8fafc' }}>State</TableCell>
											<TableCell sx={{ fontWeight: 700, backgroundColor: '#f8fafc' }}>City</TableCell>
											<TableCell sx={{ fontWeight: 700, backgroundColor: '#f8fafc' }}>Email</TableCell>
											<TableCell sx={{ fontWeight: 700, backgroundColor: '#f8fafc' }}>Phone 1</TableCell>
										</>
									)}
									{entity === 'city' && (
										<>
											<TableCell sx={{ fontWeight: 700, backgroundColor: '#f8fafc' }}>City Name</TableCell>
											<TableCell sx={{ fontWeight: 700, backgroundColor: '#f8fafc' }}>State Name</TableCell>
										</>
									)}
									{entity === 'state' && (
										<TableCell sx={{ fontWeight: 700, backgroundColor: '#f8fafc' }}>State Name</TableCell>
									)}
								</TableRow>
							</TableHead>
							<TableBody>
								{previewResult.preview.map((item) => (
									<TableRow
										key={item.row}
										sx={{
											backgroundColor: item.status === 'VALID' ? '#ffffff' : '#fef2f2',
										}}
									>
										<TableCell>{item.row}</TableCell>
										<TableCell>
											{item.status === 'VALID' ? (
												<Chip
													icon={<CheckCircleIcon />}
													label='Valid'
													size='small'
													color='success'
													sx={{ fontWeight: 700, fontSize: '0.7rem' }}
												/>
											) : (
												<Tooltip title={item.errors.map((e) => e.message).join(' | ')}>
													<Chip
														icon={<ErrorIcon />}
														label='Error'
														size='small'
														color='error'
														sx={{ fontWeight: 700, fontSize: '0.7rem' }}
													/>
												</Tooltip>
											)}
										</TableCell>
										{entity === 'bloodbank' && (
											<>
												<TableCell>{item.data.bloodbankName || '—'}</TableCell>
												<TableCell>{item.data.category || '—'}</TableCell>
												<TableCell>{item.data.state || '—'}</TableCell>
												<TableCell>{item.data.city || '—'}</TableCell>
												<TableCell>{item.data.email || '—'}</TableCell>
												<TableCell>{item.data.phoneNo1 || '—'}</TableCell>
											</>
										)}
										{entity === 'city' && (
											<>
												<TableCell>{item.data.cityName || '—'}</TableCell>
												<TableCell>{item.data.stateName || '—'}</TableCell>
											</>
										)}
										{entity === 'state' && (
											<TableCell>{item.data.stateName || '—'}</TableCell>
										)}
									</TableRow>
								))}
							</TableBody>
						</Table>
					</TableContainer>
				</Paper>
			)}

			{/* Explicit User Confirmation Dialog */}
			<Dialog
				open={confirmDialogOpen}
				onClose={() => setConfirmDialogOpen(false)}
				aria-labelledby='confirm-dialog-title'
			>
				<DialogTitle id='confirm-dialog-title' sx={{ fontWeight: 800 }}>
					Confirm Bulk Import Execution
				</DialogTitle>
				<DialogContent>
					<DialogContentText>
						You are about to import <strong>{previewResult?.validRowsCount}</strong> verified{' '}
						<strong>{ENTITY_CONFIG[entity]?.label}</strong> record(s) into the live database.
					</DialogContentText>
					{entity === 'bloodbank' && (
						<Alert severity='info' sx={{ mt: 2, borderRadius: 2 }}>
							For each imported blood bank, an associated Blood Stock record will be atomically provisioned.
						</Alert>
					)}
					<Typography variant='body2' sx={{ mt: 2, color: '#64748b' }}>
						All rows will be re-validated on the server. If any concurrent conflict or database failure occurs, the entire batch will be aborted without saving partial records.
					</Typography>
				</DialogContent>
				<DialogActions sx={{ p: 2, pt: 0 }}>
					<Button
						onClick={() => setConfirmDialogOpen(false)}
						sx={{ textTransform: 'none', color: '#64748b' }}
					>
						Cancel
					</Button>
					<Button
						onClick={handleExecuteImport}
						variant='contained'
						disabled={importing}
						sx={{
							backgroundColor: '#16a34a',
							fontWeight: 700,
							textTransform: 'none',
							'&:hover': { backgroundColor: '#15803d' },
						}}
					>
						{importing ? 'Importing Batch...' : 'Yes, Execute Import'}
					</Button>
				</DialogActions>
			</Dialog>
		</Container>
	)
}

export default BulkImport
