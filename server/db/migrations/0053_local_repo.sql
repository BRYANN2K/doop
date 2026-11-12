CREATE TABLE "repo_links" (
	"id" text PRIMARY KEY NOT NULL,
	"canvas_id" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"device_id" text NOT NULL,
	"created_at" bigint NOT NULL,
	"last_used_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "repo_links_canvas_user_idx" ON "repo_links" USING btree ("canvas_id","user_id");