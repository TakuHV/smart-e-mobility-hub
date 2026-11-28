# Smart E-Mobility Hub — MVP

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/TakuHV/smart-e-mobility-hub)

> **Run in the browser, no clone needed:** click the button above, wait 1–3 minutes while dependencies install, and the web app opens on port 5173. Log in with one of the demo accounts listed in this README.

A student-level MVP built with **React + JavaScript + Node.js + Express + SQLite**. The MVP is based on the agreed requirements baseline and covers **all 25 use cases** of the baseline (**9 core** and **16 supporting**). Together they demonstrate the student, resource-management, operations, charging, administration and simulation workflows.

## MVP scope

The agreed MVP contains **25 use cases: 9 core business use cases and 16 supporting use cases**. The scope identifies what the team commits to demonstrate; it does not mean that every alternative flow, exception flow or advanced policy in the full requirements specification must be implemented.

### Supporting use cases

| Work area | Use cases | MVP implementation boundary |
|---|---|---|
| Demo access | **UC-001 — Log in**; **UC-002 — Log out** | Local demo login by username (no password) with five fixed demo accounts and role-based menus. Sign out is in Profile (students) and the side menu (staff). This is not production authentication or University SSO integration. |
| Hub discovery | **UC-003 — Search Mobility Hub**; **UC-004 — View Hub Status** | Browse and select Hubs (three Hubs; no free-text search). Students see open/closed state, hours and a parking map; the Operator dashboard shows vehicle, parking-slot, charger and charging-queue information and marks each Hub's status as Fresh or Stale (older than 2 minutes). |
| Student self-service | **UC-010 — View My Bookings and Charging History**; **UC-011 — Modify/Cancel Booking**; **UC-012 — Manage Personal Profile**; **UC-013 — Report a Problem** | History tab lists bookings, parking, charging and reports; violation points are shown in Profile. A booking or parking reservation can be cancelled (there is no separate edit screen for changing one). Profile shows violation points and text size; personal data cannot be edited. Report a Problem offers four problem types and creates an incident for UC-019. |
| Administration | **UC-014 — Manage User Accounts**; **UC-015 — Manage Roles & Access**; **UC-016 — Manage Hub Configuration** | Create, deactivate and reactivate accounts; change a user's role (an Admin cannot change their own role and one active Admin must remain); edit system settings, Hubs, slots, chargers and vehicles. Items with history are taken out of service or retired instead of deleted. |
| Network overview | **UC-017 — Monitor Hub Network and Resource Status** | Operator and Simulation Operator dashboard summarizing Hub capacity, vehicle availability, parking occupancy, charger status, charging demand and operational warnings. |
| Operations support | **UC-020 — Redirect Users to Alternative Hubs**; **UC-022 — Adjust a Charging Schedule** | UC-020 is an advisory: an Operator asks students to use another open Hub; no booking is changed and students see a notice and a notification. UC-022 covers changing the Next Required Usage Time of a shared vehicle and pausing, resuming or cancelling Move Vehicle Requests; manual reassignment of chargers is not provided. |
| Simulation support | **UC-024 — Compare What-if Scenarios**; **UC-025 — Apply Coordination Recommendations** | UC-024 compares 2–10 saved runs of the same Hub. UC-025: the Simulation Operator sends a recommendation to its workflow as a hand-off; the Operator plans the tasks or confirms completion and the recommendation becomes Applied. |

### Core business use cases

