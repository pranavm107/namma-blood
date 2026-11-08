# Namma Blood — Phase 4.3 API Manual Testing Guide

This guide provides end-to-end instructions for manual API testing of **Phase 4.3 (Emergency Blood Connection & Authentication)** using the included Postman collection and environment.

---

## 1. Deliverable Assets

The following testing artifacts are located in `docs/postman/`:

| Artifact | File Path | Description |
|---|---|---|
| **Postman Collection** | [`Namma_Blood_Phase_4.3.postman_collection.json`](./Namma_Blood_Phase_4.3.postman_collection.json) | Complete collection (v2.1.0) with positive/negative test suites for all 7 endpoints, automatic token capture, and schema validation. |
| **Postman Environment** | [`Namma_Blood_Local.postman_environment.json`](./Namma_Blood_Local.postman_environment.json) | Environment containing `baseUrl`, `token`, and `requestId`. |
| **Testing Guide** | [`API_TESTING_GUIDE.md`](./API_TESTING_GUIDE.md) | Technical reference, prerequisites, execution workflows, and known gaps. |

---

## 2. API Endpoints Covered

| # | HTTP Method | Endpoint Path | Auth Required | Description |
|---|---|---|---|---|
| 1 | `POST` | `/api/user/login` | No | Authenticates regular user (donor/recipient); issues JWT. |
| 2 | `POST` | `/api/admin/login` | No | Authenticates platform system administrator; issues JWT. |
| 3 | `POST` | `/api/bloodbank/login` | No | Authenticates registered blood bank facility; issues JWT. |
| 4 | `POST` | `/api/bloodbank/staff/login` | No | Authenticates active blood bank staff member; issues JWT with role claim. |
| 5 | `GET` | `/api/emergency/discover/donors` | Yes (Bearer) | Discovers nearby emergency donors with presumptive immunohematology matching and Privacy Shield sanitization. |
| 6 | `GET` | `/api/emergency/discover/bloodbanks` | Yes (Bearer) | Discovers nearby blood banks with verified Phase 3 traceable inventory status. |
| 7 | `GET` | `/api/emergency/requests/:id/matches` | Yes (Bearer) | Dual-stream matching engine for verified emergency requests with independent candidate pagination. |

---

## 3. Postman Configuration & Variables

### Variables Configured

| Variable | Scope | Type | Default Value | Description |
|---|---|---|---|---|
| `baseUrl` | Environment / Collection | String | `http://localhost:5050` | Server host and port (`backend/.env` specifies `PORT=5050`). |
| `token` | Environment | Secret | `""` (Empty by default) | JWT Bearer token extracted automatically upon successful login. |
| `requestId` | Environment | String | `""` (Empty by default) | Valid verified emergency request MongoDB ObjectId or `requestNumber`. |

### Automated Token Capture

Every successful login endpoint (`POST /api/user/login`, `POST /api/admin/login`, `POST /api/bloodbank/login`, and `POST /api/bloodbank/staff/login`) returns a response containing the top-level property `token`:

```json
{
  "message": "Login Successfully.",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

The Postman test script executes automatically on all 4 login requests:

```javascript
pm.test("Status code is 200 OK", function () {
    pm.response.to.have.status(200);
});

