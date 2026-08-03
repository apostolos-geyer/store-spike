ALTER TABLE `customer_order` ADD `tax_cents` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `customer_order` ADD `currency` text DEFAULT 'cad' NOT NULL;--> statement-breakpoint
ALTER TABLE `customer_order` ADD `payment_intent_id` text;--> statement-breakpoint
ALTER TABLE `order_item` ADD `preorder` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `order_item` ADD `expected_ship_at` integer;--> statement-breakpoint
ALTER TABLE `product_variant` ADD `mode` text DEFAULT 'stock' NOT NULL;--> statement-breakpoint
ALTER TABLE `product_variant` ADD `expected_ship_at` integer;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_customer_order` (
	`id` text PRIMARY KEY,
	`order_number` text NOT NULL UNIQUE,
	`user_id` text NOT NULL,
	`email` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`ship_name` text,
	`ship_line1` text,
	`ship_line2` text,
	`ship_city` text,
	`ship_region` text,
	`ship_postal` text,
	`ship_country` text DEFAULT 'CA' NOT NULL,
	`ship_phone` text,
	`subtotal_cents` integer NOT NULL,
	`shipping_cents` integer DEFAULT 0 NOT NULL,
	`tax_cents` integer DEFAULT 0 NOT NULL,
	`total_cents` integer DEFAULT 0 NOT NULL,
	`currency` text DEFAULT 'cad' NOT NULL,
	`session_id` text UNIQUE,
	`payment_intent_id` text,
	`session_expires_at` integer,
	`payment_status` text DEFAULT 'unpaid' NOT NULL,
	`carrier` text,
	`tracking_number` text,
	`fulfillment_note` text,
	`shipped_at` integer,
	`delivered_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "ship_address_atomic" CHECK((ship_name IS NULL) = (ship_line1 IS NULL) AND (ship_name IS NULL) = (ship_city IS NULL) AND (ship_name IS NULL) = (ship_region IS NULL) AND (ship_name IS NULL) = (ship_postal IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_customer_order`(`id`, `order_number`, `user_id`, `email`, `status`, `ship_name`, `ship_line1`, `ship_line2`, `ship_city`, `ship_region`, `ship_postal`, `ship_country`, `ship_phone`, `subtotal_cents`, `shipping_cents`, `total_cents`, `session_id`, `session_expires_at`, `payment_status`, `carrier`, `tracking_number`, `fulfillment_note`, `shipped_at`, `delivered_at`, `created_at`, `updated_at`) SELECT `id`, `order_number`, `user_id`, `email`, `status`, `ship_name`, `ship_line1`, `ship_line2`, `ship_city`, `ship_region`, `ship_postal`, `ship_country`, `ship_phone`, `subtotal_cents`, `shipping_cents`, `total_cents`, `session_id`, `session_expires_at`, `payment_status`, `carrier`, `tracking_number`, `fulfillment_note`, `shipped_at`, `delivered_at`, `created_at`, `updated_at` FROM `customer_order`;--> statement-breakpoint
DROP TABLE `customer_order`;--> statement-breakpoint
ALTER TABLE `__new_customer_order` RENAME TO `customer_order`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_order_user` ON `customer_order` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_order_status` ON `customer_order` (`status`);--> statement-breakpoint
CREATE INDEX `idx_order_created` ON `customer_order` (`created_at`);