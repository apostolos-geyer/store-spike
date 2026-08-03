ALTER TABLE `product` ADD `preorder_cap` integer;--> statement-breakpoint
ALTER TABLE `product` ADD `preorder_claimed` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_product` (
	`id` text PRIMARY KEY,
	`slug` text NOT NULL UNIQUE,
	`status` text DEFAULT 'draft' NOT NULL,
	`active_release_id` text,
	`preorder_cap` integer,
	`preorder_claimed` integer DEFAULT 0 NOT NULL,
	`created_by_sub` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_product_active_release_id_product_release_id_fk` FOREIGN KEY (`active_release_id`) REFERENCES `product_release`(`id`) ON DELETE SET NULL,
	CONSTRAINT "preorder_claimed_non_negative" CHECK(preorder_claimed >= 0),
	CONSTRAINT "preorder_claimed_within_cap" CHECK(preorder_cap IS NULL OR preorder_claimed <= preorder_cap),
	CONSTRAINT "product_status_valid" CHECK(status IN ('draft', 'active', 'unavailable', 'archived'))
);
--> statement-breakpoint
INSERT INTO `__new_product`(`id`, `slug`, `status`, `active_release_id`, `created_by_sub`, `created_at`, `updated_at`) SELECT `id`, `slug`, `status`, `active_release_id`, `created_by_sub`, `created_at`, `updated_at` FROM `product`;--> statement-breakpoint
DROP TABLE `product`;--> statement-breakpoint
ALTER TABLE `__new_product` RENAME TO `product`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_product_status_updated` ON `product` (`status`,`updated_at`);