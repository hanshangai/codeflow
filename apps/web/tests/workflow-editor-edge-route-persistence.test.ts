import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const editor = readFileSync(
  new URL("../src/features/orchestration/components/workflow-editor.vue", import.meta.url),
  "utf8",
);
const graph = readFileSync(
  new URL("../src/features/orchestration/components/workflow-graph-view.vue", import.meta.url),
  "utf8",
);

test("workflow editor persists auto-layout route points in the workflow edge definition", () => {
  assert.match(editor, /routePoints: normalizedRoutePoints/u);
  assert.match(editor, /workflowEdge:\s*\{[\s\S]*routePoints: normalizedRoutePoints/u);
  assert.match(editor, /routePoints\.length >= 2 \? \{ routePoints \} : \{\}/u);
});

test("loading a workflow preserves stored route points while geometry edits clear them", () => {
  assert.match(editor, /refreshEditorEdgeAnchorLayouts\(true\)/u);
  assert.match(editor, /function refreshEditorEdgeAnchorLayouts\(preserveStoredRoutePoints = false\)/u);
  assert.match(editor, /preserveStoredRoutePoints \? editorEdges\.value : editorEdges\.value\.map\(clearTransientRoutePoints\)/u);
  assert.match(editor, /const \{ routePoints: _ignoredDefinitionRoutePoints, \.\.\.definition \} = workflowEdge/u);
});

test("reconnecting an edge updates its business endpoints and clears stale routes", () => {
  assert.match(editor, /function onEdgeUpdate\(event: EdgeUpdateEvent\): void \{/u);
  assert.match(editor, /sourceNodeId: connection\.source,/u);
  assert.match(editor, /targetNodeId: connection\.target,/u);
  assert.match(editor, /@edge-update="onEdgeUpdate"/u);
});

test("edge layout refresh synchronizes Vue Flow's internal edge store", () => {
  assert.match(editor, /const \{ fitView, setViewport, setEdges, getNodes \} = useVueFlow\("workflow-editor"\)/u);
  assert.match(editor, /function syncEditorEdgeStore\(\): void \{/u);
  assert.match(editor, /syncEditorEdgeStore\(\);/u);
});

test("edge v-model round trips strip Vue Flow runtime references before saving", () => {
  assert.match(editor, /function stripVueFlowEdgeInternals\(edge: Edge\): Edge \{/u);
  assert.match(editor, /sourceNode: _sourceNode, targetNode: _targetNode, events: _events/u);
  assert.match(editor, /data: isRecord\(definition\.data\) \? cloneValue\(definition\.data\) : definition\.data/u);
});

test("internal edge synchronization suppresses the v-model feedback loop", () => {
  assert.match(editor, /let suppressDisplayEdgeModelUpdate = false;/u);
  assert.match(editor, /if \(suppressDisplayEdgeModelUpdate\) \{/u);
  assert.match(editor, /suppressDisplayEdgeModelUpdate = true;/u);
});

test("readonly graph view also passes persisted route points to the edge renderer", () => {
  assert.match(graph, /routePoints: edge\.routePoints/u);
});