| Work area | Use cases | MVP implementation boundary |
|---|---|---|
| Shared vehicle lifecycle | **UC-005 — Book Shared Vehicle**; **UC-006 — Pickup Shared Vehicle**; **UC-007 — Return a Shared Vehicle** | Complete the main Book → Pickup → Return workflow, including availability checks, booking ownership, pickup-window validation, trip/vehicle state transitions, return-slot validation and automatic charging queueing when a returned shared vehicle has a battery level below the 30% booking minimum. |
| Personal parking | **UC-008 — Reserve Personal Parking Spot** | Register/select a personal vehicle, validate vehicle/slot compatibility and time conflicts, reserve a Personal slot, record arrival and complete departure. Advanced overstay handling is excluded. |
| Personal charging request | **UC-009 — Register Personal Charging Demand** | Register a personal vehicle's charging request with battery level and Next Required Usage Time; validate connector compatibility and parking-period conflicts; place the request in the common Hub charging queue and show its estimated start time. |
| Vehicle redistribution | **UC-018 — Coordinate Vehicle Redistribution** | Implement the basic operational workflow: select source and destination Hubs, validate available vehicles and destination Shared-slot capacity (including the return reserve), record a plan, dispatch vehicles and confirm arrivals/completion. Physical movement is represented by software status updates or simulated Field Staff confirmation. |
| Incident handling | **UC-019 — Handle Operational Incidents** | Provide a basic incident workflow to review an operational incident, record the action, update the affected vehicle or charger state, and track the incident through its core lifecycle. The MVP demonstrates selected operational cases rather than every incident category and escalation policy. |
| Smart charging | **UC-021 — Manage Smart Charging Schedule** | Maintain one common charging queue for shared and personal vehicles; run the scheduler using the four approved criteria; check connector compatibility and the Hub Power Limit; create Move Vehicle Requests when movement is required; show assignments and estimated start times. Advanced manual schedule adjustment is excluded. |
| What-if simulation | **UC-023 — Run a What-if Simulation** | Create an isolated baseline snapshot, accept a supported scenario and its parameters, calculate simulated resource/demand impact, store the completed run and display proposed coordination recommendations. A simulation must not modify live operational resource states. |

### Cross-cutting workflow: Move Vehicle Request

Move Vehicle Request is a supporting domain workflow, **not an additional use case in the 25-UC count**. The MVP represents its core lifecycle as `Requested → In Progress → Done` (or `Cancelled` where applicable). It is used for charging-area movement and relevant operational vehicle movements. A charger is released only after the corresponding removal request reaches `Done` (BR-46).

### Scope summary

The MVP covers all 25 use cases:

- **Core (9):** UC-005, UC-006, UC-007, UC-008, UC-009, UC-018, UC-019, UC-021 and UC-023.
- **Supporting (16):** UC-001, UC-002, UC-003, UC-004, UC-010, UC-011, UC-012, UC-013, UC-014, UC-015, UC-016, UC-017, UC-020, UC-022, UC-024 and UC-025.

Supporting use cases are implemented at the boundary described in the table above, not with every alternative flow. The items below are known limits of the current code: free-text Hub search (UC-003), editing a booking instead of cancelling it (UC-011), editing personal data (UC-012) and manual charger reassignment (UC-022).

The MVP uses one web client, one Express backend and one SQLite database. Seeded Hub, vehicle, slot and charger status is used as the simulated status-data source. The system reports Fresh / Stale status rather than inventing random operational state changes. There is no real University SSO, physical IoT hardware, payment gateway, Docker, Kubernetes, microservices, Redis, message broker, WebSocket, ORM or AI/ML scheduler.

## Prerequisites

- **Node.js 22.13 or later**. The backend uses the built-in `node:sqlite` API, avoiding a separate SQLite driver or ORM.
- npm 10 or later is recommended.

> `node:sqlite` is an experimental Node.js API in some Node 22 releases and may display an experimental warning. Use a current Node 22/24 release for the project demo.

## Getting started (first time after cloning)

What the repository contains and what it does not:

- **Included:** all source code, `data/configuration.json` (editable parameters) and `docs/`.
- **Not included (created on your machine):** `node_modules/` (installed by npm) and the SQLite database `data/smart_e_mobility.sqlite` (created and seeded automatically on the first start). Nothing needs to be installed or configured by hand besides Node.js.

1. **Install Node.js 22.13 or later** (a current 22 or 24 release is best). Check with `node -v`. An older version fails at start because `node:sqlite` is missing.
2. **Clone and install.** One `npm install` in the project root installs the server and the client (npm workspaces):

   ```bash
   git clone https://github.com/TakuHV/smart-e-mobility-hub.git
   cd smart-e-mobility-hub
   npm install
   ```

3. **Start both servers** from the project root:

   ```bash
   npm run dev
   ```

   - React/Vite client: <http://localhost:5173> (open this one)
   - Express API: <http://localhost:4000/api>, health check <http://localhost:4000/api/health>
   - SQLite file: `data/smart_e_mobility.sqlite`. The first start creates the tables from `server/src/database/schema.sql` and loads the demo data (see "Demo data and accounts" below).

