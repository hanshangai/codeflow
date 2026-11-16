import assert from "node:assert/strict";
import test from "node:test";

import { OrchArtifactRepo } from "../src/db/repos/orchArtifactRepo.ts";

test("artifact summary list excludes content_json and returns an empty content marker", () => {
  const statements: string[] = [];
  const db = {
    prepare(sql: string) {
      statements.push(sql);
      return {
        all: () => [{
          id: "artifact-a",
          instance_id: "instance-a",
          node_id: "node-a",
          kind: "report",
          version: 1,
          title: "Report",
          schema_ref: null,
          status: "approved",
          metadata_json: "{}",
          persistence_mode: "database",
          payload_mode: "text",
          workspace_status: null,
          workspace_base_dir: null,
          staging_path: null,
          published_path: null,
          content_hash: "hash-a",
          manifest_json: null,
          created_at: 1,
          updated_at: 2,
        }],
      };
    },
  };

  const artifacts = new OrchArtifactRepo(db as any).listSummariesByInstance("instance-a" as any);

  assert.equal(statements.length, 1);
  assert.doesNotMatch(statements[0]!, /\bcontent_json\b/iu);
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0]?.contentJson, "");
  assert.equal(artifacts[0]?.id, "artifact-a");
});
