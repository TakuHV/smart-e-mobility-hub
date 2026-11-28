# Smart E-Mobility Hub — MVP

A student-level MVP built with **React + JavaScript + Node.js + Express + SQLite**. The MVP is based on the agreed requirements baseline and focuses on **13 selected use cases** that demonstrate the main student, resource-management, operations, charging and simulation workflows. It does not attempt to implement all 25 use cases in Submission #1.

## MVP scope

The agreed MVP contains **9 core business use cases** and **4 supporting use cases**. The scope identifies what the team commits to demonstrate; it does not mean that every alternative flow, exception flow or advanced policy in the full requirements specification must be implemented.

### Supporting use cases

| Work area | Use cases | MVP implementation boundary |
|---|---|---|
| Demo access | **UC-001 — Log in** | Local demo login by username (no password) with five fixed demo accounts and role-based menus. This is not production authentication or University SSO integration. |
| Hub discovery | **UC-003 — Search Mobility Hub**; **UC-004 — View Hub Status** | Search and select Hubs; display available vehicle, parking-slot, charger and charging-queue information. Clearly distinguish fresh, stale and unavailable status data. |
| Network overview | **UC-017 — Monitor Hub Network and Resource Status** | Operator dashboard summarizing Hub capacity, vehicle availability, parking occupancy, charger status, charging demand and operational warnings. |

### Core business use cases

| Work area | Use cases | MVP implementation boundary |
|---|---|---|
| Shared vehicle lifecycle | **UC-005 — Book Shared Vehicle**; **UC-006 — Pickup Shared Vehicle**; **UC-007 — Return a Shared Vehicle** | Complete the main Book → Pickup → Return workflow, including availability checks, booking ownership, pickup-window validation, trip/vehicle state transitions, return-slot validation and automatic charging queueing when a returned shared vehicle has a battery level below 20%. |
| Personal parking | **UC-008 — Reserve Personal Parking Spot** | Register/select a personal vehicle, validate vehicle/slot compatibility and time conflicts, reserve a Personal slot, record arrival and complete departure. Advanced overstay handling is excluded. |
| Personal charging request | **UC-009 — Register Personal Charging Demand** | Register a personal vehicle's charging request with battery level and Next Required Usage Time; validate connector compatibility and parking-period conflicts; place the request in the common Hub charging queue and show its estimated start time. |
| Vehicle redistribution | **UC-018 — Coordinate Vehicle Redistribution** | Implement the basic operational workflow: select source and destination Hubs, validate available vehicles and destination Shared-slot capacity (including the return reserve), record a plan, dispatch vehicles and confirm arrivals/completion. Physical movement is represented by software status updates or simulated Field Staff confirmation. |
| Incident handling | **UC-019 — Handle Operational Incidents** | Provide a basic incident workflow to review an operational incident, record the action, update the affected vehicle or charger state, and track the incident through its core lifecycle. The MVP demonstrates selected operational cases rather than every incident category and escalation policy. |
| Smart charging | **UC-021 — Manage Smart Charging Schedule** | Maintain one common charging queue for shared and personal vehicles; run the scheduler using the four approved criteria; check connector compatibility and the Hub Power Limit; create Move Vehicle Requests when movement is required; show assignments and estimated start times. Advanced manual schedule adjustment is excluded. |
| What-if simulation | **UC-023 — Run a What-if Simulation** | Create an isolated baseline snapshot, accept a supported scenario and its parameters, calculate simulated resource/demand impact, store the completed run and display proposed coordination recommendations. A simulation must not modify live operational resource states. |

### Cross-cutting workflow: Move Vehicle Request

Move Vehicle Request is a supporting domain workflow, **not an additional use case in the 13-UC count**. The MVP represents its core lifecycle as `Requested → In Progress → Done` (or `Cancelled` where applicable). It is used for charging-area movement and relevant operational vehicle movements. A charger is released only after the corresponding removal request reaches `Done` (BR-46).

### Use cases outside the agreed MVP