pm.test("Extract token to environment", function () {
    var jsonData = pm.response.json();
    pm.expect(jsonData).to.have.property("token");
    pm.environment.set("token", jsonData.token);
});
```

All protected requests in folders `02`, `03`, and `04` inherit collection-level Bearer authentication using `Bearer {{token}}`.

---

## 4. Query Parameters & Request Specifications

### 4.1 Discovery: Donors (`GET /api/emergency/discover/donors`)

* **Authentication:** Unified `protectEmergencyAuth` (accepts valid User, Admin, Blood Bank, or Staff tokens).
* **Rate Limit:** 30 requests per minute per IP / authenticated account (`discoveryRateLimiter`).

| Parameter | Type | Required | Allowed Values / Constraints | Example |
|---|---|---|---|---|
| `bloodGroup` | String | **Yes** | `A_Positive`, `A_Negative`, `B_Positive`, `B_Negative`, `AB_Positive`, `AB_Negative`, `O_Positive`, `O_Negative` | `B_Positive` |
| `componentType` | String | No | `Whole_Blood`, `Packed_Red_Blood_Cells`, `Fresh_Frozen_Plasma`, `Platelet_Concentrate`, `Cryoprecipitate` (Defaults to `Packed_Red_Blood_Cells`) | `Packed_Red_Blood_Cells` |
| `latitude` | Number | Conditional* | Between `-90` and `+90` | `12.9716` |
| `longitude` | Number | Conditional* | Between `-180` and `+180` | `77.5946` |
| `radiusKm` | Number | No | `1` to `50` km (Defaults to `15`) | `15` |
| `city` | String | Conditional* | Max 100 characters (Used when coordinates omitted) | `Bengaluru` |
| `state` | String | Conditional* | Max 100 characters (Used when coordinates omitted) | `Karnataka` |
| `page` | Integer | No | Positive integer `>= 1` (Defaults to `1`) | `1` |
| `limit` | Integer | No | `1` to `50` (Defaults to `10`) | `10` |

*\*Location Rule: Either both `latitude` and `longitude` must be provided, OR at least one of `city`/`state` must be provided.*

### 4.2 Discovery: Blood Banks (`GET /api/emergency/discover/bloodbanks`)

* **Authentication:** Unified `protectEmergencyAuth`.
* **Rate Limit:** 30 requests per minute.

| Parameter | Type | Required | Constraints | Example |
|---|---|---|---|---|
| `bloodGroup` | String | No | Optional filter for stock verification. | `B_Positive` |
| `componentType` | String | No | Optional component filter. | `Packed_Red_Blood_Cells` |
| `latitude` | Number | Conditional* | Between `-90` and `+90` | `12.9716` |
| `longitude` | Number | Conditional* | Between `-180` and `+180` | `77.5946` |
| `radiusKm` | Number | No | `1` to `50` km (Defaults to `15`) | `15` |
| `city` | String | Conditional* | Administrative fallback | `Bengaluru` |
| `state` | String | Conditional* | Administrative fallback | `Karnataka` |
| `page` | Integer | No | `>= 1` | `1` |
| `limit` | Integer | No | `1` to `50` | `10` |

### 4.3 Request Matching (`GET /api/emergency/requests/:id/matches`)

* **Identifier (`:id`):** 24-character hexadecimal MongoDB ObjectId string OR human-readable request number (e.g., `EMG-20261102-ABC123`).
* **Independent Pagination Parameters:**

| Parameter | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `radiusKm` | Number | No | `1` to `50` km (Default: `15`) | Proximity radius around hospital location. |
| `donorPage` | Integer | No | `>= 1` (Default: `1`) | Independent page index for candidate donor stream. |
| `donorLimit` | Integer | No | `1` to `50` (Default: `10`) | Independent page size for candidate donor stream. |
| `bankPage` | Integer | No | `>= 1` (Default: `1`) | Independent page index for blood bank candidate stream. |
| `bankLimit` | Integer | No | `1` to `50` (Default: `10`) | Independent page size for blood bank candidate stream. |

---

## 5. How to Obtain a Valid Verified Emergency Request ID

### Why Direct Endpoint Creation is Not Available

The Namma Blood backend does **not** currently implement an HTTP request creation endpoint (e.g. `POST /api/emergency/requests` does not exist). Phase 4.3 implements the **candidate matching engine** and **discovery layer** over existing emergency requests.

### Clinical & Authorization Requirements for Matching

For an emergency request to be matchable and accessible via `GET /api/emergency/requests/:id/matches`, the document in MongoDB must satisfy all of the following invariants:

1. **Verification Gate:** `verificationStatus === 'Verified'` (`Pending_Verification`, `Rejected`, or `Flagged_Suspicious` fail with HTTP 400).
2. **Lifecycle Gate:** `status` must be `'Active'` or `'Partially_Reserved'` (terminal states like `Fully_Reserved`, `In_Transit`, `Fulfilled`, `Cancelled`, `Expired` fail with HTTP 400).
3. **Temporal Validity:** `expiresAt > new Date()` (expired requests fail with HTTP 400).
4. **Shortfall Data Integrity:**
   - `unitsReserved === reservedUnitIds.length`
   - `unitsReserved + unitsFulfilled <= unitsRequested`
   - `unitsRequested >= 1`
5. **Access Control (BOLA/IDOR):**
   - **System Administrator:** Can match any valid emergency request.
   - **User:** Can match only requests where `request.requesterUserId.toString() === req.user._id.toString()`.
   - **Blood Bank / Staff:** Can match only requests where their facility ID appears in `request.matchedBloodbankIds`.
   - *Any unauthorized access attempt fails with an anti-enumeration **404 REQUEST_NOT_FOUND**.*

### Option A: Querying an Existing Verified Request in Local Database

Run this query in your MongoDB shell (`mongosh`) to locate an eligible request:

```javascript
use namma_blood_dev;

