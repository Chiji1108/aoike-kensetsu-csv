CREATE TABLE `csv_location_memory` (
	`customer_id` text NOT NULL,
	`site_key` text NOT NULL,
	`work_name` text NOT NULL,
	`client` text NOT NULL,
	`prefecture` text NOT NULL,
	`place` text NOT NULL,
	`urls` text NOT NULL,
	`source` text NOT NULL,
	`confident` integer NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`case_id` text NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`customer_id`, `site_key`)
);
--> statement-breakpoint
CREATE TABLE `csv_location_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`total` integer NOT NULL,
	`searches` integer DEFAULT 0 NOT NULL,
	`usd` real DEFAULT 0 NOT NULL,
	`stop_requested` integer DEFAULT false NOT NULL,
	`proposal_id` text,
	`error` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `csv_location_runs_case_id_idx` ON `csv_location_runs` (`case_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `csv_location_runs_one_running` ON `csv_location_runs` (`case_id`) WHERE "csv_location_runs"."status" = 'running';--> statement-breakpoint
CREATE TABLE `csv_location_sites` (
	`run_id` text NOT NULL,
	`idx` integer NOT NULL,
	`site` text NOT NULL,
	`outcome` text,
	PRIMARY KEY(`run_id`, `idx`)
);