The following use cases remain in the full requirements baseline but are **not part of the selected MVP implementation or demo acceptance scope**:

| Use case | Name | Scope decision |
|---|---|---|
| UC-002 | Log out | Not a separate MVP workflow. |
| UC-010 | View My Bookings and Charging History | Full student history and violation-history screens are deferred. |
| UC-011 | Modify/Cancel Booking | Self-service modification/cancellation workflows are deferred; required state cleanup, expiry and failure handling remain part of the core workflows. |
| UC-012 | Manage Personal Profile | Deferred. |
| UC-013 | Report a Problem | Student-initiated problem-reporting UI is deferred. UC-019 can be demonstrated using an operationally generated or seeded incident. |
| UC-014 | Manage User Accounts | Deferred; demo identities are used. |
| UC-015 | Manage Roles & Access | Full role/permission administration is deferred; only the fixed MVP demo roles and route guards are needed. |
| UC-016 | Manage Hub Configuration | Full configuration editor is deferred; seeded data and `data/configuration.json` are used. |
| UC-020 | Redirect Users to Alternative Hubs | Deferred. |
| UC-022 | Adjust a Charging Schedule | Advanced/manual assignment adjustment is deferred; UC-021 covers scheduler execution and monitoring. |
| UC-024 | Compare What-if Scenarios | Multi-run comparison is deferred; MVP runs and reviews an individual simulation. |
| UC-025 | Apply Coordination Recommendations | Applying recommendations and handing them into live operational workflows is deferred; UC-023 recommendations remain proposals. |

Some of these have a **supporting demo implementation** in the code (student History/cancel, Report a Problem, Profile, Admin User Accounts / Roles & Access / Configuration, and a user-redirection advisory next to vehicle redistribution). They exist to make the demo usable and are **not part of the acceptance scope**; see "Demo-only and beyond-MVP features" below.

The selected MVP therefore covers **UC-001, UC-003, UC-004, UC-005, UC-006, UC-007, UC-008, UC-009, UC-017, UC-018, UC-019, UC-021 and UC-023**.

The MVP uses one web client, one Express backend and one SQLite database. Seeded Hub, vehicle, slot and charger status is used as the simulated status-data source. The system reports Fresh / Stale / unavailable status rather than inventing random operational state changes. There is no real University SSO, physical IoT hardware, payment gateway, Docker, Kubernetes, microservices, Redis, message broker, WebSocket, ORM or AI/ML scheduler.

## Prerequisites

- **Node.js 22.13 or later**. The backend uses the built-in `node:sqlite` API, avoiding a separate SQLite driver or ORM.
- npm 10 or later is recommended.

> `node:sqlite` is an experimental Node.js API in some Node 22 releases and may display an experimental warning. Use a current Node 22/24 release for the project demo.

## Run locally

Open a terminal in the project root:

```bash
npm install
npm run dev
```

- React/Vite client: <http://localhost:5173>
- Express API: <http://localhost:4000/api>
- Health check: <http://localhost:4000/api/health>
- SQLite file: `data/smart_e_mobility.sqlite` (created automatically)

The database is initialized from `server/src/database/schema.sql` and seeded on first backend start. To build the frontend:

```bash
npm run build
```

To reseed from a clean state, stop the server, delete `data/smart_e_mobility.sqlite` and its `-shm` / `-wal` companions, then run `npm run dev` again. **This deletes demo records.**

## Supporting behaviour of the MVP flows

