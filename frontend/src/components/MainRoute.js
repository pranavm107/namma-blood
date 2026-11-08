import React from 'react'
import { Route, Routes } from 'react-router-dom'
import Layout from './Layout'
import Login from './Auth/Login'
import UserSignup from './User/UserSignup'
import Home from './Common/Home'
import Aboutus from './Common/AboutUs'
import ContactUs from './Common/ContactUs'
import WantToDonate from './User/WantToDonate/WantToDonate'
import LookingForBlood from './User/LookingForBlood/LookingForBlood'
import PageNotFound from './PageNotFound'
import DonorRequests from '../components/BloodBank/DonorRequests/DonorRequests'
import ReceiveRequests from '../components/BloodBank/ReceiveRequests/ReceiveRequests'
import UserProfile from './User/UserProfile'
import UserHome from './User/UserHome'
import BloodbankHome from './BloodBank/BloodbankHome'
import BloodStock from './BloodBank/BloodSock/BloodStock'
import DonateRequestStatesU from './User/DonateRequestStatesU'
import ReceiveRequestStatesU from './User/ReceiveRequestStatesU'
import DonateRequestStatesB from './BloodBank/DonateRequestStatesB'
import ReceiveRequestStatesB from './BloodBank/ReceiveRequestStatesB'
import AdminHome from './Admin/AdminHome'
import BloodbankList from './Admin/BloodbankList'
import AddBloodbank from './Admin/AddBloodbank'
import BulkImport from './Admin/BulkImport'
import ForgotPassword from './Auth/ForgotPassword'
import ResetPassword from './Auth/ResetPassword'
import TraceableInventoryDashboard from './BloodBank/TraceableInventory/TraceableInventoryDashboard'
import ReconciliationDashboard from './BloodBank/Reconciliation/ReconciliationDashboard'
import ProtectedRoute from './Auth/ProtectedRoute'
import EmergencyRequestPage from './User/Emergency/EmergencyRequestPage'
import EmergencyDiscoveryPage from './User/Emergency/EmergencyDiscoveryPage'
import EmergencyMatchingDashboard from './User/Emergency/EmergencyMatchingDashboard'
import MedicalOfficerLayout from './MedicalOfficer/MedicalOfficerLayout'
import MedicalOfficerDashboard from './MedicalOfficer/MedicalOfficerDashboard'
import PendingRequestsPage from './MedicalOfficer/PendingRequestsPage'
import VerifiedRequestsPage from './MedicalOfficer/VerifiedRequestsPage'
import RejectedRequestsPage from './MedicalOfficer/RejectedRequestsPage'
import EmergencyRequestReviewPage from './MedicalOfficer/EmergencyRequestReviewPage'
import HospitalDirectory from './Admin/HospitalDirectory'
import RegisterHospital from './Admin/RegisterHospital'
import HospitalDetails from './Admin/HospitalDetails'
import MedicalOfficerManagement from './Admin/MedicalOfficerManagement'
import MedicalOfficerRegister from './MedicalOfficer/MedicalOfficerRegister'

