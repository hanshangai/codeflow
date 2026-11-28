import { createHash } from "node:crypto";

import initialSeedRows from "./engineModelCatalogSeedV1.json" with { type: "json" };
import { validateEngineModelCatalogRows, type EngineModelCatalogItem } from "./types/engineModelCatalog.js";

const INITIAL_ENGINE_MODEL_CATALOG_V1_DIGEST = "1eb9da490779503b2dc7cebf1169b79bb80b757f2dd7429fda7d881f8c47444d";

/** v106 迁移种子使用发布时的目录快照，摘要校验确保历史数据固定。 */
const initialRows = validateEngineModelCatalogRows(initialSeedRows);
const initialRowsDigest = createHash("sha256").update(JSON.stringify(initialRows), "utf8").digest("hex");
if (initialRowsDigest !== INITIAL_ENGINE_MODEL_CATALOG_V1_DIGEST) {
  throw new Error("v106 模型目录迁移种子已变化，必须保留历史数据");
}
export const INITIAL_ENGINE_MODEL_CATALOG_V1: readonly EngineModelCatalogItem[] = initialRows;