- **Timers and notifications** (`server/src/services/timerService.js`, `notificationService.js`): pickup hold (15 minutes), trip time against the 3-hour limit, parking arrival/leave, charger connect window, charging progress and overstay warnings. Visible countdowns are in `client/src/components/Timers.jsx`; the bell lists notifications.
- **Student app** (`client/src/student/`): large, simple layout with five tiles (Book a vehicle, Park my vehicle, Charge my vehicle, Report a problem, View Hubs) and a bottom bar (Home, History, Alerts, Profile). A booking stores the destination Hub; the trip screen has one "I have arrived" button, the battery is the simulated level (not typed by the student) and the return slot is chosen automatically. Students do not see Hub totals.
- **Automatic charging of shared vehicles** (`server/src/services/chargingService.js`): whenever a charger is free, idle shared vehicles that are not at 100% are put on it, lowest battery first, and charge to 100%. A shared vehicle stays *Available* (bookable) while it charges once it has at least 30% battery; below 30% it is *Needs Charging*. Parking slots have no chargers: the vehicle is taken to the charger by a Move Vehicle Request (BR-46) and its Shared slot stays reserved (BR-39).
- **Move Vehicle Requests are sent automatically** after a countdown (`charging.moveAutoSendSeconds`, 15 s). An Operator can press **Stop** during the countdown to handle the request by hand. Field Staff moves (shared vehicles, Holding) are simulated and finish after `charging.fieldMoveSeconds`; the owner moves a personal vehicle and is told to do so.
- **Personal charging request**: the student chooses the vehicle and Hub, types the battery level and the time the vehicle is needed (hour and minute), and chooses to start in 5, 10 or 15 minutes. The app shows when the vehicle should reach 90%; the owner is notified at 90% and charging continues to 100%. A vehicle with a parking reservation cannot be given a charging request for an overlapping period, and the other way round; requests for a later period are allowed.
- **Priority and displacement**: when no charger is free, the priority (Battery Level, Next Required Usage Time, Waiting Duration, class H) of the waiting personal request is compared with every shared vehicle that is charging. Urgency uses slack (minutes until the required time minus the minutes needed to charge to 100%, at the reference charger power `demoData.seedChargerPowerKw`); slack of 0 or less puts the vehicle in class H. A vehicle whose slack is below `charging.scheduler.hopelessSlackMinutes` (default −30, it cannot be ready in time even if charged now) is class X and is ranked behind class L, so it never takes a charger from a vehicle that can still be saved; it is charged when nobody else needs the charger. A shared vehicle is displaced only when the waiting request is clearly ahead (class H against class L, or a score at least `charging.scheduler.preemptMarginPoints` higher, default 10). It stops at its current battery level and its charger goes to the personal request. A booked shared vehicle, and a vehicle already at `preemptMaxBatteryPercent` (default 90%) or more, is never displaced.
- **Charging speed**: speed = charger power ÷ battery capacity. The demo chargers are 1 kW (`demoData.seedChargerPowerKw`, read by `server/src/database/seed.js` and used as the reference power for slack) and the vehicle battery is 3.5 kWh (`battery.capacityKwhByVehicleType`), so a charge from 0% to 100% takes about 3.5 hours, like a real VinFast scooter charger (4 to 10 hours for 0.4 to 1 kW). All three Hubs have the same Hub Power Limit of 3 kW (`demoData.seedHubPowerLimitsKw`), so only 3 of the 5 chargers of a Hub run at the same time. The demo clock bar has +5 min, +15 min, +1 h and +3 h buttons.
- **Motorcycles only**: the Hub network serves electric motorcycles only (`Motorcycle`, 3.5 kWh in the battery model). A student registers a vehicle with the license plate only; vehicle type and connector are set by the system. The Admin forms offer no other type.
- **Parking time limit**: one parking reservation lasts at most `parking.maxStayHours` (default 8 hours) and must end on the same day, before the Hub closes (BR-42).
- **Round trip**: the destination Hub of a booking may be the Hub where the vehicle is picked up. The slot the vehicle leaves counts as free for its return.
- **Start charging**: Now, In 5 min, In 10 min or In 15 min (default Now). The 90% "ready to collect" message is also sent when a clock jump takes the vehicle past 90% to the end in one step (sent once).
- **Booking a shared vehicle**: the student picks up now or in 5, 15 or 30 minutes; the vehicle's next use is that time and the 15-minute hold starts then. Minimum battery to book is 30%; a trip between two Hubs uses 20% battery on average (`battery.tripDropPercent`). Booking a vehicle that is charging stops its charging shortly before the pickup time and moves it back to its Shared slot automatically.
- **Holding area**: at least 40% of a Hub's Holding slots stay free (`parking.holdingFreeReservePercent`). A personal request that would have to wait and would use more is refused with "waiting area full". A personal vehicle that is not collected 5 minutes after reaching 100% gets a warning and is moved to Holding; an Operator hands it back.
- **Vehicle redistribution** (UC-018, `server/src/services/redistributionService.js`): suggestions and manual moves; tasks go Requested → In Progress → Done; the vehicle is `In Transfer` meanwhile and a destination Shared slot is kept for it.
- **User redistribution** (`server/src/services/userRedirectService.js`, supporting; advisory only, similar to UC-020): when a Hub has no bookable vehicle or no free Shared slot, an Operator asks students to use another Open Hub. Nothing is moved and no booking is changed; students see a "Busy, please use X" notice in Book and View Hubs and receive a notification. One active redirection per Hub.
- **Incidents** (UC-019, `server/src/services/incidentService.js`): Operators acknowledge and resolve incidents, optionally restoring the vehicle, slot or charger.
- **Menus per role**: Student = Book / Park / Charge / Report / View Hubs. Operator = Hub Dashboard, Smart Charging, Incidents, Vehicle & User Redistribution, What-if Simulation (view). Simulation Operator = Hub Dashboard, What-if Simulation. Admin = User Accounts, Roles & Access, Configuration. Menus are enforced in the client; the API keeps its role checks per route (an Admin can technically call Operator routes).
- An existing demo database is upgraded automatically at start (new columns/tables are added); no reseed is needed.

