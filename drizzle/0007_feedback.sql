CREATE TABLE `csv_feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text,
	`kind` text NOT NULL,
	`want` text NOT NULL,
	`did` text NOT NULL,
	`idea` text NOT NULL,
	`count` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`source` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `csv_feedback_status_idx` ON `csv_feedback` (`status`,`count`);--> statement-breakpoint
CREATE INDEX `csv_feedback_case_id_idx` ON `csv_feedback` (`case_id`);