4. **Sign in** on the login page by account name (there is no password; the demo runs on localhost only).

Useful commands (all from the project root):

| Command | What it does |
|---|---|
| `npm run dev` | Server and client with automatic reload |
| `npm test` | Backend tests (in-memory database, the real database is not touched) |
| `npm run build` | Production build of the client |
| `npm run seed` | Loads the demo data into an empty database |

### Demo data and accounts

- **Accounts and data:** see "Demo accounts" and "Seed data" below. In short: `Student`, `Operator`, `Simulation Operator`, `Admin` and `Demo` (all roles), plus `student1` to `student5` with a parked motorcycle each at Hub A.
- **Reset the demo:** sign in as `Admin` and use Reset demo. It clears the data, restores the demo data and puts the demo clock back to real time. Alternatively stop the server, delete `data/smart_e_mobility.sqlite` and its `-shm` / `-wal` files, and start again. **Both delete all demo records.**
- **Demo clock:** the chip at the top shows the demo time. An Operator or Admin can change the speed or jump ahead (+5 min, +15 min, +1 h, +3 h). The Student's "Waiting for a charger" screen also has a "+45s demo clock (demo only)" button.

### Troubleshooting

| Problem | Cause and fix |
|---|---|
| `Port 4000 is already in use` | Another program uses the port. Stop it, or start with another port, for example `PORT=4001 npm run dev` (on Windows PowerShell: `$env:PORT=4001; npm run dev`). |
| `No such built-in module: node:sqlite` or a syntax error at start | Node.js is too old. Install version 22.13 or later. |
| `ExperimentalWarning: SQLite is an experimental feature` | A normal notice from Node.js. It can be ignored. |
| `FOREIGN KEY constraint failed` at start after pulling new code | The old local database does not match the new demo data. Stop the server, delete `data/smart_e_mobility.sqlite` with its `-shm` / `-wal` files, and start again. |
| The page opens but shows no data or network errors | The API is not running. Check the terminal for errors and open `http://localhost:4000/api/health`. |
| Changed code but the screen does not update | Server code reloads by itself (`node --watch`); a change in `data/configuration.json` or the seed needs Reset demo. |

## Supporting behaviour of the MVP flows

