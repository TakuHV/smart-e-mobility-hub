# Smart E-Mobility Hub — MVP

A student-level MVP built with **React + JavaScript + Node.js + Express + SQLite**. The MVP is based on the agreed requirements baseline and focuses on **13 selected use cases** that demonstrate the main student, resource-management, operations, charging and simulation workflows. It does not attempt to implement all 25 use cases in Submission #1.

## MVP scope

The agreed MVP contains **9 core business use cases** and **4 supporting use cases**. The scope identifies what the team commits to demonstrate; it does not mean that every alternative flow, exception flow or advanced policy in the full requirements specification must be implemented.

### Supporting use cases

| Work area | Use cases | MVP implementation boundary |
|---|---|---|
| Demo access | **UC-001 — Log in** | Local demo identity and role selection for the Student, Operator and Simulation Operator workflows. This is not production authentication or University SSO integration. |
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

## Demo accounts

The login page creates or reuses a simple local demo identity by display name and role. Suggested accounts for the selected MVP workflows:

| Display name | Role | Use |
|---|---|---|
| Demo Student | Student | Hub search/status, shared-vehicle booking/pickup/return, personal parking and personal charging |
| Demo Operator | Operator | Network monitoring, vehicle redistribution, incident handling and Smart Charging Scheduler |
| Demo Simulation Operator | Simulation Operator | Run and review an individual What-if Simulation (UC-023) |

The demo role selector is not secure production authentication. It does not call the university identity provider. Full Admin account/role management is outside the selected MVP. Do not expose this MVP to the public internet without replacing the demo identity mechanism and adding production security controls.

## Seed data

The seed creates three example Hubs, Shared and Personal parking slots, Holding slots, chargers, a small shared fleet, two personal vehicles for `Demo Student`, and one shared low-battery charging request. Seed data should also include enough resource and incident conditions to demonstrate the UC-017 monitoring and selected UC-019 incident-handling flows.

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

Submission #1 v7 specifies that the Charging Scheduler uses Battery Level, Next Required Usage Time, Waiting Duration and Hub Power Limit (BR-20 / BR-21), and that the weights are configurable. The actual weights and scheduling interval are still to be defined by the group. To make the MVP demonstrable, `configuration.json` contains **equal illustrative weights** and the service uses clearly named normalization horizons. It also uses a **45-minute illustrative charging-session estimate** to show approximate queue times. These are implementation placeholders, not approved business rules, and must be confirmed or replaced before final acceptance. The estimate is not a guarantee (BR-43).

The replacement threshold in BR-22 and the maximum charging-session duration in BR-23 are not defined, so automatic charging-session replacement and maximum-session expiry are not implemented. Charging sessions can be completed manually in the demo.

The MVP's UC-023 implementation ends with stored simulation results and proposed recommendations. Multi-run comparison (UC-024), recommendation application and operational workflow hand-off (UC-025), redirect advisories (UC-020) and advanced charging schedule adjustment (UC-022) are not included in the agreed MVP, even if experimental code or routes for a later iteration are present in the repository.

The MVP does not implement every timing reminder, 3-hour overdue-trip escalation, parking overstay-to-Holding workflow, all incident categories, violation appeal/restriction lifecycle, student problem-reporting workflow, or complete UC-016 configuration editor. UC-019 is limited to the selected core incident-handling path; these advanced supporting flows remain outside the MVP.

## Tests and verification

Run the backend workflow tests from the project root:

```bash
npm test
```

The MVP acceptance tests should cover: (1) UC-005 / UC-006 / UC-007 booking, pickup, low-battery return and automatic queueing; (2) UC-008 parking reservation, arrival/departure and conflict validation; (3) UC-009 / UC-021 personal charging, scheduler allocation, connector/Hub Power Limit validation and charger release only after Move Vehicle Request `Done`; (4) UC-017 / UC-018 network monitoring and the basic redistribution plan/dispatch/arrival workflow; (5) UC-019 incident status and resource-state updates; and (6) UC-023 simulation isolation, stored results and proposed recommendations.

The existing test suite may retain regression tests for later or experimental features such as UC-024 comparison and UC-025 recommendation hand-off. Those tests do not expand the agreed MVP scope or acceptance criteria.

The JSX source was syntax-parsed and the backend JavaScript / JSON files were checked. The frontend production bundle and live Express HTTP server were not built or smoke-tested in the preparation environment because npm dependency installation could not complete there; run `npm install` followed by `npm run dev` on a machine with npm registry access.

## API overview

The following are the currently documented main endpoints associated with MVP workflows. Monitoring, redistribution and incident routes should be kept consistent with the actual route definitions in `server/src/routes`; their exact paths are not guessed here.

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

The `/api/simulation/compare` and `/api/simulation/recommendations/:id/apply` endpoints are not part of the agreed MVP acceptance scope because UC-024 and UC-025 are deferred.

## Project structure

```text
smart-e-mobility-hub/
├── client/
│   ├── index.html
│   ├── package.json
│   └── src/
│       ├── pages/                 # Login, Dashboard, Vehicles, Parking, Charging, Simulation
│       ├── components/            # App shell, status badges, stat cards, feedback
│       ├── api.js
│       ├── App.jsx
│       ├── main.jsx
│       └── styles.css
├── server/
│   ├── package.json
│   ├── src/
│   │   ├── routes/
│   │   ├── services/
│   │   ├── middleware/
│   │   ├── database/              # SQLite schema, connection and seed
│   │   └── app.js
│   └── test/
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
