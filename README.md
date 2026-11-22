# Smart E-Mobility Hub — MVP

A student-level MVP built with **React + JavaScript + Node.js + Express + SQLite**. It focuses on a small set of end-to-end workflows and on server-side business rules and status transitions. It does not attempt to implement all 25 use cases.

## MVP scope

| Work area | Use cases / workflow | Implemented result |
|---|---|---|
| Hub discovery | UC-003, UC-004 | Search Hubs, inspect slot, vehicle, charger, queue and sensor-status summaries |
| Shared vehicle | UC-005, UC-006, UC-007 | Book → pickup → return; battery validation; automatic charging queue on low-battery return |
| Personal parking | UC-008 | Register a personal vehicle, reserve a compatible Personal slot, arrive and complete departure |
| Smart charging | UC-009, UC-021, UC-022 | Personal request registration, shared-vehicle auto-queue, scheduler allocation, connector/power checks and schedule adjustment for shared vehicles |
| Move Vehicle Request | BR-46 / status model | Requested → In Progress → Done; charger is released only after a FROM_CHARGER request is Done |
| What-if simulation | UC-023, UC-024, UC-025 | Snapshot-based simulation, immutable runs, comparison, recommendations and workflow hand-off records |

The MVP uses one web client, one Express backend and one SQLite database. The seeded Hub / vehicle / slot / charger status acts as the mock sensor feed; the backend refreshes its freshness timestamp and reports Fresh / Stale status without inventing random operational state changes. There is no real University SSO, physical IoT, payment gateway, Docker, Kubernetes, microservices, Redis, message broker, WebSocket, ORM, or AI/ML scheduler.

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

The login page creates or reuses a simple local demo identity by display name and role. Suggested accounts:

| Display name | Role | Use |
|---|---|---|
| Demo Student | Student | Hub search, shared booking, personal parking and personal charging |
| Demo Operator | Operator | Charging Scheduler and Move Vehicle Requests |
| Demo Simulation Operator | Simulation Operator | Run/compare simulations and send recommendations |
| Demo Admin | Admin | MVP operator-level actions and simulation access |

This is a demo role selector, not secure production authentication. It does not call the university identity provider. Do not expose this MVP to the public internet without replacing the demo identity mechanism and adding production security controls.

## Seed data

The seed creates three example Hubs, Shared and Personal parking slots, Holding slots, chargers, a small shared fleet, two personal vehicles for `Demo Student`, and one shared low-battery charging request.

Seeded Hub Power Limits and charger power values are example demonstration data. They are not a group-approved operating configuration. Edit `data/configuration.json` and the Hub seed values if the team approves different values.

## Important business rules represented

- **Shared booking:** vehicle must be `Available`, battery at least 20%, Hub open; one active booking per student; 15-minute pickup hold; cancellation and expiry release the vehicle.
- **Pickup/return:** only the owner can act on their booking; pickup moves the booking to `In Progress` and vehicle to `In Use`; return requires an active trip and a free Shared slot. A returned shared vehicle below 20% becomes `Needs Charging` and is automatically queued.
- **Parking:** personal vehicles use Personal slots; the slot must support the vehicle type; reservation periods must be inside the Hub operating hours; a vehicle's parking and charging periods cannot overlap; the arrival hold is 15 minutes after the start.
- **Charging:** shared and personal requests use one common Hub charging area; connectors must match; simultaneous charger power cannot exceed the Hub Power Limit; personal vehicles have at most two requests per day and 15 minutes to connect after assignment.
- **Move Vehicle Request:** shared vehicle assignment creates a TO_CHARGER request; charging completion creates a FROM_CHARGER request. The shared vehicle's Shared slot remains `Reserved` during charging and is occupied again after the removal is confirmed. The charger remains unavailable until the removal request reaches `Done` (BR-39 / BR-46).
- **Simulation:** each run stores a baseline snapshot and results labelled `Simulated`; the simulation service writes only simulation/recommendation records, not operational resource state. Stored runs are not editable. Recommendations are sent to their matching workflow as a pre-filled hand-off and are not marked Applied at submission time.
- **Audit:** important MVP transitions are written to SQLite `audit_logs`.

