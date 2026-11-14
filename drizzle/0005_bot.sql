CREATE TABLE `bot_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`t` integer NOT NULL,
	`level` text NOT NULL,
	`symbol` text,
	`message` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `bot_events_t_idx` ON `bot_events` (`t`);--> statement-breakpoint
CREATE TABLE `bot_trades` (
	`id` text PRIMARY KEY NOT NULL,
	`setup_id` text NOT NULL,
	`mode` text NOT NULL,
	`symbol` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`closed_at` integer,
	`pnl` real,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `bot_trades_setup_idx` ON `bot_trades` (`setup_id`,`mode`);--> statement-breakpoint
CREATE INDEX `bot_trades_status_idx` ON `bot_trades` (`status`,`created_at`);