- **Timers and notifications** (`server/src/services/timerService.js`, `notificationService.js`): pickup hold (15 minutes), trip time against the 3-hour limit, parking arrival/leave, charger connect window, charging progress and overstay warnings. Visible countdowns are in `client/src/components/Timers.jsx`; the bell lists notifications.
- **Student app** (`client/src/student/`): large, simple layout with five tiles (Book a vehicle, Park my vehicle, Charge my vehicle, Report a problem, View Hubs) and a bottom bar (Home, History, Alerts, Profile). A booking stores the destination Hub; the trip screen has one "I have arrived" button, the battery is the simulated level (not typed by the student) and the return slot is chosen automatically. Students do not see Hub totals.
- **Automatic charging of shared vehicles** (`server/src/services/chargingService.js`): shared vehicles charge in three bands (`charging.sharedMandatoryBelowPercent` 60, `charging.sharedStopPercent` 90). Below 60% a vehicle must charge: it is queued when a charger is free, and when every charger is busy it takes the charger of a vehicle that only uses idle charger time. From 60% to 90% it uses idle chargers only (a free charger and nobody waiting), lowest battery first; from 90% to 100% only after every vehicle below 90% has a charger. A vehicle that reaches 90% while someone needs a charger stops there; otherwise it goes on to 100% without an extra move. A vehicle stays on its charger until it stops, so a charge costs two moves only, and a vehicle at 60% or more rests `charging.sharedRestMinutes` (10) after it left a charger. A shared vehicle at 90% or more that is charging always gives way to a personal request. A shared vehicle stays *Available* (bookable) while it charges once it has at least 30% battery; below 30% it is *Needs Charging*. Parking slots have no chargers: the vehicle is taken to the charger by a Move Vehicle Request (BR-46) and its Shared slot stays reserved (BR-39).
- **Move Vehicle Requests are sent automatically** after a countdown (`charging.moveAutoSendSeconds`, 15 s). An Operator can press **Pause** during the countdown (and **Resume** later) to handle the request by hand. Field Staff moves (shared vehicles, Holding) are simulated and finish after `charging.fieldMoveSeconds`; the owner moves a personal vehicle and is told to do so.
- **Personal charging request**: the student chooses the vehicle and Hub, types the battery level and the time the vehicle is needed (hour and minute), and chooses to start in 5, 10 or 15 minutes. The app shows when the vehicle should reach 90%; the owner is notified at 90% and charging continues to 100%. A vehicle with a parking reservation cannot be given a charging request for an overlapping period, and the other way round; requests for a later period are allowed.
- **Check before joining (class X)**: when a student confirms a personal charging request, the server first calculates (`POST /api/charging/preview`) whether the vehicle could be ready in time. If it would be class X, the app explains why and offers to choose a later time (a realistic time is suggested), join anyway, or not register. A class X request can still take the charger of a shared vehicle that has no Next Required Usage Time, but never anything else.
- **Priority and displacement**: when no charger is free, the priority (Battery Level, Next Required Usage Time, Waiting Duration, class H) of the waiting personal request is compared with every shared vehicle that is charging. Urgency uses slack (minutes until the required time minus the minutes needed to charge to 100%, at the reference charger power `demoData.seedChargerPowerKw`); slack of 0 or less puts the vehicle in class H. A vehicle whose slack is below `charging.scheduler.hopelessSlackMinutes` (default −30, it cannot be ready in time even if charged now) is class X and is ranked behind class L, so it never takes a charger from a vehicle that can still be saved; it is charged when nobody else needs the charger. A shared vehicle is displaced only when the waiting request is clearly ahead (class H against class L, or a score at least `charging.scheduler.preemptMarginPoints` higher, default 10). It stops at its current battery level and its charger goes to the personal request. A booked shared vehicle, and a vehicle already at `preemptMaxBatteryPercent` (default 90%) or more, is never displaced.
- **Charging speed**: speed = charger power ÷ battery capacity. The demo chargers are 1 kW (`demoData.seedChargerPowerKw`, read by `server/src/database/seed.js` and used as the reference power for slack) and the vehicle battery is 3.5 kWh (`battery.capacityKwhByVehicleType`), so a charge from 0% to 100% takes about 3.5 hours, like a real VinFast scooter charger (4 to 10 hours for 0.4 to 1 kW). All three Hubs have the same Hub Power Limit of 5 kW (`demoData.seedHubPowerLimitsKw`), so in normal operation all 5 chargers of a Hub run together. The limit only matters in a what-if simulation, for example a power outage where a smaller backup supply is used. The demo clock bar has +5 min, +15 min, +1 h and +3 h buttons.
- **Motorcycles only**: the Hub network serves electric motorcycles only (`Motorcycle`, 3.5 kWh in the battery model). A student registers a vehicle with the license plate only, which must be a Vietnamese motorcycle plate (2-digit province code 11-99, 1-2 series letters with an optional digit, then 000.01-999.99, for example `59A-123.45` or `62AN-116.30`; the dash and dot are optional when typing and the plate is stored as `59A-123.45`); vehicle type and connector are set by the system. The Admin forms offer no other type.
- **Parking time limit**: one parking reservation lasts at most `parking.maxStayHours` (default 8 hours) and must end on the same day, before the Hub closes (BR-42).
- **Round trip**: the destination Hub of a booking may be the Hub where the vehicle is picked up. The slot the vehicle leaves counts as free for its return.
- **Start charging**: Now, In 5 min, In 10 min or In 15 min (default Now). The 90% "ready to collect" message is also sent when a clock jump takes the vehicle past 90% to the end in one step (sent once).
- **Booking a shared vehicle**: the student picks up now or in 5, 15 or 30 minutes; the vehicle's next use is that time and the 15-minute hold starts then. Minimum battery to book is 30%; a trip between two Hubs uses 20% battery on average (`battery.tripDropPercent`). Booking a vehicle that is charging stops its charging shortly before the pickup time and moves it back to its Shared slot automatically.
- **Holding area**: at least 40% of a Hub's Holding slots stay free (`parking.holdingFreeReservePercent`). A personal request that would have to wait and would use more is refused with "waiting area full". A personal vehicle that is not collected 5 minutes after reaching 100% gets a warning and is moved to Holding; an Operator hands it back.
- **Vehicle redistribution** (UC-018, `server/src/services/redistributionService.js`): suggestions and manual moves; tasks go Requested → In Progress → Done; the vehicle is `In Transfer` meanwhile and a destination Shared slot is kept for it.
- **User redistribution** (`server/src/services/userRedirectService.js`, UC-020; advisory only): when a Hub has no bookable vehicle or no free Shared slot, an Operator asks students to use another Open Hub. Nothing is moved and no booking is changed; students see a "Busy, please use X" notice in Book and View Hubs and receive a notification. One active redirection per Hub.
- **Incidents** (UC-019, `server/src/services/incidentService.js`): Operators acknowledge and resolve incidents, optionally restoring the vehicle, slot or charger.
- **Menus per role**: Student = Book / Park / Charge / Report / View Hubs. Operator = Hub Dashboard, Smart Charging, Incidents, Vehicle & User Redistribution, What-if Simulation (view). Simulation Operator = Hub Dashboard, What-if Simulation. Admin = User Accounts, Roles & Access, Configuration. Menus are enforced in the client; the API keeps its role checks per route (an Admin can technically call Operator routes).
- An existing demo database is upgraded automatically at start (new columns/tables are added); no reseed is needed.

