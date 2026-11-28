PRAGMA foreign_keys = ON;

/*
 * Rules for this file
 *  - It runs at every start, so every statement must be CREATE ... IF NOT EXISTS.
 *  - Indexes and triggers added here also reach an existing database file.
 *    A changed column or CHECK does NOT: delete data/smart_e_mobility.sqlite (and -wal, -shm) to rebuild it.
 *  - All timestamps are UTC ISO-8601 strings written by the code (new Date().toISOString()). The code compares them
 *    as text, so the columns it compares reject any other format (CHECK ... GLOB). Do not use CURRENT_TIMESTAMP for them.
 */

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('Student','Operator','Simulation Operator','Admin')),
  status TEXT NOT NULL DEFAULT 'Active',            -- 'Deactivated' accounts cannot sign in (BR-07)
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(full_name, role)
);

CREATE TABLE IF NOT EXISTS hubs (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  location TEXT NOT NULL,
  open_time TEXT NOT NULL DEFAULT '05:00',
  close_time TEXT NOT NULL DEFAULT '23:00',
  power_limit_kw REAL NOT NULL CHECK (power_limit_kw > 0),
  status TEXT NOT NULL DEFAULT 'Open',
  sensor_updated_at TEXT NOT NULL,
  CHECK (open_time < close_time)                       -- 'HH:MM', same day (BR-42)
);