const MainRoute = () => {
	return (
		<Routes>
			<Route element={<Layout />}>
				{/* Public Routes */}
				<Route path='/' element={<Home />} />
				<Route path='/login/:role' element={<Login />} />
				<Route path='/user/signup' element={<UserSignup />} />
				<Route path='/medical-officer/register' element={<MedicalOfficerRegister />} />
				<Route path='/medical-officers/register' element={<MedicalOfficerRegister />} />
				<Route path='/forgotpassword/:role' element={<ForgotPassword />} />
				<Route path='/aboutus' element={<Aboutus />} />
				<Route path='/contactUs' element={<ContactUs />} />

				{/* Emergency Services (Shared between USER and ADMIN oversight) */}
				<Route element={<ProtectedRoute allowedRoles={['USER', 'ADMIN']} />}>
					<Route path='/user/emergency-request' element={<EmergencyRequestPage />} />
					<Route path='/user/emergency-discovery' element={<EmergencyDiscoveryPage />} />
					<Route path='/user/emergency-matches' element={<EmergencyMatchingDashboard />} />
					<Route path='/user/emergency-requests/:id/matches' element={<EmergencyMatchingDashboard />} />
				</Route>

				{/* Protected User Routes */}
				<Route element={<ProtectedRoute allowedRoles={['USER']} />}>
					<Route path='/user'>
						<Route path='' element={<UserHome />} />
						<Route path='donaterequestsstates' element={<DonateRequestStatesU />} />
						<Route path='receiverequestsstates' element={<ReceiveRequestStatesU />} />
						<Route path='wanttodonate' element={<WantToDonate />} />
						<Route path='lookingfor' element={<LookingForBlood />} />
						<Route path='aboutus' element={<Aboutus />} />
						<Route path='profile' element={<UserProfile />} />
						<Route path='*' element={<UserHome />} />
					</Route>
				</Route>

				{/* Protected Blood Bank & Staff Routes */}
				<Route element={<ProtectedRoute allowedRoles={['BLOODBANK', 'STAFF']} />}>
					<Route path='/bloodbank'>
						<Route path='' element={<BloodbankHome />} />
						<Route path='donaterequestsstates' element={<DonateRequestStatesB />} />
						<Route path='receiverequestsstates' element={<ReceiveRequestStatesB />} />
						<Route path='donorrequests' element={<DonorRequests />} />
						<Route path='receiverequests' element={<ReceiveRequests />} />
						<Route path='stock' element={<BloodStock />} />
						<Route path='inventory' element={<TraceableInventoryDashboard />} />
						<Route path='reconciliation' element={<ReconciliationDashboard />} />
						<Route path='emergency-requests/:id/matches' element={<EmergencyMatchingDashboard />} />
						<Route path='aboutus' element={<Aboutus />} />
						<Route path='*' element={<PageNotFound />} />
					</Route>
				</Route>

				{/* Protected Admin Routes */}
				<Route element={<ProtectedRoute allowedRoles={['ADMIN']} />}>
					<Route path='/admin'>
						<Route path='' element={<AdminHome />} />
						<Route path='bloodbanks' element={<BloodbankList />} />
						<Route path='addbloodbank' element={<AddBloodbank />} />
						<Route path='hospitals' element={<HospitalDirectory />} />
						<Route path='hospitals/register' element={<RegisterHospital />} />
						<Route path='hospitals/:id' element={<HospitalDetails />} />
						<Route path='medical-officers' element={<MedicalOfficerManagement />} />
						<Route path='bulk-import' element={<BulkImport />} />
						<Route path='emergency-requests/:id/matches' element={<EmergencyMatchingDashboard />} />
						<Route path='aboutus' element={<Aboutus />} />
						<Route path='*' element={<PageNotFound />} />
					</Route>
				</Route>

				{/* Protected Medical Officer Routes */}
				<Route element={<ProtectedRoute allowedRoles={['MEDICAL_OFFICER']} />}>
					<Route path='/medical-officer' element={<MedicalOfficerLayout />}>
						<Route index element={<MedicalOfficerDashboard />} />
						<Route path='pending' element={<PendingRequestsPage />} />
						<Route path='verified' element={<VerifiedRequestsPage />} />
						<Route path='rejected' element={<RejectedRequestsPage />} />
						<Route path='requests/:id' element={<EmergencyRequestReviewPage />} />
						<Route path='*' element={<MedicalOfficerDashboard />} />
					</Route>
				</Route>

				{/* Fallback Unhandled Route */}
				<Route path='*' element={<PageNotFound />} />
			</Route>

			{/* Standalone Route without Layout */}
			<Route path='/resetpassword/:token/:role' element={<ResetPassword />} />
		</Routes>
	)
}

export default MainRoute