## Demo-only features and supporting-use-case code

| Feature | Files | Label |
|---|---|---|
| Phone view (phone-sized frame) | `client/src/components/PhoneFrame.jsx` | **Demo-only** |
| Reset demo data (also deletes non-default accounts) | `server/src/services/demoResetService.js`, `client/src/pages/Admin.jsx` | **Demo-only** |
| Demo clock: speed x1/x10/x60/x300, pause, skip | `server/src/clock.js`, `client/src/components/DemoClockBar.jsx` | **Demo-only** |
| Demo account (all four roles) and role switch | `server/src/services/authService.js`, `client/src/components/AppShell.jsx` | **Demo-only** |
| "Register" line and decorative login art | `client/src/pages/Login.jsx`, `client/src/styles.css` | **Demo-only** (decoration) |
| Admin: User Accounts, Roles & Access, Configuration (system settings, Hubs, slots, chargers, vehicles) | `client/src/pages/Users.jsx`, `Access.jsx`, `Admin.jsx`; `server/src/services/userAdminService.js`, `settingsService.js`, `adminService.js` | Supporting (UC-014/015/016) |
| Deactivated accounts cannot sign in | `server/src/middleware/requestContext.js` | Supporting (UC-014) |
| Student Report a Problem | `client/src/student/ReportFlow.jsx` | Supporting (UC-013) |
| Student History, and cancelling a booking or parking reservation | `client/src/student/History.jsx`, `BookFlow.jsx`, `ParkFlow.jsx` | Supporting (UC-010/011) |
| Student Profile, "Larger text" | `client/src/student/Profile.jsx` | Supporting (UC-012) |
| User redistribution advisory | `server/src/services/userRedirectService.js` | Supporting (UC-020) |
| Redistribution planned from What-if recommendations | `server/src/services/redistributionService.js` | Supporting (UC-025) |

## Demo accounts

The login page asks for a username (no password in the demo). Five default accounts exist: admin, student, operator, simulation operator and demo (the five seeded Students `student1` to `student5` can also sign in); usernames are not case-sensitive and an unknown username is refused. The "Register" line is decoration only. **Demo** has all four roles: type `demo` and choose "Open as", or switch later (Profile for students, the side menu for staff). Demo accounts are demo-only (see above).

| Account | Role | Use |
|---|---|---|
| Student | Student | Book a vehicle, park, charge, report a problem, view Hubs, history, profile |
| Operator | Operator | Hub dashboard, Smart Charging, incidents, vehicle redistribution, view What-if Simulation, confirm hand-offs |
| Simulation Operator | Simulation Operator | Hub dashboard, run, compare and review What-if Simulation, send recommendations (UC-023/024/025) |
| Admin | Admin | User accounts, roles and access, configuration |
| Demo | all four | Open any of the four experiences |

The demo role selector is not secure production authentication. It does not call the university identity provider. Do not expose this MVP to the public internet without replacing the demo identity mechanism and adding production security controls.

## Seed data