## Demo-only and beyond-MVP features

| Feature | Files | Label |
|---|---|---|
| Phone view (phone-sized frame) | `client/src/components/PhoneFrame.jsx` | **Demo-only** |
| Reset demo data (also deletes non-default accounts) | `server/src/services/demoResetService.js`, `client/src/pages/Admin.jsx` | **Demo-only** |
| Demo clock: speed x1/x10/x60/x300, pause, skip | `server/src/clock.js`, `client/src/components/DemoClockBar.jsx` | **Demo-only** |
| Demo account (all four roles) and role switch | `server/src/services/authService.js`, `client/src/components/AppShell.jsx` | **Demo-only** |
| "Register" line and decorative login art | `client/src/pages/Login.jsx`, `client/src/styles.css` | **Demo-only** (decoration) |
| Admin: User Accounts, Roles & Access, Configuration (system settings, Hubs, slots, chargers, vehicles) | `client/src/pages/Users.jsx`, `Access.jsx`, `Admin.jsx`; `server/src/services/userAdminService.js`, `settingsService.js`, `adminService.js` | Beyond MVP (UC-014/015/016) |
| Deactivated accounts cannot sign in | `server/src/middleware/requestContext.js` | Beyond MVP (UC-014) |
| Student Report a Problem | `client/src/student/ReportFlow.jsx` | Beyond MVP (UC-013) |
| Student History and booking cancel | `client/src/student/History.jsx` | Beyond MVP (UC-010/011) |
| Student Profile, "Larger text" | `client/src/student/Profile.jsx` | Beyond MVP (UC-012) |
| User redistribution advisory | `server/src/services/userRedirectService.js` | Beyond MVP (UC-020) |
| Redistribution planned from What-if recommendations | `server/src/services/redistributionService.js` | Beyond MVP (UC-025) |

## Demo accounts

The login page asks for a username (no password in the demo). Five accounts exist: admin, student, operator, simulation operator and demo; usernames are not case-sensitive and an unknown username is refused. The "Register" line is decoration only. **Demo** has all four roles: type `demo` and choose "Open as", or switch later (Profile for students, the side menu for staff). Demo accounts are demo-only (see above).

