-- Candle tables: WITHOUT ROWID, PK (symbol_id, open_time) doubles as the range index.
-- Prices/volume as REAL; SQLite stores integral REALs compactly as integers on disk.
CREATE TABLE `candles_1m` (
  `symbol_id` integer NOT NULL,
  `open_time` integer NOT NULL,
  `open` real NOT NULL,
  `high` real NOT NULL,
  `low` real NOT NULL,
  `close` real NOT NULL,
  `volume` real NOT NULL,
  PRIMARY KEY (`symbol_id`, `open_time`)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `candles_1d` (
  `symbol_id` integer NOT NULL,
  `open_time` integer NOT NULL,
  `open` real NOT NULL,
  `high` real NOT NULL,
  `low` real NOT NULL,
  `close` real NOT NULL,
  `volume` real NOT NULL,
  PRIMARY KEY (`symbol_id`, `open_time`)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `candles_1w` (
  `symbol_id` integer NOT NULL,
  `open_time` integer NOT NULL,
  `open` real NOT NULL,
  `high` real NOT NULL,
  `low` real NOT NULL,
  `close` real NOT NULL,
  `volume` real NOT NULL,
  PRIMARY KEY (`symbol_id`, `open_time`)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `candles_5m` (
  `symbol_id` integer NOT NULL,
  `open_time` integer NOT NULL,
  `open` real NOT NULL,
  `high` real NOT NULL,
  `low` real NOT NULL,
  `close` real NOT NULL,
  `volume` real NOT NULL,
  `n` integer NOT NULL,
  PRIMARY KEY (`symbol_id`, `open_time`)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `candles_15m` (
  `symbol_id` integer NOT NULL,
  `open_time` integer NOT NULL,
  `open` real NOT NULL,
  `high` real NOT NULL,
  `low` real NOT NULL,
  `close` real NOT NULL,
  `volume` real NOT NULL,
  `n` integer NOT NULL,
  PRIMARY KEY (`symbol_id`, `open_time`)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `candles_1h` (
  `symbol_id` integer NOT NULL,
  `open_time` integer NOT NULL,
  `open` real NOT NULL,
  `high` real NOT NULL,
  `low` real NOT NULL,
  `close` real NOT NULL,
  `volume` real NOT NULL,
  `n` integer NOT NULL,
  PRIMARY KEY (`symbol_id`, `open_time`)
) WITHOUT ROWID;
--> statement-breakpoint
CREATE TABLE `candles_4h` (
  `symbol_id` integer NOT NULL,
  `open_time` integer NOT NULL,
  `open` real NOT NULL,
  `high` real NOT NULL,
  `low` real NOT NULL,
  `close` real NOT NULL,
  `volume` real NOT NULL,
  `n` integer NOT NULL,
  PRIMARY KEY (`symbol_id`, `open_time`)
) WITHOUT ROWID;
