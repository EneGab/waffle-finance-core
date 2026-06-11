-- Migration: 002_solana_support
-- Extends direction, src_chain, and dst_chain CHECK constraints to include Solana.
--
-- SQLite does not support ALTER TABLE ... MODIFY COLUMN, so we recreate the
-- table with the updated constraints and copy the data across.

BEGIN;

-- 1. Create the new table with updated constraints.
CREATE TABLE orders_new (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    public_id             TEXT    NOT NULL UNIQUE,
    direction             TEXT    NOT NULL CHECK (direction IN ('eth_to_xlm', 'xlm_to_eth', 'eth_to_sol', 'sol_to_eth')),
    status                TEXT    NOT NULL CHECK (status IN ('announced', 'src_locked', 'dst_locked', 'secret_revealed', 'completed', 'refunded', 'failed', 'expired')),
    hashlock              TEXT    NOT NULL,
    src_chain             TEXT    NOT NULL CHECK (src_chain IN ('ethereum', 'stellar', 'solana')),
    src_address           TEXT    NOT NULL,
    src_asset             TEXT    NOT NULL,
    src_amount            TEXT    NOT NULL,
    src_safety_deposit    TEXT    NOT NULL,
    src_order_id          TEXT,
    src_lock_tx           TEXT,
    src_lock_block        INTEGER,
    src_timelock          INTEGER,
    dst_chain             TEXT    NOT NULL CHECK (dst_chain IN ('ethereum', 'stellar', 'solana')),
    dst_address           TEXT    NOT NULL,
    dst_asset             TEXT    NOT NULL,
    dst_amount            TEXT    NOT NULL,
    dst_order_id          TEXT,
    dst_lock_tx           TEXT,
    dst_lock_block        INTEGER,
    dst_timelock          INTEGER,
    preimage              TEXT,
    secret_revealed_tx    TEXT,
    resolver_address      TEXT,
    created_at            INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
    updated_at            INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
);

-- 2. Copy existing rows.
INSERT INTO orders_new SELECT * FROM orders;

-- 3. Swap tables.
DROP TABLE orders;
ALTER TABLE orders_new RENAME TO orders;

-- 4. Re-create indexes.
CREATE INDEX IF NOT EXISTS idx_orders_hashlock         ON orders (hashlock);
CREATE INDEX IF NOT EXISTS idx_orders_src_address      ON orders (src_address);
CREATE INDEX IF NOT EXISTS idx_orders_dst_address      ON orders (dst_address);
CREATE INDEX IF NOT EXISTS idx_orders_status           ON orders (status);
CREATE INDEX IF NOT EXISTS idx_orders_src_order_id     ON orders (src_chain, src_order_id);
CREATE INDEX IF NOT EXISTS idx_orders_dst_order_id     ON orders (dst_chain, dst_order_id);

COMMIT;