The seed creates three example Hubs with the same capacity. Each has 30 parking slots (20 Shared and 10 Personal), 6 Holding slots, 5 chargers (1 kW each) and a shared fleet of 15 vehicles. It creates five example Students, `student1` to `student5` (sign in by name), each with a motorcycle (`51A-123.45`, `52B-123.45` ... `55E-123.45`) that is parked at Hub A in Personal slots P-01 to P-05, with different parking times (arrived 10 minutes to 4 hours ago). Other Students have no vehicle and add one with "Add a vehicle" (Park my vehicle or Charge my vehicle). Demo reset keeps these five Students. It also creates one low-battery shared vehicle (16%) at Hub B with its charging request, and at Hub B six of the ten Personal slots are taken by vehicles that are not registered in the system (60% occupancy) for the what-if demo. Seed data should also include enough resource and incident conditions to demonstrate the UC-017 monitoring and selected UC-019 incident-handling flows.

Seeded Hub Power Limits and charger power values are example demonstration data. They are not a group-approved operating configuration. Edit `data/configuration.json` and the Hub seed values if the team approves different values.

## Important business rules represented

- **Demo access:** the MVP uses local demo identities and fixed roles; real University SSO and full role administration are not included.
- **Hub status and monitoring:** stale status must not be presented as confirmed current data (BR-27); out-of-service resources are counted as unavailable. The Operator overview summarizes Hub capacity and resource conditions.
- **Shared booking:** a vehicle must be `Available`, have a battery level of at least 30% (`booking.minimumBatteryToBookPercent`), and belong to an open Hub; a student may have at most one active shared booking; the booking is held for 15 minutes for pickup. Expiry and failed operations must release resources correctly.
- **Pickup/return:** only the owner of a valid booking can pick up the vehicle; pickup changes the booking to `In Progress` and the vehicle to `In Use`. Return requires an active trip and a free Shared slot. A returned shared vehicle below 30% becomes `Needs Charging` and is automatically queued.
- **Parking:** personal vehicles use Personal slots; the slot must support the vehicle type; reservation periods must be inside Hub operating hours; a vehicle's parking and charging periods cannot overlap; the arrival hold is 15 minutes after the start. Full overstay-to-Holding handling is outside the MVP.
- **Charging:** shared and personal requests use one common Hub charging area; connectors must match; simultaneous charger power cannot exceed the Hub Power Limit; personal vehicles have at most two requests per day and 15 minutes to connect after assignment. The scheduler uses the four approved criteria: Battery Level, Next Required Usage Time, Waiting Duration and Hub Power Limit.
- **Move Vehicle Request:** the request tracks the required movement and its result. A charger is not released before a required FROM_CHARGER request is `Done` (BR-46). The Shared slot reserved for a shared vehicle during charging is retained according to BR-39.
- **Redistribution:** source and destination capacity are validated before dispatch; a vehicle is counted as moved only when its arrival is recorded, and the destination must preserve the free Shared-slot return reserve (BR-29 / BR-40).
- **Incident handling:** incidents follow the status lifecycle `Open → In Progress → Resolved`. An Operator acknowledges the incident, then resolves it with an optional note and chooses whether the affected vehicle, slot or charger returns to service (BR-30).
- **What-if simulation:** each run uses a baseline snapshot and stores results labelled `Simulated`; simulation must not change live resource state (BR-32). Recommendations produced by UC-023 stay proposals until a Simulation Operator sends one to its workflow (UC-025); the Operator then plans or confirms the live action. The simulation itself never changes live state.
- **Audit:** important MVP transitions are written to SQLite `audit_logs`.

## Scheduler and charging values

Submission #1 v8 (BR-20 to BR-23, BR-43 and Section 6.2) approves the values used by the MVP. The Charging Scheduler ranks requests by Battery Level, Next Required Usage Time, Waiting Duration and Hub Power Limit with the weights 0.5 / 0.3 / 0.2 (`charging.scheduler.weights`). Queue times use a 120-minute session estimate (`charging.scheduler.estimatedSessionMinutes`); the estimate is not a guarantee (BR-43).

A waiting personal request displaces a shared vehicle's charging session only when it is clearly ahead: class H against class L, or a score higher by at least `charging.scheduler.preemptMarginPoints` (10). A booked shared vehicle, and a shared vehicle at `charging.scheduler.preemptMaxBatteryPercent` (90%) or more, is never displaced (BR-22). There is no maximum session duration (BR-23; `charging.maxSessionMinutes` stays off). The charging target is 100% with a "ready to collect" notice at 90%, the minimum battery to book is 30% and 40% of the Holding slots stay free.

