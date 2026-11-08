import React from 'react'
import {
	Box,
	Button,
	Card,
	CardContent,
	Chip,
	Container,
	Grid,
	Paper,
	Typography,
} from '@mui/material'
import { useNavigate } from 'react-router-dom'
import LocalHospitalIcon from '@mui/icons-material/LocalHospital'
import AddCircleOutlineIcon from '@mui/icons-material/AddCircleOutline'
import AdminPanelSettingsIcon from '@mui/icons-material/AdminPanelSettings'
import SecurityIcon from '@mui/icons-material/Security'
import UploadFileIcon from '@mui/icons-material/UploadFile'

const AdminHome = () => {
	const navigate = useNavigate()

	return (
		<Container maxWidth='lg' sx={{ pb: 8 }}>
			<Paper
				elevation={0}
				sx={{
					p: { xs: 3, md: 4 },
					mb: 4,
					borderRadius: 3,
					background: 'linear-gradient(135deg, #ffffff 0%, #fff8f8 100%)',
					border: '1px solid #ffebee',
				}}
			>
				<Chip
					icon={<AdminPanelSettingsIcon sx={{ color: '#c62828 !important' }} />}
					label='ADMINISTRATIVE CONTROL CENTER'
					sx={{
						backgroundColor: '#ffebee',
						color: '#c62828',
						fontWeight: 700,
						fontSize: '0.75rem',
						letterSpacing: '0.08em',
						mb: 2,
						px: 1,
					}}
				/>
				<Typography variant='h4' component='h1' sx={{ fontWeight: 800, color: '#1e293b', mb: 1 }}>
					Namma Blood — Admin Dashboard
				</Typography>
				<Typography variant='body1' sx={{ color: '#64748b', maxWidth: 700 }}>
					Central management console for accrediting partner blood banks, supervising blood donation operations,
					and ensuring high platform reliability.
				</Typography>
			</Paper>

			<Grid container spacing={3}>
				<Grid item xs={12} md={4}>
					<Card
						elevation={0}
						sx={{
							p: 2,
							borderRadius: 3,
							border: '1px solid #e2e8f0',
							boxShadow: '0 4px 16px rgba(0,0,0,0.03)',
							height: '100%',
							display: 'flex',
							flexDirection: 'column',
							justifyContent: 'space-between',
						}}
					>
						<CardContent>
							<Box
								sx={{
									width: 48,
									height: 48,
									borderRadius: 2,
									backgroundColor: '#e0f2fe',
									display: 'flex',
									alignItems: 'center',
									justifyContent: 'center',
									mb: 2,
									color: '#0284c7',
								}}
							>
								<LocalHospitalIcon />
							</Box>
							<Typography variant='h6' sx={{ fontWeight: 700, color: '#1e293b', mb: 1 }}>
								Accredited Blood Banks
							</Typography>
							<Typography variant='body2' sx={{ color: '#64748b', mb: 3, lineHeight: 1.6 }}>
								Review all registered blood banks, inspect contact details, locations, and manage partner status.
							</Typography>
						</CardContent>
						<Box sx={{ p: 2, pt: 0 }}>
							<Button
								variant='contained'
								fullWidth
								onClick={() => navigate('/admin/bloodbanks')}
								sx={{
									backgroundColor: '#1e293b',
									fontWeight: 700,
									textTransform: 'none',
									py: 1.2,
									borderRadius: 2,
									'&:hover': {
										backgroundColor: '#0f172a',
									},
								}}
							>
								View Directory
							</Button>
						</Box>
					</Card>
				</Grid>

				<Grid item xs={12} md={4}>
					<Card
						elevation={0}
						sx={{
							p: 2,
							borderRadius: 3,
							border: '1px solid #e2e8f0',
							boxShadow: '0 4px 16px rgba(0,0,0,0.03)',
							height: '100%',
							display: 'flex',
							flexDirection: 'column',
							justifyContent: 'space-between',
						}}
					>
						<CardContent>
							<Box
								sx={{
									width: 48,
									height: 48,
									borderRadius: 2,
									backgroundColor: '#ffebee',
									display: 'flex',
									alignItems: 'center',
									justifyContent: 'center',
									mb: 2,
									color: '#c62828',
								}}
							>
								<AddCircleOutlineIcon />
							</Box>
							<Typography variant='h6' sx={{ fontWeight: 700, color: '#1e293b', mb: 1 }}>
								Onboard Blood Bank
							</Typography>
							<Typography variant='body2' sx={{ color: '#64748b', mb: 3, lineHeight: 1.6 }}>
								Register a single blood bank facility with interactive form fields and login setup.
							</Typography>
						</CardContent>
						<Box sx={{ p: 2, pt: 0 }}>
							<Button
								variant='contained'
								fullWidth
								onClick={() => navigate('/admin/addbloodbank')}
								sx={{
									backgroundColor: '#c62828',
									fontWeight: 700,
									textTransform: 'none',
									py: 1.2,
									borderRadius: 2,
									boxShadow: '0 4px 12px rgba(198, 40, 40, 0.3)',
									'&:hover': {
										backgroundColor: '#b71c1c',
									},
								}}
							>
								Register Single Bank
							</Button>
						</Box>
					</Card>
				</Grid>

				<Grid item xs={12} md={4}>
					<Card
						elevation={0}
						sx={{
							p: 2,
							borderRadius: 3,
							border: '1px solid #e2e8f0',
							boxShadow: '0 4px 16px rgba(0,0,0,0.03)',
							height: '100%',
							display: 'flex',
							flexDirection: 'column',
							justifyContent: 'space-between',
						}}
					>
						<CardContent>
							<Box
								sx={{
									width: 48,
									height: 48,
									borderRadius: 2,
									backgroundColor: '#f0fdf4',
									display: 'flex',
									alignItems: 'center',
									justifyContent: 'center',
									mb: 2,
									color: '#15803d',
								}}
							>
								<UploadFileIcon />
							</Box>
							<Typography variant='h6' sx={{ fontWeight: 700, color: '#1e293b', mb: 1 }}>
								Bulk Import CSV
							</Typography>
							<Typography variant='body2' sx={{ color: '#64748b', mb: 3, lineHeight: 1.6 }}>
								Batch-import partner blood banks, cities, and states via spreadsheet with validation preview.
							</Typography>
						</CardContent>
						<Box sx={{ p: 2, pt: 0 }}>
							<Button
								variant='contained'
								fullWidth
								onClick={() => navigate('/admin/bulk-import')}
								sx={{
									backgroundColor: '#15803d',
									fontWeight: 700,
									textTransform: 'none',
									py: 1.2,
									borderRadius: 2,
									boxShadow: '0 4px 12px rgba(21, 128, 61, 0.3)',
									'&:hover': {
										backgroundColor: '#166534',
									},
								}}
							>
								Open Bulk Import
							</Button>
						</Box>
					</Card>
				</Grid>

				{/* Section: Hospital Registry & Medical Officer Network */}
				<Grid item xs={12} sx={{ mt: 2 }}>
					<Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
						<LocalHospitalIcon sx={{ color: '#16a34a' }} />
						<Typography variant='h6' sx={{ fontWeight: 800, color: '#1e293b' }}>
							Hospital Registry & Medical Officer Network (Phase 4.3.5)
						</Typography>
					</Box>
					<Typography variant='body2' sx={{ color: '#64748b', mb: 1 }}>
						Manage accredited hospital facilities, institutional verification status, and Medical Officer associations.
					</Typography>
				</Grid>

				<Grid item xs={12} md={4}>
					<Card
						elevation={0}
						sx={{
							p: 2,
							borderRadius: 3,
							border: '1px solid #bbf7d0',
							boxShadow: '0 4px 16px rgba(22, 163, 74, 0.05)',
							height: '100%',
							display: 'flex',
							flexDirection: 'column',
							justifyContent: 'space-between',
						}}
					>
						<CardContent>
							<Box
								sx={{
									width: 48,
									height: 48,
									borderRadius: 2,
									backgroundColor: '#f0fdf4',
									display: 'flex',
									alignItems: 'center',
									justifyContent: 'center',
									mb: 2,
									color: '#16a34a',
								}}
							>
								<LocalHospitalIcon />
							</Box>
							<Typography variant='h6' sx={{ fontWeight: 700, color: '#1e293b', mb: 1 }}>
								Hospital Registry
							</Typography>
							<Typography variant='body2' sx={{ color: '#64748b', mb: 3, lineHeight: 1.6 }}>
								Browse registered hospitals, filter by verification status and city, inspect credentials, and manage active status.
							</Typography>
						</CardContent>
						<Box sx={{ p: 2, pt: 0 }}>
							<Button
								variant='contained'
								fullWidth
								onClick={() => navigate('/admin/hospitals')}
								sx={{
									backgroundColor: '#16a34a',
									fontWeight: 700,
									textTransform: 'none',
									py: 1.2,
									borderRadius: 2,
									boxShadow: '0 4px 12px rgba(22, 163, 74, 0.25)',
									'&:hover': {
										backgroundColor: '#15803d',
									},
								}}
							>
								View Hospital Directory
							</Button>
						</Box>
					</Card>
				</Grid>

				<Grid item xs={12} md={4}>
					<Card
						elevation={0}
						sx={{
							p: 2,
							borderRadius: 3,
							border: '1px solid #bbf7d0',
							boxShadow: '0 4px 16px rgba(22, 163, 74, 0.05)',
							height: '100%',
							display: 'flex',
							flexDirection: 'column',
							justifyContent: 'space-between',
						}}
					>
						<CardContent>
							<Box
								sx={{
									width: 48,
									height: 48,
									borderRadius: 2,
									backgroundColor: '#f0fdf4',
									display: 'flex',
									alignItems: 'center',
									justifyContent: 'center',
									mb: 2,
									color: '#16a34a',
								}}
							>
								<AddCircleOutlineIcon />
							</Box>
							<Typography variant='h6' sx={{ fontWeight: 700, color: '#1e293b', mb: 1 }}>
								Register Hospital
							</Typography>
							<Typography variant='body2' sx={{ color: '#64748b', mb: 3, lineHeight: 1.6 }}>
								Onboard a new healthcare facility with classification, postal address, contact channels, and coordinates.
							</Typography>
						</CardContent>
						<Box sx={{ p: 2, pt: 0 }}>
							<Button
								variant='outlined'
								fullWidth
								onClick={() => navigate('/admin/hospitals/register')}
								sx={{
									borderColor: '#16a34a',
									color: '#16a34a',
									fontWeight: 700,
									textTransform: 'none',
									py: 1.2,
									borderRadius: 2,
									'&:hover': {
										borderColor: '#15803d',
										backgroundColor: '#f0fdf4',
									},
								}}
							>
								Register Facility
							</Button>
						</Box>
					</Card>
				</Grid>

				<Grid item xs={12} md={4}>
					<Card
						elevation={0}
						sx={{
							p: 2,
							borderRadius: 3,
							border: '1px solid #bbf7d0',
							boxShadow: '0 4px 16px rgba(22, 163, 74, 0.05)',
							height: '100%',
							display: 'flex',
							flexDirection: 'column',
							justifyContent: 'space-between',
						}}
					>
						<CardContent>
							<Box
								sx={{
									width: 48,
									height: 48,
									borderRadius: 2,
									backgroundColor: '#e0f2fe',
									display: 'flex',
									alignItems: 'center',
									justifyContent: 'center',
									mb: 2,
									color: '#0284c7',
								}}
							>
								<SecurityIcon />
							</Box>
							<Typography variant='h6' sx={{ fontWeight: 700, color: '#1e293b', mb: 1 }}>
								Medical Officer Management
							</Typography>
							<Typography variant='body2' sx={{ color: '#64748b', mb: 3, lineHeight: 1.6 }}>
								Associate accredited doctors with hospital facilities, grant explicit verification permissions, and manage status.
							</Typography>
						</CardContent>
						<Box sx={{ p: 2, pt: 0 }}>
							<Button
								variant='contained'
								fullWidth
								onClick={() => navigate('/admin/medical-officers')}
								sx={{
									backgroundColor: '#1e293b',
									fontWeight: 700,
									textTransform: 'none',
									py: 1.2,
									borderRadius: 2,
									boxShadow: '0 4px 12px rgba(30, 41, 59, 0.25)',
									'&:hover': {
										backgroundColor: '#0f172a',
									},
								}}
							>
								Manage Associations
							</Button>
						</Box>
					</Card>
				</Grid>

				<Grid item xs={12}>
					<Paper
						elevation={0}
						sx={{
							p: 3,
							borderRadius: 3,
							border: '1px solid #e2e8f0',
							backgroundColor: '#f8fafc',
							display: 'flex',
							alignItems: 'center',
							gap: 2,
						}}
					>
						<SecurityIcon sx={{ color: '#16a34a', fontSize: 32 }} />
						<Box>
							<Typography variant='subtitle2' sx={{ fontWeight: 700, color: '#1e293b' }}>
								Secure Healthcare Data Management
							</Typography>
							<Typography variant='caption' sx={{ color: '#64748b' }}>
								All administrator endpoints and blood bank records are protected via cryptographically signed JWT sessions and encrypted passwords.
							</Typography>
						</Box>
					</Paper>
				</Grid>
			</Grid>
		</Container>
	)
}

export default AdminHome
