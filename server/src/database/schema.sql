PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('Student','Operator','Simulation Operator','Admin')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(full_name, role)
);

CREATE TABLE IF NOT EXISTS hubs (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  location TEXT NOT NULL,
  open_time TEXT NOT NULL DEFAULT '05:00',
  close_time TEXT NOT NULL DEFAULT '23:00',
  power_limit_kw REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'Open',
  sensor_updated_at TEXT NOT NULL
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
  next_required_usage_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK ((kind='shared' AND owner_id IS NULL) OR (kind='personal' AND owner_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS parking_slots (
  id TEXT PRIMARY KEY,
  hub_id TEXT NOT NULL REFERENCES hubs(id),
  code TEXT NOT NULL,
  slot_type TEXT NOT NULL CHECK (slot_type IN ('Shared','Personal','Holding')),
  supported_vehicle_types_json TEXT NOT NULL DEFAULT '["Motorcycle","Car"]',
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
  power_kw REAL NOT NULL,
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
  pickup_deadline TEXT NOT NULL,
  started_at TEXT,
  returned_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS parking_reservations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
  hub_id TEXT NOT NULL REFERENCES hubs(id),
  slot_id TEXT NOT NULL REFERENCES parking_slots(id),
  status TEXT NOT NULL CHECK (status IN ('Confirmed','In Progress','Completed','Cancelled','Expired')),
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  arrived_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS charging_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
  hub_id TEXT NOT NULL REFERENCES hubs(id),
  request_type TEXT NOT NULL CHECK (request_type IN ('personal','shared_automatic')),
  status TEXT NOT NULL CHECK (status IN ('Queued','Assigned','Charging','Completed','Cancelled','Expired')),
  battery_level INTEGER NOT NULL,
  next_required_usage_at TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  assigned_at TEXT,
  connect_deadline TEXT,
  charger_id TEXT REFERENCES chargers(id),
  charging_started_at TEXT,
  charging_completed_at TEXT,
  estimated_start_at TEXT,
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
  note TEXT
);

CREATE TABLE IF NOT EXISTS violations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  points INTEGER NOT NULL,
  reason TEXT NOT NULL,
  source_type TEXT,
  source_id TEXT,
  recorded_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Recorded'
);

CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  hub_id TEXT REFERENCES hubs(id),
  vehicle_id TEXT REFERENCES vehicles(id),
  summary TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Open',
  created_at TEXT NOT NULL
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
  status TEXT NOT NULL DEFAULT 'Pending',
  prefilled_payload_json TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_vehicles_hub_kind_status ON vehicles(hub_id, kind, status);
CREATE INDEX IF NOT EXISTS idx_slots_hub_type_status ON parking_slots(hub_id, slot_type, status);
CREATE INDEX IF NOT EXISTS idx_chargers_hub_status ON chargers(hub_id, status);
CREATE INDEX IF NOT EXISTS idx_bookings_user_status ON bookings(user_id, status);
CREATE INDEX IF NOT EXISTS idx_parking_reservation_vehicle_period ON parking_reservations(vehicle_id, start_at, end_at, status);
CREATE INDEX IF NOT EXISTS idx_charging_queue ON charging_requests(hub_id, status, registered_at);
CREATE INDEX IF NOT EXISTS idx_move_requests_status ON move_vehicle_requests(status);