UC-023 stores simulation results and proposed recommendations. UC-024 compares saved runs, UC-025 hands a recommendation to the operational workflow, UC-020 provides redirect advisories and UC-022 provides limited schedule adjustment, as described in the supporting use case table.

**Violation points (BR-11, BR-12, BR-52).** A student gets 1 point for a shared vehicle not collected within the pickup hold, a parking reservation not used in time, a personal vehicle not connected to its charger in time, a parking overstay, or a shared-vehicle trip over the maximum duration. A point expires after 14 days and the same event is never counted twice. With 5 active points a student cannot create new charging requests. The student sees the points and the reasons in **Profile → Violation points** (`GET /api/auth/me/violations`). Recording can be switched off with `RECORD_VIOLATIONS = false` in `server/src/services/commonService.js`. A full violation-history screen and the Operator's dispute workflow are not part of the MVP.

Timing reminders, the 3-hour overdue-trip warning and parking/charging overstay flags exist as supporting demo behaviour, but they are not acceptance criteria. The parking overstay-to-Holding workflow, all incident categories and the violation appeal/restriction lifecycle are not implemented. UC-019 is limited to the selected core incident-handling path.

## Tests and verification

Run the backend workflow tests from the project root (`node --test server/test/*.test.js`, 53 tests, each run uses an in-memory database from `server/testSetup.js`, so the demo data is untouched):

```bash
npm test
```

The MVP acceptance tests should cover: (1) UC-005 / UC-006 / UC-007 booking, pickup, low-battery return and automatic queueing; (2) UC-008 parking reservation, arrival/departure and conflict validation; (3) UC-009 / UC-021 personal charging, scheduler allocation, connector/Hub Power Limit validation and charger release only after Move Vehicle Request `Done`; (4) UC-017 / UC-018 network monitoring and the basic redistribution plan/dispatch/arrival workflow; (5) UC-019 incident status and resource-state updates; and (6) UC-023 simulation isolation, stored results and proposed recommendations; and (7) the 16 supporting use cases at the boundary described in the supporting use case table.

The test suite also covers supporting features (timers, Admin configuration, user accounts, reset, user redistribution, UC-024 comparison and UC-025 recommendation hand-off).

The JSX source was syntax-parsed and the backend JavaScript / JSON files were checked. The frontend production bundle and live Express HTTP server were not built or smoke-tested in the preparation environment because npm dependency installation could not complete there; run `npm install` followed by `npm run dev` on a machine with npm registry access.

## API overview