| Account | Role | Use |
|---|---|---|
| Student | Student | Book a vehicle, park, charge, report a problem, view Hubs |
| Operator | Operator | Hub dashboard, Smart Charging, incidents, vehicle redistribution, view What-if Simulation |
| Simulation Operator | Simulation Operator | Hub dashboard, run and review What-if Simulation (UC-023) |
| Admin | Admin | User accounts, roles and access, configuration |
| Demo | all four | Open any of the four experiences |

The demo role selector is not secure production authentication. It does not call the university identity provider. Full Admin account/role management is outside the selected MVP. Do not expose this MVP to the public internet without replacing the demo identity mechanism and adding production security controls.

## Seed data

The seed creates three identical example Hubs. Each has 30 parking slots (20 Shared and 10 Personal), 6 Holding slots, 5 chargers (1 kW each) and a shared fleet of 15 vehicles. It also creates two personal vehicles for the `Student` account, and one shared low-battery charging request. Seed data should also include enough resource and incident conditions to demonstrate the UC-017 monitoring and selected UC-019 incident-handling flows.

Seeded Hub Power Limits and charger power values are example demonstration data. They are not a group-approved operating configuration. Edit `data/configuration.json` and the Hub seed values if the team approves different values.

## Important business rules represented

- **Demo access:** the MVP uses local demo identities and fixed roles; real University SSO and full role administration are not included.
- **Hub status and monitoring:** stale or unavailable status must not be presented as confirmed current data. The Operator overview summarizes Hub capacity and resource conditions.
- **Shared booking:** a vehicle must be `Available`, have a battery level of at least 20%, and belong to an open Hub; a student may have at most one active shared booking; the booking is held for 15 minutes for pickup. Expiry and failed operations must release resources correctly.
- **Pickup/return:** only the owner of a valid booking can pick up the vehicle; pickup changes the booking to `In Progress` and the vehicle to `In Use`. Return requires an active trip and a free Shared slot. A returned shared vehicle below 20% becomes `Needs Charging` and is automatically queued.
- **Parking:** personal vehicles use Personal slots; the slot must support the vehicle type; reservation periods must be inside Hub operating hours; a vehicle's parking and charging periods cannot overlap; the arrival hold is 15 minutes after the start. Full overstay-to-Holding handling is outside the MVP.
- **Charging:** shared and personal requests use one common Hub charging area; connectors must match; simultaneous charger power cannot exceed the Hub Power Limit; personal vehicles have at most two requests per day and 15 minutes to connect after assignment. The scheduler uses the four approved criteria: Battery Level, Next Required Usage Time, Waiting Duration and Hub Power Limit.
- **Move Vehicle Request:** the request tracks the required movement and its result. A charger is not released before a required FROM_CHARGER request is `Done` (BR-46). The Shared slot reserved for a shared vehicle during charging is retained according to BR-39.
- **Redistribution:** source and destination capacity are validated before dispatch; a vehicle is counted as moved only when its arrival is recorded, and the destination must preserve the free Shared-slot return reserve (BR-29 / BR-40).
- **Incident handling:** incidents follow the core status lifecycle `Open → In Progress → Resolved → Closed`. An incident cannot be marked Resolved until the action is recorded and the affected resource status is verified (BR-30).
- **What-if simulation:** each run uses a baseline snapshot and stores results labelled `Simulated`; simulation must not change live resource state (BR-32). Recommendations produced by UC-023 remain proposals in the MVP; applying them through UC-025 is out of scope.
- **Audit:** important MVP transitions are written to SQLite `audit_logs`.

## Explicit demo assumptions — not approved requirements

Submission #1 v7 specifies that the Charging Scheduler uses Battery Level, Next Required Usage Time, Waiting Duration and Hub Power Limit (BR-20 / BR-21), and that the weights are configurable. The actual weights and scheduling interval are still to be defined by the group. To make the MVP demonstrable, `data/configuration.json` contains **illustrative weights** (0.5 / 0.3 / 0.2) and the service uses clearly named normalization horizons. It also uses a **45-minute illustrative charging-session estimate** to show approximate queue times. These are implementation placeholders, not approved business rules, and must be confirmed or replaced before final acceptance. The estimate is not a guarantee (BR-43).

