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
	Stack,
	Typography,
} from '@mui/material'
import { useNavigate } from 'react-router-dom'
import BloodtypeIcon from '@mui/icons-material/Bloodtype'
import LocalHospitalIcon from '@mui/icons-material/LocalHospital'
import VolunteerActivismIcon from '@mui/icons-material/VolunteerActivism'
import VerifiedUserIcon from '@mui/icons-material/VerifiedUser'
import BloodCompatible from '../BloodCompatible'
import { useSelector } from 'react-redux'

const Home = () => {
	const navigate = useNavigate()
	const { isLoggedin, role } = useSelector((state) => state?.login || {})

	const handleDonateClick = () => {
		if (isLoggedin && role === 'USER') navigate('/user/wanttodonate')
		else if (!isLoggedin) navigate('/user/signup')
		else navigate('/user')
	}

	const handleRequestClick = () => {
		if (isLoggedin && role === 'USER') navigate('/user/lookingfor')
		else if (!isLoggedin) navigate('/login/user')
		else navigate('/user')
	}

	const handleBloodbankClick = () => {
		if (isLoggedin && role === 'BLOODBANK') navigate('/bloodbank')
		else navigate('/login/bloodbank')
	}

	return (
		<Container maxWidth='lg' sx={{ pb: 8 }}>
			{/* Hero Section */}
			<Paper
				elevation={0}
				sx={{
					p: { xs: 3, md: 5 },
					mb: 4,
					borderRadius: 3,
					background: 'linear-gradient(135deg, #ffffff 0%, #fff5f5 100%)',
					border: '1px solid #ffebee',
					boxShadow: '0 10px 30px rgba(198, 40, 40, 0.06)',
				}}
			>
				<Grid container spacing={3} alignItems='center'>
					<Grid item xs={12} md={8}>
						<Chip
							icon={<BloodtypeIcon sx={{ color: '#c62828 !important' }} />}
							label='Every Drop Matters. Every Life Counts.'
							sx={{
								backgroundColor: '#ffebee',
								color: '#c62828',
								fontWeight: 700,
								fontSize: '0.875rem',
								mb: 2,
								px: 1,
							}}
						/>
						<Typography
							variant='h3'
							component='h1'
							sx={{
								fontWeight: 800,
								color: '#1e293b',
								fontSize: { xs: '2rem', md: '2.75rem' },
								lineHeight: 1.2,
								mb: 2,
							}}
						>
							Namma Blood
						</Typography>
						<Typography
							variant='h6'
							sx={{
								color: '#475569',
								fontWeight: 400,
								fontSize: { xs: '1rem', md: '1.2rem' },
								mb: 3,
								maxWidth: 650,
							}}
						>
							A community-driven blood donation platform connecting donors, blood banks,
							and people in need. Making blood availability and donation services transparent,
							fast, and accessible to everyone.
						</Typography>

						<Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
							<Button
								variant='contained'
								size='large'
								startIcon={<VolunteerActivismIcon />}
								onClick={handleDonateClick}
								sx={{
									backgroundColor: '#c62828',
									color: '#ffffff',
									px: 3,
									py: 1.2,
									fontWeight: 700,
									textTransform: 'none',
									borderRadius: 2,
									boxShadow: '0 4px 14px rgba(198, 40, 40, 0.35)',
									'&:hover': {
										backgroundColor: '#b71c1c',
									},
								}}
							>
								Donate Blood
							</Button>
							<Button
								variant='outlined'
								size='large'
								startIcon={<BloodtypeIcon />}
								onClick={handleRequestClick}
								sx={{
									borderColor: '#c62828',
									color: '#c62828',
									px: 3,
									py: 1.2,
									fontWeight: 700,
									textTransform: 'none',
									borderRadius: 2,
									'&:hover': {
										borderColor: '#b71c1c',
										backgroundColor: '#ffebee',
									},
								}}
							>
								Find / Request Blood
							</Button>
							<Button
								variant='text'
								size='large'
								startIcon={<LocalHospitalIcon />}
								onClick={handleBloodbankClick}
								sx={{
									color: '#475569',
									fontWeight: 600,
									textTransform: 'none',
									'&:hover': {
										backgroundColor: '#f1f5f9',
									},
								}}
							>
								Blood Bank Portal
							</Button>
						</Stack>
					</Grid>

					<Grid item xs={12} md={4} sx={{ textAlign: 'center' }}>
						<Box
							sx={{
								p: 3,
								borderRadius: 3,
								backgroundColor: '#ffffff',
								border: '1px solid #f1f5f9',
								boxShadow: '0 8px 24px rgba(0,0,0,0.04)',
							}}
						>
							<Typography variant='overline' sx={{ color: '#c62828', fontWeight: 800, letterSpacing: '0.1em' }}>
								COMMUNITY MISSION
							</Typography>
							<Typography variant='h5' sx={{ fontWeight: 800, color: '#1e293b', my: 1 }}>
								1 Donation = Up to 3 Lives
							</Typography>
							<Typography variant='body2' sx={{ color: '#64748b', mb: 2 }}>
								Safe whole blood and platelet donations directly support trauma patients, surgeries, and cancer therapies.
							</Typography>
							<Chip
								icon={<VerifiedUserIcon />}
								label='Verified & Safe'
								color='success'
								variant='outlined'
								size='small'
							/>
						</Box>
					</Grid>
				</Grid>
			</Paper>

			{/* Three Pillars */}
			<Grid container spacing={3} sx={{ mb: 4 }}>
				<Grid item xs={12} md={4}>
					<Card
						elevation={0}
						sx={{
							p: 1,
							height: '100%',
							borderRadius: 3,
							border: '1px solid #e2e8f0',
							boxShadow: '0 4px 12px rgba(0,0,0,0.02)',
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
								<VolunteerActivismIcon />
							</Box>
							<Typography variant='h6' sx={{ fontWeight: 700, mb: 1, color: '#1e293b' }}>
								Generous Donors
							</Typography>
							<Typography variant='body2' sx={{ color: '#64748b', lineHeight: 1.6 }}>
								Schedule voluntary donations with certified blood banks in your city. Track donation history and direct community impact.
							</Typography>
						</CardContent>
					</Card>
				</Grid>

				<Grid item xs={12} md={4}>
					<Card
						elevation={0}
						sx={{
							p: 1,
							height: '100%',
							borderRadius: 3,
							border: '1px solid #e2e8f0',
							boxShadow: '0 4px 12px rgba(0,0,0,0.02)',
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
							<Typography variant='h6' sx={{ fontWeight: 700, mb: 1, color: '#1e293b' }}>
								Certified Blood Banks
							</Typography>
							<Typography variant='body2' sx={{ color: '#64748b', lineHeight: 1.6 }}>
								Manage hospital blood inventory, fulfill patient requests, and coordinate with voluntary donors efficiently.
							</Typography>
						</CardContent>
					</Card>
				</Grid>

				<Grid item xs={12} md={4}>
					<Card
						elevation={0}
						sx={{
							p: 1,
							height: '100%',
							borderRadius: 3,
							border: '1px solid #e2e8f0',
							boxShadow: '0 4px 12px rgba(0,0,0,0.02)',
						}}
					>
						<CardContent>
							<Box
								sx={{
									width: 48,
									height: 48,
									borderRadius: 2,
									backgroundColor: '#fef3c7',
									display: 'flex',
									alignItems: 'center',
									justifyContent: 'center',
									mb: 2,
									color: '#d97706',
								}}
							>
								<BloodtypeIcon />
							</Box>
							<Typography variant='h6' sx={{ fontWeight: 700, mb: 1, color: '#1e293b' }}>
								Instant Availability
							</Typography>
							<Typography variant='body2' sx={{ color: '#64748b', lineHeight: 1.6 }}>
								Quickly search compatible blood units by State and City, cutting down critical turnaround times during medical emergencies.
							</Typography>
						</CardContent>
					</Card>
				</Grid>
			</Grid>

			{/* Compatibility Matrix Section */}
			<Paper
				elevation={0}
				sx={{
					p: { xs: 2, md: 3 },
					borderRadius: 3,
					border: '1px solid #e2e8f0',
					boxShadow: '0 4px 12px rgba(0,0,0,0.02)',
					backgroundColor: '#ffffff',
				}}
			>
				<Box sx={{ mb: 2 }}>
					<Typography variant='h6' sx={{ fontWeight: 700, color: '#1e293b' }}>
						Blood Group Compatibility Guide
					</Typography>
					<Typography variant='body2' sx={{ color: '#64748b' }}>
						Reference guide for compatible donor and recipient blood types.
					</Typography>
				</Box>
				<BloodCompatible />
			</Paper>
		</Container>
	)
}

export default Home
