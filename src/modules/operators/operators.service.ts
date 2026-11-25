import { BadRequestError, ConflictError, NotFoundError } from "../../errors";
import {
  OperatorsRepository,
  type OperatorQueryFilter,
} from "./operators.repository";
import type {
  CreateOperatorInput,
  UpdateOperatorInput,
} from "./operators.schema";
import {
  downloadOperatorImageToLocal,
  saveManualOperatorImage,
  slugifyOperatorName,
  syncOperatorsFromGitHub,
} from "./operators.sync";

export const OperatorsService = {
  async list(filter: OperatorQueryFilter) {
    return OperatorsRepository.findMany(filter);
  },

  async getBySlug(slug: string, includeDisabled = false) {
    const op = includeDisabled
      ? await OperatorsRepository.findBySlugAny(slug)
      : await OperatorsRepository.findBySlug(slug);
    if (!op) {
      throw new NotFoundError("Operator not found");
    }
    return op;
  },

  async syncFromGitHub(options?: { forceRedownloadImages?: boolean }) {
    return syncOperatorsFromGitHub(options);
  },

  async createManual(input: CreateOperatorInput, imageFile?: File | null) {
    const slug = slugifyOperatorName(input.slug || input.name, "manual");
    const existing = await OperatorsRepository.findBySlugAny(slug);
    if (existing) {
      throw new ConflictError(`An Operator with slug "${slug}" already exists`);
    }

    const id = `manual_${crypto.randomUUID().slice(0, 24)}`;
    let imageUrl = `/uploads/operators/${slug}.png`;

    if (imageFile && imageFile.size > 0) {
      imageUrl = await saveManualOperatorImage(imageFile, slug);
    } else if (input.sourceImageUrl) {
      if (!/^https?:\/\//i.test(input.sourceImageUrl)) {
        throw new BadRequestError("sourceImageUrl must be a valid http(s) URL");
      }
      const filename = `manual_${slug}_${Date.now()}.png`;
      const result = await downloadOperatorImageToLocal(
        input.sourceImageUrl,
        filename,
        true,
      );
      if (result === "failed") {
        throw new BadRequestError("Failed to download image from sourceImageUrl");
      }
      imageUrl = `/uploads/operators/${filename}`;
    }

    return OperatorsRepository.create({
      id,
      name: input.name,
      latinName: input.latinName ?? null,
      cnName: input.cnName,
      slug,
      rarity: input.rarity,
      operatorClass: input.operatorClass,
      branch: input.branch,
      faction: input.faction ?? null,
      gender: input.gender ?? null,
      race: input.race ?? null,
      imageUrl,
      releaseOrder: input.releaseOrder ?? null,
      isEnabled: true,
    });
  },

  async updateManual(
    id: string,
    input: UpdateOperatorInput,
    imageFile?: File | null,
  ) {
    const existing = await OperatorsRepository.findById(id);
    if (!existing) {
      throw new NotFoundError("Operator not found");
    }

    const nextSlug = input.slug
      ? slugifyOperatorName(input.slug, existing.slug)
      : existing.slug;

    if (nextSlug !== existing.slug) {
      const conflict = await OperatorsRepository.findBySlugAny(nextSlug);
      if (conflict && conflict.id !== id) {
        throw new ConflictError(
          `An Operator with slug "${nextSlug}" already exists`,
        );
      }
    }

    let imageUrl = existing.imageUrl;
    if (imageFile && imageFile.size > 0) {
      imageUrl = await saveManualOperatorImage(imageFile, nextSlug);
    } else if (input.sourceImageUrl) {
      if (!/^https?:\/\//i.test(input.sourceImageUrl)) {
        throw new BadRequestError("sourceImageUrl must be a valid http(s) URL");
      }
      const filename = `${existing.id}_${Date.now()}.png`;
      const result = await downloadOperatorImageToLocal(
        input.sourceImageUrl,
        filename,
        true,
      );
      if (result === "failed") {
        throw new BadRequestError("Failed to download image from sourceImageUrl");
      }
      imageUrl = `/uploads/operators/${filename}`;
    }

    return OperatorsRepository.update(id, {
      name: input.name ?? existing.name,
      latinName:
        input.latinName !== undefined ? input.latinName : existing.latinName,
      cnName: input.cnName ?? existing.cnName,
      slug: nextSlug,
      rarity: input.rarity ?? existing.rarity,
      operatorClass: input.operatorClass ?? existing.operatorClass,
      branch: input.branch ?? existing.branch,
      faction: input.faction !== undefined ? input.faction : existing.faction,
      gender: input.gender !== undefined ? input.gender : existing.gender,
      race: input.race !== undefined ? input.race : existing.race,
      imageUrl,
      releaseOrder:
        input.releaseOrder !== undefined
          ? input.releaseOrder
          : existing.releaseOrder,
      isEnabled: input.isEnabled ?? existing.isEnabled,
    });
  },

  async remove(id: string) {
    const existing = await OperatorsRepository.findById(id);
    if (!existing) {
      throw new NotFoundError("Operator not found");
    }
    return OperatorsRepository.removeOrDisable(id);
  },
};
