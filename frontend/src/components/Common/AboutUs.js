import React from 'react'
import {
	Box,
	Card,
	Chip,
	Container,
	Grid,
	Paper,
	Typography,
} from '@mui/material'
import aboutusImg from '../../image/aboutus.avif'
import BloodtypeIcon from '@mui/icons-material/Bloodtype'
import HealthAndSafetyIcon from '@mui/icons-material/HealthAndSafety'
import PeopleIcon from '@mui/icons-material/People'
import SpeedIcon from '@mui/icons-material/Speed'

const AboutUs = () => {
	return (
		<Container maxWidth='lg' sx={{ pb: 8 }}>
			<Paper
				elevation={0}
				sx={{
					p: { xs: 3, md: 5 },
					borderRadius: 3,
					background: 'linear-gradient(135deg, #ffffff 0%, #fff8f8 100%)',
					border: '1px solid #ffebee',
					mb: 4,
				}}
			>
				<Chip
					label='ABOUT OUR PLATFORM'
					sx={{
						backgroundColor: '#ffebee',
						color: '#c62828',
						fontWeight: 700,
						fontSize: '0.75rem',
						letterSpacing: '0.08em',
						mb: 2,
					}}
				/>
				<Typography variant='h3' component='h1' sx={{ fontWeight: 800, color: '#1e293b', mb: 2 }}>
					About Namma Blood
				</Typography>
				<Typography variant='h6' sx={{ color: '#c62828', fontWeight: 600, mb: 3 }}>
					Every Drop Matters. Every Life Counts.
				</Typography>
				<Typography variant='body1' sx={{ color: '#475569', lineHeight: 1.8, maxWidth: 850 }}>
					Namma Blood is a community-driven blood donation and inventory platform designed to bridge the
					critical gap between generous donors, accredited blood banks, and patients needing life-saving
					transfusions. We leverage technology to replace delays and uncertainty with rapid, real-time
					coordination.
				</Typography>
			</Paper>

			<Grid container spacing={4} sx={{ mb: 4 }} alignItems='center'>
				<Grid item xs={12} md={5}>
					<Card
						elevation={0}
						sx={{
							borderRadius: 3,
							overflow: 'hidden',
							border: '1px solid #e2e8f0',
							boxShadow: '0 8px 24px rgba(0,0,0,0.06)',
						}}
					>
						<Box
							component='img'
							src={aboutusImg}
							alt='Namma Blood Community'
							sx={{
								width: '100%',
								height: 'auto',
								maxHeight: 340,
								objectFit: 'cover',
								display: 'block',
							}}
						/>
					</Card>
				</Grid>

				<Grid item xs={12} md={7}>
					<Typography variant='h5' sx={{ fontWeight: 700, color: '#1e293b', mb: 2 }}>
						What Drives Namma Blood?
					</Typography>
					<Typography variant='body1' sx={{ color: '#475569', lineHeight: 1.8, mb: 3 }}>
						Every two seconds, someone in our country requires blood. Whether it is an emergency trauma,
						complex surgical procedure, or chronic conditions like thalassemia, timely availability of
						tested blood units saves precious lives. Namma Blood ensures that no emergency goes unanswered
						due to lack of information.
					</Typography>

					<Grid container spacing={2}>
						<Grid item xs={12} sm={6}>
							<Box sx={{ display: 'flex', gap: 1.5 }}>
								<HealthAndSafetyIcon sx={{ color: '#c62828', fontSize: 28 }} />
								<Box>
									<Typography variant='subtitle2' sx={{ fontWeight: 700, color: '#1e293b' }}>
										Safe & Certified
									</Typography>
									<Typography variant='caption' sx={{ color: '#64748b' }}>
										All partnering blood banks follow stringent testing and storage protocols.
									</Typography>
								</Box>
							</Box>
						</Grid>

						<Grid item xs={12} sm={6}>
							<Box sx={{ display: 'flex', gap: 1.5 }}>
								<SpeedIcon sx={{ color: '#0284c7', fontSize: 28 }} />
								<Box>
									<Typography variant='subtitle2' sx={{ fontWeight: 700, color: '#1e293b' }}>
										Fast Turnaround
									</Typography>
									<Typography variant='caption' sx={{ color: '#64748b' }}>
										Search city-level inventory to locate compatible blood units immediately.
									</Typography>
								</Box>
							</Box>
						</Grid>

						<Grid item xs={12} sm={6}>
							<Box sx={{ display: 'flex', gap: 1.5 }}>
								<PeopleIcon sx={{ color: '#16a34a', fontSize: 28 }} />
								<Box>
									<Typography variant='subtitle2' sx={{ fontWeight: 700, color: '#1e293b' }}>
										Donor Community
									</Typography>
									<Typography variant='caption' sx={{ color: '#64748b' }}>
										Empowering voluntary donors with direct appointment requests and tracking.
									</Typography>
								</Box>
							</Box>
						</Grid>

						<Grid item xs={12} sm={6}>
							<Box sx={{ display: 'flex', gap: 1.5 }}>
								<BloodtypeIcon sx={{ color: '#d97706', fontSize: 28 }} />
								<Box>
									<Typography variant='subtitle2' sx={{ fontWeight: 700, color: '#1e293b' }}>
										Compatibility Support
									</Typography>
									<Typography variant='caption' sx={{ color: '#64748b' }}>
										Clear guidance for all ABO and Rh blood types and rare components.
									</Typography>
								</Box>
							</Box>
						</Grid>
					</Grid>
				</Grid>
			</Grid>
		</Container>
	)
}

export default AboutUs
