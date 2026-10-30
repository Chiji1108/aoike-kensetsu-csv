CREATE TABLE `csv_rule_appends` (
	`proposal_id` text NOT NULL,
	`item` integer NOT NULL,
	`case_id` text NOT NULL,
	`token` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`proposal_id`, `item`)
);
--> statement-breakpoint
CREATE INDEX `csv_rule_appends_case_id_idx` ON `csv_rule_appends` (`case_id`);