The replacement threshold in BR-22 is not defined by the requirements. The demo replaces a shared vehicle's charging session only when the waiting personal request has a higher priority than that vehicle (same ranking as the queue); a booked shared vehicle is never replaced. The maximum charging-session duration (BR-23) is not defined, so maximum-session expiry is optional (`charging.maxSessionMinutes`, off by default). The group should confirm these rules, the 100% charging target, the 30% booking minimum and the 40% Holding reserve before they are treated as approved.

The MVP's UC-023 implementation ends with stored simulation results and proposed recommendations. Multi-run comparison (UC-024), recommendation application and operational workflow hand-off (UC-025), redirect advisories (UC-020) and advanced charging schedule adjustment (UC-022) are not included in the agreed MVP, even if experimental code or routes for a later iteration are present in the repository.

**Violation points are out of MVP scope.** Submission 1 describes them (BR-11, BR-12, BR-52), but the MVP records none: expired bookings, unused reservations and late returns only release the resource and notify the student, and no student is suspended (`RECORD_VIOLATIONS = false` in `server/src/services/commonService.js`).

Timing reminders, the 3-hour overdue-trip warning, parking/charging overstay flags, student problem reporting and an Admin configuration editor exist as supporting demo behaviour, but they are not acceptance criteria. The parking overstay-to-Holding workflow, all incident categories and the violation appeal/restriction lifecycle are not implemented. UC-019 is limited to the selected core incident-handling path.

## Tests and verification

Run the backend workflow tests from the project root (`node --test server/test/*.test.js`, 43 tests, each run uses an in-memory database from `server/testSetup.js`, so the demo data is untouched):

```bash
npm test
```

The MVP acceptance tests should cover: (1) UC-005 / UC-006 / UC-007 booking, pickup, low-battery return and automatic queueing; (2) UC-008 parking reservation, arrival/departure and conflict validation; (3) UC-009 / UC-021 personal charging, scheduler allocation, connector/Hub Power Limit validation and charger release only after Move Vehicle Request `Done`; (4) UC-017 / UC-018 network monitoring and the basic redistribution plan/dispatch/arrival workflow; (5) UC-019 incident status and resource-state updates; and (6) UC-023 simulation isolation, stored results and proposed recommendations.

The test suite also covers supporting features (timers, Admin configuration, user accounts, reset, user redistribution) and may retain regression tests for later features such as UC-024 comparison and UC-025 recommendation hand-off. Those tests do not expand the agreed MVP scope or acceptance criteria.

The JSX source was syntax-parsed and the backend JavaScript / JSON files were checked. The frontend production bundle and live Express HTTP server were not built or smoke-tested in the preparation environment because npm dependency installation could not complete there; run `npm install` followed by `npm run dev` on a machine with npm registry access.

## API overview

Main endpoints (route definitions are in `server/src/routes`). Rows marked *support* are demo or beyond-MVP.

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

The `/api/simulation/compare` and `/api/simulation/recommendations/:id/apply` endpoints are not part of the agreed MVP acceptance scope because UC-024 and UC-025 are deferred.

## Project structure

```text
smart-e-mobility-hub/
├── client/
│   ├── index.html
│   ├── package.json
│   └── src/
│       ├── pages/                 # Login, HubDashboard, Charging, Incidents, Dispatch (vehicle & user redistribution),
│       │                          # Simulation, Users, Access, Admin
│       ├── student/               # Student app: StudentApp, Home, BookFlow, ParkFlow, ChargeFlow, ReportFlow,
│       │                          # Hubs, History, Notifications, Profile, ui.jsx, student.css
│       ├── components/            # AppShell, PhoneFrame (demo), DemoClockBar (demo), NotificationBell, Timers,
│       │                          # StatusBadge, StatCard, SectionHeader, RefreshButton, Feedback
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
│   └── Technical_Design_Document.pdf
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