db.emergencybloodrequests.findOne(
  {
    verificationStatus: "Verified",
    status: { $in: ["Active", "Partially_Reserved"] },
    expiresAt: { $gt: new Date() }
  },
  { _id: 1, requestNumber: 1, requesterUserId: 1, matchedBloodbankIds: 1 }
);
```

*Copy the `_id` string (e.g. `672a1b2c3d4e5f6789012345`) or `requestNumber` into Postman's `{{requestId}}` variable.*

### Option B: Seeding a Synthetic Verified Request for Development Testing

In development or staging environments, QA engineers can insert a synthetic verified request directly into MongoDB.

Using `mongosh`:

```javascript
use namma_blood_dev;

// 1. Fetch an existing test user ID
var testUser = db.users.findOne({ email: "synthetic_user@example.com" }) || db.users.findOne();
var testUserId = testUser ? testUser._id : new ObjectId();

// 2. Insert verified active emergency request
var newRequest = {
  requestNumber: "EMG-20261106-SYNTH1",
  requesterUserId: testUserId,
  patientName: "Synthetic QA Patient",
  patientAge: 42,
  patientGender: "Female",
  requiredBloodGroup: "B_Positive",
  requiredComponent: "Packed_Red_Blood_Cells",
  unitsRequested: 3,
  unitsReserved: 0,
  unitsFulfilled: 0,
  reservedUnitIds: [],
  urgencyLevel: "Critical",
  requiredWithinHours: 4,
  expiresAt: new Date(Date.now() + 4 * 3600 * 1000), // Valid for 4 hours
  hospitalName: "Bengaluru Victoria General Hospital",
  hospitalAddress: "Fort Road, KR Market",
  hospitalCity: "Bengaluru",
  hospitalState: "Karnataka",
  hospitalPinCode: 560002,
  location: {
    type: "Point",
    coordinates: [77.5946, 12.9716] // [longitude, latitude]
  },
  attendingDoctor: {
    doctorName: "Dr. Ramesh Chandra",
    doctorPhone: "9876543210",
    registrationNumber: "KMC-45123"
  },
  matchedBloodbankIds: [],
  verificationStatus: "Verified", // Gate Requirement
  status: "Active",              // Gate Requirement
  createdAt: new Date(),
  updatedAt: new Date()
};

