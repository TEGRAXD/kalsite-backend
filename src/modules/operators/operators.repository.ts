import { and, asc, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { db, operators, type NewOperator } from "../../database";

export interface OperatorQueryFilter {
  search?: string;
  operatorClass?: string;
  rarity?: number;
  rarities?: number[];
  classes?: string[];
  limit?: number;
  includeDisabled?: boolean;
}

export const OperatorsRepository = {
  async findMany(filter: OperatorQueryFilter = {}) {
    const conditions = [];

    if (!filter.includeDisabled) {
      conditions.push(eq(operators.isEnabled, true));
    }

    if (filter.search) {
      const pattern = `%${filter.search}%`;
      conditions.push(
        or(
          ilike(operators.name, pattern),
          ilike(operators.latinName, pattern),
          ilike(operators.cnName, pattern),
          ilike(operators.slug, pattern),
          ilike(operators.operatorClass, pattern),
          ilike(operators.branch, pattern),
          ilike(operators.faction, pattern),
        )!,
      );
    }

    if (filter.operatorClass) {
      conditions.push(eq(operators.operatorClass, filter.operatorClass));
    }

    if (filter.rarity) {
      conditions.push(eq(operators.rarity, filter.rarity));
    }

    if (filter.rarities && filter.rarities.length > 0) {
      conditions.push(inArray(operators.rarity, filter.rarities));
    }

    if (filter.classes && filter.classes.length > 0) {
      conditions.push(inArray(operators.operatorClass, filter.classes));
    }

    const query = db
      .select()
      .from(operators)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(
        sql`${operators.releaseOrder} DESC NULLS LAST`,
        desc(operators.rarity),
        asc(operators.name),
      );

    if (filter.limit && filter.limit > 0) {
      return query.limit(filter.limit);
    }

    return query;
  },

  findBySlug(slug: string) {
    return db.query.operators.findFirst({
      where: and(eq(operators.slug, slug), eq(operators.isEnabled, true)),
    });
  },

  findBySlugAny(slug: string) {
    return db.query.operators.findFirst({
      where: eq(operators.slug, slug),
    });
  },

  findById(id: string) {
    return db.query.operators.findFirst({
      where: eq(operators.id, id),
    });
  },

  async create(data: NewOperator) {
    const [inserted] = await db.insert(operators).values(data).returning();
    return inserted!;
  },

  async update(id: string, data: Partial<NewOperator>) {
    const [updated] = await db
      .update(operators)
      .set(data)
      .where(eq(operators.id, id))
      .returning();
    return updated;
  },

  async removeOrDisable(id: string) {
    try {
      await db.delete(operators).where(eq(operators.id, id));
      return { deleted: true as const };
    } catch {
      // Operator is referenced by historical game_players rows — soft-disable instead
      await db
        .update(operators)
        .set({ isEnabled: false })
        .where(eq(operators.id, id));
      return { deleted: false as const };
    }
  },
};