Main endpoints (route definitions are in `server/src/routes`). Rows marked *support* belong to supporting use cases or demo-only features.

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/auth/demo-login` | Create/reuse demo identity (UC-001) |
| GET | `/api/hubs` | Search and list Hubs (UC-003) |
| GET | `/api/hubs/:hubId/status` | Hub resource status (UC-004) |
| GET | `/api/vehicles?kind=shared` | List shared fleet |
| GET / POST | `/api/vehicles/bookings` | List / create shared bookings (UC-005) |
| POST | `/api/vehicles/bookings/:id/pickup` | Pick up shared vehicle (UC-006) |
| POST | `/api/vehicles/bookings/:id/return` | Return shared vehicle (UC-007) |
| GET / POST | `/api/parking/reservations` | List / reserve personal parking (UC-008) |
| POST | `/api/parking/reservations/:id/arrive` | Record arrival/check-in (UC-008) |
| POST | `/api/parking/reservations/:id/complete` | Record departure/completion (UC-008) |
| GET | `/api/charging/queue` | Queue, chargers and movement requests (UC-021) |
| POST | `/api/charging/requests` | Register personal charging request (UC-009) |
| POST | `/api/charging/run-scheduler` | Run operator scheduler cycle (UC-021) |
| POST | `/api/charging/move-requests/:id/start` | Start a recorded vehicle movement |
| POST | `/api/charging/move-requests/:id/done` | Confirm movement and release charger when applicable |
| POST | `/api/simulation/runs` | Run a What-if Simulation (UC-023) |
| POST | `/api/simulation/compare` | *support* Compare saved runs (UC-024) |
| POST | `/api/simulation/recommendations/:id/apply` · `/decline` | *support* Send or decline a recommendation (UC-025) |
| POST | `/api/simulation/handoffs/:id/complete` | *support* Confirm a hand-off as completed (UC-025) |
| POST | `/api/vehicles/bookings/:id/cancel` | *support* Cancel a booking (UC-011) |
| GET | `/api/auth/me/violations` | *support* Violation points (UC-012) |
| GET | `/api/redistribution/overview` | Hub balance, suggestions and tasks (UC-018) |
| POST | `/api/redistribution/tasks` | Create a vehicle move task (UC-018) |
| POST | `/api/redistribution/tasks/:id/start` · `/done` · `/cancel` | Task lifecycle (UC-018) |
| GET / POST | `/api/incidents` | List / report incidents (UC-019) |
| GET / POST | `/api/redistribution/user-redirects` | *support* Redirection suggestions and active list / ask students to use another Hub |
| POST | `/api/redistribution/user-redirects/:id/end` | *support* End a redirection |
| GET | `/api/hubs/redirects` | *support* Notices shown to students |
| GET / POST | `/api/clock` | *support (demo-only)* Demo clock |
| GET / POST | `/api/notifications` | *support* Notifications |
| GET / POST | `/api/admin/users` · `/api/admin/access` · `/api/admin/settings` | *support* Accounts, access overview, configuration |
| POST | `/api/admin/reset-demo` | *support (demo-only)* Reset data, body `{"confirm":"RESET"}` |

The compare and apply endpoints implement UC-024 and UC-025.

## Project structure

```text
smart-e-mobility-hub/
├── .devcontainer/                 # GitHub Codespaces setup
├── client/
│   ├── index.html
│   ├── package.json
│   ├── vite.config.js
│   ├── manifest.webmanifest
│   └── src/
│       ├── pages/                 # Login, HubDashboard, Charging, Incidents, Dispatch (vehicle & user redistribution),
│       │                          # Simulation, Users, Access, Admin
│       ├── student/               # Student app: StudentApp, Home, BookFlow, ParkFlow, ChargeFlow, ReportFlow,
│       │                          # Hubs, History, Notifications, Profile, ui.jsx, student.css
│       ├── components/            # AppShell, PhoneFrame (demo), DemoClockBar (demo), NotificationBell, Timers,
│       │                          # StatusBadge, StatCard, SectionHeader, RefreshButton, Feedback, BatteryIcon, SlotMap
│       ├── api.js  clock.js  hooks.js  userOrder.js
│       ├── App.jsx  main.jsx
│       └── styles.css
├── server/
│   ├── package.json
│   ├── testSetup.js               # in-memory database for tests
│   ├── src/
│   │   ├── routes/                # auth, hubs, vehicles, parking, charging, simulation, redistribution, incidents,
│   │   │                          # clock, notifications, admin
│   │   ├── services/              # vehicle, parking, charging, hub, simulation, redistribution, userRedirect,
│   │   │                          # incident, timer, notification, settings, admin, userAdmin, auth, demoReset, ...
│   │   ├── middleware/
│   │   ├── database/              # schema.sql, db.js (connection and migrations), seed.js
│   │   ├── clock.js               # demo clock
│   │   ├── config.js              # configuration loader
│   │   └── app.js
│   └── test/                      # features.test.js, mvp.test.js, helpers.js
├── data/
│   └── configuration.json
├── docs/
│   ├── Submission1_v7.pdf
│   ├── Submission1_v8.docx         # requirements aligned with the MVP
│   ├── Technical_Design_Document.pdf
│   ├── Smart_Charging_Explain.docx
│   ├── Test_Cases.docx
│   └── what_if_simulation_guide.docx
├── package.json
└── README.md
```

## Development notes

- The SQLite database is intentionally accessed using parameterized SQL and small service functions; there is no ORM.
- Business checks happen in the Express services, not only in the browser.
- Multi-step resource changes use SQLite transactions (`BEGIN IMMEDIATE`) to reduce double-allocation risk.
- `data/configuration.json` is the single demo configuration source. Approved operating values should be confirmed by the group before the demonstration is treated as requirement-complete.
- Local demo may use HTTP on localhost. This does **not** satisfy NFR-18. Network deployment requires HTTPS/TLS and production-grade authentication and security controls.

---
