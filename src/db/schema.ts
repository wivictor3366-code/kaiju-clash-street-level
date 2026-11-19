import { integer, pgTable, serial, text, timestamp, varchar } from "drizzle-orm/pg-core";

// WebRTC signalling mailbox: the host parks an SDP offer under a short room code,
// the challenger posts the answer. After that all gameplay traffic is peer-to-peer.
export const rooms = pgTable("rooms", {
  code: varchar("code", { length: 8 }).primaryKey(),
  offer: text("offer").notNull(),
  answer: text("answer"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const matches = pgTable("matches", {
  id: serial("id").primaryKey(),
  mode: varchar("mode", { length: 12 }).notNull(),
  p1: varchar("p1", { length: 24 }).notNull(),
  p2: varchar("p2", { length: 24 }).notNull(),
  c1: integer("c1").notNull(),
  c2: integer("c2").notNull(),
  winner: integer("winner").notNull(), // 1, 2 or 3 (draw)
  havoc: integer("havoc").notNull(), // city damage in ¥100M
  frames: integer("frames").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