## Explicit demo assumptions — not approved requirements

Submission #1 v7 says the Charging Scheduler uses Battery Level, Next Required Usage Time, Waiting Duration and Hub Power Limit (BR-20/BR-21), and that weights are configurable. The actual weights and scheduling interval are still to be defined by the group. To make the MVP demonstrable, `configuration.json` contains **equal illustrative weights** and the service uses clearly named normalization horizons. It also uses a **45-minute illustrative charging-session estimate** to show approximate queue times. These are implementation placeholders, not approved business rules, and must be confirmed or replaced before final acceptance. The estimate is not a guarantee (BR-43).

The replacement threshold in BR-22 and the maximum charging-session duration in BR-23 are not defined, so automatic charging-session replacement and maximum-session expiry are not implemented. Charging sessions can be completed manually in the demo.

The MVP stores in-app workflow hand-offs for UC-018 / UC-020 / UC-022; it does not fully implement the complete redistribution, redirect-advisory or advanced charging-adjustment use cases. A recommendation remains `Sent for Execution` until the receiving workflow is completed. This preserves the BR-34 rule that selecting a recommendation must not directly change live resources.

The MVP does not implement every timing reminder, 3-hour overdue trip escalation, parking overstay-to-Holding workflow, incident-management console, violation appeal/restriction lifecycle, or complete UC-016 configuration editor. It records the core violation cases exercised by these workflows, but these supporting use cases remain outside the selected MVP scope.


## Tests and verification

Run the backend workflow tests from the project root:

```bash
npm test
```

The five service-level integration tests cover: (1) UC-005 / UC-006 / UC-007 booking, pickup, low-battery return and automatic queueing; (2) UC-008 parking reservation and cancellation; (3) UC-009 / UC-021 personal charging and charger release only after Move Vehicle Request `Done`; (4) UC-023 / UC-024 / UC-025 simulation isolation, comparison and recommendation hand-off; and (5) the shared-vehicle TO_CHARGER / FROM_CHARGER cycle, including the Shared-slot hold required by BR-39.

The JSX source was syntax-parsed and the backend JavaScript / JSON files were checked. The frontend production bundle and live Express HTTP server were not built or smoke-tested in the preparation environment because npm dependency installation could not complete there; run `npm install` followed by `npm run dev` on a machine with npm registry access.

## API overview

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/auth/demo-login` | Create/reuse demo identity |
| GET | `/api/hubs` | Search and list Hubs |
| GET | `/api/hubs/:hubId/status` | Hub resource status |
| GET | `/api/vehicles?kind=shared` | List shared fleet |
| GET / POST | `/api/vehicles/bookings` | List / create shared bookings |
| POST | `/api/vehicles/bookings/:id/pickup` | Pick up shared vehicle |
| POST | `/api/vehicles/bookings/:id/return` | Return shared vehicle |
| GET / POST | `/api/parking/reservations` | List / reserve personal parking |
| POST | `/api/parking/reservations/:id/arrive` | Check in |
| POST | `/api/parking/reservations/:id/complete` | Record departure |
| GET | `/api/charging/queue` | Queue, chargers and movement requests |
| POST | `/api/charging/requests` | Register personal charging request |
| POST | `/api/charging/run-scheduler` | Run operator scheduler cycle |
| POST | `/api/charging/move-requests/:id/start` | Start physical movement |
| POST | `/api/charging/move-requests/:id/done` | Confirm movement and release charger when applicable |
| POST | `/api/simulation/runs` | Run a what-if simulation |
| POST | `/api/simulation/compare` | Compare two or more stored runs |
| POST | `/api/simulation/recommendations/:id/apply` | Send recommendation to a workflow |

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
