-- ============================================================================
-- BREW COFFEE PLATFORM: PRODUCTION DATABASE SCHEMA (POSTGRESQL / SUPABASE / NEON)
-- ============================================================================
-- Designed for Serverless Postgres (Supabase, Neon, AWS RDS Aurora)
-- Real-time publication enabled for sub-500ms multi-device barista/board updates.

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ----------------------------------------------------------------------------
-- 1. VANS TABLE (Active Mobile Units, GPS, Status, Operating Hours)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vans (
    id VARCHAR(64) PRIMARY KEY,
    spot_name VARCHAR(255) NOT NULL,
    address TEXT NOT NULL,
    city VARCHAR(100) NOT NULL,
    hours VARCHAR(100) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'serving' CHECK (status IN ('serving', 'moving', 'closed', 'break')),
    notes TEXT,
    lat DOUBLE PRECISION NOT NULL,
    lng DOUBLE PRECISION NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------------------------
-- 2. ORDERS TABLE (Customer Token, Status, Timing, Curbside Signals)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
    id VARCHAR(64) PRIMARY KEY,
    order_number VARCHAR(20) NOT NULL,
    customer_name VARCHAR(150) NOT NULL DEFAULT 'Sanctuary Guest',
    customer_phone VARCHAR(50),
    total_amount NUMERIC(10, 2) NOT NULL DEFAULT 0.00,
    status VARCHAR(50) NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'brewing', 'ready', 'served', 'cancelled')),
    pickup_type VARCHAR(50) NOT NULL DEFAULT 'walkup' CHECK (pickup_type IN ('walkup', 'curbside')),
    vehicle_info TEXT,
    van_location_name VARCHAR(255) NOT NULL,
    notes TEXT,
    curbside_arrival_status VARCHAR(50) CHECK (curbside_arrival_status IN ('approaching', 'arrived')),
    van_id VARCHAR(64) REFERENCES vans(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_pickup ON orders(pickup_type);

-- ----------------------------------------------------------------------------
-- 3. ORDER ITEMS TABLE (Individual Beverage/Bakery Line Items)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_items (
    id VARCHAR(64) PRIMARY KEY,
    order_id VARCHAR(64) NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    item_id VARCHAR(64) NOT NULL,
    name VARCHAR(200) NOT NULL,
    price NUMERIC(10, 2) NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
    category VARCHAR(100),
    image TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);

-- ----------------------------------------------------------------------------
-- 4. INVENTORY LOGS (Inventory Sentinel Real-Time Raw Stock Tracking)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inventory_logs (
    id VARCHAR(64) PRIMARY KEY,
    van_id VARCHAR(64) REFERENCES vans(id) ON DELETE SET NULL,
    espresso_beans_g INTEGER NOT NULL,
    whole_milk_ml INTEGER NOT NULL,
    oat_milk_ml INTEGER NOT NULL,
    matcha_powder_g INTEGER NOT NULL,
    syrup_vanilla_pumps INTEGER NOT NULL,
    cups_paper_count INTEGER NOT NULL,
    log_type VARCHAR(50) NOT NULL DEFAULT 'deduction' CHECK (log_type IN ('deduction', 'restock', 'audit')),
    delta_reason VARCHAR(255),
    last_restocked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inventory_created_at ON inventory_logs(created_at DESC);

-- ----------------------------------------------------------------------------
-- 5. REVIEWS & CUSTOMER FEEDBACK (AI Sentiment & Location Improvement)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reviews (
    id VARCHAR(64) PRIMARY KEY,
    customer_name VARCHAR(150) NOT NULL,
    rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
    comment TEXT NOT NULL,
    location_spot VARCHAR(255) NOT NULL,
    sentiment VARCHAR(50) DEFAULT 'positive' CHECK (sentiment IN ('positive', 'neutral', 'negative')),
    van_id VARCHAR(64) REFERENCES vans(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reviews_location ON reviews(location_spot);
CREATE INDEX IF NOT EXISTS idx_reviews_rating ON reviews(rating);

-- ----------------------------------------------------------------------------
-- 6. FUTURE STOPS TABLE (Upcoming Tour Dates across Hyderabad, Vizag, etc.)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS future_stops (
    id VARCHAR(64) PRIMARY KEY,
    date VARCHAR(100) NOT NULL,
    day_of_week VARCHAR(50) NOT NULL,
    state VARCHAR(100) NOT NULL,
    city VARCHAR(100) NOT NULL,
    spot_name VARCHAR(255) NOT NULL,
    address TEXT NOT NULL,
    hours VARCHAR(100) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'scheduled',
    badge VARCHAR(100),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------------------------
-- 7. SUPABASE REALTIME REPLICATION (For WebSockets sub-500ms sync)
-- ----------------------------------------------------------------------------
-- In Supabase, execute this to enable realtime channels:
-- ALTER PUBLICATION supabase_realtime ADD TABLE orders, order_items, vans, inventory_logs, reviews, future_stops;

-- ----------------------------------------------------------------------------
-- 8. ROW LEVEL SECURITY (RLS) POLICIES
-- ----------------------------------------------------------------------------
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE vans ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE future_stops ENABLE ROW LEVEL SECURITY;

-- Allow public read of active vans and future stops for live map
CREATE POLICY "Public read vans" ON vans FOR SELECT USING (true);
CREATE POLICY "Public read future_stops" ON future_stops FOR SELECT USING (true);
CREATE POLICY "Public read reviews" ON reviews FOR SELECT USING (true);

-- Allow customers and baristas to read orders
CREATE POLICY "Allow read orders" ON orders FOR SELECT USING (true);
CREATE POLICY "Allow insert orders" ON orders FOR INSERT WITH CHECK (true);
CREATE POLICY "Allow update orders" ON orders FOR UPDATE USING (true);

-- Allow order items
CREATE POLICY "Allow read order_items" ON order_items FOR SELECT USING (true);
CREATE POLICY "Allow insert order_items" ON order_items FOR INSERT WITH CHECK (true);

-- Allow inventory reading and updating
CREATE POLICY "Allow read inventory" ON inventory_logs FOR SELECT USING (true);
CREATE POLICY "Allow insert inventory" ON inventory_logs FOR INSERT WITH CHECK (true);
