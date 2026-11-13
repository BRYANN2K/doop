CREATE TABLE "drift_comparisons" (
	"id" text PRIMARY KEY NOT NULL,
	"canvas_id" text NOT NULL,
	"frame_id" text NOT NULL,
	"shipped_frame_id" text,
	"url" text NOT NULL,
	"final_url" text,
	"score" real,
	"diff_pixels" integer,
	"total_pixels" integer,
	"via" text NOT NULL,
	"source" text NOT NULL,
	"requested_by" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "drift_comparisons_frame_idx" ON "drift_comparisons" USING btree ("frame_id");