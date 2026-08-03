ALTER TABLE `customer_order` ADD `stock_released_at` integer;--> statement-breakpoint
ALTER TABLE `customer_order` ADD `refunded_cents` integer DEFAULT 0 NOT NULL;