var insertResult = db.emergencybloodrequests.insertOne(newRequest);
print("Created Verified Request ID: " + insertResult.insertedId.str);
print("Use Request Number: " + newRequest.requestNumber);
```

Set `requestId` in Postman to the resulting `insertedId` string or `EMG-20261106-SYNTH1`.

---

## 6. Step-by-Step Testing Workflow

### Step 1: Import Collection and Environment into Postman

1. Open Postman.
2. Click **Import** (top left).
3. Select `docs/postman/Namma_Blood_Phase_4.3.postman_collection.json` and `docs/postman/Namma_Blood_Local.postman_environment.json`.
4. In the top-right environment dropdown, select **Namma Blood — Local Development**.

### Step 2: Authenticate and Capture Token

1. Navigate to folder **01 - Authentication**.
2. Update the credentials in request **1.1 POST User Login** (or **1.2 Admin Login**) to match your local synthetic test user.
3. Send the request.
4. Verify response is `200 OK` and inspect the **Tests** tab. Postman logs: `User token saved to environment.`
5. Inspect your environment variables: `token` is now populated with the actual JWT.

### Step 3: Test Candidate Donor Discovery

1. Navigate to folder **02 - Emergency Donor Discovery**.
2. Execute **2.1 GET Discover Donors - Geospatial Search**:
   - Verify `200 OK`.
   - Verify that all donor records in `data` omit PII (`userId`, `phoneNo`, `address`, exact coordinates) and include `approxDistanceKm`, `matchQuality`, and `clinicalNotice`.
3. Execute **2.2 GET Discover Donors - Administrative Fallback**:
   - Verify `searchCriteria.isGeospatial === false`.
4. Run negative test cases (**2.3**, **2.4**, **2.5**, **2.6**) to verify `400 Bad Request` and `401 Unauthorized` responses fail closed.

### Step 4: Test Blood Bank Discovery with Traceable Inventory

1. Navigate to folder **03 - Emergency Blood Bank Discovery**.
2. Execute **3.1 GET Discover Blood Banks - Geospatial with Stock Verification**:
   - Verify `200 OK`.
   - Verify `facilityRef` follows the format `BB-[0-9A-F]{12}`.
   - Verify `inventoryTrustStatus` is one of `Verified_Available`, `No_Matching_Stock`, or `Inventory_Unverified`.
3. Execute **3.2 GET Discover Blood Banks - Broad Facility Search**:
   - Verify that omitting `bloodGroup` returns nearby blood bank facilities without error.
4. Run negative test cases (**3.4**, **3.5**).

### Step 5: Test Request-Centric Matching Engine

1. Ensure `{{requestId}}` is set in your Postman environment to a verified active request.
2. If testing with a regular user token, ensure the logged-in user is the `requesterUserId`. If testing with an admin token, any valid request can be matched.
3. Execute **4.1 GET Request Matches - Dual Stream Candidate Discovery**:
   - Verify `200 OK`.
   - Inspect dual streams: `donors.data` and `bloodBanks.data`.
   - Verify candidate references: donors have `candidateRef` formatted as `DNR-[0-9A-F]{32}`, blood banks have `facilityRef` formatted as `BB-[0-9A-F]{12}`.
4. Execute **4.2 GET Request Matches - Independent Donor & Blood Bank Pagination**:
   - Verify `donors.pagination.page === 2` and `bloodBanks.pagination.page === 1`.
5. Run negative test cases:
   - **4.4 Malformed Request Identifier:** Returns `400 Bad Request` (`INVALID_REQUEST_IDENTIFIER`).
   - **4.5 Missing Request or Unauthorized BOLA:** Returns `404 Not Found` (`REQUEST_NOT_FOUND`).
   - **4.7 Unauthenticated Access:** Returns `401 Unauthorized`.

---

## 7. Known Prerequisites and Missing Implementations

### 1. Mandatory Environment Secret: `EMERGENCY_HMAC_SECRET`

* **Issue:** The matching engine derives 128-bit truncated keyed HMAC references (`DNR-[0-9A-F]{32}`) for donor candidates. The helper `validateHmacConfiguration` strictly enforces that `process.env.EMERGENCY_HMAC_SECRET` exists and has a length of **at least 32 characters**.
* **Impact if missing:** `GET /api/emergency/requests/:id/matches` throws an internal error and returns HTTP 500:
  ```json
  {
    "status": "error",
    "code": "HMAC_CONFIG_INVALID",
    "message": "Cryptographic configuration failure: HMAC configuration is invalid."
  }
  ```
* **Required Action:** Ensure your `backend/.env` file defines:
  ```ini
  EMERGENCY_HMAC_SECRET=NammaBlood_EmergencyMatching_SecretKey_2026_Min32Chars
  ```

### 2. Missing Emergency Request Creation Route (`POST /api/emergency/requests`)

* **Issue:** There is currently no public or authenticated REST endpoint to submit an emergency blood request.
* **Workaround:** Test requests must be seeded directly in MongoDB or generated by automated tests (`milestone4334MatchingApi.test.js`).

### 3. Required MongoDB 2dsphere Indexes

* **Issue:** Geospatial discovery (`$nearSphere`) requires active `2dsphere` indexes.
* **Required Collections:**
  - `emergencybloodrequests`: `{ location: "2dsphere" }`
  - `bloodbanks`: `{ location: "2dsphere" }`
  - `emergencydonorprofiles`: `{ location: "2dsphere" }`
* **Verification in mongosh:**
  ```javascript
  db.emergencybloodrequests.createIndex({ location: "2dsphere" }, { sparse: true });
  db.bloodbanks.createIndex({ location: "2dsphere" }, { sparse: true });
  db.emergencydonorprofiles.createIndex({ location: "2dsphere" }, { sparse: true });
  ```

### 4. Single-Process In-Memory Rate Limiting

* **Note:** `discoveryRateLimiter` uses an in-memory `Map` with a sliding window of 30 requests per minute. In a clustered or containerized multi-node production deployment, this will require a distributed Redis backend.

### 5. Anti-Enumeration 404 Design

* **Security Feature:** By design, attempting to access an emergency request belonging to another user (or an unassigned blood bank/staff) does **not** return `403 Forbidden`. It deliberately returns an indistinguishable `404 REQUEST_NOT_FOUND` to prevent IDOR enumeration and request existence disclosure.

