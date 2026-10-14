import React from 'react'
import logo from '../image/blooddroplogo.png'
import {
	Avatar,
	Box,
	Chip,
	Paper,
	Table,
	TableBody,
	TableCell,
	TableContainer,
	TableHead,
	TableRow,
	Typography,
} from '@mui/material'

const compatibilityData = [
	['O-', true, false, false, false, false, false, false, false],
	['O+', true, true, false, false, false, false, false, false],
	['A-', true, false, true, false, false, false, false, false],
	['A+', true, true, true, true, false, false, false, false],
	['B-', true, false, false, false, true, false, false, false],
	['B+', true, true, false, false, true, true, false, false],
	['AB-', true, false, true, false, true, false, true, false],
	['AB+', true, true, true, true, true, true, true, true],
]

const BloodCompatible = () => {
	return (
		<Paper elevation={0} sx={{ borderRadius: 2, overflow: 'hidden', border: '1px solid #e2e8f0' }}>
			<TableContainer>
				<Table size='small' aria-label='blood compatibility matrix'>
					<TableHead>
						<TableRow sx={{ backgroundColor: '#fff5f5' }}>
							<TableCell align='left' sx={{ fontWeight: 700, color: '#b71c1c', py: 1.5 }}>
								Recipient (Blood Group)
							</TableCell>
							<TableCell align='center' colSpan={8} sx={{ fontWeight: 700, color: '#b71c1c', py: 1.5 }}>
								Compatible Donors
							</TableCell>
						</TableRow>
						<TableRow sx={{ backgroundColor: '#f8fafc' }}>
							<TableCell sx={{ fontWeight: 600, color: '#475569' }}>Blood Type</TableCell>
							<TableCell align='center' sx={{ fontWeight: 600, color: '#475569' }}>O-</TableCell>
							<TableCell align='center' sx={{ fontWeight: 600, color: '#475569' }}>O+</TableCell>
							<TableCell align='center' sx={{ fontWeight: 600, color: '#475569' }}>A-</TableCell>
							<TableCell align='center' sx={{ fontWeight: 600, color: '#475569' }}>A+</TableCell>
							<TableCell align='center' sx={{ fontWeight: 600, color: '#475569' }}>B-</TableCell>
							<TableCell align='center' sx={{ fontWeight: 600, color: '#475569' }}>B+</TableCell>
							<TableCell align='center' sx={{ fontWeight: 600, color: '#475569' }}>AB-</TableCell>
							<TableCell align='center' sx={{ fontWeight: 600, color: '#475569' }}>AB+</TableCell>
						</TableRow>
					</TableHead>
					<TableBody>
						{compatibilityData.map((row, index) => (
							<TableRow
								key={index}
								sx={{
									'&:nth-of-type(odd)': { backgroundColor: '#ffffff' },
									'&:nth-of-type(even)': { backgroundColor: '#fcfcfc' },
									'&:hover': { backgroundColor: '#fff8f8' },
								}}
							>
								{row.map((val, cellIdx) => {
									if (cellIdx === 0) {
										return (
											<TableCell key={cellIdx} align='left' sx={{ fontWeight: 700, color: '#1e293b' }}>
												<Chip
													label={val}
													size='small'
													sx={{
														backgroundColor: '#ffebee',
														color: '#c62828',
														fontWeight: 700,
													}}
												/>
											</TableCell>
										)
									}
									return (
										<TableCell key={cellIdx} align='center'>
											{val === true ? (
												<Box sx={{ display: 'flex', justifyContent: 'center' }}>
													<Avatar
														alt='Compatible'
														src={logo}
														sx={{ width: 22, height: 22 }}
													/>
												</Box>
											) : (
												<Typography variant='caption' sx={{ color: '#cbd5e1' }}>
													—
												</Typography>
											)}
										</TableCell>
									)
								})}
							</TableRow>
						))}
					</TableBody>
				</Table>
			</TableContainer>
		</Paper>
	)
}

export default BloodCompatible