CREATE TABLE IF NOT EXISTS vehicles (
  id TEXT PRIMARY KEY,
  plate TEXT NOT NULL UNIQUE,
  vehicle_type TEXT NOT NULL,
  connector_type TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('shared','personal')),
  hub_id TEXT REFERENCES hubs(id),
  owner_id TEXT REFERENCES users(id),
  battery_level INTEGER NOT NULL CHECK (battery_level BETWEEN 0 AND 100),
  status TEXT NOT NULL,
  next_required_usage_at TEXT,                         -- NULL = not entered by the Operator (OD-2)
  updated_at TEXT NOT NULL,
  CHECK ((kind='shared' AND owner_id IS NULL) OR (kind='personal' AND owner_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS parking_slots (
  id TEXT PRIMARY KEY,
  hub_id TEXT NOT NULL REFERENCES hubs(id),
  code TEXT NOT NULL,
  slot_type TEXT NOT NULL CHECK (slot_type IN ('Shared','Personal','Holding')),
  supported_vehicle_types_json TEXT NOT NULL DEFAULT '["Motorcycle"]',
  status TEXT NOT NULL DEFAULT 'Available',
  current_vehicle_id TEXT REFERENCES vehicles(id),
  updated_at TEXT NOT NULL,
  UNIQUE(hub_id, code)
);

CREATE TABLE IF NOT EXISTS chargers (
  id TEXT PRIMARY KEY,
  hub_id TEXT NOT NULL REFERENCES hubs(id),
  code TEXT NOT NULL,
  connector_types_json TEXT NOT NULL,
  power_kw REAL NOT NULL CHECK (power_kw > 0),
  status TEXT NOT NULL DEFAULT 'Available',
  current_vehicle_id TEXT REFERENCES vehicles(id),
  updated_at TEXT NOT NULL,
  UNIQUE(hub_id, code)
);

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
  hub_id TEXT NOT NULL REFERENCES hubs(id),
  status TEXT NOT NULL CHECK (status IN ('Confirmed','In Progress','Overdue','Completed','Cancelled','Expired')),
  pickup_deadline TEXT NOT NULL
    CHECK (pickup_deadline GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  started_at TEXT,
  returned_at TEXT,
  start_battery INTEGER,                              -- battery percent at pickup (trip consumption starts from it)
  overdue_at TEXT,                                    -- when the trip passed the maximum duration (NI-11)
  destination_hub_id TEXT REFERENCES hubs(id),        -- Hub the student said they are driving to (optional)
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS parking_reservations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
  hub_id TEXT NOT NULL REFERENCES hubs(id),
  slot_id TEXT NOT NULL REFERENCES parking_slots(id),
  status TEXT NOT NULL CHECK (status IN ('Confirmed','In Progress','Completed','Cancelled','Expired')),
  start_at TEXT NOT NULL
    CHECK (start_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  end_at TEXT NOT NULL
    CHECK (end_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  expires_at TEXT NOT NULL
    CHECK (expires_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  arrived_at TEXT,
  completed_at TEXT,
  overstay_flagged_at TEXT,                           -- vehicle still parked after the grace period (NI-09)
  created_at TEXT NOT NULL,
  CHECK (end_at > start_at)
);

CREATE TABLE IF NOT EXISTS charging_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
  hub_id TEXT NOT NULL REFERENCES hubs(id),
  request_type TEXT NOT NULL CHECK (request_type IN ('personal','shared_automatic')),
  status TEXT NOT NULL CHECK (status IN ('Queued','Assigned','Charging','Completed','Cancelled','Expired')),
  battery_level INTEGER NOT NULL CHECK (battery_level BETWEEN 0 AND 100),
  next_required_usage_at TEXT                          -- NULL when unknown (OD-2): urgency is then 0
    CHECK (next_required_usage_at IS NULL
      OR next_required_usage_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  registered_at TEXT NOT NULL
    CHECK (registered_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  assigned_at TEXT,
  connect_deadline TEXT,
  charger_id TEXT REFERENCES chargers(id),
  charging_started_at TEXT,
  start_battery INTEGER,                              -- battery percent when charging started
  charging_completed_at TEXT,
  overstay_flagged_at TEXT,                           -- vehicle still at the charger after the grace period (NI-09)
  estimated_start_at TEXT,
  available_from TEXT,                                -- a request registered ahead of time waits until this moment
  priority_score REAL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS move_vehicle_requests (
  id TEXT PRIMARY KEY,
  charging_request_id TEXT REFERENCES charging_requests(id),
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
  charger_id TEXT NOT NULL REFERENCES chargers(id),
  direction TEXT NOT NULL CHECK (direction IN ('TO_CHARGER','FROM_CHARGER')),
  status TEXT NOT NULL CHECK (status IN ('Requested','In Progress','Done','Cancelled')),
  assigned_to TEXT,
  requested_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  note TEXT,
  auto_send_at TEXT,                                  -- the request is sent by itself at this time unless an Operator stops it
  sent_at TEXT,
  destination TEXT NOT NULL DEFAULT 'Slot'            -- 'Slot' (Shared slot or Personal slot) or 'Holding'
);

CREATE TABLE IF NOT EXISTS violations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  points INTEGER NOT NULL CHECK (points > 0),
  reason TEXT NOT NULL,
  source_type TEXT,
  source_id TEXT,
  recorded_at TEXT NOT NULL
    CHECK (recorded_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  expires_at TEXT NOT NULL
    CHECK (expires_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'),
  status TEXT NOT NULL DEFAULT 'Recorded' CHECK (status IN ('Recorded','Upheld','Disputed','Dismissed'))
);

CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  hub_id TEXT REFERENCES hubs(id),
  vehicle_id TEXT REFERENCES vehicles(id),
  summary TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Open',                -- Open -> In Progress -> Resolved
  created_at TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Vehicle fault',     -- Vehicle fault, Charger fault, Slot blocked, Safety, Other
  severity TEXT NOT NULL DEFAULT 'Medium',            -- Low, Medium, High
  source TEXT NOT NULL DEFAULT 'operator',            -- return, student, operator
  charger_id TEXT REFERENCES chargers(id),
  slot_id TEXT REFERENCES parking_slots(id),
  reported_by TEXT,
  assigned_to TEXT,
  resolution_note TEXT,
  updated_at TEXT,
  resolved_at TEXT
);

-- Settings changed in the Admin area. They are applied on top of data/configuration.json at every start.
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

-- UC-018: an Operator moves one shared vehicle from one Hub to another.
CREATE TABLE IF NOT EXISTS redistribution_tasks (
  id TEXT PRIMARY KEY,
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
  from_hub_id TEXT NOT NULL REFERENCES hubs(id),
  to_hub_id TEXT NOT NULL REFERENCES hubs(id),
  from_slot_id TEXT REFERENCES parking_slots(id),
  to_slot_id TEXT REFERENCES parking_slots(id),      -- the free Shared slot kept for the vehicle at the destination
  status TEXT NOT NULL CHECK (status IN ('Requested','In Progress','Done','Cancelled')),
  reason TEXT,
  handoff_id TEXT REFERENCES recommendation_handoffs(id),
  requested_by TEXT NOT NULL,
  assigned_to TEXT,
  requested_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  CHECK (from_hub_id <> to_hub_id)
);

-- User redirection (UC-020 style advisory): an Operator asks students to use another Hub while one Hub is busy.
CREATE TABLE IF NOT EXISTS hub_redirects (
  id TEXT PRIMARY KEY,
  from_hub_id TEXT NOT NULL REFERENCES hubs(id),
  to_hub_id TEXT NOT NULL REFERENCES hubs(id),
  reason TEXT,
  status TEXT NOT NULL CHECK (status IN ('Active','Ended')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  ended_at TEXT,
  CHECK (from_hub_id <> to_hub_id)
);
-- A Hub has at most one active redirection.
CREATE UNIQUE INDEX IF NOT EXISTS ux_active_redirect_per_hub ON hub_redirects(from_hub_id) WHERE status='Active';

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  audience_role TEXT,                                 -- 'Operator' reaches every Operator and Admin
  kind TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','critical')),
  created_at TEXT NOT NULL,
  read_at TEXT,
  CHECK (user_id IS NOT NULL OR audience_role IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  responsible_user TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS simulation_runs (
  id TEXT PRIMARY KEY,
  scenario_type TEXT NOT NULL,
  hub_id TEXT NOT NULL REFERENCES hubs(id),
  label TEXT NOT NULL DEFAULT 'Simulated',
  baseline_json TEXT NOT NULL,
  parameters_json TEXT NOT NULL,
  results_json TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recommendations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES simulation_runs(id),
  type TEXT NOT NULL CHECK (type IN ('REDISTRIBUTE_VEHICLES','ADJUST_CHARGING','REDIRECT_USERS')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  projected_benefit TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('Proposed','Sent for Execution','Applied','Declined')),
  created_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS recommendation_handoffs (
  id TEXT PRIMARY KEY,
  recommendation_id TEXT NOT NULL REFERENCES recommendations(id),
  target_workflow TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Completed')),
  prefilled_payload_json TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  completed_at TEXT
);

/* ---------- Indexes for the queries the services run ---------- */
CREATE INDEX IF NOT EXISTS idx_vehicles_hub_kind_status ON vehicles(hub_id, kind, status);
CREATE INDEX IF NOT EXISTS idx_slots_hub_type_status ON parking_slots(hub_id, slot_type, status);
CREATE INDEX IF NOT EXISTS idx_slots_current_vehicle ON parking_slots(current_vehicle_id);
CREATE INDEX IF NOT EXISTS idx_chargers_hub_status ON chargers(hub_id, status);
CREATE INDEX IF NOT EXISTS idx_bookings_user_status ON bookings(user_id, status);
CREATE INDEX IF NOT EXISTS idx_bookings_vehicle_status ON bookings(vehicle_id, status);
CREATE INDEX IF NOT EXISTS idx_parking_reservation_vehicle_period ON parking_reservations(vehicle_id, start_at, end_at, status);
CREATE INDEX IF NOT EXISTS idx_parking_reservation_slot_period ON parking_reservations(slot_id, status, start_at, end_at);
CREATE INDEX IF NOT EXISTS idx_charging_queue ON charging_requests(hub_id, status, registered_at);
CREATE INDEX IF NOT EXISTS idx_charging_vehicle_status ON charging_requests(vehicle_id, status);
CREATE INDEX IF NOT EXISTS idx_charging_charger ON charging_requests(charger_id, status);
CREATE INDEX IF NOT EXISTS idx_move_requests_status ON move_vehicle_requests(status);
CREATE INDEX IF NOT EXISTS idx_violations_user_status ON violations(user_id, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_recommendations_run ON recommendations(run_id);
CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status, created_at);
CREATE INDEX IF NOT EXISTS idx_redistribution_status ON redistribution_tasks(status, requested_at);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_role ON notifications(audience_role, created_at);

/* ---------- Rules the database itself must enforce (BR-08, BR-09, BR-36, BR-46, BR-33, BR-52) ---------- */
-- A student has one active shared-vehicle booking (BR-09); a vehicle has one active booking (BR-08).
CREATE UNIQUE INDEX IF NOT EXISTS ux_active_booking_per_user
  ON bookings(user_id) WHERE status IN ('Confirmed','In Progress','Overdue');
CREATE UNIQUE INDEX IF NOT EXISTS ux_active_booking_per_vehicle
  ON bookings(vehicle_id) WHERE status IN ('Confirmed','In Progress','Overdue');
-- A slot holds one pending reservation at a time (MVP model, see parkingService).
CREATE UNIQUE INDEX IF NOT EXISTS ux_pending_reservation_per_slot
  ON parking_reservations(slot_id) WHERE status IN ('Confirmed','In Progress');
-- A vehicle has one active charging request, and sits at one charger at a time.
CREATE UNIQUE INDEX IF NOT EXISTS ux_active_charge_per_vehicle
  ON charging_requests(vehicle_id) WHERE status IN ('Queued','Assigned','Charging');
CREATE UNIQUE INDEX IF NOT EXISTS ux_charger_current_vehicle
  ON chargers(current_vehicle_id) WHERE current_vehicle_id IS NOT NULL;
-- One open Move Vehicle Request per charging request and direction.
CREATE UNIQUE INDEX IF NOT EXISTS ux_open_move_per_request_direction
  ON move_vehicle_requests(charging_request_id, direction) WHERE status IN ('Requested','In Progress');
-- The same source is never penalised twice (matches addViolation).
CREATE UNIQUE INDEX IF NOT EXISTS ux_violation_source
  ON violations(user_id, source_type, source_id) WHERE source_type IS NOT NULL AND source_id IS NOT NULL;

-- The same reminder for the same entity and addressee is stored once (NI-06, NI-09, NI-11).
CREATE UNIQUE INDEX IF NOT EXISTS ux_notification_once
  ON notifications(kind, entity_type, entity_id, COALESCE(user_id, ''), COALESCE(audience_role, ''));

-- A vehicle is part of at most one open redistribution task.
CREATE UNIQUE INDEX IF NOT EXISTS ux_open_redistribution_per_vehicle
  ON redistribution_tasks(vehicle_id) WHERE status IN ('Requested','In Progress');

-- A stored simulation run cannot be edited or deleted (BR-33).
CREATE TRIGGER IF NOT EXISTS simulation_runs_no_update BEFORE UPDATE ON simulation_runs
BEGIN SELECT RAISE(ABORT, 'Stored simulation runs cannot be edited (BR-33)'); END;
CREATE TRIGGER IF NOT EXISTS simulation_runs_no_delete BEFORE DELETE ON simulation_runs
BEGIN SELECT RAISE(ABORT, 'Stored simulation runs cannot be deleted (BR-33)'); END;
