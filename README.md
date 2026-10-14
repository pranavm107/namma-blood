# Namma Blood — Blood Donation Platform

> **Tagline:** Every Drop Matters. Every Life Counts.  
> **Repository:** `namma-blood`

A community-driven blood donation platform connecting donors, blood banks, and people in need. Built to make blood availability and donation services transparent, fast, and accessible to everyone.

---

## 📌 Project Overview

**Namma Blood** solves the critical challenge of locating compatible blood units and scheduling voluntary donations without delays. In critical healthcare emergencies, every minute matters. This platform bridges donors, accredited blood banks, and hospitals through real-time inventory visibility and direct communication.

### Key Objectives
- **Accessibility:** Easy-to-use interface tailored for donors of all age groups.
- **Real-time Inventory:** Enable hospitals and certified blood banks to maintain accurate blood stock.
- **Safe Coordination:** Direct appointment requests for donors and status tracking for patients.
- **Security & Integrity:** Cryptographically hashed passwords and role-based access control.

---

## 👥 User Roles & Features

### 1. Donors & Recipients (Users)
- **Voluntary Blood Donation:** Search accredited blood banks by State and City to schedule donation requests.
- **Blood Availability Requests:** Request specific blood groups (A+, A-, B+, B-, AB+, AB-, O+, O-) for emergency medical needs.
- **Live Status Tracking:** Track donation and recipient request stages (`Pending`, `Accepted`, `Fulfilled`, `Rejected`).
- **Blood Group Compatibility Matrix:** Interactive guide detailing universal donor and recipient relationships.

### 2. Blood Bank Partners
- **Inventory Management:** Update real-time unit availability across blood groups and components.
- **Incoming Donor Requests:** Review voluntary donor requests, schedule appointments, and fulfill donations.
- **Patient Requests Queue:** Verify and fulfill emergency patient requests received from hospitals and families.
- **Activity Dashboard:** Visual breakdown of active, completed, and pending requests.

### 3. Platform Administrators
- **Partner Accreditation:** Onboard accredited hospitals and blood banks with state, city, and category metadata.
- **Directory Supervision:** Supervise partner compliance and directory listings.
- **System Integrity:** Secure JWT-based administrative endpoints.

---

## 🛠 Technology Stack

| Layer | Technologies |
|---|---|
| **Frontend** | React 18, Redux Toolkit, React Router v6, Material-UI (MUI v5), Emotion, Formik, Yup, React-Toastify |
| **Backend** | Node.js (v20 LTS), Express.js, Mongoose, Morgan |
| **Database** | MongoDB (Atlas / Local) |
| **Security & Auth** | JSON Web Tokens (JWT), Bcrypt.js, Crypto |
| **Notifications** | Nodemailer (SMTP / Gmail) |
| **Styling** | Custom CSS variables, Plus Jakarta Sans, Responsive Material-UI grid system |

---

## 📂 Project Structure

```text
namma-blood/
├── backend/
│   ├── Admin/               # Admin controller, middleware, model, and routes
│   ├── BloodBank/           # Blood Bank controller, middleware, model, and routes
│   ├── BloodDonate/         # Donation request controller, model, and routes
│   ├── BloodReceive/        # Recipient request controller, model, and routes
│   ├── BloodStock/          # Stock inventory controller, model, and routes
│   ├── City/                # City directory controller and routes
│   ├── Common/              # Shared input validation and model selection
│   ├── ContactUs/           # Feedback & inquiry submission handlers
│   ├── Login_And_Authentication/ # JWT verification, login, password reset
│   ├── State/               # State directory controller and routes
│   ├── User/                # User/donor controller, middleware, and routes
│   ├── Utils/               # Async handler, AppError, email templates
│   ├── app.js               # Express app configuration & middleware
│   ├── index.js             # Server entry point & database connection
│   ├── package.json         # Backend dependencies & scripts
│   └── .env.example         # Backend environment template
├── frontend/
│   ├── public/              # HTML template, manifest, icons
│   ├── src/
│   │   ├── components/      # UI, Auth, Admin, BloodBank, User components
│   │   ├── hooks/           # Route protection hooks
│   │   ├── store/           # Redux Toolkit slices (auth, stock, requests)
│   │   ├── App.js           # Route definitions & layout wrappers
│   │   ├── index.js         # React entry point
│   │   └── index.css        # Global CSS design tokens
│   ├── package.json         # Frontend dependencies & scripts
│   └── .env.example         # Frontend environment template
├── .gitignore               # Root exclusion rules
└── README.md                # Project documentation
```

