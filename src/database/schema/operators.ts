import {
  pgTable,
  varchar,
  integer,
  boolean,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

export const operators = pgTable(
  "operators",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    name: varchar("name", { length: 100 }).notNull(),
    latinName: varchar("latin_name", { length: 100 }),
    cnName: varchar("cn_name", { length: 100 }).notNull(),
    slug: varchar("slug", { length: 100 }).notNull(),
    rarity: integer("rarity").notNull(),
    operatorClass: varchar("class", { length: 40 }).notNull(),
    branch: varchar("branch", { length: 60 }).notNull(),
    faction: varchar("faction", { length: 80 }),
    factionLogoUrl: varchar("faction_logo_url", { length: 500 }),
    gender: varchar("gender", { length: 30 }),
    race: varchar("race", { length: 60 }),
    imageUrl: varchar("image_url", { length: 500 }).notNull(),
    releaseOrder: integer("release_order"),
    isEnabled: boolean("is_enabled").default(true).notNull(),
  },
  (table) => [
    uniqueIndex("operators_slug_unique").on(table.slug),
    index("operators_class_idx").on(table.operatorClass),
    index("operators_rarity_idx").on(table.rarity),
    index("operators_faction_idx").on(table.faction),
    index("operators_gender_idx").on(table.gender),
    index("operators_race_idx").on(table.race),
    index("operators_release_order_idx").on(table.releaseOrder),
  ],
);

export type Operator = typeof operators.$inferSelect;
export type NewOperator = typeof operators.$inferInsert;
