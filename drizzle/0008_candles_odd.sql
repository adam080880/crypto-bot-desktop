-- Odd timeframes (user 2026-11-23): 3m / 10m / 45m / 2h / 3h, derived from 1m like 5m/15m/1h/4h (same columns as 0002 + 0007).
CREATE TABLE `candles_3m` (
  `symbol_id` integer NOT NULL,
  `open_time` integer NOT NULL,
  `open` real NOT NULL,
  `high` real NOT NULL,
  `low` real NOT NULL,
  `close` real NOT NULL,
  `volume` real NOT NULL,
  `n` integer NOT NULL,
  `buy_volume` real,
  `trades` integer,
  PRIMARY KEY (`symbol_id`, `open_time`)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `candles_45m` (
  `symbol_id` integer NOT NULL,
  `open_time` integer NOT NULL,
  `open` real NOT NULL,
  `high` real NOT NULL,
  `low` real NOT NULL,
  `close` real NOT NULL,
  `volume` real NOT NULL,
  `n` integer NOT NULL,
  `buy_volume` real,
  `trades` integer,
  PRIMARY KEY (`symbol_id`, `open_time`)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `candles_2h` (
  `symbol_id` integer NOT NULL,
  `open_time` integer NOT NULL,
  `open` real NOT NULL,
  `high` real NOT NULL,
  `low` real NOT NULL,
  `close` real NOT NULL,
  `volume` real NOT NULL,
  `n` integer NOT NULL,
  `buy_volume` real,
  `trades` integer,
  PRIMARY KEY (`symbol_id`, `open_time`)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `candles_3h` (
  `symbol_id` integer NOT NULL,
  `open_time` integer NOT NULL,
  `open` real NOT NULL,
  `high` real NOT NULL,
  `low` real NOT NULL,
  `close` real NOT NULL,
  `volume` real NOT NULL,
  `n` integer NOT NULL,
  `buy_volume` real,
  `trades` integer,
  PRIMARY KEY (`symbol_id`, `open_time`)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `candles_10m` (
  `symbol_id` integer NOT NULL,
  `open_time` integer NOT NULL,
  `open` real NOT NULL,
  `high` real NOT NULL,
  `low` real NOT NULL,
  `close` real NOT NULL,
  `volume` real NOT NULL,
  `n` integer NOT NULL,
  `buy_volume` real,
  `trades` integer,
  PRIMARY KEY (`symbol_id`, `open_time`)
) WITHOUT ROWID;
