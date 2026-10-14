import React from 'react'
import { Box, Button, Container, Paper, Typography } from '@mui/material'
import { useNavigate } from 'react-router-dom'
import HomeIcon from '@mui/icons-material/Home'
import pageNotFoundImg from '../image/5203299.jpg'

const PageNotFound = () => {
	const navigate = useNavigate()

	const goBackHandler = () => {
		navigate('/')
	}

	return (
		<Container maxWidth='md' sx={{ py: 6, display: 'flex', justifyContent: 'center' }}>
			<Paper
				elevation={0}
				sx={{
					p: { xs: 3, md: 5 },
					borderRadius: 3,
					border: '1px solid #e2e8f0',
					backgroundColor: '#ffffff',
					boxShadow: '0 8px 30px rgba(0, 0, 0, 0.04)',
					textAlign: 'center',
					maxWidth: 600,
					width: '100%',
				}}
			>
				<Box
					component='img'
					src={pageNotFoundImg}
					alt='Page Not Found'
					sx={{
						width: '100%',
						maxWidth: 320,
						height: 'auto',
						mb: 3,
						borderRadius: 2,
					}}
				/>
				<Typography variant='h4' component='h1' sx={{ fontWeight: 800, color: '#1e293b', mb: 1 }}>
					Page Not Found
				</Typography>
				<Typography variant='body1' sx={{ color: '#64748b', mb: 3 }}>
					The page you are trying to access does not exist or may have been moved.
				</Typography>
				<Button
					variant='contained'
					startIcon={<HomeIcon />}
					onClick={goBackHandler}
					sx={{
						backgroundColor: '#c62828',
						fontWeight: 700,
						textTransform: 'none',
						py: 1.2,
						px: 3,
						borderRadius: 2,
						boxShadow: '0 4px 12px rgba(198, 40, 40, 0.3)',
						'&:hover': {
							backgroundColor: '#b71c1c',
						},
					}}
				>
					Return to Namma Blood Home
				</Button>
			</Paper>
		</Container>
	)
}

export default PageNotFound
