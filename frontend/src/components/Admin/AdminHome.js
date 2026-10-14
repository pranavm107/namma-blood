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
				<Grid item xs={12} md={6}>
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
								View Blood Bank Directory
							</Button>
						</Box>
					</Card>
				</Grid>

				<Grid item xs={12} md={6}>
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
								Onboard New Blood Bank
							</Typography>
							<Typography variant='body2' sx={{ color: '#64748b', mb: 3, lineHeight: 1.6 }}>
								Register a certified regional blood bank, setup authentication credentials, and link state/city coverage.
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
								Register New Blood Bank
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