---

## ⚙️ Prerequisites

- **Node.js**: v20.x LTS (Recommended via [nvm](https://github.com/nvm-sh/nvm))
- **npm**: v10.x or later
- **MongoDB**: Active MongoDB Atlas cluster or local MongoDB instance

---

## 🚀 Installation & Setup

### 1. Clone the Repository
```bash
git clone https://github.com/pranavm107/namma-blood.git
cd namma-blood
```

### 2. Configure Environment Variables

#### Backend Configuration
Copy the template into `backend/.env`:
```bash
cp backend/.env.example backend/.env
```
Edit `backend/.env`:
```env
PORT=5050
database_url=your_mongodb_connection_string
PASSWORD_ENCRYPT_LEVEL=12
CREATEHASH_KEY=sha256
JWT_SECRET=your_super_secret_jwt_key_min_32_characters
JWT_EXPIRES_IN=1d
EMAIL_USERNAME=your_email@gmail.com
EMAIL_PASSWORD=your_gmail_app_password
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
```

> **Note on Port 5050:** Port `5050` is chosen to avoid macOS port `5000` conflicts with AirPlay Receiver (ControlCenter).

#### Frontend Configuration
Copy the template into `frontend/.env`:
```bash
cp frontend/.env.example frontend/.env
```
Ensure `frontend/.env` points to the backend:
```env
REACT_APP_BASEURL=http://127.0.0.1:5050/api
```

---

### 3. Install Dependencies

#### Backend
```bash
cd backend
npm install
```

#### Frontend
```bash
cd ../frontend
npm install
```

---

## 💻 Running the Application

### Start Backend Server
```bash
cd backend
npm start
```
*Backend runs at: `http://localhost:5050`*

### Start Frontend Client
In a separate terminal:
```bash
cd frontend
npm start
```
*Frontend runs at: `http://localhost:3000`*

---

## 🧪 API Endpoints Reference

| Method | Endpoint | Description | Access |
|---|---|---|---|
| `POST` | `/api/user/register` | Register as Donor / Recipient | Public |
| `POST` | `/api/user/login` | Sign in as Donor / Recipient | Public |
| `POST` | `/api/admin/login` | Administrator sign in | Public |
| `POST` | `/api/admin/register` | Register new platform administrator | Admin |
| `POST` | `/api/bloodbank/register` | Onboard new partner blood bank | Admin |
| `POST` | `/api/bloodbank/login` | Sign in as partner blood bank | Public |
| `GET` | `/api/state` | Fetch state list | Public |
| `GET` | `/api/city/getcitybystatename/:state` | Fetch cities by state | Public |
| `GET` | `/api/bloodstock` | Query real-time blood stock | Authenticated |
| `POST` | `/api/donaterequests` | Submit voluntary donation appointment | User |
| `POST` | `/api/receiverequests` | Submit emergency blood unit request | User |
| `POST` | `/api/contactus` | Submit user message / support query | Public |

---

## 🔒 Security Best Practices

- **Zero Credentials in Git:** All secrets, MongoDB URLs, and passwords are strictly excluded via `.gitignore`.
- **Stateless Tokens:** Protected routes require `Bearer <token>` headers validated via JWT middleware.
- **Input Sanitization:** Client-side Formik/Yup schemas backed by server-side regex and Mongoose validations.

---

## 🗺 Future Roadmap

- [ ] SMS / WhatsApp notifications for urgent blood requests in matching pincodes.
- [ ] Geo-location mapping for nearest blood bank directions.
- [ ] Donor milestone badges and digital recognition certificates.
- [ ] Emergency SOS broadcast for critical rare blood types (e.g., Bombay blood group).

---

## 📄 License

This project is licensed under the ISC License.
